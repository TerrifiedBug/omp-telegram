import { afterEach, test, expect, describe } from "bun:test";
import { defaultAccess } from "./access";
import { Outbound, assistantText, finalAssistantText } from "./outbound";

const assistant = (text: string): unknown => ({ role: "assistant", content: [{ type: "text", text }] });
const toolResult = (): unknown => ({ role: "toolResult", content: [{ type: "text", text: "tool output" }] });
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
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
    outbound.shutdown();
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
    outbound.shutdown();
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
    outbound.shutdown();
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
    outbound.shutdown();
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
    outbound.shutdown();
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
    outbound.shutdown();
  });
});
