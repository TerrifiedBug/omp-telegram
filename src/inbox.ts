import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const INBOX_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const INBOX_MAX_TOTAL_BYTES = 250 * 1024 * 1024;
export const INBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

type InboxFile = { path: string; size: number; mtimeMs: number };

export interface PruneInboxOptions {
  now?: number;
  maxTotalBytes?: number;
  retentionMs?: number;
  preserve?: ReadonlySet<string>;
}

/** Remove expired files, then oldest files until the inbox fits its total quota. */
export async function pruneInbox(dir: string, options: PruneInboxOptions = {}): Promise<{ totalBytes: number; removed: string[] }> {
  const now = options.now ?? Date.now();
  const maxTotalBytes = options.maxTotalBytes ?? INBOX_MAX_TOTAL_BYTES;
  const retentionMs = options.retentionMs ?? INBOX_RETENTION_MS;
  const preserve = new Set([...(options.preserve ?? [])].map((path) => resolve(path)));
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const files: InboxFile[] = [];
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    let info;
    try {
      info = await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (info.isFile()) files.push({ path, size: info.size, mtimeMs: info.mtimeMs });
  }

  files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  const removed: string[] = [];
  let totalBytes = files.reduce((total, file) => total + file.size, 0);

  for (const file of files) {
    if (preserve.has(resolve(file.path))) continue;
    const expired = now - file.mtimeMs > retentionMs;
    if (!expired && totalBytes <= maxTotalBytes) continue;
    try {
      await unlink(file.path);
      totalBytes -= file.size;
      removed.push(file.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      totalBytes -= file.size;
    }
  }

  return { totalBytes, removed };
}

/** Persist one bounded attachment with private permissions and enforce inbox quota. */
export async function storeInboxFile(dir: string, filename: string, bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength > INBOX_MAX_FILE_BYTES) {
    throw new Error(`Telegram attachment is too large (${bytes.byteLength} bytes, max ${INBOX_MAX_FILE_BYTES})`);
  }
  await pruneInbox(dir);
  const path = join(dir, filename);
  await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
  try {
    const result = await pruneInbox(dir, { preserve: new Set([path]) });
    if (result.totalBytes > INBOX_MAX_TOTAL_BYTES) {
      throw new Error(`Telegram inbox quota exceeded (${result.totalBytes} bytes, max ${INBOX_MAX_TOTAL_BYTES})`);
    }
    return path;
  } catch (error) {
    await unlink(path).catch(() => undefined);
    throw error;
  }
}
