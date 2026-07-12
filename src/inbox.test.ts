import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_MAX_FILE_BYTES, pruneInbox, storeInboxFile } from "./inbox";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "omp-tg-inbox-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("Telegram inbox policy", () => {
  test("stores bounded attachments privately without changing their bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const path = await storeInboxFile(dir, "attachment.bin", bytes);
    expect(new Uint8Array(await readFile(path))).toEqual(bytes);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("rejects the actual downloaded body above 20 MiB", async () => {
    const oversized = new Uint8Array(INBOX_MAX_FILE_BYTES + 1);
    await expect(storeInboxFile(dir, "oversized.bin", oversized)).rejects.toThrow("too large");
    await expect(stat(join(dir, "oversized.bin"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("removes expired files while preserving fresh files", async () => {
    const old = join(dir, "old.bin");
    const fresh = join(dir, "fresh.bin");
    await writeFile(old, new Uint8Array(4));
    await writeFile(fresh, new Uint8Array(5));
    await utimes(old, new Date(1_000), new Date(1_000));
    await utimes(fresh, new Date(9_500), new Date(9_500));

    const result = await pruneInbox(dir, { now: 10_000, retentionMs: 1_000, maxTotalBytes: 100 });
    expect(result.removed).toEqual([old]);
    await expect(stat(old)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(fresh)).size).toBe(5);
  });

  test("deletes oldest files until under quota and never deletes the preserved file", async () => {
    const oldest = join(dir, "a.bin");
    const middle = join(dir, "b.bin");
    const current = join(dir, "current.bin");
    await writeFile(oldest, new Uint8Array(4));
    await writeFile(middle, new Uint8Array(4));
    await writeFile(current, new Uint8Array(4));
    await utimes(oldest, new Date(1_000), new Date(1_000));
    await utimes(middle, new Date(2_000), new Date(2_000));
    await utimes(current, new Date(3_000), new Date(3_000));

    const result = await pruneInbox(dir, {
      now: 4_000,
      retentionMs: 10_000,
      maxTotalBytes: 5,
      preserve: new Set([current]),
    });
    expect(result.removed).toEqual([oldest, middle]);
    expect(result.totalBytes).toBe(4);
    expect((await stat(current)).size).toBe(4);
  });
});
