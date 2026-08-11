// Raw Telegram Bot API client over Node/Bun `fetch` + `FormData` (zero runtime
// deps). Provides the request primitives (`tg`, `tgUpload`), the long-poll
// `Poller`, and a single-poller PID lock. No filesystem-layout knowledge beyond
// the lock path handed in by the caller.

import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

const API_BASE = "https://api.telegram.org/bot";
/** Base for bot file downloads: `${FILE_API_BASE}${token}/${file_path}`. */
export const FILE_API_BASE = "https://api.telegram.org/file/bot";

/** Minimal structural logger, satisfied by `pi.logger`. */
export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export class TgError extends Error {
  readonly code: number;
  readonly retryAfter?: number;
  constructor(message: string, code: number, retryAfter?: number) {
    super(message);
    this.name = "TgError";
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/**
 * Telegram's definitive signal that a locally saved forum topic no longer exists.
 * Supergroup forums answer a gone topic with "message thread not found"; DM
 * forum-topic mode answers with "TOPIC_ID_INVALID". Both mean the same thing —
 * the topic is gone — so the delete/tidy and outbound-recovery paths treat either
 * as idempotent success rather than a hard failure.
 */
export function isMissingThreadError(err: unknown): boolean {
  return err instanceof TgError && err.code === 400 && /message thread not found|topic_id_invalid/i.test(err.message);
}

/** Attempts to re-send a request Telegram rate-limited before giving up on it. */
const RATE_LIMIT_RETRIES = 3;
/** Upper bound on one `retry_after` wait, so a long ban cannot stall a turn indefinitely. */
const MAX_RETRY_WAIT_MS = 30_000;

/**
 * Run a Telegram request, waiting out `retry_after` when Telegram rate-limits
 * it. Every text delivery path goes through this: without it a 429 on part 2 of
 * a split message throws, the caller gives up, and the reader silently keeps a
 * truncated reply. `sleep` is a test seam.
 */
export async function withRateLimit<T>(
  op: () => Promise<T>,
  options: { sleep?: (ms: number) => Promise<void>; log?: Logger } = {},
): Promise<T> {
  const pause = options.sleep ?? sleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (err) {
      const retryAfter = err instanceof TgError && (err.retryAfter != null || err.code === 429) ? (err.retryAfter ?? 1) : undefined;
      if (retryAfter == null || attempt >= RATE_LIMIT_RETRIES) throw err;
      options.log?.debug(`[telegram] rate limited — retrying in ${retryAfter}s`);
      await pause(Math.min(retryAfter * 1000 + 250, MAX_RETRY_WAIT_MS));
    }
  }
}

// ---- Wire types (only the fields we read) --------------------------------

export interface TgUser {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
}
export interface TgChat {
  id: number;
  type: string;
  title?: string;
}
export interface TgMessageEntity {
  type: string;
  offset: number;
  length: number;
  user?: TgUser;
}
export interface TgPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}
interface TgFileBase {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
}
export interface TgDocument extends TgFileBase {
  file_name?: string;
  mime_type?: string;
}
export interface TgVoice extends TgFileBase {
  mime_type?: string;
}
export interface TgAudio extends TgFileBase {
  file_name?: string;
  mime_type?: string;
  title?: string;
}
export interface TgVideo extends TgFileBase {
  file_name?: string;
  mime_type?: string;
}
export type TgVideoNote = TgFileBase;
export interface TgSticker extends TgFileBase {
  emoji?: string;
}
export interface TgMessage {
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  entities?: TgMessageEntity[];
  caption_entities?: TgMessageEntity[];
  chat: TgChat;
  from?: TgUser;
  reply_to_message?: TgMessage;
  photo?: TgPhotoSize[];
  document?: TgDocument;
  voice?: TgVoice;
  audio?: TgAudio;
  video?: TgVideo;
  video_note?: TgVideoNote;
  sticker?: TgSticker;
  media_group_id?: string;
  is_topic_message?: boolean;
  message_thread_id?: number;
  /** Internal spool sentinel; not a Bot API field. */
  edited_flag?: true;
}
export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: Pick<TgMessage, "message_id" | "chat" | "is_topic_message" | "message_thread_id">;
  data?: string;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}
export interface TgFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

// ---- Requests ------------------------------------------------------------

/** POST a JSON Bot API method. Throws {@link TgError} on a non-ok response. */
export async function tg<T>(
  token: string,
  method: string,
  payload?: Record<string, unknown>,
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<T> {
  const timeout = AbortSignal.timeout(opts?.timeoutMs ?? 30_000);
  const signal = opts?.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
  const res = await fetch(`${API_BASE}${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal,
  });
  const data = (await res.json()) as TgResponse<T>;
  if (!data.ok) {
    throw new TgError(data.description ?? `Telegram ${method} failed`, data.error_code ?? res.status, data.parameters?.retry_after);
  }
  return data.result as T;
}

/** Diagnose persistent getUpdates conflicts without changing webhook state. */
export async function webhookConflictHint(token: string): Promise<string | undefined> {
  const info = await tg<{ url?: string }>(token, "getWebhookInfo");
  const url = info.url?.trim();
  return url ? `a webhook is set on this token (${url}) — delete it (deleteWebhook) or use a different token` : undefined;
}

/** Multipart upload (sendPhoto/sendDocument). 120s default timeout. */
export async function tgUpload<T>(
  token: string,
  method: string,
  fields: Record<string, string | number | undefined>,
  file: { field: string; path: string; filename?: string },
  timeoutMs = 120_000,
): Promise<T> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) form.append(k, String(v));
  }
  const bytes = await readFile(file.path);
  form.append(file.field, new Blob([bytes]), file.filename ?? basename(file.path));
  const res = await fetch(`${API_BASE}${token}/${method}`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = (await res.json()) as TgResponse<T>;
  if (!data.ok) {
    throw new TgError(data.description ?? `Telegram ${method} failed`, data.error_code ?? res.status, data.parameters?.retry_after);
  }
  return data.result as T;
}

/** Download a bot file's bytes by its Telegram `file_path`. */
export async function downloadFileBytes(token: string, filePath: string, timeoutMs = 120_000): Promise<Uint8Array> {
  const res = await fetch(`${FILE_API_BASE}${token}/${filePath}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new TgError(`file download failed: HTTP ${res.status}`, res.status);
  return new Uint8Array(await res.arrayBuffer());
}

// ---- Single-poller lock --------------------------------------------------

/** Owner heartbeat cadence; refreshes lock mtime while polling. */
export const LOCK_HEARTBEAT_MS = 15_000;
/** A lock with mtime younger than this is live regardless of the pid probe. */
export const LOCK_FRESH_MS = 45_000;
/** Per-process identity that disambiguates equal numeric PIDs across namespaces. */
const PROCESS_LOCK_NONCE = randomBytes(16).toString("hex");

export interface LockOwner {
  pid: number;
  startedAt: number;
  nonce?: string;
  name?: string;
  sessionId?: string;
  sessionFile?: string;
}

/** Whether a PID is a live process (EPERM means it exists but is owned elsewhere). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseLockOwner(content: string): LockOwner | undefined {
  const trimmed = content.trim();
  if (!trimmed) return undefined;
  const newline = trimmed.indexOf("\n");
  const firstLine = newline === -1 ? trimmed : trimmed.slice(0, newline);
  const pid = Number.parseInt(firstLine, 10) || 0;
  if (pid <= 0) return undefined;
  if (newline !== -1) {
    try {
      const owner: unknown = JSON.parse(trimmed.slice(newline + 1));
      if (owner && typeof owner === "object" && (owner as LockOwner).pid === pid) return owner as LockOwner;
    } catch {
      // Fall back to the first-line pid for malformed v2 records.
    }
  }
  return { pid, startedAt: 0 };
}

/** Parse the lock's owner record. Legacy bare-pid locks yield `{ pid, startedAt: 0 }`. */
export function readLockOwner(lockPath: string): LockOwner | undefined {
  try {
    return parseLockOwner(readFileSync(lockPath, "utf8"));
  } catch {
    return undefined;
  }
}

function lockOwnedBy(lockPath: string, pid: number, nonce: string): boolean {
  const owner = readLockOwner(lockPath);
  return owner?.pid === pid && owner.nonce === nonce;
}

function lockFresh(lockPath: string, freshMs: number): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs < freshMs;
  } catch {
    return false;
  }
}

/**
 * Atomically create `target` by hard-linking a pid-stamped temp into place.
 * `link` fails with EEXIST if the target already exists, so the filesystem —
 * not a racy read-then-write — decides the single winner, and the target is
 * populated the instant it appears (no empty mid-write window).
 */
function linkClaim(target: string, pid: number, content: string = String(pid)): boolean {
  const temp = `${target}.${pid}.${randomBytes(6).toString("hex")}`;
  writeFileSync(temp, content, { mode: 0o600 });
  try {
    linkSync(temp, target);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    return false;
  } finally {
    rmSync(temp, { force: true });
  }
}

/** A reaper lock older than this is treated as abandoned by a crashed reclaimer. */
const REAPER_TTL_MS = 10_000;

/**
 * Claim the poll lock at `lockPath`. Fails when a foreign owner has a live PID
 * or a fresh heartbeat; a crashed owner is reclaimable after `LOCK_FRESH_MS`.
 * A per-process nonce disambiguates equal numeric PIDs across PID namespaces.
 * DM chat_id == user_id, so exactly one poller per token is required — Telegram
 * rejects concurrent getUpdates with 409.
 *
 * `pid`/`nonce`/`alive`/`freshMs` are injectable for tests; production uses this
 * process, its random nonce, a real liveness probe, and the default freshness.
 */
export function acquireLock(
  lockPath: string,
  options: {
    pid?: number;
    nonce?: string;
    alive?: (pid: number) => boolean;
    identity?: { name?: string; sessionId?: string; sessionFile?: string };
    freshMs?: number;
  } = {},
): { ok: true } | { ok: false; holder: number; owner?: LockOwner } {
  const pid = options.pid ?? process.pid;
  const nonce = options.nonce ?? PROCESS_LOCK_NONCE;
  const alive = options.alive ?? pidAlive;
  const freshMs = options.freshMs ?? LOCK_FRESH_MS;
  const content = `${pid}\n${JSON.stringify({ ...options.identity, pid, startedAt: Date.now(), nonce })}`;
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });

  // Fast path: atomically claim an absent lock. Simultaneous starters can never
  // both win here (the previous read-then-write could).
  if (linkClaim(lockPath, pid, content)) return { ok: true };
  let owner = readLockOwner(lockPath);
  let holder = owner?.pid ?? 0;
  if (holder === pid && owner?.pid === pid && owner.nonce === nonce) return { ok: true };
  if (holder > 0 && (alive(holder) || lockFresh(lockPath, freshMs))) {
    return { ok: false, holder, owner };
  }

  // Stale (dead holder) or garbage lock. Reclaim under an exclusive reaper so two
  // starters can't both unlink and re-link, clobbering each other's fresh claim.
  // A reaper abandoned by a crashed reclaimer is cleared by age; a fresh one means
  // another starter is mid-reclaim, so report the lock as held.
  const reapPath = `${lockPath}.reap`;
  if (!linkClaim(reapPath, pid, content)) {
    let mtime = 0;
    try {
      mtime = statSync(reapPath).mtimeMs;
    } catch {
      mtime = 0;
    }
    if (Date.now() - mtime < REAPER_TTL_MS) {
      const current = holder > 0 ? holder : 0;
      return { ok: false, holder: current, owner: readLockOwner(lockPath) };
    }
    rmSync(reapPath, { force: true });
    if (!linkClaim(reapPath, pid, content)) {
      owner = readLockOwner(lockPath);
      const current = owner?.pid ?? (holder > 0 ? holder : 0);
      return { ok: false, holder: current, owner };
    }
  }
  try {
    // Only the exact reaper owner may touch the main lock. If we lost the reaper,
    // bail rather than race the new owner. Then re-validate the main owner in case
    // it was reclaimed while we waited.
    if (!lockOwnedBy(reapPath, pid, nonce)) {
      owner = readLockOwner(lockPath);
      const current = owner?.pid ?? (holder > 0 ? holder : 0);
      return { ok: false, holder: current, owner };
    }
    owner = readLockOwner(lockPath);
    holder = owner?.pid ?? 0;
    if (holder === pid && owner?.pid === pid && owner.nonce === nonce) return { ok: true };
    if (holder > 0 && (alive(holder) || lockFresh(lockPath, freshMs))) {
      return { ok: false, holder, owner };
    }
    rmSync(lockPath, { force: true });
    if (linkClaim(lockPath, pid, content)) return { ok: true };
    owner = readLockOwner(lockPath);
    return { ok: false, holder: owner?.pid ?? 0, owner };
  } finally {
    // Release the reaper only if this process still owns its exact nonce.
    if (lockOwnedBy(reapPath, pid, nonce)) rmSync(reapPath, { force: true });
  }
}

/** Release the lock only if this exact process nonce still owns it. */
export function releaseLock(
  lockPath: string,
  pid: number = process.pid,
  nonce: string = PROCESS_LOCK_NONCE,
): void {
  if (lockOwnedBy(lockPath, pid, nonce)) rmSync(lockPath, { force: true });
}

/** Refresh the lock mtime while this exact process nonce owns it. */
export function startLockHeartbeat(
  lockPath: string,
  pid: number = process.pid,
  intervalMs: number = LOCK_HEARTBEAT_MS,
  nonce: string = PROCESS_LOCK_NONCE,
): () => void {
  const timer = setInterval(() => {
    if (!lockOwnedBy(lockPath, pid, nonce)) return;
    try {
      const now = new Date();
      utimesSync(lockPath, now, now);
    } catch {
      // Lock vanished.
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (signal?.aborted) return Promise.resolve();
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
  signal?.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      resolve();
    },
    { once: true },
  );
  return promise;
}

// ---- Long-poll loop ------------------------------------------------------

export type UpdateHandler = (update: TgUpdate) => void | Promise<void>;

/**
 * Long-poll `getUpdates`. A handler throw never stops polling (logged). Retry
 * ladder: `delay = min(1000 * attempt, 15000)`, reset on success; persistent
 * 409 (8 attempts) → `onFatal` and stop. `stop()` aborts the in-flight fetch.
 */
export class Poller {
  #running = false;
  #abort: AbortController | undefined;
  #loop: Promise<void> | undefined;

  get running(): boolean {
    return this.#running;
  }

  start(token: string, onUpdate: UpdateHandler, onFatal: (reason: string) => void, log?: Logger): void {
    if (this.#running) return;
    this.#running = true;
    this.#abort = new AbortController();
    this.#loop = this.#run(token, onUpdate, onFatal, log);
  }

  async #run(token: string, onUpdate: UpdateHandler, onFatal: (reason: string) => void, log?: Logger): Promise<void> {
    let offset = 0;
    let attempt = 0;
    while (this.#running) {
      try {
        const updates = await tg<TgUpdate[]>(
          token,
          "getUpdates",
          { offset, timeout: 30, allowed_updates: ["message", "edited_message", "callback_query"] },
          { timeoutMs: 40_000, signal: this.#abort!.signal },
        );
        attempt = 0;
        for (const u of updates) {
          if (u.update_id >= offset) offset = u.update_id + 1;
          try {
            await onUpdate(u);
          } catch (err) {
            log?.warn(`[telegram] update handler error: ${String(err)}`);
          }
        }
      } catch (err) {
        if (!this.#running) return; // stop() aborted the fetch — clean exit
        attempt += 1;
        const is409 = err instanceof TgError && err.code === 409;
        if (is409 && attempt >= 8) {
          onFatal("409 Conflict — another poller holds this token");
          this.#running = false;
          return;
        }
        const delay = Math.min(1000 * attempt, 15_000);
        log?.debug(`[telegram] poll error (attempt ${attempt}), retry in ${delay}ms: ${String(err)}`);
        await sleep(delay, this.#abort!.signal);
      }
    }
  }

  /** Signal the loop to stop and abort any in-flight request. Awaitable via {@link done}. */
  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    this.#abort?.abort();
  }

  /** Resolves when the loop has fully exited. */
  done(): Promise<void> {
    return this.#loop ?? Promise.resolve();
  }
}
