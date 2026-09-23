import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Access,
  assertAllowedChat,
  canAnswerPrompt,
  controlTopicCreationChat,
  controlTopicTarget,
  defaultAccess,
  gate,
  isDmChat,
  isPairedOwnerDm,
  loadAccess,
  pairedOwnerId,
  resolveDmTopicsHost,
  saveAccess,
  statePath,
  updateAccess,
} from "./access";

const previousStateDir = process.env.OMP_TELEGRAM_STATE_DIR;
let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "omp-tg-access-"));
  process.env.OMP_TELEGRAM_STATE_DIR = stateDir;
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.OMP_TELEGRAM_STATE_DIR;
  else process.env.OMP_TELEGRAM_STATE_DIR = previousStateDir;
  rmSync(stateDir, { recursive: true, force: true });
});

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

describe("disabled DM policy", () => {
  const access: Access = {
    ...withAllow("42"),
    dmPolicy: "disabled",
    groups: { "-1001": { requireMention: false, allowFrom: ["42"] } },
  };

  test("rejects private owner interactions without disabling configured groups", () => {
    expect(gate({ from: { id: 42 }, chat: { id: 42, type: "private" }, text: "hi" }, "bot", access).action).toBe("drop");
    expect(isPairedOwnerDm("42", "42", "private", access)).toBe(false);
    expect(canAnswerPrompt("42", "42", "private", access)).toBe(false);

    const group = { from: { id: 42 }, chat: { id: -1001, type: "supergroup" }, text: "hi" };
    expect(gate(group, "bot", access).action).toBe("deliver");
    expect(canAnswerPrompt("42", "-1001", "supergroup", access)).toBe(true);
    expect(() => assertAllowedChat("-1001", access)).not.toThrow();
    expect(() => assertAllowedChat("42", access)).toThrow("not allowlisted");
  });
});

describe("transactional access updates", () => {
  test("a pairing mutation starts from fresh disk state instead of overwriting concurrent config", () => {
    saveAccess(defaultAccess());
    const stale = loadAccess();
    updateAccess((access) => {
      access.groups["-1001"] = { requireMention: false, allowFrom: ["42"] };
    });

    expect(gate({ from: { id: 42 }, chat: { id: 42, type: "private" }, text: "pair" }, "bot", stale).action).toBe("pair");
    const saved = loadAccess();
    expect(saved.groups["-1001"]).toEqual({ requireMention: false, allowFrom: ["42"] });
    expect(Object.values(saved.pending).map((entry) => entry.senderId)).toEqual(["42"]);
  });

  test("concurrent processes preserve every independent configuration update", async () => {
    saveAccess(defaultAccess());
    const runner = join(stateDir, "update-access.ts");
    writeFileSync(
      runner,
      `import { updateAccess } from ${JSON.stringify(join(import.meta.dirname, "access.ts"))};\n` +
        `const worker = Number(process.argv[2]);\n` +
        `for (let iteration = 0; iteration < 8; iteration++) {\n` +
        `  const id = String(-10000 - worker * 100 - iteration);\n` +
        `  updateAccess((access) => { access.groups[id] = { requireMention: false, allowFrom: [id] }; });\n` +
        `}\n`,
    );
    const workers = Array.from({ length: 8 }, (_, worker) => worker);
    const ids = workers
      .flatMap((worker) => Array.from({ length: 8 }, (_, iteration) => String(-10000 - worker * 100 - iteration)))
      .sort();
    const codes = await Promise.all(
      workers.map((worker) =>
        Bun.spawn([process.execPath, runner, String(worker)], {
          env: { ...process.env, OMP_TELEGRAM_STATE_DIR: stateDir },
          stdout: "ignore",
          stderr: "ignore",
        }).exited,
      ),
    );

    expect(codes).toEqual(workers.map(() => 0));
    expect(Object.keys(loadAccess().groups).sort()).toEqual(ids);
    expect(readdirSync(stateDir).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  test("lock contention fails closed without invoking the mutator or changing access.json", () => {
    saveAccess({ ...defaultAccess(), enabled: true });
    writeFileSync(`${statePath("access.json")}.lock`, String(process.pid));
    const warnings: string[] = [];
    let invoked = false;

    expect(() =>
      updateAccess(
        (access) => {
          invoked = true;
          access.enabled = false;
        },
        (message) => warnings.push(message),
      ),
    ).toThrow("could not acquire state lock");
    expect(invoked).toBe(false);
    expect(loadAccess().enabled).toBe(true);
    expect(warnings).toHaveLength(1);
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
