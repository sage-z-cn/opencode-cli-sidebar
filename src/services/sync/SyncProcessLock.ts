import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Cross-process leadership lock for the WebDAV auto-sync channels.
 *
 * Multiple extension-host windows on one machine share the sync storage,
 * so the lock file lives next to the manifest under globalStorage. The
 * holder renews periodically; a file whose last renewal is older than
 * LOCK_STALE_MS may be taken over.
 */

/** A held lock whose heartbeat stopped this long ago may be taken over. */
export const LOCK_STALE_MS = 35_000;

/** Pause between acquire attempts while another fresh holder exists. */
const ACQUIRE_RETRY_MS = 250;

export interface SyncLockFileData {
  /** Random owner key; only the writer of this value owns the lock. */
  lockId: string;
  pid: number;
  hostname: string;
  acquiredAt: number;
  renewedAt: number;
}

function parseLockData(raw: string): SyncLockFileData | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SyncLockFileData>;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.lockId !== "string" ||
      typeof parsed.renewedAt !== "number"
    ) {
      return null;
    }
    return {
      lockId: parsed.lockId,
      pid: typeof parsed.pid === "number" ? parsed.pid : 0,
      hostname:
        typeof parsed.hostname === "string" ? parsed.hostname : "unknown",
      acquiredAt:
        typeof parsed.acquiredAt === "number"
          ? parsed.acquiredAt
          : parsed.renewedAt,
      renewedAt: parsed.renewedAt,
    };
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SyncProcessLock {
  private readonly lockFilePath: string;
  /** Owner key of the lock this instance holds, if any. */
  private lockId: string | undefined;

  public constructor(lockFilePath: string) {
    this.lockFilePath = lockFilePath;
  }

  public isOwner(): boolean {
    return this.lockId !== undefined;
  }

  /**
   * Try to become the lock holder until the timeout elapses. Uses
   * O_EXCL creation so exactly one process wins; a stale or unreadable
   * existing file is removed and retried immediately.
   */
  public async acquire(timeoutMs: number): Promise<boolean> {
    if (this.lockId !== undefined) {
      return true;
    }
    await fs.promises
      .mkdir(path.dirname(this.lockFilePath), { recursive: true })
      .catch(() => undefined);
    const deadline = Date.now() + Math.max(0, timeoutMs);
    const lockId = crypto.randomUUID();
    for (;;) {
      const payload: SyncLockFileData = {
        lockId,
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: Date.now(),
        renewedAt: Date.now(),
      };
      try {
        const handle = await fs.promises.open(this.lockFilePath, "wx");
        try {
          await handle.writeFile(JSON.stringify(payload), "utf8");
        } finally {
          await handle.close();
        }
        this.lockId = lockId;
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          // Unusable directory or transient I/O failure: retry like a
          // held lock; the deadline still bounds the attempt.
          if (Date.now() >= deadline) {
            return false;
          }
          await delay(ACQUIRE_RETRY_MS);
          continue;
        }
        const existing = await this.readLockFile();
        if (
          existing === null ||
          Date.now() - existing.renewedAt > LOCK_STALE_MS
        ) {
          // Stale or unreadable. A residual TOCTOU window remains — the
          // holder may renew between our read and the unlink — but it is
          // bounded by one heartbeat period (LOCK_STALE_MS) and the
          // upper sync protocol's ETag CAS backstops any split-brain
          // overlap; taking over here is the deliberate trade-off.
          // Re-read before removing: if a fresh lock replaced the stale
          // one in the meantime, it is not ours to unlink.
          const recheck = await this.readLockFile();
          if (
            recheck !== null &&
            Date.now() - recheck.renewedAt <= LOCK_STALE_MS
          ) {
            if (Date.now() >= deadline) {
              return false;
            }
            await delay(ACQUIRE_RETRY_MS);
            continue;
          }
          await fs.promises.unlink(this.lockFilePath).catch(() => undefined);
          continue;
        }
        if (Date.now() >= deadline) {
          return false;
        }
        await delay(ACQUIRE_RETRY_MS);
      }
    }
  }

  /**
   * Heartbeat: rewrite renewedAt in place. Only ever touches a file whose
   * lockId still matches this instance, so a takeover's fresh lock is
   * never clobbered. Any mismatch or failure clears ownership.
   *
   * The truncate-and-rewrite is deliberately in place (never
   * temp+rename): a rename would overwrite whatever file currently sits
   * at the path, silently destroying a takeover's new lock. The residual
   * race — a taker unlinks between our open and our write — is bounded
   * by one heartbeat period and backstopped by the sync protocol's ETag
   * CAS above this layer.
   */
  public async renew(): Promise<boolean> {
    const lockId = this.lockId;
    if (lockId === undefined) {
      return false;
    }
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(this.lockFilePath, "r+");
      const existing = parseLockData(await handle.readFile("utf8"));
      if (!existing || existing.lockId !== lockId) {
        // Another owner holds the file now: leave it untouched.
        await handle.close();
        this.lockId = undefined;
        return false;
      }
      const payload: SyncLockFileData = {
        ...existing,
        renewedAt: Date.now(),
      };
      await handle.truncate(0);
      await handle.write(JSON.stringify(payload), 0, "utf8");
      await handle.close();
      return true;
    } catch {
      await handle?.close().catch(() => undefined);
      this.lockId = undefined;
      return false;
    }
  }

  /**
   * Give up the lock: unlink only when the file still carries this
   * instance's lockId. Never removes another owner's lock.
   */
  public async release(): Promise<void> {
    const lockId = this.lockId;
    this.lockId = undefined;
    if (lockId === undefined) {
      return;
    }
    try {
      const existing = parseLockData(
        await fs.promises.readFile(this.lockFilePath, "utf8"),
      );
      if (existing?.lockId === lockId) {
        await fs.promises.unlink(this.lockFilePath);
      }
    } catch {
      // Missing or unreadable lock file: nothing to release.
    }
  }

  public dispose(): void {
    void this.release();
  }

  private async readLockFile(): Promise<SyncLockFileData | null> {
    try {
      return parseLockData(
        await fs.promises.readFile(this.lockFilePath, "utf8"),
      );
    } catch {
      return null;
    }
  }
}
