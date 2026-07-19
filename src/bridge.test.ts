import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultAccess, saveAccess, statePath } from "./access";
import { type Logger, type TgMessage, TgError } from "./api";
import { type BridgeHost, BOT_COMMANDS, PUBLIC_BOT_COMMANDS, handleUpdate, syncBotCommands } from "./bridge";
import { type TelegramCall, SpawnController } from "./control";
import { TelegramPromptController } from "./prompts";
import { loadRegistry, saveRegistry } from "./topics";

const previousStateDir = process.env.OMP_TELEGRAM_STATE_DIR;
let dir: string;
let calls: Array<{ method: string; payload: Record<string, unknown> }>;

const log: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omp-tg-bridge-"));
  process.env.OMP_TELEGRAM_STATE_DIR = dir;
  calls = [];
  saveAccess({ ...defaultAccess(), enabled: true, allowFrom: ["42"], topicsChat: "42", controlThreadId: 99 });
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.OMP_TELEGRAM_STATE_DIR;
  else process.env.OMP_TELEGRAM_STATE_DIR = previousStateDir;
  rmSync(dir, { recursive: true, force: true });
});

function makeHost(overrides: Partial<BridgeHost> = {}): BridgeHost {
  const callTelegram: TelegramCall = async <T>(method: string, payload: Record<string, unknown>): Promise<T> => {
    calls.push({ method, payload });
    return undefined!;
  };
  return {
    isDaemon: true,
    selfPid: process.pid + 1000,
    token: () => "token",
    botUsername: () => "omp_bot",
    botHasTopics: () => true,
    ownThreadId: () => undefined,
    callTelegram,
    warn: () => {},
    log,
    spawnController: new SpawnController({ getAccess: () => defaultAccess(), callTelegram, warn: () => {} }),
    promptController: new TelegramPromptController({ callTelegram, authorize: () => false }),
    ...overrides,
  };
}

function message(text: string, topic?: number): TgMessage {
  return {
    message_id: topic ?? 1,
    date: 1,
    from: { id: 42 },
    chat: { id: 42, type: "private" },
    text,
    ...(topic == null ? {} : { is_topic_message: true, message_thread_id: topic }),
  };
}

describe("shared bridge routing", () => {
  test("forwards a live foreign topic through the filesystem spool", async () => {
    saveRegistry({
      version: 1,
      chatId: "42",
      threads: { "7": { pid: process.pid, cwd: "/tmp/project", name: "project", claimedAt: 1 } },
    });

    await handleUpdate(makeHost(), { update_id: 1, message: message("hello", 7) });

    expect(readdirSync(statePath("route", "7"))).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  test("queues and starts resume for an unowned owner topic", async () => {
    saveRegistry({
      version: 1,
      chatId: "42",
      threads: {
        "8": {
          pid: 2_000_000_000,
          cwd: "/tmp/project",
          name: "project",
          claimedAt: 1,
          sessionFile: "/tmp/session.jsonl",
          workspaceId: "workspace-1",
          workspaceLabel: "project",
          workspaceTerminalIds: ["pane-1"],
        },
      },
    });
    const resumed: number[] = [];

    await handleUpdate(makeHost({ resumeTopic: async (_msg, threadId) => void resumed.push(threadId) }), {
      update_id: 2,
      message: message("continue", 8),
    });

    expect(resumed).toEqual([8]);
    expect(readdirSync(statePath("route", "8"))).toHaveLength(1);
  });

  test("redirects deliverable untopiced messages in daemon mode", async () => {
    await handleUpdate(makeHost(), { update_id: 3, message: message("hello") });

    expect(calls.at(-1)?.method).toBe("sendMessage");
    expect(calls.at(-1)?.payload.text).toContain("routes conversations through session topics");
  });

  test("handles global commands in the daemon", async () => {
    await handleUpdate(makeHost(), { update_id: 4, message: message("/whoami") });

    expect(calls.some((call) => String(call.payload.text).includes("user_id: 42"))).toBe(true);
  });

  test("guides session commands entered outside a session topic", async () => {
    await handleUpdate(makeHost(), { update_id: 5, message: message("/stop") });

    expect(calls.at(-1)?.payload.text).toBe("Run /stop inside a session topic.");
  });

  test("delivers edited commands as agent turns instead of executing them", async () => {
    const sessionCommands: string[] = [];
    const delivered: TgMessage[] = [];
    const host = makeHost({
      isDaemon: false,
      selfPid: process.pid,
      handleSessionCommand: async (_msg, parsed) => {
        sessionCommands.push(parsed.name);
        return true;
      },
      deliverLocal: async (msg) => void delivered.push(msg),
    });

    await handleUpdate(host, { update_id: 6, edited_message: message("/stop") });

    expect(sessionCommands).toEqual([]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].edited_flag).toBe(true);
  });
});

describe("cleanup command", () => {
  const seedStale = (chatId: string) =>
    saveRegistry({
      version: 1,
      chatId,
      threads: {
        "100": { pid: 999999, cwd: "/stale", name: "stale", claimedAt: 1 }, // dead pid → stale
        "101": { pid: process.pid, cwd: "/live", name: "live", claimedAt: 2 }, // alive → kept
        "99": { pid: 999999, cwd: "/ctl", name: "control", claimedAt: 3 }, // dead; excluded only in DM hosting (matches controlThreadId 99)
      },
    });

  test("bare /cleanup previews only stale topics and acts on nothing", async () => {
    seedStale("42");
    await handleUpdate(makeHost(), { update_id: 10, message: message("/cleanup") });
    const preview = calls.find((c) => String(c.payload.text ?? "").includes("Run /cleanup go"))?.payload.text as string;
    expect(preview).toContain("#100 stale — /stale");
    expect(preview).not.toContain("#101");
    expect(preview).not.toContain("#99");
    expect(calls.some((c) => c.method === "deleteForumTopic" || c.method === "closeForumTopic")).toBe(false);
    expect(Object.keys(loadRegistry().threads).sort()).toEqual(["100", "101", "99"]);
  });

  test("/cleanup go deletes stale DM topics and drops their registry entries", async () => {
    seedStale("42");
    await handleUpdate(makeHost(), { update_id: 11, message: message("/cleanup go") });
    expect(calls.filter((c) => c.method === "deleteForumTopic").map((c) => c.payload.message_thread_id)).toEqual([100]);
    expect(calls.some((c) => c.method === "closeForumTopic")).toBe(false);
    expect(Object.keys(loadRegistry().threads).sort()).toEqual(["101", "99"]);
    expect(calls.some((c) => String(c.payload.text ?? "").includes("🧹 deleted 1 stale topic"))).toBe(true);
  });

  test("/cleanup go closes stale group topics (control id is DM-scoped) and keeps entries", async () => {
    saveAccess({ ...defaultAccess(), enabled: true, allowFrom: ["42"], topicsChat: "-100200", controlThreadId: 99 });
    seedStale("-100200");
    await handleUpdate(makeHost(), { update_id: 12, message: message("/cleanup go") });
    // controlThreadId 99 is an owner-DM thread; in a group host it must NOT protect
    // the numerically-matching stale group topic, so both 99 and 100 are closed.
    expect(calls.filter((c) => c.method === "closeForumTopic").map((c) => c.payload.message_thread_id)).toEqual([99, 100]);
    expect(calls.some((c) => c.method === "deleteForumTopic")).toBe(false);
    expect(Object.keys(loadRegistry().threads).sort()).toEqual(["100", "101", "99"]); // group entries kept, parked
    expect(calls.some((c) => String(c.payload.text ?? "").includes("🧹 closed 2 stale topics"))).toBe(true);
  });

  test("/cleanup go treats an already-closed group topic as success (idempotent)", async () => {
    saveAccess({ ...defaultAccess(), enabled: true, allowFrom: ["42"], topicsChat: "-100200", controlThreadId: 5 });
    saveRegistry({ version: 1, chatId: "-100200", threads: { "100": { pid: 999999, cwd: "/stale", name: "stale", claimedAt: 1 } } });
    const host = makeHost({
      callTelegram: (async (method: string, payload: Record<string, unknown>) => {
        calls.push({ method, payload });
        if (method === "closeForumTopic") throw new TgError("Bad Request: TOPIC_NOT_MODIFIED", 400);
        return undefined!;
      }) as TelegramCall,
    });
    await handleUpdate(host, { update_id: 13, message: message("/cleanup go") });
    expect(calls.some((c) => c.method === "closeForumTopic")).toBe(true);
    expect(calls.some((c) => String(c.payload.text ?? "").includes("🧹 closed 1 stale topic"))).toBe(true);
    expect(calls.some((c) => String(c.payload.text ?? "").includes("failed"))).toBe(false);
    expect(Object.keys(loadRegistry().threads)).toEqual(["100"]); // parked entry kept
  });

  test("/cleanup go counts a non-idempotent close error as failed and keeps the entry", async () => {
    saveAccess({ ...defaultAccess(), enabled: true, allowFrom: ["42"], topicsChat: "-100200", controlThreadId: 5 });
    saveRegistry({ version: 1, chatId: "-100200", threads: { "100": { pid: 999999, cwd: "/stale", name: "stale", claimedAt: 1 } } });
    const host = makeHost({
      callTelegram: (async (method: string, payload: Record<string, unknown>) => {
        calls.push({ method, payload });
        if (method === "closeForumTopic") throw new TgError("Bad Request: CHAT_ADMIN_REQUIRED", 400);
        return undefined!;
      }) as TelegramCall,
    });
    await handleUpdate(host, { update_id: 14, message: message("/cleanup go") });
    expect(calls.some((c) => String(c.payload.text ?? "").includes("🧹 closed 0 stale topics (1 failed"))).toBe(true);
    expect(Object.keys(loadRegistry().threads)).toEqual(["100"]);
  });
});

describe("bot command surface", () => {
  const names = (menu: ReadonlyArray<{ command: string }>): string[] => menu.map((c) => c.command);
  const recorder = () => {
    const recorded: Array<{ method: string; payload: Record<string, unknown> }> = [];
    const call: TelegramCall = async <T>(method: string, payload: Record<string, unknown>): Promise<T> => {
      recorded.push({ method, payload });
      return undefined!;
    };
    return { recorded, call };
  };

  test("the full menu drops /switch and the public menu is the pairing essentials", () => {
    expect(names(BOT_COMMANDS)).toContain("model");
    expect(names(BOT_COMMANDS)).not.toContain("switch");
    expect(names(PUBLIC_BOT_COMMANDS)).toEqual(["start", "whoami"]);
    for (const cmd of names(PUBLIC_BOT_COMMANDS)) expect(names(BOT_COMMANDS)).toContain(cmd);
  });

  test("syncBotCommands scopes the minimal menu to everyone and the full menu to the owner", async () => {
    const { recorded, call } = recorder();
    await syncBotCommands(call, "42");
    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toEqual({ method: "setMyCommands", payload: { commands: PUBLIC_BOT_COMMANDS, scope: { type: "all_private_chats" } } });
    expect(recorded[1]).toEqual({ method: "setMyCommands", payload: { commands: BOT_COMMANDS, scope: { type: "chat", chat_id: 42 } } });
  });

  test("syncBotCommands skips the owner scope when unpaired", async () => {
    const { recorded, call } = recorder();
    await syncBotCommands(call, undefined);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].payload.scope).toEqual({ type: "all_private_chats" });
  });

  test("owner /help is derived from the table — renders session commands, drops /switch", async () => {
    await handleUpdate(makeHost(), { update_id: 20, message: message("/help") });
    const help = calls.find((c) => c.method === "sendMessage" && String(c.payload.text ?? "").includes("/model"))?.payload.text as string;
    expect(help).toContain("/spawn new <branch>");
    expect(help).toContain("/thinking [level]");
    expect(help).not.toContain("/switch");
  });
});
