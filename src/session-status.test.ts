import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultAccess, saveAccess, statePath } from "./access";
import type { TgCallbackQuery, TgMessage } from "./api";
import type { TelegramCall } from "./control";
import {
  SessionCardController,
  type SessionStatusSnapshot,
  parseSessionCardCallbackId,
  publishSessionStatus,
} from "./session-status";
const previousStateDir = process.env.OMP_TELEGRAM_STATE_DIR;
let dir: string;

const snapshot = (overrides: Partial<SessionStatusSnapshot> = {}): SessionStatusSnapshot => ({
  pid: process.pid,
  sessionId: "session-a",
  sessionFile: "/tmp/session-a.jsonl",
  name: "project-a",
  cwd: "/work/project-a",
  chatId: "42",
  threadId: 7,
  state: "idle",
  model: "openai/gpt",
  thinking: "medium",
  contextPercent: 25,
  pending: false,
  lastActivityAt: 1_000,
  ...overrides,
});

const controlMessage: TgMessage = {
  message_id: 9,
  date: 1,
  from: { id: 42 },
  chat: { id: 42, type: "private" },
  is_topic_message: true,
  message_thread_id: 99,
  text: "/sessions",
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omp-tg-status-"));
  process.env.OMP_TELEGRAM_STATE_DIR = dir;
  saveAccess({
    ...defaultAccess(),
    enabled: true,
    allowFrom: ["42"],
    topicsChat: "42",
    controlThreadId: 99,
  });
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.OMP_TELEGRAM_STATE_DIR;
  else process.env.OMP_TELEGRAM_STATE_DIR = previousStateDir;
  rmSync(dir, { recursive: true, force: true });
});

interface RecordedCall {
  method: string;
  payload: Record<string, unknown>;
}

function recorder(calls: RecordedCall[]): TelegramCall {
  return async <T>(method: string, payload: Record<string, unknown>): Promise<T> => {
    calls.push({ method, payload });
    if (method === "sendMessage") {
      return {
        message_id: 100 + calls.filter((call) => call.method === "sendMessage").length - 1,
        date: 1,
        chat: { id: Number(payload.chat_id), type: "private" },
        ...(payload.message_thread_id == null ? {} : { is_topic_message: true, message_thread_id: payload.message_thread_id }),
      } as T;
    }
    return true as T;
  };
}

function callbackData(call: RecordedCall, row: number, column = 0): string {
  const markup = call.payload.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
  return markup.inline_keyboard[row][column].callback_data;
}

async function openCard(
  controller: SessionCardController,
  calls: RecordedCall[],
): Promise<{ cardMessageId: number; cardData: string }> {
  await controller.sendList(controlMessage, "OMP sessions");
  const listCall = calls.find((call) => call.method === "sendMessage")!;
  const openData = callbackData(listCall, 0);
  await controller.handleCallback({
    id: "open-callback",
    from: { id: 42 },
    data: openData,
    message: { message_id: 100, chat: controlMessage.chat, is_topic_message: true, message_thread_id: 99 },
  });
  const cardCall = calls.filter((call) => call.method === "sendMessage").at(-1)!;
  return { cardMessageId: 101, cardData: callbackData(cardCall, 0, 1) };
}

describe("session cards", () => {
  test("a published snapshot refreshes the same card message", async () => {
    await publishSessionStatus(snapshot());
    const calls: RecordedCall[] = [];
    const callTelegram = recorder(calls);
    const nonces = ["listnonce", "cardnonce"];
    const controller = new SessionCardController({
      getAccess: () => ({ ...defaultAccess(), enabled: true, allowFrom: ["42"], topicsChat: "42", controlThreadId: 99 }),
      callTelegram,
      nonce: () => nonces.shift()!,
      alive: () => true,
      now: () => 2_000,
    });
    await openCard(controller, calls);

    await publishSessionStatus(snapshot({ state: "running", pending: true, lastActivityAt: 1_900 }), callTelegram);

    expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(2);
    const refresh = calls.find((call) => call.method === "editMessageText")!;
    expect(refresh.payload.message_id).toBe(101);
    expect(String(refresh.payload.text)).toContain("State: running");
    expect(String(refresh.payload.text)).toContain("Pending message: yes");
  });

  test("minimal sendMessage results use the known command target", async () => {
    await publishSessionStatus(snapshot());
    const calls: RecordedCall[] = [];
    let messageId = 100;
    const callTelegram: TelegramCall = async <T>(method: string, payload: Record<string, unknown>): Promise<T> => {
      calls.push({ method, payload });
      if (method === "sendMessage") return { message_id: messageId++ } as T;
      return true as T;
    };
    const nonces = ["listnonce", "cardnonce"];
    const controller = new SessionCardController({
      getAccess: () => ({ ...defaultAccess(), enabled: true, allowFrom: ["42"], topicsChat: "42", controlThreadId: 99 }),
      callTelegram,
      nonce: () => nonces.shift()!,
      alive: () => true,
      now: () => 2_000,
    });

    await expect(openCard(controller, calls)).resolves.toEqual({
      cardMessageId: 101,
      cardData: "sc:s:cardnonce",
    });
    expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(2);
  });

  test("card actions spool the exact target with callback identity", async () => {
    await publishSessionStatus(snapshot());
    await publishSessionStatus(snapshot({ pid: process.pid + 1, sessionId: "session-b", name: "project-b", threadId: 8 }));
    const calls: RecordedCall[] = [];
    const controller = new SessionCardController({
      getAccess: () => ({ ...defaultAccess(), enabled: true, allowFrom: ["42"], topicsChat: "42", controlThreadId: 99 }),
      callTelegram: recorder(calls),
      nonce: (() => {
        const nonces = ["listnonce", "cardnonce"];
        return () => nonces.shift()!;
      })(),
      alive: () => true,
      now: () => 2_000,
    });
    const { cardMessageId, cardData } = await openCard(controller, calls);

    await controller.handleCallback({
      id: "unique-action-id",
      from: { id: 42 },
      data: cardData,
      message: { message_id: cardMessageId, chat: controlMessage.chat, is_topic_message: true, message_thread_id: 99 },
    });

    const names = readdirSync(statePath("route", "7")).filter((name) => name.endsWith(".json"));
    expect(names).toHaveLength(1);
    const payload = JSON.parse(readFileSync(statePath("route", "7", names[0]), "utf8")) as { msg: TgMessage };
    expect(payload.msg).toMatchObject({
      text: "/stop",
      message_thread_id: 7,
      chat: { id: 42 },
    });
    expect(parseSessionCardCallbackId(payload.msg.bridge_callback_id)).toEqual({
      pid: process.pid,
      sessionId: "session-a",
      chatId: "42",
      originPrivate: true,
      threadId: 7,
      queryId: "unique-action-id",
    });
    expect(() => readdirSync(statePath("route", "8"))).toThrow();
  });

  test("rejects foreign, wrong-message, and changed-session callbacks", async () => {
    await publishSessionStatus(snapshot());
    const calls: RecordedCall[] = [];
    const controller = new SessionCardController({
      getAccess: () => ({ ...defaultAccess(), enabled: true, allowFrom: ["42"], topicsChat: "42", controlThreadId: 99 }),
      callTelegram: recorder(calls),
      nonce: (() => {
        const nonces = ["listnonce", "cardnonce"];
        return () => nonces.shift()!;
      })(),
      alive: () => true,
      now: () => 2_000,
    });
    const { cardMessageId, cardData } = await openCard(controller, calls);
    const cardQuery = (overrides: Partial<TgCallbackQuery>): TgCallbackQuery => ({
      id: "card-action",
      from: { id: 42 },
      data: cardData,
      message: { message_id: cardMessageId, chat: controlMessage.chat, is_topic_message: true, message_thread_id: 99 },
      ...overrides,
    });

    await controller.handleCallback(cardQuery({ from: { id: 99 } }));
    await controller.handleCallback(cardQuery({ message: { message_id: 999, chat: controlMessage.chat, is_topic_message: true, message_thread_id: 99 } }));
    await publishSessionStatus(snapshot({ sessionId: "replacement-session" }));
    await controller.handleCallback(cardQuery({ id: "changed-session" }));

    expect(() => readdirSync(statePath("route", "7"))).toThrow();
    const answers = calls.filter((call) => call.method === "answerCallbackQuery");
    expect(answers.some((call) => String(call.payload.text).includes("restricted"))).toBe(true);
    expect(answers.some((call) => String(call.payload.text).includes("stale"))).toBe(true);
    expect(answers.some((call) => String(call.payload.text).includes("exact session"))).toBe(true);
  });
});
