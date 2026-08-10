import { afterEach, test, expect, describe, setSystemTime } from "bun:test";
import { defaultAccess } from "./access";
import { Outbound, assistantText, finalAssistantText } from "./outbound";

const assistant = (text: string): unknown => ({ role: "assistant", content: [{ type: "text", text }] });
const toolResult = (): unknown => ({ role: "toolResult", content: [{ type: "text", text: "tool output" }] });
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  setSystemTime();
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
    outbound.shutdown();
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
    outbound.shutdown();
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
    outbound.shutdown();
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
    outbound.shutdown();
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
  /** Flush pending microtasks — the fetch double resolves without real I/O. */
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 200; i++) await Promise.resolve();
  };

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
    outbound.shutdown();
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
    outbound.shutdown();
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
    outbound.shutdown();
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
    outbound.shutdown();
  });
});
