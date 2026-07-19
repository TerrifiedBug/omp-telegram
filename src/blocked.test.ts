import { describe, expect, test } from "bun:test";
import { BlockedPings, type BlockedPingDeps, askQuestionSummary } from "./blocked";

/**
 * Drive {@link BlockedPings} with a hand-controlled scheduler and transport, so
 * a test decides exactly when the grace "elapses" (`fire`) and when a send lands
 * (`settleSend`) — no real timers, no flakiness. The send is recorded
 * synchronously and BlockedPings attaches its `.then` before the test awaits the
 * same promise, so `settleSend` deterministically flushes the post-send handler.
 */
function harness(over: Partial<BlockedPingDeps> = {}) {
  const sends: Array<{ chatId: string; text: string; threadId: number | undefined }> = [];
  const edits: Array<{ chatId: string; messageId: number; text: string }> = [];
  let scheduled: (() => void) | undefined;
  let cancelled = 0;
  let pendingSend = Promise.withResolvers<number | undefined>();
  const deps: BlockedPingDeps = {
    send: (chatId, text, threadId) => {
      sends.push({ chatId, text, threadId });
      pendingSend = Promise.withResolvers<number | undefined>();
      return pendingSend.promise;
    },
    edit: async (chatId, messageId, text) => {
      edits.push({ chatId, messageId, text });
    },
    schedule: (cb) => {
      scheduled = cb;
      return () => {
        cancelled += 1;
      };
    },
    delayMs: 2000,
    resumedText: () => "[ANSWERED]",
    ...over,
  };
  return {
    pings: new BlockedPings(deps),
    sends,
    edits,
    fire: () => scheduled?.(),
    settleSend: async (id: number | undefined) => {
      pendingSend.resolve(id);
      await pendingSend.promise;
    },
    cancelledCount: () => cancelled,
  };
}

describe("askQuestionSummary", () => {
  test("summarizes the first question and counts the rest", () => {
    expect(askQuestionSummary({ questions: [{ question: "Cut the release?" }] })).toBe(":\nCut the release?");
    expect(askQuestionSummary({ questions: [{ question: "A?" }, { question: "B?" }, { question: "C?" }] })).toBe(":\nA? (+2 more)");
  });

  test("returns empty string when no question text is present", () => {
    expect(askQuestionSummary(undefined)).toBe("");
    expect(askQuestionSummary({})).toBe("");
    expect(askQuestionSummary({ questions: [] })).toBe("");
    expect(askQuestionSummary({ questions: [{ id: "x" }] })).toBe("");
    expect(askQuestionSummary({ questions: [{ question: "  " }] })).toBe("");
  });
});

describe("BlockedPings lifecycle", () => {
  const target = { chatId: "9", threadId: 7 };

  test("pings once after the grace with the built text and target", () => {
    const h = harness();
    h.pings.start("t1", target, () => "BODY");
    expect(h.sends).toHaveLength(0); // nothing before the grace elapses
    h.fire();
    expect(h.sends).toEqual([{ chatId: "9", text: "BODY", threadId: 7 }]);
  });

  test("a resolution before the grace cancels the ping silently", () => {
    const h = harness();
    h.pings.start("t1", target, () => "BODY");
    h.pings.end("t1");
    expect(h.cancelledCount()).toBe(1);
    h.fire(); // guarded no-op even if the timer somehow runs
    expect(h.sends).toHaveLength(0);
    expect(h.edits).toHaveLength(0);
  });

  test("a resolution after the ping edits it to the resumed text", async () => {
    const h = harness();
    h.pings.start("t1", target, () => "BODY");
    h.fire();
    await h.settleSend(42);
    expect(h.edits).toHaveLength(0); // sent, but not yet resolved
    h.pings.end("t1");
    expect(h.edits).toEqual([{ chatId: "9", messageId: 42, text: "[ANSWERED]" }]);
  });

  test("a resolution while the send is in flight resolves once it lands", async () => {
    const h = harness();
    h.pings.start("t1", target, () => "BODY");
    h.fire();
    h.pings.end("t1"); // resolved before the send lands
    expect(h.edits).toHaveLength(0);
    await h.settleSend(99); // send lands
    expect(h.edits).toEqual([{ chatId: "9", messageId: 99, text: "[ANSWERED]" }]);
  });

  test("clear cancels a still-pending ping", () => {
    const h = harness();
    h.pings.start("t1", target, () => "BODY");
    h.pings.clear();
    expect(h.cancelledCount()).toBe(1);
    h.fire();
    expect(h.sends).toHaveLength(0);
  });

  test("a repeat start for the same id cancels the prior ping", () => {
    const h = harness();
    h.pings.start("t1", target, () => "FIRST");
    h.pings.start("t1", target, () => "SECOND");
    expect(h.cancelledCount()).toBe(1);
    h.fire();
    expect(h.sends).toEqual([{ chatId: "9", text: "SECOND", threadId: 7 }]);
  });
});
