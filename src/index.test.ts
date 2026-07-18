import { describe, expect, test } from "bun:test";
import { defaultAccess } from "./access";
import { isMissingThreadError, TgError, type TgMessage } from "./api";
import { canAutoResumeTopic, consumeOutsidePrivateChat } from "./bridge";
import { approvalPingTarget, collectDoctorReport, isTaskSubagent, parseTelegramPromptTarget, substituteFileArg, transcribeVoice } from "./index";

describe("Telegram bot command scope", () => {
  test("known commands are consumed outside private chats instead of reaching omp", () => {
    expect(consumeOutsidePrivateChat("supergroup", "spawn")).toBe(true);
    expect(consumeOutsidePrivateChat("group", "sessions")).toBe(true);
    expect(consumeOutsidePrivateChat("supergroup", "stop")).toBe(true);
    expect(consumeOutsidePrivateChat("supergroup", "compact")).toBe(true);
    expect(consumeOutsidePrivateChat("supergroup", "model")).toBe(true);
    expect(consumeOutsidePrivateChat("supergroup", "switch")).toBe(true);
    expect(consumeOutsidePrivateChat("supergroup", "thinking")).toBe(true);
    expect(consumeOutsidePrivateChat("supergroup", "cleanup")).toBe(true);
    expect(consumeOutsidePrivateChat("private", "spawn")).toBe(false);
    expect(consumeOutsidePrivateChat("supergroup", "not-a-bot-command")).toBe(false);
  });
});

describe("Telegram session ownership", () => {
  test("does not attach the bridge to task subagents", () => {
    expect(isTaskSubagent(false, ["read", "yield"])).toBe(true);
    expect(isTaskSubagent(true, ["read", "yield"])).toBe(false);
    expect(isTaskSubagent(false, ["read"])).toBe(false);
  });
});

describe("approval ping targeting", () => {
  const active = { chatId: "42", threadId: 7 };
  const away = { chatId: "99" };

  test("prefers the active Telegram conversation and otherwise uses the away target", () => {
    expect(approvalPingTarget(true, active, away)).toEqual(active);
    expect(approvalPingTarget(false, active, away)).toEqual(away);
    expect(approvalPingTarget(true, undefined, away)).toBeUndefined();
    expect(approvalPingTarget(false, undefined, undefined)).toBeUndefined();
  });
});

describe("voice transcription", () => {
  test("substitutes every file placeholder in argv", () => {
    expect(substituteFileArg(["transcribe", "--input={file}", "{file}"], "/tmp/voice note.ogg")).toEqual([
      "transcribe",
      "--input=/tmp/voice note.ogg",
      "/tmp/voice note.ogg",
    ]);
  });

  test("executes argv directly and returns visible success or failure text", async () => {
    await expect(transcribeVoice(["/bin/echo", "{file}", "$(echo injected)"], "/tmp/voice note.ogg")).resolves.toBe(
      "[Voice transcript: /tmp/voice note.ogg $(echo injected)]",
    );
    await expect(transcribeVoice(["missing", "{file}"], "/tmp/note.ogg", async () => {
      throw new Error("transcriber offline");
    })).resolves.toBe("[Voice transcription failed: transcriber offline]");
  });
});

describe("Telegram doctor", () => {
  test("reports degraded checks without hiding later sections", async () => {
    const report = await collectDoctorReport([
      { label: "Token", run: async () => { throw new Error("offline"); } },
      { label: "Daemon", run: () => "Daemon: pid 42 · dead" },
      { label: "Herdr", run: () => { throw new Error("not installed"); } },
      { label: "Inbox", run: () => "Inbox: 3 files · 99 bytes" },
    ]);

    expect(report).toEqual([
      "Telegram doctor",
      "Token: probe failed: offline",
      "Daemon: pid 42 · dead",
      "Herdr: probe failed: not installed",
      "Inbox: 3 files · 99 bytes",
    ]);
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
