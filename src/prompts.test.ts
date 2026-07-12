import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TgCallbackQuery, TgMessage } from "./api";
import type { TelegramCall } from "./control";
import { TelegramPromptController, formatPromptResult } from "./prompts";

const previousStateDir = process.env.OMP_TELEGRAM_STATE_DIR;
let dir: string;
let calls: Array<{ method: string; payload: Record<string, unknown> }>;
let nextMessageId: number;
let pollWaiters: Array<() => void>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "omp-tg-prompts-test-"));
  process.env.OMP_TELEGRAM_STATE_DIR = dir;
  calls = [];
  nextMessageId = 100;
  pollWaiters = [];
});

afterEach(async () => {
  if (previousStateDir === undefined) delete process.env.OMP_TELEGRAM_STATE_DIR;
  else process.env.OMP_TELEGRAM_STATE_DIR = previousStateDir;
  await rm(dir, { recursive: true, force: true });
});

function telegram(): TelegramCall {
  return async <T>(method: string, payload: Record<string, unknown>): Promise<T> => {
    calls.push({ method, payload });
    return (method === "sendMessage" ? { message_id: ++nextMessageId } : {}) as T;
  };
}

function callback(data: string, messageId: number, from = 42): TgCallbackQuery {
  return {
    id: `callback-${data}`,
    data,
    from: { id: from },
    message: {
      message_id: messageId,
      chat: { id: 42, type: "private" },
      is_topic_message: true,
      message_thread_id: 7,
    },
  };
}

function textMessage(text: string, from = 42): TgMessage {
  return {
    message_id: 500,
    date: 1,
    from: { id: from },
    chat: { id: 42, type: "private" },
    is_topic_message: true,
    message_thread_id: 7,
    text,
  };
}

function waitForTestPoll(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      const index = pollWaiters.indexOf(done);
      if (index >= 0) pollWaiters.splice(index, 1);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    pollWaiters.push(done);
    signal?.addEventListener("abort", done, { once: true });
  });
}

async function waitForRequest(nonce: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await stat(join(dir, "prompts", `${nonce}.json`));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error("prompt request was not persisted");
}

async function advancePromptPoll(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const resume = pollWaiters.shift();
    if (resume) {
      resume();
      await Promise.resolve();
      return;
    }
    await stat(dir);
  }
  throw new Error("prompt owner did not start polling");
}

const target = { responderId: "42", chatId: "42", chatType: "private", threadId: 7 } as const;

describe("TelegramPromptController", () => {
  test("persists a single-select request and accepts only its responder", async () => {
    const owner = new TelegramPromptController({ callTelegram: telegram(), authorize: (id) => id === "42", nonce: () => "single", waitForPoll: waitForTestPoll });
    const poller = new TelegramPromptController({ callTelegram: telegram(), authorize: (id) => id === "42" });
    const pending = owner.ask(target, [{ id: "choice", question: "Choose", options: [{ label: "A" }, { label: "B" }] }]);
    await waitForRequest("single");

    expect(await poller.handleCallback(callback("qa:single:s:1", 101, 99))).toBe(true);
    expect(calls.at(-1)?.payload.show_alert).toBe(true);
    expect(await poller.handleCallback(callback("qa:single:s:1", 101))).toBe(true);
    await advancePromptPoll();

    await expect(pending).resolves.toEqual({
      status: "answered",
      answers: [{ id: "choice", question: "Choose", selectedOptions: ["B"] }],
    });
  });

  test("supports paged multi-select with explicit Done", async () => {
    const owner = new TelegramPromptController({ callTelegram: telegram(), authorize: () => true, nonce: () => "multi", waitForPoll: waitForTestPoll });
    const poller = new TelegramPromptController({ callTelegram: telegram(), authorize: () => true });
    const options = Array.from({ length: 10 }, (_, index) => ({ label: `Option ${index}` }));
    const pending = owner.ask(target, [{ id: "many", question: "Choose several", options, multi: true }]);
    await waitForRequest("multi");

    await poller.handleCallback(callback("qa:multi:t:0", 101));
    await poller.handleCallback(callback("qa:multi:p:1", 101));
    await poller.handleCallback(callback("qa:multi:t:9", 101));
    await poller.handleCallback(callback("qa:multi:d", 101));
    await advancePromptPoll();

    await expect(pending).resolves.toEqual({
      status: "answered",
      answers: [{ id: "many", question: "Choose several", selectedOptions: ["Option 0", "Option 9"] }],
    });
    expect(calls.some((call) => call.method === "editMessageText" && JSON.stringify(call.payload.reply_markup).includes("Previous"))).toBe(true);
  });

  test("captures Other text from the exact responder instead of creating another agent turn", async () => {
    const owner = new TelegramPromptController({ callTelegram: telegram(), authorize: (id) => id === "42", nonce: () => "other", waitForPoll: waitForTestPoll });
    const poller = new TelegramPromptController({ callTelegram: telegram(), authorize: (id) => id === "42" });
    const pending = owner.ask(target, [{ id: "custom", question: "Choose", options: [{ label: "A" }, { label: "B" }] }]);
    await waitForRequest("other");

    await poller.handleCallback(callback("qa:other:o", 101));
    expect(await poller.handleMessage(textMessage("wrong", 99))).toBe(false);
    expect(await poller.handleMessage(textMessage("My custom answer"))).toBe(true);
    await advancePromptPoll();

    const outcome = await pending;
    expect(outcome).toEqual({
      status: "answered",
      answers: [{ id: "custom", question: "Choose", selectedOptions: [], customInput: "My custom answer" }],
    });
    expect(formatPromptResult(outcome)).toBe("User provided custom input: My custom answer");
  });

  test("handles button cancellation, text cancellation, abort, and expiry", async () => {
    const buttonOwner = new TelegramPromptController({ callTelegram: telegram(), authorize: () => true, nonce: () => "button-cancel", waitForPoll: waitForTestPoll });
    const poller = new TelegramPromptController({ callTelegram: telegram(), authorize: () => true });
    const buttonPending = buttonOwner.ask(target, [{ id: "q", question: "Choose", options: [{ label: "A" }, { label: "B" }] }]);
    await waitForRequest("button-cancel");
    await poller.handleCallback(callback("qa:button-cancel:x", 101));
    await advancePromptPoll();
    await expect(buttonPending).resolves.toEqual({ status: "cancelled" });

    nextMessageId = 101;
    const textOwner = new TelegramPromptController({ callTelegram: telegram(), authorize: () => true, nonce: () => "text-cancel", waitForPoll: waitForTestPoll });
    const textPending = textOwner.ask(target, [{ id: "q", question: "Choose", options: [{ label: "A" }, { label: "B" }] }]);
    await waitForRequest("text-cancel");
    await poller.handleCallback(callback("qa:text-cancel:o", 102));
    expect(await poller.handleMessage(textMessage("/cancel"))).toBe(true);
    await advancePromptPoll();
    await expect(textPending).resolves.toEqual({ status: "cancelled" });

    nextMessageId = 102;
    const abort = new AbortController();
    const abortOwner = new TelegramPromptController({ callTelegram: telegram(), authorize: () => true, nonce: () => "abort", waitForPoll: waitForTestPoll });
    const abortPending = abortOwner.ask(target, [{ id: "q", question: "Choose", options: [{ label: "A" }, { label: "B" }] }], abort.signal);
    await waitForRequest("abort");
    abort.abort();
    await expect(abortPending).resolves.toEqual({ status: "aborted" });

    let now = 0;
    nextMessageId = 103;
    const expiryOwner = new TelegramPromptController({ callTelegram: telegram(), authorize: () => true, nonce: () => "expiry", now: () => now, waitForPoll: waitForTestPoll });
    const expiryPending = expiryOwner.ask(target, [{ id: "q", question: "Choose", options: [{ label: "A" }, { label: "B" }] }]);
    await waitForRequest("expiry");
    await advancePromptPoll();
    now = 5 * 60_000 + 1;
    await advancePromptPoll();
    await expect(expiryPending).resolves.toEqual({ status: "expired" });
  });
});
