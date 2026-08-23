import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultAccess, saveAccess, statePath } from "./access";
import { daemonDisableReason, ensureDaemon, type EnsureDaemonOptions, readDaemonState, resolveRuntime } from "./daemon";

const previousStateDir = process.env.OMP_TELEGRAM_STATE_DIR;
const previousToken = process.env.TELEGRAM_BOT_TOKEN;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omp-tg-daemon-"));
  process.env.OMP_TELEGRAM_STATE_DIR = dir;
  delete process.env.TELEGRAM_BOT_TOKEN;
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.OMP_TELEGRAM_STATE_DIR;
  else process.env.OMP_TELEGRAM_STATE_DIR = previousStateDir;
  if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = previousToken;
  rmSync(dir, { recursive: true, force: true });
});

describe("daemon gating", () => {
  const enabled = { ...defaultAccess(), enabled: true, topicsChat: "42" };

  test("requires autostart, topics, no groups, and a token", () => {
    expect(daemonDisableReason(enabled, "token")).toBeUndefined();
    expect(daemonDisableReason({ ...enabled, enabled: false }, "token")).toBe("bridge disabled");
    expect(daemonDisableReason({ ...enabled, topicsChat: undefined }, "token")).toBe("topics off");
    expect(daemonDisableReason({ ...enabled, groups: { "-1": { requireMention: true, allowFrom: [] } } }, "token")).toBe("groups configured");
    expect(daemonDisableReason(enabled, "")).toBe("bot token missing");
  });
});

describe("daemon upgrades", () => {
  test("stops an old live version before spawning the current version", () => {
    saveAccess({ ...defaultAccess(), enabled: true, topicsChat: "42" });
    process.env.TELEGRAM_BOT_TOKEN = "token";
    writeFileSync(statePath("daemon.json"), JSON.stringify({ pid: 9876, version: "0.1.1", startedAt: 1 }));
    let running = true;
    const killed: Array<[number, NodeJS.Signals]> = [];
    let spawned = 0;

    const result = ensureDaemon(() => {}, {
      version: "0.2.0",
      alive: () => running,
      kill: (pid, signal) => {
        killed.push([pid, signal]);
        running = false;
      },
      spawn: () => {
        spawned++;
        return { once: () => undefined, unref: () => {} };
      },
    });

    expect(result).toBe("spawned");
    expect(killed).toEqual([[9876, "SIGTERM"]]);
    expect(spawned).toBe(1);
  });

  test("keeps a live daemon on the current version", () => {
    saveAccess({ ...defaultAccess(), enabled: true, topicsChat: "42" });
    process.env.TELEGRAM_BOT_TOKEN = "token";
    writeFileSync(statePath("daemon.json"), JSON.stringify({ pid: 9876, version: "0.2.0", startedAt: 1 }));
    let spawned = 0;

    expect(
      ensureDaemon(() => {}, {
        version: "0.2.0",
        alive: () => true,
        spawn: () => {
          spawned++;
          return { once: () => undefined, unref: () => {} };
        },
      }),
    ).toBe("alive");
    expect(spawned).toBe(0);
    expect(readDaemonState()).toEqual({ pid: 9876, version: "0.2.0", startedAt: 1 });
  });
});

describe("daemon spawn preconditions (#68)", () => {
  const enable = (): void => {
    saveAccess({ ...defaultAccess(), enabled: true, topicsChat: "42" });
    process.env.TELEGRAM_BOT_TOKEN = "token";
  };
  const spy = () => {
    const calls: Array<{ executable: string; env?: NodeJS.ProcessEnv }> = [];
    return {
      calls,
      spawn: ((executable, _args, options) => {
        calls.push({ executable, env: options.env });
        return { once: () => undefined, unref: () => {} };
      }) as NonNullable<EnsureDaemonOptions["spawn"]>,
    };
  };

  test("declines instead of spawning when another live process owns the poll lock", () => {
    // The whole defect. Before the fix this spawned a child to discover the
    // lock was taken, and because the child was `omp <script>` it became a
    // session that claimed a permanent Telegram topic before exiting. Measured
    // cost on one host: 83 topics.
    enable();
    const s = spy();
    const result = ensureDaemon(() => {}, {
      spawn: s.spawn,
      runtime: () => "/usr/bin/bun",
      lockOwner: () => ({ pid: 4242, startedAt: 1, name: "conductor" }),
      alive: (pid) => pid === 4242,
    });
    expect(result).toBe("declined");
    expect(s.calls).toEqual([]);
  });

  test("spawns when the lock holder is dead — a stale lock must not wedge it shut", () => {
    enable();
    const s = spy();
    const result = ensureDaemon(() => {}, {
      spawn: s.spawn,
      runtime: () => "/usr/bin/bun",
      lockOwner: () => ({ pid: 4242, startedAt: 1 }),
      alive: () => false,
    });
    expect(result).toBe("spawned");
    expect(s.calls).toHaveLength(1);
  });

  test("our own lock is not foreign", () => {
    enable();
    const s = spy();
    expect(
      ensureDaemon(() => {}, {
        spawn: s.spawn,
        runtime: () => "/usr/bin/bun",
        lockOwner: () => ({ pid: process.pid, startedAt: 1 }),
        alive: () => true,
      }),
    ).toBe("spawned");
  });

  test("declines rather than launching something that cannot run daemon.ts", () => {
    // `process.execPath` inside the omp binary is omp itself, which ignores a
    // script argument and boots an agent session. A spawn that cannot become a
    // daemon must not be reported as one.
    enable();
    const s = spy();
    const warnings: string[] = [];
    const result = ensureDaemon((m) => warnings.push(m), {
      spawn: s.spawn,
      runtime: () => undefined,
      lockOwner: () => undefined,
    });
    expect(result).toBe("declined");
    expect(s.calls).toEqual([]);
    expect(warnings.join(" ")).toContain("no bun/node runtime");
  });

  test("launches the resolved runtime, never process.execPath, and marks the child", () => {
    enable();
    const s = spy();
    expect(
      ensureDaemon(() => {}, { spawn: s.spawn, runtime: () => "/opt/bun/bin/bun", lockOwner: () => undefined }),
    ).toBe("spawned");
    expect(s.calls[0]?.executable).toBe("/opt/bun/bin/bun");
    // The marker is the blast-radius cap: a child that somehow boots as a
    // session still refuses to claim a topic.
    expect(s.calls[0]?.env?.OMP_TELEGRAM_DAEMON_CHILD).toBe("1");
  });

  test("a stale-version daemon is still stopped before the lock is consulted", () => {
    // Ordering matters: if the lock were checked first, a stale-version daemon
    // holding its own lock would be immortal.
    enable();
    writeFileSync(statePath("daemon.json"), JSON.stringify({ pid: 9876, version: "0.1.1", startedAt: 1 }));
    const s = spy();
    let running = true;
    const killed: number[] = [];
    const result = ensureDaemon(() => {}, {
      version: "0.2.0",
      spawn: s.spawn,
      runtime: () => "/usr/bin/bun",
      lockOwner: () => undefined,
      alive: () => running,
      kill: (pid) => {
        killed.push(pid);
        running = false;
      },
    });
    expect(killed).toEqual([9876]);
    expect(result).toBe("spawned");
  });
});

describe("resolveRuntime (#68)", () => {
  test("rejects a host binary that only looks like a launcher", () => {
    // The bug in one assertion: omp is not a runtime, so it must never be
    // returned even though it is `process.execPath`.
    expect(resolveRuntime({ PATH: "" }, "/root/.local/bin/omp")).toBeUndefined();
  });

  test("uses the host runtime when the host IS one", () => {
    expect(resolveRuntime({ PATH: "" }, "/usr/local/bin/bun")).toBe("/usr/local/bin/bun");
    expect(resolveRuntime({ PATH: "" }, "/usr/bin/node")).toBe("/usr/bin/node");
  });

  test("finds bun on PATH when the host is not a runtime", () => {
    const bin = mkdtempSync(join(tmpdir(), "omp-tg-runtime-"));
    try {
      writeFileSync(join(bin, "bun"), "#!/bin/sh\n", { mode: 0o755 });
      expect(resolveRuntime({ PATH: bin }, "/root/.local/bin/omp")).toBe(join(bin, "bun"));
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
