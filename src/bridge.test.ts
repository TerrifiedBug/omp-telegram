import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultAccess, saveAccess, statePath } from "./access";
import type { Logger, TgMessage } from "./api";
import { type BridgeHost, handleUpdate } from "./bridge";
import { type TelegramCall, SpawnController } from "./control";
import { TelegramPromptController } from "./prompts";
import { saveRegistry } from "./topics";

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
});
