import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Access,
  controlTopicCreationChat,
  gate,
  isPairedOwnerDm,
  loadAccess,
  pairedOwnerId,
  saveAccess,
} from "./access";
import { isMissingThreadError, type Logger, type TgMessage, type TgUpdate } from "./api";
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
  type ThreadRegistry,
  decideRoute,
  isAlive,
  isResumedOwner,
  loadRegistry,
  saveRegistry,
  writeRouted,
} from "./topics";

export const BOT_COMMANDS = [
  { command: "start", description: "Pairing instructions" },
  { command: "spawn", description: "Start omp in a herdr space" },
  { command: "sessions", description: "List active omp sessions" },
  { command: "cleanup", description: "Delete stale and duplicate omp topics" },
  { command: "stop", description: "Abort this topic's omp task" },
  { command: "compact", description: "Compact this session's context" },
  { command: "model", description: "Show or change this session's model" },
  { command: "switch", description: "Choose this session's model" },
  { command: "thinking", description: "Show or change thinking level" },
  { command: "status", description: "Bridge and session health" },
  { command: "help", description: "Show available commands" },
  { command: "whoami", description: "Show your Telegram IDs" },
];

const KNOWN_COMMANDS: Record<string, true> = {
  start: true,
  spawn: true,
  sessions: true,
  cleanup: true,
  stop: true,
  compact: true,
  model: true,
  switch: true,
  thinking: true,
  status: true,
  help: true,
  whoami: true,
};
const GLOBAL_COMMANDS: Record<string, true> = {
  start: true,
  spawn: true,
  sessions: true,
  cleanup: true,
  status: true,
  help: true,
  whoami: true,
};
const SESSION_COMMANDS: Record<string, true> = {
  stop: true,
  compact: true,
  model: true,
  switch: true,
  thinking: true,
};
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

/** Delete stale topics and same-process extras while preserving live sibling sessions. */
export async function cleanupRegisteredTopics(
  registry: ThreadRegistry,
  keepThreadId: number,
  selfPid: number,
  alive: (pid: number) => boolean,
  deleteTopic: (threadId: number) => Promise<void>,
): Promise<{ deletedThreadIds: number[]; failed: number }> {
  const deletedThreadIds: number[] = [];
  let failed = 0;
  for (const [threadIdText, entry] of Object.entries(registry.threads)) {
    const threadId = Number(threadIdText);
    if (threadId === keepThreadId || (entry.pid !== selfPid && alive(entry.pid))) continue;
    try {
      await deleteTopic(threadId);
      deletedThreadIds.push(threadId);
    } catch {
      failed++;
    }
  }
  return { deletedThreadIds, failed };
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
      text: "OMP control\n\nUse this topic for bridge commands:\n/spawn — start omp in a herdr space\n/sessions — inspect session and topic state\n/status — bridge health\n/help — command reference\n\nUse the other topics for conversations with individual omp sessions.",
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
    await commandReply(
      host,
      access,
      msg,
      owner
        ? 'Use "omp control" for bridge commands and the other topics for agent conversations.\n\n/spawn [space] — start omp in a herdr space\n/sessions — list active omp sessions and topic attachment\n/cleanup — delete all other omp topics\n/stop — abort this topic’s current task\n/compact [focus] — compact this session’s context\n/model [provider/id] — show or change this session’s model\n/switch — choose this session’s model\n/thinking [level] — show or change thinking level\n/status — bridge and session health\n/whoami — show Telegram IDs'
        : "/start — pairing instructions\n/status — pairing state\n/whoami — show Telegram IDs",
    );
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
    } else {
      const keepThreadId = host.ownThreadId() ?? -1;
      if (!host.isDaemon && keepThreadId < 0) {
        await commandReply(host, access, msg, "No main omp topic is attached, so cleanup was skipped.");
        return true;
      }
      const registry = loadRegistry(host.warn);
      const otherCount = Object.keys(registry.threads).filter((threadId) => Number(threadId) !== keepThreadId).length;
      const protectedCount = Object.entries(registry.threads).filter(
        ([threadId, entry]) => Number(threadId) !== keepThreadId && entry.pid !== host.selfPid && isAlive(entry.pid),
      ).length;
      const count = otherCount - protectedCount;
      const protectedText = protectedCount
        ? ` ${protectedCount} topic${protectedCount === 1 ? "" : "s"} owned by other live omp sessions will stay.`
        : "";
      const preserved = host.isDaemon ? "Topics owned by live omp sessions and omp control remain." : "The main omp topic and omp control remain.";
      if (count === 0) {
        await commandReply(host, access, msg, `Nothing stale or duplicated to clean up. ${preserved}${protectedText}`);
      } else if (args !== "confirm") {
        await commandReply(
          host,
          access,
          msg,
          `This permanently deletes ${count} stale or duplicate omp topic${count === 1 ? "" : "s"} and all messages in ${count === 1 ? "it" : "them"}. ${preserved}${protectedText}\n\nRun /cleanup confirm to continue.`,
        );
      } else {
        const topicsChat = registry.chatId || access.topicsChat!;
        const result = await cleanupRegisteredTopics(registry, keepThreadId, host.selfPid, isAlive, async (threadId) => {
          try {
            await host.callTelegram("deleteForumTopic", { chat_id: topicsChat, message_thread_id: threadId });
          } catch (err) {
            if (!isMissingThreadError(err)) throw err;
          }
        });
        const currentRegistry = loadRegistry(host.warn);
        for (const threadId of result.deletedThreadIds) delete currentRegistry.threads[String(threadId)];
        saveRegistry(currentRegistry);
        const deleted = result.deletedThreadIds.length;
        await commandReply(
          host,
          access,
          msg,
          `Deleted ${deleted} stale or duplicate omp topic${deleted === 1 ? "" : "s"}. ${preserved}${protectedText}${result.failed ? ` ${result.failed} could not be deleted and remain registered.` : ""}`,
        );
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
