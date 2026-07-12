import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statePath } from "./access";
import type { TgMessage } from "./api";
import {
  ROUTED_TTL_MS,
  type ThreadEntry,
  type ThreadRegistry,
  claimThread,
  decideRoute,
  findAdoptableThread,
  isResumedOwner,
  loadRegistry,
  releaseThread,
  watchRoute,
  writeRouted,
} from "./topics";

const prev = process.env.OMP_TELEGRAM_STATE_DIR;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omp-tg-topics-"));
  process.env.OMP_TELEGRAM_STATE_DIR = dir;
});
afterEach(() => {
  if (prev === undefined) delete process.env.OMP_TELEGRAM_STATE_DIR;
  else process.env.OMP_TELEGRAM_STATE_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

const topicMsg = (over: Partial<TgMessage> = {}): TgMessage => ({
  message_id: 1,
  date: 0,
  chat: { id: 100, type: "supergroup" },
  is_topic_message: true,
  message_thread_id: 7,
  ...over,
});

describe("decideRoute", () => {
  const reg = (threads: Record<string, ThreadEntry>): ThreadRegistry => ({ version: 1, chatId: "100", threads });
  const alive = (): boolean => true;
  const dead = (): boolean => false;

  test("untopiced when topics mode is off", () => {
    expect(decideRoute(topicMsg(), undefined, reg({}), 1, alive).kind).toBe("untopiced");
  });
  test("untopiced when the chat is not the topics chat", () => {
    expect(decideRoute(topicMsg({ chat: { id: 999, type: "supergroup" } }), "100", reg({}), 1, alive).kind).toBe("untopiced");
  });
  test("untopiced when the message is not a topic message", () => {
    expect(decideRoute(topicMsg({ is_topic_message: false }), "100", reg({}), 1, alive).kind).toBe("untopiced");
  });
  test("untopiced when there is no thread id", () => {
    expect(decideRoute(topicMsg({ message_thread_id: undefined }), "100", reg({}), 1, alive).kind).toBe("untopiced");
  });
  test("unowned when no session has claimed the topic", () => {
    expect(decideRoute(topicMsg(), "100", reg({}), 1, alive)).toEqual({ kind: "unowned", threadId: 7 });
  });
  test("unowned when the claiming pid is dead", () => {
    const r = reg({ "7": { pid: 4242, cwd: "/x", name: "x", claimedAt: 0 } });
    expect(decideRoute(topicMsg(), "100", r, 1, dead)).toEqual({ kind: "unowned", threadId: 7 });
  });
  test("local when the topic is owned by this session", () => {
    const r = reg({ "7": { pid: 1, cwd: "/x", name: "x", claimedAt: 0 } });
    expect(decideRoute(topicMsg(), "100", r, 1, alive)).toEqual({ kind: "local" });
  });
  test("forward when a live foreign session owns the topic", () => {
    const r = reg({ "7": { pid: 999, cwd: "/x", name: "x", claimedAt: 0 } });
    expect(decideRoute(topicMsg(), "100", r, 1, alive)).toEqual({ kind: "forward", threadId: 7, pid: 999 });
  });
});

describe("registry", () => {
  test("claim then load round-trips chat and entry", () => {
    claimThread("100", 7, { pid: 1, cwd: "/proj", name: "proj", claimedAt: 123 });
    const r = loadRegistry();
    expect(r.chatId).toBe("100");
    expect(r.threads["7"]).toEqual({ pid: 1, cwd: "/proj", name: "proj", claimedAt: 123 });
  });

  test("release drops only the owner's entry", () => {
    claimThread("100", 7, { pid: 1, cwd: "/proj", name: "proj", claimedAt: 0 });
    releaseThread(7, 999); // not the owner — kept for adoption
    expect(loadRegistry().threads["7"]).toBeDefined();
    releaseThread(7, 1); // owner — removed
    expect(loadRegistry().threads["7"]).toBeUndefined();
  });



  test("a fresh session does not adopt another session's stale topic", () => {
    claimThread("100", 7, { pid: 1, cwd: "/proj", name: "old", claimedAt: 0, sessionId: "session-a" });
    expect(findAdoptableThread(loadRegistry(), "/proj", "session-b")).toBeUndefined();
  });

  test("an exact resumed session re-adopts its topic", () => {
    claimThread("100", 7, { pid: 1, cwd: "/old-path", name: "old", claimedAt: 0, sessionId: "session-a" });
    expect(findAdoptableThread(loadRegistry(), "/new-path", "session-a")?.[0]).toBe("7");
  });

  test("a resumed session re-adopts by session file when its runtime ID changes", () => {
    claimThread("100", 7, {
      pid: 1,
      cwd: "/proj",
      name: "old",
      claimedAt: 0,
      sessionId: "old-runtime-id",
      sessionFile: "/sessions/conversation.jsonl",
    });
    expect(findAdoptableThread(loadRegistry(), "/proj", "new-runtime-id", "/sessions/conversation.jsonl")?.[0]).toBe("7");
  });

  test("resume handoff accepts a new runtime ID for the same session file", () => {
    const previous = {
      pid: 1,
      cwd: "/proj",
      name: "old",
      claimedAt: 0,
      sessionId: "old-runtime-id",
      sessionFile: "/sessions/conversation.jsonl",
    };
    const owner = { ...previous, pid: 2, sessionId: "new-runtime-id" };
    expect(isResumedOwner(previous, owner, () => true)).toBe(true);
    expect(isResumedOwner(previous, { ...owner, sessionFile: "/sessions/other.jsonl" }, () => true)).toBe(false);
  });

  test("an identified fresh session does not adopt a same-cwd legacy claim", () => {
    claimThread("100", 7, { pid: 1, cwd: "/proj", name: "legacy", claimedAt: 0 });
    expect(findAdoptableThread(loadRegistry(), "/proj", "session-a")).toBeUndefined();
  });

  test("resumable session and herdr identity survive registry persistence", () => {
    const entry: ThreadEntry = {
      pid: 1,
      cwd: "/proj",
      name: "proj",
      claimedAt: 123,
      sessionId: "session-a",
      sessionFile: "/sessions/a.jsonl",
      workspaceId: "w1",
      workspaceLabel: "project",
      workspaceTerminalIds: ["term-a"],
    };
    claimThread("100", 7, entry);
    expect(loadRegistry().threads["7"]).toEqual(entry);
  });

  test("a corrupt threads.json is moved aside and reloads empty", () => {
    writeFileSync(statePath("threads.json"), "{not json");
    expect(loadRegistry().threads).toEqual({});
    const aside = readdirSync(statePath()).filter((f) => f.startsWith("threads.json.corrupt-"));
    expect(aside).toHaveLength(1);
  });
});

describe("writeRouted / watchRoute", () => {
  const routed = (id: number): TgMessage => ({ message_id: id, date: 0, chat: { id: 100, type: "supergroup" }, text: "hi", is_topic_message: true, message_thread_id: 7 });

  test("a spooled payload is delivered by the initial scan and consumed", () => {
    writeRouted(7, routed(42));
    const got: TgMessage[] = [];
    const dispose = watchRoute(7, (m) => got.push(m));
    dispose();
    expect(got).toHaveLength(1);
    expect(got[0].message_id).toBe(42);
    expect(got[0].text).toBe("hi");
    expect(readdirSync(statePath("route", "7"))).toHaveLength(0);
  });

  test("a TTL-expired payload is discarded, not delivered", () => {
    writeRouted(7, routed(43));
    const spool = statePath("route", "7");
    const file = join(spool, readdirSync(spool)[0]);
    const old = (Date.now() - ROUTED_TTL_MS - 60_000) / 1000;
    utimesSync(file, old, old);
    const got: TgMessage[] = [];
    const dispose = watchRoute(7, (m) => got.push(m));
    dispose();
    expect(got).toHaveLength(0);
    expect(readdirSync(spool)).toHaveLength(0);
  });

  test("tmp- files are ignored and left in place", () => {
    const spool = statePath("route", "7");
    mkdirSync(spool, { recursive: true });
    writeFileSync(join(spool, "tmp-999-1.json"), JSON.stringify(routed(1)));
    const got: TgMessage[] = [];
    const dispose = watchRoute(7, (m) => got.push(m));
    dispose();
    expect(got).toHaveLength(0);
    expect(readdirSync(spool)).toContain("tmp-999-1.json");
  });
});
