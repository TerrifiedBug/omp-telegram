import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultAccess, loadAccess, saveAccess } from "./access";
import { type Logger, TgError } from "./api";
import { availableTopicName, TOPIC_NAME_MAX, topicName, TopicNameSync } from "./topic-name";
import { loadRegistry, saveRegistry } from "./topics";

const previousStateDir = process.env.OMP_TELEGRAM_STATE_DIR;
let dir: string;
let sync: TopicNameSync;
let calls: Array<{ method: string; payload: Record<string, unknown> }>;
let warnings: string[];
let log: Logger;
const callTelegram = async (method: string, payload: Record<string, unknown>) => { calls.push({ method, payload }); };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omp-tg-topic-name-"));
  process.env.OMP_TELEGRAM_STATE_DIR = dir;
  sync = new TopicNameSync();
  calls = [];
  warnings = [];
  log = { debug: () => {}, info: () => {}, error: () => {}, warn: (text) => { warnings.push(text); } };
  saveRegistry({ version: 1, chatId: "42", threads: {
    "7": { pid: process.pid, cwd: "/project", name: "old", claimedAt: 1, sessionId: "session-a", sessionFile: "/session.jsonl" },
  } });
});
afterEach(() => {
  sync.stop();
  if (previousStateDir === undefined) delete process.env.OMP_TELEGRAM_STATE_DIR;
  else process.env.OMP_TELEGRAM_STATE_DIR = previousStateDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("topic name normalization", () => {
  test("uses the session name, collapses whitespace, and falls back for blank names", () => {
    expect(topicName("  session\n name  ", "project")).toBe("session name");
    expect(topicName("  ", "project")).toBe("project");
    expect(topicName(undefined, "project")).toBe("project");
  });
  test("prefers a word boundary after at least 20 code points", () => {
    expect(topicName("abcdefghijklmnopqrst hello world again", "")).toBe("abcdefghijklmnopqrst hello…");
    expect(topicName("short " + "x".repeat(40), "")).toBe("short " + "x".repeat(25) + "…");
  });
  test("caps CJK and single-code-point emoji without splitting them", () => {
    expect(topicName("中".repeat(40), "")).toBe("中".repeat(31) + "…");
    expect(topicName("😀".repeat(40), "")).toBe("😀".repeat(31) + "…");
  });
  test("preserves multi-code-point emoji graphemes", () => {
    const family = "👨‍👩‍👧‍👦";
    expect(topicName("a".repeat(28) + family + " more", "")).toBe("a".repeat(28) + "…");
    expect(topicName(family.repeat(6), "")).toBe(family.repeat(4) + "…");
  });
  test("leaves exactly 32 code points untouched", () => {
    expect(topicName("a".repeat(TOPIC_NAME_MAX), "")).toBe("a".repeat(TOPIC_NAME_MAX));
    expect(topicName("😀".repeat(TOPIC_NAME_MAX), "")).toBe("😀".repeat(TOPIC_NAME_MAX));
  });
});

describe("topic name synchronization", () => {
  test("renames a changed topic and preserves routing identities; unchanged names do not call Telegram", async () => {
    const topic = { threadId: 7, name: "old" };
    const before = loadRegistry().threads["7"];
    expect(await sync.check("42", topic, "new", callTelegram, log)).toBe(true);
    expect(calls).toEqual([{ method: "editForumTopic", payload: { chat_id: "42", message_thread_id: 7, name: "new" } }]);
    expect(loadRegistry().threads["7"]).toEqual({ ...before, name: "new" });
    expect(topic.name).toBe("new");
    expect(await sync.check("42", topic, "new", callTelegram, log)).toBe(true);
    expect(calls).toHaveLength(1);
  });
  test("treats TOPIC_NOT_MODIFIED as success", async () => {
    const topic = { threadId: 7, name: "old" };
    expect(await sync.check("42", topic, "new", async () => { throw new TgError("Bad Request: TOPIC_NOT_MODIFIED", 400); }, log)).toBe(true);
    expect(topic.name).toBe("new");
    expect(loadRegistry().threads["7"].name).toBe("new");
    expect(warnings).toEqual([]);
  });
  test("warns once and retries a failed name until success", async () => {
    const topic = { threadId: 7, name: "old" };
    const fail = async () => { throw new TgError("Bad Request: unavailable", 400); };
    expect(await sync.check("42", topic, "new", fail, log)).toBe(false);
    expect(await sync.check("42", topic, "new", fail, log)).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(loadRegistry().threads["7"].name).toBe("old");
    expect(await sync.check("42", topic, "new", callTelegram, log)).toBe(true);
    expect(topic.name).toBe("new");
  });
  test("suffixes a live collision inside the cap", async () => {
    const desired = "😀".repeat(32);
    const registry = loadRegistry();
    registry.threads["8"] = { pid: process.pid, cwd: "/other", name: desired, claimedAt: 1 };
    saveRegistry(registry);
    const expected = availableTopicName(desired, registry, 7);
    expect(expected.endsWith(`-${process.pid}`)).toBe(true);
    expect(Array.from(expected).length).toBeLessThanOrEqual(32);
    const topic = { threadId: 7, name: "old" };
    expect(await sync.check("42", topic, desired, callTelegram, log)).toBe(true);
    expect(topic.name).toBe(expected);
    expect(await sync.check("42", topic, desired, callTelegram, log)).toBe(true);
    expect(calls).toHaveLength(1);
  });
  test("never edits a thread owned by another process", async () => {
    expect(await sync.check("99", { threadId: 7, name: "old" }, "new", callTelegram, log)).toBe(false);
    expect(calls).toEqual([]);
  });
  test("space mode restores the legacy title once, then stops edits and the interval", async () => {
    const topic = { threadId: 7, name: "old" };
    sync.configure("session", () => {});
    expect(await sync.check("42", topic, "Session title", callTelegram, log)).toBe(true);
    sync.configure("space", () => {});
    expect(sync.running).toBe(false);
    const legacy = "legacy space name ".repeat(3).trim();
    expect(await sync.check("42", topic, legacy, callTelegram, log)).toBe(true);
    expect(topic.name).toBe(legacy);
    expect(await sync.check("42", topic, "later space name", callTelegram, log)).toBe(false);
    expect(calls).toHaveLength(2);
    sync.configure("session", () => {});
    expect(sync.running).toBe(true);
    expect(await sync.check("42", topic, "New session", callTelegram, log)).toBe(true);
    sync.configure("space", () => {});
    expect(await sync.check("42", topic, legacy, callTelegram, log)).toBe(true);
    expect(calls).toHaveLength(4);
    expect(sync.running).toBe(false);
  });
  test("a failed space restoration retries at the next check", async () => {
    const topic = { threadId: 7, name: "old" };
    sync.configure("space", () => {});
    expect(await sync.check("42", topic, "space", async () => { throw new TgError("unavailable", 400); }, log)).toBe(false);
    expect(await sync.check("42", topic, "space", callTelegram, log)).toBe(true);
    expect(topic.name).toBe("space");
    expect(sync.running).toBe(false);
  });
  test("persists both naming modes, defaulting to session", () => {
    saveAccess(defaultAccess());
    expect(loadAccess().topicsNames).toBe("session");
    for (const mode of ["space", "session"] as const) {
      saveAccess({ ...loadAccess(), topicsNames: mode });
      expect(loadAccess().topicsNames).toBe(mode);
    }
  });
});
