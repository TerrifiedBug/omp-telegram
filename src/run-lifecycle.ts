import { basename } from "node:path";
import { type Access, effectiveStreaming, notifyTarget } from "./access";
import type { Logger } from "./api";
import { Outbound, finalAssistantText, lastRunError } from "./outbound";

type Target = { chatId: string; threadId?: number };
type Topic = { chatId: string; threadId: number };

function shortError(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 300);
}

function delayLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "a bit";
  if (ms < 1000) return Math.round(ms) + "ms";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return seconds + "s";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m";
  return Math.floor(minutes / 60) + "h" + (minutes % 60 === 0 ? "" : " " + (minutes % 60) + "m");
}

/** Retry continuations retain their destinations; only terminal settlement ends a run. */
export class RunLifecycle {
  #failureAnnounced = false;
  #retryAnnounced = false;

  constructor(
    private readonly outbound: Outbound,
    private readonly getAccess: () => Access,
    private readonly log: Logger,
  ) {}

  begin(): void {
    this.#failureAnnounced = false;
    this.#retryAnnounced = false;
  }

  async #announce(text: string): Promise<void> {
    if (effectiveStreaming(this.getAccess()) !== "explicit") await this.outbound.announce(text);
  }

  async retryStarted(event: { errorMessage: string; attempt: number; maxAttempts: number; delayMs: number }): Promise<void> {
    if (this.#retryAnnounced) return;
    this.#retryAnnounced = true;
    await this.#announce(`Request failed: ${shortError(event.errorMessage)}. Retrying (${event.attempt}/${event.maxAttempts}, in ~${delayLabel(event.delayMs)}).`);
  }

  async retryEnded(event: { success: boolean; attempt: number; finalError?: string }): Promise<void> {
    if (event.success) {
      if (!this.#retryAnnounced) return;
      this.#retryAnnounced = false;
      await this.#announce(`Request succeeded after ${event.attempt}${event.attempt === 1 ? " retry." : " retries."}`);
      return;
    }
    this.#failureAnnounced = true;
    await this.#announce(`Run failed after ${event.attempt}${event.attempt === 1 ? " attempt" : " attempts"}: ${shortError(event.finalError ?? "unknown error")}. Use /model to switch, /sessions for state.`);
  }

  async fallbackApplied(event: { from: string; to: string; role: string }): Promise<void> {
    await this.#announce(`Model fallback: ${event.from} -> ${event.to} (${event.role}).`);
  }

  async end(
    event: { messages: readonly unknown[]; willContinue?: boolean },
    settle: () => Promise<Topic | undefined>,
  ): Promise<boolean> {
    if (event.willContinue) return false;
    const wasActive = this.outbound.isActive();
    const text = finalAssistantText(event.messages);
    const error = lastRunError(event.messages);
    if (error && !this.#failureAnnounced) {
      this.#failureAnnounced = true;
      const detail = `${error.status != null ? error.status + " " : ""}${shortError(error.message)}`;
      await this.#announce(`Run failed: ${detail}. Use /model to switch, /sessions for state.`);
    }
    let topic: Topic | undefined;
    try {
      await this.outbound.onAgentEnd(text);
    } finally {
      topic = await settle();
    }
    const access = this.getAccess();
    if (effectiveStreaming(access) === "explicit") return true;
    const destination = notifyTarget(wasActive, access, this.outbound.hasToken(), topic);
    if (destination) {
      await this.outbound.send(destination.chatId, text || `omp idle in ${basename(process.cwd())}. Your turn.`, { threadId: destination.threadId })
        .catch((err) => this.log.debug(`[telegram] idle notify failed: ${String(err)}`));
    }
    return true;
  }
}
