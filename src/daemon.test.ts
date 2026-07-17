import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultAccess, saveAccess, statePath } from "./access";
import { daemonDisableReason, ensureDaemon, readDaemonState } from "./daemon";

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
