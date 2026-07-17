import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultAccess } from "./access";
import type { TgCallbackQuery, TgMessage } from "./api";
import { type ControlSpace, type RunHerdr, type TelegramCall, SpawnController, createWorktreeOmp, findSessionSpace, formatSessions, listControlSpaces, resumeOmp, sendCommandMessage, spawnOmp, validWorktreeBranch, workspaceDirectoryError } from "./control";
import type { ThreadRegistry } from "./topics";

const workspaceList = (items: unknown[]): string => JSON.stringify({ result: { workspaces: items } });
const paneList = (items: unknown[]): string => JSON.stringify({ result: { panes: items } });

function snapshotRunner(calls: string[] = []): RunHerdr {
  return async (args) => {
    const command = args.join(" ");
    calls.push(command);
    if (command === "workspace list") {
      return workspaceList([
        { workspace_id: "w2", label: "idle-space", agent_status: "unknown" },
        { workspace_id: "w1", label: "active-space", agent_status: "working" },
      ]);
    }
    if (command === "pane list") {
      return paneList([
        { workspace_id: "w1", agent: "omp", agent_status: "working", cwd: "/active", terminal_id: "term-a" },
        { workspace_id: "w1", agent: "omp", agent_status: "idle", cwd: "/active/second", terminal_id: "term-b" },
        { workspace_id: "w2", agent_status: "unknown", cwd: "/idle", terminal_id: "term-c" },
      ]);
    }
    throw new Error(`unexpected command: ${command}`);
  };
}

const activeSpace: ControlSpace = {
  workspaceId: "w1",
  label: "active-space",
  ompCwds: ["/active", "/active/second"],
  terminalIds: ["term-a", "term-b"],
  status: "working",
  ompCount: 2,
  ompStatuses: ["working", "idle"],
};

describe("listControlSpaces", () => {
  test("lists open workspaces with omp counts and active spaces first", async () => {
    expect(await listControlSpaces(snapshotRunner())).toEqual([
      activeSpace,
      {
        workspaceId: "w2",
        label: "idle-space",
        ompCwds: [],
        terminalIds: ["term-c"],
        status: "unknown",
        ompCount: 0,
        ompStatuses: [],
      },
    ]);
  });

  test("rejects malformed herdr JSON", async () => {
    const run: RunHerdr = async (args) => (args[0] === "workspace" ? "not-json" : paneList([]));
    await expect(listControlSpaces(run)).rejects.toThrow("invalid JSON");
  });
});

describe("findSessionSpace", () => {
  test("locates the hosting space by exact herdr agent session path", async () => {
    const run: RunHerdr = async (args) => {
      const command = args.join(" ");
      if (command === "workspace list") {
        return workspaceList([{ workspace_id: "w1", label: "active-space", agent_status: "working" }]);
      }
      if (command === "pane list") {
        return paneList([
          {
            workspace_id: "w1",
            agent: "omp",
            agent_status: "working",
            cwd: "/active",
            terminal_id: "term-a",
            agent_session: { kind: "path", value: "/sessions/exact.jsonl" },
          },
        ]);
      }
      throw new Error(`unexpected command: ${command}`);
    };

    expect(await findSessionSpace("/sessions/exact.jsonl", run)).toEqual({
      workspaceId: "w1",
      label: "active-space",
      ompCwds: ["/active"],
      terminalIds: ["term-a"],
      status: "working",
      ompCount: 1,
      ompStatuses: ["working"],
    });
    expect(await findSessionSpace("/sessions/other.jsonl", run)).toBeUndefined();
  });
});

describe("spawnOmp", () => {
  test("revalidates the space and supports herdr snapshots without terminal ids", async () => {
    const calls: string[] = [];
    const base = snapshotRunner(calls);
    const run: RunHerdr = async (args) => {
      const command = args.join(" ");
      if (command === "tab create --workspace w1 --label omp --no-focus") {
        calls.push(command);
        return JSON.stringify({ result: { tab: { tab_id: "w1:t3" }, root_pane: { pane_id: "w1:p3" } } });
      }
      if (command === "pane run w1:p3 omp") {
        calls.push(command);
        return "";
      }
      return base(args);
    };

    await expect(spawnOmp({ ...activeSpace, terminalIds: [] }, run)).resolves.toEqual({ paneId: "w1:p3" });
    expect(calls).toContain("tab create --workspace w1 --label omp --no-focus");
    expect(calls).toContain("pane run w1:p3 omp");
  });

  test("refuses a stale picker selection before creating a tab", async () => {
    const calls: string[] = [];
    await expect(spawnOmp({ ...activeSpace, label: "old-name" }, snapshotRunner(calls))).rejects.toThrow("changed or closed");
    expect(calls.some((command) => command.startsWith("tab create"))).toBe(false);
  });

  test("rejects a compacted workspace id that now points at different terminals", async () => {
    const calls: string[] = [];
    await expect(
      spawnOmp({ ...activeSpace, terminalIds: ["term-from-closed-space"] }, snapshotRunner(calls)),
    ).rejects.toThrow("changed or closed");
    expect(calls.some((command) => command.startsWith("tab create"))).toBe(false);
  });

  test("closes the newly created tab when omp cannot start", async () => {
    const calls: string[] = [];
    const base = snapshotRunner(calls);
    const run: RunHerdr = async (args) => {
      const command = args.join(" ");
      calls.push(command);
      if (command.startsWith("tab create")) {
        return JSON.stringify({ result: { tab: { tab_id: "w1:t3" }, root_pane: { pane_id: "w1:p3" } } });
      }
      if (command === "pane run w1:p3 omp") throw new Error("run failed");
      if (command === "tab close w1:t3") return "";
      calls.pop();
      return base(args);
    };

    await expect(spawnOmp(activeSpace, run)).rejects.toThrow("run failed");
    expect(calls).toContain("tab close w1:t3");
  });
});

describe("new herdr destinations", () => {
  test("validates worktree branch names and local workspace directories", () => {
    expect(validWorktreeBranch("tg/smoke-2026.07")).toBe(true);
    expect(validWorktreeBranch("-bad")).toBe(false);
    expect(validWorktreeBranch("bad branch")).toBe(false);
    expect(validWorktreeBranch("a".repeat(101))).toBe(false);
    expect(workspaceDirectoryError("relative/path")).toContain("absolute");
    const dir = mkdtempSync(join(tmpdir(), "omp-tg-workspace-"));
    try {
      expect(workspaceDirectoryError(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("finds the created worktree root pane when create omits it", async () => {
    const calls: string[] = [];
    let workspaceLists = 0;
    let paneLists = 0;
    const run: RunHerdr = async (args) => {
      const command = args.join(" ");
      calls.push(command);
      if (command === "workspace list") {
        workspaceLists++;
        return workspaceLists === 1
          ? workspaceList([{ workspace_id: "w1", label: "active-space", agent_status: "working" }])
          : workspaceList([
              { workspace_id: "w1", label: "active-space", agent_status: "working" },
              { workspace_id: "w2", label: "tg-smoke", agent_status: "unknown" },
            ]);
      }
      if (command === "pane list") {
        paneLists++;
        return paneLists === 1
          ? paneList([{ workspace_id: "w1", terminal_id: "term-a", agent_status: "working" }])
          : paneList([{ workspace_id: "w2", pane_id: "w2:p1", terminal_id: "term-b", agent_status: "unknown" }]);
      }
      if (command === "worktree create --workspace w1 --branch tg/smoke --no-focus --json") {
        return JSON.stringify({ result: {} });
      }
      if (command === "pane run w2:p1 omp") return "";
      throw new Error(`unexpected command: ${command}`);
    };

    await expect(createWorktreeOmp({ ...activeSpace, ompCount: 0, terminalIds: ["term-a"] }, "tg/smoke", run)).resolves.toEqual({
      paneId: "w2:p1",
    });
    expect(calls).toContain("pane run w2:p1 omp");
  });
});

describe("resumeOmp", () => {
  const entry = {
    pid: 9,
    cwd: "/work/acme's repo",
    name: "acme",
    claimedAt: 1,
    sessionId: "session-id",
    sessionFile: "/sessions/my run.jsonl",
    workspaceId: "w1",
    workspaceLabel: "active-space",
    workspaceTerminalIds: ["term-a"],
  };

  test("revalidates the saved space and resumes the exact session with shell-safe paths", async () => {
    const calls: string[] = [];
    const base = snapshotRunner(calls);
    const expected = `pane run w1:p3 omp --cwd '/work/acme'"'"'s repo' --resume '/sessions/my run.jsonl'`;
    const run: RunHerdr = async (args) => {
      const command = args.join(" ");
      if (command === "tab create --workspace w1 --label omp --no-focus") {
        calls.push(command);
        return JSON.stringify({ result: { tab: { tab_id: "w1:t3" }, root_pane: { pane_id: "w1:p3" } } });
      }
      if (command === expected) {
        calls.push(command);
        return "";
      }
      return base(args);
    };

    await expect(resumeOmp(entry, run)).resolves.toEqual({ paneId: "w1:p3" });
    expect(calls).toContain(expected);
  });

  test("refuses missing resume metadata and a reused herdr space", async () => {
    const calls: string[] = [];
    await expect(resumeOmp({ pid: 1, cwd: "/x", name: "x", claimedAt: 0 }, snapshotRunner(calls))).rejects.toThrow(
      "no saved omp session identity",
    );
    await expect(
      resumeOmp({ ...entry, workspaceTerminalIds: ["terminal-from-closed-space"] }, snapshotRunner(calls)),
    ).rejects.toThrow("changed or closed");
    expect(calls.some((command) => command.startsWith("tab create"))).toBe(false);
  });
});

describe("formatSessions", () => {
  test("shows attached, unattached, and outside-herdr topic owners", () => {
    const spaces: ControlSpace[] = [
      { ...activeSpace, ompCount: 1, ompStatuses: ["idle"], ompCwds: ["/active"] },
      { workspaceId: "w2", label: "gitops", ompCwds: ["/gitops"], terminalIds: ["term-g"], status: "idle", ompCount: 1, ompStatuses: ["idle"] },
    ];
    const registry: ThreadRegistry = {
      version: 1,
      chatId: "42",
      threads: {
        "10": { pid: 1, cwd: "/active", name: "active-space", claimedAt: 1 },
        "11": { pid: 2, cwd: "/dead", name: "dead", claimedAt: 1 },
        "12": { pid: 3, cwd: "/outside", name: "outside", claimedAt: 1 },
      },
    };

    const text = formatSessions(spaces, registry, (pid) => pid !== 2);
    expect(text).toContain("active-space — 1 omp (idle), 1 topic");
    expect(text).toContain("[unattached] gitops — 1 omp (idle), no Telegram topic");
    expect(text).toContain("[outside herdr] outside — live topic owner pid 3");
    expect(text).toContain("[stale topic] dead — thread 11, no live owner");
  });
});

describe("sendCommandMessage", () => {
  const msg: TgMessage = {
    message_id: 7,
    date: 1,
    from: { id: 42 },
    chat: { id: 42, type: "private" },
    is_topic_message: true,
    message_thread_id: 3061,
  };
  const access = { ...defaultAccess(), allowFrom: ["42"], topicsChat: "42", controlThreadId: 900 };

  test("routes global output to omp control and leaves an origin notice", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const callTelegram: TelegramCall = async <T>(_method: string, payload: Record<string, unknown>) => {
      calls.push(payload);
      return { ...msg, message_id: calls.length } as T;
    };
    await sendCommandMessage({ access, callTelegram, msg, text: "sessions" });
    expect(calls).toEqual([
      { chat_id: "42", message_thread_id: 900, text: "sessions" },
      { chat_id: "42", message_thread_id: 3061, text: 'Handled in the "omp control" topic.' },
    ]);
  });

  test("does not redirect when already inside omp control", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const callTelegram: TelegramCall = async <T>(_method: string, payload: Record<string, unknown>) => {
      calls.push(payload);
      return { ...msg, message_id: 1 } as T;
    };
    await sendCommandMessage({ access, callTelegram, msg: { ...msg, message_thread_id: 900 }, text: "status" });
    expect(calls).toEqual([{ chat_id: "42", message_thread_id: 900, text: "status" }]);
  });

  test("falls back to the originating topic when the control topic rejects", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const callTelegram: TelegramCall = async <T>(_method: string, payload: Record<string, unknown>) => {
      calls.push(payload);
      if (payload.message_thread_id === 900) throw new Error("thread missing");
      return { ...msg, message_id: calls.length } as T;
    };
    await expect(sendCommandMessage({ access, callTelegram, msg, text: "sessions" })).resolves.toBeDefined();
    expect(calls).toEqual([
      { chat_id: "42", message_thread_id: 900, text: "sessions" },
      { chat_id: "42", message_thread_id: 3061, text: "sessions" },
    ]);
  });

  test("keeps topic-local commands in their originating session", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const callTelegram: TelegramCall = async <T>(_method: string, payload: Record<string, unknown>) => {
      calls.push(payload);
      return { ...msg, message_id: 1 } as T;
    };
    await sendCommandMessage({ access, callTelegram, msg, text: "Stopped.", useControlTopic: false });
    expect(calls).toEqual([{ chat_id: "42", message_thread_id: 3061, text: "Stopped." }]);
  });
});

describe("SpawnController", () => {
  const ownerAccess = { ...defaultAccess(), allowFrom: ["42"] };
  const ownerMessage: TgMessage = {
    message_id: 7,
    date: 1,
    from: { id: 42, first_name: "Owner" },
    chat: { id: 42, type: "private" },
    text: "/spawn active-space",
  };

  function telegramRecorder(calls: Array<{ method: string; payload: Record<string, unknown> }>): TelegramCall {
    return async <T>(method: string, payload: Record<string, unknown>): Promise<T> => {
      calls.push({ method, payload });
      if (method === "sendMessage") return { ...ownerMessage, message_id: 100 } as T;
      return true as T;
    };
  }

  test("rejects another user and a stale picker message", async () => {
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    let spawnCount = 0;
    const controller = new SpawnController({
      getAccess: () => ownerAccess,
      callTelegram: telegramRecorder(calls),
      listSpaces: async () => [activeSpace],
      spawn: async () => {
        spawnCount += 1;
        return { paneId: "w1:p3" };
      },
      nonce: () => "secure",
      now: () => 1_000,
    });
    await controller.start(ownerMessage, "active-space");

    const foreign: TgCallbackQuery = {
      id: "foreign",
      from: { id: 99 },
      message: { message_id: 100, chat: ownerMessage.chat },
      data: "sp:y:secure",
    };
    const stale: TgCallbackQuery = {
      id: "stale",
      from: ownerMessage.from!,
      message: { message_id: 101, chat: ownerMessage.chat },
      data: "sp:y:secure",
    };
    expect(await controller.handleCallback(foreign)).toBe(true);
    expect(await controller.handleCallback(stale)).toBe(true);
    expect(spawnCount).toBe(0);
    expect(calls.filter((call) => call.method === "answerCallbackQuery")).toHaveLength(2);
    expect(calls.some((call) => call.payload.text === "This control is restricted to the paired owner.")).toBe(true);
    expect(calls.some((call) => call.payload.text === "This picker expired. Run /spawn again.")).toBe(true);
  });

  test("answers, consumes, and spawns exactly once under callback redelivery", async () => {
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    let spawnCount = 0;
    let controller: SpawnController;
    const confirmation: TgCallbackQuery = {
      id: "confirm",
      from: ownerMessage.from!,
      message: { message_id: 100, chat: ownerMessage.chat },
      data: "sp:y:once",
    };
    controller = new SpawnController({
      getAccess: () => ownerAccess,
      callTelegram: telegramRecorder(calls),
      listSpaces: async () => [activeSpace],
      spawn: async () => {
        spawnCount += 1;
        calls.push({ method: "spawn", payload: {} });
        await controller.handleCallback({ ...confirmation, id: "duplicate-during-spawn" });
        return { paneId: "w1:p3" };
      },
      nonce: () => "once",
      now: () => 1_000,
    });
    await controller.start(ownerMessage, "active-space");
    expect(await controller.handleCallback(confirmation)).toBe(true);
    expect(await controller.handleCallback({ ...confirmation, id: "duplicate-after-spawn" })).toBe(true);

    expect(spawnCount).toBe(1);
    const methods = calls.map((call) => call.method);
    expect(methods.indexOf("answerCallbackQuery")).toBeLessThan(methods.indexOf("spawn"));
    expect(calls.filter((call) => call.method === "spawn")).toHaveLength(1);
    expect(calls.filter((call) => call.payload.text === "This picker expired. Run /spawn again.")).toHaveLength(2);
  });


  test("consumes a worktree confirmation before creating it", async () => {
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    const created: Array<{ space: string; branch: string }> = [];
    const controller = new SpawnController({
      getAccess: () => ownerAccess,
      callTelegram: telegramRecorder(calls),
      listSpaces: async () => [activeSpace],
      createWorktree: async (space, branch) => {
        created.push({ space: space.workspaceId, branch });
        return { paneId: "w2:p1" };
      },
      nonce: () => "worktree",
      now: () => 1_000,
    });
    const confirmation: TgCallbackQuery = {
      id: "worktree-confirm",
      from: ownerMessage.from!,
      message: { message_id: 100, chat: ownerMessage.chat },
      data: "sp:y:worktree",
    };

    await controller.start(ownerMessage, "new tg/smoke active-space");
    expect(await controller.handleCallback(confirmation)).toBe(true);
    expect(await controller.handleCallback({ ...confirmation, id: "worktree-duplicate" })).toBe(true);

    expect(created).toEqual([{ space: "w1", branch: "tg/smoke" }]);
    expect(calls.some((call) => call.payload.text === "Create worktree tg/smoke from active-space and start omp?")).toBe(true);
    expect(calls.some((call) => String(call.payload.text).includes("Started omp in new worktree tg/smoke (w2:p1)"))).toBe(true);
  });

  test("rejects invalid branches and non-absolute directory targets before listing spaces", async () => {
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    let listed = 0;
    const controller = new SpawnController({
      getAccess: () => ownerAccess,
      callTelegram: telegramRecorder(calls),
      listSpaces: async () => {
        listed++;
        return [activeSpace];
      },
    });

    await controller.start(ownerMessage, "new -bad");
    await controller.start(ownerMessage, "dir relative/path");

    expect(listed).toBe(0);
    expect(calls.some((call) => call.payload.text === "usage: /spawn new <branch> [space-label]")).toBe(true);
    expect(calls.some((call) => String(call.payload.text).includes("usage: /spawn dir <absolute-path>"))).toBe(true);
  });
  test("does not open a picker outside the owner's private DM", async () => {
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    const controller = new SpawnController({
      getAccess: () => ownerAccess,
      callTelegram: telegramRecorder(calls),
      listSpaces: async () => [activeSpace],
    });
    await controller.start({ ...ownerMessage, chat: { id: -1001, type: "supergroup" } }, "");
    expect(calls).toEqual([]);
  });
});
