import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statePath } from "./access";
import { claimDmOwner, clearDmOwner, loadDmOwner, type ThreadEntry } from "./topics";

const previousStateDir = process.env.OMP_TELEGRAM_STATE_DIR;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omp-tg-dm-owner-"));
  process.env.OMP_TELEGRAM_STATE_DIR = dir;
});
afterEach(() => {
  if (previousStateDir === undefined) delete process.env.OMP_TELEGRAM_STATE_DIR;
  else process.env.OMP_TELEGRAM_STATE_DIR = previousStateDir;
  rmSync(dir, { recursive: true, force: true });
});

const owner = (overrides: Partial<ThreadEntry> = {}): ThreadEntry => ({
  pid: 1001,
  cwd: "/fleet",
  name: "fleet",
  claimedAt: 123,
  sessionId: "session-1",
  sessionFile: "/tmp/fleet.jsonl",
  ...overrides,
});

describe("DM owner", () => {
  test("the first claim persists and round-trips", () => {
    const entry = owner();
    expect(claimDmOwner(entry)).toEqual({ ok: true });
    expect(loadDmOwner()).toEqual(entry);
  });

  test("a foreign session cannot replace the recorded owner", () => {
    claimDmOwner(owner());
    const file = statePath("dm-owner.json");
    const before = readFileSync(file, "utf8");

    expect(
      claimDmOwner(owner({ pid: 2002, name: "other", sessionId: "session-2", sessionFile: "/tmp/other.jsonl" })),
    ).toEqual({ ok: false, owner: owner() });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("the same durable session can refresh its pid after resume", () => {
    claimDmOwner(owner());
    const resumed = owner({ pid: 2002, sessionId: "session-2" });
    expect(claimDmOwner(resumed)).toEqual({ ok: true });
    expect(loadDmOwner()).toEqual(resumed);
  });

  test("an explicit force claim replaces a foreign owner", () => {
    claimDmOwner(owner());
    const replacement = owner({ pid: 2002, name: "other", sessionId: "session-2", sessionFile: "/tmp/other.jsonl" });
    expect(claimDmOwner(replacement, { force: true })).toEqual({ ok: true });
    expect(loadDmOwner()).toEqual(replacement);
  });

  test("clearing ownership allows a fresh first claim", () => {
    claimDmOwner(owner());
    clearDmOwner();
    expect(existsSync(statePath("dm-owner.json"))).toBe(false);
    const replacement = owner({ pid: 2002, name: "other", sessionId: "session-2", sessionFile: "/tmp/other.jsonl" });
    expect(claimDmOwner(replacement)).toEqual({ ok: true });
    expect(loadDmOwner()).toEqual(replacement);
  });

  test("a corrupt owner record is moved aside and warned about", () => {
    writeFileSync(statePath("dm-owner.json"), "{not json");
    const warnings: string[] = [];
    expect(loadDmOwner((message) => warnings.push(message))).toBeUndefined();
    expect(warnings).toEqual(["dm-owner.json was corrupt — moved aside, starting unowned"]);
    expect(readdirSync(statePath()).filter((name) => name.startsWith("dm-owner.json.corrupt-"))).toHaveLength(1);
  });
});
