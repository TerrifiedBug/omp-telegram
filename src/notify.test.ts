import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { type Access, effectiveStreaming, notifyTarget, defaultAccess, loadAccess, saveAccess } from "./access";
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

  test("a daemon profile is a destination on its own — a headless host has no terminal to ask on", () => {
    // Requiring notifyMode here is what made the fleet set it purely to keep
    // telegram_ask answerable, which armed the idle notify post as a side effect.
    expect(notifyTarget(false, mk({ profile: "daemon", notifyChat: "123" }), true)).toEqual({ chatId: "123" });
    expect(notifyTarget(false, mk({ profile: "daemon" }), true)).toBeUndefined(); // still needs somewhere to land
    expect(notifyTarget(true, mk({ profile: "daemon", notifyChat: "123" }), true)).toBeUndefined();
    expect(notifyTarget(false, mk({ profile: "daemon", notifyChat: "123" }), false)).toBeUndefined();
  });
});

describe("effectiveStreaming", () => {
  test("defaults to full streaming and passes through explicit modes", () => {
    expect(effectiveStreaming(mk({}))).toBe(true);
    expect(effectiveStreaming(mk({ streaming: false }))).toBe(false);
    expect(effectiveStreaming(mk({ streaming: "final" }))).toBe("final");
    expect(effectiveStreaming(mk({ streaming: "explicit" }))).toBe("explicit");
  });

  test("a daemon profile overrides a louder streaming value left over from before it", () => {
    expect(effectiveStreaming(mk({ profile: "daemon", streaming: true }))).toBe("explicit");
    expect(effectiveStreaming(mk({ profile: "daemon" }))).toBe("explicit");
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

  test("round-trips the streaming mode and daemon profile", () => {
    saveAccess({ ...defaultAccess(), streaming: "explicit", profile: "daemon" });
    const a = loadAccess();
    expect(a.streaming).toBe("explicit");
    expect(a.profile).toBe("daemon");
  });

  // Both keys decide whether assistant text auto-relays, so an unrecognised
  // value must not fall through to the noisiest default: a hand-typed
  // `"explict"` is truthy, and passed through raw it selected full streaming.
  test("drops unrecognised streaming and profile values instead of trusting them", () => {
    writeFileSync(join(dir, "access.json"), JSON.stringify({ ...defaultAccess(), streaming: "explict", profile: "DAEMON" }));
    const typo = loadAccess();
    expect(typo.streaming).toBeUndefined();
    expect(typo.profile).toBeUndefined();

    writeFileSync(join(dir, "access.json"), JSON.stringify({ ...defaultAccess(), streaming: 1, profile: true }));
    const junk = loadAccess();
    expect(junk.streaming).toBeUndefined();
    expect(junk.profile).toBeUndefined();
  });
});
