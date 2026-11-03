import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ILogger } from "./ILogger";
import { commandBypassesSharedService } from "./OpenCodeCliCompat";
import type { OpenCodeReadiness } from "./OpenCodeReadiness";

/**
 * Serializes the first start of the shared OpenCode background service
 * across VS Code windows.
 *
 * Every window restores at startup and each one would otherwise spawn its own
 * `opencode serve --service` contender for the same fixed port. Exactly one
 * window wins an on-disk lease and lets its own TUI start the service; the
 * others wait for that service to answer instead of racing a contender. The
 * lease is a file with a heartbeat, so a crashed owner is taken over instead
 * of blocking everyone.
 */
export type StartupGateOutcome = "ready" | "owner" | "timeout" | "skipped";

/** The narrow surface `SessionRuntime` needs. */
export interface StartupGate {
  beforeStart(): Promise<StartupGateOutcome>;
}

/**
 * Observable steps of one gate pass, so a window can show the user why the
 * session has not started yet.
 */
export type StartupGatePhase = "starting" | "ready" | "timeout" | "skipped";

export interface StartupLeaseData {
  lockId: string;
  pid: number;
  hostname: string;
  acquiredAt: number;
  renewedAt: number;
}

export interface StartupCoordinatorOptions {
  /** Directory owned by the extension's global storage. */
  storageDir: string;
  readiness: OpenCodeReadiness;
  logger: ILogger;
  /** Full launch command, used to detect `--standalone` / `--server`. */
  launchCommand?: () => string | undefined;
  /** Reads the `startup.coordinate` setting. */
  isEnabled?: () => boolean;
  /** Reports gate progress for user-visible feedback. */
  onPhase?: (phase: StartupGatePhase) => void;
  /** A held lease whose heartbeat stopped this long ago may be taken over. */
  leaseMs?: number;
  heartbeatMs?: number;
  acquireRetryMs?: number;
  /** Time spent trying to become the owner before falling back to waiting. */
  acquireTimeoutMs?: number;
  /** How long a window waits for the service before starting anyway. */
  readyTimeoutMs?: number;
  pollMs?: number;
  now?: () => number;
}

const DEFAULT_LEASE_MS = 20_000;
const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_ACQUIRE_RETRY_MS = 250;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 0;
const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_MS = 1_000;
const OWNER_POLL_MS = 250;
const LEASE_FILE_NAME = "warmup.lock";

type LeaseState = { lease?: StartupLeaseData; fresh: boolean };

export class StartupCoordinator implements StartupGate, vscode.Disposable {
  private readonly storageDir: string;
  private readonly readiness: OpenCodeReadiness;
  private readonly logger: ILogger;
  private readonly launchCommand?: () => string | undefined;
  private readonly isEnabled?: () => boolean;
  private readonly onPhase?: (phase: StartupGatePhase) => void;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly acquireRetryMs: number;
  private readonly acquireTimeoutMs: number;
  private readonly readyTimeoutMs: number;
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly leaseFile: string;

  private lockId: string | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  public constructor(options: StartupCoordinatorOptions) {
    this.storageDir = options.storageDir;
    this.readiness = options.readiness;
    this.logger = options.logger;
    this.launchCommand = options.launchCommand;
    this.isEnabled = options.isEnabled;
    this.onPhase = options.onPhase;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.acquireRetryMs = options.acquireRetryMs ?? DEFAULT_ACQUIRE_RETRY_MS;
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.now = options.now ?? Date.now;
    this.leaseFile = path.join(this.storageDir, LEASE_FILE_NAME);
  }

  /**
   * Gates one session start.
   *
   * `"ready"` means a service already answers, `"owner"` means this window
   * may start and is now responsible for bringing the service up, and
   * `"timeout"` / `"skipped"` mean the caller should start without the gate.
   */
  public async beforeStart(): Promise<StartupGateOutcome> {
    if (this.disposed) {
      return "skipped";
    }
    if (this.isEnabled && !this.isEnabled()) {
      this.logger.debug("[Startup] coordination disabled; starting directly");
      this.phase("skipped");
      return "skipped";
    }
    const launchCommand = this.launchCommand?.();
    if (launchCommand && commandBypassesSharedService(launchCommand)) {
      this.logger.debug(
        "[Startup] launch command bypasses the shared service; skipping coordination",
      );
      this.phase("skipped");
      return "skipped";
    }

    const initial = await this.readiness.probe({
      allowCliFallback: true,
      force: true,
    });
    if (initial === "ready") {
      this.phase("ready");
      return "ready";
    }

    if (await this.acquire()) {
      this.claimOwnership();
      return "owner";
    }
    return this.waitAsFollower();
  }

  /**
   * True while a window is bringing the service up.
   *
   * Other work that must not touch the config directory, such as the startup
   * WebDAV pass, uses this to decide whether waiting is worth it.
   */
  public isWarmupInFlight(): boolean {
    if (this.lockId !== undefined) {
      return true;
    }
    return this.readLeaseState().fresh;
  }

  public dispose(): void {
    this.disposed = true;
    void this.release();
  }

  /**
   * The caller starts the service through its own TUI, so this window only
   * holds the lease until the service answers. No extra `service start`
   * process is spawned and the TUI launch is never delayed.
   */
  private claimOwnership(): void {
    this.phase("starting");
    this.logger.info(
      "[Startup] this window starts the background service; holding the startup lease",
    );
    void this.trackServiceReady();
  }

  private async trackServiceReady(): Promise<void> {
    try {
      const state = await this.readiness.waitUntilReady({
        timeoutMs: this.readyTimeoutMs,
        pollMs: OWNER_POLL_MS,
        allowCliFallback: true,
      });
      if (state === "ready") {
        this.logger.info(
          "[Startup] background service ready; releasing the startup lease",
        );
      } else {
        this.logger.warn(
          `[Startup] background service did not become ready within ${this.readyTimeoutMs}ms (state=${state})`,
        );
      }
      this.phase(state === "ready" ? "ready" : "timeout");
    } finally {
      await this.release();
    }
  }

  private async waitAsFollower(): Promise<StartupGateOutcome> {
    this.logger.info(
      "[Startup] another window is starting the background service; waiting",
    );
    this.phase("starting");
    const deadline = this.now() + this.readyTimeoutMs;
    let allowCliFallback = true;
    for (;;) {
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        this.logger.warn(
          `[Startup] background service still unavailable after ${this.readyTimeoutMs}ms; starting anyway`,
        );
        this.phase("timeout");
        return "timeout";
      }
      const state = await this.readiness.waitUntilReady({
        timeoutMs: Math.min(remaining, this.pollMs * 3),
        pollMs: this.pollMs,
        allowCliFallback,
      });
      allowCliFallback = false;
      if (state === "ready") {
        this.phase("ready");
        return "ready";
      }
      if (state === "failed") {
        this.logger.warn(
          "[Startup] background service reported a failed start; falling back to a direct start",
        );
        this.phase("timeout");
        return "timeout";
      }
      if (this.disposed) {
        this.phase("skipped");
        return "skipped";
      }
      // The owner may have crashed mid-start. Taking the lease over is
      // cheaper than waiting out the remaining deadline.
      if (await this.acquire()) {
        this.claimOwnership();
        return "owner";
      }
    }
  }

  private async acquire(): Promise<boolean> {
    if (this.lockId !== undefined) {
      return true;
    }
    await fs.promises
      .mkdir(path.dirname(this.leaseFile), { recursive: true })
      .catch(() => undefined);

    const lockId = crypto.randomUUID();
    const deadline = this.now() + this.acquireTimeoutMs;
    for (;;) {
      const at = this.now();
      const payload: StartupLeaseData = {
        lockId,
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: at,
        renewedAt: at,
      };
      try {
        await fs.promises.writeFile(this.leaseFile, JSON.stringify(payload), {
          flag: "wx",
          mode: 0o600,
        });
        this.lockId = lockId;
        this.startHeartbeat();
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          this.logger.warn(
            `[Startup] could not take the startup lease: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return false;
        }
      }

      if (!this.readLeaseState().fresh) {
        // A dead owner or a half-written file: drop it and retry. The delete
        // can fail on Windows while another handle is open, which is why the
        // deadline below is checked on every iteration.
        await fs.promises.rm(this.leaseFile, { force: true }).catch(() => undefined);
      }
      if (this.now() >= deadline) {
        return false;
      }
      await delay(this.acquireRetryMs);
    }
  }

  private async release(): Promise<void> {
    this.stopHeartbeat();
    const owned = this.lockId;
    this.lockId = undefined;
    if (owned === undefined) {
      return;
    }
    const lease = this.readLeaseState().lease;
    if (lease !== undefined && lease.lockId !== owned) {
      return;
    }
    await fs.promises.rm(this.leaseFile, { force: true }).catch(() => undefined);
  }

  /**
   * Reads the lease without treating a half-written file as dead.
   *
   * `writeFile` with `wx` creates the file before writing its content, so a
   * competing window can observe an empty lease for a moment. A recent file
   * that cannot be parsed is therefore reported as still held rather than as
   * a stale lock someone may delete.
   */
  private readLeaseState(): LeaseState {
    let raw: string;
    let modifiedAt: number;
    try {
      modifiedAt = fs.statSync(this.leaseFile).mtimeMs;
      raw = fs.readFileSync(this.leaseFile, "utf8");
    } catch {
      return { fresh: false };
    }
    const lease = parseLease(raw);
    if (lease === undefined) {
      return { fresh: this.now() - modifiedAt <= this.leaseMs };
    }
    return { lease, fresh: this.now() - lease.renewedAt <= this.leaseMs };
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.renewLease();
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private async renewLease(): Promise<void> {
    const owned = this.lockId;
    if (owned === undefined) {
      return;
    }
    const lease = this.readLeaseState().lease;
    if (lease === undefined || lease.lockId !== owned) {
      // Another window took over; stop pretending we own the start-up.
      this.logger.warn("[Startup] startup lease was taken over by another window");
      this.stopHeartbeat();
      this.lockId = undefined;
      return;
    }
    const payload: StartupLeaseData = { ...lease, renewedAt: this.now() };
    await fs.promises
      .writeFile(this.leaseFile, JSON.stringify(payload), { mode: 0o600 })
      .catch(() => undefined);
  }

  private phase(phase: StartupGatePhase): void {
    this.onPhase?.(phase);
  }
}

function parseLease(raw: string): StartupLeaseData | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<StartupLeaseData>;
    if (typeof parsed.lockId !== "string" || typeof parsed.renewedAt !== "number") {
      return undefined;
    }
    return {
      lockId: parsed.lockId,
      pid: typeof parsed.pid === "number" ? parsed.pid : 0,
      hostname: typeof parsed.hostname === "string" ? parsed.hostname : "unknown",
      acquiredAt:
        typeof parsed.acquiredAt === "number" ? parsed.acquiredAt : parsed.renewedAt,
      renewedAt: parsed.renewedAt,
    };
  } catch {
    return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
