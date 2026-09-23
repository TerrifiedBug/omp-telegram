// Per-chat outbound delivery: streams the assistant's in-progress text to
// Telegram (native message drafts for DMs, edit-based preview for groups /
// draft-unsupported), finalizes one real message per agent turn, and exposes
// send/file/react helpers for the model tools. All Telegram I/O funnels through
// here so the outbound-chat gate and formatting live in one place.
//
// How much of that is automatic depends on the configured mode
// (`effectiveStreaming`): under `"explicit"` none of it is, and the send/file
// helpers below are the only way text reaches Telegram.

import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { type Access, assertSendable, effectiveStreaming, messageLimit } from "./access";
import { isMissingThreadError, type Logger, TgError, tg, tgUpload, withRateLimit } from "./api";
import { MARKDOWN_HEADROOM, PART_LABEL_RESERVE, TELEGRAM_MAX_CHARS, TELEGRAM_RICH_MAX_CHARS, chunkLabeled, hasRichConstructs, mdToMarkdownV2 } from "./markdown";
import { REPLIED_REACTION, SEEN_REACTION } from "./delivery";
import {
  claimOutboxRecord,
  createOutboxRecord,
  loadOutboxRecord,
  loadOutboxRecords,
  listOutboxRecords,
  type OutboxPart,
  type OutboxRecord,
  removeOutboxRecord,
  saveOutboxRecord,
} from "./outbox";

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const PHOTO_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const CURSOR = " \u258f"; // ▍ streaming caret appended to live previews
const DRAFT_THROTTLE_MS = 600;
const EDIT_THROTTLE_MS = 1250;
const TYPING_INTERVAL_MS = 5000;
/** Map a chat + optional forum topic to a single #chats / #active key. */
const targetKey = (chatId: string, threadId?: number): string => (threadId != null ? `${chatId}#${threadId}` : chatId);

interface ChatState {
  /** Chat this state streams to (the target's own address). */
  chatId: string;
  /** Forum topic thread id when this target is a per-session topic. */
  threadId?: number;
  /** sendMessageDraft id for the current turn (DM draft path). */
  draftId?: number;
  /** message_id of the live edit-path preview for the current turn. */
  previewMsgId?: number;
  /** Full accumulated assistant text last pushed this turn. */
  acc: string;
  /** Source chars already finalized into prior preview messages (edit overflow). */
  sentUpTo: number;
  /** Messages of this turn's answer already delivered, kept so `(i/n)` can be filled in at the end. */
  committed: Array<{ messageId: number; text: string }>;
  /** Throttle timestamp of the last stream push. */
  lastEditAt: number;
  /** True while this turn has unfinalized streamed content. */
  dirty: boolean;
  /** A stream push is in flight (mutual exclusion + finalize barrier). */
  busy: boolean;
  /** The in-flight stream push, awaited by finalize to avoid racing edits. */
  inflight?: Promise<void>;
  /** The turn-end delivery in progress; the run-end flush waits for it instead of sending again. */
  finalizing?: Promise<void>;
  /** 429 backoff: suspend stream pushes until this timestamp. */
  suspendUntil?: number;
  /** sendMessageDraft rejected message_thread_id for this target — use the edit path. */
  draftBroken?: boolean;
  /** Inbound messages marked seen (deliveryStatus "reactions") awaiting a reply this run, with their 👀 send. */
  awaitingReply: Array<{ messageId: number; seen: Promise<void>; seenAt: number }>;
  /** When a reply last reached this target this run; only messages seen earlier count as answered. */
  repliedAt?: number;
  typingTimer?: NodeJS.Timeout;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as { type?: unknown; text?: unknown };
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("\n");
}

/** Visible text of an assistant message (text blocks only; thinking excluded). */
export function assistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const m = message as { role?: unknown; content?: unknown };
  if (m.role !== "assistant") return "";
  return textFromContent(m.content);
}

/** Stream-start timestamp omp stamps on an assistant message; stable across its updates. */
function messageTimestamp(message: unknown): number | undefined {
  if (!message || typeof message !== "object" || !("timestamp" in message)) return undefined;
  const stamp = message.timestamp;
  return typeof stamp === "number" && Number.isFinite(stamp) ? stamp : undefined;
}

/** Last visible assistant text in a message list (text blocks only; "" when none). */
export function finalAssistantText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = assistantText(messages[i]);
    if (t.trim().length > 0) return t;
  }
  return "";
}

export interface RunError {
  message: string;
  status?: number;
}

/** Failure of the current terminal assistant result, never an older turn. */
export function lastRunError(messages: readonly unknown[]): RunError | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== "object") continue;
    const r = m as { role?: unknown; stopReason?: unknown; errorMessage?: unknown; errorStatus?: unknown };
    if (r.role === "user") return undefined;
    if (r.role !== "assistant") continue;
    if (r.stopReason !== "error" || typeof r.errorMessage !== "string" || r.errorMessage.trim().length === 0) return undefined;
    return { message: r.errorMessage, status: typeof r.errorStatus === "number" ? r.errorStatus : undefined };
  }
  return undefined;
}

export type DeliveryFailureState = "failed" | "uncertain";

/** A Bot API rejection proves no send occurred; transport/parse failures cannot. */
export function deliveryFailureState(error: unknown): DeliveryFailureState {
  return error instanceof TgError ? "failed" : "uncertain";
}

/** Delivery error with the confirmed remote ids preserved for callers and logs. */
export class OutboundDeliveryError extends Error {
  readonly state: DeliveryFailureState;
  readonly sentIds: number[];
  readonly totalParts: number;
  readonly chatId: string;
  readonly threadId?: number;

  constructor(
    kind: "message" | "attachment",
    error: unknown,
    sentIds: number[],
    totalParts: number,
    chatId: string,
    threadId?: number,
  ) {
    const state = deliveryFailureState(error);
    const delivered = sentIds.length > 0 ? ` Confirmed message ids: ${sentIds.join(", ")}.` : "";
    const explanation =
      state === "uncertain"
        ? "Telegram may have accepted the in-flight part; it was not retried to avoid a duplicate."
        : "Telegram definitively rejected the in-flight part.";
    super(
      `Telegram ${kind} delivery ${state} after ${sentIds.length} of ${totalParts} part(s).${delivered} ${explanation} ${String(error)}`,
      { cause: error },
    );
    this.name = "OutboundDeliveryError";
    this.state = state;
    this.sentIds = [...sentIds];
    this.totalParts = totalParts;
    this.chatId = chatId;
    this.threadId = threadId;
  }
}

interface OutboxResumeResult {
  sent: number;
  failed: number;
  uncertain: number;
  error?: unknown;
}

export class Outbound {
  #token = "";
  readonly #getAccess: () => Access;
  readonly #log?: Logger;
  readonly #sleep?: (ms: number) => Promise<void>;
  readonly #chats = new Map<string, ChatState>();
  readonly #active = new Set<string>();
  #draftUnsupported = false;
  #lastTarget: { chatId: string; threadId?: number } | undefined;
  #missingThreadHandler?: (chatId: string, threadId: number) => Promise<number | undefined>;
  /**
   * Timestamp of the newest assistant message a turn_end has finalized. omp
   * delivers message_update through a queue it does not await, so a stale
   * snapshot can land after turn_end; replaying it would re-dirty the turn and
   * send its partial text as a second reply.
   */
  #finalizedThrough = 0;

  constructor(getAccess: () => Access, log?: Logger, sleep?: (ms: number) => Promise<void>) {
    this.#getAccess = getAccess;
    this.#log = log;
    this.#sleep = sleep;
  }

  setToken(token: string): void {
    this.#token = token;
  }

  setMissingThreadHandler(handler: (chatId: string, threadId: number) => Promise<number | undefined>): void {
    this.#missingThreadHandler = handler;
  }

  hasToken(): boolean {
    return this.#token.length > 0;
  }

  /** Whether any Telegram inbound is active — locally-typed prompts never mirror. */
  isActive(): boolean {
    return this.#active.size > 0;
  }

  /** Most recent inbound chat, for tool chat_id defaulting. */
  lastChat(): string | undefined {
    return this.#lastTarget?.chatId;
  }

  /** Most recent inbound target (chat + optional topic), for tool defaulting. */
  lastTarget(): { chatId: string; threadId?: number } | undefined {
    return this.#lastTarget;
  }

  /** Chats with a live Telegram turn (normal replies route here). */
  activeTargets(): Array<{ chatId: string; threadId?: number }> {
    const targets: Array<{ chatId: string; threadId?: number }> = [];
    for (const key of this.#active) {
      const st = this.#chats.get(key);
      if (st) targets.push({ chatId: st.chatId, threadId: st.threadId });
    }
    return targets;
  }

  pendingDeliveries(): Array<{
    chatId: string;
    threadId?: number;
    state: "failed" | "uncertain";
    parts: number;
    unsent: number;
    updatedAt: number;
  }> {
    const deliveries: Array<{
      chatId: string;
      threadId?: number;
      state: "failed" | "uncertain";
      parts: number;
      unsent: number;
      updatedAt: number;
    }> = [];
    for (const record of listOutboxRecords()) {
      const unsent = record.parts.reduce((count, part) => count + (part.state === "sent" ? 0 : 1), 0);
      if (unsent === 0) continue;
      const uncertain = record.parts.some((part) => part.state === "uncertain" || part.state === "inflight");
      deliveries.push({
        chatId: record.chatId,
        ...(record.threadId != null ? { threadId: record.threadId } : {}),
        state: uncertain ? "uncertain" : "failed",
        parts: record.parts.length,
        unsent,
        updatedAt: record.updatedAt,
      });
    }
    return deliveries;
  }

  /**
   * Run-status notice (retry/failure/recovery) to every chat with a live
   * Telegram turn. Plain text: provider errors carry MarkdownV2-hostile
   * characters. Gated to Telegram turns by construction — #active only fills
   * from Telegram inbound.
   */
  async announce(text: string): Promise<void> {
    if (!this.#token || this.#active.size === 0) return;
    for (const t of this.activeTargets()) {
      await this.send(t.chatId, text, { threadId: t.threadId, format: "text" }).catch((err) =>
        this.#log?.warn("[telegram] announce failed " + t.chatId + ": " + String(err)),
      );
    }
  }

  /** Mark a chat (optionally a forum topic) as an active inbound source; starts typing. */
  markActive(chatId: string, threadId?: number): void {
    this.#lastTarget = { chatId, threadId };
    const key = targetKey(chatId, threadId);
    const already = this.#active.has(key);
    this.#active.add(key);
    if (!already) this.#startTyping(this.#chatState(chatId, threadId));
  }

  /**
   * React {@link SEEN_REACTION} to an inbound message. It switches to
   * {@link REPLIED_REACTION} once a reply reaches its chat: at the end of the
   * first turn that started after this message was accepted, or at run end for
   * replies sent another way. A run can outlive many turns (follow-ups, steers),
   * so waiting for run end alone left 👀 up long after the answer arrived.
   * The replied reaction waits for this send, so a slow 👀 can never overwrite 👍.
   */
  markSeen(chatId: string, threadId: number | undefined, messageId: number): Promise<void> {
    const seen = this.react(chatId, messageId, SEEN_REACTION).catch((err) =>
      this.#log?.debug(`[telegram] seen reaction ${chatId} failed: ${String(err)}`),
    );
    this.#chatState(chatId, threadId).awaitingReply.push({ messageId, seen, seenAt: Date.now() });
    return seen;
  }

  // ---- event inputs (wired from index.ts) --------------------------------

  onMessageUpdate(message: unknown): void {
    if (!this.#token || this.#active.size === 0) return;
    const stamp = messageTimestamp(message);
    if (stamp !== undefined && stamp <= this.#finalizedThrough) return;
    const streaming = effectiveStreaming(this.#getAccess());
    if (streaming === false || streaming === "final" || streaming === "explicit") return;
    const text = assistantText(message);
    if (text.trim().length === 0) return;
    for (const key of this.#active) {
      const st = this.#chats.get(key);
      if (!st) continue;
      void this.#streamChat(st, text).catch((err) => this.#log?.warn(`[telegram] stream error ${key}: ${String(err)}`));
    }
  }

  async onTurnEnd(message: unknown): Promise<void> {
    if (!this.#token || this.#active.size === 0) return;
    // Record before any await: stale updates can arrive while this turn sends.
    const stamp = messageTimestamp(message);
    if (stamp !== undefined && stamp > this.#finalizedThrough) this.#finalizedThrough = stamp;
    const streaming = effectiveStreaming(this.#getAccess());
    if (streaming === "final") return; // one message per run, delivered at agent end
    if (streaming === "explicit") return; // nothing is automatic; the model sends or nobody hears
    const text = assistantText(message);
    for (const key of [...this.#active]) {
      const st = this.#chats.get(key);
      if (!st) continue;
      if (text.trim().length > 0) {
        await this.#finalize(st, text);
        // Only messages accepted before this turn began can be what it answers.
        if (stamp !== undefined) await this.#reactReplied(st, key, (entry) => entry.seenAt < stamp);
      }
      else this.#resetTurn(st);
    }
  }

  /**
   * End of the whole run. In `"final"` mode deliver `finalText` here; in
   * `"explicit"` mode deliver nothing at all; otherwise flush any dirty stream.
   *
   * `"explicit"` deliberately drops `finalText` rather than using it as a
   * fallback for a run that never called `telegram_send`. The run that most
   * needs a fallback is the one a message steered into mid-duty, and there
   * `finalText` is not the answer — it is the closing line of whatever internal
   * work was in flight. Sending it would reintroduce exactly the leak this mode
   * exists to remove, so the mode stays silent and the discipline lives in the
   * prompt: one `telegram_send` per answer.
   */
  async onAgentEnd(finalText?: string): Promise<void> {
    const streaming = effectiveStreaming(this.#getAccess());
    let failure: unknown;
    try {
      for (const key of [...this.#active]) {
        const st = this.#chats.get(key);
        if (!st) continue;
        try {
          // turn_end delivery can still be in flight when agent_end arrives;
          // its failure is reported by the turn_end path.
          if (st.finalizing) await st.finalizing.catch(() => {});
          // "explicit" streams nothing, so there is never a dirty preview to flush.
          if (streaming === "final") {
            if (finalText && finalText.trim().length > 0) await this.#finalize(st, finalText);
          } else if (streaming !== "explicit" && st.dirty) {
            await this.#finalize(st, st.acc);
          }
        } catch (error) {
          failure ??= error;
        } finally {
          const repliedAt = st.repliedAt;
          st.repliedAt = undefined;
          this.#resetTurn(st);
          this.#stopTyping(st);
          if (repliedAt !== undefined) await this.#reactReplied(st, key, (entry) => entry.seenAt <= repliedAt);
          st.awaitingReply = [];
        }
      }
    } finally {
      this.#active.clear();
    }
    if (failure) throw failure;
  }

  async #reactReplied(st: ChatState, key: string, answered: (entry: ChatState["awaitingReply"][number]) => boolean): Promise<void> {
    const due = st.awaitingReply.filter(answered);
    st.awaitingReply = st.awaitingReply.filter((entry) => !due.includes(entry));
    for (const { messageId, seen } of due) {
      await seen;
      await this.react(st.chatId, messageId, REPLIED_REACTION).catch((err) =>
        this.#log?.debug(`[telegram] replied reaction ${key} failed: ${String(err)}`),
      );
    }
  }

  /** Session switch/branch/tree: finalize open previews. Native drafts expire on their own. */
  async onSessionBoundary(): Promise<void> {
    for (const key of [...this.#active]) {
      const st = this.#chats.get(key);
      if (st) {
        if (st.inflight) await st.inflight.catch(() => {});
        if (st.previewMsgId != null) {
          await this.#finalizePreview(st, st.acc.slice(st.sentUpTo), false).catch((err) =>
            this.#log?.warn(`[telegram] boundary finalize ${key}: ${String(err)}`),
          );
        }
        this.#resetTurn(st);
        this.#stopTyping(st);
      }
    }
    this.#active.clear();
  }

  async shutdown(): Promise<void> {
    const states = [...this.#chats.values()];
    for (const st of states) this.#stopTyping(st);
    for (const st of states) {
      if (st.inflight) await st.inflight.catch(() => {});
    }
    this.#chats.clear();
    this.#active.clear();
  }

  // ---- model-tool helpers ------------------------------------------------

  /** Send text with the configured Markdown format and safe labeled fallback. Returns actual message ids. */
  async send(chatId: string, text: string, opts?: { replyTo?: number; format?: "text" | "markdown"; threadId?: number }): Promise<number[]> {
    if (!text) return [];
    const access = this.#getAccess();
    const replyMode = access.replyToMode ?? "first";
    const useMd = (opts?.format ?? "markdown") === "markdown";
    const ids: number[] = [];
    let totalParts = 1;
    let threadId = opts?.threadId;
    let recovered = false;
    const deliver = async <T>(op: () => Promise<T>): Promise<T> => {
      try {
        return await op();
      } catch (err) {
        if (recovered || threadId == null || !isMissingThreadError(err)) throw err;
        const replacement = await this.#recoverMissingThread(chatId, threadId);
        if (replacement == null) throw err;
        recovered = true;
        threadId = replacement;
        return op();
      }
    };
    try {
      let allowRich = true;
      const richBudget = access.textChunkLimit == null ? TELEGRAM_RICH_MAX_CHARS : messageLimit(access);
      if (text.length <= richBudget && this.#wantsRich(text, useMd)) {
        const id = await deliver(() => this.#tryRichSend(chatId, text, this.#threadTarget(opts?.replyTo, replyMode, 0), threadId));
        if (id !== undefined) {
          this.#noteReplied(chatId, opts?.threadId);
          return [id];
        }
        allowRich = false; // Re-split the rejected source; never retry rich for these parts.
      }
      const parts = chunkLabeled(text, messageLimit(access) - MARKDOWN_HEADROOM, access.chunkMode ?? "newline");
      totalParts = parts.length;
      for (let i = 0; i < parts.length; i++) {
        const replyTo = this.#threadTarget(opts?.replyTo, replyMode, i);
        ids.push(await deliver(() => this.#sendOne(chatId, parts[i], useMd, replyTo, threadId, allowRich)));
      }
      this.#noteReplied(chatId, opts?.threadId);
      return ids;
    } catch (error) {
      const failure = new OutboundDeliveryError("message", error, ids, totalParts, chatId, threadId);
      this.#log?.warn(`[telegram] ${failure.state} message delivery ${chatId}: ${failure.message}`);
      throw failure;
    }
  }

  /** Attach files after preflighting the whole list, so local errors upload nothing. */
  async sendFiles(chatId: string, files: string[], replyTo?: number, threadId?: number): Promise<number[]> {
    const prepared: Array<{ file: string; isPhoto: boolean }> = [];
    for (const file of files) {
      assertSendable(file);
      const info = await stat(file);
      if (!info.isFile()) throw new Error(`not a regular file: ${file}`);
      if (info.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(`file too large: ${file} (${(info.size / 1048576).toFixed(1)}MB, max 50MB)`);
      }
      prepared.push({ file, isPhoto: PHOTO_EXTS.has(extname(file).toLowerCase()) });
    }

    const replyMode = this.#getAccess().replyToMode ?? "first";
    const ids: number[] = [];
    let targetThreadId = threadId;
    let recovered = false;
    try {
      for (let i = 0; i < prepared.length; i++) {
        const { file, isPhoto } = prepared[i];
        const upload = async (destinationThreadId: number | undefined): Promise<{ message_id: number }> => {
          const fields: Record<string, string | number | undefined> = { chat_id: chatId };
          if (destinationThreadId != null) fields.message_thread_id = destinationThreadId;
          const reply = this.#threadTarget(replyTo, replyMode, i);
          if (reply != null) fields.reply_parameters = JSON.stringify({ message_id: reply });
          return this.#rateLimited(() =>
            tgUpload<{ message_id: number }>(
              this.#token,
              isPhoto ? "sendPhoto" : "sendDocument",
              fields,
              { field: isPhoto ? "photo" : "document", path: file },
            ),
          );
        };
        try {
          ids.push((await upload(targetThreadId)).message_id);
        } catch (error) {
          if (recovered || targetThreadId == null || !isMissingThreadError(error)) throw error;
          const replacement = await this.#recoverMissingThread(chatId, targetThreadId);
          if (replacement == null) throw error;
          recovered = true;
          targetThreadId = replacement;
          ids.push((await upload(targetThreadId)).message_id);
        }
      }
      this.#noteReplied(chatId, threadId);
      return ids;
    } catch (error) {
      const failure = new OutboundDeliveryError("attachment", error, ids, prepared.length, chatId, targetThreadId);
      this.#log?.warn(`[telegram] ${failure.state} attachment delivery ${chatId}: ${failure.message}`);
      throw failure;
    }
  }

  /**
   * Explicitly retry durable final-delivery failures for one exact chat/topic.
   * Ambiguous attempts remain untouched unless the user opts into duplication risk.
   */
  async retryFailed(
    chatId: string,
    threadId?: number,
    options: { includeUncertain?: boolean } = {},
  ): Promise<{ sent: number; failed: number; uncertain: number }> {
    const totals = { sent: 0, failed: 0, uncertain: 0 };
    for (const snapshot of loadOutboxRecords(chatId, threadId)) {
      const release = claimOutboxRecord(snapshot.id);
      if (!release) continue;
      try {
        const record = loadOutboxRecord(snapshot.id);
        if (!record) continue;
        const result = await this.#resumeOutbox(record, options.includeUncertain === true);
        totals.sent += result.sent;
        totals.failed += result.failed;
        totals.uncertain += result.uncertain;
        if (result.error) {
          this.#log?.warn(`[telegram] retry ${record.id} stopped: ${String(result.error)}`);
        }
      } catch (error) {
        totals.uncertain += 1;
        this.#log?.warn(`[telegram] retry state failure ${snapshot.id}: ${String(error)}`);
      } finally {
        release();
      }
    }
    return totals;
  }

  async react(chatId: string, messageId: number, emoji: string): Promise<void> {
    await tg(this.#token, "setMessageReaction", {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: "emoji", emoji }],
    });
  }

  // ---- streaming internals -----------------------------------------------

  async #streamChat(st: ChatState, text: string): Promise<void> {
    if (st.busy) return; // one push at a time; the next update will catch up
    const now = Date.now();
    if (st.suspendUntil && now < st.suspendUntil) return;
    const useDraft = Number(st.chatId) > 0 && !this.#draftUnsupported && !st.draftBroken;
    if (now - st.lastEditAt < (useDraft ? DRAFT_THROTTLE_MS : EDIT_THROTTLE_MS)) return;
    if (text === st.acc) return;
    st.busy = true;
    st.acc = text;
    st.lastEditAt = now;
    st.dirty = true;
    const work = useDraft ? this.#streamDraft(st, text) : this.#streamEdit(st, text);
    st.inflight = work;
    try {
      await work;
    } catch (err) {
      this.#onStreamError(st, err);
    } finally {
      st.busy = false;
      st.inflight = undefined;
    }
  }

  async #streamDraft(st: ChatState, text: string): Promise<void> {
    if (st.draftId == null) st.draftId = 1 + Math.floor(Math.random() * 0x7fffffff);
    try {
      await tg(this.#token, "sendMessageDraft", {
        chat_id: st.chatId,
        draft_id: st.draftId,
        text: text.slice(-TELEGRAM_MAX_CHARS),
        ...(st.threadId != null ? { message_thread_id: st.threadId } : {}),
      });
    } catch (err) {
      // Only a definitive capability/parameter rejection selects the edit path.
      // Rate limits, server errors, and transport failures are transient.
      if (err instanceof TgError && (err.code === 400 || err.code === 404)) {
        if (st.threadId != null) {
          // message_thread_id is a valid sendMessageDraft param (Bot API 10.1), but a
          // server/bot without DM forum-topic mode still rejects it — fall back to edit
          // streaming for this target only, never the global latch.
          st.draftBroken = true;
          this.#log?.debug(`[telegram] sendMessageDraft+thread unsupported (${err.code}) ${st.chatId}#${st.threadId} — edit streaming`);
          return;
        }
        this.#draftUnsupported = true; // latch for the session; edit path takes over next tick
        this.#log?.debug(`[telegram] sendMessageDraft unsupported (${err.code}) — using edit streaming`);
        return;
      }
      throw err;
    }
  }

  async #streamEdit(st: ChatState, text: string): Promise<void> {
    const access = this.#getAccess();
    const mode = access.chunkMode ?? "newline";
    const budget = messageLimit(access) - MARKDOWN_HEADROOM;
    // A committed segment gets an `(i/n)` label once the total is known, so cut
    // one label short of the budget — for the preview too, so both agree on
    // where the segment ends.
    const segBudget = budget - PART_LABEL_RESERVE;
    const seg = text.slice(st.sentUpTo);
    if (st.previewMsgId != null && text.length - st.sentUpTo > budget) {
      // Overflow: commit the current preview at a source boundary, start fresh.
      const head = seg.slice(0, this.#boundary(seg, segBudget, mode));
      const messageId = st.previewMsgId;
      await this.#finalizePreview(st, head, true);
      st.sentUpTo += head.length;
      st.committed.push({ messageId, text: head });
      st.previewMsgId = undefined;
      return; // remainder rendered as a new preview on the next update
    }
    // The first preview of a turn can already exceed the budget (a fast first burst).
    const body = seg.slice(0, this.#boundary(seg, segBudget, mode)) + CURSOR;
    if (st.previewMsgId == null) {
      const sent = await tg<{ message_id: number }>(this.#token, "sendMessage", {
        chat_id: st.chatId,
        text: body,
        ...(st.threadId != null ? { message_thread_id: st.threadId } : {}),
      });
      st.previewMsgId = sent.message_id;
    } else {
      await tg(this.#token, "editMessageText", { chat_id: st.chatId, message_id: st.previewMsgId, text: body });
    }
  }

  /** First-chunk source cut: paragraph, then line, then space past limit/2, else hard cut. */
  #boundary(seg: string, limit: number, mode: "length" | "newline"): number {
    if (seg.length <= limit) return seg.length;
    if (mode === "length") return limit;
    const para = seg.lastIndexOf("\n\n", limit);
    const line = seg.lastIndexOf("\n", limit);
    const space = seg.lastIndexOf(" ", limit);
    return para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit;
  }

  /** Finalize a live preview with the selected format, removing the cursor. */
  async #finalizePreview(st: ChatState, text: string, useMd: boolean): Promise<void> {
    if (st.previewMsgId == null) return;
    await this.#editDelivered(st.chatId, st.previewMsgId, text, useMd);
  }

  /** Edit in place; only definitive rich rejections may fall back to legacy formatting. */
  async #editDelivered(chatId: string, messageId: number, text: string, useMd: boolean): Promise<void> {
    if (this.#wantsRich(text, useMd)) {
      try {
        await this.#rateLimited(() =>
          tg(this.#token, "editMessageText", { chat_id: chatId, message_id: messageId, rich_message: { markdown: text } }),
        );
        return;
      } catch (err) {
        if (err instanceof TgError && err.code === 400 && /message is not modified/i.test(err.message)) return;
        if (isMissingThreadError(err) || !(err instanceof TgError && (err.code === 400 || err.code === 404))) throw err;
      }
    }
    if (useMd) {
      try {
        await this.#rateLimited(() =>
          tg(this.#token, "editMessageText", { chat_id: chatId, message_id: messageId, text: mdToMarkdownV2(text), parse_mode: "MarkdownV2" }),
        );
        return;
      } catch (err) {
        if (isMissingThreadError(err) || !(err instanceof TgError && err.code === 400)) throw err;
      }
    }
    await this.#rateLimited(() => tg(this.#token, "editMessageText", { chat_id: chatId, message_id: messageId, text }));
  }

  /** Finalize one turn through the crash-safe outbox, then reset per-turn state. */
  #finalize(st: ChatState, fullText: string): Promise<void> {
    // Claim the turn before the first await. agent_end can arrive while this
    // send is in flight; seeing the turn still dirty, the run-end flush would
    // send it a second time (with a stale, shorter preview when throttled).
    st.dirty = false;
    const run = this.#deliverTurn(st, fullText).then(() => {
      st.repliedAt = Date.now();
    });
    st.finalizing = run;
    return run.finally(() => {
      if (st.finalizing === run) st.finalizing = undefined;
    });
  }

  async #deliverTurn(st: ChatState, fullText: string): Promise<void> {
    if (st.inflight) await st.inflight.catch(() => {}); // barrier: let any in-flight push settle
    let record: OutboxRecord | undefined;
    try {
      record = createOutboxRecord(st.chatId, st.threadId, this.#finalParts(st, fullText));
      const result = await this.#resumeOutbox(record, false, st);
      if (result.error || result.failed > 0 || result.uncertain > 0) {
        const cause = result.error ?? new Error("delivery did not reach a confirmed state");
        const ids = record.parts.flatMap((part) => part.state === "sent" && part.messageId != null ? [part.messageId] : []);
        const failure = new OutboundDeliveryError("message", cause, ids, record.parts.length, record.chatId, record.threadId);
        this.#log?.warn(
          `[telegram] final delivery ${failure.state} ${st.chatId}; retained as ${record.id} for /retry: ${failure.message}`,
        );
        throw failure;
      }
      await this.#labelCommitted(st, record.parts.length);
    } catch (error) {
      if (error instanceof OutboundDeliveryError) throw error;
      const ids = record?.parts.flatMap((part) => part.state === "sent" && part.messageId != null ? [part.messageId] : []) ?? [];
      const failure = new OutboundDeliveryError(
        "message",
        error,
        ids,
        record?.parts.length ?? 1,
        record?.chatId ?? st.chatId,
        record?.threadId ?? st.threadId,
      );
      this.#log?.warn(`[telegram] final delivery state failure ${st.chatId}: ${failure.message}`);
      throw failure;
    } finally {
      // No draft cleanup: the final send replaces the DM draft. A later
      // sendMessageDraft (even with empty text, which Telegram renders as a
      // "Thinking…" placeholder) would re-show a stale preview under the reply.
      this.#resetTurn(st);
    }
  }

  #finalParts(st: ChatState, fullText: string): OutboxPart[] {
    const access = this.#getAccess();
    const prior: OutboxPart[] = st.committed.map((part) => ({
      kind: "edit",
      text: part.text,
      useMd: true,
      allowRich: true,
      state: "sent",
      existingMessageId: part.messageId,
      messageId: part.messageId,
    }));
    const richBudget = access.textChunkLimit == null ? TELEGRAM_RICH_MAX_CHARS : messageLimit(access);
    if (
      prior.length === 0 &&
      st.previewMsgId == null &&
      st.sentUpTo === 0 &&
      fullText.length <= richBudget &&
      this.#wantsRich(fullText, true)
    ) {
      return [{ kind: "rich", text: fullText, useMd: true, allowRich: true, state: "pending" }];
    }

    const chunks = chunkLabeled(
      fullText.slice(st.sentUpTo),
      messageLimit(access) - MARKDOWN_HEADROOM,
      access.chunkMode ?? "newline",
      prior.length,
    );
    if (st.previewMsgId != null) {
      const [head = fullText.slice(st.sentUpTo), ...tail] = chunks;
      prior.push({
        kind: "edit",
        text: head,
        useMd: true,
        allowRich: true,
        state: "pending",
        existingMessageId: st.previewMsgId,
      });
      prior.push(...tail.map((text): OutboxPart => ({
        kind: "send",
        text,
        useMd: true,
        allowRich: true,
        state: "pending",
      })));
      return prior;
    }
    prior.push(...chunks.map((text): OutboxPart => ({
      kind: "send",
      text,
      useMd: true,
      allowRich: true,
      state: "pending",
    })));
    return prior;
  }

  async #resumeOutbox(record: OutboxRecord, includeUncertain: boolean, st?: ChatState): Promise<OutboxResumeResult> {
    const result: OutboxResumeResult = { sent: 0, failed: 0, uncertain: 0 };
    let recovered = false;
    for (let index = 0; index < record.parts.length; index++) {
      const part = record.parts[index];
      if (part.state === "sent") continue;
      const wasUncertain = part.state === "uncertain" || part.state === "inflight";
      if (wasUncertain) {
        result.uncertain += 1;
        if (!includeUncertain) return result;
        this.#log?.warn(
          `[telegram] explicitly retrying uncertain delivery ${record.id} part ${index + 1}; Telegram may already have accepted it`,
        );
      }

      part.state = "inflight";
      part.detail = undefined;
      saveOutboxRecord(record);
      try {
        let messageId: number;
        if (part.kind === "rich") {
          const richId = await this.#tryRichSend(record.chatId, part.text, undefined, record.threadId);
          if (richId == null) {
            const access = this.#getAccess();
            const fallback = chunkLabeled(
              part.text,
              messageLimit(access) - MARKDOWN_HEADROOM,
              access.chunkMode ?? "newline",
            ).map((text): OutboxPart => ({
              kind: "send",
              text,
              useMd: part.useMd,
              allowRich: false,
              state: "pending",
            }));
            record.parts.splice(index, 1, ...fallback);
            saveOutboxRecord(record);
            index -= 1;
            continue;
          }
          messageId = richId;
        } else if (part.kind === "edit" && part.existingMessageId != null) {
          await this.#editDelivered(record.chatId, part.existingMessageId, part.text, part.useMd);
          messageId = part.existingMessageId;
        } else {
          messageId = await this.#sendOne(
            record.chatId,
            part.text,
            part.useMd,
            undefined,
            record.threadId,
            part.allowRich,
          );
        }
        part.state = "sent";
        part.messageId = messageId;
        part.detail = undefined;
        saveOutboxRecord(record);
        result.sent += 1;
      } catch (error) {
        if (!recovered && record.threadId != null && isMissingThreadError(error)) {
          try {
            const replacement = await this.#recoverMissingThread(record.chatId, record.threadId, st);
            if (replacement != null) {
              recovered = true;
              record.threadId = replacement;
              if (part.kind === "edit") {
                part.kind = "send";
                part.existingMessageId = undefined;
              }
              part.state = "pending";
              part.detail = undefined;
              saveOutboxRecord(record);
              index -= 1;
              continue;
            }
          } catch (recoveryError) {
            this.#log?.warn(`[telegram] topic recovery failed ${record.chatId}: ${String(recoveryError)}`);
          }
        }
        const state = deliveryFailureState(error);
        part.state = state;
        part.detail = String(error);
        saveOutboxRecord(record);
        if (state === "failed") result.failed += 1;
        else if (!wasUncertain) result.uncertain += 1;
        result.error = error;
        return result;
      }
    }
    removeOutboxRecord(record.id);
    return result;
  }

  /**
   * Backfill `(i/n)` on the segments committed mid-stream: their number is only
   * known once the turn ends, so the label is edited in afterwards. A failed
   * relabel costs a label, never content.
   */
  async #labelCommitted(st: ChatState, total: number): Promise<void> {
    if (total < 2) return;
    for (const [i, part] of st.committed.entries()) {
      await this.#editDelivered(st.chatId, part.messageId, `(${i + 1}/${total})\n${part.text}`, true).catch((err) =>
        this.#log?.debug(`[telegram] relabel ${st.chatId}#${part.messageId} failed: ${String(err)}`),
      );
    }
  }

  async #recoverMissingThread(chatId: string, threadId: number, state?: ChatState): Promise<number | undefined> {
    const replacement = await this.#missingThreadHandler?.(chatId, threadId);
    if (replacement == null) return undefined;
    const oldKey = targetKey(chatId, threadId);
    const current = state ?? this.#chats.get(oldKey);
    if (current) {
      if (this.#chats.get(oldKey) === current) this.#chats.delete(oldKey);
      current.threadId = replacement;
      this.#chats.set(targetKey(chatId, replacement), current);
    }
    if (this.#active.delete(oldKey)) this.#active.add(targetKey(chatId, replacement));
    if (this.#lastTarget?.chatId === chatId && this.#lastTarget.threadId === threadId) {
      this.#lastTarget = { chatId, threadId: replacement };
    }
    return replacement;
  }

  #wantsRich(text: string, useMd: boolean): boolean {
    if (!useMd || !text) return false;
    const mode = this.#getAccess().richMessages;
    return mode === "on" || (mode === "auto" && hasRichConstructs(text));
  }

  async #tryRichSend(chatId: string, text: string, replyTo: number | undefined, threadId?: number): Promise<number | undefined> {
    try {
      const sent = await this.#rateLimited(() =>
        tg<{ message_id: number }>(this.#token, "sendRichMessage", {
          chat_id: chatId,
          rich_message: { markdown: text },
          ...(threadId != null ? { message_thread_id: threadId } : {}),
          ...(replyTo != null ? { reply_parameters: { message_id: replyTo } } : {}),
        }),
      );
      return sent.message_id;
    } catch (err) {
      if (isMissingThreadError(err) || !(err instanceof TgError && (err.code === 400 || err.code === 404))) throw err;
      return undefined;
    }
  }

  async #sendOne(chatId: string, text: string, useMd: boolean, replyTo: number | undefined, threadId?: number, allowRich = true): Promise<number> {
    if (allowRich && this.#wantsRich(text, useMd)) {
      const id = await this.#tryRichSend(chatId, text, replyTo, threadId);
      if (id !== undefined) return id;
    }
    const reply = replyTo != null ? { reply_parameters: { message_id: replyTo } } : {};
    const thread = threadId != null ? { message_thread_id: threadId } : {};
    if (useMd) {
      try {
        const sent = await this.#rateLimited(() =>
          tg<{ message_id: number }>(this.#token, "sendMessage", {
            chat_id: chatId,
            text: mdToMarkdownV2(text),
            parse_mode: "MarkdownV2",
            ...thread,
            ...reply,
          }),
        );
        return sent.message_id;
      } catch (err) {
        if (isMissingThreadError(err) || !(err instanceof TgError && err.code === 400)) throw err;
      }
    }
    const sent = await this.#rateLimited(() =>
      tg<{ message_id: number }>(this.#token, "sendMessage", { chat_id: chatId, text, ...thread, ...reply }),
    );
    return sent.message_id;
  }

  /** Run a Telegram delivery with the shared rate-limit retry (and this instance's test seam). */
  #rateLimited<T>(op: () => Promise<T>): Promise<T> {
    return withRateLimit(op, { sleep: this.#sleep, log: this.#log });
  }

  #onStreamError(st: ChatState, err: unknown): void {
    if (err instanceof TgError && (err.retryAfter != null || err.code === 429)) {
      const retryAfter = err.retryAfter ?? 1;
      st.suspendUntil = Date.now() + retryAfter * 1000 + 250;
      this.#log?.debug(`[telegram] 429 ${st.chatId} — pausing stream ${retryAfter}s`);
      return;
    }
    this.#log?.debug(`[telegram] stream edit failed ${st.chatId}: ${String(err)}`);
  }

  #threadTarget(replyTo: number | undefined, mode: "off" | "first" | "all", index: number): number | undefined {
    if (replyTo == null || mode === "off") return undefined;
    return mode === "all" || index === 0 ? replyTo : undefined;
  }

  #startTyping(st: ChatState): void {
    if (st.typingTimer) return;
    const ping = (): void => {
      void tg(this.#token, "sendChatAction", {
        chat_id: st.chatId,
        action: "typing",
        ...(st.threadId != null ? { message_thread_id: st.threadId } : {}),
      }).catch(() => {});
    };
    ping();
    st.typingTimer = setInterval(ping, TYPING_INTERVAL_MS);
    st.typingTimer.unref?.();
  }

  #stopTyping(st: ChatState): void {
    if (st.typingTimer) {
      clearInterval(st.typingTimer);
      st.typingTimer = undefined;
    }
  }

  #noteReplied(chatId: string, threadId?: number): void {
    const st = this.#chats.get(targetKey(chatId, threadId));
    if (st) st.repliedAt = Date.now();
  }

  #chatState(chatId: string, threadId?: number): ChatState {
    const key = targetKey(chatId, threadId);
    let st = this.#chats.get(key);
    if (!st) {
      st = { chatId, threadId, acc: "", sentUpTo: 0, committed: [], lastEditAt: 0, dirty: false, busy: false, awaitingReply: [] };
      this.#chats.set(key, st);
    }
    return st;
  }

  #resetTurn(st: ChatState): void {
    st.draftId = undefined;
    st.previewMsgId = undefined;
    st.acc = "";
    st.sentUpTo = 0;
    st.committed = [];
    st.lastEditAt = 0;
    st.dirty = false;
  }
}
