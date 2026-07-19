import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Access, defaultAccess, loadAccess } from "./access";
import telegramExtension from "./index";

type EventHandler = (event: unknown, ctx: unknown) => unknown;
type CommandHandler = (args: string, ctx: unknown) => unknown;
type ToolResult = { content: { type: string; text: string }[]; isError?: true };
type ToolShape = {
  name: string;
  execute(id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: unknown): Promise<ToolResult>;
};

// A structural fake ExtensionAPI that captures registrations and tool-set
// mutations so we can drive the real extension handlers without a live bridge.
// These are runtime-populated collections keyed dynamically, hence Map.
function harness(initialTools: string[]) {
  const tools = new Map<string, ToolShape>();
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
    registerTool: (tool: ToolShape) => tools.set(tool.name, tool),
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

  test("/away toggles away mode on and off in access.json", async () => {
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

describe("away auto-clear (input handler)", () => {
  const fire = (
    h: { handlers: Map<string, EventHandler[]> },
    text: string,
    source: "interactive" | "rpc" | "extension",
    notify: (m: string, l?: string) => void = () => {},
  ) => h.handlers.get("input")?.[0]?.({ type: "input", text, source }, { ui: { notify } });

  test("an interactive local prompt clears `away` and announces it", async () => {
    writeAccess({ allowFrom: ["42"], notifyChat: "42", notifyMode: "away" });
    const h = harness(["ask"]);
    let announced = false;
    await fire(h, "keep working on the parser", "interactive", (m) => (announced ||= /away off/.test(m)));
    expect(loadAccess().notifyMode).toBeUndefined();
    expect(announced).toBe(true);
  });

  test("a phone reply (extension) and an rpc turn never count as presence", async () => {
    for (const source of ["extension", "rpc"] as const) {
      writeAccess({ allowFrom: ["42"], notifyChat: "42", notifyMode: "away" });
      const h = harness(["ask"]);
      await fire(h, "answer from the couch", source);
      expect(loadAccess().notifyMode).toBe("away");
    }
  });

  test("`always` never auto-clears on interactive input", async () => {
    writeAccess({ allowFrom: ["42"], notifyChat: "42", notifyMode: "always" });
    const h = harness(["ask"]);
    await fire(h, "do the next thing", "interactive");
    expect(loadAccess().notifyMode).toBe("always");
  });

  test("another interactive slash command is still presence and clears `away`", async () => {
    writeAccess({ allowFrom: ["42"], notifyChat: "42", notifyMode: "away" });
    const h = harness(["ask"]);
    await fire(h, "/sessions", "interactive");
    expect(loadAccess().notifyMode).toBeUndefined();
  });

  test("the `/away` toggle is not raced: input(`/away`) then the command lands OFF", async () => {
    writeAccess({ allowFrom: ["42"], notifyChat: "42", notifyMode: "away" });
    const h = harness(["ask"]);
    await fire(h, "/away", "interactive"); // guard: must NOT clear, or the toggle below re-arms
    expect(loadAccess().notifyMode).toBe("away");
    await h.commands.get("away")?.handler("", { ui: { notify() {} } });
    expect(loadAccess().notifyMode).toBeUndefined();
  });

  test("interactive input with notify off is a no-op", async () => {
    writeAccess({ allowFrom: ["42"], notifyChat: "42" }); // notifyMode undefined
    const h = harness(["ask"]);
    await fire(h, "just do it", "interactive");
    expect(loadAccess().notifyMode).toBeUndefined();
  });
});

type DialogQuestion = { id: string; question: string; options: { label: string }[]; multi?: boolean };

describe("telegram_ask execute (dual-surface)", () => {
  const questions = [{ id: "q", question: "Pick one", options: [{ label: "A" }, { label: "B" }] }];
  const submit = async (qs: DialogQuestion[], selected: string[] = ["A"], note?: string) => ({
    kind: "submit",
    results: qs.map((q) => ({
      id: q.id,
      question: q.question,
      options: q.options.map((o) => o.label),
      multi: false,
      selectedOptions: selected,
      ...(note == null ? {} : { note }),
    })),
  });

  test("maps a terminal submit to the answer", async () => {
    const h = harness(["ask"]);
    const res = await h.tools.get("telegram_ask")!.execute("t", { questions }, undefined, undefined, {
      hasUI: true,
      ui: { askDialog: (qs: DialogQuestion[]) => submit(qs) },
    });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain("User selected: A");
  });

  test("preserves a terminal note", async () => {
    const h = harness(["ask"]);
    const res = await h.tools.get("telegram_ask")!.execute("t", { questions }, undefined, undefined, {
      hasUI: true,
      ui: { askDialog: (qs: DialogQuestion[]) => submit(qs, ["A"], "double-check") },
    });
    expect(res.content[0].text).toContain("User added a note: double-check");
  });

  test("returns an error result on terminal cancel", async () => {
    const h = harness(["ask"]);
    const res = await h.tools.get("telegram_ask")!.execute("t", { questions }, undefined, undefined, {
      hasUI: true,
      ui: { askDialog: async () => undefined },
    });
    expect(res.isError).toBe(true);
  });

  test("passes through a terminal chat redirect", async () => {
    const h = harness(["ask"]);
    const res = await h.tools.get("telegram_ask")!.execute("t", { questions }, undefined, undefined, {
      hasUI: true,
      ui: { askDialog: async () => ({ kind: "chat" }) },
    });
    expect(res.content[0].text.toLowerCase()).toContain("chat about this");
  });

  test("terminal wins when the Telegram surface fails fast", async () => {
    writeAccess({ allowFrom: [] }); // responder isn't authorized → Telegram surface rejects before any network call
    const h = harness(["ask", "read"]);
    await h.handlers.get("before_agent_start")?.[0]?.(
      { type: "before_agent_start", prompt: '<telegram-message from_id="42" chat_id="42" chat_type="private">hi</telegram-message>', systemPrompt: [] },
      {},
    );
    const res = await h.tools.get("telegram_ask")!.execute("t", { questions }, undefined, undefined, {
      hasUI: true,
      ui: { askDialog: (qs: DialogQuestion[]) => submit(qs, ["B"]) },
    });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain("User selected: B");
  });
});
