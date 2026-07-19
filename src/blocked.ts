// Blocked-input Telegram pings. A local run that parks for input — a tool
// approval, or an `ask` prompt (which is read-approval and so never fires the
// approval ping) — is surfaced to Telegram after a short grace, then edited to a
// resumed marker once it unblocks. The lifecycle mirrors the tool-approval ping.

/** Destination for a blocked-input ping. */
export interface PingTarget {
  chatId: string;
  threadId?: number;
}

/** Side-effect surface for {@link BlockedPings}, injected so the lifecycle is testable. */
export interface BlockedPingDeps {
  /** Deliver the ping; resolves to the sent message id (or undefined if the transport hid it). */
  send: (chatId: string, text: string, threadId: number | undefined) => Promise<number | undefined>;
  /** Edit a delivered ping in place once the block resolves. Best-effort; swallows its own errors. */
  edit: (chatId: string, messageId: number, text: string) => Promise<void>;
  /** Schedule `cb` after `ms`; returns a canceler that is idempotent and safe to call post-fire. */
  schedule: (cb: () => void, ms: number) => () => void;
  /** Grace before a still-blocked run pings, so a quick local answer stays silent. */
  delayMs: number;
  /** Text a delivered ping is edited to once the run resumes. */
  resumedText: () => string;
  /** Optional observer for a failed send. */
  onError?: (err: unknown) => void;
}

interface Pending {
  chatId: string;
  threadId?: number;
  cancel?: () => void;
  messageId?: number;
  resolved?: boolean;
}

/**
 * Summarize an `ask` tool call for a blocked-input ping: the first question,
 * plus a count of any others. Returns "" when the args carry no question text.
 */
export function askQuestionSummary(args: unknown): string {
  if (!args || typeof args !== "object" || !("questions" in args)) return "";
  const questions = args.questions;
  if (!Array.isArray(questions) || questions.length === 0) return "";
  const first = questions[0];
  if (!first || typeof first !== "object" || !("question" in first)) return "";
  const q = first.question;
  if (typeof q !== "string" || !q.trim()) return "";
  const more = questions.length > 1 ? ` (+${questions.length - 1} more)` : "";
  return `:\n${q.trim()}${more}`;
}

/**
 * Lifecycle for "a local run is blocked on input" Telegram pings, keyed by tool
 * call id. A run that stays blocked past the grace pings once; a resolution
 * before the grace cancels it silently; a resolution after the ping edits the
 * message to the resumed text. A send still in flight when the block resolves is
 * reconciled when it lands.
 */
export class BlockedPings {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly deps: BlockedPingDeps) {}

  /** A run became blocked: schedule a ping after the grace unless it resolves first. */
  start(id: string, target: PingTarget, buildText: () => string): void {
    this.pending.get(id)?.cancel?.();
    const pending: Pending = { chatId: target.chatId, threadId: target.threadId };
    pending.cancel = this.deps.schedule(() => {
      if (this.pending.get(id) !== pending) return;
      pending.cancel = undefined;
      void this.deps
        .send(pending.chatId, buildText(), pending.threadId)
        .then((messageId) => {
          if (this.pending.get(id) !== pending) return;
          pending.messageId = messageId;
          if (pending.resolved && pending.messageId != null) {
            void this.deps.edit(pending.chatId, pending.messageId, this.deps.resumedText());
            this.pending.delete(id);
          }
        })
        .catch((err) => {
          this.pending.delete(id);
          this.deps.onError?.(err);
        });
    }, this.deps.delayMs);
    this.pending.set(id, pending);
  }

  /** The run resumed: cancel a still-pending ping, or edit a delivered one to resumed. */
  end(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    if (pending.cancel) {
      pending.cancel();
      this.pending.delete(id);
      return;
    }
    if (pending.messageId == null) {
      pending.resolved = true; // send in flight — reconcile when it lands
      return;
    }
    this.pending.delete(id);
    void this.deps.edit(pending.chatId, pending.messageId, this.deps.resumedText());
  }

  /** Drop every scheduled ping (the agent loop ended). */
  clear(): void {
    for (const pending of this.pending.values()) pending.cancel?.();
    this.pending.clear();
  }
}
