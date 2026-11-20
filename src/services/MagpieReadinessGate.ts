import * as vscode from "vscode";
import type { ILogger } from "./ILogger";

/**
 * Pre-launch wait for the local magpie service.
 *
 * OpenCode routes its model traffic through magpie, so launching the TUI while
 * that service is still down leaves the first request dead. This gate parks the
 * launch until the configured endpoint answers, then lets it continue.
 *
 * The wait is bounded and never throws: an unreachable magpie must delay the
 * launch, not prevent it. Any HTTP response (including 401/403) proves the
 * process is listening, which is the only fact this gate needs.
 */

/** How one wait ended; used for logs and tests, never for UX. */
export type MagpieWaitOutcome = "disabled" | "ready" | "timeout" | "cancelled";

export interface MagpieGateConfig {
  enabled: boolean;
  baseUrl: string;
  probePath: string;
  timeoutMs: number;
  pollIntervalMs: number;
}

/** Defaults match the magpie provider in the OpenCode config. */
export const MAGPIE_DEFAULTS = {
  baseUrl: "http://127.0.0.1:3425/v1",
  probePath: "/models",
  timeoutSeconds: 180,
  pollIntervalMs: 1000,
} as const;

/** One probe may not hang longer than this. */
export const MAGPIE_PROBE_TIMEOUT_MS = 2_000;

export interface MagpieReadinessGateDeps {
  logger: ILogger;
  /** Reads the current settings; injectable for tests. */
  readConfig?: () => MagpieGateConfig;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** True while the launch is parked, so the sidebar can show the reason. */
  onActiveChange?: (active: boolean) => void;
}

/**
 * Joins the configured base URL and probe path without letting an absolute
 * probe path discard the base path (`new URL("/models", ".../v1")` would).
 */
export function buildMagpieProbeUrl(
  baseUrl: string,
  probePath: string,
): string | undefined {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return undefined;
  }
  const base = trimmed.replace(/\/+$/, "");
  const path = probePath.trim().replace(/^\/+/, "");
  return path ? `${base}/${path}` : base;
}

/** Reads the `magpie.*` settings from the extension's configuration section. */
export function readMagpieGateConfig(): MagpieGateConfig {
  const config = vscode.workspace.getConfiguration("opencode-cli-sidebar");
  const timeoutSeconds = config.get<number>(
    "magpie.waitTimeoutSeconds",
    MAGPIE_DEFAULTS.timeoutSeconds,
  );
  const pollIntervalMs = config.get<number>(
    "magpie.pollIntervalMs",
    MAGPIE_DEFAULTS.pollIntervalMs,
  );
  return {
    enabled: config.get<boolean>("magpie.waitForStartup", false),
    baseUrl: config.get<string>("magpie.baseUrl", MAGPIE_DEFAULTS.baseUrl),
    probePath: config.get<string>("magpie.probePath", MAGPIE_DEFAULTS.probePath),
    timeoutMs: Math.max(5, timeoutSeconds) * 1000,
    pollIntervalMs: Math.max(200, pollIntervalMs),
  };
}

export class MagpieReadinessGate implements vscode.Disposable {
  private readonly readConfig: () => MagpieGateConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  private inFlight?: Promise<MagpieWaitOutcome>;
  private cancelled = false;
  private disposed = false;
  private sleepTimer?: ReturnType<typeof setTimeout>;
  private wakeSleep?: () => void;
  private activeProbe?: AbortController;

  public constructor(private readonly deps: MagpieReadinessGateDeps) {
    this.readConfig = deps.readConfig ?? readMagpieGateConfig;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  /** True while a launch is parked on this gate. */
  public isWaiting(): boolean {
    return this.inFlight !== undefined;
  }

  /**
   * Abort a running wait from the sidebar overlay or the skip command.
   * Returns false when nothing was waiting.
   */
  public cancel(): boolean {
    if (!this.inFlight) {
      return false;
    }
    this.cancelled = true;
    this.activeProbe?.abort();
    this.wake();
    this.deps.logger.info("[MagpieGate] wait skipped");
    return true;
  }

  public dispose(): void {
    this.disposed = true;
    if (this.inFlight) {
      this.cancelled = true;
      this.activeProbe?.abort();
      this.wake();
    }
  }

  /**
   * Park the launch until magpie answers or the budget elapses. Never throws;
   * the caller's only job is to await it before spawning OpenCode.
   */
  public waitForReady(): Promise<MagpieWaitOutcome> {
    if (this.inFlight) {
      return this.inFlight;
    }
    const run = this.runWait()
      .catch((error) => {
        // The gate contract is "never throws": a broken config read or an
        // unexpected probe failure must still let the launch continue.
        this.deps.logger.warn(
          `[MagpieGate] wait failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return "disabled" as MagpieWaitOutcome;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    this.inFlight = run;
    return run;
  }

  private async runWait(): Promise<MagpieWaitOutcome> {
    const config = this.readConfig();
    if (!config.enabled) {
      return "disabled";
    }
    const url = buildMagpieProbeUrl(config.baseUrl, config.probePath);
    if (!url) {
      // A broken address must not stall the launch; the user still sees the
      // error in the log next to the setting they just edited.
      this.deps.logger.warn(
        `[MagpieGate] ignoring wait: invalid address "${config.baseUrl}"`,
      );
      return "disabled";
    }

    this.cancelled = false;
    const startedAt = this.now();
    this.deps.onActiveChange?.(true);
    this.deps.logger.info(
      `[MagpieGate] waiting for ${url} (up to ${config.timeoutMs}ms)`,
    );

    try {
      for (;;) {
        if (this.disposed || this.cancelled) {
          return "cancelled";
        }
        if (await this.probe(url)) {
          this.deps.logger.info(
            `[MagpieGate] ready after ${this.now() - startedAt}ms`,
          );
          return "ready";
        }
        const remaining = config.timeoutMs - (this.now() - startedAt);
        if (remaining <= 0) {
          this.deps.logger.warn(
            `[MagpieGate] not ready after ${config.timeoutMs}ms; launching anyway`,
          );
          return "timeout";
        }
        await this.sleep(Math.min(config.pollIntervalMs, remaining));
      }
    } finally {
      this.deps.onActiveChange?.(false);
    }
  }

  /** One probe. Any HTTP response means the service is up. */
  private async probe(url: string): Promise<boolean> {
    const controller = new AbortController();
    this.activeProbe = controller;
    const timer = setTimeout(() => controller.abort(), MAGPIE_PROBE_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        signal: controller.signal,
      });
      this.deps.logger.debug(
        `[MagpieGate] probe answered HTTP ${response.status}`,
      );
      await response.body?.cancel().catch(() => undefined);
      return true;
    } catch (error) {
      this.deps.logger.debug(
        `[MagpieGate] probe failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    } finally {
      clearTimeout(timer);
      if (this.activeProbe === controller) {
        this.activeProbe = undefined;
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.sleepTimer = undefined;
        this.wakeSleep = undefined;
        resolve();
      }, ms);
      timer.unref?.();
      this.sleepTimer = timer;
      this.wakeSleep = resolve;
    });
  }

  /** Clears a pending sleep and resolves it immediately. */
  private wake(): void {
    if (this.sleepTimer) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = undefined;
    }
    const resolve = this.wakeSleep;
    this.wakeSleep = undefined;
    resolve?.();
  }
}
