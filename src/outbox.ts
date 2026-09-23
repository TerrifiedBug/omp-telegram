import { randomBytes } from "node:crypto";
import { mkdirSync, openSync, closeSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureStateDir } from "./access";

const OUTBOX_VERSION = 1;
const OUTBOX_RECORD_LIMIT = 50;
const STALE_CLAIM_MS = 5 * 60_000;

export type OutboxPartState = "pending" | "inflight" | "sent" | "failed" | "uncertain";
export type OutboxPartKind = "send" | "edit" | "rich";

export interface OutboxPart {
  kind: OutboxPartKind;
  text: string;
  useMd: boolean;
  allowRich: boolean;
  state: OutboxPartState;
  existingMessageId?: number;
  messageId?: number;
  detail?: string;
}

export interface OutboxRecord {
  version: 1;
  id: string;
  chatId: string;
  threadId?: number;
  createdAt: number;
  updatedAt: number;
  parts: OutboxPart[];
}

function outboxDir(): string {
  return join(ensureStateDir(), "outbox");
}

function recordPath(id: string): string {
  return join(outboxDir(), `${id}.json`);
}

function validPart(value: unknown): value is OutboxPart {
  if (!value || typeof value !== "object") return false;
  const part = value as Partial<OutboxPart>;
  return (
    (part.kind === "send" || part.kind === "edit" || part.kind === "rich") &&
    typeof part.text === "string" &&
    typeof part.useMd === "boolean" &&
    typeof part.allowRich === "boolean" &&
    (part.state === "pending" || part.state === "inflight" || part.state === "sent" || part.state === "failed" || part.state === "uncertain") &&
    (part.existingMessageId == null || (Number.isInteger(part.existingMessageId) && part.existingMessageId > 0)) &&
    (part.messageId == null || (Number.isInteger(part.messageId) && part.messageId > 0)) &&
    (part.detail == null || typeof part.detail === "string")
  );
}

function validRecord(value: unknown): value is OutboxRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<OutboxRecord>;
  return (
    record.version === OUTBOX_VERSION &&
    typeof record.id === "string" &&
    /^[a-zA-Z0-9-]+$/.test(record.id) &&
    typeof record.chatId === "string" &&
    (record.threadId == null || Number.isInteger(record.threadId)) &&
    typeof record.createdAt === "number" &&
    Number.isFinite(record.createdAt) &&
    typeof record.updatedAt === "number" &&
    Number.isFinite(record.updatedAt) &&
    Array.isArray(record.parts) &&
    record.parts.length > 0 &&
    record.parts.every(validPart)
  );
}

function readRecord(path: string): OutboxRecord | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return validRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function pruneOutbox(preserveId: string): void {
  const dir = outboxDir();
  const records: Array<{ id: string; updatedAt: number }> = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json") || name.includes(".tmp-")) continue;
    const record = readRecord(join(dir, name));
    if (record) records.push({ id: record.id, updatedAt: record.updatedAt });
  }
  records.sort((a, b) => b.updatedAt - a.updatedAt);
  const keep = new Set(records.slice(0, OUTBOX_RECORD_LIMIT).map((record) => record.id));
  keep.add(preserveId);
  for (const record of records) {
    if (!keep.has(record.id)) rmSync(recordPath(record.id), { force: true });
  }
}

/** Atomically persist a delivery record before and after every remote attempt. */
export function saveOutboxRecord(record: OutboxRecord): void {
  const dir = outboxDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  record.updatedAt = Date.now();
  const path = recordPath(record.id);
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  pruneOutbox(record.id);
}

export function createOutboxRecord(
  chatId: string,
  threadId: number | undefined,
  parts: OutboxPart[],
): OutboxRecord {
  const now = Date.now();
  const record: OutboxRecord = {
    version: OUTBOX_VERSION,
    id: `${now}-${process.pid}-${randomBytes(8).toString("hex")}`,
    chatId,
    ...(threadId != null ? { threadId } : {}),
    createdAt: now,
    updatedAt: now,
    parts,
  };
  saveOutboxRecord(record);
  return record;
}

export function loadOutboxRecord(id: string): OutboxRecord | undefined {
  return readRecord(recordPath(id));
}

/** All retained deliveries, newest first. Malformed records are ignored. */
export function listOutboxRecords(): OutboxRecord[] {
  const dir = outboxDir();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: OutboxRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.includes(".tmp-")) continue;
    const record = readRecord(join(dir, name));
    if (record) records.push(record);
  }
  return records.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function loadOutboxRecords(chatId: string, threadId?: number): OutboxRecord[] {
  return listOutboxRecords()
    .filter((record) => record.chatId === chatId && record.threadId === threadId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function removeOutboxRecord(id: string): void {
  rmSync(recordPath(id), { force: true });
}

/** Claim one record so two live sessions cannot retry the same chunks concurrently. */
export function claimOutboxRecord(id: string): (() => void) | undefined {
  const dir = outboxDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${id}.lock`);
  try {
    const fd = openSync(path, "wx", 0o600);
    closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try {
      if (Date.now() - statSync(path).mtimeMs <= STALE_CLAIM_MS) return undefined;
      rmSync(path, { force: true });
      const fd = openSync(path, "wx", 0o600);
      closeSync(fd);
    } catch {
      return undefined;
    }
  }
  return () => rmSync(path, { force: true });
}
