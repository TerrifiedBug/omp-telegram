import { describe, expect, test } from "bun:test";
import { type Access, defaultAccess, notifyTarget } from "./access";
import { type AskSurface, buildPromptTarget, raceAskSurfaces } from "./index";
import { PROMPT_SUPERSEDED } from "./prompts";

const mk = (over: Partial<Access>): Access => ({ ...defaultAccess(), ...over });

describe("buildPromptTarget", () => {
  test("routes a paired owner's DM notify chat", () => {
    const access = mk({ allowFrom: ["42"] });
    expect(buildPromptTarget({ chatId: "42" }, access)).toEqual({ responderId: "42", chatId: "42", chatType: "private" });
  });

  test("preserves the forum thread id", () => {
    const access = mk({ allowFrom: ["42"], topicsChat: "42" });
    expect(buildPromptTarget({ chatId: "42", threadId: 7 }, access)).toEqual({
      responderId: "42",
      chatId: "42",
      chatType: "private",
      threadId: 7,
    });
  });

  test("routes a configured group topic", () => {
    const access = mk({ allowFrom: ["42"], groups: { "-100999": { requireMention: false, allowFrom: [] } } });
    expect(buildPromptTarget({ chatId: "-100999", threadId: 3 }, access)).toEqual({
      responderId: "42",
      chatId: "-100999",
      chatType: "supergroup",
      threadId: 3,
    });
  });

  test("declines a DM that is not the owner's own chat", () => {
    // A bot DM's chat_id equals the user id, so a chat that isn't the owner can't be answered by them.
    expect(buildPromptTarget({ chatId: "999" }, mk({ allowFrom: ["42"] }))).toBeUndefined();
  });

  test("declines an unconfigured group", () => {
    expect(buildPromptTarget({ chatId: "-100999" }, mk({ allowFrom: ["42"] }))).toBeUndefined();
  });

  test("declines when there is no single paired owner", () => {
    expect(buildPromptTarget({ chatId: "42" }, mk({ allowFrom: [] }))).toBeUndefined();
    expect(buildPromptTarget({ chatId: "42" }, mk({ allowFrom: ["42", "43"] }))).toBeUndefined();
  });

  test("declines a missing destination", () => {
    expect(buildPromptTarget(undefined, mk({ allowFrom: ["42"] }))).toBeUndefined();
  });

  // Mirrors how before_agent_start resolves the away/always destination.
  test("composes with notifyTarget the way the away branch does", () => {
    const dm = mk({ allowFrom: ["42"], notifyChat: "42", notifyMode: "away" });
    expect(buildPromptTarget(notifyTarget(false, dm, true), dm)).toEqual({ responderId: "42", chatId: "42", chatType: "private" });

    const topic = mk({ allowFrom: ["42"], topicsChat: "42", notifyMode: "always" });
    expect(buildPromptTarget(notifyTarget(false, topic, true, { chatId: "42", threadId: 9 }), topic)).toEqual({
      responderId: "42",
      chatId: "42",
      chatType: "private",
      threadId: 9,
    });

    const off = mk({ allowFrom: ["42"], notifyChat: "42" });
    expect(buildPromptTarget(notifyTarget(false, off, true), off)).toBeUndefined();
  });
});

describe("raceAskSurfaces", () => {
  const pending = <R>(): AskSurface<R> => ({ run: () => new Promise<R | undefined>(() => {}) });

  test("takes the first decision and aborts the losers as superseded", async () => {
    const first = Promise.withResolvers<string | undefined>();
    let loserSignal: AbortSignal | undefined;
    const race = raceAskSurfaces<string>(
      [{ run: () => first.promise }, { run: (sig) => ((loserSignal = sig), new Promise<string | undefined>(() => {})) }],
      () => "exhausted",
    );
    first.resolve("phone");
    expect(await race).toBe("phone");
    expect(loserSignal?.aborted).toBe(true);
    expect(loserSignal?.reason).toBe(PROMPT_SUPERSEDED);
  });

  test("ignores a surface that gives up while another is still live", async () => {
    const idle = Promise.withResolvers<string | undefined>();
    const answer = Promise.withResolvers<string | undefined>();
    const race = raceAskSurfaces<string>([{ run: () => idle.promise }, { run: () => answer.promise }], () => "exhausted");
    idle.resolve(undefined);
    await Promise.resolve();
    answer.resolve("terminal");
    expect(await race).toBe("terminal");
  });

  test("reports exhaustion when every surface gives up", async () => {
    const a = Promise.withResolvers<string | undefined>();
    const b = Promise.withResolvers<string | undefined>();
    const race = raceAskSurfaces<string>([{ run: () => a.promise }, { run: () => b.promise }], (aborted) => (aborted ? "aborted" : "expired"));
    a.resolve(undefined);
    b.resolve(undefined);
    expect(await race).toBe("expired");
  });

  test("settles a pre-aborted parent turn as aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await raceAskSurfaces<string>([pending()], (aborted) => (aborted ? "aborted" : "expired"), controller.signal)).toBe("aborted");
  });

  test("settles a mid-flight parent abort and aborts the live surfaces", async () => {
    const controller = new AbortController();
    let surfaceSignal: AbortSignal | undefined;
    const race = raceAskSurfaces<string>(
      [{ run: (sig) => ((surfaceSignal = sig), new Promise<string | undefined>(() => {})) }],
      (aborted) => (aborted ? "aborted" : "expired"),
      controller.signal,
    );
    controller.abort();
    expect(await race).toBe("aborted");
    expect(surfaceSignal?.aborted).toBe(true);
  });

  test("keeps a live surface after a sibling fails, and reports the failure", async () => {
    const terminal = Promise.withResolvers<string | undefined>();
    const errors: unknown[] = [];
    const race = raceAskSurfaces<string>(
      [{ run: () => Promise.reject(new Error("telegram send failed")) }, { run: () => terminal.promise }],
      () => "exhausted",
      undefined,
      (err) => errors.push(err),
    );
    await Promise.resolve();
    terminal.resolve("answered locally");
    expect(await race).toBe("answered locally");
    expect(errors).toHaveLength(1);
  });

  test("rejects with the real error when the only surface fails", async () => {
    await expect(
      raceAskSurfaces<string>([{ run: () => Promise.reject(new Error("no telegram target")) }], () => "expired"),
    ).rejects.toThrow("no telegram target");
  });
});
