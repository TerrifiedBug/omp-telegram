import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Access, controlTopicTarget, loadAccess, pairedOwnerId, statePath } from "./access";
import type { TgCallbackQuery, TgMessage } from "./api";
import { sendCommandMessage, type TelegramCall } from "./control";
import { DM_ROUTE_KEY, isAlive, writeRouted } from "./topics";

export interface SessionStatusSnapshot {
  pid: number;
  sessionId: string;
  sessionFile?: string;
  name: string;
  cwd: string;
  chatId?: string;
  threadId?: number;
  state: "running" | "idle" | "waiting";
  model?: string;
  thinking?: string;
  contextPercent?: number;
  pending: boolean;
  lastActivityAt: number;
}
export interface SessionCardCallbackTarget {
  pid: number;
  sessionId: string;
  chatId: string;
  threadId?: number;
  originPrivate: boolean;
  queryId: string;
}

/** Bind a synthetic command to the exact session route authorized by a card. */
export function sessionCardCallbackId(target: SessionCardCallbackTarget): string {
  return `session-card:${Buffer.from(JSON.stringify(target)).toString("base64url")}`;
}

/** Recover the exact card target at routed-command dispatch time. */
export function parseSessionCardCallbackId(value: string | undefined): SessionCardCallbackTarget | undefined {
  if (!value?.startsWith("session-card:")) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value.slice("session-card:".length), "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") return undefined;
    const target = parsed as Partial<SessionCardCallbackTarget>;
    if (
      !Number.isSafeInteger(target.pid) ||
      typeof target.sessionId !== "string" ||
      target.sessionId.length === 0 ||
      typeof target.chatId !== "string" ||
      typeof target.originPrivate !== "boolean" ||
      typeof target.queryId !== "string" ||
      (target.threadId != null && !Number.isSafeInteger(target.threadId))
    ) return undefined;
    return target as SessionCardCallbackTarget;
  } catch {
    return undefined;
  }
}


type InlineKeyboard = { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };

interface SessionCardRecord {
  nonce: string;
  ownerId: string;
  cardChatId: string;
  cardThreadId?: number;
  messageId: number;
  pid: number;
  sessionId: string;
  targetChatId?: string;
  targetThreadId?: number;
  createdAt: number;
}

interface SessionListTarget {
  pid: number;
  sessionId: string;
  chatId?: string;
  threadId?: number;
}

interface SessionListPicker {
  ownerId: string;
  chatId: string;
  threadId?: number;
  messageId: number;
  targets: Map<number, SessionListTarget>;
  expiresAt: number;
}

const STATUS_DIR = "session-status";
const CARD_DIR = "session-cards";
const LIST_TTL_MS = 5 * 60_000;

function statusDir(): string {
  return statePath(STATUS_DIR);
}

function cardsDir(): string {
  return statePath(CARD_DIR);
}

function statusPath(pid: number): string {
  return join(statusDir(), `${pid}.json`);
}

function cardPath(nonce: string): string {
  return join(cardsDir(), `${nonce}.json`);
}

function atomicWrite(path: string, value: unknown): void {
  const dir = path.slice(0, path.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as T) : undefined;
  } catch {
    return undefined;
  }
}

function validSnapshot(value: SessionStatusSnapshot | undefined): value is SessionStatusSnapshot {
  return !!value &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    typeof value.name === "string" &&
    typeof value.cwd === "string" &&
    (value.state === "running" || value.state === "idle" || value.state === "waiting") &&
    typeof value.pending === "boolean" &&
    typeof value.lastActivityAt === "number";
}

function readStatus(pid: number): SessionStatusSnapshot | undefined {
  const snapshot = readJson<SessionStatusSnapshot>(statusPath(pid));
  return validSnapshot(snapshot) ? snapshot : undefined;
}

export function listSessionStatuses(alive: (pid: number) => boolean = isAlive): SessionStatusSnapshot[] {
  let names: string[];
  try {
    names = readdirSync(statusDir());
  } catch {
    return [];
  }
  const statuses: SessionStatusSnapshot[] = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    const snapshot = readJson<SessionStatusSnapshot>(join(statusDir(), name));
    if (validSnapshot(snapshot) && alive(snapshot.pid)) statuses.push(snapshot);
  }
  return statuses.sort((a, b) => b.lastActivityAt - a.lastActivityAt || a.name.localeCompare(b.name));
}

function readCards(): SessionCardRecord[] {
  let names: string[];
  try {
    names = readdirSync(cardsDir());
  } catch {
    return [];
  }
  const cards: SessionCardRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.includes(".tmp-")) continue;
    const card = readJson<SessionCardRecord>(join(cardsDir(), name));
    if (
      card &&
      typeof card.nonce === "string" &&
      typeof card.ownerId === "string" &&
      typeof card.cardChatId === "string" &&
      typeof card.messageId === "number" &&
      typeof card.pid === "number" &&
      typeof card.sessionId === "string"
    ) cards.push(card);
  }
  return cards;
}

function sameTarget(snapshot: SessionStatusSnapshot, target: Pick<SessionCardRecord, "pid" | "sessionId" | "targetChatId" | "targetThreadId">): boolean {
  return snapshot.pid === target.pid &&
    snapshot.sessionId === target.sessionId &&
    snapshot.chatId === target.targetChatId &&
    snapshot.threadId === target.targetThreadId;
}
function currentSessionTarget(access: Access, ownerId: string, snapshot: SessionStatusSnapshot): boolean {
  if (!snapshot.chatId) return false;
  if (snapshot.threadId == null) return snapshot.chatId === ownerId;
  if (snapshot.chatId !== access.topicsChat) return false;
  return snapshot.chatId === ownerId || Object.hasOwn(access.groups, snapshot.chatId);
}

function currentCardLocation(access: Access, ownerId: string, card: SessionCardRecord): boolean {
  return card.cardChatId === ownerId ||
    (card.cardChatId === access.topicsChat && Object.hasOwn(access.groups, card.cardChatId));
}


function ageText(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

export function formatSessionCard(snapshot: SessionStatusSnapshot, now = Date.now()): string {
  const state = snapshot.state === "waiting" ? "waiting for input" : snapshot.state;
  const context = snapshot.contextPercent == null
    ? "unknown"
    : `${Math.max(0, Math.min(100, Math.round(snapshot.contextPercent)))}%`;
  return [
    snapshot.name || "omp session",
    `State: ${state}`,
    `Session: ${snapshot.sessionId}`,
    `Directory: ${snapshot.cwd}`,
    `Model: ${snapshot.model ?? "unknown"}`,
    `Thinking: ${snapshot.thinking ?? "unknown"}`,
    `Context: ${context}`,
    `Pending message: ${snapshot.pending ? "yes" : "no"}`,
    `Last activity: ${ageText(snapshot.lastActivityAt, now)}`,
  ].join("\n");
}

function cardKeyboard(nonce: string): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: "Refresh", callback_data: `sc:r:${nonce}` },
        { text: "Stop", callback_data: `sc:s:${nonce}` },
      ],
      [
        { text: "Model", callback_data: `sc:m:${nonce}` },
        { text: "Thinking", callback_data: `sc:t:${nonce}` },
        { text: "Compact", callback_data: `sc:c:${nonce}` },
      ],
    ],
  };
}

async function editPublishedCard(callTelegram: TelegramCall, card: SessionCardRecord, snapshot: SessionStatusSnapshot): Promise<void> {
  await callTelegram("editMessageText", {
    chat_id: card.cardChatId,
    ...(card.cardThreadId == null ? {} : { message_thread_id: card.cardThreadId }),
    message_id: card.messageId,
    text: formatSessionCard(snapshot),
    reply_markup: cardKeyboard(card.nonce),
  }).catch(() => undefined);
}

/** Persist a process snapshot and refresh every still-bound card in place. */
export async function publishSessionStatus(snapshot: SessionStatusSnapshot, callTelegram?: TelegramCall): Promise<void> {
  if (!validSnapshot(snapshot)) throw new Error("invalid session status snapshot");
  atomicWrite(statusPath(snapshot.pid), snapshot);
  if (!callTelegram) return;
  const access = loadAccess();
  const ownerId = pairedOwnerId(access);
  if (!ownerId || !currentSessionTarget(access, ownerId, snapshot)) return;
  for (const card of readCards()) {
    if (
      card.ownerId !== ownerId ||
      !sameTarget(snapshot, card) ||
      !currentCardLocation(access, ownerId, card)
    ) continue;
    await editPublishedCard(callTelegram, card, snapshot);
  }
}

/** Remove a stopped process and every card whose callbacks targeted it. */
export function removeSessionStatus(pid: number): void {
  rmSync(statusPath(pid), { force: true });
  for (const card of readCards()) {
    if (card.pid === pid) rmSync(cardPath(card.nonce), { force: true });
  }
}

export interface SessionCardControllerOptions {
  getAccess: () => Access;
  callTelegram: TelegramCall;
  warn?: (message: string) => void;
  nonce?: () => string;
  now?: () => number;
  alive?: (pid: number) => boolean;
}

/** Owner-authenticated session lists and durable, cross-process session cards. */
export class SessionCardController {
  readonly #getAccess: () => Access;
  readonly #call: TelegramCall;
  readonly #warn: (message: string) => void;
  readonly #nonce: () => string;
  readonly #now: () => number;
  readonly #alive: (pid: number) => boolean;
  readonly #lists = new Map<string, SessionListPicker>();

  constructor(options: SessionCardControllerOptions) {
    this.#getAccess = options.getAccess;
    this.#call = options.callTelegram;
    this.#warn = options.warn ?? (() => undefined);
    this.#nonce = options.nonce ?? (() => randomBytes(6).toString("base64url"));
    this.#now = options.now ?? Date.now;
    this.#alive = options.alive ?? isAlive;
  }

  async sendList(msg: TgMessage, text: string): Promise<void> {
    const access = this.#getAccess();
    const ownerId = pairedOwnerId(access);
    if (!ownerId || String(msg.from?.id ?? "") !== ownerId) return;
    const statuses = listSessionStatuses(this.#alive);
    const nonce = this.#nonce();
    this.#pruneLists();
    const replyMarkup: InlineKeyboard | undefined = statuses.length === 0
      ? undefined
      : {
          inline_keyboard: statuses.map((snapshot) => [{
            text: `${snapshot.state === "running" ? "Running" : snapshot.state === "waiting" ? "Waiting" : "Idle"} · ${snapshot.name}`.slice(0, 60),
            callback_data: `sl:o:${nonce}:${snapshot.pid}`,
          }]),
        };
    const expectedTarget = controlTopicTarget(access) ?? {
      chatId: String(msg.chat.id),
      ...(msg.is_topic_message && msg.message_thread_id != null ? { threadId: msg.message_thread_id } : {}),
    };
    const sent = await sendCommandMessage({
      access,
      callTelegram: this.#call,
      msg,
      text,
      replyMarkup,
      warn: this.#warn,
    });
    if (!sent || !replyMarkup) return;
    const sentThreadId = sent.message_thread_id ?? expectedTarget.threadId;
    this.#lists.set(nonce, {
      ownerId,
      chatId: String(sent.chat?.id ?? expectedTarget.chatId),
      ...(sentThreadId == null ? {} : { threadId: sentThreadId }),
      messageId: sent.message_id,
      targets: new Map(statuses.map((snapshot) => [snapshot.pid, {
        pid: snapshot.pid,
        sessionId: snapshot.sessionId,
        chatId: snapshot.chatId,
        threadId: snapshot.threadId,
      }])),
      expiresAt: this.#now() + LIST_TTL_MS,
    });
  }

  async handleMessage(
    msg: TgMessage,
    parsed: { name: string; args: string },
    identity?: { sessionId?: string; sessionFile?: string },
  ): Promise<boolean> {
    if (parsed.name !== "session") return false;
    const access = this.#getAccess();
    const ownerId = pairedOwnerId(access);
    if (!ownerId || String(msg.from?.id ?? "") !== ownerId) return true;
    const candidates = listSessionStatuses(this.#alive).filter((snapshot) =>
      snapshot.chatId === String(msg.chat.id) &&
      snapshot.threadId === (msg.is_topic_message ? msg.message_thread_id : undefined) &&
      (identity?.sessionId ? snapshot.sessionId === identity.sessionId : true) &&
      (identity?.sessionFile ? snapshot.sessionFile === identity.sessionFile : true),
    );
    if (candidates.length !== 1) {
      await this.#call("sendMessage", {
        chat_id: String(msg.chat.id),
        ...(msg.is_topic_message && msg.message_thread_id != null ? { message_thread_id: msg.message_thread_id } : {}),
        text: "This topic is not attached to one live omp session.",
      }).catch(() => undefined);
      return true;
    }
    await this.#sendCard(candidates[0], ownerId, String(msg.chat.id), msg.message_thread_id);
    return true;
  }

  /** Returns false only for callbacks that do not belong to session lists/cards. */
  async handleCallback(query: TgCallbackQuery): Promise<boolean> {
    const data = query.data;
    if (!data?.startsWith("sl:") && !data?.startsWith("sc:")) return false;
    const message = query.message;
    const access = this.#getAccess();
    const ownerId = pairedOwnerId(access);
    if (!message || !ownerId || String(query.from.id) !== ownerId) {
      await this.#answer(query.id, "This control is restricted to the paired owner.", true);
      return true;
    }
    return data.startsWith("sl:")
      ? this.#handleListCallback(query, ownerId)
      : this.#handleCardCallback(query, access, ownerId);
  }

  async #handleListCallback(query: TgCallbackQuery, ownerId: string): Promise<true> {
    const message = query.message!;
    const [, action, nonce, pidText] = query.data!.split(":");
    this.#pruneLists();
    const picker = this.#lists.get(nonce ?? "");
    const pid = Number(pidText);
    const target = picker?.targets.get(pid);
    if (
      action !== "o" ||
      !picker ||
      picker.ownerId !== ownerId ||
      picker.chatId !== String(message.chat.id) ||
      picker.threadId !== message.message_thread_id ||
      picker.messageId !== message.message_id ||
      !target
    ) {
      await this.#answer(query.id, "This session list is stale. Run /sessions again.", true);
      return true;
    }
    const snapshot = readStatus(target.pid);
    if (
      !snapshot ||
      !this.#alive(snapshot.pid) ||
      snapshot.sessionId !== target.sessionId ||
      snapshot.chatId !== target.chatId ||
      snapshot.threadId !== target.threadId ||
      !currentSessionTarget(this.#getAccess(), ownerId, snapshot)
    ) {
      await this.#answer(query.id, "That session is no longer available.", true);
      return true;
    }
    await this.#answer(query.id);
    await this.#sendCard(snapshot, ownerId, String(message.chat.id), message.message_thread_id);
    return true;
  }

  async #handleCardCallback(query: TgCallbackQuery, access: Access, ownerId: string): Promise<true> {
    const message = query.message!;
    const [, action, nonce] = query.data!.split(":");
    const card = readJson<SessionCardRecord>(cardPath(nonce ?? ""));
    if (
      !card ||
      card.ownerId !== ownerId ||
      card.cardChatId !== String(message.chat.id) ||
      card.cardThreadId !== message.message_thread_id ||
      card.messageId !== message.message_id
    ) {
      await this.#answer(query.id, "This session card is stale. Open it again.", true);
      return true;
    }
    const snapshot = readStatus(card.pid);
    if (
      !snapshot ||
      !this.#alive(snapshot.pid) ||
      !sameTarget(snapshot, card) ||
      !currentSessionTarget(access, ownerId, snapshot) ||
      !currentCardLocation(access, ownerId, card)
    ) {
      await this.#answer(query.id, "That exact session is no longer running.", true);
      return true;
    }
    if (action === "r") {
      await this.#answer(query.id, "Refreshed");
      await editPublishedCard(this.#call, card, snapshot);
      return true;
    }
    const command = action === "s" ? "stop" : action === "m" ? "model" : action === "t" ? "thinking" : action === "c" ? "compact" : undefined;
    if (!command) {
      await this.#answer(query.id);
      return true;
    }
    if (!snapshot.chatId) {
      await this.#answer(query.id, "This session has no Telegram route.", true);
      return true;
    }
    const messageId = randomBytes(4).readUInt32BE(0) & 0x7fffffff;
    const routed: TgMessage = {
      message_id: messageId,
      date: Math.floor(this.#now() / 1000),
      from: query.from,
      chat: {
        id: Number(snapshot.chatId),
        type: snapshot.chatId === ownerId ? "private" : "supergroup",
      },
      text: `/${command}`,
      ...(snapshot.threadId == null ? {} : { is_topic_message: true, message_thread_id: snapshot.threadId }),
      bridge_callback_id: sessionCardCallbackId({
        pid: snapshot.pid,
        sessionId: snapshot.sessionId,
        chatId: snapshot.chatId,
        originPrivate: message.chat.type === "private",
        ...(snapshot.threadId == null ? {} : { threadId: snapshot.threadId }),
        queryId: query.id,
      }),
    };
    try {
      writeRouted(snapshot.threadId ?? DM_ROUTE_KEY, routed);
    } catch (err) {
      this.#warn(`session card route write failed: ${String(err)}`);
      await this.#answer(query.id, `Could not queue /${command}.`, true);
      return true;
    }
    await this.#answer(query.id, `Queued /${command} for ${snapshot.name}.`);
    return true;
  }

  async #sendCard(snapshot: SessionStatusSnapshot, ownerId: string, chatId: string, threadId?: number): Promise<void> {
    const nonce = this.#nonce();
    let sent: TgMessage;
    try {
      sent = await this.#call<TgMessage>("sendMessage", {
        chat_id: chatId,
        ...(threadId == null ? {} : { message_thread_id: threadId }),
        text: formatSessionCard(snapshot, this.#now()),
        reply_markup: cardKeyboard(nonce),
      });
    } catch (err) {
      this.#warn(`session card send failed: ${String(err)}`);
      return;
    }
    if (typeof sent?.message_id !== "number") return;
    const card: SessionCardRecord = {
      nonce,
      ownerId,
      cardChatId: String(sent.chat?.id ?? chatId),
      ...(sent.message_thread_id == null
        ? (threadId == null ? {} : { cardThreadId: threadId })
        : { cardThreadId: sent.message_thread_id }),
      messageId: sent.message_id,
      pid: snapshot.pid,
      sessionId: snapshot.sessionId,
      ...(snapshot.chatId == null ? {} : { targetChatId: snapshot.chatId }),
      ...(snapshot.threadId == null ? {} : { targetThreadId: snapshot.threadId }),
      createdAt: this.#now(),
    };
    atomicWrite(cardPath(nonce), card);
  }

  #pruneLists(): void {
    const now = this.#now();
    for (const [nonce, picker] of this.#lists) if (picker.expiresAt <= now) this.#lists.delete(nonce);
  }

  async #answer(id: string, text?: string, showAlert = false): Promise<void> {
    await this.#call("answerCallbackQuery", {
      callback_query_id: id,
      ...(text ? { text } : {}),
      ...(showAlert ? { show_alert: true } : {}),
    }).catch(() => undefined);
  }
}
