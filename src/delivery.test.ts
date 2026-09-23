import { describe, expect, test } from "bun:test";
import type { Logger, TgMessage } from "./api";
import type { TelegramCall } from "./control";
import { DeliveryReporter } from "./delivery";

const message = (): TgMessage => ({
  message_id: 7,
  date: 1,
  from: { id: 42 },
  chat: { id: 42, type: "private" },
  text: "hello",
});

const log: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const all = (): boolean => true;
const failuresOnly = (): boolean => false;

describe("DeliveryReporter", () => {
  test("progresses one status message instead of sending a receipt per state", async () => {
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    const callTelegram: TelegramCall = async <T>(method: string, payload: Record<string, unknown>): Promise<T> => {
      calls.push({ method, payload });
      return { message_id: 99, date: 1, chat: { id: 42, type: "private" } } as T;
    };
    const reporter = new DeliveryReporter(callTelegram, all, log);
    const msg = message();

    await reporter.report(msg, "received");
    await reporter.report(msg, "queued");
    await reporter.report(msg, "accepted");

    expect(msg.bridge_status_id).toBe(99);
    expect(calls.map((call) => call.method)).toEqual(["sendMessage", "editMessageText", "editMessageText"]);
    expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(1);
    expect(calls.at(-1)?.payload).toMatchObject({ message_id: 99, text: "Delivered to omp." });
  });

  test("provisional updates cannot overwrite failure, while real retry acceptance can", async () => {
    const texts: string[] = [];
    const callTelegram: TelegramCall = async <T>(_method: string, payload: Record<string, unknown>): Promise<T> => {
      texts.push(String(payload.text));
      return { message_id: 100, date: 1, chat: { id: 42, type: "private" } } as T;
    };
    const reporter = new DeliveryReporter(callTelegram, all, log);
    const msg = message();

    await reporter.report(msg, "received");
    await reporter.report(msg, "failed", "No content reached omp.");
    await reporter.report(msg, "queued");
    await reporter.report(msg, "accepted");

    expect(texts).toEqual([
      "Received by the bridge.",
      "Delivery failed.\nNo content reached omp.",
      "Delivered to omp.",
    ]);
  });

  test("uncertain remains terminal until an authoritative submit is confirmed", async () => {
    const texts: string[] = [];
    const reporter = new DeliveryReporter(async <T>(_method: string, payload: Record<string, unknown>): Promise<T> => {
      texts.push(String(payload.text));
      return { message_id: 101, date: 1, chat: { id: 42, type: "private" } } as T;
    }, all, log);
    const msg = message();

    await reporter.report(msg, "received");
    await reporter.report(msg, "uncertain");
    await reporter.report(msg, "queued");
    expect(texts.at(-1)).toBe("Delivery is uncertain after the session stopped during handoff.");

    await reporter.report(msg, "accepted");
    expect(texts.at(-1)).toBe("Delivered to omp.");
  });

  test("synthetic card commands never create delivery chatter", async () => {
    const calls: string[] = [];
    const reporter = new DeliveryReporter(async <T>(method: string): Promise<T> => {
      calls.push(method);
      return undefined as T;
    }, all, log);
    const msg = { ...message(), bridge_callback_id: "callback-1" };

    await reporter.report(msg, "received");
    await reporter.report(msg, "accepted");

    expect(calls).toEqual([]);
  });

  test("Telegram status failures do not fail the user delivery", async () => {
    const reporter = new DeliveryReporter(async () => {
      throw new Error("network down");
    }, all, log);

    await expect(reporter.report(message(), "received")).resolves.toBeUndefined();
  });

  test("failures-only mode stays silent on success but still reports a failure", async () => {
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    const callTelegram: TelegramCall = async <T>(method: string, payload: Record<string, unknown>): Promise<T> => {
      calls.push({ method, payload });
      return { message_id: 102, date: 1, chat: { id: 42, type: "private" } } as T;
    };
    const reporter = new DeliveryReporter(callTelegram, failuresOnly, log);

    const ok = message();
    await reporter.report(ok, "received");
    await reporter.report(ok, "queued");
    await reporter.report(ok, "accepted");
    expect(calls).toEqual([]);

    const lost = message();
    await reporter.report(lost, "received");
    await reporter.report(lost, "failed", "No content reached omp.");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "sendMessage",
      payload: { text: "Delivery failed.\nNo content reached omp.", reply_parameters: { message_id: 7 } },
    });
    // A later successful retry corrects the notice instead of leaving a stale failure.
    await reporter.report(lost, "accepted");
    expect(calls.at(-1)).toMatchObject({ method: "editMessageText", payload: { message_id: 102, text: "Delivered to omp." } });
  });
});
