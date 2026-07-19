import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { type Access, notifyTarget, defaultAccess, loadAccess, saveAccess } from "./access";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mk = (over: Partial<Access>): Access => ({ ...defaultAccess(), ...over });

describe("notifyTarget", () => {
  test("targets the notify chat for a local run when a mode is active", () => {
    expect(notifyTarget(false, mk({ notifyMode: "away", notifyChat: "123" }), true)).toEqual({ chatId: "123" });
    expect(notifyTarget(false, mk({ notifyMode: "always", notifyChat: "-1001234567890" }), true)).toEqual({ chatId: "-1001234567890" });
  });

  test("prefers this session's topic over the notify chat", () => {
    const target = notifyTarget(false, mk({ notifyMode: "away", notifyChat: "123", topicsChat: "-100999" }), true, { chatId: "-100999", threadId: 42 });
    expect(target).toEqual({ chatId: "-100999", threadId: 42 });
  });

  test("stays silent when notify mode is off — user is present at the machine", () => {
    expect(notifyTarget(false, mk({ notifyChat: "123" }), true)).toBeUndefined();
  });

  test("skips Telegram-initiated runs so the phone isn't double-pinged", () => {
    expect(notifyTarget(true, mk({ notifyMode: "away", notifyChat: "123" }), true)).toBeUndefined();
  });

  test("skips when no bot token is configured", () => {
    expect(notifyTarget(false, mk({ notifyMode: "away", notifyChat: "123" }), false)).toBeUndefined();
  });

  test("skips when a mode is active but no target is configured", () => {
    expect(notifyTarget(false, mk({ notifyMode: "always" }), true)).toBeUndefined();
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
  test("round-trips notify, topic, control, mode, and transcription fields", () => {
    saveAccess({
      ...defaultAccess(),
      notifyChat: "1",
      topicsChat: "2",
      controlThreadId: 42,
      notifyMode: "always",
      transcribeCommand: ["whisper-cli", "-f", "{file}"],
    });
    const a = loadAccess();
    expect(a.notifyChat).toBe("1");
    expect(a.topicsChat).toBe("2");
    expect(a.controlThreadId).toBe(42);
    expect(a.notifyMode).toBe("always");
    expect(a.transcribeCommand).toEqual(["whisper-cli", "-f", "{file}"]);
  });

  test("absent optional fields load as undefined", () => {
    saveAccess(defaultAccess());
    const a = loadAccess();
    expect(a.notifyChat).toBeUndefined();
    expect(a.topicsChat).toBeUndefined();
    expect(a.controlThreadId).toBeUndefined();
    expect(a.notifyMode).toBeUndefined();
    expect(a.transcribeCommand).toBeUndefined();
  });

  test("migrates a legacy away:true flag to notify away mode", () => {
    writeFileSync(join(dir, "access.json"), JSON.stringify({ ...defaultAccess(), away: true }));
    expect(loadAccess().notifyMode).toBe("away");
  });

  test("legacy away:false migrates to notify off", () => {
    writeFileSync(join(dir, "access.json"), JSON.stringify({ ...defaultAccess(), away: false }));
    expect(loadAccess().notifyMode).toBeUndefined();
  });
});
