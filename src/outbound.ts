// Per-chat outbound delivery: streams the assistant's in-progress text to
// Telegram (native message drafts for DMs, edit-based preview for groups /
// draft-unsupported), finalizes one real message per agent turn, and exposes
// send/file/react helpers for the model tools. All Telegram I/O funnels through
// here so the outbound-chat gate and formatting live in one place.

import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { type Access, assertSendable } from "./access";
import { type Logger, TgError, tg, tgUpload } from "./api";
import { MARKDOWN_HEADROOM, TELEGRAM_MAX_CHARS, chunk, mdToMarkdownV2 } from "./markdown";

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
  /** Throttle timestamp of the last stream push. */
  lastEditAt: number;
  /** True while this turn has unfinalized streamed content. */
  dirty: boolean;
  /** A stream push is in flight (mutual exclusion + finalize barrier). */
  busy: boolean;
  /** The in-flight stream push, awaited by finalize to avoid racing edits. */
  inflight?: Promise<void>;
  /** 429 backoff: suspend stream pushes until this timestamp. */
  suspendUntil?: number;
  /** sendMessageDraft rejected message_thread_id for this target — use the edit path. */
  draftBroken?: boolean;
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

/** Last visible assistant text in a message list (text blocks only; "" when none). */
export function finalAssistantText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = assistantText(messages[i]);
    if (t.trim().length > 0) return t;
  }
  return "";
}

export class Outbound {
  #token = "";
  readonly #getAccess: () => Access;
  readonly #log?: Logger;
  readonly #chats = new Map<string, ChatState>();
  readonly #active = new Set<string>();
  #draftUnsupported = false;
  #lastTarget: { chatId: string; threadId?: number } | undefined;

  constructor(getAccess: () => Access, log?: Logger) {
    this.#getAccess = getAccess;
    this.#log = log;
  }

  setToken(token: string): void {
    this.#token = token;
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

  /** Mark a chat (optionally a forum topic) as an active inbound source; starts typing. */
  markActive(chatId: string, threadId?: number): void {
    this.#lastTarget = { chatId, threadId };
    const key = targetKey(chatId, threadId);
    const already = this.#active.has(key);
    this.#active.add(key);
    if (!already) this.#startTyping(this.#chatState(chatId, threadId));
  }

  // ---- event inputs (wired from index.ts) --------------------------------

  onMessageUpdate(message: unknown): void {
    if (!this.#token || this.#active.size === 0) return;
    if (this.#getAccess().streaming === false) return;
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
    const text = assistantText(message);
    for (const key of [...this.#active]) {
      const st = this.#chats.get(key);
      if (!st) continue;
      if (text.trim().length > 0) await this.#finalize(st, text);
      else this.#resetTurn(st);
    }
  }

  async onAgentEnd(): Promise<void> {
    for (const key of [...this.#active]) {
      const st = this.#chats.get(key);
      if (st?.dirty) await this.#finalize(st, st.acc);
      if (st) this.#stopTyping(st);
    }
    this.#active.clear();
  }

  /** Session switch/branch/tree: finalize open previews as plain text, keep running. */
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

  shutdown(): void {
    for (const st of this.#chats.values()) this.#stopTyping(st);
    this.#chats.clear();
    this.#active.clear();
  }

  // ---- model-tool helpers ------------------------------------------------

  /** Send text to a chat, chunked + MarkdownV2 (plain fallback on parse error). Returns message ids. */
  async send(chatId: string, text: string, opts?: { replyTo?: number; format?: "text" | "markdown"; threadId?: number }): Promise<number[]> {
    const access = this.#getAccess();
    const budget = this.#chunkLimit(access) - MARKDOWN_HEADROOM;
    const parts = chunk(text, budget, access.chunkMode ?? "newline");
    if (parts.length === 0) return [];
    const replyMode = access.replyToMode ?? "first";
    const useMd = (opts?.format ?? "markdown") === "markdown";
    const ids: number[] = [];
    for (let i = 0; i < parts.length; i++) {
      const thread = this.#threadTarget(opts?.replyTo, replyMode, i);
      ids.push(await this.#sendOne(chatId, parts[i], useMd, thread, opts?.threadId));
    }
    return ids;
  }

  /** Attach files: images as photos, others as documents. Guards state-dir files and 50MB cap. */
  async sendFiles(chatId: string, files: string[], replyTo?: number, threadId?: number): Promise<number[]> {
    const replyMode = this.#getAccess().replyToMode ?? "first";
    const ids: number[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      assertSendable(f);
      const info = await stat(f);
      if (info.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(`file too large: ${f} (${(info.size / 1048576).toFixed(1)}MB, max 50MB)`);
      }
      const isPhoto = PHOTO_EXTS.has(extname(f).toLowerCase());
      const fields: Record<string, string | number | undefined> = { chat_id: chatId };
      if (threadId != null) fields.message_thread_id = threadId;
      const thread = this.#threadTarget(replyTo, replyMode, i);
      if (thread != null) fields.reply_parameters = JSON.stringify({ message_id: thread });
      const sent = await tgUpload<{ message_id: number }>(
        this.#token,
        isPhoto ? "sendPhoto" : "sendDocument",
        fields,
        { field: isPhoto ? "photo" : "document", path: f },
      );
      ids.push(sent.message_id);
    }
    return ids;
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
      if (err instanceof TgError) {
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
    const budget = this.#chunkLimit(access) - MARKDOWN_HEADROOM;
    if (st.previewMsgId != null && text.length - st.sentUpTo > budget) {
      // Overflow: finalize the current preview at a source boundary, start fresh.
      const seg = text.slice(st.sentUpTo);
      const head = seg.slice(0, this.#boundary(seg, budget, access.chunkMode ?? "newline"));
      await this.#finalizePreview(st, head, true);
      st.sentUpTo += head.length;
      st.previewMsgId = undefined;
      return; // remainder rendered as a new preview on the next update
    }
    const body = text.slice(st.sentUpTo) + CURSOR;
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

  /** Finalize a live preview: MarkdownV2 attempt then plain fallback, cursor removed. */
  async #finalizePreview(st: ChatState, text: string, useMd: boolean): Promise<void> {
    if (st.previewMsgId == null) return;
    const id = st.previewMsgId;
    if (useMd) {
      try {
        await tg(this.#token, "editMessageText", { chat_id: st.chatId, message_id: id, text: mdToMarkdownV2(text), parse_mode: "MarkdownV2" });
        return;
      } catch (err) {
        if (!(err instanceof TgError && err.code === 400)) throw err;
      }
    }
    await tg(this.#token, "editMessageText", { chat_id: st.chatId, message_id: id, text });
  }

  /** Finalize one turn into real message(s), then reset per-turn state. */
  async #finalize(st: ChatState, fullText: string): Promise<void> {
    if (st.inflight) await st.inflight.catch(() => {}); // barrier: let any in-flight push settle
    const access = this.#getAccess();
    const budget = this.#chunkLimit(access) - MARKDOWN_HEADROOM;
    const mode = access.chunkMode ?? "newline";
    try {
      if (st.previewMsgId != null) {
        const parts = chunk(fullText.slice(st.sentUpTo), budget, mode);
        await this.#finalizePreview(st, parts[0] ?? fullText.slice(st.sentUpTo), true);
        for (let i = 1; i < parts.length; i++) await this.#sendOne(st.chatId, parts[i], true, undefined, st.threadId);
      } else {
        for (const part of chunk(fullText, budget, mode)) await this.#sendOne(st.chatId, part, true, undefined, st.threadId);
        if (st.draftId != null) {
          // Clear the ephemeral draft so it doesn't linger beside the real message.
          await tg(this.#token, "sendMessageDraft", {
            chat_id: st.chatId,
            draft_id: st.draftId,
            text: "",
            ...(st.threadId != null ? { message_thread_id: st.threadId } : {}),
          }).catch(() => {});
        }
      }
    } catch (err) {
      this.#log?.warn(`[telegram] finalize failed ${st.chatId}: ${String(err)}`);
    } finally {
      this.#resetTurn(st);
    }
  }

  async #sendOne(chatId: string, text: string, useMd: boolean, replyTo: number | undefined, threadId?: number): Promise<number> {
    const reply = replyTo != null ? { reply_parameters: { message_id: replyTo } } : {};
    const thread = threadId != null ? { message_thread_id: threadId } : {};
    if (useMd) {
      try {
        const sent = await tg<{ message_id: number }>(this.#token, "sendMessage", {
          chat_id: chatId,
          text: mdToMarkdownV2(text),
          parse_mode: "MarkdownV2",
          ...thread,
          ...reply,
        });
        return sent.message_id;
      } catch (err) {
        if (!(err instanceof TgError && err.code === 400)) throw err;
      }
    }
    const sent = await tg<{ message_id: number }>(this.#token, "sendMessage", { chat_id: chatId, text, ...thread, ...reply });
    return sent.message_id;
  }

  #onStreamError(st: ChatState, err: unknown): void {
    if (err instanceof TgError && err.retryAfter) {
      st.suspendUntil = Date.now() + err.retryAfter * 1000 + 250;
      this.#log?.debug(`[telegram] 429 ${st.chatId} — pausing stream ${err.retryAfter}s`);
      return;
    }
    this.#log?.debug(`[telegram] stream edit failed ${st.chatId}: ${String(err)}`);
  }

  #threadTarget(replyTo: number | undefined, mode: "off" | "first" | "all", index: number): number | undefined {
    if (replyTo == null || mode === "off") return undefined;
    return mode === "all" || index === 0 ? replyTo : undefined;
  }

  #chunkLimit(access: Access): number {
    return Math.max(1, Math.min(access.textChunkLimit ?? TELEGRAM_MAX_CHARS, TELEGRAM_MAX_CHARS));
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

  #chatState(chatId: string, threadId?: number): ChatState {
    const key = targetKey(chatId, threadId);
    let st = this.#chats.get(key);
    if (!st) {
      st = { chatId, threadId, acc: "", sentUpTo: 0, lastEditAt: 0, dirty: false, busy: false };
      this.#chats.set(key, st);
    }
    return st;
  }

  #resetTurn(st: ChatState): void {
    st.draftId = undefined;
    st.previewMsgId = undefined;
    st.acc = "";
    st.sentUpTo = 0;
    st.lastEditAt = 0;
    st.dirty = false;
  }
}
