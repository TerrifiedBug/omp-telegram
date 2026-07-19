import { spawn } from "node:child_process";
import {
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type Access,
  canAnswerPrompt,
  ensureStateDir,
  loadAccess,
  pairedOwnerId,
  resolveToken,
  statePath,
} from "./access";
import { acquireLock, type Logger, Poller, releaseLock, tg, webhookConflictHint } from "./api";
import { type BridgeHost, ensureControlTopic, handleUpdate, syncBotCommands } from "./bridge";
import { SpawnController } from "./control";
import { TelegramPromptController } from "./prompts";
import { isAlive } from "./topics";

export interface DaemonState {
  pid: number;
  version: string;
  startedAt: number;
}

function packageVersion(): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
    return parsed && typeof parsed === "object" && "version" in parsed && typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

export function daemonDisableReason(access: Access, token: string): string | undefined {
  if (!access.enabled) return "bridge disabled";
  if (!access.topicsChat) return "topics off";
  if (Object.keys(access.groups).length > 0) return "groups configured";
  if (!token) return "bot token missing";
  return undefined;
}

export function readDaemonState(): DaemonState | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath("daemon.json"), "utf8"));
    if (!parsed || typeof parsed !== "object") return undefined;
    if (!("pid" in parsed) || typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 1) return undefined;
    if (!("version" in parsed) || typeof parsed.version !== "string") return undefined;
    if (!("startedAt" in parsed) || typeof parsed.startedAt !== "number" || !Number.isFinite(parsed.startedAt)) return undefined;
    return { pid: parsed.pid, version: parsed.version, startedAt: parsed.startedAt };
  } catch {
    return undefined;
  }
}

export function daemonAlive(state: DaemonState | undefined, alive: (pid: number) => boolean = isAlive): boolean {
  return !!state && alive(state.pid);
}

function saveDaemonState(state: DaemonState): void {
  ensureStateDir();
  const path = statePath("daemon.json");
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function rotateDaemonLog(): void {
  const path = statePath("daemon.log");
  try {
    if (statSync(path).size <= 5 * 1024 * 1024) return;
    rmSync(`${path}.1`, { force: true });
    renameSync(path, `${path}.1`);
  } catch {
    /* absent or best-effort rotation */
  }
}

interface SpawnedDaemon {
  once(event: "error", listener: (error: Error) => void): unknown;
  unref(): void;
}
type SpawnDaemon = (
  executable: string,
  args: string[],
  options: { detached: true; stdio: ["ignore", number, number] },
) => SpawnedDaemon;

export interface EnsureDaemonOptions {
  alive?: (pid: number) => boolean;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  spawn?: SpawnDaemon;
  sleep?: (ms: number) => void;
  now?: () => number;
  version?: string;
}

/** Ensure one current-version daemon is alive when topics-only routing permits it. */
export function ensureDaemon(
  warn: (message: string) => void,
  options: EnsureDaemonOptions = {},
): "alive" | "spawned" | "disabled" | "failed" {
  const reason = daemonDisableReason(loadAccess(warn), resolveToken());
  if (reason) return "disabled";

  const alive = options.alive ?? isAlive;
  const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  const sleep = options.sleep ?? ((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  const now = options.now ?? Date.now;
  const version = options.version ?? packageVersion();
  const spawnDaemon: SpawnDaemon = options.spawn ?? ((executable, args, spawnOptions) => spawn(executable, args, spawnOptions));
  const current = readDaemonState();
  if (current && daemonAlive(current, alive)) {
    if (current.version === version) return "alive";
    try {
      kill(current.pid, "SIGTERM");
    } catch (err) {
      warn(`could not stop daemon pid ${current.pid} for upgrade: ${String(err)}`);
      return "failed";
    }
    const deadline = now() + 3_000;
    while (alive(current.pid) && now() < deadline) sleep(50);
    if (alive(current.pid)) {
      warn(`daemon pid ${current.pid} did not stop within 3 seconds`);
      return "failed";
    }
  }

  ensureStateDir();
  rotateDaemonLog();
  const logFd = openSync(statePath("daemon.log"), "a", 0o600);
  try {
    const child = spawnDaemon(process.execPath, [join(import.meta.dirname, "daemon.ts")], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.once("error", (err) => warn(`daemon process failed: ${String(err)}`));
    child.unref();
    return "spawned";
  } catch (err) {
    warn(`could not spawn daemon: ${String(err)}`);
    return "failed";
  } finally {
    closeSync(logFd);
  }
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

const log: Logger = {
  debug: (message) => console.debug(message),
  info: (message) => console.info(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

/** Run the detached long-poll process until disabled or signalled. */
export async function runDaemon(): Promise<void> {
  rotateDaemonLog();
  const existing = readDaemonState();
  if (existing && daemonAlive(existing) && existing.pid !== process.pid) return;

  const version = packageVersion();
  const startedAt = Date.now();
  const lockPath = statePath("bot.lock");
  let poller: Poller | undefined;
  let stopping = false;
  let fatalState: { reason?: string } = {};
  let fatalBackoff = 60_000;

  const cleanup = (): void => {
    stopping = true;
    poller?.stop();
    releaseLock(lockPath);
    const current = readDaemonState();
    if (current?.pid === process.pid) rmSync(statePath("daemon.json"), { force: true });
  };
  const onSignal = (): void => {
    cleanup();
    process.exit(0);
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  try {
    while (!stopping) {
      const access = loadAccess(log.warn);
      const token = resolveToken();
      const disabled = daemonDisableReason(access, token);
      if (disabled) {
        log.info(`[telegram daemon] stopped: ${disabled}`);
        break;
      }

      const lock = acquireLock(lockPath);
      if (!lock.ok) {
        log.info(`[telegram daemon] another poller (pid ${lock.holder}) holds the lock; exiting`);
        break;
      }
      // Publish ownership only after the lock is held, so daemon.json.pid always
      // names the live poller — ensureDaemon's version-upgrade path stops exactly
      // that PID, and a starter that loses the lock never claims daemon.json.
      saveDaemonState({ pid: process.pid, version, startedAt });

      let botUsername = "";
      let botHasTopics: boolean | undefined;
      try {
        const me = await tg<{ username: string; has_topics_enabled?: boolean }>(token, "getMe");
        botUsername = me.username;
        botHasTopics = me.has_topics_enabled;
      } catch (err) {
        log.warn(`[telegram daemon] getMe failed: ${String(err)}`);
        releaseLock(lockPath);
        await sleep(fatalBackoff);
        fatalBackoff = Math.min(fatalBackoff * 2, 300_000);
        continue;
      }

      const callTelegram = <T>(method: string, payload: Record<string, unknown>): Promise<T> => tg<T>(token, method, payload);
      const spawnController = new SpawnController({ getAccess: () => loadAccess(log.warn), callTelegram, warn: log.warn });
      const promptController = new TelegramPromptController({
        callTelegram,
        authorize: (responderId, chatId, chatType) => canAnswerPrompt(responderId, chatId, chatType, loadAccess(log.warn)),
      });
      const host: BridgeHost = {
        isDaemon: true,
        selfPid: process.pid,
        token: () => token,
        botUsername: () => botUsername,
        botHasTopics: () => botHasTopics,
        ownThreadId: () => undefined,
        callTelegram,
        warn: log.warn,
        log,
        spawnController,
        promptController,
      };

      await syncBotCommands(callTelegram, pairedOwnerId(loadAccess(log.warn))).catch(() => {});
      await ensureControlTopic(host).catch((err) => log.warn(`[telegram daemon] control topic creation failed: ${String(err)}`));
      poller = new Poller();
      fatalState = {};
      poller.start(
        token,
        (update) => handleUpdate(host, update),
        (reason) => {
          fatalState.reason = reason;
          releaseLock(lockPath);
        },
        log,
      );
      log.info(`[telegram daemon] polling as @${botUsername} (pid ${process.pid}, v${version})`);
      const gateTimer = setInterval(() => {
        const reason = daemonDisableReason(loadAccess(log.warn), resolveToken());
        if (!reason) return;
        stopping = true;
        log.info(`[telegram daemon] stopping: ${reason}`);
        poller?.stop();
      }, 60_000);
      await poller.done();
      clearInterval(gateTimer);
      releaseLock(lockPath);
      if (stopping) break;
      const stoppedReason = fatalState.reason;
      if (stoppedReason) {
        if (stoppedReason.includes("409")) {
          try {
            const hint = await webhookConflictHint(token);
            if (hint) log.warn(`[telegram daemon] ${hint}`);
          } catch (err) {
            log.debug(`[telegram daemon] webhook diagnosis failed: ${String(err)}`);
          }
        }
        log.warn(`[telegram daemon] poller stopped: ${stoppedReason}; retrying in ${fatalBackoff}ms`);
        await sleep(fatalBackoff);
        fatalBackoff = Math.min(fatalBackoff * 2, 300_000);
      } else {
        fatalBackoff = 60_000;
      }
    }
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    cleanup();
  }
}

if (import.meta.main) {
  await runDaemon().catch((err) => {
    log.error(`[telegram daemon] fatal: ${String(err)}`);
    const state = readDaemonState();
    if (state?.pid === process.pid) rmSync(statePath("daemon.json"), { force: true });
    process.exitCode = 1;
  });
}
