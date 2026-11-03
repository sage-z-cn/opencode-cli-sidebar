import * as fs from "node:fs";
import * as vscode from "vscode";
import {
  buildOpenCodeV2AuthHeader,
  resolveOpenCodeV2Service,
  v2ServiceStatePaths,
  type OpenCodeV2ServiceInfo,
} from "./OpenCodeCliCompat";
import type { ILogger } from "./ILogger";

/**
 * Readiness of the machine-wide OpenCode background service.
 *
 * Every VS Code window shares the same v2 daemon, so this state lives
 * outside `SessionRuntime`: the registration file written by the service is
 * the source of truth, and `/api/info` separates "still booting" (503) from
 * "ready" (200). Callers use it to avoid spawning competing services and to
 * hold back work that must not touch the config directory while OpenCode
 * boots.
 */
export type OpenCodeServiceState =
  | "unknown"
  | "down"
  | "starting"
  | "ready"
  | "failed";

/** A state where nothing more can be learned by waiting. */
export function isSettledState(state: OpenCodeServiceState): boolean {
  return state === "ready" || state === "failed";
}

export interface OpenCodeReadinessOptions {
  logger?: ILogger;
  /** Resolves the configured CLI command or binary name. */
  command?: () => string;
  /** Timeout for one `/api/info` request. */
  probeTimeoutMs?: number;
  /** How long a probe result stays valid. */
  cacheTtlMs?: number;
  now?: () => number;
}

export interface ProbeOptions {
  /** Allow the `opencode service status` fallback when no state file exists. */
  allowCliFallback?: boolean;
  /** Ignore the cached result. */
  force?: boolean;
}

export interface WaitForReadyOptions {
  /**
   * Grace period before the first conclusive check. Gives the launch flow a
   * chance to request a start before this call decides nothing is happening.
   */
  settleMs?: number;
  timeoutMs?: number;
  pollMs?: number;
  /**
   * Allow the `opencode service status` fallback on the first probe. Polling
   * callers pass `false` after the first round so a missing service file does
   * not spawn a CLI subprocess per tick.
   */
  allowCliFallback?: boolean;
  /**
   * Return as soon as the service is down and no start is in flight, instead
   * of waiting out `timeoutMs` for a start that will never come.
   */
  stopWhenIdle?: boolean;
  /** Whether a service start is currently in flight. */
  isStartInFlight?: () => boolean;
}

const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_CACHE_TTL_MS = 500;
const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
const DEFAULT_WAIT_POLL_MS = 500;

export class OpenCodeReadiness implements vscode.Disposable {
  private readonly logger?: ILogger;
  private readonly command: () => string;
  private readonly probeTimeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly emitter = new vscode.EventEmitter<OpenCodeServiceState>();

  private state: OpenCodeServiceState = "unknown";
  private probedAt = 0;
  private disposed = false;
  /**
   * Endpoint discovered by the last full probe. Fast probes reuse it so a
   * registration file that is momentarily unreadable does not stop the health
   * checks or make a booting service look gone.
   */
  private lastService: OpenCodeV2ServiceInfo | undefined;

  public readonly onDidChange = this.emitter.event;

  public constructor(options: OpenCodeReadinessOptions = {}) {
    this.logger = options.logger;
    this.command = options.command ?? (() => "opencode");
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /** Last observed state without touching the network. */
  public peek(): OpenCodeServiceState {
    return this.state;
  }

  /**
   * Probes the background service.
   *
   * The v2 CLI is only consulted when no registration file exists, so a
   * polling caller never spawns a subprocess per tick.
   */
  public async probe(options: ProbeOptions = {}): Promise<OpenCodeServiceState> {
    if (this.disposed) {
      return this.state;
    }
    const at = this.now();
    if (!options.force && at - this.probedAt < this.cacheTtlMs) {
      return this.state;
    }
    const next = await this.evaluate(options.allowCliFallback ?? true);
    this.probedAt = this.now();
    this.set(next);
    return next;
  }

  /**
   * Waits until the service reaches a settled state.
   *
   * Never throws: a rejected probe degrades to `"down"` so callers can fall
   * back to their pre-coordination behaviour.
   */
  public async waitUntilReady(
    options: WaitForReadyOptions = {},
  ): Promise<OpenCodeServiceState> {
    const settleMs = Math.max(0, options.settleMs ?? 0);
    const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
    const pollMs = Math.max(50, options.pollMs ?? DEFAULT_WAIT_POLL_MS);

    if (settleMs > 0) {
      await delay(settleMs);
    }

    const deadline = this.now() + timeoutMs;
    let allowCliFallback = options.allowCliFallback ?? true;
    for (;;) {
      const state = await this.probe({ allowCliFallback, force: true });
      allowCliFallback = false;
      if (isSettledState(state)) {
        return state;
      }
      if (
        state === "down" &&
        options.stopWhenIdle &&
        options.isStartInFlight !== undefined &&
        !options.isStartInFlight()
      ) {
        return state;
      }
      if (this.disposed || this.now() >= deadline) {
        return state;
      }
      await delay(pollMs);
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.emitter.dispose();
  }

  private set(next: OpenCodeServiceState): void {
    if (next === this.state) {
      return;
    }
    this.state = next;
    if (!this.disposed) {
      this.logger?.debug(`[OpenCodeReadiness] service state: ${next}`);
      this.emitter.fire(next);
    }
  }

  private async evaluate(
    allowCliFallback: boolean,
  ): Promise<OpenCodeServiceState> {
    let service: OpenCodeV2ServiceInfo | undefined;
    try {
      service = allowCliFallback
        ? await resolveOpenCodeV2Service(this.command())
        : this.readServiceFile();
    } catch (error) {
      this.logger?.debug(
        `[OpenCodeReadiness] service resolution failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return "down";
    }
    service ??= this.lastService;
    if (!service) {
      return "down";
    }
    this.lastService = service;

    const headers: Record<string, string> = { Accept: "application/json" };
    if (service.password) {
      headers.Authorization = buildOpenCodeV2AuthHeader(service.password);
    }

    let status: number;
    try {
      const response = await fetch(`${trimTrailingSlash(service.url)}/api/info`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(this.probeTimeoutMs),
      });
      status = response.status;
    } catch {
      // Connection refused, timeout, or abort: nothing is listening.
      return "down";
    }

    // 401/403 means a listener exists but our stored password is stale, and
    // 500 is the service reporting a failed boot. Both need a fresh start
    // rather than more waiting.
    if (status === 500 || status === 401 || status === 403) {
      return "failed";
    }
    if (status === 503) {
      return "starting";
    }
    if (status === 404) {
      // A server without the /api/info route still answers requests.
      return "ready";
    }
    return status >= 200 && status < 300 ? "ready" : "failed";
  }

  /**
   * Reads the registration file without consulting the CLI.
   *
   * Mirrors the file half of `resolveOpenCodeV2Service` for callers that poll
   * every few hundred milliseconds.
   */
  private readServiceFile(): OpenCodeV2ServiceInfo | undefined {
    for (const file of v2ServiceStatePaths()) {
      let raw: string;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object") {
        continue;
      }
      const record = parsed as {
        url?: unknown;
        password?: unknown;
        version?: unknown;
        pid?: unknown;
      };
      if (typeof record.url !== "string" || !record.url) {
        continue;
      }
      const port = parseUrlPort(record.url);
      if (port === undefined) {
        continue;
      }
      return {
        url: record.url,
        port,
        password:
          typeof record.password === "string" ? record.password : undefined,
        version:
          typeof record.version === "string" ? record.version : undefined,
        pid: typeof record.pid === "number" ? record.pid : undefined,
      };
    }
    return undefined;
  }
}

function parseUrlPort(url: string): number | undefined {
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
