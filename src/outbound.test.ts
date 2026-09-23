import { afterEach, beforeEach, test, expect, describe, setSystemTime } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Access, defaultAccess } from "./access";
import { Outbound, OutboundDeliveryError, assistantText, finalAssistantText, lastRunError } from "./outbound";
import { mdToMarkdownV2 } from "./markdown";

const assistant = (text: string): unknown => ({ role: "assistant", content: [{ type: "text", text }] });
const toolResult = (): unknown => ({ role: "toolResult", content: [{ type: "text", text: "tool output" }] });
const originalFetch = globalThis.fetch;
const previousStateDir = process.env.OMP_TELEGRAM_STATE_DIR;
let testStateDir: string;
let scratchDir: string;
beforeEach(() => {
  testStateDir = mkdtempSync(join(tmpdir(), "omp-telegram-outbound-state-"));
  scratchDir = mkdtempSync(join(tmpdir(), "omp-telegram-outbound-files-"));
  process.env.OMP_TELEGRAM_STATE_DIR = testStateDir;
});
const outboxFiles = (): string[] => {
  try {
    return readdirSync(join(testStateDir, "outbox")).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
};
/** Flush pending microtasks — the fetch double resolves without real I/O. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 200; i++) await Promise.resolve();
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  setSystemTime();
  rmSync(testStateDir, { recursive: true, force: true });
  rmSync(scratchDir, { recursive: true, force: true });
  if (previousStateDir == null) delete process.env.OMP_TELEGRAM_STATE_DIR;
  else process.env.OMP_TELEGRAM_STATE_DIR = previousStateDir;
});

describe("assistantText", () => {
  test("returns the text blocks of an assistant message", () => {
    expect(assistantText(assistant("hello"))).toBe("hello");
    expect(assistantText({ role: "assistant", content: "plain string" })).toBe("plain string");
  });

  test("excludes thinking/reasoning blocks — only visible text leaves the machine", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret chain of thought" },
        { type: "text", text: "the answer" },
      ],
    };
    expect(assistantText(msg)).toBe("the answer");
  });

  test("ignores non-assistant messages and junk", () => {
    expect(assistantText({ role: "user", content: [{ type: "text", text: "hi" }] })).toBe("");
    expect(assistantText(undefined)).toBe("");
  });
});

describe("finalAssistantText", () => {
  test("returns the last assistant text across a run", () => {
    expect(finalAssistantText([assistant("first"), assistant("last")])).toBe("last");
  });

  test("skips a trailing tool-result message (run ended on a tool)", () => {
    expect(finalAssistantText([assistant("here is the result"), toolResult()])).toBe("here is the result");
  });

  test("returns empty when there is no assistant text — triggers the bare-ping fallback", () => {
    expect(finalAssistantText([])).toBe("");
    expect(finalAssistantText([{ role: "user", content: [{ type: "text", text: "hi" }] }])).toBe("");
    expect(finalAssistantText([{ role: "assistant", content: [{ type: "thinking", thinking: "..." }] }])).toBe("");
  });
});

describe("lastRunError", () => {
  const failed = (message?: unknown): unknown => ({ role: "assistant", content: [], stopReason: "error", errorMessage: message, errorStatus: 429 });

  test("returns the latest failure with its status", () => {
    expect(lastRunError([assistant("ok"), failed("429 boom")])).toEqual({ message: "429 boom", status: 429 });
  });

  test("stops at the latest assistant result or user boundary", () => {
    expect(lastRunError([failed("old"), assistant("healthy")])).toBeUndefined();
    expect(lastRunError([failed("old"), { role: "user", content: "new request" }])).toBeUndefined();
    expect(lastRunError([failed("old"), failed(" ")])).toBeUndefined();
    expect(lastRunError([failed("old"), { role: "assistant", stopReason: "aborted" }])).toBeUndefined();
    expect(lastRunError([failed("old"), { role: "user", content: "new request" }, failed("current")])).toEqual({ message: "current", status: 429 });
  });

  test("ignores aborts, textless failures, and non-assistant messages", () => {
    expect(lastRunError([{ role: "assistant", content: [], stopReason: "aborted", errorMessage: "stop" }])).toBeUndefined();
    expect(lastRunError([failed("   ")])).toBeUndefined();
    expect(lastRunError([failed(undefined)])).toBeUndefined();
    expect(lastRunError([{ role: "user", content: "hi" }])).toBeUndefined();
    expect(lastRunError([])).toBeUndefined();
  });
});

describe("Outbound.announce", () => {
  test("notifies every active chat in plain text, silent with no token or no turn", async () => {
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url, init) => {
      const method = String(url).split("/").pop()!;
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ method, payload });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 31 } }), { status: 200 });
    }) as typeof fetch;

    const outbound = new Outbound(() => ({ ...defaultAccess(), allowFrom: ["42"], richMessages: "on" }));
    await outbound.announce("no token");
    expect(calls).toEqual([]);
    outbound.setToken("secret");
    await outbound.announce("no turn");
    expect(calls).toEqual([]);
    outbound.markActive("42", 9);
    outbound.markActive("43");
    await outbound.announce("run failed: boom_bam");
    expect(calls.filter((c) => c.method === "sendMessage").map((c) => c.payload)).toEqual([
      { chat_id: "42", text: "run failed: boom_bam", message_thread_id: 9 },
      { chat_id: "43", text: "run failed: boom_bam" },
    ]);
    await outbound.shutdown();
  });
});

describe("Outbound Telegram delivery", () => {
  test("falls back to plain text when Telegram rejects MarkdownV2", async () => {
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    let messageId = 10;
    globalThis.fetch = (async (url, init) => {
      const method = String(url).split("/").pop()!;
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ method, payload });
      if (method === "sendMessage" && payload.parse_mode === "MarkdownV2") {
        return new Response(JSON.stringify({ ok: false, error_code: 400, description: "can't parse entities" }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: ++messageId } }), { status: 200 });
    }) as typeof fetch;

    const outbound = new Outbound(() => ({ ...defaultAccess(), allowFrom: ["42"] }));
    outbound.setToken("secret");
    await expect(outbound.send("42", "hello_world", { threadId: 7 })).resolves.toEqual([11]);
    expect(calls.filter((call) => call.method === "sendMessage")).toEqual([
      { method: "sendMessage", payload: { chat_id: "42", text: "hello\\_world", parse_mode: "MarkdownV2", message_thread_id: 7 } },
      { method: "sendMessage", payload: { chat_id: "42", text: "hello_world", message_thread_id: 7 } },
    ]);
    await outbound.shutdown();
  });

  test("finalizes an active topic turn into that same topic", async () => {
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url, init) => {
      const method = String(url).split("/").pop()!;
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ method, payload });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 22 } }), { status: 200 });
    }) as typeof fetch;

    const outbound = new Outbound(() => ({ ...defaultAccess(), allowFrom: ["42"], streaming: false }));
    outbound.setToken("secret");
    outbound.markActive("42", 9);
    await outbound.onTurnEnd(assistant("done"));
    await outbound.onAgentEnd();

    expect(calls.some((call) => call.method === "sendChatAction" && call.payload.message_thread_id === 9)).toBe(true);
    expect(calls.some((call) => call.method === "sendMessage" && call.payload.message_thread_id === 9 && call.payload.text === "done")).toBe(true);
    expect(outbound.isActive()).toBe(false);
    await outbound.shutdown();
  });

  test("retries a tool send once in a replacement topic", async () => {
    const threads: number[] = [];
    globalThis.fetch = (async (_url, init) => {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      threads.push(Number(payload.message_thread_id));
      if (payload.message_thread_id === 9) {
        return new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: message thread not found" }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 30 } }), { status: 200 });
    }) as typeof fetch;

    const outbound = new Outbound(() => ({ ...defaultAccess(), allowFrom: ["42"] }));
    outbound.setToken("secret");
    const recovered: number[] = [];
    outbound.setMissingThreadHandler(async (_chatId, threadId) => {
      recovered.push(threadId);
      return 10;
    });

    await expect(outbound.send("42", "answer", { threadId: 9 })).resolves.toEqual([30]);
    expect(recovered).toEqual([9]);
    expect(threads).toEqual([9, 10]);
    await outbound.shutdown();
  });

  test("rekeys active turn state before retrying final output", async () => {
    const threads: number[] = [];
    globalThis.fetch = (async (url, init) => {
      const method = String(url).split("/").pop()!;
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (method === "sendMessage") {
        threads.push(Number(payload.message_thread_id));
        if (payload.message_thread_id === 9) {
          return new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: message thread not found" }), { status: 200 });
        }
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 31 } }), { status: 200 });
    }) as typeof fetch;

    const outbound = new Outbound(() => ({ ...defaultAccess(), allowFrom: ["42"], streaming: false }));
    outbound.setToken("secret");
    outbound.setMissingThreadHandler(async () => 10);
    outbound.markActive("42", 9);

    await outbound.onTurnEnd(assistant("done"));

    expect(threads).toEqual([9, 10]);
    expect(outbound.lastTarget()).toEqual({ chatId: "42", threadId: 10 });
    await outbound.onAgentEnd();
    await outbound.shutdown();
  });

  test("streaming 'final' suppresses per-turn messages and sends only the run's final text", async () => {
    const sent: string[] = [];
    const methods: string[] = [];
    globalThis.fetch = (async (url, init) => {
      const method = String(url).split("/").pop()!;
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      methods.push(method);
      if (method === "sendMessage") sent.push(String(payload.text));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 40 } }), { status: 200 });
    }) as typeof fetch;

    const outbound = new Outbound(() => ({ ...defaultAccess(), allowFrom: ["42"], streaming: "final" }));
    outbound.setToken("secret");
    outbound.markActive("42", 9);
    // Intermediate turns must not leak — no live preview (draft/edit) and no per-turn message.
    outbound.onMessageUpdate(assistant("thinking out loud"));
    await outbound.onTurnEnd(assistant("step one"));
    await outbound.onTurnEnd(assistant("step two"));
    expect(methods.filter((m) => m !== "sendChatAction")).toEqual([]);
    // Only the run's final visible assistant text is delivered.
    await outbound.onAgentEnd(finalAssistantText([assistant("step two"), assistant("the answer")]));
    expect(sent).toEqual(["the answer"]);
    expect(outbound.isActive()).toBe(false);
    await outbound.shutdown();
  });

  test("streaming 'final' with no final text delivers nothing", async () => {
    const sent: string[] = [];
    globalThis.fetch = (async (url, init) => {
      const method = String(url).split("/").pop()!;
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (method === "sendMessage") sent.push(String(payload.text));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 41 } }), { status: 200 });
    }) as typeof fetch;

    const outbound = new Outbound(() => ({ ...defaultAccess(), allowFrom: ["42"], streaming: "final" }));
    outbound.setToken("secret");
    outbound.markActive("42");
    await outbound.onTurnEnd(assistant("interim"));
    await outbound.onAgentEnd("");
    expect(sent).toEqual([]);
    await outbound.shutdown();
  });

  test("streaming 'explicit' sends nothing automatically — not per turn, not at the end", async () => {
    const sent: string[] = [];
    const methods: string[] = [];
    globalThis.fetch = (async (url, init) => {
      const method = String(url).split("/").pop()!;
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      methods.push(method);
      if (method === "sendMessage") sent.push(String(payload.text));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 50 } }), { status: 200 });
    }) as typeof fetch;

    const outbound = new Outbound(() => ({ ...defaultAccess(), allowFrom: ["42"], streaming: "explicit" }));
    outbound.setToken("secret");
    outbound.markActive("42", 9);
    outbound.onMessageUpdate(assistant("thinking out loud"));
    await outbound.onTurnEnd(assistant("step one"));
    await outbound.onTurnEnd(assistant("step two"));
    // The end of the run is the leak that a final-text fallback would reopen: on a
    // run a message steered into, the last visible text is the tick's own closing
    // line, not an answer to anybody.
    await outbound.onAgentEnd(finalAssistantText([assistant("step two"), assistant("tick complete")]));
    expect(sent).toEqual([]);
    expect(methods.filter((m) => m !== "sendChatAction")).toEqual([]);
    expect(outbound.isActive()).toBe(false);
    expect(outboxFiles()).toEqual([]);
    await outbound.shutdown();
  });

  test("streaming 'explicit' still delivers an explicit send — the tool path is the whole point", async () => {
    const sent: string[] = [];
    globalThis.fetch = (async (url, init) => {
      const method = String(url).split("/").pop()!;
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (method === "sendMessage") sent.push(String(payload.text));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 51 } }), { status: 200 });
    }) as typeof fetch;

    const outbound = new Outbound(() => ({ ...defaultAccess(), allowFrom: ["42"], streaming: "explicit" }));
    outbound.setToken("secret");
    outbound.markActive("42", 9);
    await outbound.send("42", "the answer", { threadId: 9 });
    await outbound.onTurnEnd(assistant("more internal work"));
    await outbound.onAgentEnd("tick complete");
    expect(sent).toEqual(["the answer"]);
    await outbound.shutdown();
  });

  test("profile 'daemon' forces explicit output over a stale streaming value", async () => {
    const sent: string[] = [];
    globalThis.fetch = (async (url, init) => {
      const method = String(url).split("/").pop()!;
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (method === "sendMessage") sent.push(String(payload.text));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 52 } }), { status: 200 });
    }) as typeof fetch;

    // A host that carried `streaming: true` from before the profile existed.
    const outbound = new Outbound(() => ({ ...defaultAccess(), allowFrom: ["42"], streaming: true, profile: "daemon" }));
    outbound.setToken("secret");
    outbound.markActive("42");
    outbound.onMessageUpdate(assistant("thinking out loud"));
    await outbound.onTurnEnd(assistant("step one"));
    await outbound.onAgentEnd("tick complete");
    expect(sent).toEqual([]);
    await outbound.shutdown();
  });

  test("a tick-shaped run (no inbound message) sends nothing whatever the mode", async () => {
    const sent: string[] = [];
    globalThis.fetch = (async (url, init) => {
      const method = String(url).split("/").pop()!;
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (method === "sendMessage") sent.push(String(payload.text));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 53 } }), { status: 200 });
    }) as typeof fetch;

    // No markActive: nothing marked this run as having a Telegram counterpart.
    const outbound = new Outbound(() => ({ ...defaultAccess(), allowFrom: ["42"] }));
    outbound.setToken("secret");
    await outbound.onTurnEnd(assistant("tick internals"));
    await outbound.onAgentEnd("tick complete");
    expect(sent).toEqual([]);
    await outbound.shutdown();
  });
  test("preflights every attachment and reports confirmed partial uploads", async () => {
    const first = join(scratchDir, "first.txt");
    const second = join(scratchDir, "second.txt");
    writeFileSync(first, "one");
    let uploadCalls = 0;
    globalThis.fetch = (async () => {
      uploadCalls += 1;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 70 + uploadCalls } }));
    }) as typeof fetch;

    const outbound = new Outbound(() => ({ ...defaultAccess(), allowFrom: ["42"] }));
    outbound.setToken("secret");
    await expect(outbound.sendFiles("42", [first, second])).rejects.toThrow();
    expect(uploadCalls).toBe(0);

    writeFileSync(second, "two");
    globalThis.fetch = (async () => {
      uploadCalls += 1;
      if (uploadCalls === 2) {
        return new Response(JSON.stringify({ ok: false, error_code: 403, description: "forbidden" }));
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 71 } }));
    }) as typeof fetch;
    try {
      await outbound.sendFiles("42", [first, second]);
      throw new Error("expected the second upload to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(OutboundDeliveryError);
      expect((error as OutboundDeliveryError).state).toBe("failed");
      expect((error as OutboundDeliveryError).sentIds).toEqual([71]);
      expect(String(error)).toContain("after 1 of 2 part(s)");
    }
    await outbound.shutdown();
  });

  test("transient draft errors recover and boundaries plus shutdown leave drafts to expire", async () => {
    const drafts: Array<Record<string, unknown>> = [];
    let draftAttempts = 0;
    globalThis.fetch = (async (url, init) => {
      const method = String(url).split("/").pop()!;
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (method === "sendMessageDraft") {
        drafts.push(payload);
        draftAttempts += 1;
        if (draftAttempts === 1) {
          return new Response(JSON.stringify({ ok: false, error_code: 500, description: "temporary" }));
        }
      }
      return new Response(JSON.stringify({ ok: true, result: {} }));
    }) as typeof fetch;

    const outbound = new Outbound(() => ({ ...defaultAccess(), allowFrom: ["42"] }));
    outbound.setToken("secret");
    setSystemTime(new Date(1_000_000));
    outbound.markActive("42");
    outbound.onMessageUpdate(assistant("first"));
    await flush();
    setSystemTime(new Date(1_001_000));
    outbound.onMessageUpdate(assistant("second"));
    await flush();
    expect(drafts.map((draft) => draft.text)).toEqual(["first", "second"]);

    // An empty sendMessageDraft shows Telegram's "Thinking…" placeholder, so
    // neither boundary nor shutdown may send one.
    await outbound.onSessionBoundary();
    expect(drafts).toHaveLength(2);
    setSystemTime(new Date(1_002_000));
    outbound.markActive("42");
    outbound.onMessageUpdate(assistant("third"));
    await flush();
    expect(drafts.at(-1)?.text).toBe("third");
    await outbound.shutdown();
    expect(drafts.map((draft) => draft.text)).toEqual(["first", "second", "third"]);
  });
});

describe("Outbound long answers", () => {
  /** Prose with word boundaries, so the newline chunker has somewhere to cut. */
  const prose = (chars: number): string => {
    let out = "";
    let i = 0;
    while (out.length < chars) out += `word${i++} `;
    return out.slice(0, chars);
  };
  /** Recorded Telegram text back to source form: drop MarkdownV2 escapes and the (i/n) label. */
  const unlabel = (text: string): string => text.replace(/\\/g, "").replace(/^\(\d+\/\d+\)\n/, "");

  test("keeps failed final chunks across restart without retrying confirmed parts", async () => {
    const source = prose(9000);
    const firstRun: string[] = [];
    const retryRun: string[] = [];
    let stage: "fail" | "retry" = "fail";
    let attempt = 0;
    let messageId = 80;
    globalThis.fetch = (async (url, init) => {
      const method = String(url).split("/").pop()!;
      if (method !== "sendMessage") {
        return new Response(JSON.stringify({ ok: true, result: {} }));
      }
      const payload = JSON.parse(String(init?.body)) as { text: string };
      (stage === "fail" ? firstRun : retryRun).push(payload.text);
      attempt += 1;
      if (stage === "fail" && attempt === 2) {
        return new Response(JSON.stringify({ ok: false, error_code: 403, description: "forbidden" }));
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: ++messageId } }));
    }) as typeof fetch;

    const first = new Outbound(() => ({ ...defaultAccess(), allowFrom: ["42"], streaming: "final" }));
    first.setToken("secret");
    first.markActive("42");
    await expect(first.onAgentEnd(source)).rejects.toMatchObject({
      state: "failed",
      sentIds: [81],
      chatId: "42",
    });
    expect(first.isActive()).toBe(false);
    expect(firstRun).toHaveLength(2);
    expect(first.pendingDeliveries()).toEqual([{
      chatId: "42",
      state: "failed",
      parts: 3,
      unsent: 2,
      updatedAt: expect.any(Number),
    }]);
    expect(outboxFiles()).toHaveLength(1);
    await first.shutdown();

    stage = "retry";
    const restarted = new Outbound(() => ({ ...defaultAccess(), allowFrom: ["42"], streaming: false }));
    restarted.setToken("secret");
    expect(await restarted.retryFailed("42")).toEqual({ sent: 2, failed: 0, uncertain: 0 });
    expect(retryRun).toHaveLength(2);
    expect(retryRun).not.toContain(firstRun[0]);
    expect(outboxFiles()).toEqual([]);
    await restarted.shutdown();
  });

  test("requires explicit opt-in before retrying an ambiguous send", async () => {
    globalThis.fetch = (async (url) => {
      const method = String(url).split("/").pop()!;
      if (method === "sendMessage") throw new TypeError("network timeout");
      return new Response(JSON.stringify({ ok: true, result: {} }));
    }) as typeof fetch;
    const first = new Outbound(() => ({ ...defaultAccess(), allowFrom: ["42"], streaming: false }));
    first.setToken("secret");
    first.markActive("42");
    await expect(first.onTurnEnd(assistant("answer"))).rejects.toMatchObject({ state: "uncertain", sentIds: [] });
    expect(outboxFiles()).toHaveLength(1);
    expect(first.pendingDeliveries()).toEqual([{
      chatId: "42",
      state: "uncertain",
      parts: 1,
      unsent: 1,
      updatedAt: expect.any(Number),
    }]);
    await first.shutdown();

    let retries = 0;
    globalThis.fetch = (async (url) => {
      if (String(url).endsWith("/sendMessage")) retries += 1;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 91 } }));
    }) as typeof fetch;
    const warnings: string[] = [];
    const restarted = new Outbound(
      () => ({ ...defaultAccess(), allowFrom: ["42"], streaming: false }),
      {
        debug: () => {},
        info: () => {},
        warn: (message) => warnings.push(message),
        error: () => {},
      },
    );
    restarted.setToken("secret");
    expect(await restarted.retryFailed("42")).toEqual({ sent: 0, failed: 0, uncertain: 1 });
    expect(retries).toBe(0);
    expect(await restarted.retryFailed("42", undefined, { includeUncertain: true })).toEqual({
      sent: 1,
      failed: 0,
      uncertain: 1,
    });
    expect(retries).toBe(1);
    expect(warnings.some((message) => message.includes("may already have accepted"))).toBe(true);
    expect(outboxFiles()).toEqual([]);
    await restarted.shutdown();
  });

  test("a 9k answer is delivered whole, as labelled consecutive parts", async () => {
    const sent: string[] = [];
    globalThis.fetch = (async (url, init) => {
      const method = String(url).split("/").pop()!;
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (method === "sendMessage") sent.push(String(payload.text));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 50 } }), { status: 200 });
    }) as typeof fetch;

    const outbound = new Outbound(() => ({ ...defaultAccess(), allowFrom: ["42"], streaming: false }));
    outbound.setToken("secret");
    outbound.markActive("42");
    const text = prose(9000);
    await outbound.onTurnEnd(assistant(text));
    await outbound.onAgentEnd();

    expect(sent.length).toBe(3);
    expect(sent.every((part) => part.length <= 4096)).toBe(true);
    expect(sent.map((part) => /^\\\((\d)\/(\d)\\\)\n/.exec(part)?.slice(1).join("/"))).toEqual(["1/3", "2/3", "3/3"]);
    expect(sent.map(unlabel).join("")).toBe(text);
    await outbound.shutdown();
  });

  test("a short answer carries no part label", async () => {
    const sent: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sent.push(String(payload.text));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 51 } }), { status: 200 });
    }) as typeof fetch;

    const outbound = new Outbound(() => ({ ...defaultAccess(), allowFrom: ["42"], streaming: false }));
    outbound.setToken("secret");
    await outbound.send("42", "short answer");
    expect(sent).toEqual(["short answer"]);
    await outbound.shutdown();
  });

  test("a rate-limited part is retried instead of dropping the rest of the answer", async () => {
    const sent: string[] = [];
    const waits: number[] = [];
    let limited = false;
    globalThis.fetch = (async (url, init) => {
      const method = String(url).split("/").pop()!;
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (method !== "sendMessage") return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
      if (!limited && String(payload.text).startsWith("\\(2/3\\)")) {
        limited = true;
        return new Response(
          JSON.stringify({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 3 } }),
          { status: 200 },
        );
      }
      sent.push(String(payload.text));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 52 } }), { status: 200 });
    }) as typeof fetch;

    const outbound = new Outbound(
      () => ({ ...defaultAccess(), allowFrom: ["42"], streaming: false }),
      undefined,
      async (ms) => {
        waits.push(ms);
      },
    );
    outbound.setToken("secret");
    outbound.markActive("42");
    const text = prose(9000);
    await outbound.onTurnEnd(assistant(text));

    expect(limited).toBe(true);
    expect(waits).toEqual([3250]);
    expect(sent.length).toBe(3);
    expect(sent.map(unlabel).join("")).toBe(text);
    await outbound.shutdown();
  });

  test("an overflowed stream turn reads as one numbered answer, delivered once", async () => {
    // Model the chat: sends append a message, edits replace one in place.
    const chat = new Map<number, string>();
    let nextId = 60;
    globalThis.fetch = (async (url, init) => {
      const method = String(url).split("/").pop()!;
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (method === "sendMessage") chat.set(++nextId, String(payload.text));
      if (method === "editMessageText") chat.set(Number(payload.message_id), String(payload.text));
      return new Response(JSON.stringify({ ok: true, result: { message_id: nextId } }), { status: 200 });
    }) as typeof fetch;

    const outbound = new Outbound(() => ({ ...defaultAccess(), allowFrom: ["-100"], streaming: true }));
    outbound.setToken("secret");
    setSystemTime(new Date(1_000_000));
    outbound.markActive("-100", 3); // group chat -> edit-based preview, not drafts
    const text = prose(9000);

    outbound.onMessageUpdate(assistant(text.slice(0, 500)));
    await flush();
    setSystemTime(new Date(1_000_000 + 5_000)); // past the edit throttle
    outbound.onMessageUpdate(assistant(text)); // overflows: commits the head, drops the preview
    await flush();
    await outbound.onTurnEnd(assistant(text));
    await outbound.onAgentEnd();

    const messages = [...chat.values()];
    expect(messages.length).toBe(3);
    // The head committed mid-stream is numbered too, once the total is known.
    expect(messages.map((m) => /^\\\((\d)\/(\d)\\\)\n/.exec(m)?.slice(1).join("/"))).toEqual(["1/3", "2/3", "3/3"]);
    expect(messages.map(unlabel).join("")).toBe(text); // every source char exactly once
    await outbound.shutdown();
  });
});

describe("Outbound rich Markdown", () => {
  const table = "| Name | State |\n| --- | --- |\n| build | ready |";
  type Payload = {
    chat_id?: string;
    text?: string;
    parse_mode?: string;
    message_id?: number;
    message_thread_id?: number;
    reply_parameters?: { message_id: number };
    rich_message?: { markdown: string };
    draft_id?: number;
  };
  type Call = { method: string; payload: Payload };
  const rejected = (code: number, description = "rejected"): Response =>
    new Response(JSON.stringify({ ok: false, error_code: code, description, parameters: code === 429 ? { retry_after: 1 } : undefined }));

  function wire(over: Partial<Access> = {}, reject?: (call: Call) => Response | undefined) {
    const calls: Call[] = [];
    const chat = new Map<number, string>();
    const waits: number[] = [];
    let id = 0;
    globalThis.fetch = (async (url, init) => {
      const call = { method: String(url).split("/").pop()!, payload: JSON.parse(String(init?.body)) as Payload };
      calls.push(call);
      const error = reject?.(call);
      if (error) return error;
      const { method, payload } = call;
      const body = payload.rich_message?.markdown ?? payload.text ?? "";
      if (method === "sendMessage" || method === "sendRichMessage") chat.set(++id, body);
      if (method === "editMessageText") chat.set(payload.message_id!, body);
      return new Response(JSON.stringify({ ok: true, result: { message_id: id } }));
    }) as typeof fetch;
    const outbound = new Outbound(() => ({ ...defaultAccess(), richMessages: "auto", ...over }), undefined, async (ms) => { waits.push(ms); });
    outbound.setToken("111:rich-test");
    return { outbound, calls, chat, waits };
  }

  test("auto preserves rich source, topic and reply while off and literal text bypass rich", async () => {
    const rich = wire();
    expect(await rich.outbound.send("42", table, { replyTo: 3, threadId: 9 })).toEqual([1]);
    expect(rich.calls).toEqual([{ method: "sendRichMessage", payload: {
      chat_id: "42", rich_message: { markdown: table }, message_thread_id: 9, reply_parameters: { message_id: 3 },
    } }]);
    for (const [richMessages, format, body] of [
      ["off", "markdown", mdToMarkdownV2(table)],
      ["on", "text", table],
    ] as const) {
      const w = wire({ richMessages });
      await w.outbound.send("42", table, { format });
      expect(w.calls[0].method).toBe("sendMessage");
      expect([...w.chat.values()]).toEqual([body]);
      expect(w.calls[0].payload.parse_mode).toBe(format === "markdown" ? "MarkdownV2" : undefined);
    }
    for (const text of ["**bold**", "```\n- [x] code\n```", "`<details>`"]) {
      const w = wire();
      await w.outbound.send("42", text);
      expect(w.calls[0].method).toBe("sendMessage");
      expect([...w.chat.values()]).toEqual([mdToMarkdownV2(text)]);
    }
    const empty = wire({ richMessages: "on" });
    expect(await empty.outbound.send("42", "")).toEqual([]);
    expect(empty.calls).toEqual([]);
  });

  test.each([400, 404])("rich rejection %s falls back with original source and routing", async (code) => {
    const w = wire({}, ({ method }) => method === "sendRichMessage" ? rejected(code) : undefined);
    expect(await w.outbound.send("42", table, { replyTo: 3, threadId: 9 })).toEqual([1]);
    expect([...w.chat.values()]).toEqual([mdToMarkdownV2(table)]);
    expect(w.calls.map((c) => c.method)).toEqual(["sendRichMessage", "sendMessage"]);
    expect(w.calls[1].payload).toMatchObject({ message_thread_id: 9, reply_parameters: { message_id: 3 }, parse_mode: "MarkdownV2" });
    const plain = wire({}, ({ method, payload }) => method === "sendRichMessage" || payload.parse_mode ? rejected(code === 404 && method === "sendRichMessage" ? 404 : 400) : undefined);
    await plain.outbound.send("42", table, { replyTo: 3, threadId: 9 });
    expect([...plain.chat.values()]).toEqual([table]);
    expect(plain.calls.at(-1)?.payload).toEqual({ chat_id: "42", text: table, message_thread_id: 9, reply_parameters: { message_id: 3 } });
  });

  test("rich rate limits retry one delivery; ambiguous and authorization failures never resend", async () => {
    let limited = false;
    const w = wire({}, () => { if (!limited) { limited = true; return rejected(429); } });
    await w.outbound.send("42", table);
    expect(w.waits).toEqual([1250]);
    expect([...w.chat.values()]).toEqual([table]);
    expect(w.calls.map((c) => c.method)).toEqual(["sendRichMessage", "sendRichMessage"]);
    for (const failure of [401, 403, 500, 429, "timeout"] as const) {
      const failed = wire({}, () => {
        if (failure === "timeout") throw new Error("network timeout");
        return rejected(failure);
      });
      await expect(failed.outbound.send("42", table)).rejects.toThrow();
      expect(failed.chat.size).toBe(0);
      expect(failed.calls.every((c) => c.method === "sendRichMessage")).toBe(true);
    }
  });

  test("whole rich reports use the larger budget and definitive rejection re-splits once", async () => {
    const source = table + "\n" + "report ".repeat(850);
    const rich = wire();
    expect(await rich.outbound.send("42", source)).toEqual([1]);
    expect([...rich.chat.values()]).toEqual([source]);
    for (const code of [400, 404]) {
      const w = wire({ chunkMode: "length" }, ({ method, payload }) =>
        method === "sendRichMessage" ? rejected(code) : payload.parse_mode ? rejected(400) : undefined);
      expect(await w.outbound.send("42", source, { replyTo: 3, threadId: 9 })).toEqual([1, 2]);
      expect(w.calls.filter((c) => c.method === "sendRichMessage")).toHaveLength(1);
      const messages = [...w.chat.values()];
      expect(messages.map((m) => m.match(/^\((\d\/\d)\)\n/)?.[1])).toEqual(["1/2", "2/2"]);
      expect(messages.every((m) => m.length <= 4096)).toBe(true);
      expect(messages.map((m) => m.replace(/^\(\d+\/\d+\)\n/, "")).join("")).toBe(source);
      expect(w.calls.filter((c) => c.method === "sendMessage").every((c) => c.payload.text!.length <= 4096)).toBe(true);
      expect(w.calls.every((c) => c.payload.message_thread_id === 9)).toBe(true);
      expect(w.calls.at(-1)?.payload.reply_parameters).toBeUndefined();
    }
  });

  test("explicit caps and over-budget sources keep labeled chunks and reply modes", async () => {
    for (const [textChunkLimit, count, replyToMode] of [[1000, 1400, "all"], [undefined, 17000, "off"]] as const) {
      const source = "日🌱".repeat(count);
      const w = wire({ richMessages: "on", textChunkLimit, chunkMode: "length", replyToMode });
      const ids = await w.outbound.send("42", source, { replyTo: 3 });
      const messages = [...w.chat.values()];
      expect(ids).toEqual([...w.chat.keys()]);
      expect(messages.length).toBeGreaterThan(1);
      expect(messages.every((m) => m.length <= (textChunkLimit ?? 4096))).toBe(true);
      expect(messages.map((m, i) => m.startsWith(`(${i + 1}/${messages.length})\n`))).toEqual(messages.map(() => true));
      expect(messages.map((m) => m.replace(/^\(\d+\/\d+\)\n/, "")).join("")).toBe(source);
      expect(w.calls.every((c) => c.payload.reply_parameters?.message_id === (replyToMode === "all" ? 3 : undefined))).toBe(true);
    }
    const fence = wire({ richMessages: "on", textChunkLimit: 1000 });
    await fence.outbound.send("42", "```ts\n" + "const value = 1;\n".repeat(180) + "```");
    expect([...fence.chat.values()].every((m) => (m.match(/```/g) ?? []).length % 2 === 0)).toBe(true);
    expect([...fence.chat.values()].join("\n").match(/const value = 1;/g)).toHaveLength(180);
  });

  test("topic recovery is shared by whole rich and legacy fallback sends", async () => {
    const w = wire({}, ({ method, payload }) => {
      if (payload.message_thread_id === 9) return rejected(400, "Bad Request: message thread not found");
      if (method === "sendRichMessage") return rejected(404);
    });
    const recovered: number[] = [];
    w.outbound.setMissingThreadHandler(async (_chat, thread) => { recovered.push(thread); return 10; });
    expect(await w.outbound.send("42", table, { threadId: 9, replyTo: 4 })).toEqual([1]);
    expect(recovered).toEqual([9]);
    expect(w.calls.map((c) => [c.method, c.payload.message_thread_id])).toEqual([
      ["sendRichMessage", 9], ["sendRichMessage", 10], ["sendMessage", 10],
    ]);
    expect(w.calls.at(-1)?.payload.reply_parameters).toEqual({ message_id: 4 });
    const failed = wire({}, ({ method }) => rejected(400, method === "sendRichMessage" ? "rich parse error" : "message thread not found"));
    let recoveries = 0;
    failed.outbound.setMissingThreadHandler(async () => { recoveries++; return 10; });
    await expect(failed.outbound.send("42", table, { threadId: 9 })).rejects.toThrow();
    expect(recoveries).toBe(1);
    expect(failed.calls.map((c) => c.method)).toEqual(["sendRichMessage", "sendMessage", "sendMessage"]);
  });

  test("DM drafts finalize once as rich and send no draft after the reply", async () => {
    const source = table + "\n" + "report ".repeat(850);
    const w = wire();
    try {
      w.outbound.markActive("42", 9);
      w.outbound.onMessageUpdate(assistant(source));
      await w.outbound.onTurnEnd(assistant(source));
      await w.outbound.onAgentEnd(source);
      expect([...w.chat.values()]).toEqual([source]);
      const methods = w.calls.map((c) => c.method);
      const drafts = w.calls.filter((c) => c.method === "sendMessageDraft");
      expect(drafts).toHaveLength(1);
      expect(drafts[0].payload.text).toBe(source.slice(-4096));
      // Any draft after the final send re-shows a stale preview under the reply.
      expect(methods.lastIndexOf("sendMessageDraft")).toBeLessThan(methods.indexOf("sendRichMessage"));
      expect(drafts[0].payload.message_thread_id).toBe(9);
      expect(w.calls.filter((c) => c.method === "sendRichMessage")).toHaveLength(1);
    } finally { await w.outbound.shutdown(); }
  });

  test("a partial update delivered after its turn ended cannot send a second, shorter reply", async () => {
    // omp queues message_update for extensions without awaiting it, so a stale
    // snapshot of an already-finalized message can arrive after turn_end.
    const stamped = (text: string): unknown => ({ role: "assistant", content: [{ type: "text", text }], timestamp: 1_000 });
    const w = wire({ richMessages: "off" });
    try {
      w.outbound.markActive("42", 9);
      await w.outbound.onTurnEnd(stamped("Answer.\n\nStatus: done."));
      w.outbound.onMessageUpdate(stamped("Answer."));
      await flush();
      await w.outbound.onAgentEnd("Answer.\n\nStatus: done.");
      expect([...w.chat.values()]).toEqual([mdToMarkdownV2("Answer.\n\nStatus: done.")]);
    } finally { await w.outbound.shutdown(); }
  });

  test("agent_end arriving while the turn_end send is in flight sends the reply once", async () => {
    // Observed live: turn_end and agent_end handlers overlap, and the run-end
    // flush re-sent the still-dirty turn (with the throttled partial preview).
    const stamped = (text: string): unknown => ({ role: "assistant", content: [{ type: "text", text }], timestamp: 2_000 });
    const w = wire({ richMessages: "off" });
    try {
      w.outbound.markActive("42", 9);
      w.outbound.onMessageUpdate(stamped("Answer."));
      const turnEnd = w.outbound.onTurnEnd(stamped("Answer.\n\nStatus: done."));
      const agentEnd = w.outbound.onAgentEnd("Answer.\n\nStatus: done.");
      await Promise.all([turnEnd, agentEnd]);
      expect(w.calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);
      expect([...w.chat.values()]).toEqual([mdToMarkdownV2("Answer.\n\nStatus: done.")]);
    } finally { await w.outbound.shutdown(); }
  });

  test("a seen message switches to replied only after a reply reaches its chat", async () => {
    const reactions = (calls: Array<{ method: string; payload: { reaction?: unknown } }>): unknown[] =>
      calls.filter((c) => c.method === "setMessageReaction").map((c) => c.payload.reaction);
    const seen = [{ type: "emoji", emoji: "👀" }];
    const replied = [{ type: "emoji", emoji: "👍" }];

    const w = wire({ richMessages: "off", streaming: "final" });
    try {
      w.outbound.markActive("42", 9);
      await w.outbound.markSeen("42", 9, 7);
      await w.outbound.onAgentEnd("Answer.");
      expect(reactions(w.calls)).toEqual([seen, replied]);
      expect(w.calls.at(-1)?.payload).toMatchObject({ chat_id: "42", message_id: 7 });
    } finally { await w.outbound.shutdown(); }

    const failed = wire({ richMessages: "off", streaming: "final" }, ({ method }) => method === "sendMessage" ? rejected(403, "forbidden") : undefined);
    try {
      failed.outbound.markActive("42", 9);
      await failed.outbound.markSeen("42", 9, 7);
      await expect(failed.outbound.onAgentEnd("Answer.")).rejects.toThrow();
      expect(reactions(failed.calls)).toEqual([seen]);
    } finally { await failed.outbound.shutdown(); }
  });

  test("a slow seen reaction cannot land after the replied reaction", async () => {
    // Telegram replaces a message's reactions, so 👀 finishing last would undo 👍.
    const w = wire({ richMessages: "off", streaming: "final" });
    const fastFetch = globalThis.fetch;
    let releaseSeen!: () => void;
    const seenGate = new Promise<void>((resolve) => (releaseSeen = resolve));
    const settled: string[] = [];
    globalThis.fetch = (async (url, init) => {
      const payload = JSON.parse(String(init?.body)) as { reaction?: Array<{ emoji: string }> };
      const emoji = payload.reaction?.[0]?.emoji;
      if (emoji === "👀") await seenGate;
      const response = await fastFetch(url, init);
      if (emoji) settled.push(emoji);
      return response;
    }) as typeof fetch;
    try {
      w.outbound.markActive("42", 9);
      void w.outbound.markSeen("42", 9, 7);
      const end = w.outbound.onAgentEnd("Answer.");
      await flush();
      expect(settled).toEqual([]);
      releaseSeen();
      await end;
      expect(settled).toEqual(["👀", "👍"]);
    } finally { await w.outbound.shutdown(); }
  });

  test("replied lands at the answering turn, not only when a long run ends", async () => {
    const emojis = (calls: Array<{ method: string; payload: { reaction?: Array<{ emoji: string }>; message_id?: number } }>) =>
      calls.filter((c) => c.method === "setMessageReaction").map((c) => `${c.payload.message_id}:${c.payload.reaction?.[0]?.emoji}`);
    const turn = (text: string, timestamp: number): unknown => ({ role: "assistant", content: [{ type: "text", text }], timestamp });
    const w = wire({ richMessages: "off" });
    try {
      setSystemTime(new Date(1_000));
      w.outbound.markActive("42", 9);
      await w.outbound.markSeen("42", 9, 7);
      // Message 8 arrives while the turn answering 7 (started at 2_000) streams.
      setSystemTime(new Date(3_000));
      await w.outbound.markSeen("42", 9, 8);
      await w.outbound.onTurnEnd(turn("Answer to 7.", 2_000));
      expect(emojis(w.calls)).toEqual(["7:👀", "8:👀", "7:👍"]);

      await w.outbound.onTurnEnd(turn("Answer to 8.", 4_000));
      expect(emojis(w.calls)).toEqual(["7:👀", "8:👀", "7:👍", "8:👍"]);
      await w.outbound.onAgentEnd("Answer to 8.");
      expect(emojis(w.calls)).toHaveLength(4);
    } finally { await w.outbound.shutdown(); }
  });

  test("a message that arrives after the last reply keeps 👀 when the run ends", async () => {
    const w = wire({ richMessages: "off" });
    try {
      setSystemTime(new Date(1_000));
      w.outbound.markActive("42", 9);
      await w.outbound.markSeen("42", 9, 7);
      await w.outbound.onTurnEnd({ role: "assistant", content: [{ type: "text", text: "Answer to 7." }], timestamp: 2_000 });
      setSystemTime(new Date(5_000));
      await w.outbound.markSeen("42", 9, 8);
      await w.outbound.onAgentEnd("Answer to 7.");
      const reactions = w.calls
        .filter((c) => c.method === "setMessageReaction")
        .map((c) => `${c.payload.message_id}:${(c.payload as { reaction?: Array<{ emoji: string }> }).reaction?.[0]?.emoji}`);
      expect(reactions).toEqual(["7:👀", "7:👍", "8:👀"]);
    } finally { await w.outbound.shutdown(); }
  });

  test("overflowed group previews retain every segment once with final rich labels", async () => {
    const source = table + "\n" + "report ".repeat(1400);
    const w = wire({ richMessages: "on", chunkMode: "length" });
    try {
      setSystemTime(new Date(1_000_000));
      w.outbound.markActive("-100", 9);
      w.outbound.onMessageUpdate(assistant(source.slice(0, 500)));
      await flush();
      setSystemTime(new Date(1_005_000));
      w.outbound.onMessageUpdate(assistant(source));
      await flush();
      await w.outbound.onTurnEnd(assistant(source));
      await w.outbound.onAgentEnd();
      const messages = [...w.chat.values()];
      expect(messages).toHaveLength(3);
      expect(messages.map((m, i) => m.startsWith(`(${i + 1}/3)\n`))).toEqual([true, true, true]);
      expect(messages.map((m) => m.replace(/^\(\d+\/\d+\)\n/, "")).join("")).toBe(source);
      expect(messages.some((m) => m.includes("▍"))).toBe(false);
      expect(w.calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);
      expect(w.calls.filter((c) => c.payload.rich_message).every((c) => !c.payload.text && !c.payload.parse_mode)).toBe(true);
    } finally { await w.outbound.shutdown(); }
  });

  test("rich edit rejection falls back in place and not-modified never strips formatting", async () => {
    for (const error of [400, 404, "not modified"] as const) {
      const w = wire({}, ({ method, payload }) => {
        if (method === "editMessageText" && payload.rich_message) {
          return rejected(typeof error === "number" ? error : 400, error === "not modified" ? "Bad Request: message is not modified" : "rich unsupported");
        }
      });
      try {
        w.outbound.markActive("-100", 9);
        w.outbound.onMessageUpdate(assistant(table));
        await w.outbound.onTurnEnd(assistant(table));
        await w.outbound.onAgentEnd();
        expect(w.chat.size).toBe(1);
        expect(w.calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);
        expect(w.calls.some((c) => c.method === "sendRichMessage")).toBe(false);
        const edits = w.calls.filter((c) => c.method === "editMessageText");
        expect(edits).toHaveLength(error === "not modified" ? 1 : 2);
        if (error !== "not modified") expect([...w.chat.values()]).toEqual([mdToMarkdownV2(table)]);
      } finally { await w.outbound.shutdown(); }
    }
  });

  test("finalization recovers missing topics and keeps rejected rich fallback disabled", async () => {
    for (const richRejected of [false, true]) {
      const w = wire({ streaming: false }, ({ method, payload }) => {
        if (method === "sendChatAction") return;
        if (richRejected && method === "sendRichMessage") return rejected(404);
        if (payload.message_thread_id === 9) return rejected(400, "message thread not found");
      });
      let recoveries = 0;
      w.outbound.setMissingThreadHandler(async () => { recoveries++; return 10; });
      try {
        w.outbound.markActive("42", 9);
        await w.outbound.onTurnEnd(assistant(table));
        await w.outbound.onAgentEnd();
        expect(recoveries).toBe(1);
        expect([...w.chat.values()]).toEqual([richRejected ? mdToMarkdownV2(table) : table]);
        expect(w.calls.at(-1)?.payload.message_thread_id).toBe(10);
        expect(w.calls.filter((c) => c.method === "sendRichMessage")).toHaveLength(richRejected ? 1 : 2);
      } finally { await w.outbound.shutdown(); }
    }
  });

  test("explicit and daemon gates stay silent while explicit sends honor rich mode", async () => {
    for (const over of [{ streaming: "explicit" }, { profile: "daemon", streaming: true }] as const) {
      const w = wire(over);
      try {
        w.outbound.markActive("42");
        w.outbound.onMessageUpdate(assistant(table));
        await w.outbound.onTurnEnd(assistant(table));
        await w.outbound.onAgentEnd(table);
        expect(w.calls.filter((c) => c.method !== "sendChatAction")).toEqual([]);
        await w.outbound.send("42", table);
        expect([...w.chat.values()]).toEqual([table]);
        expect(w.calls.at(-1)?.method).toBe("sendRichMessage");
      } finally { await w.outbound.shutdown(); }
    }
    const boundary = wire({ richMessages: "on" });
    try {
      boundary.outbound.markActive("-100", 9);
      boundary.outbound.onMessageUpdate(assistant(table));
      await boundary.outbound.onSessionBoundary();
      expect([...boundary.chat.values()]).toEqual([table]);
      expect(boundary.calls.some((c) => c.payload.rich_message || c.payload.parse_mode)).toBe(false);
    } finally { await boundary.outbound.shutdown(); }
  });
});
