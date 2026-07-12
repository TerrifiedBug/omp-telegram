import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { type Access, awayNotifyTarget, defaultAccess, loadAccess, saveAccess } from "./access";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mk = (over: Partial<Access>): Access => ({ ...defaultAccess(), ...over });

describe("awayNotifyTarget", () => {
  test("targets the notify chat for a local run when away is on", () => {
    expect(awayNotifyTarget(false, mk({ away: true, notifyChat: "123" }), true)).toEqual({ chatId: "123" });
    expect(awayNotifyTarget(false, mk({ away: true, notifyChat: "-1001234567890" }), true)).toEqual({ chatId: "-1001234567890" });
  });

  test("prefers this session's topic over the notify chat", () => {
    const target = awayNotifyTarget(false, mk({ away: true, notifyChat: "123", topicsChat: "-100999" }), true, { chatId: "-100999", threadId: 42 });
    expect(target).toEqual({ chatId: "-100999", threadId: 42 });
  });

  test("stays silent when away is off — user is present at the machine", () => {
    expect(awayNotifyTarget(false, mk({ away: false, notifyChat: "123" }), true)).toBeUndefined();
    expect(awayNotifyTarget(false, mk({ notifyChat: "123" }), true)).toBeUndefined();
  });

  test("skips Telegram-initiated runs so the phone isn't double-pinged", () => {
    expect(awayNotifyTarget(true, mk({ away: true, notifyChat: "123" }), true)).toBeUndefined();
  });

  test("skips when no bot token is configured", () => {
    expect(awayNotifyTarget(false, mk({ away: true, notifyChat: "123" }), false)).toBeUndefined();
  });

  test("skips when away is on but no target is configured", () => {
    expect(awayNotifyTarget(false, mk({ away: true }), true)).toBeUndefined();
  });
});

describe("loadAccess field preservation", () => {
  const prev = process.env.OMP_TELEGRAM_STATE_DIR;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omp-tg-access-"));
    process.env.OMP_TELEGRAM_STATE_DIR = dir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.OMP_TELEGRAM_STATE_DIR;
    else process.env.OMP_TELEGRAM_STATE_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  // Regression: optional state once vanished during field-by-field rebuilds;
  // every persistent target/control field must survive the same load path.
  test("round-trips notifyChat, topicsChat, controlThreadId, and away", () => {
    saveAccess({ ...defaultAccess(), notifyChat: "1", topicsChat: "2", controlThreadId: 42, away: true });
    const a = loadAccess();
    expect(a.notifyChat).toBe("1");
    expect(a.topicsChat).toBe("2");
    expect(a.controlThreadId).toBe(42);
    expect(a.away).toBe(true);
  });

  test("absent optional fields load as undefined", () => {
    saveAccess(defaultAccess());
    const a = loadAccess();
    expect(a.notifyChat).toBeUndefined();
    expect(a.topicsChat).toBeUndefined();
    expect(a.controlThreadId).toBeUndefined();
    expect(a.away).toBeUndefined();
  });
});
