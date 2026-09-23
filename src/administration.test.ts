import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AccessAdministration, type AccessAdministrationHooks, type BotIdentity, type TokenTelegramCall } from "./administration";
import { TgError } from "./api";
import { defaultAccess, loadAccess, saveAccess, updateAccess } from "./access";

const previousStateDir = process.env.OMP_TELEGRAM_STATE_DIR;
let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "omp-telegram-admin-"));
  process.env.OMP_TELEGRAM_STATE_DIR = stateDir;
  saveAccess(defaultAccess());
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.OMP_TELEGRAM_STATE_DIR;
  else process.env.OMP_TELEGRAM_STATE_DIR = previousStateDir;
  rmSync(stateDir, { recursive: true, force: true });
});

type Notice = { message: string; level?: "info" | "warning" | "error" };
type FakeUiOptions = {
  hasUI?: boolean;
  inputs?: Array<string | undefined>;
  confirms?: boolean[];
  selects?: Array<string | undefined>;
};

function fakeContext(options: FakeUiOptions = {}): { ctx: ExtensionContext; notices: Notice[] } {
  const notices: Notice[] = [];
  const inputs = [...(options.inputs ?? [])];
  const confirms = [...(options.confirms ?? [])];
  const selects = [...(options.selects ?? [])];
  const ctx = {
    hasUI: options.hasUI ?? true,
    ui: {
      notify(message: string, level?: Notice["level"]) {
        notices.push({ message, level });
      },
      async input() {
        return inputs.shift();
      },
      async confirm() {
        return confirms.shift() ?? false;
      },
      async select() {
        return selects.shift();
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, notices };
}

function hooks(overrides: Partial<AccessAdministrationHooks> = {}): AccessAdministrationHooks {
  return {
    getToken: () => "",
    onAccessChanged() {},
    onTokenChanged() {},
    start() {},
    configureTopics() {},
    doctor() {},
    syncProfile() {},
    refreshCommands() {},
    ...overrides,
  };
}

describe("AccessAdministration", () => {
  test("local settings update a fresh snapshot without overwriting unrelated state", async () => {
    const synced: string[] = [];
    const admin = new AccessAdministration(hooks({
      syncProfile(access) {
        synced.push(access.profile ?? "default");
      },
    }));
    saveAccess({
      ...defaultAccess(),
      allowFrom: ["42"],
      notifyChat: "42",
      groups: { "-100": { requireMention: false, allowFrom: ["42"] } },
    });

    const { ctx } = fakeContext();
    expect(await admin.handle("set", ["profile", "daemon"], ctx)).toBe(true);

    expect(loadAccess()).toMatchObject({
      allowFrom: ["42"],
      notifyChat: "42",
      groups: { "-100": { requireMention: false, allowFrom: ["42"] } },
      profile: "daemon",
    });
    expect(synced).toEqual(["daemon"]);
  });

  test("rejects and removes an expired pairing code without changing the owner", async () => {
    saveAccess({
      ...defaultAccess(),
      allowFrom: ["42"],
      pending: {
        expired: { senderId: "42", chatId: "42", createdAt: Date.now() - 2_000, expiresAt: Date.now() - 1, replies: 1 },
      },
    });
    let refreshes = 0;
    const admin = new AccessAdministration(hooks({
      refreshCommands() {
        refreshes++;
      },
    }));
    const { ctx, notices } = fakeContext();

    await admin.handle("pair", ["expired"], ctx);
    expect(loadAccess().allowFrom).toEqual(["42"]);
    expect(loadAccess().pending).toEqual({});
    expect(refreshes).toBe(0);
    expect(notices.at(-1)?.message).toContain("expired");
  });

  test("evaluates the current owner inside the locked allow mutation", async () => {
    const admin = new AccessAdministration(hooks());
    saveAccess({ ...defaultAccess(), allowFrom: ["42"] });
    const { ctx, notices } = fakeContext();

    await admin.handle("allow", ["77"], ctx);

    expect(loadAccess().allowFrom).toEqual(["42"]);
    expect(notices.at(-1)).toMatchObject({ level: "error" });
  });

  test("rejects setup outside an interactive UI without side effects", async () => {
    let calls = 0;
    const admin = new AccessAdministration(hooks({
      onTokenChanged() {
        calls++;
      },
      start() {
        calls++;
      },
    }));
    const { ctx, notices } = fakeContext({ hasUI: false });

    await admin.handle("setup", [], ctx);

    expect(calls).toBe(0);
    expect(loadAccess().enabled).toBe(false);
    expect(notices.at(-1)?.message).toContain("interactive terminal");
  });

  test("does not expose a rejected token even when the transport error includes it", async () => {
    const telegram: TokenTelegramCall = async <T>(token) => {
      throw new TgError(`invalid token ${token}`, 401);
    };
    const admin = new AccessAdministration(hooks({ callTelegram: telegram }));
    const { ctx, notices } = fakeContext();

    await admin.handle("token", ["super-secret"], ctx);

    expect(notices.at(-1)?.message).toBe("telegram: token rejected — 401 invalid token [redacted]");
    expect(notices.some(({ message }) => message.includes("super-secret"))).toBe(false);
    expect(() => readFileSync(join(stateDir, ".env"), "utf8")).toThrow();
  });

  test("honors replacement-token cancellation after declining the configured token", async () => {
    const telegram: TokenTelegramCall = async <T>(_token: string, method: string) => {
      if (method !== "getMe") throw new Error("unexpected call");
      return { username: "configured_bot" } as unknown as T;
    };
    let changed = false;
    const admin = new AccessAdministration(hooks({
      getToken: () => "configured-secret",
      callTelegram: telegram,
      onTokenChanged() {
        changed = true;
      },
    }));
    const { ctx, notices } = fakeContext({ confirms: [false], inputs: [undefined] });

    await admin.handle("setup", [], ctx);

    expect(changed).toBe(false);
    expect(loadAccess().enabled).toBe(false);
    expect(notices.at(-1)?.message).toBe("telegram: setup cancelled");
    expect(notices.some(({ message }) => message.includes("configured-secret"))).toBe(false);
  });

  test("runs token validation, pairing, topic setup, and doctor through real hooks", async () => {
    const telegramCalls: Array<{ token: string; method: string; payload: Record<string, unknown> }> = [];
    const me: BotIdentity = {
      id: 7,
      username: "setup_bot",
      has_topics_enabled: true,
      allows_users_to_create_topics: false,
    };
    const telegram: TokenTelegramCall = async <T>(token, method, payload) => {
      telegramCalls.push({ token, method, payload });
      if (method === "getMe") return me as unknown as T;
      if (method === "sendMessage") return { message_id: 1 } as unknown as T;
      throw new Error(`unexpected Telegram method ${method}`);
    };
    let currentToken = "";
    const effects: string[] = [];
    const admin = new AccessAdministration(hooks({
      getToken: () => currentToken,
      callTelegram: telegram,
      onTokenChanged(token) {
        currentToken = token;
        effects.push("token");
      },
      start() {
        effects.push("start");
        updateAccess((access) => {
          access.pending.abc123 = {
            senderId: "42",
            chatId: "42",
            createdAt: Date.now(),
            expiresAt: Date.now() + 60_000,
            replies: 1,
          };
        });
      },
      configureTopics(_ctx, arg) {
        effects.push(`topics:${arg}`);
      },
      doctor() {
        effects.push("doctor");
      },
      refreshCommands() {
        effects.push("commands");
      },
    }));
    const { ctx, notices } = fakeContext({
      inputs: ["test-secret", "abc123"],
      selects: ["Enable session topics"],
    });

    await admin.handle("setup", [], ctx);

    expect(readFileSync(join(stateDir, ".env"), "utf8")).toBe("TELEGRAM_BOT_TOKEN=test-secret\n");
    expect(statSync(join(stateDir, ".env")).mode & 0o777).toBe(0o600);
    expect(loadAccess()).toMatchObject({ enabled: true, allowFrom: ["42"], pending: {} });
    expect(effects).toEqual(["token", "start", "commands", "topics:on", "doctor"]);
    expect(telegramCalls.map(({ method }) => method)).toEqual(["getMe", "sendMessage"]);
    expect(telegramCalls[1]?.payload).toMatchObject({ chat_id: "42" });
    expect(notices.some(({ message }) => message.includes("test-secret"))).toBe(false);
  });

  test("explains unavailable and unsafe BotFather topic flags before doctor", async () => {
    saveAccess({ ...defaultAccess(), allowFrom: ["42"] });
    const telegram: TokenTelegramCall = async <T>() => ({
      username: "setup_bot",
      has_topics_enabled: false,
      allows_users_to_create_topics: true,
    } as unknown as T);
    let configuredTopics = false;
    let doctored = false;
    const admin = new AccessAdministration(hooks({
      getToken: () => "configured-secret",
      callTelegram: telegram,
      configureTopics() {
        configuredTopics = true;
      },
      doctor() {
        doctored = true;
      },
    }));
    const { ctx, notices } = fakeContext({ confirms: [true] });

    await admin.handle("setup", [], ctx);

    expect(configuredTopics).toBe(false);
    expect(doctored).toBe(true);
    expect(notices.some(({ message }) => message.includes("Enable Topics"))).toBe(true);
    expect(notices.some(({ message }) => message.includes("disable user-created topics"))).toBe(true);
  });

  test("stops setup when the topic choice is cancelled", async () => {
    saveAccess({ ...defaultAccess(), allowFrom: ["42"] });
    const telegram: TokenTelegramCall = async <T>() => ({ username: "setup_bot", has_topics_enabled: true } as unknown as T);
    const effects: string[] = [];
    const admin = new AccessAdministration(hooks({
      getToken: () => "configured-secret",
      callTelegram: telegram,
      start() {
        effects.push("start");
      },
      configureTopics() {
        effects.push("topics");
      },
      doctor() {
        effects.push("doctor");
      },
    }));
    const { ctx, notices } = fakeContext({ confirms: [true], selects: [undefined] });

    await admin.handle("setup", [], ctx);

    expect(effects).toEqual(["start"]);
    expect(notices.at(-1)?.message).toBe("telegram: setup cancelled");
  });
});
