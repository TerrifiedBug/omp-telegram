import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Poller, TgError, acquireLock, downloadFileBytes, releaseLock, tg, webhookConflictHint } from "./api";

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

  test("reports a configured webhook as the likely polling conflict", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, result: { url: "https://example.test/hook" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    await expect(webhookConflictHint("secret")).resolves.toContain("https://example.test/hook");
  });

  test("returns no conflict hint when webhook delivery is disabled", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, result: { url: "" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    await expect(webhookConflictHint("secret")).resolves.toBeUndefined();
  });

  test("polls edited messages and advances the update offset", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const poller = new Poller();
    globalThis.fetch = (async (_url, init) => {
      payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (payloads.length > 1) {
        poller.stop();
        return new Response(JSON.stringify({ ok: true, result: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          ok: true,
          result: [{ update_id: 12, edited_message: { message_id: 1, date: 1, chat: { id: 42, type: "private" }, text: "edited" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    let handled = false;

    poller.start(
      "secret",
      (update) => {
        handled = update.edited_message?.text === "edited";
      },
      () => {},
    );
    await poller.done();

    expect(handled).toBe(true);
    expect(payloads[0].allowed_updates).toEqual(["message", "edited_message", "callback_query"]);
    expect(payloads[1].offset).toBe(13);
  });
});

describe("single-poller lock", () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omp-tg-lock-"));
    lockPath = join(dir, "bot.lock");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a live foreign holder blocks a second starter without clobbering the lock", () => {
    expect(acquireLock(lockPath, { pid: 1001, alive: () => true })).toEqual({ ok: true });
    expect(readFileSync(lockPath, "utf8")).toBe("1001");
    expect(acquireLock(lockPath, { pid: 1002, alive: () => true })).toEqual({ ok: false, holder: 1001 });
    expect(readFileSync(lockPath, "utf8")).toBe("1001"); // loser must not overwrite the owner
  });

  test("re-acquiring with the same pid is idempotent", () => {
    acquireLock(lockPath, { pid: 1001, alive: () => true });
    expect(acquireLock(lockPath, { pid: 1001, alive: () => true })).toEqual({ ok: true });
  });

  test("a stale (dead) holder is reclaimed", () => {
    acquireLock(lockPath, { pid: 1001, alive: () => true });
    expect(acquireLock(lockPath, { pid: 1002, alive: (p) => p !== 1001 })).toEqual({ ok: true });
    expect(readFileSync(lockPath, "utf8")).toBe("1002");
  });

  test("releaseLock removes the lock only for its owner", () => {
    acquireLock(lockPath, { pid: 1001, alive: () => true });
    releaseLock(lockPath, 2002); // not the owner
    expect(existsSync(lockPath)).toBe(true);
    releaseLock(lockPath, 1001); // owner
    expect(existsSync(lockPath)).toBe(false);
  });

  test("backs off when another reclaimer holds a fresh reaper", () => {
    writeFileSync(lockPath, "1001"); // stale main lock (1001 dead)
    const reapPath = `${lockPath}.reap`;
    writeFileSync(reapPath, "1002"); // a live reclaimer is mid-reclaim
    expect(acquireLock(lockPath, { pid: 1003, alive: (p) => p === 1002 })).toEqual({ ok: false, holder: 1001 });
    expect(readFileSync(lockPath, "utf8")).toBe("1001"); // main untouched
    expect(readFileSync(reapPath, "utf8")).toBe("1002"); // fresh reaper untouched
  });

  test("clears an abandoned reaper and reclaims the stale lock", () => {
    writeFileSync(lockPath, "1001"); // stale main lock
    const reapPath = `${lockPath}.reap`;
    writeFileSync(reapPath, "1002"); // reaper left by a crashed reclaimer
    const aged = new Date(Date.now() - 60_000);
    utimesSync(reapPath, aged, aged); // age it past the reaper TTL
    expect(acquireLock(lockPath, { pid: 1003, alive: () => false })).toEqual({ ok: true });
    expect(readFileSync(lockPath, "utf8")).toBe("1003");
    expect(existsSync(reapPath)).toBe(false); // reaper released by its new owner
  });

  // Real cross-process contention via a static child fixture, coordinated over
  // event-driven Bun IPC (no polling, no timers): every child announces `ready`,
  // the parent releases them together with `go`, collects each result, then sends
  // `release` so the winner drops the lock. The winner stays alive until then, so
  // losers always observe a live holder.
  const raceForLock = async (n: number): Promise<string[]> => {
    const fixture = join(import.meta.dirname, "lock-race-fixture.ts");
    const results: string[] = [];
    let ready = 0;
    const allReady = Promise.withResolvers<void>();
    const allResults = Promise.withResolvers<void>();
    const procs = Array.from({ length: n }, () =>
      Bun.spawn([process.execPath, fixture, lockPath], {
        stdout: "ignore",
        stderr: "ignore",
        ipc(message: unknown) {
          if (message === "ready") {
            if (++ready === n) allReady.resolve();
          } else {
            results.push(String(message));
            if (results.length === n) allResults.resolve();
          }
        },
      }),
    );
    await allReady.promise; // barrier: every child is at the start line
    for (const p of procs) p.send("go"); // release them together
    await allResults.promise; // every child has decided
    for (const p of procs) p.send("release"); // let the winner drop the lock
    await Promise.all(procs.map((p) => p.exited));
    return results;
  };

  test("concurrent starters: exactly one wins a free lock", async () => {
    const results = await raceForLock(8);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "no")).toHaveLength(7);
  });

  test("concurrent starters: exactly one reclaims a stale lock", async () => {
    const doomed = Bun.spawn([process.execPath, "-e", ""]); // exits at once → its PID is dead when the race runs
    await doomed.exited;
    writeFileSync(lockPath, String(doomed.pid));
    const results = await raceForLock(8);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "no")).toHaveLength(7);
  });
});
