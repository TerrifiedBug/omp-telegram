import { isPairedOwnerDm, type Access } from "./access";
import type { TgMessage } from "./api";

export interface SessionRenameHost {
  access: Access;
  ownThreadId?: number;
  hasContext: boolean;
  getSessionName(): string | undefined;
  setSessionName(name: string): void | Promise<void>;
  syncTopicName(): void;
  reply(text: string): Promise<void>;
}

/** Rename only the paired owner's live session topic, never an agent prompt. */
export async function handleSessionRename(msg: TgMessage, args: string, host: SessionRenameHost): Promise<void> {
  if (!isPairedOwnerDm(String(msg.from?.id ?? ""), String(msg.chat.id), msg.chat.type, host.access)) return;
  if (!host.hasContext || msg.is_topic_message !== true || host.ownThreadId == null ||
    msg.message_thread_id !== host.ownThreadId || String(msg.chat.id) !== host.access.topicsChat ||
    msg.message_thread_id === host.access.controlThreadId) {
    await host.reply("Use /rename <name> inside the omp session topic you want to rename.");
    return;
  }
  const name = args.trim().replace(/\s+/gu, " ");
  if (!name) {
    await host.reply(`Current session name: ${host.getSessionName()?.trim() || "(unnamed)"}\nUsage: /rename <name>`);
    return;
  }
  try {
    await host.setSessionName(name);
    host.syncTopicName();
    await host.reply(`Session renamed: ${name}${host.access.topicsNames !== "session" ? "\nTopic keeps the space name. Use /telegram topics names session to follow session names." : ""}`);
  } catch (err) {
    await host.reply(`Could not rename this session: ${err instanceof Error ? err.message : String(err)}`);
  }
}
