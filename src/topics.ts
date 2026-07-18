// Per-session forum-topic routing. In topics mode each omp session claims one
// Telegram forum topic (named after its project dir) in an operator-designated
// chat; inbound topic messages are routed to the owning session — even across
// processes — via JSON payload files spooled under the shared state dir and a
// per-topic watcher. No network here: this module is pure filesystem + policy,
// so it is fully unit-testable. Telegram I/O stays in api.ts / outbound.ts.

import { type FSWatcher, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureStateDir, statePath } from "./access";
import type { Logger, TgMessage } from "./api";

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

/** Atomically persist threads.json (tmp write mode 0600 + rename). Mirrors saveAccess. */
export function saveRegistry(r: ThreadRegistry): void {
  ensureStateDir();
  const file = statePath("threads.json");
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(r, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

/** Read-modify-write a topic claim: records the chat and the owning session. */
export function claimThread(chatId: string, threadId: number, entry: ThreadEntry, warn?: (msg: string) => void): void {
  const r = loadRegistry(warn);
  r.chatId = chatId;
  r.threads[String(threadId)] = entry;
  saveRegistry(r);
}

/**
 * Drop a claim only if `pid` still owns it. Dead entries are kept to preserve
 * exact session → thread identity and same-cwd legacy claims for re-adoption
 * without collapsing fresh sessions together.
 */
export function releaseThread(threadId: number, pid: number, warn?: (msg: string) => void): void {
  const r = loadRegistry(warn);
  const key = String(threadId);
  if (r.threads[key]?.pid === pid) {
    delete r.threads[key];
    saveRegistry(r);
  }
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


type SessionIdentity = Pick<ThreadEntry, "sessionId" | "sessionFile">;

/** Session files survive `omp --resume`; runtime session IDs may change. */
export function sameSession(left: SessionIdentity, right: SessionIdentity): boolean {
  if (left.sessionFile && right.sessionFile) return left.sessionFile === right.sessionFile;
  return !!left.sessionId && left.sessionId === right.sessionId;
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

/** Per-topic spool directory for cross-process routed payloads. Writer & watcher must agree. */
function routeDir(threadId: number): string {
  return statePath("route", String(threadId));
}

/** Remove a topic's spool dir and any un-consumed payloads. Missing dir is a no-op. */
export function purgeRouteDir(threadId: number): void {
  rmSync(routeDir(threadId), { recursive: true, force: true });
}

/**
 * Spool a raw message for the owning session to pick up. Written to a `tmp-`
 * name then renamed so a watcher never observes a half-written file.
 */
export function writeRouted(threadId: number, msg: TgMessage): void {
  const dir = routeDir(threadId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const base = `${Date.now()}-${msg.message_id}.json`;
  const tmp = join(dir, `tmp-${base}`);
  writeFileSync(tmp, JSON.stringify(msg), { mode: 0o600 });
  renameSync(tmp, join(dir, base));
}

/**
 * Watch a topic's spool dir and hand each spooled message to `onMsg`. Uses an
 * initial scan + fs.watch + a 5s rescan (fs.watch alone is not reliable enough).
 * Skips `tmp-*`; discards payloads older than ROUTED_TTL_MS (e.g. written just
 * before a crash). A per-lifetime processed set stops watch+rescan double-firing.
 * Returns a disposer. All fs calls are synchronous so handling is race-free.
 */
export function watchRoute(threadId: number, onMsg: (m: TgMessage) => void, log?: Logger): () => void {
  const dir = routeDir(threadId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const processed = new Set<string>();

  const handle = (name: string): void => {
    if (!name || name.startsWith("tmp-") || !name.endsWith(".json") || processed.has(name)) return;
    const full = join(dir, name);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(full).mtimeMs;
    } catch {
      return; // vanished between listing and stat
    }
    processed.add(name);
    if (Date.now() - mtimeMs > ROUTED_TTL_MS) {
      try {
        unlinkSync(full);
      } catch {
        /* ignore */
      }
      return; // stale
    }
    let raw: string;
    try {
      raw = readFileSync(full, "utf8");
    } catch {
      return;
    }
    try {
      unlinkSync(full);
    } catch {
      /* ignore */
    }
    try {
      onMsg(JSON.parse(raw) as TgMessage);
    } catch (err) {
      log?.warn(`[telegram] routed payload parse failed (${name}): ${String(err)}`);
    }
  };

  const scan = (): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) handle(name);
  };

  scan(); // pick up anything already spooled before the watcher attached

  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(dir, (_event, filename) => {
      if (filename) handle(String(filename));
    });
  } catch (err) {
    log?.warn(`[telegram] watch failed for ${dir}: ${String(err)}`);
  }

  const interval = setInterval(scan, 5000);
  interval.unref?.();

  return () => {
    watcher?.close();
    clearInterval(interval);
  };
}
