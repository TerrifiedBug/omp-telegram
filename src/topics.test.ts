import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statePath } from "./access";
import type { TgMessage } from "./api";
import {
  DM_ROUTE_KEY,
  INBOUND_RECEIPT,
  ROUTED_TTL_MS,
  type ThreadEntry,
  type ThreadRegistry,
  claimThread,
  decideRoute,
  findAdoptableThread,
  isResumedOwner,
  loadRegistry,
  purgeRouteDir,
  readInboundReceipt,
  releaseThread,
  sessionTopicTitle,
  saveRegistry,
  staleThreads,
  watchRoute,
  writeRouted,
} from "./topics";

const prev = process.env.OMP_TELEGRAM_STATE_DIR;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omp-tg-topics-"));
  process.env.OMP_TELEGRAM_STATE_DIR = dir;
});
afterEach(() => {
  if (prev === undefined) delete process.env.OMP_TELEGRAM_STATE_DIR;
  else process.env.OMP_TELEGRAM_STATE_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

const topicMsg = (over: Partial<TgMessage> = {}): TgMessage => ({
  message_id: 1,
  date: 0,
  chat: { id: 100, type: "supergroup" },
  is_topic_message: true,
  message_thread_id: 7,
  ...over,
});


describe("sessionTopicTitle", () => {
  test("prefers the herdr agent name over everything else", () => {
    expect(sessionTopicTitle("veltrosecurity", "veltrosecurity", "/root/.omp/conductor")).toBe("veltrosecurity");
  });

  test("falls back to the herdr space when the agent lookup came back empty", () => {
    // The lookup reads herdr over a socket and swallows its own failure, so
    // "no agent name" is a routine outcome, not a broken host.
    expect(sessionTopicTitle(undefined, "veltrosecurity", "/root/.omp/conductor")).toBe("veltrosecurity");
  });

  test("falls back to the cwd basename outside herdr", () => {
    expect(sessionTopicTitle(undefined, undefined, "/srv/checkouts/api")).toBe("api");
  });

  test("treats blank identities as absent rather than titling a topic with nothing", () => {
    // Telegram rejects an empty topic name, and a space with no custom name
    // must not consume the fallback chain on the way past.
    expect(sessionTopicTitle("", "", "/srv/checkouts/api")).toBe("api");
    expect(sessionTopicTitle("   ", "veltro", "/srv/checkouts/api")).toBe("veltro");
    expect(sessionTopicTitle(undefined, "  spaced  ", "/srv/checkouts/api")).toBe("spaced");
  });

  test("two panes under one directory tree get their own titles, not the shared one", () => {
    // The regression this rule exists for: both panes live under
    // ~/.omp/conductor, so basename alone titles both of them "conductor" and
    // a project's pages land in the other project's topic.
    const shared = "/root/.omp/conductor";
    expect(sessionTopicTitle(undefined, "veltrosecurity", shared)).toBe("veltrosecurity");
    expect(sessionTopicTitle(undefined, "conductor", shared)).toBe("conductor");
    // Without a space either, both collapse to the same useless title — which
    // is exactly the state that shipped before this fallback existed.
    expect(sessionTopicTitle(undefined, undefined, shared)).toBe("conductor");
  });
});

describe("decideRoute", () => {
  const reg = (threads: Record<string, ThreadEntry>): ThreadRegistry => ({ version: 1, chatId: "100", threads });
  const alive = (): boolean => true;
  const dead = (): boolean => false;

  test("untopiced when topics mode is off", () => {
    expect(decideRoute(topicMsg(), undefined, reg({}), 1, alive).kind).toBe("untopiced");
  });
  test("untopiced when the chat is not the topics chat", () => {
    expect(decideRoute(topicMsg({ chat: { id: 999, type: "supergroup" } }), "100", reg({}), 1, alive).kind).toBe("untopiced");
  });
  test("untopiced when the message is not a topic message", () => {
    expect(decideRoute(topicMsg({ is_topic_message: false }), "100", reg({}), 1, alive).kind).toBe("untopiced");
  });
  test("untopiced when there is no thread id", () => {
    expect(decideRoute(topicMsg({ message_thread_id: undefined }), "100", reg({}), 1, alive).kind).toBe("untopiced");
  });
  test("unowned when no session has claimed the topic", () => {
    expect(decideRoute(topicMsg(), "100", reg({}), 1, alive)).toEqual({ kind: "unowned", threadId: 7 });
  });
  test("unowned when the claiming pid is dead", () => {
    const r = reg({ "7": { pid: 4242, cwd: "/x", name: "x", claimedAt: 0 } });
    expect(decideRoute(topicMsg(), "100", r, 1, dead)).toEqual({ kind: "unowned", threadId: 7 });
  });
  test("local when the topic is owned by this session", () => {
    const r = reg({ "7": { pid: 1, cwd: "/x", name: "x", claimedAt: 0 } });
    expect(decideRoute(topicMsg(), "100", r, 1, alive)).toEqual({ kind: "local" });
  });
  test("forward when a live foreign session owns the topic", () => {
    const r = reg({ "7": { pid: 999, cwd: "/x", name: "x", claimedAt: 0 } });
    expect(decideRoute(topicMsg(), "100", r, 1, alive)).toEqual({ kind: "forward", threadId: 7, pid: 999 });
  });
});

describe("registry", () => {
  test("claim then load round-trips chat and entry", () => {
    claimThread("100", 7, { pid: 1, cwd: "/proj", name: "proj", claimedAt: 123 });
    const r = loadRegistry();
    expect(r.chatId).toBe("100");
    expect(r.threads["7"]).toEqual({ pid: 1, cwd: "/proj", name: "proj", claimedAt: 123 });
  });

  test("release drops only the owner's entry", () => {
    claimThread("100", 7, { pid: 1, cwd: "/proj", name: "proj", claimedAt: 0 });
    releaseThread(7, 999); // not the owner — kept for adoption
    expect(loadRegistry().threads["7"]).toBeDefined();
    releaseThread(7, 1); // owner — removed
    expect(loadRegistry().threads["7"]).toBeUndefined();
  });



  test("a fresh session does not adopt another session's stale topic", () => {
    claimThread("100", 7, { pid: 1, cwd: "/proj", name: "old", claimedAt: 0, sessionId: "session-a" });
    expect(findAdoptableThread(loadRegistry(), "/proj", "session-b")).toBeUndefined();
  });

  test("an exact resumed session re-adopts its topic", () => {
    claimThread("100", 7, { pid: 1, cwd: "/old-path", name: "old", claimedAt: 0, sessionId: "session-a" });
    expect(findAdoptableThread(loadRegistry(), "/new-path", "session-a")?.[0]).toBe("7");
  });

  test("a resumed session re-adopts by session file when its runtime ID changes", () => {
    claimThread("100", 7, {
      pid: 1,
      cwd: "/proj",
      name: "old",
      claimedAt: 0,
      sessionId: "old-runtime-id",
      sessionFile: "/sessions/conversation.jsonl",
    });
    expect(findAdoptableThread(loadRegistry(), "/proj", "new-runtime-id", "/sessions/conversation.jsonl")?.[0]).toBe("7");
  });

  test("resume handoff accepts a new runtime ID for the same session file", () => {
    const previous = {
      pid: 1,
      cwd: "/proj",
      name: "old",
      claimedAt: 0,
      sessionId: "old-runtime-id",
      sessionFile: "/sessions/conversation.jsonl",
    };
    const owner = { ...previous, pid: 2, sessionId: "new-runtime-id" };
    expect(isResumedOwner(previous, owner, () => true)).toBe(true);
    expect(isResumedOwner(previous, { ...owner, sessionFile: "/sessions/other.jsonl" }, () => true)).toBe(false);
  });

  test("an identified fresh session does not adopt a same-cwd legacy claim", () => {
    claimThread("100", 7, { pid: 1, cwd: "/proj", name: "legacy", claimedAt: 0 });
    expect(findAdoptableThread(loadRegistry(), "/proj", "session-a")).toBeUndefined();
  });

  test("resumable session and herdr identity survive registry persistence", () => {
    const entry: ThreadEntry = {
      pid: 1,
      cwd: "/proj",
      name: "proj",
      claimedAt: 123,
      sessionId: "session-a",
      sessionFile: "/sessions/a.jsonl",
      workspaceId: "w1",
      workspaceLabel: "project",
      workspaceTerminalIds: ["term-a"],
    };
    claimThread("100", 7, entry);
    expect(loadRegistry().threads["7"]).toEqual(entry);
  });

  test("a corrupt threads.json is moved aside and reloads empty", () => {
    writeFileSync(statePath("threads.json"), "{not json");
    expect(loadRegistry().threads).toEqual({});
    const aside = readdirSync(statePath()).filter((f) => f.startsWith("threads.json.corrupt-"));
    expect(aside).toHaveLength(1);
  });
});

describe("writeRouted / watchRoute", () => {
  const routed = (id: number): TgMessage => ({ message_id: id, date: 0, chat: { id: 100, type: "supergroup" }, text: "hi", is_topic_message: true, message_thread_id: 7 });

  test("a spooled payload is delivered by the initial scan and consumed", () => {
    writeRouted(7, routed(42));
    const got: TgMessage[] = [];
    const dispose = watchRoute(7, (m) => got.push(m));
    dispose();
    expect(got).toHaveLength(1);
    expect(got[0].message_id).toBe(42);
    expect(got[0].text).toBe("hi");
    // The payload is consumed; the receipt stays (#61). Asserted as "no payload
    // left" rather than "empty dir", because the dir now deliberately retains
    // exactly one bounded file as evidence the message arrived.
    expect(readdirSync(statePath("route", "7")).filter((f) => f !== INBOUND_RECEIPT)).toHaveLength(0);
    expect(readInboundReceipt(7)?.messageId).toBe(42);
  });

  test("a watcher that no longer owns a mutable route leaves its payload for the owner", () => {
    writeRouted(DM_ROUTE_KEY, routed(44));
    const ignored: TgMessage[] = [];
    const stopIgnored = watchRoute(DM_ROUTE_KEY, (m) => ignored.push(m), undefined, () => false);
    stopIgnored();
    expect(ignored).toHaveLength(0);
    expect(readdirSync(statePath("route", DM_ROUTE_KEY))).toHaveLength(1);

    const received: TgMessage[] = [];
    const stopOwner = watchRoute(DM_ROUTE_KEY, (m) => received.push(m), undefined, () => true);
    stopOwner();
    expect(received.map((m) => m.message_id)).toEqual([44]);
  });

  test("a TTL-expired payload is discarded, not delivered", () => {
    writeRouted(7, routed(43));
    const spool = statePath("route", "7");
    const file = join(spool, readdirSync(spool)[0]);
    const old = (Date.now() - ROUTED_TTL_MS - 60_000) / 1000;
    utimesSync(file, old, old);
    const got: TgMessage[] = [];
    const dispose = watchRoute(7, (m) => got.push(m));
    dispose();
    expect(got).toHaveLength(0);
    expect(readdirSync(spool)).toHaveLength(0);
  });

  test("tmp- files are ignored and left in place", () => {
    const spool = statePath("route", "7");
    mkdirSync(spool, { recursive: true });
    writeFileSync(join(spool, "tmp-999-1.json"), JSON.stringify(routed(1)));
    const got: TgMessage[] = [];
    const dispose = watchRoute(7, (m) => got.push(m));
    dispose();
    expect(got).toHaveLength(0);
    expect(readdirSync(spool)).toContain("tmp-999-1.json");
  });
});

describe("acknowledged routed delivery", () => {
  const routed = (id: number, overrides: Partial<TgMessage> = {}): TgMessage => ({
    message_id: id,
    date: 1_700_000_000,
    chat: { id: 100, type: "supergroup" },
    text: `message-${id}`,
    is_topic_message: true,
    message_thread_id: 7,
    ...overrides,
  });

  test("keeps a rejected handoff and retries it until one submission is accepted", async () => {
    writeRouted(7, routed(50));
    let attempts = 0;
    const states: string[] = [];
    const accepted = Promise.withResolvers<void>();
    const stop = watchRoute(
      7,
      async () => {
        attempts++;
        if (attempts === 1) throw new Error("not submitted");
      },
      undefined,
      undefined,
      (_msg, state) => {
        states.push(state);
        if (state === "accepted") accepted.resolve();
      },
    );

    // This integration path intentionally awaits the watcher's real retry
    // signal: fake timers cannot drive fs.watch plus the retry timer together.
    await accepted.promise;
    stop();
    expect(attempts).toBe(2);
    expect(states).toEqual(["failed", "accepted"]);
    expect(readdirSync(statePath("route", "7"))).toEqual([INBOUND_RECEIPT]);
  });

  test("bounds retries for known pre-accept failures and retains the failed payload", async () => {
    writeRouted(7, routed(51));
    let attempts = 0;
    const states: string[] = [];
    const exhausted = Promise.withResolvers<void>();
    const stop = watchRoute(
      7,
      async () => {
        attempts++;
        throw new Error("still not submitted");
      },
      undefined,
      undefined,
      (_msg, state) => {
        states.push(state);
        if (states.length === 3) exhausted.resolve();
      },
    );

    await exhausted.promise;
    stop();
    expect(attempts).toBe(3);
    expect(states).toEqual(["failed", "failed", "failed"]);
    const payloads = readdirSync(statePath("route", "7")).filter((name) => name !== INBOUND_RECEIPT);
    expect(payloads).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(statePath("route", "7"), payloads[0]), "utf8")).state).toBe("failed");
  });

  test("deduplicates active and durably accepted deliveries", () => {
    const message = routed(52);
    writeRouted(7, message);
    writeRouted(7, message);
    let delivered = 0;
    const stop = watchRoute(7, () => {
      delivered++;
    });
    expect(delivered).toBe(1);

    writeRouted(7, message);
    stop();
    expect(delivered).toBe(1);
  });
  test("bounds the durable accepted ledger", () => {
    for (let id = 1; id <= 270; id++) writeRouted(7, routed(1_000 + id));
    let delivered = 0;
    const stop = watchRoute(7, () => {
      delivered++;
    });
    stop();

    const ledger = JSON.parse(readFileSync(statePath("route", "7.accepted.json"), "utf8")) as {
      entries: Array<{ identity: string }>;
    };
    expect(delivered).toBe(270);
    expect(ledger.entries).toHaveLength(256);
    expect(ledger.entries[0].identity).toContain(":1015:");
    expect(ledger.entries.at(-1)?.identity).toContain(":1270:");
  });

  test("treats each edited version and callback id as its own delivery", () => {
    writeRouted(7, routed(53));
    const firstEdit = routed(53, { edited_flag: true, edit_date: 1_700_000_010 });
    writeRouted(7, firstEdit);
    writeRouted(7, firstEdit);
    writeRouted(7, routed(53, { edited_flag: true, edit_date: 1_700_000_010, text: "same-second revision" }));
    writeRouted(7, routed(53, { edited_flag: true, edit_date: 1_700_000_011 }));
    writeRouted(7, routed(53, { bridge_callback_id: "callback-a" }));
    writeRouted(7, routed(53, { bridge_callback_id: "callback-b" }));
    const versions: string[] = [];
    const stop = watchRoute(7, (message) => {
      versions.push(message.bridge_callback_id ?? `${message.edit_date ?? "original"}:${message.text}`);
    });
    stop();

    expect(versions).toEqual([
      "original:message-53",
      "1700000010:message-53",
      "1700000010:same-second revision",
      "1700000011:message-53",
      "callback-a",
      "callback-b",
    ]);
  });

  test("starts sorted deliveries without awaiting an earlier batching promise", async () => {
    writeRouted(7, routed(54));
    writeRouted(7, routed(55));
    writeRouted(7, routed(56));
    const started: number[] = [];
    const resolveSubmissions: Array<() => void> = [];
    const allAccepted = Promise.withResolvers<void>();
    let accepted = 0;
    const stop = watchRoute(
      7,
      (message) => {
        started.push(message.message_id);
        const completion = Promise.withResolvers<void>();
        resolveSubmissions.push(() => completion.resolve());
        return completion.promise;
      },
      undefined,
      undefined,
      (_msg, state) => {
        if (state === "accepted" && ++accepted === 3) allAccepted.resolve();
      },
    );

    expect(started).toEqual([54, 55, 56]);
    for (const resolve of resolveSubmissions) resolve();
    await allAccepted.promise;
    stop();
  });

  test("a crashed in-flight handoff becomes uncertain and is never replayed", async () => {
    writeRouted(7, routed(57));
    const runner = join(dir, "crash-inflight.ts");
    writeFileSync(
      runner,
      `import { watchRoute } from ${JSON.stringify(join(import.meta.dirname, "topics.ts"))};\n` +
        `watchRoute(7, () => process.exit(9));\n`,
    );
    const exitCode = await Bun.spawn([process.execPath, runner], {
      env: { ...process.env, OMP_TELEGRAM_STATE_DIR: dir },
      stdout: "ignore",
      stderr: "ignore",
    }).exited;
    expect(exitCode).toBe(9);

    let replayed = 0;
    const reports: string[] = [];
    const stop = watchRoute(
      7,
      () => {
        replayed++;
      },
      undefined,
      undefined,
      (_msg, state) => {
        reports.push(state);
      },
    );
    stop();

    const secondReports: string[] = [];
    watchRoute(
      7,
      () => {
        replayed++;
      },
      undefined,
      undefined,
      (_msg, state) => secondReports.push(state),
    )();
    expect(replayed).toBe(0);
    expect(reports).toEqual(["uncertain"]);
    expect(secondReports).toEqual([]);
    expect(readdirSync(statePath("route", "7")).filter((name) => name !== INBOUND_RECEIPT)).toHaveLength(1);
  });
});

describe("staleThreads", () => {
  const reg = (pids: Record<string, number>): ThreadRegistry => ({
    version: 1,
    chatId: "100",
    threads: Object.fromEntries(
      Object.entries(pids).map(([id, pid]) => [id, { pid, cwd: `/p${id}`, name: `t${id}`, claimedAt: 0 }]),
    ),
  });

  test("returns only dead-pid entries, sorted ascending by thread id", () => {
    const stale = staleThreads(reg({ "9": 200, "3": 100, "5": 300 }), (pid) => pid === 300);
    expect(stale.map(([id]) => id)).toEqual([3, 9]);
    expect(stale[0][1].name).toBe("t3");
  });

  test("excludes live-pid entries entirely", () => {
    expect(staleThreads(reg({ "7": 1 }), () => true)).toEqual([]);
  });

  test("honors excludeThreadId even when that entry is dead", () => {
    const stale = staleThreads(reg({ "7": 100, "12": 200 }), () => false, 7);
    expect(stale.map(([id]) => id)).toEqual([12]);
  });
});

describe("purgeRouteDir", () => {
  test("removes an existing spool, receipt, and accepted ledger", () => {
    writeRouted(7, { message_id: 1, date: 0, chat: { id: 100, type: "supergroup" }, is_topic_message: true, message_thread_id: 7 });
    watchRoute(7, () => {})();
    const spool = statePath("route", "7");
    const ledger = statePath("route", "7.accepted.json");
    expect(existsSync(spool)).toBe(true);
    expect(existsSync(ledger)).toBe(true);
    purgeRouteDir(7);
    expect(existsSync(spool)).toBe(false);
    expect(existsSync(ledger)).toBe(false);
  });

  test("does not throw when the dir does not exist", () => {
    expect(() => purgeRouteDir(999)).not.toThrow();
  });
});

describe("registry writes survive concurrency (#68)", () => {
  const entry = (pid: number): ThreadEntry => ({ pid, cwd: `/w/${pid}`, name: "conductor", claimedAt: 1_000 + pid });

  test("concurrent claims from separate processes all persist", async () => {
    // The measured failure: a burst that created 16 topics recorded 15 rows.
    // Whole-file writes make every claim a read-modify-write, so unserialised
    // the last writer wins and the rows in between are lost — and a topic whose
    // row is lost is invisible to /cleanup forever, because the registry is the
    // only index that exists. Losing the index is worse than losing the topic.
    const runner = join(dir, "claim.ts");
    writeFileSync(
      runner,
      `import { claimThread } from ${JSON.stringify(join(import.meta.dirname, "topics.ts"))};\n` +
        `claimThread("42", Number(process.argv[2]), { pid: Number(process.argv[2]), cwd: "/w", name: "conductor", claimedAt: 1 });\n`,
    );
    const ids = [7001, 7002, 7003, 7004, 7005, 7006, 7007, 7008];
    await Promise.all(
      ids.map((id) =>
        Bun.spawn([process.execPath, runner, String(id)], {
          env: { ...process.env, OMP_TELEGRAM_STATE_DIR: dir },
          stdout: "ignore",
          stderr: "ignore",
        }).exited,
      ),
    );
    const got = Object.keys(loadRegistry().threads).map(Number).sort((a, b) => a - b);
    expect(got).toEqual(ids);
  });

  test("concurrent claims and releases serialize without resurrecting or dropping entries", async () => {
    const released = [7101, 7102, 7103, 7104, 7105, 7106];
    const claimed = [7201, 7202, 7203, 7204, 7205, 7206];
    saveRegistry({
      version: 1,
      chatId: "42",
      threads: Object.fromEntries(released.map((id) => [String(id), entry(id)])),
    });
    const runner = join(dir, "mutate-registry.ts");
    writeFileSync(
      runner,
      `import { claimThread, releaseThread } from ${JSON.stringify(join(import.meta.dirname, "topics.ts"))};\n` +
        `const id = Number(process.argv[3]);\n` +
        `if (process.argv[2] === "release") releaseThread(id, id);\n` +
        `else claimThread("42", id, { pid: id, cwd: "/w", name: "conductor", claimedAt: 1 });\n`,
    );
    const operations = [
      ...released.map((id) => ["release", id] as const),
      ...claimed.map((id) => ["claim", id] as const),
    ];
    const codes = await Promise.all(
      operations.map(([operation, id]) =>
        Bun.spawn([process.execPath, runner, operation, String(id)], {
          env: { ...process.env, OMP_TELEGRAM_STATE_DIR: dir },
          stdout: "ignore",
          stderr: "ignore",
        }).exited,
      ),
    );

    expect(codes).toEqual(operations.map(() => 0));
    expect(Object.keys(loadRegistry().threads).map(Number).sort((a, b) => a - b)).toEqual(claimed);
  });

  test("fresh lock contention rejects release without touching the registry", () => {
    saveRegistry({ version: 1, chatId: "42", threads: { "7301": entry(7301) } });
    writeFileSync(`${statePath("threads.json")}.lock`, String(process.pid));
    const warnings: string[] = [];

    expect(() => releaseThread(7301, 7301, (message) => warnings.push(message))).toThrow("could not acquire state lock");
    expect(loadRegistry().threads["7301"]).toEqual(entry(7301));
    expect(warnings).toHaveLength(1);
  });

  test("a lock left by a dead process does not wedge the registry shut", () => {
    // Self-healing by age. A mutation lock is held for microseconds, so one
    // that is seconds old belonged to a process that died holding it.
    const lock = `${statePath("threads.json")}.lock`;
    writeFileSync(lock, "999999");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    claimThread("42", 8001, entry(8001));
    expect(Object.keys(loadRegistry().threads)).toEqual(["8001"]);
  });

  test("each registry save uses a unique temp file and leaves no debris", () => {
    // A shared `threads.json.tmp` let concurrent writers publish one another's
    // content. Every save now stages under its own random name.
    claimThread("42", 8002, entry(8002));
    const leftovers = readdirSync(dir).filter((name) => name.startsWith("threads.json.") && name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
    expect(loadRegistry().threads["8002"]?.pid).toBe(8002);
  });
});

describe("durable inbound receipt (#61)", () => {
  const msg = (id: number, text: string, thread?: number): TgMessage => ({
    message_id: id,
    date: 1_700_000_000,
    from: { id: 555, is_bot: false, first_name: "op" },
    chat: { id: 100, type: "supergroup" },
    text,
    ...(thread === undefined ? {} : { is_topic_message: true, message_thread_id: thread }),
  });

  test("a delivered message leaves a receipt a supervisor can verify", () => {
    writeRouted(7, msg(42, "arm-code-abc", 7));
    watchRoute(7, () => {})();
    const r = readInboundReceipt(7);
    expect(r?.messageId).toBe(42);
    expect(r?.chatId).toBe(100);
    expect(r?.fromId).toBe(555);
    expect(r?.messageThreadId).toBe(7);
    expect(r?.receivedAt).toBeGreaterThan(0);
    // A hash, not the text: the payload already lives in the consuming agent's
    // transcript, and a supervisor verifying a challenge knows what it sent.
    expect(r?.textSha256).toBe(new Bun.CryptoHasher("sha256").update("arm-code-abc").digest("hex"));
    expect(JSON.stringify(r)).not.toContain("arm-code-abc");
  });

  test("the receipt survives a consumer that dies mid-handoff — the case it exists for", async () => {
    // A thrown error is caught and execution continues, so an in-process throw
    // cannot distinguish before-handoff from after. Process death can: the child
    // hard-exits inside `onMsg`, so anything sequenced after the handoff never
    // runs. This is the assertion that fails when the receipt is written last.
    writeRouted(8, msg(43, "boom", 8));
    const runner = join(dir, "die.ts");
    writeFileSync(
      runner,
      `import { watchRoute } from ${JSON.stringify(join(import.meta.dirname, "topics.ts"))};\n` +
        `watchRoute(8, () => process.exit(9));\n`,
    );
    const { exitCode } = await Bun.spawn([process.execPath, runner], {
      env: { ...process.env, OMP_TELEGRAM_STATE_DIR: dir },
      stdout: "ignore",
      stderr: "ignore",
    }).exited.then((code) => ({ exitCode: code }));
    expect(exitCode).toBe(9); // the consumer really did die inside onMsg
    expect(readInboundReceipt(8)?.messageId).toBe(43);
  });

  test("it is bounded: a second delivery replaces the first, never accumulates", () => {
    writeRouted(9, msg(44, "one", 9));
    watchRoute(9, () => {})();
    writeRouted(9, msg(45, "two", 9));
    watchRoute(9, () => {})();
    expect(readInboundReceipt(9)?.messageId).toBe(45);
    expect(readdirSync(statePath("route", "9"))).toEqual([INBOUND_RECEIPT]);
  });

  test("the watcher never consumes its own receipt as a payload", () => {
    // It lives in the watched dir and ends in `.json`, so this is a real hazard.
    writeRouted(10, msg(46, "hi", 10));
    watchRoute(10, () => {})();
    const delivered: TgMessage[] = [];
    watchRoute(10, (m) => delivered.push(m))();
    expect(delivered).toEqual([]);
    expect(readInboundReceipt(10)?.messageId).toBe(46);
  });

  test("the DM route gets one too", () => {
    writeRouted(DM_ROUTE_KEY, msg(47, "dm"));
    watchRoute(DM_ROUTE_KEY, () => {})();
    expect(readInboundReceipt(DM_ROUTE_KEY)?.messageId).toBe(47);
  });

  test("purgeRouteDir removes it with the rest of the route state", () => {
    writeRouted(11, msg(48, "hi", 11));
    watchRoute(11, () => {})();
    expect(readInboundReceipt(11)).toBeDefined();
    purgeRouteDir(11);
    expect(readInboundReceipt(11)).toBeUndefined();
  });

  test("a corrupt or absent receipt reads as absent, never throws", () => {
    expect(readInboundReceipt(9999)).toBeUndefined();
    mkdirSync(statePath("route", "12"), { recursive: true });
    writeFileSync(join(statePath("route", "12"), INBOUND_RECEIPT), "{ not json");
    expect(readInboundReceipt(12)).toBeUndefined();
  });
});
