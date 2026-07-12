import { describe, expect, test } from "bun:test";
import { defaultAccess } from "./access";
import { TgError, type TgMessage } from "./api";
import { canAutoResumeTopic, consumeOutsidePrivateChat, isMissingThreadError, parseTelegramPromptTarget } from "./index";

describe("Telegram bot command scope", () => {
  test("known commands are consumed outside private chats instead of reaching omp", () => {
    expect(consumeOutsidePrivateChat("supergroup", "spawn")).toBe(true);
    expect(consumeOutsidePrivateChat("group", "sessions")).toBe(true);
    expect(consumeOutsidePrivateChat("supergroup", "stop")).toBe(true);
    expect(consumeOutsidePrivateChat("supergroup", "compact")).toBe(true);
    expect(consumeOutsidePrivateChat("supergroup", "model")).toBe(true);
    expect(consumeOutsidePrivateChat("supergroup", "switch")).toBe(true);
    expect(consumeOutsidePrivateChat("supergroup", "thinking")).toBe(true);
    expect(consumeOutsidePrivateChat("private", "spawn")).toBe(false);
    expect(consumeOutsidePrivateChat("supergroup", "not-a-bot-command")).toBe(false);
  });
});

describe("Telegram turn identity", () => {
  test("recovers the exact responder and topic from the injected envelope", () => {
    expect(
      parseTelegramPromptTarget(
        '<telegram-message chat_id="42" chat_type="private" from="Owner (42)" from_id="42" message_id="9" ts="2026-01-01T00:00:00.000Z" thread_id="7">\\nhello\\n</telegram-message>',
      ),
    ).toEqual({ responderId: "42", chatId: "42", chatType: "private", threadId: 7 });
    expect(parseTelegramPromptTarget('<telegram-message chat_id="42" chat_type="private">missing responder</telegram-message>')).toBeUndefined();
    expect(parseTelegramPromptTarget("normal local prompt")).toBeUndefined();
  });
});

describe("deleted topic recovery", () => {
  test("recognizes only Telegram's missing-thread response", () => {
    expect(isMissingThreadError(new TgError("Bad Request: message thread not found", 400))).toBe(true);
    expect(isMissingThreadError(new TgError("Bad Request: message thread not found", 429))).toBe(false);
    expect(isMissingThreadError(new TgError("Bad Request: chat not found", 400))).toBe(false);
    expect(isMissingThreadError(new Error("message thread not found"))).toBe(false);
  });
});

describe("stale topic auto-resume policy", () => {
  const access = { ...defaultAccess(), allowFrom: ["42"] };
  const ownerMessage: TgMessage = {
    message_id: 1,
    date: 1,
    from: { id: 42 },
    chat: { id: 42, type: "private" },
    is_topic_message: true,
    message_thread_id: 7,
    text: "continue",
  };
  const entry = {
    pid: 9,
    cwd: "/project",
    name: "project",
    claimedAt: 1,
    sessionId: "session-a",
    workspaceId: "w1",
    workspaceLabel: "project",
    workspaceTerminalIds: ["term-a"],
  };

  test("allows only normal messages from the paired owner DM with complete resume identity", () => {
    expect(canAutoResumeTopic(ownerMessage, access, entry)).toBe(true);
    expect(canAutoResumeTopic(ownerMessage, access, entry, "stop")).toBe(false);
    expect(canAutoResumeTopic({ ...ownerMessage, from: { id: 99 } }, access, entry)).toBe(false);
    expect(canAutoResumeTopic({ ...ownerMessage, chat: { id: -1001, type: "supergroup" } }, access, entry)).toBe(false);
    expect(canAutoResumeTopic(ownerMessage, access, { ...entry, workspaceTerminalIds: undefined })).toBe(false);
  });
});
