// Access control: pairing codes, allowlists, group mention-gating, and the
// on-disk access.json state. Ported from the Claude telegram plugin's access
// model (anthropics/claude-plugins-official) and extended with omp-specific
// delivery/UX config. `gate()` operates on a plain Bot API message object
// (structural `GateMessage` contract below) — no grammy ctx.

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

export type PendingEntry = {
  senderId: string;
  chatId: string;
  createdAt: number;
  expiresAt: number;
  replies: number;
};

export type GroupPolicy = { requireMention: boolean; allowFrom: string[] };

export type Access = {
  /** Autostart the bot on session_start (default false). */
  enabled: boolean;
  /** DM handling. Default "pairing". */
  dmPolicy: "pairing" | "allowlist" | "disabled";
  /** Numeric user IDs (as strings) allowed to DM the session. */
  allowFrom: string[];
  /** Per-group policy keyed by numeric chat ID (as string). */
  groups: Record<string, GroupPolicy>;
  /** Outstanding pairing requests keyed by 6-hex code. */
  pending: Record<string, PendingEntry>;
  /** Extra regexes that satisfy group mention-gating. */
  mentionPatterns?: string[];
  /** Emoji to react with on receipt (Telegram fixed whitelist). Unset = none. */
  ackReaction?: string;
  /** Which chunks carry Telegram's reply reference. Default "first". */
  replyToMode?: "off" | "first" | "all";
  /** Max chars per outbound message before splitting. Default 4096, clamp 1..4096. */
  textChunkLimit?: number;
  /** Split strategy. Default "newline". */
  chunkMode?: "length" | "newline";
  /** Inbound queueing mode while the agent is busy. Default "followUp". */
  deliverAs?: "steer" | "followUp";
  /** Stream partial output to Telegram (draft/edit). Default true. */
  streaming?: boolean;
  /** Optional argv template for voice-note transcription. Each `{file}` substring is replaced with the downloaded path. */
  transcribeCommand?: string[];
  /** Chat to ping when a locally-started run goes idle. Unset = off. Set via `/telegram notify`. */
  notifyChat?: string;
  /** Chat hosting per-session topics (a DM with the bot's forum-topic mode enabled, or a forum supergroup). Presence enables topics mode. Set via `/telegram topics`. */
  topicsChat?: string;
  /** Tidy this session's topic on clean exit: delete it in a DM host, close it in a forum supergroup. Set via /telegram topics tidy. */
  topicsTidy?: boolean;
  /** Persistent owner-DM topic used for bridge/herdr control commands. */
  controlThreadId?: number;
  /**
   * Laptop-wide notification mode, set via `/telegram notify`. Absent = off.
   * `away` posts a local run's final message and blocked-input pings while you
   * are away, and auto-clears on the next interactive local keystroke. `always`
   * keeps notifying regardless — for juggling herdr sessions you aren't watching.
   */
  notifyMode?: "away" | "always";
};

// Structural contract for what `gate()`/`isMentioned()` read off a Bot API
// message. The full wire type in api.ts (TgMessage) satisfies this. Kept local
// so access.ts stays independent of api.ts.
export interface GateEntity {
  type: string;
  offset: number;
  length: number;
  user?: { is_bot?: boolean; username?: string };
}
export interface GateMessage {
  from?: { id: number | string; username?: string; is_bot?: boolean; first_name?: string };
  chat: { id: number | string; type: string; title?: string };
  text?: string;
  caption?: string;
  entities?: GateEntity[];
  caption_entities?: GateEntity[];
  reply_to_message?: { from?: { username?: string } };
}

export function stateDir(): string {
  return process.env.OMP_TELEGRAM_STATE_DIR ?? join(homedir(), ".omp", "agent", "telegram");
}

/** Create the state dir (mode 0700) and return its path. */
export function ensureStateDir(): string {
  const dir = stateDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Resolve a path inside the state dir. Does not create anything. */
export function statePath(...parts: string[]): string {
  return join(stateDir(), ...parts);
}

/** Resolve the bot token from the process environment or the private state file. */
export function resolveToken(): string {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN;
  try {
    for (const line of readFileSync(statePath(".env"), "utf8").split("\n")) {
      const match = /^TELEGRAM_BOT_TOKEN=(.*)$/.exec(line.trim());
      if (match) return match[1];
    }
  } catch {
    /* no .env yet */
  }
  return "";
}

export function defaultAccess(): Access {
  return { enabled: false, dmPolicy: "pairing", allowFrom: [], groups: {}, pending: {} };
}

/** The bridge's sole paired operator, or undefined while unpaired / ambiguous. */
export function pairedOwnerId(access: Access): string | undefined {
  return access.allowFrom.length === 1 ? access.allowFrom[0] : undefined;
}

/** Owner-only control invariant shared by command messages and callbacks. */
export function isPairedOwnerDm(userId: string, chatId: string, chatType: string, access: Access): boolean {
  const ownerId = pairedOwnerId(access);
  return ownerId != null && chatType === "private" && userId === ownerId && chatId === ownerId;
}

/** Authorize one Telegram prompt answer using the same DM/group policy as inbound turns. */
export function canAnswerPrompt(responderId: string, chatId: string, chatType: string, access: Access): boolean {
  if (chatType === "private") return isPairedOwnerDm(responderId, chatId, chatType, access);
  if (chatType !== "group" && chatType !== "supergroup") return false;
  const policy = access.groups[chatId];
  if (!policy) return false;
  const allowed = policy.allowFrom ?? [];
  return allowed.length === 0 || allowed.includes(responderId);
}

/** Dedicated owner-DM destination for global control commands, when configured. */
export function controlTopicTarget(access: Access): { chatId: string; threadId: number } | undefined {
  const ownerId = pairedOwnerId(access);
  if (!ownerId || access.topicsChat !== ownerId || typeof access.controlThreadId !== "number") return undefined;
  return { chatId: ownerId, threadId: access.controlThreadId };
}

/** Owner DM that still needs its persistent control topic, when topic mode permits. */
export function controlTopicCreationChat(access: Access, dmTopicsAvailable: boolean | undefined): string | undefined {
  const ownerId = pairedOwnerId(access);
  if (!ownerId || access.topicsChat !== ownerId || access.controlThreadId != null || dmTopicsAvailable === false) return undefined;
  return ownerId;
}

/**
 * Resolve where a notification should land — a local run going idle, or a
 * blocked-input ping — or undefined when none should fire. Skips
 * Telegram-initiated runs (the user already sees the reply) and requires a
 * token plus an active notify mode. Targets this session's forum topic when
 * topics mode owns one, else the flat notifyChat.
 */
export function notifyTarget(
  wasTelegramActive: boolean,
  access: Access,
  hasToken: boolean,
  ownTopic?: { chatId: string; threadId: number },
): { chatId: string; threadId?: number } | undefined {
  if (wasTelegramActive || !hasToken || !access.notifyMode) return undefined;
  if (ownTopic) return { chatId: ownTopic.chatId, threadId: ownTopic.threadId };
  if (access.notifyChat) return { chatId: access.notifyChat };
  return undefined;
}

/**
 * Load access.json. ENOENT → defaults. Corrupt JSON → move aside to
 * access.json.corrupt-<ts>, warn, return defaults.
 */
export function loadAccess(warn?: (msg: string) => void): Access {
  const file = statePath("access.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaultAccess();
    warn?.(`could not read access.json: ${String(err)}`);
    return defaultAccess();
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Access>;
    // Migrate the retired `away` boolean to the notifyMode enum on first load.
    const notifyMode: Access["notifyMode"] =
      parsed.notifyMode === "away" || parsed.notifyMode === "always"
        ? parsed.notifyMode
        : "away" in parsed && parsed.away === true
          ? "away"
          : undefined;
    return {
      enabled: parsed.enabled ?? false,
      dmPolicy: parsed.dmPolicy ?? "pairing",
      allowFrom: Array.isArray(parsed.allowFrom) ? parsed.allowFrom : [],
      groups: parsed.groups ?? {},
      pending: parsed.pending ?? {},
      mentionPatterns: parsed.mentionPatterns,
      ackReaction: parsed.ackReaction,
      replyToMode: parsed.replyToMode,
      textChunkLimit: parsed.textChunkLimit,
      chunkMode: parsed.chunkMode,
      deliverAs: parsed.deliverAs,
      streaming: parsed.streaming,
      transcribeCommand: Array.isArray(parsed.transcribeCommand) && parsed.transcribeCommand.every((arg) => typeof arg === "string")
        ? parsed.transcribeCommand
        : undefined,
      notifyChat: parsed.notifyChat,
      topicsChat: parsed.topicsChat,
      topicsTidy: parsed.topicsTidy,
      controlThreadId: parsed.controlThreadId,
      notifyMode,
    };
  } catch {
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      /* best effort */
    }
    warn?.("access.json was corrupt — moved aside, starting fresh");
    return defaultAccess();
  }
}

/** Atomically persist access.json (tmp write mode 0600 + rename). */
export function saveAccess(a: Access): void {
  ensureStateDir();
  const file = statePath("access.json");
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(a, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

/** Drop expired pending pairings. Returns true if anything changed. */
export function pruneExpired(a: Access): boolean {
  const now = Date.now();
  let changed = false;
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code];
      changed = true;
    }
  }
  return changed;
}

/** True if the bot is @-mentioned, replied-to, or matches a configured pattern. */
export function isMentioned(msg: GateMessage, botUsername: string, extraPatterns?: string[]): boolean {
  const entities = msg.entities ?? msg.caption_entities ?? [];
  const text = msg.text ?? msg.caption ?? "";
  const handle = `@${botUsername}`.toLowerCase();
  for (const e of entities) {
    if (e.type === "mention") {
      const mentioned = text.slice(e.offset, e.offset + e.length);
      if (mentioned.toLowerCase() === handle) return true;
    }
    if (e.type === "text_mention" && e.user?.is_bot && e.user.username === botUsername) return true;
  }
  if (msg.reply_to_message?.from?.username === botUsername) return true;
  for (const pat of extraPatterns ?? []) {
    try {
      if (new RegExp(pat, "i").test(text)) return true;
    } catch {
      /* invalid user-supplied regex — skip */
    }
  }
  return false;
}

export type GateResult =
  | { action: "deliver" }
  | { action: "drop" }
  | { action: "pair"; code: string; isResend: boolean };

/**
 * Decide what to do with an inbound message. May mutate + persist `access`
 * (minting/incrementing pairing codes). Caller passes a freshly-loaded Access.
 */
export function gate(msg: GateMessage, botUsername: string, access: Access): GateResult {
  if (pruneExpired(access)) saveAccess(access);

  if (access.dmPolicy === "disabled") return { action: "drop" };

  const from = msg.from;
  if (!from) return { action: "drop" };
  const senderId = String(from.id);
  const chatType = msg.chat.type;

  if (chatType === "private") {
    const ownerId = pairedOwnerId(access);
    if (ownerId) return senderId === ownerId ? { action: "deliver" } : { action: "drop" };
    // Historical multi-user state is ambiguous. Fail closed until repaired locally.
    if (access.allowFrom.length > 1 || access.dmPolicy === "allowlist") return { action: "drop" };

    // Pairing — reuse an existing non-expired code for this sender.
    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        if ((p.replies ?? 1) >= 2) return { action: "drop" }; // initial + one reminder, then silent
        p.replies = (p.replies ?? 1) + 1;
        saveAccess(access);
        return { action: "pair", code, isResend: true };
      }
    }
    if (Object.keys(access.pending).length >= 3) return { action: "drop" }; // cap pending

    const code = randomBytes(3).toString("hex"); // 6 hex chars
    const now = Date.now();
    access.pending[code] = {
      senderId,
      chatId: String(msg.chat.id),
      createdAt: now,
      expiresAt: now + 60 * 60 * 1000, // 1h
      replies: 1,
    };
    saveAccess(access);
    return { action: "pair", code, isResend: false };
  }

  if (chatType === "group" || chatType === "supergroup") {
    const groupId = String(msg.chat.id);
    const policy = access.groups[groupId];
    if (!policy) return { action: "drop" };
    const groupAllowFrom = policy.allowFrom ?? [];
    const requireMention = policy.requireMention ?? true;
    if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) return { action: "drop" };
    if (requireMention && !isMentioned(msg, botUsername, access.mentionPatterns)) return { action: "drop" };
    return { action: "deliver" };
  }

  return { action: "drop" };
}

/**
 * Outbound gate — a chat is sendable only if the inbound gate would deliver
 * from it. DM chat_id == user_id, so allowFrom covers DMs. Throws otherwise.
 */
export function assertAllowedChat(chatId: string, access: Access): void {
  if (pairedOwnerId(access) === chatId) return;
  if (chatId in access.groups) return;
  throw new Error(`chat ${chatId} is not allowlisted — manage access via /telegram`);
}

/**
 * Telegram invariant: user/DM chat ids are positive, group/supergroup/channel
 * ids negative. Lets the topics flow tell a bot DM apart from a forum group
 * without an API round-trip.
 */
export function isDmChat(chatId: string): boolean {
  return !chatId.startsWith("-");
}

/**
 * Resolve the DM chat that should host per-session topics for `/telegram topics on`.
 * A DM's chat_id equals the paired user's id, so a single allowFrom entry IS the
 * host. Zero → nothing paired yet; many → ambiguous, force an explicit chat_id.
 */
export function resolveDmTopicsHost(access: Access): { chatId: string } | { error: string } {
  const ids = access.allowFrom;
  if (ids.length === 1) return { chatId: ids[0] };
  if (ids.length === 0) {
    return { error: "telegram: no paired DM yet — DM the bot and run /telegram pair <code> first, or pass a chat_id: /telegram topics <chat_id>" };
  }
  return { error: `telegram: multiple paired DMs (${ids.join(", ")}) — ambiguous; pass one explicitly: /telegram topics <chat_id>` };
}

/**
 * Refuse to send the extension's own state files (token, access.json, lock).
 * Downloaded inbox files are exempt. A missing file returns silently — the
 * caller's stat() will fail with a clearer error. Mirrors the Claude plugin's
 * exfiltration guard.
 */
export function assertSendable(file: string): void {
  let real: string;
  let stateReal: string;
  try {
    real = realpathSync(file);
    stateReal = realpathSync(stateDir());
  } catch {
    return;
  }
  const inbox = join(stateReal, "inbox");
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send Telegram state file: ${file}`);
  }
}
