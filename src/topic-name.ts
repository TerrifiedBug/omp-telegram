import { type FSWatcher, watch } from "node:fs";
import { stateDir } from "./access";
import { type Logger, TgError, withRateLimit } from "./api";
import { isAlive, loadRegistry, renameThread, type ThreadRegistry } from "./topics";

/** Display cap, including the ellipsis and any live-owner suffix (Telegram allows 128). */
export const TOPIC_NAME_MAX = 32;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function prefix(value: string, max: number): string {
  let result = "";
  let length = 0;
  for (const { segment } of graphemes.segment(value)) {
    const size = Array.from(segment).length;
    if (length + size > max) break;
    result += segment;
    length += size;
  }
  return result;
}

/** Normalize before comparing, so long session titles do not cause repeated edits. */
export function topicName(sessionName: string | undefined, fallback: string): string {
  const name = (sessionName?.trim() || fallback).replace(/\s+/gu, " ").trim();
  if (Array.from(name).length <= TOPIC_NAME_MAX) return name;
  let shortened = prefix(name, TOPIC_NAME_MAX - 1);
  const space = shortened.lastIndexOf(" ");
  if (space >= 0 && Array.from(shortened.slice(0, space)).length >= 20) shortened = shortened.slice(0, space);
  return `${shortened.trimEnd()}…`;
}

/** Keep the existing -pid convention without exceeding the display/Telegram cap. */
export function availableTopicName(
  desired: string,
  registry: ThreadRegistry,
  threadId?: number,
  pid = process.pid,
  alive: (pid: number) => boolean = isAlive,
  maxLength = TOPIC_NAME_MAX,
): string {
  const occupied = (name: string): boolean => Object.entries(registry.threads).some(
    ([id, entry]) => Number(id) !== threadId && entry.name === name && alive(entry.pid),
  );
  if (!occupied(desired)) return desired;
  for (let attempt = 1; ; attempt++) {
    const suffix = `-${pid}${attempt === 1 ? "" : `-${attempt}`}`;
    const base = Number.isFinite(maxLength) ? prefix(desired, maxLength - Array.from(suffix).length).trimEnd() : desired;
    const name = `${base}${suffix}`;
    if (!occupied(name)) return name;
  }
}

export interface NamedTopic {
  threadId: number;
  name: string;
}

/** Detached from routing; one request at a time and one warning per failed name. */
export class TopicNameSync {
  #pending = false;
  #warned = new Set<string>();
  #timer: NodeJS.Timeout | undefined;
  #mode: "session" | "space" = "session";
  #spaceSettled = false;
  #settingsWatcher: FSWatcher | undefined;
  #check: (() => void) | undefined;

  get running(): boolean {
    return this.#timer !== undefined;
  }

  configure(mode: "session" | "space", check: () => void): void {
    if (mode !== this.#mode) this.#spaceSettled = false;
    this.#mode = mode;
    this.#check = check;
    if (mode === "space") {
      clearInterval(this.#timer);
      this.#timer = undefined;
    } else if (!this.#timer) {
      this.#timer = setInterval(check, 30_000);
      this.#timer.unref();
    }
  }

  /** Atomic access.json replacements must wake idle space-mode sessions too. */
  watchSettings(check: () => void, log: Logger): void {
    if (this.#settingsWatcher) return;
    try {
      this.#settingsWatcher = watch(stateDir(), { persistent: false }, (_event, name) => {
        if (name?.toString() === "access.json") check();
      });
      this.#settingsWatcher.on("error", (err) => log.warn(`[telegram] topic names settings watch failed: ${String(err)}`));
    } catch (err) {
      log.warn(`[telegram] topic names settings watch failed: ${String(err)}`);
    }
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#settingsWatcher?.close();
    this.#settingsWatcher = undefined;
    this.#spaceSettled = false;
  }

  async check(
    chatId: string | undefined,
    topic: NamedTopic | undefined,
    desired: string,
    callTelegram: (method: string, payload: Record<string, unknown>) => Promise<unknown>,
    log: Logger,
  ): Promise<boolean> {
    if ((this.#mode === "space" && this.#spaceSettled) || !chatId || !topic || this.#pending) return false;
    const mode = this.#mode;
    this.#pending = true;
    let name = desired;
    try {
      // The cheap in-memory check is done by the caller. Only changed names and
      // retries read the registry, and only the still-owned thread is editable.
      const registry = loadRegistry();
      const entry = registry.threads[String(topic.threadId)];
      if (registry.chatId !== chatId || entry?.pid !== process.pid) return false;
      name = availableTopicName(desired, registry, topic.threadId, process.pid, isAlive, mode === "space" ? Infinity : TOPIC_NAME_MAX);
      if (entry.name !== name) {
        try {
          await withRateLimit(() => callTelegram("editForumTopic", {
            chat_id: chatId,
            message_thread_id: topic.threadId,
            name,
          }), { log });
        } catch (err) {
          if (!(err instanceof TgError && /TOPIC_NOT_MODIFIED/i.test(err.message))) throw err;
        }
        if (!renameThread(chatId, topic.threadId, process.pid, name)) return false;
      }
      topic.name = name;
      if (mode === "space" && this.#mode === mode) this.#spaceSettled = true;
      return true;
    } catch (err) {
      if (!this.#warned.has(name)) {
        this.#warned.add(name);
        log.warn(`[telegram] could not rename topic to ${JSON.stringify(name)}; retrying at the next check: ${String(err)}`);
      }
      return false;
    } finally {
      this.#pending = false;
      if (this.#mode !== mode) this.#check?.();
    }
  }
}
