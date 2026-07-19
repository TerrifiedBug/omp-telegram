import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Access,
  controlTopicCreationChat,
  gate,
  isDmChat,
  isPairedOwnerDm,
  loadAccess,
  pairedOwnerId,
  saveAccess,
} from "./access";
import { isMissingThreadError, type Logger, type TgCallbackQuery, TgError, type TgMessage, type TgUpdate } from "./api";
import {
  type TelegramCall,
  type SpawnController,
  formatSessions,
  listControlSpaces,
  resumeOmp,
  sendCommandMessage,
} from "./control";
import type { TelegramPromptController } from "./prompts";
import {
  type ThreadEntry,
  decideRoute,
  isAlive,
  isResumedOwner,
  loadRegistry,
  purgeRouteDir,
  releaseThread,
  staleThreads,
  writeRouted,
} from "./topics";

export interface CommandSpec {
  /** Bare command name (no leading slash). */
  command: string;
  /** One-line description for the Telegram command menu. */
  description: string;
  /** global = usable from any paired chat; session = needs a live session topic. */
  scope: "global" | "session";
  /** Listed for unpaired users (the pairing essentials) as well as the owner. */
  public?: boolean;
  /** Detailed usage line(s) for /help; defaults to `/<command> — <description>`. */
  help?: string[];
}

// Single source of truth for the bot's command surface. The Telegram menu, the
// command parser's known/global/session sets, per-scope menu targeting, and the
// /help text are all derived from this table so the visible and accepted
// surfaces cannot drift.
const COMMANDS: CommandSpec[] = [
  { command: "start", description: "Pairing instructions", scope: "global", public: true },
  {
    command: "spawn",
    description: "Start omp in a herdr space, new worktree, or directory",
    scope: "global",
    help: [
      "/spawn [space] — start omp in a herdr space",
      "/spawn new <branch> [space] — create a worktree and start omp",
      "/spawn dir <absolute-path> — create a workspace and start omp",
    ],
  },
  { command: "sessions", description: "List active omp sessions", scope: "global", help: ["/sessions — list active omp sessions and topic attachment"] },
  { command: "cleanup", description: "Tidy topics of exited sessions", scope: "global", help: ["/cleanup — preview exited-session topics, then tap to confirm (or /cleanup go to skip the preview)"] },
  { command: "stop", description: "Abort this topic's omp task", scope: "session", help: ["/stop — abort this topic’s current task"] },
  { command: "compact", description: "Compact this session's context", scope: "session", help: ["/compact [focus] — compact this session’s context"] },
  { command: "model", description: "Show or change this session's model", scope: "session", help: ["/model [provider/id] — show or change this session’s model"] },
  { command: "thinking", description: "Show or change thinking level", scope: "session", help: ["/thinking [level] — show or change thinking level"] },
  { command: "status", description: "Bridge and session health", scope: "global", help: ["/status — bridge and session health"] },
  { command: "help", description: "Show available commands", scope: "global" },
  { command: "whoami", description: "Show your Telegram IDs", scope: "global", help: ["/whoami — show Telegram IDs"] },
];

const toMenu = (specs: CommandSpec[]): Array<{ command: string; description: string }> =>
  specs.map(({ command, description }) => ({ command, description }));
const namesByScope = (scope: CommandSpec["scope"]): Record<string, true> =>
  Object.fromEntries(COMMANDS.filter((c) => c.scope === scope).map((c) => [c.command, true] as const));

/** Full command menu, shown to the paired owner's DM. */
export const BOT_COMMANDS = toMenu(COMMANDS);
/** Minimal menu for unpaired private chats: the pairing essentials only. */
export const PUBLIC_BOT_COMMANDS = toMenu(COMMANDS.filter((c) => c.public));

const KNOWN_COMMANDS: Record<string, true> = Object.fromEntries(COMMANDS.map((c) => [c.command, true] as const));
const GLOBAL_COMMANDS = namesByScope("global");
const SESSION_COMMANDS = namesByScope("session");

const helpLines = (c: CommandSpec): string[] => c.help ?? [`/${c.command} — ${c.description}`];
/** /help for the paired owner: every command except the pre-pairing/meta ones. */
const ownerHelpText = `Use "omp control" for bridge commands and the other topics for agent conversations.\n\n${COMMANDS.filter(
  (c) => c.command !== "start" && c.command !== "help",
)
  .flatMap(helpLines)
  .join("\n")}`;
/** /help for unpaired users: the pairing essentials. */
const publicHelpText = COMMANDS.filter((c) => c.public)
  .flatMap(helpLines)
  .join("\n");

/**
 * Push the command menu to Telegram: the minimal set to every private chat, and
 * the full set scoped to the paired owner's DM (which overrides the minimal set
 * there). Best-effort; menu failures never break polling.
 */
export async function syncBotCommands(call: TelegramCall, ownerId: string | undefined): Promise<void> {
  await call("setMyCommands", { commands: PUBLIC_BOT_COMMANDS, scope: { type: "all_private_chats" } }).catch(() => {});
  if (ownerId != null) {
    await call("setMyCommands", { commands: BOT_COMMANDS, scope: { type: "chat", chat_id: Number(ownerId) } }).catch(() => {});
  }
}

/** Drop a former owner's chat-scoped full menu so their DM reverts to the minimal set. */
export async function clearOwnerBotCommands(call: TelegramCall, ownerId: string): Promise<void> {
  await call("deleteMyCommands", { scope: { type: "chat", chat_id: Number(ownerId) } }).catch(() => {});
}

const packageVersion = (() => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
    return parsed && typeof parsed === "object" && "version" in parsed && typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
})();

export interface BridgeHost {
  isDaemon: boolean;
  selfPid: number;
  token(): string;
  botUsername(): string;
  botHasTopics(): boolean | undefined;
  ownThreadId(): number | undefined;
  callTelegram: TelegramCall;
  warn(message: string): void;
  log: Logger;
  spawnController: SpawnController;
  promptController: TelegramPromptController;
  handleSessionCommand?(msg: TgMessage, parsed: { name: string; args: string }): Promise<boolean>;
  deliverLocal?(msg: TgMessage): Promise<void>;
  /** Test seam for the external herdr resume side effect. */
  resumeTopic?(msg: TgMessage, threadId: number, entry: ThreadEntry): Promise<void>;
}

export function parseBotCommand(text: string): { name: string; args: string } | undefined {
  const match = /^\/([a-zA-Z0-9_]+)(?:@[\w]+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return undefined;
  return { name: match[1].toLowerCase(), args: match[2]?.trim() ?? "" };
}

/** Known bot commands are control-plane input and never become group agent turns. */
export function consumeOutsidePrivateChat(chatType: string, command: string): boolean {
  return chatType !== "private" && Object.hasOwn(KNOWN_COMMANDS, command);
}

/** Only the paired owner may turn an inert DM topic into a local process. */
export function canAutoResumeTopic(
  msg: TgMessage,
  access: Access,
  entry: ThreadEntry | undefined,
  commandName?: string,
): entry is ThreadEntry {
  if (commandName === "stop" || !entry) return false;
  if (!isPairedOwnerDm(String(msg.from?.id ?? ""), String(msg.chat.id), msg.chat.type, access)) return false;
  const hasSession =
    (typeof entry.sessionFile === "string" && entry.sessionFile.length > 0) ||
    (typeof entry.sessionId === "string" && entry.sessionId.length > 0);
  return (
    hasSession &&
    typeof entry.workspaceId === "string" &&
    entry.workspaceId.length > 0 &&
    typeof entry.workspaceLabel === "string" &&
    entry.workspaceLabel.length > 0 &&
    Array.isArray(entry.workspaceTerminalIds)
  );
}

/** Delete (DM host) or close (forum supergroup) one topic. Caller owns error handling. */
export async function tidyRemoteTopic(callTelegram: TelegramCall, chatId: string, threadId: number): Promise<"deleted" | "closed"> {
  if (isDmChat(chatId)) {
    await callTelegram("deleteForumTopic", { chat_id: chatId, message_thread_id: threadId });
    return "deleted";
  }
  try {
    await callTelegram("closeForumTopic", { chat_id: chatId, message_thread_id: threadId });
  } catch (err) {
    // An already-closed topic returns 400 TOPIC_NOT_MODIFIED; that is idempotent success.
    // /cleanup keeps closed group entries, so a repeat run must not report this as failed.
    if (!(err instanceof TgError && err.code === 400 && /topic_not_modified/i.test(err.message))) throw err;
  }
  return "closed";
}

let controlTopicCreating: Promise<void> | undefined;

/** Ensure the paired owner's persistent control topic exists. */
export async function ensureControlTopic(host: BridgeHost): Promise<void> {
  const access = loadAccess(host.warn);
  const ownerId = controlTopicCreationChat(access, host.botHasTopics());
  if (!host.token() || !ownerId) return;
  if (controlTopicCreating) return controlTopicCreating;

  controlTopicCreating = (async () => {
    const topic = await host.callTelegram<{ message_thread_id: number }>("createForumTopic", {
      chat_id: ownerId,
      name: "omp control",
    });
    const fresh = loadAccess(host.warn);
    if (pairedOwnerId(fresh) !== ownerId || fresh.topicsChat !== ownerId || fresh.controlThreadId != null) return;
    fresh.controlThreadId = topic.message_thread_id;
    saveAccess(fresh);
    await host.callTelegram("sendMessage", {
      chat_id: ownerId,
      message_thread_id: topic.message_thread_id,
      text: "OMP control\n\nUse this topic for bridge commands:\n/spawn — start omp in a herdr space, new worktree, or directory\n/sessions — inspect session and topic state\n/status — bridge health\n/help — command reference\n\nUse the other topics for conversations with individual omp sessions.",
    });
    host.log.info(`[telegram] control topic #${topic.message_thread_id} created in owner DM ${ownerId}`);
  })();
  try {
    await controlTopicCreating;
  } finally {
    controlTopicCreating = undefined;
  }
}

const resumingTopics = new Set<number>();

async function waitForResumedOwner(threadId: number, previous: ThreadEntry): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const owner = loadRegistry().threads[String(threadId)];
    if (isResumedOwner(previous, owner, isAlive)) return true;
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(resolve, 250);
    timer.unref?.();
    await promise;
  }
  return false;
}

async function resumeStaleTopic(host: BridgeHost, msg: TgMessage, threadId: number, entry: ThreadEntry): Promise<void> {
  const origin = { chat_id: String(msg.chat.id), message_thread_id: threadId };
  const notice = await host.callTelegram<TgMessage>("sendMessage", {
    ...origin,
    text: "Resuming this topic's saved omp session; messages here are queued...",
  }).catch(() => undefined);
  const report = async (text: string): Promise<void> => {
    if (notice) {
      await host.callTelegram("editMessageText", {
        chat_id: String(msg.chat.id),
        message_id: notice.message_id,
        text,
      }).catch(() => {});
    } else {
      await host.callTelegram("sendMessage", { ...origin, text }).catch(() => {});
    }
  };

  try {
    const started = await resumeOmp(entry);
    if (!(await waitForResumedOwner(threadId, entry))) {
      throw new Error(`omp started in pane ${started.paneId}, but it did not reattach to this topic within 30 seconds`);
    }
    await report("Session resumed. Delivering queued messages.");
  } catch (err) {
    await report(`Could not resume this session: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function commandReply(host: BridgeHost, access: Access, msg: TgMessage, text: string, useControlTopic = true): Promise<void> {
  await sendCommandMessage({ access, callTelegram: host.callTelegram, msg, text, useControlTopic, warn: host.warn });
}

type InlineKeyboard = { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };

interface CleanupPicker {
  ownerId: string;
  chatId: string;
  messageId: number;
  /** Host chat the preview was derived against; the stored ids are chat-local. */
  topicsChat: string;
  /** Exact stale topic ids the preview showed; the tap acts only on these. */
  threadIds: number[];
  expiresAt: number;
}

const cleanupPickers = new Map<string, CleanupPicker>();
const CLEANUP_TTL_MS = 5 * 60_000;

function pruneCleanupPickers(now: number): void {
  for (const [nonce, picker] of cleanupPickers) {
    if (picker.expiresAt <= now) cleanupPickers.delete(nonce);
  }
}

/** Delete (DM host) or close (group host) each stale topic; reconcile the local registry. */
async function executeCleanup(
  host: BridgeHost,
  topicsChat: string,
  stale: Array<[number, ThreadEntry]>,
): Promise<{ cleaned: number; failed: number; deletes: boolean }> {
  const deletes = isDmChat(topicsChat);
  let cleaned = 0;
  let failed = 0;
  for (const [threadId, entry] of stale) {
    try {
      const mode = await tidyRemoteTopic(host.callTelegram, topicsChat, threadId);
      if (mode === "deleted") {
        releaseThread(threadId, entry.pid, host.warn);
        purgeRouteDir(threadId);
      }
      cleaned++;
    } catch (err) {
      if (!isMissingThreadError(err)) {
        host.warn(`could not tidy topic #${threadId}: ${String(err)}`);
        failed++;
        continue;
      }
      releaseThread(threadId, entry.pid, host.warn); // remote topic already gone
      purgeRouteDir(threadId);
      cleaned++;
    }
  }
  return { cleaned, failed, deletes };
}

function cleanupResultText(cleaned: number, failed: number, deletes: boolean): string {
  const verb = deletes ? "deleted" : "closed";
  const suffix = failed > 0 ? ` (${failed} failed — see omp logs)` : "";
  return `🧹 ${verb} ${cleaned} stale topic${cleaned === 1 ? "" : "s"}${suffix}`;
}

/**
 * Preview the stale topics with a confirm/cancel keyboard so the owner can tidy
 * with one tap instead of typing `/cleanup go`. The picker records the exact
 * previewed topic ids so the tap acts only on those (revalidated as still
 * stale) — never on a topic that went stale, or resumed, after the preview.
 */
async function sendCleanupPreview(
  host: BridgeHost,
  access: Access,
  msg: TgMessage,
  topicsChat: string,
  stale: Array<[number, ThreadEntry]>,
): Promise<void> {
  const ownerId = pairedOwnerId(access);
  if (!ownerId) return;
  const deletes = isDmChat(topicsChat);
  const plural = stale.length === 1 ? "" : "s";
  const lines = stale.map(([threadId, entry]) => `#${threadId} ${entry.name} — ${entry.cwd}`).join("\n");
  const prompt = deletes
    ? `Delete these ${stale.length} topic${plural} and their message history?`
    : `Close these ${stale.length} topic${plural}? History is kept and reopened on re-adoption.`;
  const nonce = randomBytes(6).toString("base64url");
  pruneCleanupPickers(Date.now());
  const keyboard: InlineKeyboard = {
    inline_keyboard: [
      [{ text: `🧹 ${deletes ? "Delete" : "Close"} ${stale.length} topic${plural}`, callback_data: `cl:go:${nonce}` }],
      [{ text: "Cancel", callback_data: `cl:x:${nonce}` }],
    ],
  };
  const sent = await sendCommandMessage({
    access,
    callTelegram: host.callTelegram,
    msg,
    text: `${lines}\n\n${prompt}`,
    replyMarkup: keyboard,
    redirectText: 'Continue in the "omp control" topic.',
    warn: host.warn,
  });
  if (sent) {
    cleanupPickers.set(nonce, {
      ownerId,
      chatId: String(sent.chat.id),
      messageId: sent.message_id,
      topicsChat,
      threadIds: stale.map(([threadId]) => threadId),
      expiresAt: Date.now() + CLEANUP_TTL_MS,
    });
  }
}

async function answerCallback(host: BridgeHost, id: string, text?: string, showAlert = false): Promise<void> {
  await host
    .callTelegram("answerCallbackQuery", {
      callback_query_id: id,
      ...(text ? { text } : {}),
      ...(showAlert ? { show_alert: true } : {}),
    })
    .catch(() => undefined);
}

async function editCleanupMessage(host: BridgeHost, message: NonNullable<TgCallbackQuery["message"]>, text: string): Promise<void> {
  await host
    .callTelegram("editMessageText", {
      chat_id: String(message.chat.id),
      message_id: message.message_id,
      text,
      reply_markup: { inline_keyboard: [] },
    })
    .catch((err) => host.warn(`cleanup edit failed: ${String(err)}`));
}

/**
 * Handle a `/cleanup` confirm/cancel tap. Owner-authenticated and nonce-guarded
 * like the /spawn picker; the confirm path re-derives the stale set so double
 * taps or a redelivered callback cannot act on a stale preview. Returns false
 * only for callbacks this handler does not own.
 */
export async function handleCleanupCallback(host: BridgeHost, query: TgCallbackQuery): Promise<boolean> {
  const data = query.data;
  if (!data?.startsWith("cl:")) return false;
  const access = loadAccess(host.warn);
  const ownerId = pairedOwnerId(access);
  const message = query.message;
  if (!message || !ownerId || !isPairedOwnerDm(String(query.from.id), String(message.chat.id), message.chat.type, access)) {
    await answerCallback(host, query.id, "This control is restricted to the paired owner.", true);
    return true;
  }
  const [, action, nonce] = data.split(":");
  pruneCleanupPickers(Date.now());
  const picker = cleanupPickers.get(nonce ?? "");
  if (!picker || picker.ownerId !== ownerId || picker.chatId !== String(message.chat.id) || picker.messageId !== message.message_id) {
    await answerCallback(host, query.id, "This cleanup expired. Run /cleanup again.", true);
    return true;
  }
  cleanupPickers.delete(nonce); // consume before any side effect; a redelivered tap sees it expired

  if (action === "x") {
    await answerCallback(host, query.id);
    await editCleanupMessage(host, message, "Cleanup cancelled.");
    return true;
  }
  if (action !== "go") {
    await answerCallback(host, query.id);
    return true;
  }

  const registry = loadRegistry(host.warn);
  const topicsChat = registry.chatId || access.topicsChat;
  // Act only on the exact topics this preview showed, revalidated as still
  // stale. A topic that went stale AFTER the preview was never confirmed (don't
  // delete its unpreviewed history); one that resumed since must be spared.
  if (!topicsChat || topicsChat !== picker.topicsChat) {
    await answerCallback(host, query.id);
    await editCleanupMessage(host, message, "The topic host changed since this preview. Run /cleanup again.");
    return true;
  }
  const controlExclude = topicsChat === ownerId ? access.controlThreadId : undefined;
  const previewed = new Set(picker.threadIds);
  const stale = staleThreads(registry, isAlive, controlExclude).filter(([threadId]) => previewed.has(threadId));
  if (stale.length === 0) {
    await answerCallback(host, query.id);
    await editCleanupMessage(host, message, "Nothing to clean — those topics are gone or back in use.");
    return true;
  }
  await answerCallback(host, query.id, "Cleaning up…");
  const { cleaned, failed, deletes } = await executeCleanup(host, topicsChat, stale);
  await editCleanupMessage(host, message, cleanupResultText(cleaned, failed, deletes));
  return true;
}

export async function handleGlobalCommand(
  host: BridgeHost,
  msg: TgMessage,
  parsed: { name: string; args: string },
): Promise<boolean> {
  const { name: command, args } = parsed;
  if (!Object.hasOwn(GLOBAL_COMMANDS, command)) return false;
  const access = loadAccess(host.warn);
  if (access.dmPolicy === "disabled") return true;

  const senderId = String(msg.from?.id ?? "");
  const chatId = String(msg.chat.id);
  const ownerId = pairedOwnerId(access);
  const owner = isPairedOwnerDm(senderId, chatId, msg.chat.type, access);
  if (access.allowFrom.length > 1) {
    await commandReply(host, access, msg, "Control commands are locked because multiple paired users exist. Repair access locally.");
    return true;
  }
  if (ownerId && !owner) return true;

  if (command === "start") {
    await commandReply(
      host,
      access,
      msg,
      owner
        ? 'This bot is paired to you. Use "omp control" for /spawn, /sessions, and /status; use session topics for agent conversations.'
        : "This bot bridges Telegram to one omp operator.\n\nTo pair:\n1. Send any normal message to receive a code.\n2. In omp, run /telegram pair <code>.",
    );
  } else if (command === "help") {
    await commandReply(host, access, msg, owner ? ownerHelpText : publicHelpText);
  } else if (command === "whoami") {
    await commandReply(host, access, msg, `chat_id: ${chatId}\nuser_id: ${senderId}\nchat_type: ${msg.chat.type}`);
  } else if (command === "spawn") {
    if (!owner) await commandReply(host, access, msg, "Pair this DM locally before using control commands.");
    else await host.spawnController.start(msg, args);
  } else if (command === "sessions") {
    if (!owner) {
      await commandReply(host, access, msg, "Pair this DM locally before using control commands.");
    } else {
      try {
        await commandReply(host, access, msg, formatSessions(await listControlSpaces(), loadRegistry(host.warn), isAlive));
      } catch (err) {
        await commandReply(host, access, msg, `Cannot list omp sessions: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else if (command === "cleanup") {
    if (!owner) {
      await commandReply(host, access, msg, "Pair this DM locally before using cleanup.");
    } else if (!access.topicsChat) {
      await commandReply(host, access, msg, "Topics mode is off — nothing to clean.");
    } else if (args !== "" && args !== "go") {
      await commandReply(host, access, msg, "usage: /cleanup [go]");
    } else {
      const registry = loadRegistry(host.warn);
      const topicsChat = registry.chatId || access.topicsChat;
      // controlThreadId is an owner-DM thread; only exclude it when this session's
      // topics are hosted in that same DM (thread ids are chat-local, so in a group
      // host it could numerically collide with a real stale group topic).
      const controlExclude = topicsChat === pairedOwnerId(access) ? access.controlThreadId : undefined;
      const stale = staleThreads(registry, isAlive, controlExclude);
      if (stale.length === 0) {
        await commandReply(host, access, msg, "Nothing to clean — no stale session topics. Live sessions and omp control remain.");
      } else if (args === "") {
        await sendCleanupPreview(host, access, msg, topicsChat, stale);
      } else {
        // args === "go": re-derived above; never act on the preview.
        const { cleaned, failed, deletes } = await executeCleanup(host, topicsChat, stale);
        await commandReply(host, access, msg, cleanupResultText(cleaned, failed, deletes));
      }
    }
  } else {
    if (!owner) {
      const pending = Object.entries(access.pending).find(([, value]) => value.senderId === senderId);
      await commandReply(host, access, msg, pending ? `Pending — run in omp:\n\n/telegram pair ${pending[0]}` : "Not paired. Send a normal message to get a pairing code.");
    } else {
      const registry = loadRegistry(host.warn);
      const liveTopics = Object.values(registry.threads).filter((entry) => isAlive(entry.pid)).length;
      const bridge = host.isDaemon ? `daemon polling (pid ${host.selfPid}, v${packageVersion})` : "polling";
      try {
        const spaces = await listControlSpaces();
        const liveOmp = spaces.reduce((total, space) => total + space.ompCount, 0);
        await commandReply(
          host,
          access,
          msg,
          `Paired owner: ${ownerId}\nBridge: ${bridge}\nTopics: ${access.topicsChat ? "on" : "off"}\nControl topic: ${access.controlThreadId != null ? `#${access.controlThreadId}` : "not attached"}\nOMP sessions: ${liveOmp}\nLive topic owners: ${liveTopics}`,
        );
      } catch (err) {
        await commandReply(
          host,
          access,
          msg,
          `Paired owner: ${ownerId}\nBridge: ${bridge}\nTopics: ${access.topicsChat ? "on" : "off"}\nControl topic: ${access.controlThreadId != null ? `#${access.controlThreadId}` : "not attached"}\nLive topic owners: ${liveTopics}\nHerdr: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  return true;
}

async function deliverToSession(host: BridgeHost, msg: TgMessage, parsed: { name: string; args: string } | undefined): Promise<void> {
  if (msg.chat.type === "private" && parsed && host.handleSessionCommand && (await host.handleSessionCommand(msg, parsed))) return;
  if (host.deliverLocal) await host.deliverLocal(msg);
}

async function handleDaemonSessionCommand(host: BridgeHost, access: Access, msg: TgMessage, parsed: { name: string }): Promise<boolean> {
  if (!Object.hasOwn(SESSION_COMMANDS, parsed.name)) return false;
  if (access.dmPolicy === "disabled") return true;
  const senderId = String(msg.from?.id ?? "");
  const chatId = String(msg.chat.id);
  const ownerId = pairedOwnerId(access);
  const owner = isPairedOwnerDm(senderId, chatId, msg.chat.type, access);
  if (access.allowFrom.length > 1) {
    await commandReply(host, access, msg, "Control commands are locked because multiple paired users exist. Repair access locally.");
  } else if (!ownerId || owner) {
    await commandReply(
      host,
      access,
      msg,
      owner ? `Run /${parsed.name} inside a session topic.` : "Pair this DM locally before using session commands.",
      false,
    );
  }
  return true;
}

/** Route one Bot API update through the shared control/topic bridge. */
export async function handleUpdate(host: BridgeHost, update: TgUpdate): Promise<void> {
  if (update.callback_query) {
    if (await host.promptController.handleCallback(update.callback_query)) return;
    if (await handleCleanupCallback(host, update.callback_query)) return;
    await host.spawnController.handleCallback(update.callback_query);
    return;
  }
  const source = update.message ?? update.edited_message;
  if (!source || source.from?.is_bot) return;
  const edited = update.message == null;
  const msg = edited ? { ...source, edited_flag: true as const } : source;
  const access = loadAccess(host.warn);
  if (access.controlThreadId == null && access.topicsChat === pairedOwnerId(access)) {
    await ensureControlTopic(host).catch((err) => host.warn(`could not create control topic: ${String(err)}`));
  }
  if (await host.promptController.handleMessage(msg)) return;

  const parsed = edited ? undefined : parseBotCommand(msg.text ?? "");
  if (parsed && consumeOutsidePrivateChat(msg.chat.type, parsed.name)) return;
  if (msg.chat.type === "private" && parsed && Object.hasOwn(GLOBAL_COMMANDS, parsed.name) && (await handleGlobalCommand(host, msg, parsed))) return;

  const registry = loadRegistry(host.warn);
  const route = access.topicsChat ? decideRoute(msg, access.topicsChat, registry, host.selfPid, isAlive) : { kind: "untopiced" as const };
  if (route.kind !== "untopiced") {
    const threadId = msg.message_thread_id;
    const result = gate(msg, host.botUsername(), access);
    if (result.action === "drop") return;
    if (result.action === "pair") {
      const lead = result.isResend ? "Still pending" : "Pairing required";
      await host.callTelegram("sendMessage", {
        chat_id: String(msg.chat.id),
        message_thread_id: threadId,
        text: `${lead} — run in omp:\n\n/telegram pair ${result.code}`,
      }).catch(() => {});
      return;
    }
    if (route.kind === "forward") {
      try {
        writeRouted(route.threadId, msg);
      } catch (err) {
        host.log.warn(`[telegram] route write failed: ${String(err)}`);
        await deliverToSession(host, msg, parsed);
      }
      return;
    }
    if (route.kind === "unowned") {
      const entry = registry.threads[String(route.threadId)];
      if (canAutoResumeTopic(msg, access, entry, parsed?.name)) {
        try {
          writeRouted(route.threadId, msg);
        } catch (err) {
          host.log.warn(`[telegram] resume queue write failed: ${String(err)}`);
          await host.callTelegram("sendMessage", {
            chat_id: String(msg.chat.id),
            message_thread_id: route.threadId,
            text: "Could not queue this message, so the session was not resumed.",
          }).catch(() => {});
          return;
        }
        if (!resumingTopics.has(route.threadId)) {
          resumingTopics.add(route.threadId);
          const resume = host.resumeTopic
            ? host.resumeTopic(msg, route.threadId, entry)
            : resumeStaleTopic(host, msg, route.threadId, entry);
          void resume.finally(() => resumingTopics.delete(route.threadId));
        }
        return;
      }
      const text =
        parsed?.name === "stop"
          ? "No live omp session owns this topic, so there is nothing to stop."
          : entry
            ? "No live omp session owns this topic. Resume it locally once to refresh its auto-resume identity."
            : "No saved omp session is attached to this topic.";
      await host.callTelegram("sendMessage", {
        chat_id: String(msg.chat.id),
        message_thread_id: route.threadId,
        text,
      }).catch(() => {});
      return;
    }
    await deliverToSession(host, msg, parsed);
    return;
  }

  if (msg.chat.type === "private" && parsed) {
    if (host.isDaemon && (await handleDaemonSessionCommand(host, access, msg, parsed))) return;
    if (!host.isDaemon && host.handleSessionCommand && (await host.handleSessionCommand(msg, parsed))) return;
  }
  const result = gate(msg, host.botUsername(), access);
  if (result.action === "drop") {
    if (msg.chat.type !== "private" && !(String(msg.chat.id) in access.groups)) {
      host.log.debug(`[telegram] ignored message from unconfigured group ${msg.chat.id} (${(msg.chat.title ?? "").replace(/[<>[\]\r\n;"]/g, "_")})`);
    }
    return;
  }
  if (result.action === "pair") {
    const lead = result.isResend ? "Still pending" : "Pairing required";
    await host.callTelegram("sendMessage", {
      chat_id: String(msg.chat.id),
      text: `${lead} — run in omp:\n\n/telegram pair ${result.code}`,
    }).catch(() => {});
    return;
  }
  if (host.isDaemon) {
    await commandReply(
      host,
      access,
      msg,
      'This bridge routes conversations through session topics. Open a session topic to chat, or "omp control" for commands.',
      false,
    );
    return;
  }
  if (host.deliverLocal) await host.deliverLocal(msg);
}
