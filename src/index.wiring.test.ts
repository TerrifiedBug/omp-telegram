import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type Access, defaultAccess, loadAccess } from "./access";
import telegramExtension from "./index";
import { claimDmOwner, loadDmOwner, loadRegistry } from "./topics";

type EventHandler = (event: unknown, ctx: unknown) => unknown;
type CommandHandler = (args: string, ctx: unknown) => unknown;
type ToolResult = { content: { type: string; text: string }[]; isError?: true };
type ToolShape = {
  name: string;
  execute(id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: unknown): Promise<ToolResult>;
  defaultInactive?: boolean;
};
type Harness = {
  tools: Map<string, ToolShape>;
  commands: Map<string, { handler: CommandHandler }>;
  handlers: Map<string, EventHandler[]>;
  setActiveCalls: string[][];
  active: () => string[];
};

// A structural fake ExtensionAPI that captures registrations and tool-set
// mutations so we can drive the real extension handlers without a live bridge.
// These are runtime-populated collections keyed dynamically, hence Map.
function harness(initialTools: string[], activateRegisteredTools = false): Harness {
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
    registerTool: (tool: ToolShape) => {
      tools.set(tool.name, tool);
      if (activateRegisteredTools && tool.defaultInactive !== true && !active.includes(tool.name)) active.push(tool.name);
    },
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
const previousToken = process.env.TELEGRAM_BOT_TOKEN;
const packageJson: unknown = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
if (!packageJson || typeof packageJson !== "object" || !("version" in packageJson) || typeof packageJson.version !== "string") {
  throw new Error("package.json has no string version");
}
const packageVersion = packageJson.version;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omp-tg-wiring-"));
  process.env.OMP_TELEGRAM_STATE_DIR = dir;
  delete process.env.TELEGRAM_BOT_TOKEN; // a real token in the dev environment must never leak into these tests
});
afterEach(() => {
  if (previousStateDir === undefined) delete process.env.OMP_TELEGRAM_STATE_DIR;
  else process.env.OMP_TELEGRAM_STATE_DIR = previousStateDir;
  if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = previousToken;
  rmSync(dir, { recursive: true, force: true });
});

function writeAccess(over: Partial<Access>): void {
  writeFileSync(join(dir, "access.json"), JSON.stringify({ ...defaultAccess(), ...over }));
}

/**
 * Bring the extension's in-session bot token online — the gate that decides
 * whether telegram_ask can be mounted — without touching the network: a
 * daemon record for this (live) pid makes startBot skip both the daemon spawn
 * and the getMe/poll launch.
 */
async function startBridge(h: Harness): Promise<void> {
  writeFileSync(join(dir, ".env"), "TELEGRAM_BOT_TOKEN=111:wiring-test\n");
  writeFileSync(join(dir, "daemon.json"), JSON.stringify({ pid: process.pid, version: packageVersion, startedAt: Date.now() }));
  await h.handlers.get("session_start")?.[0]?.(
    { type: "session_start" },
    {
      hasUI: true,
      ui: { notify() {} },
      sessionManager: {
        getSessionId: () => "session-1",
        getSessionFile: () => "/tmp/session-1.jsonl",
      },
    },
  );
}

describe("extension wiring", () => {
  test("registers telegram_ask and the /away command", () => {
    const h = harness(["ask", "read"]);
    expect(h.tools.has("telegram_ask")).toBe(true);
    expect(h.commands.has("away")).toBe(true);
  });

  test("startup auto-claims DM ownership and refreshes it without topics enabled", async () => {
    writeAccess({ enabled: true, allowFrom: ["42"] });
    const h = harness(["ask"]);
    await startBridge(h);
    expect(loadDmOwner()).toMatchObject({
      pid: process.pid,
      sessionId: "session-1",
      sessionFile: "/tmp/session-1.jsonl",
    });

    const switchedCtx = {
      hasUI: true,
      ui: { notify() {} },
      sessionManager: {
        getSessionId: () => "session-2",
        getSessionFile: () => "/tmp/session-2.jsonl",
      },
    };
    await h.handlers.get("session_switch")?.[0]?.({ type: "session_switch" }, switchedCtx);
    expect(loadDmOwner()).toMatchObject({
      pid: process.pid,
      sessionId: "session-2",
      sessionFile: "/tmp/session-2.jsonl",
    });
    await h.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown" }, switchedCtx);
  });

  test("task subagent completion cannot replace the parent routing identity", async () => {
    writeAccess({ enabled: true, allowFrom: ["42"], topicsChat: "42" });
    const h = harness(["read", "yield"]);
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const method = String(input).split("/").pop();
      const result = method === "createForumTopic" ? { message_thread_id: 99 } : { message_id: 7 };
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    }) as typeof fetch;
    try {
      await startBridge(h);
      expect(loadRegistry().threads["99"]?.sessionFile).toBe("/tmp/session-1.jsonl");
      expect(loadDmOwner()?.sessionFile).toBe("/tmp/session-1.jsonl");

      await h.handlers.get("agent_end")?.[0]?.(
        { type: "agent_end", messages: [] },
        {
          hasUI: false,
          isIdle: () => true,
          sessionManager: {
            getSessionId: () => "child-session",
            getSessionFile: () => "/tmp/child-session.jsonl",
          },
        },
      );

      expect(loadRegistry().threads["99"]?.sessionFile).toBe("/tmp/session-1.jsonl");
      expect(loadDmOwner()?.sessionFile).toBe("/tmp/session-1.jsonl");
    } finally {
      await h.handlers.get("session_shutdown")?.[0]?.(
        { type: "session_shutdown" },
        { sessionManager: { getSessionId: () => "session-1", getSessionFile: () => "/tmp/session-1.jsonl" } },
      );
      globalThis.fetch = previousFetch;
    }
  });

  test("/telegram own pins, reports, and clears this session", async () => {
    const h = harness(["ask"]);
    const notices: string[] = [];
    const ctx = {
      ui: { notify: (message: string) => notices.push(message) },
      sessionManager: {
        getSessionId: () => "session-own",
        getSessionFile: () => "/tmp/session-own.jsonl",
      },
    };
    const command = h.commands.get("telegram");

    await command?.handler("own", ctx);
    expect(loadDmOwner()).toMatchObject({
      pid: process.pid,
      sessionId: "session-own",
      sessionFile: "/tmp/session-own.jsonl",
    });
    await command?.handler("own status", ctx);
    expect(notices.at(-1)).toContain(`DM owner: "${basename(process.cwd())}"`);
    await command?.handler("own clear", ctx);
    expect(loadDmOwner()).toBeUndefined();
    expect(notices.at(-1)).toContain("DM owner cleared");
  });

  test("a resumed Telegram turn resolves its token, swaps ask, and reaches the originating owner", async () => {
    writeAccess({ enabled: false, allowFrom: ["42"] });
    writeFileSync(join(dir, ".env"), "TELEGRAM_BOT_TOKEN=111:wiring-test\n");
    const h = harness(["ask", "read", "bash"]);
    const beforeStart = h.handlers.get("before_agent_start")?.[0];
    expect(beforeStart).toBeDefined();
    const result = (await beforeStart?.(
      { type: "before_agent_start", prompt: '<telegram-message from_id="42" chat_id="42" chat_type="private">hi</telegram-message>', systemPrompt: [] },
      { hasUI: false },
    )) as { systemPrompt: string[] } | undefined;
    const swapped = h.setActiveCalls.at(-1);
    expect(swapped).toContain("telegram_ask");
    expect(swapped).not.toContain("ask");
    expect(swapped).toContain("read");
    expect(result?.systemPrompt.at(-1)).toContain("Telegram");

    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const stop = new AbortController();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
      if (calls.length === 2) stop.abort();
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const sendResult = await h.tools.get("telegram_send")!.execute(
        "send",
        { chat_id: "42", text: "reply from resumed turn" },
        undefined,
        undefined,
        { hasUI: false },
      );
      expect(sendResult.isError).toBeUndefined();
      const askResult = await h.tools.get("telegram_ask")!.execute(
        "ask",
        { questions: [{ id: "q", question: "Pick one", options: [{ label: "A" }, { label: "B" }] }] },
        stop.signal,
        undefined,
        { hasUI: false },
      );
      expect(askResult.isError).toBe(true);
      expect(askResult.content[0].text).not.toContain("no surface available");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls[0]).toMatchObject({
      url: expect.stringContaining("/bot111:wiring-test/sendMessage"),
      body: { chat_id: "42" },
    });
    expect(calls[1]?.url).toContain("/bot111:wiring-test/sendMessage");
  });

  test("telegram_send uses this session's topic without a prior inbound message", async () => {
    writeAccess({ enabled: true, allowFrom: ["42"], topicsChat: "42" });
    const h = harness(["ask"]);
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const method = String(input).split("/").pop()!;
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ method, body });
      const result = method === "createForumTopic" ? { message_thread_id: 99 } : { message_id: 8 };
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    }) as typeof fetch;
    try {
      await startBridge(h);
      calls.length = 0;
      const result = await h.tools.get("telegram_send")!.execute(
        "t",
        { text: "done" },
        undefined,
        undefined,
        { sessionManager: { getSessionId: () => "session-1", getSessionFile: () => "/tmp/session-1.jsonl" } },
      );
      expect(result.isError).toBeUndefined();
      expect(calls.find((call) => call.method === "sendMessage")?.body).toMatchObject({
        chat_id: "42",
        message_thread_id: 99,
        text: "done",
      });
      const react = await h.tools.get("telegram_react")!.execute(
        "r",
        { message_id: "55", emoji: "👍" },
        undefined,
        undefined,
        { sessionManager: { getSessionId: () => "session-1", getSessionFile: () => "/tmp/session-1.jsonl" } },
      );
      expect(react.isError).toBeUndefined();
      expect(calls.find((call) => call.method === "setMessageReaction")?.body).toMatchObject({
        chat_id: "42",
        message_id: 55,
      });
    } finally {
      await h.handlers.get("session_shutdown")?.[0]?.(
        { type: "session_shutdown" },
        { sessionManager: { getSessionId: () => "session-1", getSessionFile: () => "/tmp/session-1.jsonl" } },
      );
      globalThis.fetch = previousFetch;
    }
  });

  test("a Telegram steering message gives telegram_send its default chat", async () => {
    writeAccess({ enabled: true, allowFrom: ["42"] });
    const h = harness(["ask"]);
    await startBridge(h);
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      calls.push({
        method: String(input).split("/").pop()!,
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 8 } }), { status: 200 });
    }) as typeof fetch;
    try {
      await h.handlers.get("message_start")?.[0]?.(
        {
          type: "message_start",
          message: {
            role: "user",
            content: [{ type: "text", text: '<telegram-message from_id="42" chat_id="42" chat_type="private">go ahead</telegram-message>' }],
            steering: true,
          },
        },
        {},
      );
      const result = await h.tools.get("telegram_send")!.execute("t", { text: "done" }, undefined, undefined, {});
      expect(result.isError).toBeUndefined();
    } finally {
      await h.handlers.get("session_shutdown")?.[0]?.(
        { type: "session_shutdown" },
        { sessionManager: { getSessionId: () => "session-1", getSessionFile: () => "/tmp/session-1.jsonl" } },
      );
      globalThis.fetch = previousFetch;
    }
    expect(calls).toEqual([
      { method: "sendChatAction", body: { chat_id: "42", action: "typing" } },
      { method: "sendMessage", body: { chat_id: "42", text: "done", parse_mode: "MarkdownV2" } },
    ]);
  });

  test("telegram_send uses this session's pinned DM owner without a prior inbound message", async () => {
    writeAccess({ enabled: true, allowFrom: ["42"] });
    const h = harness(["ask"]);
    await startBridge(h);
    const calls: Record<string, unknown>[] = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      calls.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 8 } }), { status: 200 });
    }) as typeof fetch;
    try {
      const result = await h.tools.get("telegram_send")!.execute(
        "t",
        { text: "done" },
        undefined,
        undefined,
        { sessionManager: { getSessionId: () => "session-1", getSessionFile: () => "/tmp/session-1.jsonl" } },
      );
      expect(result.isError).toBeUndefined();
      expect(calls.find((body) => body.text === "done")).toMatchObject({ chat_id: "42", text: "done" });
    } finally {
      await h.handlers.get("session_shutdown")?.[0]?.(
        { type: "session_shutdown" },
        { sessionManager: { getSessionId: () => "session-1", getSessionFile: () => "/tmp/session-1.jsonl" } },
      );
      globalThis.fetch = previousFetch;
    }
  });

  test("telegram_send refuses a foreign pinned DM owner", async () => {
    writeAccess({ enabled: true, allowFrom: ["42"] });
    claimDmOwner({
      pid: 999_999,
      cwd: "/foreign",
      name: "foreign",
      claimedAt: 1,
      sessionId: "foreign",
      sessionFile: "/tmp/foreign.jsonl",
    });
    const h = harness(["ask"]);
    await startBridge(h);
    const result = await h.tools.get("telegram_send")!.execute(
      "t",
      { text: "done" },
      undefined,
      undefined,
      { sessionManager: { getSessionId: () => "session-1", getSessionFile: () => "/tmp/session-1.jsonl" } },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("no active telegram chat — pass chat_id");
  });

  test("telegram_send still refuses when no bridge session has claimed a target", async () => {
    writeAccess({ enabled: true, allowFrom: ["42"] });
    const h = harness(["ask"]);
    const result = await h.tools.get("telegram_send")!.execute("t", { text: "done" }, undefined, undefined, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("no active telegram chat — pass chat_id");
  });

  test("before_agent_start leaves ask untouched for a plain terminal turn with notify off", async () => {
    writeAccess({ allowFrom: ["42"], notifyChat: "42" }); // notifyMode undefined => off
    const h = harness(["ask", "read"]);
    const beforeStart = h.handlers.get("before_agent_start")?.[0];
    await beforeStart?.({ type: "before_agent_start", prompt: "just do the thing", systemPrompt: [] }, {});
    expect(h.setActiveCalls.every((call) => !call.includes("telegram_ask"))).toBe(true);
    expect(h.active()).toContain("ask");
  });

  test("before_agent_start mounts telegram_ask alongside ask on a locally injected turn once the bridge is live", async () => {
    writeAccess({ enabled: true, allowFrom: ["42"] }); // notifyMode off, no notifyChat — the reported conductor state
    const h = harness(["ask", "read"]);
    await startBridge(h);
    await h.handlers.get("before_agent_start")?.[0]?.({ type: "before_agent_start", prompt: "scheduled tick", systemPrompt: [] }, {});
    const mounted = h.setActiveCalls.at(-1);
    expect(mounted).toContain("telegram_ask"); // discovery: the tool's own no-surface guard replaces `No such tool`
    expect(mounted).toContain("ask"); // ...but a local turn keeps the native ask; only away/always and Telegram turns swap
  });

  test("daemon profile mounts telegram_ask at registration and preserves it across agent_end", async () => {
    writeAccess({ enabled: true, allowFrom: ["42"], notifyChat: "42", profile: "daemon" });
    const h = harness(["ask", "read"], true);
    expect(h.active()).toContain("telegram_ask");
    await startBridge(h);
    const ctx = {
      hasUI: false,
      isIdle: () => true,
      ui: { notify() {} },
      sessionManager: { getSessionId: () => "session-1", getSessionFile: () => "/tmp/session-1.jsonl" },
    };

    await h.handlers.get("before_agent_start")?.[0]?.(
      { type: "before_agent_start", prompt: "operator turn", systemPrompt: [] },
      ctx,
    );
    await h.handlers.get("agent_end")?.[0]?.(
      { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] },
      ctx,
    );
    // Agent-initiated custom turns inherit this surface; they do not run
    // before_agent_start and no Telegram turn_start handler remounts it.

    expect(h.active()).toContain("telegram_ask");
  });

  test("daemon profile removes telegram_ask from task subagents", async () => {
    writeAccess({ enabled: true, allowFrom: ["42"], notifyChat: "42", profile: "daemon" });
    const h = harness(["ask", "read", "yield"], true);
    expect(h.active()).toContain("telegram_ask");

    await h.handlers.get("session_start")?.[0]?.({ type: "session_start" }, { hasUI: false });

    expect(h.active()).not.toContain("telegram_ask");
  });

  test("changing the profile updates the persistent telegram_ask mount", async () => {
    writeAccess({ enabled: true, allowFrom: ["42"], notifyChat: "42" });
    const h = harness(["ask", "read"]);
    const ctx = { ui: { notify() {} } };
    expect(h.active()).not.toContain("telegram_ask");

    await h.commands.get("telegram")?.handler("set profile daemon", ctx);
    expect(h.active()).toContain("telegram_ask");

    await h.commands.get("telegram")?.handler("set profile default", ctx);
    expect(h.active()).not.toContain("telegram_ask");
  });

  test("a resumed daemon turn hydrates the bridge, mounts telegram_ask, and reaches its paired owner", async () => {
    writeAccess({ enabled: true, allowFrom: ["42"], notifyChat: "42", profile: "daemon" });
    writeFileSync(join(dir, ".env"), "TELEGRAM_BOT_TOKEN=111:wiring-test\n");
    // Match startBridge(): a live standalone daemon means startBot hydrates the
    // session lifecycle without issuing getMe or starting a second poller.
    writeFileSync(join(dir, "daemon.json"), JSON.stringify({ pid: process.pid, version: "test", startedAt: Date.now() }));
    const h = harness(["ask", "read"]);
    const ctx = {
      hasUI: false,
      ui: { notify() {} },
      sessionManager: {
        getSessionId: () => "resumed-session",
        getSessionFile: () => "/tmp/resumed-session.jsonl",
      },
    };
    const result = (await h.handlers.get("before_agent_start")?.[0]?.(
      { type: "before_agent_start", prompt: "resumed scheduled tick", systemPrompt: [] },
      ctx,
    )) as { systemPrompt: string[] } | undefined;

    expect(h.active()).toContain("telegram_ask");
    expect(h.active()).not.toContain("ask");
    expect(result?.systemPrompt.at(-1)).toContain("headless");
    expect(loadDmOwner()).toMatchObject({
      pid: process.pid,
      sessionId: "resumed-session",
      sessionFile: "/tmp/resumed-session.jsonl",
    });

    const calls: { method: string; body: Record<string, unknown> }[] = [];
    const stop = new AbortController();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ method: String(input).split("/").pop()!, body: JSON.parse(String(init?.body ?? "{}")) });
      if (calls.length === 2) stop.abort();
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const sendResult = await h.tools.get("telegram_send")!.execute(
        "send",
        { chat_id: "42", text: "bridge hydrated" },
        undefined,
        undefined,
        { hasUI: false },
      );
      expect(sendResult.isError).toBeUndefined();
      const askResult = await h.tools.get("telegram_ask")!.execute(
        "ask",
        { questions: [{ id: "q", question: "Pick one", options: [{ label: "A" }, { label: "B" }] }] },
        stop.signal,
        undefined,
        { hasUI: false },
      );
      expect(askResult.isError).toBe(true);
      expect(askResult.content[0].text).not.toContain("no surface available");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls[0]).toMatchObject({ method: "sendMessage", body: { chat_id: "42", text: "bridge hydrated" } });
    expect(calls[1]).toMatchObject({ method: "sendMessage", body: { chat_id: "42" } });
  });

  test("a resumed local turn keeps telegram_ask unmounted when the bridge is disabled despite a saved token", async () => {
    writeAccess({ enabled: false, allowFrom: ["42"], notifyChat: "42", profile: "daemon" });
    writeFileSync(join(dir, ".env"), "TELEGRAM_BOT_TOKEN=111:wiring-test\n");
    const h = harness(["ask", "read"], true);

    await h.handlers.get("before_agent_start")?.[0]?.(
      { type: "before_agent_start", prompt: "resumed scheduled tick", systemPrompt: [] },
      { hasUI: false },
    );

    expect(h.active()).not.toContain("telegram_ask");
    expect(h.setActiveCalls).toEqual([]);
  });

  test("a resumed task subagent stays detached from the enabled Telegram bridge", async () => {
    writeAccess({ enabled: true, allowFrom: ["42"], notifyChat: "42", profile: "daemon" });
    writeFileSync(join(dir, ".env"), "TELEGRAM_BOT_TOKEN=111:wiring-test\n");
    const h = harness(["read", "yield"]);

    await h.handlers.get("before_agent_start")?.[0]?.(
      { type: "before_agent_start", prompt: "subagent turn", systemPrompt: [] },
      { hasUI: false },
    );

    expect(h.active()).toEqual(["read", "yield"]);
    expect(h.setActiveCalls).toEqual([]);
  });

  test("before_agent_start adds no away nudge when telegram_ask is merely mounted", async () => {
    writeAccess({ enabled: true, allowFrom: ["42"] });
    const h = harness(["ask"]);
    await startBridge(h);
    const result = await h.handlers.get("before_agent_start")?.[0]?.({ type: "before_agent_start", prompt: "scheduled tick", systemPrompt: [] }, {});
    expect(result).toBeUndefined();
  });

  test("before_agent_start still leaves telegram_ask unmounted when no owner is paired", async () => {
    writeAccess({ enabled: true, allowFrom: [] });
    const h = harness(["ask", "read"]);
    await startBridge(h);
    await h.handlers.get("before_agent_start")?.[0]?.({ type: "before_agent_start", prompt: "scheduled tick", systemPrompt: [] }, {});
    expect(h.setActiveCalls.every((call) => !call.includes("telegram_ask"))).toBe(true);
  });

  test("before_agent_start swaps ask -> telegram_ask on a scheduled tick under a daemon profile", async () => {
    // The fleet state the profile exists for: a paired owner, a notify chat to
    // reach them, and deliberately no notifyMode — which used to be required
    // purely to keep telegram_ask answerable, arming the idle notify post as a
    // side effect.
    writeAccess({ enabled: true, allowFrom: ["42"], notifyChat: "42", profile: "daemon" });
    const h = harness(["ask", "read"]);
    await startBridge(h);
    const result = (await h.handlers.get("before_agent_start")?.[0]?.(
      { type: "before_agent_start", prompt: "scheduled tick", systemPrompt: [] },
      {},
    )) as { systemPrompt: string[] } | undefined;
    const mounted = h.setActiveCalls.at(-1);
    expect(mounted).toContain("telegram_ask");
    expect(mounted).not.toContain("ask"); // headless: there is no terminal to answer a native ask
    expect(result?.systemPrompt.at(-1)).toContain("headless");
  });

  test("agent_end posts no idle notify text under a daemon profile", async () => {
    writeAccess({ enabled: true, allowFrom: ["42"], notifyChat: "42", profile: "daemon" });
    const h = harness(["ask"]);
    await startBridge(h);
    const sent: string[] = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      const method = String(url).split("/").pop()!;
      const payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (method === "sendMessage") sent.push(String(payload.text));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 60 } }), { status: 200 });
    }) as typeof fetch;
    try {
      await h.handlers.get("agent_end")?.[0]?.(
        { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "tick complete" }] }] },
        {
          isIdle: () => true,
          ui: { notify() {} },
          sessionManager: { getSessionId: () => "session-1", getSessionFile: () => undefined },
        },
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
    expect(sent).toEqual([]);
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

  const activateDualSurfaces = async (h: Harness): Promise<void> => {
    writeAccess({ enabled: false, allowFrom: ["42"] });
    writeFileSync(join(dir, ".env"), "TELEGRAM_BOT_TOKEN=111:wiring-test\n");
    await h.handlers.get("before_agent_start")?.[0]?.(
      {
        type: "before_agent_start",
        prompt:
          '<telegram-message from_id="42" chat_id="42" chat_type="private">hi</telegram-message>',
        systemPrompt: [],
      },
      { hasUI: true },
    );
  };

  test("maps a terminal submit to the answer", async () => {
    const h = harness(["ask"]);
    const res = await h.tools.get("telegram_ask")!.execute("t", { questions }, undefined, undefined, {
      hasUI: true,
      ui: { askDialog: (qs: DialogQuestion[]) => submit(qs) },
    });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toBe(
      'Ask provenance: {"posted":["terminal"],"answeredBy":"terminal","errors":{}}\nUser selected: A',
    );
  });

  test("resumed daemon UI ask falls back to the paired owner", async () => {
    writeAccess({
      enabled: true,
      allowFrom: ["42"],
      notifyChat: "42",
      notifyMode: "always",
      profile: "daemon",
    });
    const h = harness(["ask", "read"]);
    await startBridge(h);
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        method: String(input).split("/").pop()!,
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const res = await h.tools.get("telegram_ask")!.execute(
        "t",
        { questions },
        undefined,
        undefined,
        {
          hasUI: true,
          ui: { askDialog: (qs: DialogQuestion[]) => submit(qs) },
        },
      );
      expect(res.content[0].text).toBe(
        'Ask provenance: {"posted":["terminal","telegram"],"answeredBy":"terminal","errors":{}}\nUser selected: A',
      );
      expect(calls[0]).toMatchObject({ method: "sendMessage", body: { chat_id: "42" } });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("terminal answer waits for a deferred Telegram post before reporting provenance", async () => {
    const h = harness(["ask", "read"]);
    await activateDualSurfaces(h);
    const telegramStarted = Promise.withResolvers<void>();
    const telegramResponse = Promise.withResolvers<Response>();
    const telegramClosed = Promise.withResolvers<void>();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const method = String(input).split("/").pop();
      if (method === "sendMessage") {
        telegramStarted.resolve();
        return telegramResponse.promise;
      }
      if (method === "editMessageText") telegramClosed.resolve();
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      let settled = false;
      const result = h.tools.get("telegram_ask")!.execute(
        "t",
        { questions },
        undefined,
        undefined,
        {
          hasUI: true,
          ui: { askDialog: (qs: DialogQuestion[]) => submit(qs) },
        },
      );
      void result.then(() => {
        settled = true;
      });
      await telegramStarted.promise;
      await Bun.sleep(0);
      expect(settled).toBe(false);
      telegramResponse.resolve(
        new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
          headers: { "content-type": "application/json" },
        }),
      );
      const res = await result;
      expect(res.content[0].text).toBe(
        'Ask provenance: {"posted":["terminal","telegram"],"answeredBy":"terminal","errors":{}}\nUser selected: A',
      );
      await telegramClosed.promise;
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("parent cancellation does not wait for a deferred Telegram post", async () => {
    const h = harness(["ask", "read"]);
    await activateDualSurfaces(h);
    const telegramStarted = Promise.withResolvers<void>();
    const telegramResponse = Promise.withResolvers<Response>();
    const telegramClosed = Promise.withResolvers<void>();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const method = String(input).split("/").pop();
      if (method === "sendMessage") {
        telegramStarted.resolve();
        return telegramResponse.promise;
      }
      if (method === "editMessageText") telegramClosed.resolve();
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const stop = new AbortController();
      const result = h.tools.get("telegram_ask")!.execute(
        "t",
        { questions },
        stop.signal,
        undefined,
        {
          hasUI: true,
          ui: {
            askDialog: (
              _qs: DialogQuestion[],
              opts: { signal: AbortSignal },
            ) =>
              new Promise<undefined>((resolve) => {
                if (opts.signal.aborted) resolve(undefined);
                else opts.signal.addEventListener("abort", () => resolve(undefined), { once: true });
              }),
          },
        },
      );
      await telegramStarted.promise;
      stop.abort();
      const res = await result;
      expect(res.content[0].text).toBe(
        'Ask provenance: {"posted":["terminal"],"errors":{}}\nThe question was cancelled because the task stopped.',
      );
      telegramResponse.resolve(
        new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
          headers: { "content-type": "application/json" },
        }),
      );
      await telegramClosed.promise;
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("dual-surface Telegram answer reports both posts and Telegram origin", async () => {
    const h = harness(["ask", "read"]);
    await activateDualSurfaces(h);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    try {
      const result = h.tools.get("telegram_ask")!.execute(
        "t",
        { questions },
        undefined,
        undefined,
        {
          hasUI: true,
          ui: {
            askDialog: (
              _qs: DialogQuestion[],
              opts: { signal: AbortSignal },
            ) =>
              new Promise<undefined>((resolve) => {
                if (opts.signal.aborted) resolve(undefined);
                else opts.signal.addEventListener("abort", () => resolve(undefined), { once: true });
              }),
          },
        },
      );
      const answer = (async (): Promise<void> => {
        const prompts = join(dir, "prompts");
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const requestName = existsSync(prompts)
            ? readdirSync(prompts).find(
                (name) => name.endsWith(".json") && !name.endsWith(".answer.json"),
              )
            : undefined;
          if (requestName !== undefined) {
            const request = JSON.parse(
              readFileSync(join(prompts, requestName), "utf8"),
            ) as { nonce: string };
            writeFileSync(
              join(prompts, `${request.nonce}.answer.json`),
              JSON.stringify({
                expiresAt: Date.now() + 60_000,
                outcome: {
                  status: "answered",
                  answers: [
                    {
                      id: "q",
                      question: "Pick one",
                      selectedOptions: ["B"],
                    },
                  ],
                },
              }),
            );
            return;
          }
          await Bun.sleep(5);
        }
        throw new Error("Telegram prompt request was not persisted");
      })();
      const [res] = await Promise.all([result, answer]);
      expect(res.content[0].text).toBe(
        'Ask provenance: {"posted":["terminal","telegram"],"answeredBy":"telegram","errors":{}}\nUser selected: B',
      );
    } finally {
      globalThis.fetch = realFetch;
    }
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

  test("Telegram post failure remains explicit beside a terminal answer", async () => {
    const h = harness(["ask", "read"]);
    await activateDualSurfaces(h);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("sendMessage unavailable");
    }) as typeof fetch;
    try {
      const res = await h.tools.get("telegram_ask")!.execute(
        "t",
        { questions },
        undefined,
        undefined,
        {
          hasUI: true,
          ui: { askDialog: (qs: DialogQuestion[]) => submit(qs, ["B"]) },
        },
      );
      expect(res.isError).toBeUndefined();
      expect(res.content[0].text).toBe(
        'Ask provenance: {"posted":["terminal"],"answeredBy":"terminal","errors":{"telegram":"sendMessage unavailable"}}\n' +
          "SURFACE ERROR [telegram]: sendMessage unavailable\n" +
          "User selected: B",
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("normalizes an omitted-options question into a free-text terminal dialog", async () => {
    const h = harness(["ask"]);
    let receivedOptions: unknown;
    const res = await h.tools.get("telegram_ask")!.execute(
      "t",
      { questions: [{ id: "open", question: "What's your call?" }] }, // options omitted → free text
      undefined,
      undefined,
      {
        hasUI: true,
        ui: {
          askDialog: (qs: DialogQuestion[]) => {
            receivedOptions = qs[0].options;
            return Promise.resolve({
              kind: "submit",
              results: [{ id: "open", question: "What's your call?", options: [], multi: false, selectedOptions: [], customInput: "go with A" }],
            });
          },
        },
      },
    );
    expect(receivedOptions).toEqual([]); // normalized to [], never undefined, at the tool boundary
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain("go with A");
  });

  test("a headless turn with no resolved target asks the paired owner's DM", async () => {
    writeAccess({ enabled: true, allowFrom: ["42"] }); // notify off: nothing pre-resolves a target
    const h = harness(["ask"]);
    await startBridge(h);
    await h.handlers.get("before_agent_start")?.[0]?.({ type: "before_agent_start", prompt: "scheduled tick", systemPrompt: [] }, {});
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    const stop = new AbortController();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ method: String(input).split("/").pop()!, body: JSON.parse(String(init?.body ?? "{}")) });
      stop.abort(); // the question is posted, then the turn stops — enough to prove where it went
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const res = await h.tools.get("telegram_ask")!.execute("t", { questions }, stop.signal, undefined, { hasUI: false });
      expect(res.isError).toBe(true); // aborted, not "no surface available"
      expect(res.content[0].text).not.toContain("no surface available");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls[0]?.method).toBe("sendMessage");
    expect(calls[0]?.body.chat_id).toBe("42");
  });

  test("a headless turn with no paired owner still reports the no-surface diagnostic", async () => {
    writeAccess({ enabled: true, allowFrom: [] });
    const h = harness(["ask"]);
    await startBridge(h);
    const res = await h.tools.get("telegram_ask")!.execute("t", { questions }, undefined, undefined, { hasUI: false });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("no surface available");
  });
});
