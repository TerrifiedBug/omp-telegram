import { describe, expect, test } from "bun:test";
import { defaultAccess } from "./access";
import { isMissingThreadError, TgError, type TgMessage } from "./api";
import { canAutoResumeTopic, consumeOutsidePrivateChat } from "./bridge";
import { approvalPingTarget, collectDoctorReport, isTaskSubagent, parseTelegramPromptTarget, substituteFileArg, telegramArgumentCompletions, transcribeVoice } from "./index";

describe("Telegram bot command scope", () => {
  test("known commands are consumed outside private chats instead of reaching omp", () => {
    expect(consumeOutsidePrivateChat("supergroup", "spawn")).toBe(true);
    expect(consumeOutsidePrivateChat("group", "sessions")).toBe(true);
    expect(consumeOutsidePrivateChat("supergroup", "stop")).toBe(true);
    expect(consumeOutsidePrivateChat("supergroup", "compact")).toBe(true);
    expect(consumeOutsidePrivateChat("supergroup", "model")).toBe(true);
    expect(consumeOutsidePrivateChat("supergroup", "switch")).toBe(false); // /switch was folded into /model
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
  test("recognizes a gone topic from both supergroup and DM-mode wordings", () => {
    expect(isMissingThreadError(new TgError("Bad Request: message thread not found", 400))).toBe(true);
    // DM forum-topic mode reports a gone/nonexistent topic as TOPIC_ID_INVALID.
    expect(isMissingThreadError(new TgError("Bad Request: TOPIC_ID_INVALID", 400))).toBe(true);
    expect(isMissingThreadError(new TgError("Bad Request: message thread not found", 429))).toBe(false);
    expect(isMissingThreadError(new TgError("Bad Request: TOPIC_ID_INVALID", 429))).toBe(false);
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

describe("/telegram argument completions", () => {
  type Dynamic = { pending: () => string[]; owners: () => string[]; groups: () => string[] };
  const labels = (prefix: string, dynamic?: Partial<Dynamic>) =>
    (telegramArgumentCompletions(prefix, { pending: () => [], owners: () => [], groups: () => [], ...dynamic }) ?? []).map((item) => item.label);
  const values = (prefix: string) => (telegramArgumentCompletions(prefix) ?? []).map((item) => item.value);

  test("offers every subcommand at the top level with descriptions", () => {
    const items = telegramArgumentCompletions("") ?? [];
    expect(items.map((i) => i.label)).toEqual([
      "status", "doctor", "daemon", "token", "on", "off", "pair", "deny",
      "allow", "remove", "policy", "group", "set", "notify", "topics",
    ]);
    expect(items.find((i) => i.label === "topics")?.description).toBe("per-project session topics");
  });

  test("filters the top level by the typed fragment", () => {
    expect(labels("to")).toEqual(["token", "topics"]);
    expect(telegramArgumentCompletions("TO")).toBeNull(); // case-sensitive, like the handler switch
  });

  test("completes nested subcommands past the first token", () => {
    expect(labels("topics ")).toEqual(["on", "off", "status", "tidy"]);
    expect(labels("topics ti")).toEqual(["tidy"]);
    expect(labels("topics tidy ")).toEqual(["on", "off", "status"]);
    expect(labels("daemon ")).toEqual(["status", "restart", "stop"]);
    expect(labels("policy ")).toEqual(["pairing", "allowlist", "disabled"]);
    expect(labels("notify ")).toEqual(["off", "away", "always", "status", "clear"]);
  });

  test("completes set keys and their enum values", () => {
    expect(labels("set ")).toContain("replyToMode");
    const setKey = (telegramArgumentCompletions("set ") ?? []).find((i) => i.label === "replyToMode");
    expect(setKey?.description).toBe("thread replies: off | first | all");
    expect(labels("set replyToMode ")).toEqual(["off", "first", "all"]);
    expect(labels("set chunkMode ")).toEqual(["length", "newline"]);
    expect(labels("set streaming ")).toEqual(["true", "false"]);
  });

  test("value replaces the whole argument so nested picks round-trip", () => {
    expect(values("topics ti")).toEqual(["topics tidy "]);
    expect(values("topics tidy of")).toEqual(["topics tidy off "]); // "of" matches only off (on also starts with "o")
    expect(values("se")).toEqual(["set "]);
  });

  test("returns null where the position takes a free-form value", () => {
    expect(telegramArgumentCompletions("token ")).toBeNull(); // bot token
    expect(telegramArgumentCompletions("notify 123")).toBeNull(); // chat id
    expect(telegramArgumentCompletions("topics -100200")).toBeNull(); // chat id
    expect(telegramArgumentCompletions("bogus ")).toBeNull(); // unknown subcommand
    expect(telegramArgumentCompletions("daemon status extra")).toBeNull(); // past a terminal
  });

  test("completes free-form single-argument subcommands from live state", () => {
    const dynamic = { pending: () => ["ab12", "cd34"], owners: () => ["42", "77"] };
    expect(labels("pair ", dynamic)).toEqual(["ab12", "cd34"]);
    expect(labels("pair c", dynamic)).toEqual(["cd34"]);
    expect(labels("deny ", dynamic)).toEqual(["ab12", "cd34"]);
    expect(labels("remove ", dynamic)).toEqual(["42", "77"]);
    expect(telegramArgumentCompletions("pair ")).toBeNull(); // no dynamic source → nothing to suggest
  });

  test("completes the group grammar: subcommands, rm ids, and add flags", () => {
    const dynamic = { groups: () => ["-100200", "-100300"] };
    expect(labels("group ")).toEqual(["add", "rm"]);
    expect(labels("group rm ", dynamic)).toEqual(["-100200", "-100300"]);
    expect(labels("group rm -1003", dynamic)).toEqual(["-100300"]);
    expect(telegramArgumentCompletions("group add ")).toBeNull(); // the new chat id is free-form
    expect(labels("group add -100200 ")).toEqual(["--no-mention", "--allow"]);
    expect(labels("group add -100200 --no-mention ")).toEqual(["--allow"]); // a used flag drops out
    expect(telegramArgumentCompletions("group add -100200 --allow ")).toBeNull(); // the flag value is free-form
  });
});
