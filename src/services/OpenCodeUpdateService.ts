import * as vscode from "vscode";
import * as path from "node:path";
import {
  extractCliBinary,
  getOpenCodeVersion,
  parseOpenCodeMajorVersion,
  peekOpenCodeVersion,
  peekOpenCodeVersionProbe,
  resetOpenCodeCliVersionCaches,
  runOpenCodeCliCommand,
  streamOpenCodeCliCommand,
  type OpenCodeCliStreamOptions,
} from "./OpenCodeCliCompat";
import {
  detectInstallMethod,
  detectNvmWindows,
  getDefaultMethod as pickDefaultMethod,
  parseUpgradeMethodChoices,
  type RunFn,
} from "./OpenCodeInstallMethod";
import { OutputChannelService } from "./OutputChannelService";
import { isVersionNewer } from "./semver";

/**
 * Orchestrates OpenCode self-update checks and upgrades: version
 * comparison, install-method resolution, upgrade execution with nvm
 * remediation, and verification. Timers/auto-check scheduling and webview
 * wiring arrive in later phases.
 */

const LAST_METHOD_KEY = "opencodeUpdate.lastMethod";
const LAST_CHECK_AT_KEY = "opencodeUpdate.lastCheckAt";
/**
 * Latest-version endpoints raced concurrently: the official npm registry
 * plus China npm mirrors for when the official registry is unreachable.
 * All serve the same JSON `version` payload shape for the v2 CLI package
 * `@opencode/cli` (the update feature is v2-only). The first endpoint to
 * return a valid version wins; mirrors may lag the official registry by
 * a few minutes, which is acceptable for a periodic update check.
 */
const LATEST_VERSION_ENDPOINTS = [
  "https://registry.npmjs.org/@opencode/cli/latest",
  "https://registry.npmmirror.com/@opencode/cli/latest",
  "https://mirrors.tencent.com/npm/@opencode/cli/latest",
] as const;
/** Per-endpoint fetch timeout so a hanging mirror cannot stall the check. */
const LATEST_FETCH_TIMEOUT_MS = 10_000;
/** How long a successful check's latest version stays reusable as target. */
const TARGET_CACHE_MS = 5 * 60 * 1000;
/** Upper bound for one upgrade command (large npm installs are slow). */
const UPGRADE_TIMEOUT_MS = 10 * 60 * 1000;
/** nvm reshim / trust commands are quick compared to the upgrade itself. */
const NVM_STEP_TIMEOUT_MS = 60 * 1000;
/** Methods whose binaries live in an nvm-managed node install. */
const NVM_FAMILY_METHODS = ["npm", "pnpm", "bun", "yarn"];
/** nvm-windows firewall markers (NVM4306) in blocked upgrade output. */
const NVM_BLOCKED_PATTERN = /NVM blocked package-manager execution|could not be trusted/;
/**
 * CLI availability probe timeout: cold starts (antivirus scans, network
 * drives) can exceed the generic 4 s command budget.
 */
const PROBE_CLI_TIMEOUT_MS = 10_000;
/** Bare binary name used as the last-chance probe fallback. */
const BARE_BINARY_NAME = "opencode";

/** One executable install command for a fixed install method. */
interface CliInstallCommand {
  file: string;
  args: string[];
}

/**
 * Fixed install-method commands for the missing-CLI install flow. No local
 * package-manager probing: choosing an unavailable entry simply fails at
 * execution and surfaces the official script as the manual fallback.
 */
const CLI_INSTALL_COMMANDS: ReadonlyMap<string, CliInstallCommand> = new Map([
  ["npm", { file: "npm", args: ["install", "-g", "@opencode/cli"] }],
  ["pnpm", { file: "pnpm", args: ["add", "-g", "@opencode/cli"] }],
  ["yarn", { file: "yarn", args: ["global", "add", "@opencode/cli"] }],
  ["bun", { file: "bun", args: ["install", "-g", "@opencode/cli"] }],
  ["brew", { file: "brew", args: ["install", "opencode"] }],
  ["scoop", { file: "scoop", args: ["install", "opencode"] }],
  ["choco", { file: "choco", args: ["install", "opencode"] }],
]);

/**
 * Fixed method list offered by the install popover: the mapped package
 * managers plus the official script entry. `curl` and any other id without
 * a direct command resolve to the official script.
 */
const CLI_INSTALL_METHODS: readonly string[] = [
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "brew",
  "scoop",
  "choco",
  "curl",
];

/** Official install script shown when package-manager installs are impossible. */
function officialInstallCommand(): string {
  return process.platform === "win32"
    ? "irm https://opencode.ai/install.ps1 | iex"
    : "curl -fsSL https://opencode.ai/install | bash";
}

/** Executable form of the official install script for the current platform. */
function officialInstallExec(): CliInstallCommand {
  return process.platform === "win32"
    ? {
        file: "powershell",
        args: [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "irm https://opencode.ai/install.ps1 | iex",
        ],
      }
    : { file: "bash", args: ["-c", "curl -fsSL https://opencode.ai/install | bash"] };
}

/** Resolves the install command for a method; unknown ids use the script. */
function installCommandFor(method: string): CliInstallCommand {
  return CLI_INSTALL_COMMANDS.get(method) ?? officialInstallExec();
}

/** Method ids `opencode upgrade --method` may receive from the webview. */
const UPDATE_METHOD_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;
/** Upper bound for method ids before they reach any shell command. */
const MAX_UPDATE_METHOD_LENGTH = 32;

/**
 * Whitelist for update method ids arriving from the webview: short
 * single tokens of letters, digits, underscores, and hyphens only, so a
 * crafted method can never inject shell syntax.
 */
export function isValidOpenCodeUpdateMethod(method: string): boolean {
  return (
    method.length > 0 &&
    method.length <= MAX_UPDATE_METHOD_LENGTH &&
    UPDATE_METHOD_PATTERN.test(method)
  );
}

export type OpenCodeUpdateState =
  | "disabled"
  | "idle"
  | "checking"
  | "installable"
  | "available"
  | "upToDate"
  | "updating"
  | "updateSucceeded"
  | "failed";

/**
 * Coarse progress markers while state is "updating": resolving the target
 * version, reading the installed one, executing the upgrade, optional nvm
 * reshim/remediation, and verification.
 */
export type OpenCodeUpdateStep =
  | "prepare-target"
  | "prepare-local"
  | "execute"
  | "reshim"
  | "remediate-trust"
  | "remediate-reshim"
  | "verify"
  | "installing";

/**
 * Status payload for UI mapping. Terminal events (failed/updateSucceeded)
 * carry structured details; raw command output never leaves the log.
 */
export interface OpenCodeUpdateStatus {
  state: OpenCodeUpdateState;
  step?: OpenCodeUpdateStep;
  /** Log-oriented message on failed terminal events. */
  detail?: string;
  /** Version the update flow is installing or just installed. */
  targetVersion?: string;
  /** Version actually verified on disk (updateSucceeded events). */
  installedVersion?: string;
  /** Version currently installed, on available/upToDate check events. */
  currentVersion?: string;
  /** Latest released version, on available/upToDate check events. */
  latestVersion?: string;
  /** Manual commands for the user when automatic remediation failed. */
  remediationCommands?: string[];
  /** Fixed install-method list, on installable events. */
  methods?: string[];
  /** Preselected install method, on installable events. */
  defaultMethod?: string;
  /** True while the install confirmation dialog should be showing. */
  installPromptPending?: boolean;
  /** True when the check was user-initiated; automatic checks stay silent. */
  manual?: boolean;
}

export interface OpenCodeUpdateCheckResult {
  ok: boolean;
  state: OpenCodeUpdateState;
  current?: string;
  latest?: string;
  error?: string;
}

export interface OpenCodeUpdateResult {
  ok: boolean;
  state: OpenCodeUpdateState;
  targetVersion?: string;
  installedVersion?: string;
  remediationCommands?: string[];
  error?: string;
}

/** Minimal Memento-shaped persistence for update-flow state. */
export interface OpenCodeUpdateStateStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

/** Long-running exec adapter shape (satisfied by streamOpenCodeCliCommand). */
export type UpgradeExecFn = (
  file: string,
  args: string[],
  options?: OpenCodeCliStreamOptions,
) => Promise<string>;

export interface OpenCodeUpdateServiceOptions {
  logger?: Pick<
    OutputChannelService,
    "debug" | "info" | "warn" | "error"
  >;
  /** Clock used for lastCheckAt persistence; defaults to Date.now. */
  now?: () => number;
  /** CLI exec adapter; defaults to OpenCodeCliCompat's retry-backed runner. */
  exec?: RunFn;
  /** Upgrade exec adapter; defaults to OpenCodeCliCompat's streaming runner. */
  execUpgrade?: UpgradeExecFn;
  /** Resolves the opencode binary; defaults to the opencode.commandPath setting. */
  getBinary?: () => string;
}

/** Settings that drive the update flow's scheduled checks (Phase 4). */
export interface OpenCodeUpdateConfig {
  autoCheck: boolean;
  checkIntervalHours: number;
}

/** Reads the update settings from the extension configuration. */
export function getOpenCodeUpdateConfig(): OpenCodeUpdateConfig {
  const config = vscode.workspace.getConfiguration("opencode-cli-sidebar");
  return {
    autoCheck: config.get<boolean>("update.autoCheck", true),
    checkIntervalHours: config.get<number>("update.checkIntervalHours", 24),
  };
}

/** Method breakdown the update popover needs for preselection and marks. */
export interface OpenCodeUpgradeMethodDetails {
  /** Method choices parsed from CLI help; undefined when unavailable. */
  methods?: string[];
  /** Host-computed preselection: last used, then detected, then npm. */
  defaultMethod: string;
  /** Auto-detected install method; undefined when undetectable. */
  detectedMethod?: string;
  /** Last successfully used method. */
  lastUsedMethod?: string;
}

export class OpenCodeUpdateService implements vscode.Disposable {
  private readonly store: OpenCodeUpdateStateStore;
  private readonly logger: Pick<
    OutputChannelService,
    "debug" | "info" | "warn" | "error"
  >;
  private readonly now: () => number;
  private readonly exec: RunFn;
  private readonly execUpgrade: UpgradeExecFn;
  private readonly getBinaryFn: () => string;
  private readonly upgradeChoicesCache = new Map<string, string[]>();
  private readonly _onDidChangeStatus =
    new vscode.EventEmitter<OpenCodeUpdateStatus>();
  /**
   * Raw upgrade/install output lines, exactly as the child process printed
   * them. The webview progress dialog consumes them for its log pane; the
   * full log still lands in the output channel through the logger.
   */
  private readonly _onDidOutputLine = new vscode.EventEmitter<string>();
  private currentState: OpenCodeUpdateState = "idle";
  /** True while the in-webview install confirmation should be showing. */
  private installPromptPending = false;
  /** State restored when an in-flight flow is abandoned by the user. */
  private resumeState: OpenCodeUpdateState = "available";
  private lastResolvedLatest: string | undefined;
  private lastResolvedAt = 0;
  private abortController: AbortController | undefined;
  private inFlightCheck: Promise<OpenCodeUpdateCheckResult> | undefined;
  private readonly binaryPathCache = new Map<string, string>();

  public readonly onDidChangeStatus: vscode.Event<OpenCodeUpdateStatus> =
    this._onDidChangeStatus.event;

  /** Streamed upgrade/install output for the progress dialog log pane. */
  public readonly onDidOutputLine: vscode.Event<string> =
    this._onDidOutputLine.event;

  public constructor(
    store: OpenCodeUpdateStateStore,
    {
      logger = OutputChannelService.getInstance(),
      now = Date.now,
      exec = runOpenCodeCliCommand,
      execUpgrade = streamOpenCodeCliCommand,
      // Read on every call so detection/updates always follow the launch
      // command the extension actually runs. Falsy values fall back to the
      // bare name so a broken setting can never crash version probes.
      getBinary = () =>
        vscode.workspace
          .getConfiguration("opencode-cli-sidebar")
          .get("opencode.commandPath", "opencode") || "opencode",
    }: OpenCodeUpdateServiceOptions = {},
  ) {
    this.store = store;
    this.logger = logger;
    this.now = now;
    this.exec = exec;
    this.execUpgrade = execUpgrade;
    this.getBinaryFn = getBinary;
  }

  public get status(): OpenCodeUpdateState {
    return this.currentState;
  }

  /**
   * Compares the local CLI version against the latest published release.
   * Never throws: failures return `{ ok: false, error }` and restore the
   * previous status. `manual: true` marks user-initiated checks so the UI
   * may show feedback; automatic checks default to silent.
   */
  public async checkForUpdates(
    options: { manual?: boolean } = {},
  ): Promise<OpenCodeUpdateCheckResult> {
    const manual = options.manual === true;
    if (this.currentState === "updating") {
      // A check must never clobber an in-flight update pipeline.
      this.logger.debug(
        "[OpenCodeUpdateService] checkForUpdates ignored: update in progress",
      );
      return {
        ok: false,
        state: this.currentState,
        error: "update in progress",
      };
    }
    if (this.currentState === "checking" && this.inFlightCheck) {
      // Dedupe concurrent checks instead of stacking a second fetch.
      this.logger.debug(
        "[OpenCodeUpdateService] checkForUpdates deduped onto the in-flight check",
      );
      return this.inFlightCheck;
    }

    const previous = this.currentState;
    this.setStatus("checking", { manual });
    const pending = this.runCheck(manual, previous);
    this.inFlightCheck = pending;
    try {
      return await pending;
    } finally {
      if (this.inFlightCheck === pending) {
        this.inFlightCheck = undefined;
      }
    }
  }

  private async runCheck(
    manual: boolean,
    previous: OpenCodeUpdateState,
  ): Promise<OpenCodeUpdateCheckResult> {
    const result = await this.performCheck();
    if (!result.ok) {
      this.logger.warn(
        `[OpenCodeUpdateService] update check failed: ${result.error}`,
      );
      this.setStatus(previous, { manual });
      return { ...result, state: this.currentState };
    }
    if (
      result.state === "disabled" &&
      (this.comesFromInstallable(previous) ||
        this.currentState === "installable")
    ) {
      // The CLI is still missing: keep the installable entry instead of
      // letting a scheduled or manual check hide it again. Covers a fresh
      // installable state, a failed install whose re-check must return to
      // the install entry (resumeState records the flow origin), and the
      // availability probe arming the entry while this check was in flight.
      this.setStatus(
        "installable",
        this.installablePayload(this.installPromptPending),
      );
      return { ok: true, state: this.currentState };
    }
    this.setStatus(result.state, {
      currentVersion: result.current,
      latestVersion: result.latest,
      manual,
    });
    return { ...result, state: this.currentState };
  }

  /** True when the state lags the awaited check into a busy flow. */
  private isBusyUpdating(): boolean {
    return this.currentState === "updating";
  }

  /** True when the flow entered from the missing-CLI install pipeline. */
  private comesFromInstallable(previous: OpenCodeUpdateState): boolean {
    return (
      previous === "installable" ||
      (previous === "failed" && this.resumeState === "installable")
    );
  }

  /**
   * Fast local-only version probe for the pill: no registry fetch and no
   * state transition, so startup can show the version before the first
   * scheduled network check resolves. Returns the version for v2+ CLIs
   * only (the update flow is v2-only); undefined otherwise. With `fresh`
   * the shared version caches are dropped first so the probe reads the
   * disk state another window may just have written.
   */
  public async probeLocalVersion(fresh = false): Promise<string | undefined> {
    if (fresh) {
      resetOpenCodeCliVersionCaches();
    }
    const binary = extractCliBinary(this.getBinaryFn());
    const current = await getOpenCodeVersion(binary);
    if (current === undefined) return undefined;
    const major = parseOpenCodeMajorVersion(current);
    return major !== undefined && major >= 2 ? current : undefined;
  }

  /**
   * Probes whether the configured OpenCode CLI can execute at all via
   * `--version`. Reuses any known or in-flight version probe first so
   * activation does not spawn the binary once per consumer (pill, update
   * check, availability probe). A command that runs but prints
   * unparseable output still counts as present (that case belongs to the
   * existing v1/disabled gating, not to "not installed"); only a failing
   * command means the CLI is missing. Uses the injected exec adapter for
   * the fallback, so the default Windows cmd-shim retry applies.
   */
  public async probeCliAvailable(): Promise<boolean> {
    const binary = extractCliBinary(this.getBinaryFn());
    if (peekOpenCodeVersion(binary) !== undefined) {
      return true;
    }
    const inFlight = peekOpenCodeVersionProbe(binary);
    if (inFlight) {
      const version = await inFlight;
      if (version !== undefined) {
        return true;
      }
    }
    try {
      await this.exec(binary, ["--version"], PROBE_CLI_TIMEOUT_MS);
      return true;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      this.logger.debug(
        `[OpenCodeUpdateService] CLI availability probe failed for ${binary}: ${message}`,
      );
      return false;
    }
  }

  /**
   * Re-detect entry for the install confirmation dialog: the user may
   * have installed the CLI manually outside the extension. Clears the
   * version caches, reports "checking" while probing, then settles to
   * idle when the CLI appeared (the caller refreshes the local version)
   * or back to installable with the confirmation flag cleared when it
   * is still missing. The probe occupies the shared in-flight slot for
   * its whole duration so manual checks and update starts dedupe onto
   * it instead of penetrating the probe window.
   */
  public async recheckCliAvailable(): Promise<boolean> {
    if (this.currentState === "updating") {
      this.logger.debug(
        "[OpenCodeUpdateService] recheckCliAvailable ignored: update in progress",
      );
      return false;
    }
    if (this.currentState === "checking" && this.inFlightCheck) {
      this.logger.debug(
        "[OpenCodeUpdateService] recheckCliAvailable waiting for the in-flight check",
      );
      await this.inFlightCheck.catch(() => undefined);
      if (this.isBusyUpdating()) {
        return false;
      }
    }
    this.setStatus("checking");
    resetOpenCodeCliVersionCaches();
    const pending = (async (): Promise<OpenCodeUpdateCheckResult> => {
      const available = await this.probeCliAvailable();
      if (available) {
        this.setStatus("idle");
      } else {
        this.installPromptPending = false;
        this.setStatus("installable", this.installablePayload(false));
      }
      return { ok: true, state: this.currentState };
    })();
    this.inFlightCheck = pending;
    try {
      const result = await pending;
      return result.state !== "installable";
    } finally {
      if (this.inFlightCheck === pending) {
        this.inFlightCheck = undefined;
      }
    }
  }

  /**
   * Runs the full upgrade pipeline for `method`: resolve target, execute
   * `opencode upgrade`, optionally reshim nvm-windows, remediate NVM4306
   * firewall blocks, then verify the installed version. Never throws;
   * failures return `{ ok: false, error }` with structured details.
   */
  public async startUpdate(method: string): Promise<OpenCodeUpdateResult> {
    if (!isValidOpenCodeUpdateMethod(method)) {
      // Second defense layer: never forward a crafted method id on.
      this.logger.debug(
        `[OpenCodeUpdateService] startUpdate rejected: invalid method ${JSON.stringify(method)}`,
      );
      return { ok: false, state: this.currentState, error: "invalid method" };
    }
    if (this.currentState === "updating") {
      this.logger.debug(
        "[OpenCodeUpdateService] startUpdate ignored: update already in progress",
      );
      return { ok: false, state: this.currentState, error: "update already in progress" };
    }
    if (this.currentState === "checking" && this.inFlightCheck) {
      // A click during the checking window must not be dropped: wait for
      // the in-flight check, then re-evaluate instead of rejecting.
      this.logger.debug(
        "[OpenCodeUpdateService] startUpdate waiting for the in-flight check",
      );
      await this.inFlightCheck.catch(() => undefined);
      if (this.isBusyUpdating()) {
        this.logger.debug(
          "[OpenCodeUpdateService] startUpdate ignored: update already in progress",
        );
        return { ok: false, state: this.currentState, error: "update already in progress" };
      }
    }
    if (this.currentState === "disabled") {
      this.logger.debug(
        "[OpenCodeUpdateService] startUpdate rejected: updates disabled for this CLI",
      );
      return { ok: false, state: this.currentState, error: "updates disabled for this CLI" };
    }

    this.resumeState =
      this.currentState === "installable" ? "installable" : "available";
    this.setStatus("updating", { step: "prepare-target" });
    const binary = extractCliBinary(this.getBinaryFn());
    const controller = new AbortController();
    this.abortController = controller;

    try {
      const target = await this.resolveTargetVersion();
      if (target.upToDate) {
        // A fresh re-check found the disk already at/above the remote
        // latest (e.g. the user updated outside the extension): resolve
        // as up-to-date instead of misclassifying the normal state as
        // a failed update.
        this.setStatus("upToDate", {
          currentVersion: target.current,
          latestVersion: target.latest,
          manual: true,
        });
        return {
          ok: true,
          state: this.currentState,
          targetVersion: target.latest,
          installedVersion: target.current,
        };
      }
      if (!target.latest) {
        if (target.disabled) {
          this.setStatus("disabled");
          return {
            ok: false,
            state: this.currentState,
            error: "update flow requires CLI major >= 2",
          };
        }
        return this.failUpdate(target.error ?? "could not resolve target version");
      }
      const targetVersion = target.latest;

      this.setStatus("updating", { step: "prepare-local", targetVersion });
      const oldVersion = await this.probeVersionWithFallback(binary);
      if (oldVersion === undefined) {
        return this.failUpdate(`local version unavailable for ${binary}`, {
          targetVersion,
        });
      }
      if (!isVersionNewer(targetVersion, oldVersion)) {
        // Disk already at/above the target (e.g. the user updated outside
        // the extension): report up-to-date instead of rerunning the
        // upgrade command.
        this.setStatus("upToDate", {
          currentVersion: oldVersion,
          latestVersion: targetVersion,
          manual: true,
        });
        return {
          ok: true,
          state: this.currentState,
          targetVersion,
          installedVersion: oldVersion,
        };
      }

      this.setStatus("updating", { step: "execute", targetVersion });
      let reshimCompleted = false;
      const first = await this.runUpgradeCommand(
        binary,
        method,
        controller,
        targetVersion,
      );
      if (controller.signal.aborted) {
        return this.abandonedResult();
      }

      if (NVM_BLOCKED_PATTERN.test(first.captured)) {
        if (!NVM_FAMILY_METHODS.includes(method)) {
          return this.failUpdate(
            `upgrade blocked by the nvm firewall (method=${method})`,
            { targetVersion },
          );
        }
        const remediated = await this.remediateNvmBlocked(
          first.captured,
          controller.signal,
          targetVersion,
        );
        if (!remediated.ok) {
          if (controller.signal.aborted) {
            return this.abandonedResult();
          }
          return this.failUpdate(
            remediated.error ?? "nvm firewall remediation failed",
            {
              targetVersion,
              remediationCommands: remediated.commands,
            },
          );
        }
        // Remediation already ran `nvm reshim`; skip the standard step.
        reshimCompleted = true;

        // The blocked attempt may have died before installing anything;
        // re-run the upgrade once now that the module is trusted.
        this.setStatus("updating", { step: "execute", targetVersion });
        const second = await this.runUpgradeCommand(
          binary,
          method,
          controller,
          targetVersion,
        );
        if (controller.signal.aborted) {
          return this.abandonedResult();
        }
        if (NVM_BLOCKED_PATTERN.test(second.captured)) {
          const moduleName =
            parseNvmBlockedModule(second.captured) ??
            parseNvmBlockedModule(first.captured);
          return this.failUpdate(
            "upgrade blocked again by the nvm firewall after remediation",
            moduleName
              ? {
                  targetVersion,
                  remediationCommands: [
                    `nvm firewall trust module ${moduleName}`,
                    "nvm reshim",
                  ],
                }
              : { targetVersion },
          );
        }
        if (second.error) {
          return this.failUpdate(
            `upgrade command failed: ${second.error.message}`,
            { targetVersion },
          );
        }
      } else if (first.error) {
        return this.failUpdate(
          `upgrade command failed: ${first.error.message}`,
          { targetVersion },
        );
      }

      const nvmManaged =
        NVM_FAMILY_METHODS.includes(method) &&
        (await detectNvmWindows(this.exec));
      if (!reshimCompleted && nvmManaged) {
        if (controller.signal.aborted) {
          return this.abandonedResult();
        }
        this.setStatus("updating", { step: "reshim", targetVersion });
        try {
          await this.execUpgrade("nvm", ["reshim"], {
            timeoutMs: NVM_STEP_TIMEOUT_MS,
            signal: controller.signal,
          });
          this.logger.info("[OpenCodeUpdateService] nvm reshim finished");
        } catch (error) {
          if (controller.signal.aborted) {
            return this.abandonedResult();
          }
          const message =
            error instanceof Error ? error.message : String(error);
          return this.failUpdate(`nvm reshim failed: ${message}`, {
            targetVersion,
            remediationCommands: ["nvm reshim"],
          });
        }
      }

      if (nvmManaged) {
        // The upgrade rewrote the module entry script, so the nvm-windows
        // firewall now blocks every proxied run with an interactive trust
        // prompt. Re-trust before verification; trusted modules re-sign
        // themselves silently on the next run.
        await this.trustNvmModule(binary, controller.signal);
      }
      if (controller.signal.aborted) {
        return this.abandonedResult();
      }
      const installed = await this.verifyInstalledVersion(binary);
      if (
        installed === undefined ||
        (installed !== targetVersion &&
          (installed === "local" || !isVersionNewer(installed, oldVersion)))
      ) {
        return this.failUpdate(
          `version verification failed: expected ${targetVersion}, found ${
            installed ?? "(none)"
          }`,
          nvmManaged
            ? {
                targetVersion,
                remediationCommands: [
                  `nvm firewall trust module ${moduleBaseName(binary)}`,
                  "nvm reshim",
                ],
              }
            : { targetVersion },
        );
      }

      await this.setLastMethod(method);
      this.setStatus("updateSucceeded", { targetVersion, installedVersion: installed });
      this.logger.info(
        `[OpenCodeUpdateService] update succeeded: ${oldVersion} -> ${installed} (method=${method})`,
      );
      return {
        ok: true,
        state: this.currentState,
        targetVersion,
        installedVersion: installed,
      };
    } finally {
      if (this.abortController === controller) {
        this.abortController = undefined;
      }
    }
  }

  /**
   * Aborts any in-flight update: kills the child process, resolves the
   * pending pipeline as abandoned, and restores the entry status
   * ("available", or "installable" for missing-CLI installs). Safe to
   * call when nothing is running.
   */
  public abandonUpdate(): void {
    this.abortController?.abort();
    this.abortController = undefined;
    if (this.currentState === "updating") {
      this.logger.info("[OpenCodeUpdateService] update abandoned by user");
      this.setStatus(this.resumeState);
    }
  }

  /**
   * Marks the CLI as missing so the update UI offers the install entry.
   * `prompt` additionally arms the in-webview install confirmation
   * dialog (internal flows such as a failed re-detect pass false to
   * keep the state without re-arming the dialog). Idempotent: states
   * running a flow (updating) or holding a resolved present-CLI result
   * (available/upToDate/updateSucceeded) are never overwritten. The
   * activation availability probe may land while a silent check is
   * still "checking" or after it resolved "disabled" (no CLI at all);
   * its fresh verdict outranks the check and must yield the entry.
   */
  public markCliMissing(prompt = true): void {
    if (
      this.currentState !== "idle" &&
      this.currentState !== "failed" &&
      this.currentState !== "installable" &&
      this.currentState !== "checking" &&
      this.currentState !== "disabled"
    ) {
      this.logger.debug(
        `[OpenCodeUpdateService] markCliMissing ignored in state ${this.currentState}`,
      );
      return;
    }
    this.installPromptPending = prompt;
    this.setStatus("installable", this.installablePayload(prompt));
  }

  /**
   * Clears a pending install confirmation and re-announces the
   * installable state without it. Idempotent: nothing fires once the
   * flag is already cleared, and states past installable are left alone.
   */
  public clearInstallPrompt(): void {
    if (!this.installPromptPending) {
      return;
    }
    this.installPromptPending = false;
    if (this.currentState === "installable") {
      this.setStatus("installable", this.installablePayload(false));
    }
  }

  private installablePayload(prompt: boolean): Omit<
    OpenCodeUpdateStatus,
    "state"
  > {
    return {
      methods: [...CLI_INSTALL_METHODS],
      defaultMethod: this.store.get<string>(LAST_METHOD_KEY) ?? "npm",
      installPromptPending: prompt,
    };
  }

  /**
   * Installs the OpenCode CLI from scratch (it is missing entirely) using
   * the explicit install method chosen in the webview: run the mapped
   * command with streamed progress, reshim nvm-windows for npm-family
   * methods, then verify `--version`. Methods without a direct command
   * fall back to the official install script. Never throws; failures
   * return `{ ok: false, error }` with manual install commands.
   */
  public async startInstall(method: string): Promise<OpenCodeUpdateResult> {
    if (!isValidOpenCodeUpdateMethod(method)) {
      this.logger.debug(
        `[OpenCodeUpdateService] startInstall rejected: invalid method ${JSON.stringify(method)}`,
      );
      return { ok: false, state: this.currentState, error: "invalid method" };
    }
    if (this.currentState === "updating") {
      this.logger.debug(
        "[OpenCodeUpdateService] startInstall ignored: another update flow is in progress",
      );
      return {
        ok: false,
        state: this.currentState,
        error: "update already in progress",
      };
    }
    if (this.currentState === "checking" && this.inFlightCheck) {
      // The UI keeps showing the install entry while a check runs; wait
      // for it and re-evaluate so the click is not silently dropped.
      this.logger.debug(
        "[OpenCodeUpdateService] startInstall waiting for the in-flight check",
      );
      await this.inFlightCheck.catch(() => undefined);
      if (this.isBusyUpdating()) {
        this.logger.debug(
          "[OpenCodeUpdateService] startInstall ignored: another update flow is in progress",
        );
        return {
          ok: false,
          state: this.currentState,
          error: "update already in progress",
        };
      }
    }
    if (this.currentState === "disabled") {
      this.logger.debug(
        "[OpenCodeUpdateService] startInstall rejected: updates disabled for this CLI",
      );
      return {
        ok: false,
        state: this.currentState,
        error: "updates disabled for this CLI",
      };
    }

    this.resumeState =
      this.currentState === "installable" ? "installable" : "available";
    this.setStatus("updating", { step: "installing" });
    const binary = extractCliBinary(this.getBinaryFn());
    const controller = new AbortController();
    this.abortController = controller;

    const scripted = !CLI_INSTALL_COMMANDS.has(method);
    const command = installCommandFor(method);

    try {
      try {
        await this.execUpgrade(command.file, command.args, {
          timeoutMs: UPGRADE_TIMEOUT_MS,
          signal: controller.signal,
          onLine: (line, stream) => {
            this.logger.debug(
              `[OpenCodeUpdateService] install ${stream} | ${line}`,
            );
            this._onDidOutputLine.fire(line);
          },
        });
        this.logger.info(
          `[OpenCodeUpdateService] install command finished via ${method}`,
        );
      } catch (error) {
        if (controller.signal.aborted) {
          return this.abandonedResult();
        }
        const message =
          error instanceof Error ? error.message : String(error);
        return this.failInstall(
          `install command failed via ${method}: ${message}`,
          scripted
            ? [officialInstallCommand()]
            : [
                [command.file, ...command.args].join(" "),
                officialInstallCommand(),
              ],
        );
      }

      const nvmManaged =
        !scripted &&
        NVM_FAMILY_METHODS.includes(method) &&
        (await detectNvmWindows(this.exec));
      if (nvmManaged) {
        if (controller.signal.aborted) {
          return this.abandonedResult();
        }
        this.setStatus("updating", { step: "reshim" });
        try {
          await this.execUpgrade("nvm", ["reshim"], {
            timeoutMs: NVM_STEP_TIMEOUT_MS,
            signal: controller.signal,
          });
          this.logger.info("[OpenCodeUpdateService] nvm reshim finished");
        } catch (error) {
          if (controller.signal.aborted) {
            return this.abandonedResult();
          }
          const message =
            error instanceof Error ? error.message : String(error);
          return this.failInstall(`nvm reshim failed: ${message}`, [
            "nvm reshim",
            officialInstallCommand(),
          ]);
        }
      }

      if (nvmManaged) {
        // The install rewrote the module entry script, so the nvm-windows
        // firewall now blocks every proxied run with an interactive trust
        // prompt. Re-trust before verification; trusted modules re-sign
        // themselves silently on the next run.
        await this.trustNvmModule(binary, controller.signal);
      }
      if (controller.signal.aborted) {
        return this.abandonedResult();
      }
      const installed = await this.verifyInstalledVersion(binary);
      if (installed === undefined) {
        return this.failInstall(
          `version verification failed for ${binary} after install`,
          nvmManaged
            ? [
                `nvm firewall trust module ${moduleBaseName(binary)}`,
                "nvm reshim",
                officialInstallCommand(),
              ]
            : [officialInstallCommand()],
        );
      }

      await this.setLastMethod(method);
      this.setStatus("updateSucceeded", { installedVersion: installed });
      this.logger.info(
        `[OpenCodeUpdateService] CLI install succeeded: ${installed} (via ${method})`,
      );
      return {
        ok: true,
        state: this.currentState,
        installedVersion: installed,
      };
    } finally {
      if (this.abortController === controller) {
        this.abortController = undefined;
      }
    }
  }

  private failInstall(
    message: string,
    remediationCommands: string[],
  ): OpenCodeUpdateResult {
    this.logger.error(`[OpenCodeUpdateService] install failed: ${message}`);
    this.setStatus("failed", { detail: message, remediationCommands });
    return {
      ok: false,
      state: this.currentState,
      error: message,
      remediationCommands,
    };
  }

  /**
   * Resolves the upgrade method the update UI should preselect: the
   * persisted last-used method when still offered, then the detected
   * install method, then npm.
   */
  public async getDefaultMethodForUi(): Promise<string> {
    return (await this.getUpgradeMethodDetails()).defaultMethod;
  }

  /**
   * Resolves the full method breakdown for the update popover: choices,
   * default preselection, detected method, and the persisted last-used
   * method.
   */
  public async getUpgradeMethodDetails(): Promise<OpenCodeUpgradeMethodDetails> {
    const binary = extractCliBinary(this.getBinaryFn());
    // Path heuristics need an absolute path; a bare name never matches and
    // would mispreselect npm for curl installs.
    const detectionPath = await this.resolveBinaryPath(binary);
    const detected = await detectInstallMethod(
      detectionPath,
      process.platform,
      this.exec,
    );
    const detectedMethod =
      detected.method === "unknown" ? undefined : detected.method;
    const lastUsed = this.store.get<string>(LAST_METHOD_KEY);
    const choices = await this.resolveUpgradeChoices(binary);

    const defaultMethod = choices
      ? pickDefaultMethod(choices, lastUsed, detectedMethod)
      : (lastUsed ?? detectedMethod ?? "npm");

    this.logger.debug(
      `[OpenCodeUpdateService] default method=${defaultMethod} (lastUsed=${
        lastUsed ?? "(none)"
      } detected=${detected.method} choices=${
        choices ? choices.join("|") : "(unavailable)"
      })`,
    );
    return {
      methods: choices,
      defaultMethod,
      detectedMethod,
      lastUsedMethod: lastUsed,
    };
  }

  /** Persists the method chosen in the update UI for future preselection. */
  public async setLastMethod(method: string): Promise<void> {
    await this.store.update(LAST_METHOD_KEY, method);
    this.logger.debug(
      `[OpenCodeUpdateService] last method persisted: ${method}`,
    );
  }

  /** Timestamp of the last successful check, for scheduling skip logic. */
  public getLastCheckAt(): number | undefined {
    return this.store.get<number>(LAST_CHECK_AT_KEY);
  }

  /**
   * Resolves a binary name to its absolute path for path-based install
   * detection. Already-absolute inputs pass through; lookup failures fall
   * back to the bare name so package-manager probes still run.
   */
  private async resolveBinaryPath(binary: string): Promise<string> {
    if (path.isAbsolute(binary)) {
      return binary;
    }
    const cached = this.binaryPathCache.get(binary);
    if (cached !== undefined) {
      return cached;
    }
    const resolved = await this.lookupBinaryPath(binary);
    this.binaryPathCache.set(binary, resolved);
    return resolved;
  }

  private async lookupBinaryPath(binary: string): Promise<string> {
    const command = process.platform === "win32" ? "where" : "which";
    try {
      const output = await this.exec(command, [binary]);
      const first = output.trim().split(/\r?\n/)[0]?.trim() ?? "";
      return first || binary;
    } catch {
      return binary;
    }
  }

  public dispose(): void {
    this._onDidChangeStatus.dispose();
    this._onDidOutputLine.dispose();
  }

  /**
   * Check logic without status transitions so `startUpdate` can reuse it
   * while it already reports "updating".
   */
  private async performCheck(): Promise<OpenCodeUpdateCheckResult> {
    const binary = extractCliBinary(this.getBinaryFn());

    // The CLI may have been upgraded outside the extension (terminal,
    // npm, another window): drop cached versions so the comparison below
    // sees the binary on disk, not a value from an earlier probe.
    resetOpenCodeCliVersionCaches();

    // One `--version` probe feeds both the full version and the major gate;
    // an unprobeable CLI counts as disabled (v2-only feature).
    const current = await this.probeCurrentVersion(binary);
    const major =
      current !== undefined ? parseOpenCodeMajorVersion(current) : undefined;
    if (current === undefined || major === undefined || major < 2) {
      this.logger.debug(
        `[OpenCodeUpdateService] update flow needs CLI major >= 2; ${binary} reports ${
          major ?? "(unknown)"
        }`,
      );
      return { ok: true, state: "disabled" };
    }

    let latest: string;
    try {
      latest = await this.fetchLatestVersion();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, state: this.currentState, error: message };
    }

    const state: OpenCodeUpdateState = isVersionNewer(latest, current)
      ? "available"
      : "upToDate";
    const checkedAt = this.now();
    await this.store.update(LAST_CHECK_AT_KEY, checkedAt);
    this.lastResolvedLatest = latest;
    this.lastResolvedAt = checkedAt;
    this.logger.info(
      `[OpenCodeUpdateService] check complete: current=${current} latest=${latest} state=${state}`,
    );
    return { ok: true, state, current, latest };
  }

  /**
   * Version probe that self-heals the nvm-windows v2 module firewall:
   * when the probe fails on Windows with nvm 2.x present, the module may
   * be blocked by an interactive trust prompt (e.g. it was upgraded
   * outside this flow). Trust it once and re-probe; failures fall back
   * to the original undefined result.
   */
  private async probeCurrentVersion(
    binary: string,
  ): Promise<string | undefined> {
    const direct = await getOpenCodeVersion(binary);
    if (direct !== undefined || process.platform !== "win32") {
      return direct;
    }
    if (!(await detectNvmWindows(this.exec))) {
      return direct;
    }
    if (!(await this.trustNvmModule(binary))) {
      return direct;
    }
    resetOpenCodeCliVersionCaches();
    return getOpenCodeVersion(binary);
  }

  /**
   * Resolves the upgrade target: the cached latest from a check younger
   * than TARGET_CACHE_MS, otherwise a fresh check. Never throws. A
   * re-check that finds the disk already current returns `upToDate`
   * with the observed versions so callers can short-circuit cleanly.
   */
  private async resolveTargetVersion(): Promise<{
    latest?: string;
    disabled?: boolean;
    upToDate?: boolean;
    current?: string;
    error?: string;
  }> {
    if (
      this.lastResolvedLatest !== undefined &&
      this.now() - this.lastResolvedAt < TARGET_CACHE_MS
    ) {
      this.logger.debug(
        `[OpenCodeUpdateService] using cached target version ${this.lastResolvedLatest}`,
      );
      return { latest: this.lastResolvedLatest };
    }

    const check = await this.performCheck();
    if (!check.ok) {
      return { error: check.error ?? "update check failed" };
    }
    if (check.state === "disabled") {
      return { disabled: true };
    }
    if (check.state !== "available" || !check.latest) {
      return { upToDate: true, current: check.current, latest: check.latest };
    }
    return { latest: check.latest };
  }

  /**
   * NVM4306 remediation: trust the blocked module, reshim, and let the
   * caller retry verification once. Failures carry the two manual commands.
   */
  private async remediateNvmBlocked(
    capturedOutput: string,
    signal: AbortSignal,
    targetVersion: string,
  ): Promise<{ ok: boolean; commands?: string[]; error?: string }> {
    const moduleName = parseNvmBlockedModule(capturedOutput);
    if (!moduleName) {
      return {
        ok: false,
        error: "nvm firewall blocked the upgrade but the module path was unparseable",
      };
    }

    const commands = [
      `nvm firewall trust module ${moduleName}`,
      "nvm reshim",
    ];

    this.setStatus("updating", { step: "remediate-trust", targetVersion });
    try {
      await this.execUpgrade(
        "nvm",
        ["firewall", "trust", "module", moduleName],
        { timeoutMs: NVM_STEP_TIMEOUT_MS, signal },
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return { ok: false, commands, error: `nvm trust failed: ${message}` };
    }

    if (signal.aborted) {
      return { ok: false, error: "abandoned" };
    }

    this.setStatus("updating", { step: "remediate-reshim", targetVersion });
    try {
      await this.execUpgrade("nvm", ["reshim"], {
        timeoutMs: NVM_STEP_TIMEOUT_MS,
        signal,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      return { ok: false, commands, error: `nvm reshim failed: ${message}` };
    }
    this.logger.info(
      `[OpenCodeUpdateService] nvm remediation finished (module=${moduleName})`,
    );
    return { ok: true };
  }

  /**
   * Re-trusts the OpenCode module in the nvm-windows v2 firewall after an
   * upgrade rewrote its entry script. Without this, every proxied run
   * blocks on an interactive trust prompt the extension-host cannot
   * answer, so version probes and the user's terminal both stall.
   * Best-effort: older nvm 2.x builds ship no `firewall` subcommand, and
   * a failed trust only means verification will surface the problem.
   */
  private async trustNvmModule(
    binary: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (process.platform !== "win32") {
      return false;
    }
    try {
      await this.execUpgrade(
        "nvm",
        ["firewall", "trust", "module", moduleBaseName(binary)],
        { timeoutMs: NVM_STEP_TIMEOUT_MS, signal },
      );
      return true;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[OpenCodeUpdateService] nvm module trust failed: ${message}`,
      );
      return false;
    }
  }

  /** Fresh `--version` probe after version caches are cleared. */
  private async verifyInstalledVersion(
    binary: string,
  ): Promise<string | undefined> {
    this.setStatus("updating", { step: "verify" });
    // Cache-only reset: keep the diagnostics sink and shell-retry wiring.
    resetOpenCodeCliVersionCaches();
    return this.probeVersionWithFallback(binary);
  }

  /**
   * Version probe with a bare-name fallback: the configured binary path
   * can stop resolving after an upgrade replaced its shim, so an
   * unprobeable path retries once as the bare command name before the
   * caller declares failure. Detection only; install commands run with
   * their own fixed executables.
   */
  private async probeVersionWithFallback(
    binary: string,
  ): Promise<string | undefined> {
    const direct = await getOpenCodeVersion(binary);
    if (direct !== undefined || binary === BARE_BINARY_NAME) {
      return direct;
    }
    this.logger.debug(
      `[OpenCodeUpdateService] version probe failed for ${binary}; retrying as bare ${BARE_BINARY_NAME}`,
    );
    return getOpenCodeVersion(BARE_BINARY_NAME);
  }

  /** Runs one upgrade command with full timeout, abort, and streaming. */
  private async runUpgradeCommand(
    binary: string,
    method: string,
    controller: AbortController,
    targetVersion: string,
  ): Promise<{ captured: string; error?: Error }> {
    const captured: string[] = [];
    let execError: Error | undefined;
    try {
      await this.execUpgrade(binary, ["upgrade", "--method", method], {
        timeoutMs: UPGRADE_TIMEOUT_MS,
        signal: controller.signal,
        onLine: (line, stream) => {
          captured.push(line);
          this.logger.debug(
            `[OpenCodeUpdateService] upgrade ${stream} | ${line}`,
          );
          this._onDidOutputLine.fire(line);
        },
      });
      this.logger.info(
        `[OpenCodeUpdateService] upgrade command finished (method=${method} target=${targetVersion})`,
      );
    } catch (error) {
      execError = error instanceof Error ? error : new Error(String(error));
    }
    return { captured: captured.join("\n"), error: execError };
  }

  private abandonedResult(): OpenCodeUpdateResult {
    this.logger.info("[OpenCodeUpdateService] update abandoned");
    return {
      ok: false,
      state: this.currentState,
      error: "update abandoned",
    };
  }

  private failUpdate(
    message: string,
    details: Pick<OpenCodeUpdateResult, "targetVersion" | "remediationCommands"> = {},
  ): OpenCodeUpdateResult {
    this.logger.error(`[OpenCodeUpdateService] update failed: ${message}`);
    this.setStatus("failed", { detail: message, ...details });
    return {
      ok: false,
      state: this.currentState,
      error: message,
      ...details,
    };
  }

  private setStatus(
    state: OpenCodeUpdateState,
    extra: Omit<OpenCodeUpdateStatus, "state"> = {},
  ): void {
    this.currentState = state;
    this._onDidChangeStatus.fire({ state, ...extra });
  }

  /**
   * Races every latest-version endpoint concurrently; resolves with the
   * first valid version and rejects only when every endpoint (official
   * registry and both mirrors) has failed. Losing requests are left to
   * finish or time out on their own; each per-endpoint failure lands in
   * the debug log.
   */
  private async fetchLatestVersion(): Promise<string> {
    const attempts = LATEST_VERSION_ENDPOINTS.map(async (endpoint) => {
      const host = new URL(endpoint).host;
      try {
        const version = await this.fetchNpmLatest(endpoint);
        this.logger.debug(
          `[OpenCodeUpdateService] latest version resolved from ${host}`,
        );
        return version;
      } catch (error) {
        const failure =
          error instanceof Error ? error : new Error(String(error));
        this.logger.debug(
          `[OpenCodeUpdateService] latest version lookup failed on ${host}: ${failure.message}`,
        );
        throw failure;
      }
    });
    try {
      return await Promise.any(attempts);
    } catch {
      throw new Error("all latest-version endpoints failed");
    }
  }

  private async fetchNpmLatest(endpoint: string): Promise<string> {
    const response = await fetch(endpoint, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(LATEST_FETCH_TIMEOUT_MS),
    });
    const host = new URL(endpoint).host;
    if (!response.ok) {
      throw new Error(`${host} returned ${response.status}`);
    }
    const body = (await response.json()) as { version?: unknown };
    if (typeof body.version !== "string" || !body.version.trim()) {
      throw new Error(`${host} response missing version`);
    }
    return body.version.trim();
  }

  /** Resolves and caches `opencode upgrade --help` choices for one binary. */
  private async resolveUpgradeChoices(
    binary: string,
  ): Promise<string[] | undefined> {
    const cached = this.upgradeChoicesCache.get(binary);
    if (cached) {
      return cached;
    }

    let choices: string[] | undefined;
    try {
      const help = await this.exec(binary, ["upgrade", "--help"]);
      choices = parseUpgradeMethodChoices(help);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      this.logger.debug(
        `[OpenCodeUpdateService] upgrade help probe failed: ${message}`,
      );
    }
    if (choices) {
      this.upgradeChoicesCache.set(binary, choices);
    }
    return choices;
  }
}

/** Basename of a path from either separator style, extension stripped. */
function moduleBaseName(filePath: string): string {
  const base = filePath.split(/[\\/]/).filter(Boolean).pop() ?? "";
  return base.replace(/\.[^.]+$/, "");
}

/** Parses the blocked module name from NVM4306 `File: <path>` output. */
function parseNvmBlockedModule(capturedOutput: string): string | undefined {
  const filePath = capturedOutput.match(/File:\s*(.+)/)?.[1]?.trim();
  const moduleName = filePath ? moduleBaseName(filePath) : undefined;
  return moduleName || undefined;
}
