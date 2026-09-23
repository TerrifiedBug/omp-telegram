import type { Logger, TgMessage } from "./api";
import type { TelegramCall } from "./control";

export type DeliveryState = "received" | "queued" | "accepted" | "failed" | "uncertain";

/**
 * `deliveryStatus: "reactions"` marks: seen when omp accepts the message, then
 * replied once a reply reaches the chat. Telegram's bot reaction whitelist has
 * no check mark, so 👍 stands in for "done".
 */
export const SEEN_REACTION = "👀";
export const REPLIED_REACTION = "👍";

const STATE_TEXT: Record<DeliveryState, string> = {
  received: "Received by the bridge.",
  queued: "Queued for the session.",
  accepted: "Delivered to omp.",
  failed: "Delivery failed.",
  uncertain: "Delivery is uncertain after the session stopped during handoff.",
};

function statusText(state: DeliveryState, detail?: string): string {
  const clean = detail?.replace(/[\r\n]+/g, " ").trim();
  return clean ? `${STATE_TEXT[state]}\n${clean.slice(0, 1000)}` : STATE_TEXT[state];
}

/**
 * Maintains one small delivery-status message for an inbound Telegram message.
 * The status message id travels with the durable route payload, so the polling
 * process and the consuming session edit the same receipt across processes.
 *
 * Progress receipts (received/queued/accepted) are opt-in via
 * `deliveryStatus: "all"`. A failed or uncertain delivery always gets a notice:
 * silently losing a message is the failure this reporter exists to prevent.
 */
export class DeliveryReporter {
  readonly #call: TelegramCall;
  readonly #showProgress: () => boolean;
  readonly #log?: Logger;
  readonly #creating = new WeakMap<TgMessage, Promise<number | undefined>>();
  readonly #terminal = new WeakMap<TgMessage, "accepted" | "failed" | "uncertain">();

  constructor(callTelegram: TelegramCall, showProgress: () => boolean, log?: Logger) {
    this.#call = callTelegram;
    this.#showProgress = showProgress;
    this.#log = log;
  }

  async report(msg: TgMessage, state: DeliveryState, detail?: string): Promise<void> {
    // Card callbacks are control messages, not user deliveries. Their callback
    // query already receives an immediate acknowledgement.
    if (msg.bridge_callback_id) return;
    // received/queued are provisional. Once a consumer reports a terminal
    // outcome they cannot regress the UI. An explicit accepted is authoritative
    // (Inbound emits it only after real submission) and may confirm a later
    // successful retry after failed, or a genuinely submitted uncertain handoff.
    const terminal = this.#terminal.get(msg);
    if (terminal) {
      if (state === "accepted" && terminal !== "accepted") this.#terminal.set(msg, "accepted");
      else return;
    } else if (state === "accepted" || state === "failed" || state === "uncertain") {
      this.#terminal.set(msg, state);
    }

    let statusId = msg.bridge_status_id;
    if (statusId == null) {
      const pending = this.#creating.get(msg);
      if (pending) {
        // Another state is creating the status message; edit it once it exists
        // (a duplicate "received" already has its text).
        statusId = await pending;
        if (state === "received") return;
      } else if (state === "failed" || state === "uncertain" || (state === "received" && this.#showProgress())) {
        const creating = this.#sendInitial(msg, statusText(state, detail));
        this.#creating.set(msg, creating);
        statusId = await creating;
        this.#creating.delete(msg);
        if (statusId != null) msg.bridge_status_id = statusId;
        return;
      }
    }
    if (statusId == null) return;

    await this.#call("editMessageText", {
      chat_id: String(msg.chat.id),
      ...(msg.is_topic_message && msg.message_thread_id != null ? { message_thread_id: msg.message_thread_id } : {}),
      message_id: statusId,
      text: statusText(state, detail),
    }).catch((err) => {
      this.#log?.warn(`[telegram] delivery status update failed: ${String(err)}`);
    });
  }

  async #sendInitial(msg: TgMessage, text: string): Promise<number | undefined> {
    try {
      const sent = await this.#call<TgMessage>("sendMessage", {
        chat_id: String(msg.chat.id),
        ...(msg.is_topic_message && msg.message_thread_id != null ? { message_thread_id: msg.message_thread_id } : {}),
        text,
        reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
      });
      return typeof sent?.message_id === "number" ? sent.message_id : undefined;
    } catch (err) {
      this.#log?.warn(`[telegram] delivery status send failed: ${String(err)}`);
      return undefined;
    }
  }
}
