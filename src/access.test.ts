import { test, expect, describe } from "bun:test";
import { type Access, assertAllowedChat, controlTopicCreationChat, controlTopicTarget, defaultAccess, gate, isDmChat, isPairedOwnerDm, pairedOwnerId, resolveDmTopicsHost } from "./access";

const withAllow = (...ids: string[]): Access => ({ ...defaultAccess(), allowFrom: ids });

describe("isDmChat", () => {
  test("positive ids are DMs (user chat_id == user_id)", () => {
    expect(isDmChat("123456")).toBe(true);
    expect(isDmChat("1")).toBe(true);
  });

  test("negative ids are groups/supergroups/channels", () => {
    expect(isDmChat("-1001234567890")).toBe(false);
    expect(isDmChat("-42")).toBe(false);
  });
});

describe("resolveDmTopicsHost", () => {
  test("exactly one paired DM resolves to that chat_id", () => {
    expect(resolveDmTopicsHost(withAllow("123456"))).toEqual({ chatId: "123456" });
  });

  test("no paired DM yet returns a pairing hint and does not resolve", () => {
    const r = resolveDmTopicsHost(withAllow());
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toContain("/telegram pair");
  });

  test("multiple paired DMs are ambiguous and list the candidate ids", () => {
    const r = resolveDmTopicsHost(withAllow("111", "222"));
    expect("error" in r).toBe(true);
    if ("error" in r) {
      expect(r.error).toContain("ambiguous");
      expect(r.error).toContain("111");
      expect(r.error).toContain("222");
    }
  });
});

describe("single paired operator", () => {
  const dm = (id: number) => ({ from: { id }, chat: { id, type: "private" }, text: "hello" });

  test("the sole owner is delivered and every other DM is dropped", () => {
    const access = withAllow("42");
    expect(pairedOwnerId(access)).toBe("42");
    expect(gate(dm(42), "bot", access).action).toBe("deliver");
    expect(gate(dm(99), "bot", access).action).toBe("drop");
    expect(access.pending).toEqual({});
  });

  test("historical multi-owner state fails closed", () => {
    const access = withAllow("42", "99");
    expect(pairedOwnerId(access)).toBeUndefined();
    expect(gate(dm(42), "bot", access).action).toBe("drop");
    expect(gate(dm(99), "bot", access).action).toBe("drop");
  });

  test("outbound DM delivery accepts only the sole owner", () => {
    const access = withAllow("42");
    expect(() => assertAllowedChat("42", access)).not.toThrow();
    expect(() => assertAllowedChat("99", access)).toThrow("not allowlisted");
  });

  test("control identity requires the owner in their private DM", () => {
    const access = withAllow("42");
    expect(isPairedOwnerDm("42", "42", "private", access)).toBe(true);
    expect(isPairedOwnerDm("99", "42", "private", access)).toBe(false);
    expect(isPairedOwnerDm("42", "-1001", "supergroup", access)).toBe(false);
  });
});

describe("dedicated control topic", () => {
  const access = { ...withAllow("42"), topicsChat: "42" };

  test("is created only for the paired owner's topic-enabled DM", () => {
    expect(controlTopicCreationChat(access, true)).toBe("42");
    expect(controlTopicCreationChat(access, undefined)).toBe("42");
    expect(controlTopicCreationChat(access, false)).toBeUndefined();
    expect(controlTopicCreationChat({ ...access, topicsChat: "-1001" }, true)).toBeUndefined();
    expect(controlTopicCreationChat({ ...access, controlThreadId: 900 }, true)).toBeUndefined();
  });

  test("becomes the global command target only while owner-DM topics are active", () => {
    const configured = { ...access, controlThreadId: 900 };
    expect(controlTopicTarget(configured)).toEqual({ chatId: "42", threadId: 900 });
    expect(controlTopicTarget({ ...configured, topicsChat: undefined })).toBeUndefined();
    expect(controlTopicTarget({ ...configured, allowFrom: [] })).toBeUndefined();
  });
});
