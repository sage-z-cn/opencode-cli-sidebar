import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PreStartSyncProgress } from "../../types";
import type { ILogger } from "../ILogger";
import {
  readSyncConfig,
  type ConfigSyncService,
  type SyncPassResult,
} from "./ConfigSyncService";
import { syncStorageDir } from "./SyncManifest";
import {
  PRE_START_SYNC_PATHS,
  SERVICE_OWNED_PRE_START_PATHS,
} from "./syncItems";

/**
 * Pre-launch config sync gate.
 *
 * OpenCode reads its global config directory while it boots, so a launch that
 * races a config sync reads a half-updated state. This gate pulls the key
 * config files before the terminal is spawned, then lets the launch continue
 * no matter how the pass ended: a failed or skipped sync must never block
 * OpenCode from starting.
 *
 * Cross-window and short-interval dedupe is two-part:
 * - The pass lock lives inside `ConfigSyncService`, so only one pass runs per
 *   machine; a second window observes `busy` and waits for the completion
 *   stamp instead of racing the manifest.
 * - A completion stamp records when the key files were last brought up to
 *   date, so reopening the extension inside the cooldown window skips the
 *   pass entirely.
 *
 * The time budget is enforced from the outside: a pass that outlives it is
 * aborted and the launch proceeds. `ConfigSyncService` can sit inside a rate
 * limit wait for minutes, so an internal deadline would not be reliable.
 */

/** Hard cap on how long a launch may wait for the pre-start pass. */
export const PRE_START_BUDGET_MS = 10_000;

/** Backoff after a failed pass, so every launch does not retry a dead server. */
export const PRE_START_NEGATIVE_CACHE_MS = 120_000;

/** Where the stamp lives, next to the manifest and the shared status file. */
const STAMP_FILE_NAME = "prestart.json";

/** How the pre-start gate finished; used for logs and tests, never for UX. */
export type PreStartSyncOutcome =
  | "synced"
  | "cooldown"
  | "skipped"
  | "failed"
  | "disabled"
  /** Another window held the pass; its stamp satisfied this launch. */
  | "busy-waited"
  /** The budget elapsed; the launch continues without the sync. */
  | "timeout";

/** Persisted completion record for one machine-wide pre-start pass. */
export interface PreStartSyncStamp {
  /** Epoch ms the pass settled. */
  completedAt: number;
  /** Unique per write; two windows can settle in the same millisecond. */
  writeId: string;
  result: "ok" | "aborted" | "failed";
  /** Server identity the pass ran against; a changed server invalidates it. */
  connectionKey: string;
  /** Files the pass covered, for diagnostics. */
  paths: string[];
  /** Earliest time a new attempt may start; failed passes back off. */
  nextAttemptAt?: number;
}

/** Narrow service surface the gate depends on (mockable in tests). */
export interface PreStartSyncRunner {
  runScopedPass(options: {
    scopePaths: readonly string[];
    signal: AbortSignal;
    onProgress?: (progress: PreStartSyncProgress) => void;
  }): Promise<SyncPassResult>;
  /**
   * True when automatic passes are currently gated off: the breaker paused
   * after repeated errors, or the stored credentials were rejected. A launch
   * must not wait on a pass that cannot succeed.
   */
  isAutoPassBlocked(): boolean;
  /**
   * Full reconcile of everything outside the launch scope. Runs after the
   * launch pass so `AGENTS.md` and `skills/` still get synced on startup
   * without making the launch wait for them. Fire-and-forget by contract.
   */
  reconcileAfterLaunch?(): void;
}

export interface PreStartSyncGateDeps {
  /**
   * Resolved lazily: `TerminalProvider` is constructed before
   * `ConfigSyncService`, so the gate cannot capture the instance up front.
   */
  resolveRunner: () => PreStartSyncRunner | undefined;
  logger: ILogger;
  /** Global storage path; the stamp lives under its `sync/` directory. */
  globalStoragePath: string;
  /** Renders progress in the sidebar overlay and the status bar. */
  onProgress?: (progress: PreStartSyncProgress | undefined) => void;
  /** True while the gate owns the startup indicator. */
  onActiveChange?: (active: boolean) => void;
  /**
   * Settled verdict, so the UI can show the user whether the launch synced,
   * skipped, timed out or failed instead of only writing a log line.
   */
  onResult?: (outcome: PreStartSyncOutcome) => void;
  now?: () => number;
  budgetMs?: number;
  negativeCacheMs?: number;
}

/** Inputs that decide whether this launch runs the pass at all. */
export interface PreStartSyncRequest {
  /**
   * True when the shared v2 service already answers, so this window only
   * attaches to it. Files the service hot-reloads are then left alone.
   */
  v2ServiceReady: boolean;
}

/**
 * Files OpenCode must have on disk before a process starts reading them.
 * Derived from the item definitions; `cli.json` is the one file the
 * background service does not own.
 */
export function preStartScopeFor(request: PreStartSyncRequest): string[] {
  if (!request.v2ServiceReady) {
    return [...PRE_START_SYNC_PATHS];
  }
  // The ready service watches and hot reloads its own files; only the file
  // this window's TUI is about to read still needs to be current.
  const serviceOwned = new Set<string>(SERVICE_OWNED_PRE_START_PATHS);
  return PRE_START_SYNC_PATHS.filter((path) => !serviceOwned.has(path));
}

/** Identity of the server a stamp belongs to; a change invalidates it. */
export function preStartConnectionKey(
  url: string,
  basePath: string,
  username: string,
): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([url.trim(), basePath, username]), "utf8")
    .digest("hex")
    .slice(0, 16);
}

/** Shape-check a parsed stamp; anything malformed reads back as absent. */
export function parsePreStartStamp(raw: string): PreStartSyncStamp | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  const value = parsed as Record<string, unknown>;
  if (
    typeof value.completedAt !== "number" ||
    typeof value.writeId !== "string" ||
    value.writeId.length === 0 ||
    (value.result !== "ok" &&
      value.result !== "aborted" &&
      value.result !== "failed") ||
    typeof value.connectionKey !== "string" ||
    !Array.isArray(value.paths)
  ) {
    return undefined;
  }
  return {
    completedAt: value.completedAt,
    writeId: value.writeId,
    result: value.result,
    connectionKey: value.connectionKey,
    paths: value.paths.filter(
      (entry): entry is string => typeof entry === "string",
    ),
    nextAttemptAt:
      typeof value.nextAttemptAt === "number" ? value.nextAttemptAt : undefined,
  };
}

/**
 * True when a stamp still speaks for this launch: a successful pass for the
 * same server inside the cooldown window, or a recent failure still inside
 * its backoff.
 */
export function isStampFresh(
  stamp: PreStartSyncStamp,
  connectionKey: string,
  now: number,
  cooldownMs: number,
): boolean {
  if (stamp.connectionKey !== connectionKey) {
    return false;
  }
  // A timestamp in the future means the clock moved backwards; the record
  // cannot be trusted, so the launch syncs again instead of skipping forever.
  if (stamp.completedAt > now + 60_000) {
    return false;
  }
  if (stamp.result === "ok") {
    return now - stamp.completedAt < cooldownMs;
  }
  return stamp.nextAttemptAt !== undefined && now < stamp.nextAttemptAt;
}

export class PreStartSyncGate {
  private readonly deps: PreStartSyncGateDeps;
  private readonly stampFilePath: string;
  private readonly now: () => number;
  private readonly budgetMs: number;
  private readonly negativeCacheMs: number;

  /** Aborts the in-flight pass; set by `skip()` or by the budget. */
  private abortController: AbortController | undefined;
  private stampWrite: Promise<void> = Promise.resolve();
  private disposed = false;

  public constructor(deps: PreStartSyncGateDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.budgetMs = deps.budgetMs ?? PRE_START_BUDGET_MS;
    this.negativeCacheMs =
      deps.negativeCacheMs ?? PRE_START_NEGATIVE_CACHE_MS;
    this.stampFilePath = path.join(
      syncStorageDir(deps.globalStoragePath),
      STAMP_FILE_NAME,
    );
  }

  public dispose(): void {
    this.disposed = true;
    this.abortController?.abort();
    this.abortController = undefined;
  }

  /** Abort the running pass; the launch continues as soon as it settles. */
  public skip(): boolean {
    const controller = this.abortController;
    if (!controller) {
      return false;
    }
    controller.abort();
    this.deps.logger.info("[PreStartSync] skipped by user");
    return true;
  }

  /** True while this gate owns the startup indicator. */
  public isRunning(): boolean {
    return this.abortController !== undefined;
  }

  /**
   * Run the pre-launch pass and settle. Never throws and never rejects: the
   * caller's only job is to await it before spawning OpenCode.
   */
  public async beforeOpenCodeStart(
    request: PreStartSyncRequest,
  ): Promise<PreStartSyncOutcome> {
    const config = readSyncConfig();
    if (
      !config.enabled ||
      !config.url ||
      !config.preStartSync ||
      !config.autoSyncEnabled
    ) {
      return "disabled";
    }
    const runner = this.deps.resolveRunner();
    if (!runner || runner.isAutoPassBlocked()) {
      return "disabled";
    }
    const connectionKey = preStartConnectionKey(
      config.url,
      config.basePath,
      config.username,
    );
    const scope = preStartScopeFor(request);
    const requestAt = this.now();
    const cooldownMs = Math.max(0, config.preStartSyncCooldownMinutes) * 60_000;

    await this.stampWrite;
    const existing = await this.readStamp();
    if (existing && isStampFresh(existing, connectionKey, requestAt, cooldownMs)) {
      this.deps.logger.debug(
        `[PreStartSync] skipped; stamp is still fresh (${existing.result})`,
      );
      return "cooldown";
    }

    const controller = new AbortController();
    this.abortController = controller;
    this.deps.onActiveChange?.(true);
    // No count yet: the remote walk has no predictable total, and the files
    // to transfer are only known after the scan. A placeholder like `0/N`
    // reads as "stuck at zero" instead of progress.
    this.deps.onProgress?.({ phase: "scan", current: 0, total: 0 });

    let outcome: PreStartSyncOutcome;
    try {
      const result = await this.raceBudget(runner, scope, controller);
      if (result === "busy") {
        // Another window owns the pass lock; its stamp is the only signal
        // that the files are current. Wait for it inside the same budget.
        outcome = await this.waitForSiblingStamp(
          connectionKey,
          requestAt,
          cooldownMs,
        );
      } else {
        // Trust the abort flag over the runner's verdict: a pass that was
        // cancelled must never record a successful stamp, or the cooldown
        // would suppress the next launch's retry. A budget abort is reported
        // as `timeout` so the caller can tell the two apart.
        const settledResult =
          result === "timeout"
            ? "timeout"
            : controller.signal.aborted
              ? "aborted"
              : result;
        outcome = await this.settle(
          settledResult,
          connectionKey,
          scope,
          runner,
        );
      }
    } catch (error) {
      this.deps.logger.warn(
        `[PreStartSync] pass failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      outcome = await this.settle("failed", connectionKey, scope, runner);
    } finally {
      this.abortController = undefined;
      this.deps.onProgress?.(undefined);
      this.deps.onActiveChange?.(false);
    }
    // Emitted after the teardown above so the overlay hand-off cannot wipe
    // the verdict, and before returning so the launch starts immediately
    // instead of waiting for the message to be displayed.
    if (outcome !== "disabled") {
      this.deps.onResult?.(outcome);
    }
    return outcome;
  }

  /**
   * Bound the pass from the outside. `ConfigSyncService` can sit in a rate
   * limit wait far longer than any launch should, so the deadline aborts it
   * rather than trusting it to return.
   */
  private async raceBudget(
    runner: PreStartSyncRunner,
    scope: readonly string[],
    controller: AbortController,
  ): Promise<SyncPassResult | "timeout"> {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve("timeout");
      }, this.budgetMs);
      timer.unref?.();
    });
    const pass = runner.runScopedPass({
      scopePaths: scope,
      signal: controller.signal,
      onProgress: (progress) => {
        if (!timedOut) {
          this.deps.onProgress?.(progress);
        }
      },
    });
    try {
      return await Promise.race([pass, budget]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      // The pass may still be unwinding after a timeout; its result no
      // longer matters, but an unhandled rejection would be logged as ours.
      void pass.catch(() => undefined);
    }
  }

  /**
   * A sibling window holds the pass. Poll its stamp instead of retrying the
   * lock: the stamp is written once and is the only fact that matters.
   */
  private async waitForSiblingStamp(
    connectionKey: string,
    requestAt: number,
    cooldownMs: number,
  ): Promise<PreStartSyncOutcome> {
    const deadline = this.now() + this.budgetMs;
    for (;;) {
      await delay(200);
      const stamp = await this.readStamp();
      if (stamp && stamp.completedAt >= requestAt) {
        if (isStampFresh(stamp, connectionKey, this.now(), cooldownMs)) {
          return "busy-waited";
        }
        // A failed or aborted sibling pass settles the wait; retrying here
        // would double the launch delay for no gain.
        return "busy-waited";
      }
      if (this.disposed) {
        return "busy-waited";
      }
      if (this.now() >= deadline) {
        this.deps.logger.warn(
          "[PreStartSync] sibling pass did not settle within the budget",
        );
        return "timeout";
      }
    }
  }

  /** Record the outcome and return the launch verdict. */
  private async settle(
    result: SyncPassResult | "timeout",
    connectionKey: string,
    scope: readonly string[],
    runner: PreStartSyncRunner,
  ): Promise<PreStartSyncOutcome> {
    const outcome: PreStartSyncOutcome =
      result === "done"
        ? "synced"
        : result === "aborted"
          ? "skipped"
          : result === "timeout"
            ? "timeout"
            : "failed";
    // A timeout still aborted the pass, so the stamp must say so: leaving no
    // stamp would make every sibling window wait out its own full budget.
    const stampResult: PreStartSyncStamp["result"] =
      outcome === "synced"
        ? "ok"
        : outcome === "skipped" || outcome === "timeout"
          ? "aborted"
          : "failed";
    const completedAt = this.now();
    await this.writeStamp({
      completedAt,
      writeId: crypto.randomUUID(),
      result: stampResult,
      connectionKey,
      paths: [...scope],
      // Only a failed pass backs off; a skipped one may retry on next launch.
      nextAttemptAt:
        stampResult === "failed" ? completedAt + this.negativeCacheMs : undefined,
    });
    this.deps.logger.info(`[PreStartSync] settled: ${outcome}`);
    // Hand the rest of the scope to a background pass. The launch only
    // needed the boot-read files; AGENTS.md and skills/ would otherwise
    // wait for the poller, and `autoSyncOnStartup` no longer covers them.
    if (outcome === "synced") {
      runner.reconcileAfterLaunch?.();
    }
    // `disabled` never showed the overlay, so it has no result to report.
    return outcome;
  }

  private async readStamp(): Promise<PreStartSyncStamp | undefined> {
    try {
      const raw = await fs.promises.readFile(this.stampFilePath, "utf8");
      return parsePreStartStamp(raw);
    } catch {
      return undefined;
    }
  }

  /** Write-then-rename so a crash mid-write leaves the previous stamp. */
  private writeStamp(stamp: PreStartSyncStamp): Promise<void> {
    this.stampWrite = this.stampWrite.then(async () => {
      const dir = path.dirname(this.stampFilePath);
      const tempPath = `${this.stampFilePath}.${process.pid}.${crypto
        .randomBytes(4)
        .toString("hex")}.tmp`;
      try {
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.writeFile(tempPath, JSON.stringify(stamp), "utf8");
        await fs.promises.rename(tempPath, this.stampFilePath);
      } catch (error) {
        await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
        this.deps.logger.warn(
          `[PreStartSync] could not persist the completion stamp: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    });
    return this.stampWrite;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Narrow cast helper: keeps the gate free of the full service type. */
export function asPreStartSyncRunner(
  service: ConfigSyncService,
): PreStartSyncRunner {
  return service as unknown as PreStartSyncRunner;
}
