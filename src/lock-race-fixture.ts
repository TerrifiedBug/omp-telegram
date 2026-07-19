// Test-only child process for the acquireLock concurrency regression in
// api.test.ts. It runs with a real, distinct PID so the operating system — not an
// in-process stub — decides the single winner, which no same-process test can
// reproduce. Coordination uses event-driven Bun IPC (no timers, no polling):
// announce `ready`, wait for the parent's `go`, report the acquire result, then
// idle until `release` so the winner keeps the lock held while the losers decide.
// Not a *.test.ts (bun-test ignores it) and absent from package.json "files", so
// it never ships.
import { acquireLock } from "./api";

const lockPath = process.argv[2];
if (!lockPath) throw new Error("lock-race-fixture: missing lock path argument");

process.on("message", (message: unknown) => {
  if (message === "go") {
    const result = acquireLock(lockPath);
    process.send?.(result.ok ? "ok" : "no");
    // Stay alive until released: the winner keeps its PID (and the lock) live
    // while the losers contend, so they observe a live holder, not a stale lock.
  } else if (message === "release") {
    process.exit(0);
  }
});

process.send?.("ready");
