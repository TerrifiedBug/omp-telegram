// Owner-only Telegram control plane backed by herdr's JSON CLI. The public
// interface stays small: list current spaces and spawn one omp process. No
// Telegram or extension state lives here, so command behavior is testable.

import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Access } from "./access";
import { controlTopicTarget, isPairedOwnerDm, pairedOwnerId } from "./access";
import type { TgCallbackQuery, TgMessage } from "./api";
import type { ThreadEntry, ThreadRegistry } from "./topics";

export type RunHerdr = (args: readonly string[]) => Promise<string>;

export interface ControlSpace {
  workspaceId: string;
  label: string;
  ompCwds: string[];
  terminalIds: string[];
  status: string;
  ompCount: number;
  ompStatuses: string[];
}

interface WorkspaceWire {
  workspace_id?: unknown;
  label?: unknown;
  agent_status?: unknown;
}

interface PaneWire {
  workspace_id?: unknown;
  pane_id?: unknown;
  agent?: unknown;
  agent_status?: unknown;
  cwd?: unknown;
  terminal_id?: unknown;
  agent_session?: unknown;
}

function resultArray(raw: string, key: "workspaces" | "panes"): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`herdr returned invalid JSON for ${key}`);
  }
  const result = (parsed as { result?: Record<string, unknown> } | null)?.result;
  const value = result?.[key];
  if (!Array.isArray(value)) throw new Error(`herdr response is missing result.${key}`);
  return value;
}

function resultCreatedTab(raw: string): { tabId: string; paneId: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("herdr returned invalid JSON for tab create");
  }
  const result = (parsed as { result?: { tab?: { tab_id?: unknown }; root_pane?: { pane_id?: unknown } } } | null)?.result;
  const tabId = result?.tab?.tab_id;
  const paneId = result?.root_pane?.pane_id;
  if (typeof tabId !== "string" || tabId.length === 0) {
    throw new Error("herdr tab create response is missing result.tab.tab_id");
  }
  if (typeof paneId !== "string" || paneId.length === 0) {
    throw new Error("herdr tab create response is missing result.root_pane.pane_id");
  }
  return { tabId, paneId };
}

export const runHerdr: RunHerdr = async (args) => {
  if (process.env.HERDR_ENV !== "1") throw new Error("herdr control is unavailable outside a herdr-managed pane");
  const bin = process.env.HERDR_BIN_PATH || "herdr";
  return await new Promise<string>((resolve, reject) => {
    execFile(bin, [...args], { encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = stderr.trim() || err.message;
        reject(new Error(`herdr ${args.join(" ")} failed: ${detail}`));
        return;
      }
      resolve(stdout);
    });
  });
};

/** Snapshot open herdr spaces, enriched with live omp counts and statuses. */
export async function listControlSpaces(run: RunHerdr = runHerdr): Promise<ControlSpace[]> {
  const [workspaceRaw, paneRaw] = await Promise.all([run(["workspace", "list"]), run(["pane", "list"])]);
  const panes = resultArray(paneRaw, "panes") as PaneWire[];
  const ompByWorkspace = new Map<string, { statuses: string[]; cwds: string[] }>();
  const terminalsByWorkspace = new Map<string, string[]>();

  for (const pane of panes) {
    if (typeof pane.workspace_id !== "string") continue;
    if (typeof pane.terminal_id === "string") {
      const terminalIds = terminalsByWorkspace.get(pane.workspace_id) ?? [];
      terminalIds.push(pane.terminal_id);
      terminalsByWorkspace.set(pane.workspace_id, terminalIds);
    }
    if (pane.agent !== "omp") continue;
    const session = ompByWorkspace.get(pane.workspace_id) ?? { statuses: [], cwds: [] };
    session.statuses.push(typeof pane.agent_status === "string" ? pane.agent_status : "unknown");
    if (typeof pane.cwd === "string") session.cwds.push(pane.cwd);
    ompByWorkspace.set(pane.workspace_id, session);
  }

  const spaces: ControlSpace[] = [];
  for (const item of resultArray(workspaceRaw, "workspaces") as WorkspaceWire[]) {
    if (typeof item.workspace_id !== "string" || typeof item.label !== "string") continue;
    const omp = ompByWorkspace.get(item.workspace_id) ?? { statuses: [], cwds: [] };
    spaces.push({
      workspaceId: item.workspace_id,
      label: item.label,
      ompCwds: omp.cwds,
      terminalIds: terminalsByWorkspace.get(item.workspace_id) ?? [],
      status: typeof item.agent_status === "string" ? item.agent_status : "unknown",
      ompCount: omp.statuses.length,
      ompStatuses: omp.statuses,
    });
  }

  return spaces.sort((a, b) => b.ompCount - a.ompCount || a.label.localeCompare(b.label));
}

/** Locate the herdr space that currently hosts one exact omp session file. */
export async function findSessionSpace(sessionFile: string, run: RunHerdr = runHerdr): Promise<ControlSpace | undefined> {
  const panes = resultArray(await run(["pane", "list"]), "panes") as PaneWire[];
  const pane = panes.find((candidate) => {
    const value = (candidate.agent_session as { value?: unknown } | undefined)?.value;
    return candidate.agent === "omp" && value === sessionFile;
  });
  if (typeof pane?.workspace_id !== "string") return undefined;
  return (await listControlSpaces(run)).find((space) => space.workspaceId === pane.workspace_id);
}

type HerdrSpaceRef = Pick<ControlSpace, "workspaceId" | "label" | "terminalIds">;

/** Revalidate a space snapshot, create an unfocused tab, and run one shell command. */
export async function spawnOmp(
  expected: HerdrSpaceRef,
  run: RunHerdr = runHerdr,
  command = "omp",
): Promise<{ paneId: string }> {
  const current = await listControlSpaces(run);
  const space = current.find(
    (candidate) =>
      candidate.workspaceId === expected.workspaceId &&
      candidate.label === expected.label &&
      (expected.terminalIds.length === 0 ||
        candidate.terminalIds.length === 0 ||
        expected.terminalIds.some((terminalId) => candidate.terminalIds.includes(terminalId))),
  );
  if (!space) throw new Error("that herdr space changed or closed; run /spawn again");

  const created = resultCreatedTab(
    await run(["tab", "create", "--workspace", space.workspaceId, "--label", "omp", "--no-focus"]),
  );
  try {
    await run(["pane", "run", created.paneId, command]);
  } catch (err) {
    await run(["tab", "close", created.tabId]).catch(() => undefined);
    throw err;
  }
  return { paneId: created.paneId };
}

export function validWorktreeBranch(branch: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(branch);
}

export function workspaceDirectoryError(cwd: string): string | undefined {
  if (!isAbsolute(cwd)) return "the directory must be an absolute path";
  try {
    if (!statSync(cwd).isDirectory()) return "the path is not a directory";
  } catch {
    return "the directory does not exist";
  }
  return undefined;
}

interface CreatedWorkspaceRefs {
  workspaceId?: string;
  paneId?: string;
}

function createdWorkspaceRefs(raw: string, operation: string): CreatedWorkspaceRefs {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`herdr returned invalid JSON for ${operation}`);
  }
  if (!parsed || typeof parsed !== "object" || !("result" in parsed) || !parsed.result || typeof parsed.result !== "object") {
    throw new Error(`herdr ${operation} response is missing result`);
  }
  const result = parsed.result;
  const workspace =
    "workspace" in result && result.workspace && typeof result.workspace === "object" ? result.workspace : undefined;
  const rootPane =
    "root_pane" in result && result.root_pane && typeof result.root_pane === "object" ? result.root_pane : undefined;
  const nestedWorkspaceId =
    workspace && "workspace_id" in workspace && typeof workspace.workspace_id === "string" ? workspace.workspace_id : undefined;
  const directWorkspaceId =
    "workspace_id" in result && typeof result.workspace_id === "string" ? result.workspace_id : undefined;
  const paneId = rootPane && "pane_id" in rootPane && typeof rootPane.pane_id === "string" ? rootPane.pane_id : undefined;
  return { workspaceId: nestedWorkspaceId ?? directWorkspaceId, paneId };
}

async function resolveCreatedPane(
  raw: string,
  operation: string,
  previousWorkspaceIds: ReadonlySet<string>,
  run: RunHerdr,
): Promise<string> {
  const refs = createdWorkspaceRefs(raw, operation);
  if (refs.paneId) return refs.paneId;
  let workspaceId = refs.workspaceId;
  if (!workspaceId) {
    for (const item of resultArray(await run(["workspace", "list"]), "workspaces")) {
      if (!item || typeof item !== "object" || !("workspace_id" in item) || typeof item.workspace_id !== "string") continue;
      if (!previousWorkspaceIds.has(item.workspace_id)) {
        workspaceId = item.workspace_id;
        break;
      }
    }
  }
  if (!workspaceId) throw new Error(`herdr ${operation} response did not identify the created workspace`);
  for (const item of resultArray(await run(["pane", "list"]), "panes")) {
    if (!item || typeof item !== "object") continue;
    if (!("workspace_id" in item) || item.workspace_id !== workspaceId) continue;
    if ("pane_id" in item && typeof item.pane_id === "string" && item.pane_id.length > 0) return item.pane_id;
  }
  throw new Error(`herdr ${operation} response did not identify the created root pane`);
}

/** Create a git worktree from a revalidated source space and start omp in it. */
export async function createWorktreeOmp(
  source: HerdrSpaceRef,
  branch: string,
  run: RunHerdr = runHerdr,
): Promise<{ paneId: string }> {
  if (!validWorktreeBranch(branch)) throw new Error("invalid worktree branch");
  const spaces = await listControlSpaces(run);
  const current = spaces.find(
    (candidate) =>
      candidate.workspaceId === source.workspaceId &&
      candidate.label === source.label &&
      (source.terminalIds.length === 0 ||
        candidate.terminalIds.length === 0 ||
        source.terminalIds.some((terminalId) => candidate.terminalIds.includes(terminalId))),
  );
  if (!current) throw new Error("that herdr space changed or closed; run /spawn new again");
  const raw = await run([
    "worktree",
    "create",
    "--workspace",
    current.workspaceId,
    "--branch",
    branch,
    "--no-focus",
    "--json",
  ]);
  const paneId = await resolveCreatedPane(raw, "worktree create", new Set(spaces.map((space) => space.workspaceId)), run);
  await run(["pane", "run", paneId, "omp"]);
  return { paneId };
}

/** Create a herdr workspace rooted at one local directory and start omp in it. */
export async function createWorkspaceOmp(cwd: string, run: RunHerdr = runHerdr): Promise<{ paneId: string }> {
  const invalid = workspaceDirectoryError(cwd);
  if (invalid) throw new Error(invalid);
  const spaces = await listControlSpaces(run);
  const raw = await run(["workspace", "create", "--cwd", cwd, "--no-focus"]);
  const paneId = await resolveCreatedPane(raw, "workspace create", new Set(spaces.map((space) => space.workspaceId)), run);
  await run(["pane", "run", paneId, "omp"]);
  return { paneId };
}

/** Single-quote one local value for herdr's shell-command interface. */
function shellArg(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

/** Restart the exact omp conversation previously attached to a stale topic. */
export async function resumeOmp(entry: ThreadEntry, run: RunHerdr = runHerdr): Promise<{ paneId: string }> {
  const resume = entry.sessionFile || entry.sessionId;
  if (!resume) throw new Error("this topic has no saved omp session identity");
  if (!entry.workspaceId || !entry.workspaceLabel || !entry.workspaceTerminalIds) {
    throw new Error("this topic has no saved herdr space identity");
  }
  const command = `omp --cwd ${shellArg(entry.cwd)} --resume ${shellArg(resume)}`;
  return spawnOmp(
    {
      workspaceId: entry.workspaceId,
      label: entry.workspaceLabel,
      terminalIds: entry.workspaceTerminalIds,
    },
    run,
    command,
  );
}

export function formatSpaceButton(space: ControlSpace): string {
  const count = space.ompCount === 0 ? "no omp" : `${space.ompCount} omp · ${[...new Set(space.ompStatuses)].join("/")}`;
  const label = `${space.label} · ${count}`;
  return label.length <= 60 ? label : `${label.slice(0, 57)}...`;
}

/** Read-only owner view: herdr processes plus live and stale Telegram claims. */
export function formatSessions(spaces: readonly ControlSpace[], registry: ThreadRegistry, alive: (pid: number) => boolean): string {
  const liveTopics: Array<[string, ThreadRegistry["threads"][string]]> = [];
  const staleTopics: Array<[string, ThreadRegistry["threads"][string]]> = [];
  for (const entry of Object.entries(registry.threads)) {
    (alive(entry[1].pid) ? liveTopics : staleTopics).push(entry);
  }
  const lines = ["OMP sessions"];
  const seenCwds = new Set<string>();

  for (const space of spaces) {
    const topics = liveTopics.filter(([, entry]) => space.ompCwds.includes(entry.cwd));
    if (space.ompCount === 0) continue;
    for (const cwd of space.ompCwds) seenCwds.add(cwd);
    const statuses = space.ompStatuses.length ? [...new Set(space.ompStatuses)].join("/") : space.status;
    const topicText = topics.length === 0 ? "no Telegram topic" : `${topics.length} topic${topics.length === 1 ? "" : "s"}`;
    lines.push(`${topics.length === 0 ? "[unattached] " : ""}${space.label} — ${space.ompCount} omp (${statuses}), ${topicText}`);
  }

  for (const [, entry] of liveTopics) {
    if (seenCwds.has(entry.cwd)) continue;
    lines.push(`[outside herdr] ${entry.name} — live topic owner pid ${entry.pid}`);
    seenCwds.add(entry.cwd);
  }

  if (lines.length === 1) lines.push("No live omp sessions.");
  for (const [threadId, entry] of staleTopics) {
    lines.push(`[stale topic] ${entry.name} — thread ${threadId}, no live owner`);
  }

  return lines.join("\n");
}

type InlineKeyboard = { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
export type TelegramCall = <T>(method: string, payload: Record<string, unknown>) => Promise<T>;

export interface CommandMessageOptions {
  access: Access;
  callTelegram: TelegramCall;
  msg: TgMessage;
  text: string;
  replyMarkup?: InlineKeyboard;
  useControlTopic?: boolean;
  redirectText?: string;
  warn?: (message: string) => void;
}

/** Send a global command result home to omp control, with safe origin fallback. */
export async function sendCommandMessage(options: CommandMessageOptions): Promise<TgMessage | undefined> {
  const { access, callTelegram, msg, text, replyMarkup } = options;
  const warn = options.warn ?? (() => undefined);
  const origin = {
    chat_id: String(msg.chat.id),
    ...(msg.is_topic_message && msg.message_thread_id != null ? { message_thread_id: msg.message_thread_id } : {}),
  };
  const control = options.useControlTopic === false ? undefined : controlTopicTarget(access);
  let sent: TgMessage;
  try {
    sent = await callTelegram<TgMessage>("sendMessage", {
      ...(control ? { chat_id: control.chatId, message_thread_id: control.threadId } : origin),
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  } catch (err) {
    warn(`command reply failed: ${String(err)}`);
    if (!control) return undefined;
    try {
      return await callTelegram<TgMessage>("sendMessage", {
        ...origin,
        text,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
    } catch (fallbackErr) {
      warn(`command reply fallback failed: ${String(fallbackErr)}`);
      return undefined;
    }
  }

  if (control && (String(msg.chat.id) !== control.chatId || msg.message_thread_id !== control.threadId)) {
    await callTelegram("sendMessage", {
      ...origin,
      text: options.redirectText ?? 'Handled in the "omp control" topic.',
    }).catch((err) => warn(`control-topic redirect notice failed: ${String(err)}`));
  }
  return sent;
}

interface SpawnPicker {
  ownerId: string;
  chatId: string;
  messageId: number;
  spaces: ControlSpace[];
  selected?: ControlSpace;
  mode: "space" | "worktree";
  branch?: string;
  directory?: string;
  expiresAt: number;
}

export interface SpawnControllerOptions {
  getAccess: () => Access;
  callTelegram: TelegramCall;
  warn?: (message: string) => void;
  listSpaces?: () => Promise<ControlSpace[]>;
  spawn?: (space: ControlSpace) => Promise<{ paneId: string }>;
  createWorktree?: (space: ControlSpace, branch: string) => Promise<{ paneId: string }>;
  createWorkspace?: (cwd: string) => Promise<{ paneId: string }>;
  nonce?: () => string;
  now?: () => number;
}

/**
 * Stateful, owner-authenticated /spawn picker. Consumes a confirmation before
 * spawning, so callback redelivery and double taps cannot create two sessions.
 */
export class SpawnController {
  readonly #getAccess: () => Access;
  readonly #call: TelegramCall;
  readonly #warn: (message: string) => void;
  readonly #listSpaces: () => Promise<ControlSpace[]>;
  readonly #spawn: (space: ControlSpace) => Promise<{ paneId: string }>;
  readonly #createWorktree: (space: ControlSpace, branch: string) => Promise<{ paneId: string }>;
  readonly #createWorkspace: (cwd: string) => Promise<{ paneId: string }>;
  readonly #nonce: () => string;
  readonly #now: () => number;
  readonly #pickers = new Map<string, SpawnPicker>();

  constructor(options: SpawnControllerOptions) {
    this.#getAccess = options.getAccess;
    this.#call = options.callTelegram;
    this.#warn = options.warn ?? (() => undefined);
    this.#listSpaces = options.listSpaces ?? (() => listControlSpaces());
    this.#spawn = options.spawn ?? ((space) => spawnOmp(space));
    this.#createWorktree = options.createWorktree ?? ((space, branch) => createWorktreeOmp(space, branch));
    this.#createWorkspace = options.createWorkspace ?? ((cwd) => createWorkspaceOmp(cwd));
    this.#nonce = options.nonce ?? (() => randomBytes(6).toString("base64url"));
    this.#now = options.now ?? Date.now;
  }

  async start(msg: TgMessage, requestedLabel: string): Promise<void> {
    const access = this.#getAccess();
    const ownerId = pairedOwnerId(access);
    if (!isPairedOwnerDm(String(msg.from?.id ?? ""), String(msg.chat.id), msg.chat.type, access) || !ownerId) return;

    const request = requestedLabel.trim();
    if (request === "dir" || request.startsWith("dir ")) {
      const directory = request.slice(3).trim();
      const invalid = workspaceDirectoryError(directory);
      if (invalid) {
        await this.#send(msg, `usage: /spawn dir <absolute-path> (${invalid})`);
        return;
      }
      this.#prune();
      const nonce = this.#nonce();
      const sent = await this.#send(msg, `Create workspace at ${directory} and start omp?`, this.#confirmationKeyboard(nonce));
      if (!sent) return;
      this.#pickers.set(nonce, {
        ownerId,
        chatId: String(msg.chat.id),
        messageId: sent.message_id,
        spaces: [],
        mode: "space",
        directory,
        expiresAt: this.#now() + 5 * 60_000,
      });
      return;
    }

    let mode: "space" | "worktree" = "space";
    let branch: string | undefined;
    let spaceLabel = request;
    if (request === "new" || request.startsWith("new ")) {
      mode = "worktree";
      const [requestedBranch, ...labelParts] = request.slice(3).trim().split(/\s+/);
      branch = requestedBranch;
      spaceLabel = labelParts.join(" ");
      if (!branch || !validWorktreeBranch(branch)) {
        await this.#send(msg, "usage: /spawn new <branch> [space-label]");
        return;
      }
    }

    let spaces: ControlSpace[];
    try {
      spaces = await this.#listSpaces();
    } catch (err) {
      await this.#send(msg, `Cannot list herdr spaces: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (spaces.length === 0) {
      await this.#send(msg, "No open herdr spaces.");
      return;
    }

    this.#prune();
    const nonce = this.#nonce();
    const exact = spaceLabel
      ? spaces.filter((space) => space.label.toLowerCase() === spaceLabel.toLowerCase())
      : [];
    const selected = exact.length === 1 ? exact[0] : undefined;
    const safeRequested = spaceLabel.replace(/[\r\n]/g, " ");
    const picker: SpawnPicker = {
      ownerId,
      chatId: String(msg.chat.id),
      messageId: 0,
      spaces,
      selected,
      mode,
      branch,
      expiresAt: this.#now() + 5 * 60_000,
    };
    const text = selected
      ? this.#confirmationText(picker, selected)
      : mode === "worktree"
        ? `Choose the source space for worktree ${branch}:`
        : spaceLabel
          ? `No unique open space named "${safeRequested}". Choose a herdr space:`
          : "Choose a herdr space:";
    const sent = await this.#send(
      msg,
      text,
      selected ? this.#confirmationKeyboard(nonce) : this.#pickerKeyboard(nonce, spaces, 0),
    );
    if (!sent) return;
    picker.messageId = sent.message_id;
    this.#pickers.set(nonce, picker);
  }

  /** Returns false only for callbacks not owned by this controller. */
  async handleCallback(query: TgCallbackQuery): Promise<boolean> {
    const data = query.data;
    if (!data?.startsWith("sp:")) return false;
    const access = this.#getAccess();
    const ownerId = pairedOwnerId(access);
    const message = query.message;
    if (
      !message ||
      !ownerId ||
      !isPairedOwnerDm(String(query.from.id), String(message.chat.id), message.chat.type, access)
    ) {
      await this.#answer(query.id, "This control is restricted to the paired owner.", true);
      return true;
    }

    const [, action, nonce, value] = data.split(":");
    this.#prune();
    const picker = this.#pickers.get(nonce);
    if (
      !picker ||
      picker.ownerId !== ownerId ||
      picker.chatId !== String(message.chat.id) ||
      picker.messageId !== message.message_id
    ) {
      await this.#answer(query.id, "This picker expired. Run /spawn again.", true);
      return true;
    }

    if (action === "x") {
      this.#pickers.delete(nonce);
      await this.#answer(query.id);
      await this.#edit(query, "Spawn cancelled.", { inline_keyboard: [] });
      return true;
    }
    if (action === "p") {
      const page = Number.parseInt(value ?? "", 10);
      await this.#answer(query.id);
      await this.#edit(
        query,
        picker.mode === "worktree" ? `Choose the source space for worktree ${picker.branch}:` : "Choose a herdr space:",
        this.#pickerKeyboard(nonce, picker.spaces, Number.isFinite(page) ? page : 0),
      );
      return true;
    }
    if (action === "s") {
      const selected = picker.spaces[Number.parseInt(value ?? "", 10)];
      if (!selected) {
        await this.#answer(query.id, "That space is no longer available. Run /spawn again.", true);
        return true;
      }
      picker.selected = selected;
      await this.#answer(query.id);
      await this.#edit(query, this.#confirmationText(picker, selected), this.#confirmationKeyboard(nonce));
      return true;
    }
    if (action !== "y" || (!picker.selected && !picker.directory)) {
      await this.#answer(query.id);
      return true;
    }

    // Consume before the process side effect. Duplicate delivery sees an expired picker.
    this.#pickers.delete(nonce);
    const selected = picker.selected;
    const destination = picker.directory ?? selected?.label ?? "new workspace";
    await this.#answer(query.id, `Starting omp in ${destination}`);
    await this.#edit(query, `Starting omp in ${destination}...`, { inline_keyboard: [] });
    try {
      let result: { paneId: string };
      let text: string;
      if (picker.directory) {
        result = await this.#createWorkspace(picker.directory);
        text = `Started omp in new workspace ${picker.directory} (${result.paneId}). Its Telegram topic will appear after extension startup.`;
      } else if (!selected) {
        throw new Error("the selected herdr space is unavailable");
      } else if (picker.mode === "worktree") {
        if (!picker.branch) throw new Error("the worktree branch is missing");
        result = await this.#createWorktree(selected, picker.branch);
        text = `Started omp in new worktree ${picker.branch} (${result.paneId}). Its Telegram topic will appear after extension startup.`;
      } else {
        result = await this.#spawn(selected);
        text = `Started omp in ${selected.label} (${result.paneId}). Its Telegram topic will appear after extension startup.`;
      }
      await this.#edit(query, text, { inline_keyboard: [] });
    } catch (err) {
      await this.#edit(
        query,
        `Could not start omp in ${destination}: ${err instanceof Error ? err.message : String(err)}`,
        { inline_keyboard: [] },
      );
    }
    return true;
  }

  #prune(): void {
    const now = this.#now();
    for (const [nonce, picker] of this.#pickers) {
      if (picker.expiresAt <= now) this.#pickers.delete(nonce);
    }
  }

  #pickerKeyboard(nonce: string, spaces: readonly ControlSpace[], page: number): InlineKeyboard {
    const pageCount = Math.max(1, Math.ceil(spaces.length / 8));
    const safePage = Math.max(0, Math.min(page, pageCount - 1));
    const start = safePage * 8;
    const rows = spaces.slice(start, start + 8).map((space, offset) => [
      { text: formatSpaceButton(space), callback_data: `sp:s:${nonce}:${start + offset}` },
    ]);
    if (pageCount > 1) {
      const nav: Array<{ text: string; callback_data: string }> = [];
      if (safePage > 0) nav.push({ text: "Previous", callback_data: `sp:p:${nonce}:${safePage - 1}` });
      if (safePage + 1 < pageCount) nav.push({ text: "Next", callback_data: `sp:p:${nonce}:${safePage + 1}` });
      rows.push(nav);
    }
    rows.push([{ text: "Cancel", callback_data: `sp:x:${nonce}` }]);
    return { inline_keyboard: rows };
  }

  #confirmationKeyboard(nonce: string): InlineKeyboard {
    return {
      inline_keyboard: [
        [{ text: "Start omp", callback_data: `sp:y:${nonce}` }],
        [{ text: "Cancel", callback_data: `sp:x:${nonce}` }],
      ],
    };
  }

  #confirmationText(picker: SpawnPicker, space: ControlSpace): string {
    if (picker.mode === "worktree") return `Create worktree ${picker.branch} from ${space.label} and start omp?`;
    if (space.ompCount === 0) return `Start omp in ${space.label}?`;
    return `${space.label} already has ${space.ompCount} live omp session${space.ompCount === 1 ? "" : "s"}.\n\nStarting another creates a parallel agent and another Telegram topic.`;
  }

  #send(msg: TgMessage, text: string, replyMarkup?: InlineKeyboard): Promise<TgMessage | undefined> {
    return sendCommandMessage({
      access: this.#getAccess(),
      callTelegram: this.#call,
      msg,
      text,
      replyMarkup,
      redirectText: 'Continue in the "omp control" topic.',
      warn: this.#warn,
    });
  }

  async #edit(query: TgCallbackQuery, text: string, replyMarkup: InlineKeyboard): Promise<void> {
    if (!query.message) return;
    await this.#call("editMessageText", {
      chat_id: String(query.message.chat.id),
      message_id: query.message.message_id,
      text,
      reply_markup: replyMarkup,
    }).catch((err) => this.#warn(`picker edit failed: ${String(err)}`));
  }

  async #answer(id: string, text?: string, showAlert = false): Promise<void> {
    await this.#call("answerCallbackQuery", {
      callback_query_id: id,
      ...(text ? { text } : {}),
      ...(showAlert ? { show_alert: true } : {}),
    }).catch(() => undefined);
  }
}
