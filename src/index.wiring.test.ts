import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Access, defaultAccess, loadAccess } from "./access";
import telegramExtension from "./index";

type EventHandler = (event: unknown, ctx: unknown) => unknown;
type CommandHandler = (args: string, ctx: unknown) => unknown;

// A structural fake ExtensionAPI that captures registrations and tool-set
// mutations so we can drive the real extension handlers without a live bridge.
// These are runtime-populated collections keyed dynamically, hence Map.
function harness(initialTools: string[]) {
  const tools = new Map<string, { name: string }>();
  const commands = new Map<string, { handler: CommandHandler }>();
  const handlers = new Map<string, EventHandler[]>();
  const setActiveCalls: string[][] = [];
  let active = [...initialTools];
  // Every `T.Xxx(...)` access returns a callable that yields the same stand-in,
  // so schema construction at registration time never throws.
  const anyType: unknown = new Proxy(() => anyType, { get: () => () => anyType });
  const pi = {
    typebox: { Type: anyType },
    logger: { warn() {}, debug() {}, info() {}, error() {} },
    registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
    registerCommand: (name: string, opts: { handler: CommandHandler }) => commands.set(name, opts),
    registerFlag: () => {},
    registerShortcut: () => {},
    on: (event: string, handler: EventHandler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    getFlag: () => undefined,
    getActiveTools: () => [...active],
    setActiveTools: async (names: string[]) => {
      active = [...names];
      setActiveCalls.push([...names]);
    },
    setLabel: () => {},
    sendUserMessage: () => {},
    setModel: async () => true,
    getThinkingLevel: () => undefined,
    setThinkingLevel: () => {},
  };
  // Structural stand-in for the injected API; the extension only touches the
  // members mocked above during registration and the handlers under test.
  telegramExtension(pi as unknown as ExtensionAPI);
  return { tools, commands, handlers, setActiveCalls, active: () => active };
}

const previousStateDir = process.env.OMP_TELEGRAM_STATE_DIR;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omp-tg-wiring-"));
  process.env.OMP_TELEGRAM_STATE_DIR = dir;
});
afterEach(() => {
  if (previousStateDir === undefined) delete process.env.OMP_TELEGRAM_STATE_DIR;
  else process.env.OMP_TELEGRAM_STATE_DIR = previousStateDir;
  rmSync(dir, { recursive: true, force: true });
});

function writeAccess(over: Partial<Access>): void {
  writeFileSync(join(dir, "access.json"), JSON.stringify({ ...defaultAccess(), ...over }));
}

describe("extension wiring", () => {
  test("registers telegram_ask and the /away command", () => {
    const h = harness(["ask", "read"]);
    expect(h.tools.has("telegram_ask")).toBe(true);
    expect(h.commands.has("away")).toBe(true);
  });

  test("before_agent_start swaps ask -> telegram_ask for a Telegram-originated turn", async () => {
    const h = harness(["ask", "read", "bash"]);
    const beforeStart = h.handlers.get("before_agent_start")?.[0];
    expect(beforeStart).toBeDefined();
    const result = (await beforeStart?.(
      { type: "before_agent_start", prompt: '<telegram-message from_id="42" chat_id="42" chat_type="private">hi</telegram-message>', systemPrompt: [] },
      {},
    )) as { systemPrompt: string[] } | undefined;
    const swapped = h.setActiveCalls.at(-1);
    expect(swapped).toContain("telegram_ask");
    expect(swapped).not.toContain("ask");
    expect(swapped).toContain("read");
    expect(result?.systemPrompt.at(-1)).toContain("Telegram");
  });

  test("before_agent_start leaves ask untouched for a plain terminal turn with notify off", async () => {
    writeAccess({ allowFrom: ["42"], notifyChat: "42" }); // notifyMode undefined => off
    const h = harness(["ask", "read"]);
    const beforeStart = h.handlers.get("before_agent_start")?.[0];
    await beforeStart?.({ type: "before_agent_start", prompt: "just do the thing", systemPrompt: [] }, {});
    expect(h.setActiveCalls.every((call) => !call.includes("telegram_ask"))).toBe(true);
    expect(h.active()).toContain("ask");
  });

  test("/away toggles sticky away mode in access.json", async () => {
    writeAccess({ allowFrom: ["42"], notifyChat: "42" });
    const h = harness(["ask"]);
    const away = h.commands.get("away");
    expect(away).toBeDefined();
    const ctx = { ui: { notify() {} } };

    await away?.handler("", ctx);
    expect(loadAccess().notifyMode).toBe("away");
    await away?.handler("", ctx);
    expect(loadAccess().notifyMode).toBeUndefined();
  });

  test("/away turns off `always` without downgrading it to `away`", async () => {
    writeAccess({ allowFrom: ["42"], notifyChat: "42", notifyMode: "always" });
    const h = harness(["ask"]);
    await h.commands.get("away")?.handler("", { ui: { notify() {} } });
    expect(loadAccess().notifyMode).toBeUndefined();
  });

  test("/away refuses to arm without a destination", async () => {
    writeAccess({ allowFrom: ["42"] }); // no notifyChat, no topics
    const h = harness(["ask"]);
    let warned = false;
    await h.commands.get("away")?.handler("", { ui: { notify: (_message: string, level?: string) => (warned ||= level === "warning") } });
    expect(warned).toBe(true);
    expect(loadAccess().notifyMode).toBeUndefined();
  });
});
