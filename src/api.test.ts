import { afterEach, describe, expect, test } from "bun:test";
import { TgError, downloadFileBytes, tg } from "./api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Telegram Bot API transport", () => {
  test("posts JSON and returns the Telegram result", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 17 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await expect(tg<{ message_id: number }>("secret", "sendMessage", { chat_id: "42", text: "hello" })).resolves.toEqual({ message_id: 17 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.endsWith("/botsecret/sendMessage")).toBe(true);
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ chat_id: "42", text: "hello" });
  });

  test("surfaces Telegram error code and retry delay", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 3 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    try {
      await tg("secret", "sendMessage", { chat_id: "42", text: "hello" });
      throw new Error("expected tg to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(TgError);
      expect((error as TgError).code).toBe(429);
      expect((error as TgError).retryAfter).toBe(3);
      expect((error as TgError).message).toBe("Too Many Requests");
    }
  });

  test("downloads exact file bytes and rejects HTTP failures", async () => {
    globalThis.fetch = (async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as typeof fetch;
    await expect(downloadFileBytes("secret", "documents/a.bin")).resolves.toEqual(new Uint8Array([1, 2, 3]));

    globalThis.fetch = (async () => new Response("missing", { status: 404 })) as typeof fetch;
    await expect(downloadFileBytes("secret", "documents/missing.bin")).rejects.toMatchObject({ code: 404 });
  });
});
