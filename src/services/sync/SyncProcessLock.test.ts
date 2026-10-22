import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCK_STALE_MS, type SyncLockFileData, SyncProcessLock } from "./SyncProcessLock";

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-synclock-"));
  lockPath = path.join(dir, "sync", "lock.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function readLockFile(): SyncLockFileData {
  return JSON.parse(fs.readFileSync(lockPath, "utf8")) as SyncLockFileData;
}

function writeLockFile(data: Partial<SyncLockFileData>): void {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify(data), "utf8");
}

describe("SyncProcessLock", () => {
  it("acquires, reports ownership and releases", async () => {
    const lock = new SyncProcessLock(lockPath);
    expect(lock.isOwner()).toBe(false);
    await expect(lock.acquire(1_000)).resolves.toBe(true);
    expect(lock.isOwner()).toBe(true);
    const data = readLockFile();
    expect(data.pid).toBe(process.pid);
    expect(data.lockId).toEqual(expect.any(String));
    expect(data.renewedAt).toEqual(expect.any(Number));

    await lock.release();
    expect(lock.isOwner()).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(false);

    // The freed lock is acquirable again.
    const next = new SyncProcessLock(lockPath);
    await expect(next.acquire(1_000)).resolves.toBe(true);
  });

  it("rejects a second acquirer until its timeout", async () => {
    const first = new SyncProcessLock(lockPath);
    const second = new SyncProcessLock(lockPath);
    await expect(first.acquire(1_000)).resolves.toBe(true);
    const firstId = readLockFile().lockId;

    await expect(second.acquire(150)).resolves.toBe(false);
    expect(second.isOwner()).toBe(false);
    // The holder is unaffected by the failed attempt.
    expect(first.isOwner()).toBe(true);
    expect(readLockFile().lockId).toBe(firstId);
  });

  it("takes over a stale lock", async () => {
    const first = new SyncProcessLock(lockPath);
    await expect(first.acquire(1_000)).resolves.toBe(true);
    const data = readLockFile();
    writeLockFile({
      ...data,
      renewedAt: Date.now() - LOCK_STALE_MS - 5_000,
    });

    const second = new SyncProcessLock(lockPath);
    await expect(second.acquire(1_000)).resolves.toBe(true);
    expect(second.isOwner()).toBe(true);
    // The dispossessed owner learns about the takeover on renewal.
    await expect(first.renew()).resolves.toBe(false);
    expect(first.isOwner()).toBe(false);
  });

  it("treats an unreadable lock file as stale", async () => {
    writeLockFile({} as Partial<SyncLockFileData>);
    fs.writeFileSync(lockPath, "not json", "utf8");
    const lock = new SyncProcessLock(lockPath);
    await expect(lock.acquire(1_000)).resolves.toBe(true);
    expect(readLockFile().lockId).toEqual(expect.any(String));
  });

  it("renews in place only for the owner", async () => {
    const lock = new SyncProcessLock(lockPath);
    await expect(lock.acquire(1_000)).resolves.toBe(true);
    const before = readLockFile();
    await expect(lock.renew()).resolves.toBe(true);
    const after = readLockFile();
    expect(after.lockId).toBe(before.lockId);
    expect(after.renewedAt).toBeGreaterThanOrEqual(before.renewedAt);
    expect(after.acquiredAt).toBe(before.acquiredAt);

    // A non-owner renew is a clean no-op that keeps the file intact.
    const other = new SyncProcessLock(lockPath);
    await expect(other.renew()).resolves.toBe(false);
    expect(other.isOwner()).toBe(false);
    expect(readLockFile().lockId).toBe(before.lockId);
  });

  it("renew fails once the lock file disappears", async () => {
    const lock = new SyncProcessLock(lockPath);
    await expect(lock.acquire(1_000)).resolves.toBe(true);
    fs.rmSync(lockPath);
    await expect(lock.renew()).resolves.toBe(false);
    expect(lock.isOwner()).toBe(false);
  });

  it("release never deletes another owner's lock", async () => {
    const first = new SyncProcessLock(lockPath);
    await expect(first.acquire(1_000)).resolves.toBe(true);
    // Simulate a takeover after this owner went stale.
    writeLockFile({
      lockId: "another-owner",
      pid: -1,
      hostname: "elsewhere",
      acquiredAt: Date.now(),
      renewedAt: Date.now(),
    });

    await first.release();
    expect(first.isOwner()).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(readLockFile().lockId).toBe("another-owner");
  });

  it("dispose releases the held lock", async () => {
    const lock = new SyncProcessLock(lockPath);
    await expect(lock.acquire(1_000)).resolves.toBe(true);
    lock.dispose();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(lock.isOwner()).toBe(false);
  });
});
