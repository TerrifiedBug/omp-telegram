// Per-session forum-topic routing. In topics mode each omp session claims one
// Telegram forum topic (named by `sessionTopicTitle` below) in an operator-
// designated chat; inbound topic messages are routed to the owning session —
// even across processes — via JSON payload files spooled under the shared state
// dir and a per-topic watcher. No network here: this module is pure filesystem
// + policy, so it is fully unit-testable. Telegram I/O stays in api.ts /
// outbound.ts.

import { createHash, randomBytes } from "node:crypto";
import {
  type FSWatcher,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { ensureStateDir, statePath } from "./access";
import { type Logger, type TgMessage } from "./api";
import { withStateLock } from "./state-lock";

/** A session's claim on one forum topic. Keyed in the registry by thread id. */
export interface ThreadEntry {
  pid: number;
  cwd: string;
  name: string;
  claimedAt: number;
  /** Exact omp conversation to resume when this topic has no live owner. */
  sessionId?: string;
  /** Absolute session file, preferred over the ID when available. */
  sessionFile?: string;
  /** Herdr space snapshot used to restart the session without targeting a reused id. */
  workspaceId?: string;
  workspaceLabel?: string;
  workspaceTerminalIds?: string[];
}

/** On-disk registry of topic claims (threads.json). key = String(message_thread_id). */
export interface ThreadRegistry {
  version: 1;
  chatId: string;
  threads: Record<string, ThreadEntry>;
}

/** Time a routed payload may sit unclaimed before a watcher discards it as stale. */
export const ROUTED_TTL_MS = 600_000;
/** Spool key for untopiced private messages routed to the pinned DM owner. */
export const DM_ROUTE_KEY = "dm" as const;

/**
 * The title a newly created session topic gets, strongest identity first.
 *
 * 1. **herdr agent name** — operator-assigned and one-to-one with the session,
 *    which is exactly what a per-session topic represents.
 * 2. **herdr space label** — equally one-to-one with the pane, and captured by
 *    a *different* call than the agent name, so it still answers when that
 *    lookup comes back empty.
 * 3. **`basename(cwd)`** — the last resort, and the reason the first two exist:
 *    every pane under one directory tree claims the same useless title.
 *
 * The middle rung is not belt-and-braces. The agent lookup reads herdr over a
 * socket and swallows its own failure, and `tidy` closes a topic on exit so the
 * title is re-derived on every restart rather than once. On a fleet whose panes
 * share a parent directory — `~/.omp/conductor/…` for two projects, say — a
 * single missed lookup is enough to retitle a live project's topic after the
 * shared directory, which is how two projects end up both called "conductor".
 *
 * Blank is treated as absent throughout: Telegram rejects an empty topic name,
 * and a space with no custom name must not consume the fallback chain.
 */
export function sessionTopicTitle(
  agentName: string | undefined,
  spaceLabel: string | undefined,
  cwd: string,
): string {
  return agentName?.trim() || spaceLabel?.trim() || basename(cwd);
}

/**
 * Load threads.json. ENOENT / read error → fresh empty registry. Corrupt JSON →
 * move aside to threads.json.corrupt-<ts>, warn, return fresh. Mirrors loadAccess.
 */
export function loadRegistry(warn?: (msg: string) => void): ThreadRegistry {
  const file = statePath("threads.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, chatId: "", threads: {} };
    warn?.(`could not read threads.json: ${String(err)}`);
    return { version: 1, chatId: "", threads: {} };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ThreadRegistry>;
    return {
      version: 1,
      chatId: typeof parsed.chatId === "string" ? parsed.chatId : "",
      threads: parsed.threads && typeof parsed.threads === "object" ? parsed.threads : {},
    };
  } catch {
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      /* best effort */
    }
    warn?.("threads.json was corrupt — moved aside, starting fresh");
    return { version: 1, chatId: "", threads: {} };
  }
}

/** Atomically persist threads.json. Kept as a low-level fixture/setup primitive. */
export function saveRegistry(r: ThreadRegistry): void {
  ensureStateDir();
  const file = statePath("threads.json");
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(r, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function withRegistryLock<T>(mutate: () => T, warn?: (message: string) => void): T {
  ensureStateDir();
  return withStateLock(`${statePath("threads.json")}.lock`, mutate, warn);
}

/** Read-modify-write a topic claim: records the chat and the owning session. */
export function claimThread(chatId: string, threadId: number, entry: ThreadEntry, warn?: (msg: string) => void): void {
  withRegistryLock(() => {
    const registry = loadRegistry(warn);
    registry.chatId = chatId;
    registry.threads[String(threadId)] = entry;
    saveRegistry(registry);
  }, warn);
}

/**
 * Drop a claim only if `pid` still owns it. Dead entries are kept to preserve
 * exact session → thread identity and same-cwd legacy claims for re-adoption
 * without collapsing fresh sessions together.
 */
export function releaseThread(threadId: number, pid: number, warn?: (msg: string) => void): void {
  withRegistryLock(() => {
    const registry = loadRegistry(warn);
    const key = String(threadId);
    if (registry.threads[key]?.pid !== pid) return;
    delete registry.threads[key];
    saveRegistry(registry);
  }, warn);
}

/**
 * Topics whose owning pid is no longer alive, sorted
 * ascending by thread id for deterministic output. Liveness is injected (like
 * `decideRoute`) so this stays pure and unit-testable. `excludeThreadId`
 * defensively skips the control topic.
 */
export function staleThreads(
  r: ThreadRegistry,
  alive: (pid: number) => boolean,
  excludeThreadId?: number,
): Array<[number, ThreadEntry]> {
  return Object.entries(r.threads)
    .map(([key, entry]) => [Number(key), entry] as [number, ThreadEntry])
    .filter(([threadId, entry]) => threadId !== excludeThreadId && !alive(entry.pid))
    .sort((a, b) => a[0] - b[0]);
}


/**
 * Why a stale topic is stale (#67).
 *
 * `!alive(pid)` alone cannot tell a crash loop from a fortnight of history, and
 * in a DM host `/cleanup` deletes irreversibly — so its only remedy for 83
 * topics minutes old also destroyed an unrelated project topic from eight days
 * earlier. An operator needs to see which is which before tapping Delete.
 *
 * `never-ran` is the high-confidence signal: the entry records a session file
 * that does not exist, so that process claimed a topic and died without writing
 * one line of transcript. A session that did any work leaves a file behind.
 */
export type StaleReason = "never-ran" | "ended";

export interface StaleTopic {
  threadId: number;
  entry: ThreadEntry;
  reason: StaleReason;
  /** How long ago the claim was made, in ms. */
  ageMs: number;
}

/**
 * Annotate stale topics with why they are stale and how old the claim is.
 *
 * `exists` is injected so this stays pure and testable, like `alive` above.
 */
export function classifyStale(
  stale: Array<[number, ThreadEntry]>,
  now: number,
  exists: (path: string) => boolean = existsSync,
): StaleTopic[] {
  return stale.map(([threadId, entry]) => ({
    threadId,
    entry,
    // No recorded session file at all is an older-format claim, not evidence of
    // a crash: only a recorded-but-absent file proves nothing ever ran.
    reason: entry.sessionFile !== undefined && !exists(entry.sessionFile) ? "never-ran" : "ended",
    ageMs: Math.max(0, now - entry.claimedAt),
  }));
}

type SessionIdentity = Pick<ThreadEntry, "sessionId" | "sessionFile">;

/** Session files survive `omp --resume`; runtime session IDs may change. */
export function sameSession(left: SessionIdentity, right: SessionIdentity): boolean {
  if (left.sessionFile && right.sessionFile) return left.sessionFile === right.sessionFile;
  return !!left.sessionId && left.sessionId === right.sessionId;
}

/** Session pinned to receive untopiced private DMs. */
export function loadDmOwner(warn?: (msg: string) => void): ThreadEntry | undefined {
  const file = statePath("dm-owner.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    warn?.(`could not read dm-owner.json: ${String(err)}`);
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as ThreadEntry).pid === "number" &&
      Number.isFinite((parsed as ThreadEntry).pid)
    ) {
      return parsed as ThreadEntry;
    }
  } catch {
    // Invalid records are moved aside below.
  }
  try {
    renameSync(file, `${file}.corrupt-${Date.now()}`);
  } catch {
    /* best effort */
  }
  warn?.("dm-owner.json was corrupt — moved aside, starting unowned");
  return undefined;
}

/** Remove the pinned DM owner without racing another process's claim. */
export function clearDmOwner(warn?: (msg: string) => void): void {
  ensureStateDir();
  const file = statePath("dm-owner.json");
  withStateLock(`${file}.lock`, () => {
    rmSync(file, { force: true });
  }, warn);
}

/**
 * Atomically pin a session as DM owner. A foreign session may only be replaced
 * explicitly; the same durable session may refresh its record after resuming.
 */
export function claimDmOwner(
  entry: ThreadEntry,
  options: { force?: boolean } = {},
  warn?: (msg: string) => void,
): { ok: true } | { ok: false; owner: ThreadEntry } {
  ensureStateDir();
  const file = statePath("dm-owner.json");
  return withStateLock(
    `${file}.lock`,
    () => {
      const existing = loadDmOwner(warn);
      if (existing && !options.force && existing.pid !== entry.pid && !sameSession(existing, entry)) {
        return { ok: false as const, owner: existing };
      }

      const replacement = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        writeFileSync(replacement, JSON.stringify(entry, null, 2) + "\n", { mode: 0o600 });
        renameSync(replacement, file);
      } finally {
        rmSync(replacement, { force: true });
      }
      return { ok: true as const };
    },
    warn,
  );
}


/** Select an exact saved conversation; cwd fallback is only for unidentified legacy sessions. */
export function findAdoptableThread(
  r: ThreadRegistry,
  cwd: string,
  sessionId?: string,
  sessionFile?: string,
): [string, ThreadEntry] | undefined {
  const identity = { sessionId, sessionFile };
  const exact = Object.entries(r.threads).find(([, entry]) => sameSession(entry, identity));
  if (exact || sessionId || sessionFile) return exact;
  return Object.entries(r.threads).find(([, entry]) => entry.cwd === cwd && entry.sessionId == null && entry.sessionFile == null);
}

/** Whether a newly started process has reattached to the same saved conversation. */
export function isResumedOwner(previous: ThreadEntry, owner: ThreadEntry | undefined, alive: (pid: number) => boolean): boolean {
  return !!owner && owner.pid !== previous.pid && alive(owner.pid) && sameSession(previous, owner);
}

/** Whether a pid is a live process. Mirrors the acquireLock liveness probe. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // throws ESRCH if the process is gone
    return true;
  } catch {
    return false;
  }
}

export type Route =
  | { kind: "local" }
  | { kind: "forward"; threadId: number; pid: number }
  | { kind: "unowned"; threadId: number }
  | { kind: "untopiced" };

/**
 * Decide how one inbound message is handled. Pure: liveness is injected so it is
 * testable without real processes. Anything not addressed to a topic in the
 * configured topics chat is "untopiced" (today's flow). Within topics: no entry
 * or a dead owner → "unowned"; our own pid → "local"; a live foreign owner → "forward".
 */
export function decideRoute(
  msg: { chat: { id: number | string }; is_topic_message?: boolean; message_thread_id?: number },
  topicsChat: string | undefined,
  r: ThreadRegistry,
  selfPid: number,
  alive: (pid: number) => boolean,
): Route {
  if (!topicsChat || String(msg.chat.id) !== topicsChat || msg.is_topic_message !== true || typeof msg.message_thread_id !== "number") {
    return { kind: "untopiced" };
  }
  const threadId = msg.message_thread_id;
  const entry = r.threads[String(threadId)];
  if (!entry || !alive(entry.pid)) return { kind: "unowned", threadId };
  if (entry.pid === selfPid) return { kind: "local" };
  return { kind: "forward", threadId, pid: entry.pid };
}

/** Per-route spool directory for cross-process payloads. Writer & watcher must agree. */
function routeDir(threadId: number | typeof DM_ROUTE_KEY): string {
  return statePath("route", String(threadId));
}

function routeLedgerPath(threadId: number | typeof DM_ROUTE_KEY): string {
  return statePath("route", `${String(threadId)}.accepted.json`);
}

function routeLockPath(threadId: number | typeof DM_ROUTE_KEY): string {
  return `${routeDir(threadId)}.lock`;
}

/** Remove a route's spool, delivery ledger, and any unconsumed payloads. */
export function purgeRouteDir(threadId: number | typeof DM_ROUTE_KEY): void {
  rmSync(routeDir(threadId), { recursive: true, force: true });
  rmSync(routeLedgerPath(threadId), { force: true });
}

type RoutedState = "queued" | "claimed" | "inflight" | "failed" | "uncertain";

interface RoutedPayload {
  version: 1;
  identity: string;
  msg: TgMessage;
  state: RoutedState;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  retryAt?: number;
  owner?: { pid: number; claimId: string; claimedAt: number };
  detail?: string;
}

interface AcceptedLedger {
  version: 1;
  entries: Array<{ identity: string; acceptedAt: number }>;
}

const ACCEPTED_LEDGER_LIMIT = 256;
const ROUTED_DELIVERY_ATTEMPTS = 3;
const ROUTED_RETRY_BASE_MS = 250;
let lastRouteOrder = 0;

function atomicWriteJson(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function deliveryIdentity(msg: TgMessage): string {
  if (msg.bridge_callback_id) return `callback:${msg.bridge_callback_id}`;
  if (typeof msg.edit_date === "number" || msg.edited_flag) {
    const revision = { ...msg, bridge_status_id: undefined, bridge_callback_id: undefined };
    const contentHash = createHash("sha256").update(JSON.stringify(revision)).digest("hex").slice(0, 20);
    return `message:${msg.chat.id}:${msg.message_id}:edit:${msg.edit_date ?? "unknown"}:${contentHash}`;
  }
  return `message:${msg.chat.id}:${msg.message_id}:original`;
}

function readAcceptedLedger(threadId: number | typeof DM_ROUTE_KEY): AcceptedLedger {
  const file = routeLedgerPath(threadId);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, entries: [] };
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`routed acceptance ledger is corrupt: ${file}`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error(`routed acceptance ledger is invalid: ${file}`);
  const candidate = parsed as Partial<AcceptedLedger>;
  if (
    candidate.version !== 1 ||
    !Array.isArray(candidate.entries) ||
    candidate.entries.some(
      (entry) => !entry || typeof entry.identity !== "string" || typeof entry.acceptedAt !== "number",
    )
  ) {
    throw new Error(`routed acceptance ledger is invalid: ${file}`);
  }
  return { version: 1, entries: candidate.entries };
}

function readRoutedPayload(file: string): RoutedPayload | undefined {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object") return undefined;
  const candidate = parsed as Partial<RoutedPayload>;
  const state = candidate.state;
  if (
    candidate.version === 1 &&
    candidate.msg &&
    typeof candidate.msg === "object" &&
    typeof candidate.identity === "string" &&
    (state === "queued" || state === "claimed" || state === "inflight" || state === "failed" || state === "uncertain") &&
    typeof candidate.attempts === "number" &&
    typeof candidate.createdAt === "number" &&
    typeof candidate.updatedAt === "number"
  ) {
    return candidate as RoutedPayload;
  }

  const legacy = parsed as TgMessage;
  if (typeof legacy.message_id !== "number" || !legacy.chat || typeof legacy.chat.id !== "number") return undefined;
  const createdAt = statSync(file).mtimeMs;
  return {
    version: 1,
    identity: deliveryIdentity(legacy),
    msg: legacy,
    state: "queued",
    attempts: 0,
    createdAt,
    updatedAt: createdAt,
  };
}

/**
 * Durably spool a message once. Duplicate active or previously accepted
 * delivery identities are ignored; edited versions and callback ids are
 * independent identities.
 */
export function writeRouted(threadId: number | typeof DM_ROUTE_KEY, msg: TgMessage): void {
  const dir = routeDir(threadId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const identity = deliveryIdentity(msg);
  withStateLock(routeLockPath(threadId), () => {
    if (readAcceptedLedger(threadId).entries.some((entry) => entry.identity === identity)) return;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json") || name.startsWith("tmp-") || name === INBOUND_RECEIPT) continue;
      try {
        if (readRoutedPayload(join(dir, name))?.identity === identity) return;
      } catch {
        // The watcher owns corrupt-payload reporting and cleanup.
      }
    }

    const now = Date.now();
    lastRouteOrder = Math.max(now * 1000, lastRouteOrder + 1);
    const hash = createHash("sha256").update(identity).digest("hex").slice(0, 20);
    const file = join(dir, `${String(lastRouteOrder).padStart(16, "0")}-${hash}.json`);
    atomicWriteJson(file, {
      version: 1,
      identity,
      msg,
      state: "queued",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    } satisfies RoutedPayload);
  });
}

/** File name of the per-route inbound receipt (#61). Stable external contract. */
export const INBOUND_RECEIPT = "last-inbound.json";

/**
 * What a supervising process can rely on after an inbound message is delivered.
 *
 * `textSha256` rather than the text: the payload already exists in the
 * receiving agent's transcript, and a receipt is for *proving arrival*, not for
 * holding a second copy of what a user wrote. A supervisor verifying a
 * challenge code knows the code it sent, so hashing its own copy is enough —
 * and a hash cannot leak a message to anything that did not already know it.
 */
export interface InboundReceipt {
  messageId: number;
  date: number;
  fromId?: number;
  chatId: number;
  messageThreadId?: number;
  textSha256?: string;
  /** When this receipt was written, which is when the payload was consumed. */
  receivedAt: number;
}

/**
 * Record that a message arrived, before anything consumes it (#61).
 *
 * Written before the handoff on purpose: a receipt whose whole value is
 * surviving a consumer that died is worthless if the consumer writes it. One
 * file per route, replaced in place, so it is bounded by construction and needs
 * no reaper beyond {@link purgeRouteDir}.
 */
export function writeInboundReceipt(threadId: number | typeof DM_ROUTE_KEY, msg: TgMessage): void {
  const dir = routeDir(threadId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const receipt: InboundReceipt = {
    messageId: msg.message_id,
    date: msg.date,
    ...(msg.from?.id === undefined ? {} : { fromId: msg.from.id }),
    chatId: msg.chat.id,
    ...(msg.message_thread_id === undefined ? {} : { messageThreadId: msg.message_thread_id }),
    ...(msg.text === undefined ? {} : { textSha256: createHash("sha256").update(msg.text).digest("hex") }),
    receivedAt: Date.now(),
  };
  const tmp = join(dir, `tmp-${process.pid}-${randomBytes(6).toString("hex")}-${INBOUND_RECEIPT}`);
  try {
    writeFileSync(tmp, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, join(dir, INBOUND_RECEIPT));
  } catch {
    throw new Error("could not write inbound receipt");
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Read a route's inbound receipt, or `undefined` when none has been written. */
export function readInboundReceipt(threadId: number | typeof DM_ROUTE_KEY): InboundReceipt | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(routeDir(threadId), INBOUND_RECEIPT), "utf8"));
    if (!parsed || typeof parsed !== "object") return undefined;
    const r = parsed as InboundReceipt;
    return typeof r.messageId === "number" && typeof r.chatId === "number" ? r : undefined;
  } catch {
    return undefined;
  }
}
export type RouteDeliveryState = "accepted" | "failed" | "uncertain";
export type RouteDeliveryCallback = (
  msg: TgMessage,
  state: RouteDeliveryState,
  detail?: string,
) => Promise<void> | void;

type RouteClaim =
  | { kind: "deliver"; payload: RoutedPayload }
  | { kind: "report"; payload: RoutedPayload; state: "failed" | "uncertain"; detail: string };

/**
 * Watch a route's spool and submit every queued message in filename order.
 * Consumer promises settle independently: later text/album parts enter the
 * inbound batch immediately instead of waiting behind its 800ms flush.
 */
export function watchRoute(
  threadId: number | typeof DM_ROUTE_KEY,
  onMsg: (m: TgMessage) => Promise<void> | void,
  log?: Logger,
  accept?: () => boolean,
  onDelivery?: RouteDeliveryCallback,
): () => void {
  const dir = routeDir(threadId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const claimId = randomBytes(12).toString("hex");
  const processing = new Set<string>();
  const retryTimers = new Set<NodeJS.Timeout>();
  let stopped = false;

  const warn = (message: string): void => {
    try {
      log?.warn(message);
    } catch {
      // A host logger must not turn a handled delivery failure into an
      // unhandled promise rejection.
    }
  };

  const report = (msg: TgMessage, state: RouteDeliveryState, detail?: string): void => {
    if (!onDelivery) return;
    try {
      const pending = onDelivery(msg, state, detail);
      if (pending) {
        void pending.catch((err) => {
          warn(`[telegram] routed delivery report failed: ${String(err)}`);
        });
      }
    } catch (err) {
      warn(`[telegram] routed delivery report failed: ${String(err)}`);
    }
  };

  const claimPayload = (name: string): RouteClaim | undefined => {
    const full = join(dir, name);
    return withStateLock(routeLockPath(threadId), () => {
      let payload: RoutedPayload;
      try {
        const parsed = readRoutedPayload(full);
        if (!parsed) throw new Error("invalid routed payload");
        payload = parsed;
      } catch (err) {
        warn(`[telegram] routed payload parse failed (${name}): ${String(err)}`);
        rmSync(full, { force: true });
        return undefined;
      }

      if (readAcceptedLedger(threadId).entries.some((entry) => entry.identity === payload.identity)) {
        rmSync(full, { force: true });
        return undefined;
      }

      if (payload.state === "inflight") {
        if (payload.owner && isAlive(payload.owner.pid)) return undefined;
        payload.state = "uncertain";
        payload.updatedAt = Date.now();
        payload.detail = "previous consumer exited during handoff; delivery may have been submitted";
        atomicWriteJson(full, payload);
        return { kind: "report", payload, state: "uncertain", detail: payload.detail };
      }

      if (payload.state === "claimed") {
        if (payload.owner && isAlive(payload.owner.pid)) return undefined;
        payload.state = "queued";
        payload.owner = undefined;
        payload.updatedAt = Date.now();
        atomicWriteJson(full, payload);
      }
      if (payload.state === "failed" || payload.state === "uncertain") return undefined;
      const now = Date.now();
      const queuedSince = Math.min(payload.createdAt, statSync(full).mtimeMs);
      if (now - queuedSince > ROUTED_TTL_MS) {
        rmSync(full, { force: true });
        return { kind: "report", payload, state: "failed", detail: "routed payload expired before handoff" };
      }
      if (payload.retryAt != null && payload.retryAt > now) return undefined;

      payload.state = "claimed";
      payload.owner = { pid: process.pid, claimId, claimedAt: now };
      payload.retryAt = undefined;
      payload.updatedAt = now;
      atomicWriteJson(full, payload);

      payload.state = "inflight";
      payload.attempts += 1;
      payload.updatedAt = Date.now();
      atomicWriteJson(full, payload);
      return { kind: "deliver", payload };
    });
  };

  const markUncertain = (name: string, payload: RoutedPayload, detail: string): void => {
    try {
      withStateLock(routeLockPath(threadId), () => {
        const full = join(dir, name);
        const current = readRoutedPayload(full);
        if (
          !current ||
          current.identity !== payload.identity ||
          current.state !== "inflight" ||
          current.owner?.claimId !== claimId
        ) {
          return;
        }
        current.state = "uncertain";
        current.detail = detail;
        current.updatedAt = Date.now();
        atomicWriteJson(full, current);
      });
    } catch (err) {
      warn(`[telegram] could not retain uncertain routed delivery (${name}): ${String(err)}`);
    }
    report(payload.msg, "uncertain", detail);
  };

  const settleAccepted = (name: string, payload: RoutedPayload): void => {
    try {
      const accepted = withStateLock(routeLockPath(threadId), () => {
        const full = join(dir, name);
        const current = readRoutedPayload(full);
        if (
          !current ||
          current.identity !== payload.identity ||
          current.state !== "inflight" ||
          current.owner?.claimId !== claimId
        ) {
          return false;
        }
        const ledger = readAcceptedLedger(threadId);
        if (!ledger.entries.some((entry) => entry.identity === payload.identity)) {
          ledger.entries.push({ identity: payload.identity, acceptedAt: Date.now() });
          ledger.entries = ledger.entries.slice(-ACCEPTED_LEDGER_LIMIT);
          atomicWriteJson(routeLedgerPath(threadId), ledger);
        }
        rmSync(full, { force: true });
        return true;
      });
      if (accepted) report(payload.msg, "accepted");
    } catch (err) {
      const detail = `consumer accepted but durable acknowledgement failed: ${String(err)}`;
      warn(`[telegram] ${detail}`);
      markUncertain(name, payload, detail);
    }
  };

  const scheduleScan = (delay: number): void => {
    if (stopped) return;
    const timer = setTimeout(() => {
      retryTimers.delete(timer);
      if (!stopped) scan();
    }, delay);
    timer.unref?.();
    retryTimers.add(timer);
  };

  const settleFailed = (name: string, payload: RoutedPayload, err: unknown): void => {
    const detail = String(err);
    let retryAt: number | undefined;
    try {
      withStateLock(routeLockPath(threadId), () => {
        const full = join(dir, name);
        const current = readRoutedPayload(full);
        if (
          !current ||
          current.identity !== payload.identity ||
          current.state !== "inflight" ||
          current.owner?.claimId !== claimId
        ) {
          return;
        }
        current.detail = detail;
        current.owner = undefined;
        current.updatedAt = Date.now();
        if (current.attempts < ROUTED_DELIVERY_ATTEMPTS) {
          current.state = "queued";
          retryAt = Date.now() + ROUTED_RETRY_BASE_MS * current.attempts;
          current.retryAt = retryAt;
        } else {
          current.state = "failed";
          current.retryAt = undefined;
        }
        atomicWriteJson(full, current);
      });
    } catch (stateErr) {
      warn(`[telegram] could not retain failed routed delivery (${name}): ${String(stateErr)}`);
    }
    warn(`[telegram] routed delivery failed (${name}): ${detail}`);
    report(payload.msg, "failed", detail);
    if (retryAt != null) scheduleScan(Math.max(1, retryAt - Date.now()));
  };

  const handle = (name: string): void => {
    if (
      stopped ||
      !name ||
      name.startsWith("tmp-") ||
      name === INBOUND_RECEIPT ||
      !name.endsWith(".json") ||
      processing.has(name)
    ) {
      return;
    }
    try {
      if (accept && !accept()) return;
    } catch (err) {
      warn(`[telegram] routed ownership check failed: ${String(err)}`);
      return;
    }

    processing.add(name);
    let claim: RouteClaim | undefined;
    try {
      claim = claimPayload(name);
    } catch (err) {
      warn(`[telegram] routed claim failed (${name}): ${String(err)}`);
      processing.delete(name);
      return;
    }
    if (!claim) {
      processing.delete(name);
      return;
    }
    if (claim.kind === "report") {
      report(claim.payload.msg, claim.state, claim.detail);
      processing.delete(name);
      return;
    }

    const payload = claim.payload;
    try {
      writeInboundReceipt(threadId, payload.msg);
    } catch (err) {
      warn(`[telegram] inbound receipt write failed: ${String(err)}`);
    }

    let pending: Promise<void> | void;
    try {
      pending = onMsg(payload.msg);
    } catch (err) {
      settleFailed(name, payload, err);
      processing.delete(name);
      return;
    }

    if (!pending) {
      settleAccepted(name, payload);
      processing.delete(name);
      return;
    }
    void Promise.resolve(pending)
      .then(
        () => {
          settleAccepted(name, payload);
          processing.delete(name);
        },
        (err) => {
          settleFailed(name, payload, err);
          processing.delete(name);
        },
      )
      .catch((err) => {
        processing.delete(name);
        warn(`[telegram] routed delivery settlement failed (${name}): ${String(err)}`);
      });
  };

  function scan(): void {
    if (stopped) return;
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    // Deliberately do not await: sorted invocation plus independent settlement
    // preserves route order without breaking inbound text/album coalescing.
    for (const name of names) handle(name);
  }

  scan();

  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(dir, () => scan());
  } catch (err) {
    warn(`[telegram] watch failed for ${dir}: ${String(err)}`);
  }

  const interval = setInterval(scan, 5000);
  interval.unref?.();

  return () => {
    stopped = true;
    watcher?.close();
    clearInterval(interval);
    for (const timer of retryTimers) clearTimeout(timer);
    retryTimers.clear();
  };
}
