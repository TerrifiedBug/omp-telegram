import { randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const STATE_LOCK_WAIT_MS = 2_000;
const STATE_LOCK_FRESH_MS = 5_000;
const STATE_LOCK_POLL_MS = 20;
const STATE_REAPER_STALE_MS = 10_000;

interface StateLockOwner {
  pid: number;
  nonce?: string;
}

function owner(lockPath: string): StateLockOwner | undefined {
  try {
    const content = readFileSync(lockPath, "utf8").trim();
    const newline = content.indexOf("\n");
    const pid = Number.parseInt(newline < 0 ? content : content.slice(0, newline), 10);
    if (!Number.isFinite(pid) || pid <= 0) return undefined;
    if (newline >= 0) {
      const parsed = JSON.parse(content.slice(newline + 1)) as Partial<StateLockOwner>;
      if (parsed.pid === pid) return { pid, nonce: parsed.nonce };
    }
    return { pid };
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function fresh(lockPath: string, ageMs: number): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs < ageMs;
  } catch {
    return false;
  }
}

function claim(lockPath: string, content: string): boolean {
  const temp = `${lockPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, content, { mode: 0o600 });
  try {
    linkSync(temp, lockPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    return false;
  } finally {
    rmSync(temp, { force: true });
  }
}

function ownedBy(lockPath: string, nonce: string): boolean {
  const current = owner(lockPath);
  return current?.pid === process.pid && current.nonce === nonce;
}

function tryAcquire(lockPath: string, nonce: string): { ok: true } | { ok: false; holder?: number } {
  const content = `${process.pid}\n${JSON.stringify({ pid: process.pid, nonce })}`;
  if (claim(lockPath, content)) return { ok: true };

  // The previous holder can release between our failed link and this read. In
  // that gap there is nothing stale to reap: retry the atomic claim instead.
  // Reaping an absent path races the next legitimate claimant and can let two
  // read-modify-writes enter together.
  if (!existsSync(lockPath)) return { ok: false };
  let current = owner(lockPath);
  // A fresh record is held even if its owner text is temporarily unreadable.
  if (fresh(lockPath, STATE_LOCK_FRESH_MS) || (current && alive(current.pid))) {
    return { ok: false, holder: current?.pid };
  }

  const reaper = `${lockPath}.reap`;
  if (!claim(reaper, content)) {
    if (fresh(reaper, STATE_REAPER_STALE_MS)) return { ok: false, holder: current?.pid };
    rmSync(reaper, { force: true });
    if (!claim(reaper, content)) return { ok: false, holder: owner(lockPath)?.pid };
  }

  try {
    if (!ownedBy(reaper, nonce)) return { ok: false, holder: owner(lockPath)?.pid };
    // Another contender may have completed the stale reclaim while this one
    // waited for the reaper. Never turn that now-absent gap into a reclaim.
    if (!existsSync(lockPath)) return { ok: false };
    current = owner(lockPath);
    if (fresh(lockPath, STATE_LOCK_FRESH_MS) || (current && alive(current.pid))) {
      return { ok: false, holder: current?.pid };
    }
    rmSync(lockPath, { force: true });
    return claim(lockPath, content) ? { ok: true } : { ok: false, holder: owner(lockPath)?.pid };
  } finally {
    if (ownedBy(reaper, nonce)) rmSync(reaper, { force: true });
  }
}

/** Run a short synchronous state mutation while exclusively holding its lock. */
export function withStateLock<T>(lockPath: string, mutate: () => T, warn?: (message: string) => void): T {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const nonce = randomBytes(12).toString("hex");
  const deadline = Date.now() + STATE_LOCK_WAIT_MS;

  while (true) {
    const result = tryAcquire(lockPath, nonce);
    if (result.ok) break;
    if (Date.now() >= deadline) {
      const message = `could not acquire state lock ${lockPath} (held by pid ${result.holder ?? "unknown"})`;
      warn?.(message);
      throw new Error(message);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, STATE_LOCK_POLL_MS);
  }

  try {
    return mutate();
  } finally {
    if (ownedBy(lockPath, nonce)) rmSync(lockPath, { force: true });
  }
}
