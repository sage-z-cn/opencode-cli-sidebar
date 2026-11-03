import * as os from "os";
import * as vscode from "vscode";
import { l10n } from "../i18n";
import { OutputCaptureManager } from "../services/OutputCaptureManager";
import { OpenCodeApiClient } from "../services/OpenCodeApiClient";
import type { OpenCodeGenerateConnection } from "../services/OpenCodeGenerateClient";
import { PortManager } from "../services/PortManager";
import { ContextSharingService } from "../services/ContextSharingService";
import { OutputChannelService } from "../services/OutputChannelService";
import { InstanceId, InstanceStore } from "../services/InstanceStore";
import { isOhMyOpenCodeSlimAvailable } from "../services/openCodeConfigPath";
import {
  ServiceRestartPromptAction,
  TerminalBackendType,
} from "../types";
import {
  OpenCodeFileReference,
  OpenCodeToolOperator,
} from "../services/aiTools/OpenCodeToolOperator";
import { TerminalManager } from "../terminals/TerminalManager";
import {
  detectOpenCodeMajorVersion,
  detectOpenCodeApiProtocol,
  resolveOpenCodeV2Service,
  extractCliBinary,
  commandBypassesSharedService,
  runOpenCodeCliCommand,
  type OpenCodeApiProtocol,
} from "../services/OpenCodeCliCompat";
import { TerminalBackendRegistry } from "../services/terminalBackends";
import type { IdeContextServer } from "../services/ideContext/IdeContextServer";
import type {
  BackendLaunchPlan,
} from "../services/terminalBackends";
import { NativeTerminalManager } from "../services/NativeTerminalManager";
import type { StartupGate } from "../services/StartupCoordinator";

interface StartupWorkspaceResolution {
  workspacePath: string;
  isWorkspaceScoped: boolean;
}

/**
 * Policy for the shared OpenCode v2 background service during a restart.
 * - "prompt": ask the user with a modal dialog (manual restarts).
 * - "always": restart the service without asking (restart-after-update,
 *   where the updated binary requires a fresh service).
 */
export type ServiceRestartPolicy = "prompt" | "always";

interface SessionRuntimeCallbacks {
  postMessage: (message: unknown) => void;
  onActiveInstanceChanged: (instanceId: InstanceId) => void;
  requestStartOpenCode: () => Promise<void>;
}

export interface SessionState {
  instanceId: InstanceId;
  terminalKey: string;
  port?: number;
  backendState?: import("../services/terminalBackends").BackendSessionState;
  backend: TerminalBackendType;
}

export class SessionRuntime {
  private static readonly LEGACY_TERMINAL_ID: InstanceId = "ai-sidebar-terminal-main";

  private activeInstanceId: InstanceId = "default";
  private isStarted = false;
  private isStarting = false;
  private apiClient?: OpenCodeApiClient;
  /** Live endpoint used for text generation (changelog translation). */
  private translationConnection?: OpenCodeGenerateConnection;
  private httpAvailable = false;
  private dataListener?: vscode.Disposable;
  private exitListener?: vscode.Disposable;
  private activeInstanceSubscription?: vscode.Disposable;
  private lastKnownCols = 0;
  private lastKnownRows = 0;
  private activeBackend: TerminalBackendType = "native";
  /** Resolves the pending in-webview service-restart prompt (see promptServiceRestartInWebview). */
  private serviceRestartPromptResolver?: (action: ServiceRestartPromptAction) => void;
  /**
   * Launch command snapshot taken when the session last started. Restart
   * and reconnect judgments use it so mid-session settings changes cannot
   * drift the decision away from what actually runs.
   */
  private activeLaunchCommand?: string;
  private openCodeCliMajor: number | undefined;
  private openCodeMajorRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private session?: SessionState;

  public constructor(
    private readonly terminalManager: TerminalManager,
    _captureManager: OutputCaptureManager,
    _openCodeApiClient: OpenCodeApiClient | undefined,
    private readonly portManager: PortManager,
    private readonly backendRegistry: TerminalBackendRegistry,
    private readonly instanceStore: InstanceStore | undefined,
    private readonly logger: OutputChannelService,
    private readonly contextSharingService: ContextSharingService,
    private readonly opencodeOperator: OpenCodeToolOperator,
    private readonly callbacks: SessionRuntimeCallbacks,
    private readonly nativeTerminalManager?: NativeTerminalManager,
    private readonly ideContextServer?: IdeContextServer,
    private readonly startupGate?: StartupGate,
  ) {
    if (this.instanceStore) {
      this.subscribeToActiveInstanceChanges();
    } else {
      this.activeInstanceId = SessionRuntime.LEGACY_TERMINAL_ID;
    }
  }

  public getActiveInstanceId(): InstanceId {
    return this.activeInstanceId;
  }

  public getActiveTerminalId(): string {
    return (
      this.session?.terminalKey ??
      this.resolveTerminalIdForInstance(this.activeInstanceId)
    );
  }

  public getLastKnownTerminalSize(): { cols: number; rows: number } {
    return { cols: this.lastKnownCols, rows: this.lastKnownRows };
  }

  public setLastKnownTerminalSize(cols: number, rows: number): void {
    this.lastKnownCols = cols;
    this.lastKnownRows = rows;
  }

  public isStartedFlag(): boolean {
    return this.isStarted;
  }

  /**
   * Currently resolved OpenCode CLI major version. Undefined while the
   * binary has not been resolved yet, including a session "started" while
   * the CLI was missing (the version parse can never succeed there).
   */
  public getCliMajorVersion(): number | undefined {
    return this.openCodeCliMajor;
  }

  /** True while a session launch is in progress and not yet settled. */
  public isStartingSession(): boolean {
    return this.isStarting;
  }

  public getApiClient(): OpenCodeApiClient | undefined {
    return this.apiClient;
  }

  /** Connection used for text generation, or undefined when HTTP is unavailable. */
  public getGenerateConnection(): OpenCodeGenerateConnection | undefined {
    return this.translationConnection;
  }

  public getActiveBackend(): TerminalBackendType {
    return this.activeBackend;
  }

  public isHttpAvailable(): boolean {
    return this.httpAvailable;
  }

  public hasLiveTerminalProcess(): boolean {
    return (
      this.isStarted &&
      this.terminalManager.getTerminal(this.getActiveTerminalId()) !== undefined
    );
  }

  public getActiveSession(): SessionState | undefined {
    return this.session ? { ...this.session } : undefined;
  }

  public async startOpenCode(): Promise<void> {
    await this.startDefaultSession();
  }

  public async switchToInstance(
    instanceId: InstanceId,
    options?: { forceRestart?: boolean },
  ): Promise<void> {
    const forceRestart = options?.forceRestart ?? false;
    if (instanceId === this.activeInstanceId && !forceRestart) {
      return;
    }

    this.disposeListeners();
    this.portManager.releaseTerminalPorts(this.activeInstanceId);
    this.portManager.releaseTerminalPorts(instanceId);
    this.resetState(false);
    this.activeInstanceId = instanceId;

    this.callbacks.postMessage({ type: "clearTerminal" });

    const existingTerminal =
      this.terminalManager.getByInstance(instanceId) ||
      this.terminalManager.getTerminal(instanceId);

    if (existingTerminal && !forceRestart) {
      this.isStarted = true;
      // Re-detect the CLI major so the keymap flag reflects the binary
      // actually in use (cached per binary, so this is cheap after launch).
      const command = this.resolveActiveLaunchCommand();
      this.openCodeCliMajor = await this.resolveOpenCodeMajorForKeymap(
        command,
      );
      this.reconnectListeners();
      this.syncActiveInstance(instanceId);

      const config = vscode.workspace.getConfiguration("opencode-cli-sidebar");
      if (existingTerminal.port) {
        const httpTimeout = config.get<number>("httpTimeout", 5000);
        // OpenCode v1 requires x-opencode-directory on instance-scoped
        // routes (/tui/append-prompt, /session/*). Resolve the workspace path
        // from the now-active instance so the client sends the right one.
        const directory = this.resolveStartupWorkspacePath().workspacePath;
        const apiProtocol = await detectOpenCodeApiProtocol(command);
        if (apiProtocol === "v2") {
          const v2Service = await resolveOpenCodeV2Service(command);
          this.apiClient = v2Service
            ? OpenCodeApiClient.fromV2Service(v2Service, {
                maxRetries: 10,
                baseDelay: 200,
                timeoutMs: httpTimeout,
                directory,
              })
            : undefined;
          this.translationConnection = v2Service
            ? {
                protocol: "v2",
                baseUrl: v2Service.url,
                password: v2Service.password,
                directory,
              }
            : undefined;
        } else {
          this.apiClient = new OpenCodeApiClient(
            existingTerminal.port,
            10,
            200,
            httpTimeout,
            directory,
          );
          this.translationConnection = {
            protocol: "v1",
            baseUrl: `http://localhost:${existingTerminal.port}`,
            directory,
          };
        }
        if (this.apiClient) {
          await this.pollForHttpReadiness();
        }
      }

      if (this.lastKnownCols && this.lastKnownRows) {
        this.terminalManager.resizeTerminal(
          this.getActiveTerminalId(),
          this.lastKnownCols,
          this.lastKnownRows,
        );
      }
      return;
    }

    if (existingTerminal && forceRestart) {
      this.terminalManager.killByInstance(instanceId);
      this.terminalManager.killTerminal(instanceId);
    }

    await this.callbacks.requestStartOpenCode();
    this.syncActiveInstance(instanceId);
  }

  private async startDefaultSession(): Promise<SessionState | undefined> {
    if (this.isStarted || this.isStarting) {
      return (
        this.session ?? {
          instanceId: this.activeInstanceId,
          terminalKey: this.getActiveTerminalId(),
          backend: "native",
        }
      );
    }

    this.isStarting = true;

    try {
      this.disposeListeners();

      const config = vscode.workspace.getConfiguration("opencode-cli-sidebar");
      const httpTimeout = config.get<number>("httpTimeout", 5000);

      const { workspacePath } = this.resolveStartupWorkspacePath();

      const commandPath = config.get<string>(
        "opencode.commandPath",
        "opencode",
      );
      const opencodeArgs = config.get<string[]>("opencode.args", []);
      const continueLastSession = config.get<boolean>(
        "opencode.continueLastSession",
        true,
      );
      let command = this.opencodeOperator.getLaunchCommand({
        commandPath,
        args: opencodeArgs,
        continueLastSession,
      });
      if (!command) {
        this.isStarting = false;
        void vscode.window.showWarningMessage(
          l10n.t(
            "OpenCode launch command is empty. Check the opencode.commandPath setting.",
          ),
        );
        return;
      }
      this.activeLaunchCommand = command;

      let nativeLaunchPlan: BackendLaunchPlan | undefined;
      if (this.nativeTerminalManager) {
        nativeLaunchPlan = this.nativeTerminalManager.create(
          this.activeInstanceId,
          {
            command,
            args: opencodeArgs,
            cwd: workspacePath,
          },
        );
      }

      let port: number | undefined;
      let openCodeCliMajor: number | undefined;
      let apiProtocol: OpenCodeApiProtocol | undefined;
      let v2Service: Awaited<ReturnType<typeof resolveOpenCodeV2Service>>;
      // Keymap flag: resolve the CLI major for OpenCode (cached per binary;
      // falls back to the v2 service file).
      this.openCodeCliMajor = await this.resolveOpenCodeMajorForKeymap(command);
      if (command) {
        // OpenCode v1 hosts HTTP on `--port=N`. OpenCode v2 rejects `--port`
        // on the TUI and talks to a background service instead.
        openCodeCliMajor =
          this.openCodeCliMajor ??
          (await detectOpenCodeMajorVersion(command));
        this.openCodeCliMajor = openCodeCliMajor;
        apiProtocol =
          openCodeCliMajor !== undefined
            ? openCodeCliMajor >= 2
              ? "v2"
              : "v1"
            : await detectOpenCodeApiProtocol(command);

        try {
          if (apiProtocol === "v2") {
            v2Service = await resolveOpenCodeV2Service(command);
            port = v2Service?.port;
            if (v2Service) {
              // A live v2 background service is proof of v2 even when the
              // --version probe failed — record it for the keymap flag.
              this.openCodeCliMajor = 2;
              this.logger.info(
                `[TerminalProvider] Using OpenCode v2 service ${v2Service.url} (port ${v2Service.port})`,
              );
            } else {
              this.logger.warn(
                "[TerminalProvider] OpenCode v2 detected but the background service is not up yet",
              );
            }
          } else {
            port = this.portManager.assignPortToTerminal(this.activeInstanceId);
            this.logger.info(
              `[TerminalProvider] Assigned port ${port} to terminal ${this.activeInstanceId}`,
            );
            // OpenCode v1 reads the HTTP port from `--port=N` and no longer
            // honours the legacy `_EXTENSION_OPENCODE_PORT` env var. Append the
            // arg here so the spawned process actually binds the port we will
            // poll below. Without this, pollForHttpReadiness never succeeds and
            // auto-context sharing silently never fires.
            const portArg = this.opencodeOperator.buildPortArg(port, {
              cliMajorVersion: openCodeCliMajor,
            });
            if (portArg) {
              command = `${command} ${portArg}`;
              this.logger.info(
                `[TerminalProvider] Appended HTTP port arg: ${portArg}`,
              );
            }
          }
        } catch (error) {
          this.translationConnection = undefined;
          this.logger.error(
            `[TerminalProvider] Failed to assign port: ${error instanceof Error ? error.message : String(error)}`,
          );
          vscode.window.showWarningMessage(
            l10n.t("Failed to assign port for OpenCode HTTP API. Running without HTTP features."),
          );
        }
      }

      // Start the editor-context WS server BEFORE spawning OpenCode so the
      // `~/.claude/ide/<port>.lock` file exists when OpenCode TUI's editor.ts
      // polls for it. If Claude Code's extension is already serving the WS,
      // start() detects the lock file and defers (returns started=false).
      // Failures are swallowed: OpenCode should still launch, just without
      // live editor context.
      if (this.ideContextServer) {
        const autoShareContext = vscode.workspace
          .getConfiguration("opencode-cli-sidebar")
          .get<boolean>("autoShareContext", true);
        if (!autoShareContext) {
          this.logger.info(
            "[TerminalProvider] Editor context WS disabled by autoShareContext setting",
          );
        } else {
          await this.startEditorContextWs();
        }
      }

      // Multiple VS Code windows restore at once and would otherwise each
      // spawn a contender for the same fixed service port. Only v2 has a
      // shared service; v1 binds its own port per window and needs no gate.
      if (apiProtocol === "v2" && this.startupGate) {
        const outcome = await this.startupGate.beforeStart();
        this.logger.info(`[TerminalProvider] OpenCode startup gate: ${outcome}`);
      }

      this.terminalManager.createTerminal(
        this.activeInstanceId,
        command,
        port
          ? {
              _EXTENSION_OPENCODE_PORT: port.toString(),
              OPENCODE_CALLER: "vscode",
            }
          : {},
        port,
        this.lastKnownCols || undefined,
        this.lastKnownRows || undefined,
        this.activeInstanceId,
        workspacePath,
      );

      this.session = {
        instanceId: this.activeInstanceId,
        terminalKey: this.activeInstanceId,
        port,
        backendState: nativeLaunchPlan?.state,
        backend: "native",
      };

      if (this.instanceStore) {
        try {
          const existing = this.instanceStore.get(this.activeInstanceId);
          if (existing) {
            this.instanceStore.upsert({
              ...existing,
              config: {
                ...existing.config,
                terminalBackend: "native",
              },
              runtime: {
                ...existing.runtime,
                terminalKey: this.activeInstanceId,
                terminalBackend: "native",
                backendState: nativeLaunchPlan?.state,
                port: port ?? existing.runtime.port,
              },
            });
          } else {
            this.instanceStore.upsert({
              config: {
                id: this.activeInstanceId,
                terminalBackend: "native",
              },
              runtime: {
                terminalKey: this.activeInstanceId,
                terminalBackend: "native",
                backendState: nativeLaunchPlan?.state,
                port,
              },
              state: "connected",
            });
          }
        } catch (err) {
          this.logger.warn(
            `[TerminalProvider] Failed to update instance store with terminal key: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      this.reconnectListeners();

      this.isStarted = true;

      this.notifyActiveSession();

      // A fresh process reloaded cli.json; pending plugin version pins
      // in the settings UI are now active.
      this.callbacks.postMessage({ type: "openCodeSessionStarted" });

      // The v2 background service only exists after the TUI has started.
      // When the pre-launch probes failed (e.g. the CLI is not on the
      // extension host PATH and no service file existed yet), retry once
      // the terminal has been up for a while and re-notify if we can then
      // resolve the major — otherwise the keymap button never appears.
      if (command && this.openCodeCliMajor === undefined) {
        this.scheduleOpenCodeMajorRetry(command);
      }

      if (port) {
        if (v2Service) {
          this.apiClient = OpenCodeApiClient.fromV2Service(v2Service, {
            maxRetries: 10,
            baseDelay: 200,
            timeoutMs: httpTimeout,
            directory: workspacePath,
          });
          this.translationConnection = {
            protocol: "v2",
            baseUrl: v2Service.url,
            password: v2Service.password,
            directory: workspacePath,
          };
        } else {
          // Pass the resolved workspace path so the client can emit
          // x-opencode-directory on instance-scoped routes. Required by
          // OpenCode v1 WorkspaceRoutingMiddleware.
          this.apiClient = new OpenCodeApiClient(
            port,
            10,
            200,
            httpTimeout,
            workspacePath,
          );
          this.translationConnection = {
            protocol: "v1",
            baseUrl: `http://localhost:${port}`,
            directory: workspacePath,
          };
        }
        await this.pollForHttpReadiness();
      } else {
        this.translationConnection = undefined;
        this.logger.info(
          "[TerminalProvider] HTTP API disabled or unavailable, using message passing fallback",
        );
        this.httpAvailable = false;
      }

      return { ...this.session };
    } finally {
      this.isStarting = false;
    }
  }

  /**
   * Restarts the active session. Kept synchronous for existing callers;
   * the teardown, optional v2 service restart, and relaunch happen in
   * restartSession().
   */
  public restart(serviceRestart: ServiceRestartPolicy = "prompt"): void {
    void this.restartSession(serviceRestart);
  }

  /**
   * Tears down the active session and relaunches it. When the session being
   * restarted is OpenCode v2 and the TUI attaches to the shared background
   * service, the service is restarted per the given policy: "prompt" asks
   * the user through an in-webview prompt (cancelling it aborts the
   * restart), "always" restarts it without asking (restart-after-update). Standalone (`--standalone`) and explicit-server
   * (`--server <url>`) TUIs skip the service restart entirely because they
   * never attach to the shared service. A failed service restart is logged
   * but non-fatal: the terminal relaunch below must always proceed.
   */
  private async restartSession(
    serviceRestart: ServiceRestartPolicy = "prompt",
  ): Promise<void> {
    // Capture the v2 service-restart target BEFORE resetState() clears
    // openCodeCliMajor — the gate and the launch command are only readable
    // from the session being torn down.
    let serviceRestartBinary: string | undefined;
    if (this.isOpenCodeV2Active()) {
      const command = this.resolveActiveLaunchCommand();
      if (commandBypassesSharedService(command)) {
        this.logger.info(
          "[SessionRuntime] OpenCode v2 TUI runs without the shared background service; skipping background service restart",
        );
      } else {
        const binary = extractCliBinary(command);
        if (binary) {
          serviceRestartBinary = binary;
        } else {
          this.logger.warn(
            "[SessionRuntime] Could not extract OpenCode CLI binary for background service restart",
          );
        }
      }
    }

    // Resolve the service decision before tearing anything down so the
    // current session stays untouched while the prompt is open; cancelling
    // the prompt aborts the restart entirely.
    let restartService = false;
    if (serviceRestartBinary) {
      if (serviceRestart === "always") {
        restartService = true;
        this.logger.info(
          "[SessionRuntime] Restarting background service without prompting (restart-after-update)",
        );
      } else {
        const answer = await this.promptServiceRestartInWebview();
        if (answer === "cancel") {
          this.logger.info(
            "[SessionRuntime] Terminal restart cancelled from the service-restart prompt",
          );
          return;
        }
        restartService = answer === "restartService";
        this.logger.info(
          `[SessionRuntime] Background service restart on terminal restart: ${restartService ? "yes" : "no"}`,
        );
      }
    }

    this.disposeListeners();
    this.destroyActiveSession();
    this.resetState();

    this.callbacks.postMessage({ type: "clearTerminal" });

    if (serviceRestartBinary && restartService) {
      this.logger.info(
        `[SessionRuntime] Restarting OpenCode v2 background service (${serviceRestartBinary} service restart)`,
      );
      try {
        const output = await runOpenCodeCliCommand(
          serviceRestartBinary,
          ["service", "restart"],
          15000,
        );
        this.logger.info(
          `[SessionRuntime] OpenCode v2 background service restarted: ${output.trim()}`,
        );
      } catch (error) {
        // Non-fatal: the TUI relaunch below still runs and will start or
        // reconnect to a service on its own.
        this.logger.warn(
          `[SessionRuntime] OpenCode v2 background service restart failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    void this.callbacks.requestStartOpenCode();
  }

  /**
   * Shows the service-restart prompt inside the webview and resolves with
   * the user's answer. Any previous unanswered prompt is cancelled first so
   * a stale restart cannot linger.
   */
  private promptServiceRestartInWebview(): Promise<ServiceRestartPromptAction> {
    this.serviceRestartPromptResolver?.("cancel");
    return new Promise<ServiceRestartPromptAction>((resolve) => {
      this.serviceRestartPromptResolver = resolve;
      this.callbacks.postMessage({ type: "showServiceRestartPrompt" });
    });
  }

  /** Resolves the pending prompt; called by MessageRouter with the webview answer. */
  public answerServiceRestartPrompt(action: ServiceRestartPromptAction): void {
    const resolve = this.serviceRestartPromptResolver;
    this.serviceRestartPromptResolver = undefined;
    resolve?.(action);
  }

  public resetState(releasePorts: boolean = true): void {
    this.isStarted = false;
    this.isStarting = false;
    this.httpAvailable = false;
    this.apiClient = undefined;
    this.translationConnection = undefined;
    this.openCodeCliMajor = undefined;
    if (this.openCodeMajorRetryTimer) {
      clearTimeout(this.openCodeMajorRetryTimer);
      this.openCodeMajorRetryTimer = null;
    }
    if (releasePorts && this.session) {
      this.portManager.releaseTerminalPorts(this.session.instanceId);
    }
    this.session = undefined;
  }

  public disposeListeners(): void {
    if (this.dataListener) {
      this.dataListener.dispose();
      this.dataListener = undefined;
    }
    if (this.exitListener) {
      this.exitListener.dispose();
      this.exitListener = undefined;
    }
  }

  public reconnectListeners(): void {
    this.disposeListeners();

    this.dataListener = this.terminalManager.onData((event) => {
      const session = this.findSessionByTerminalKey(event.id);
      if (!session) {
        return;
      }
      this.callbacks.postMessage({
        type: "terminalOutput",
        data: event.data,
      });
    });

    this.exitListener = this.terminalManager.onExit((id) => {
      const session = this.findSessionByTerminalKey(id);
      if (!session) {
        return;
      }

      this.resetState();
      this.callbacks.postMessage({
        type: "terminalExited",
      });
    });
  }

  public async pollForHttpReadiness(): Promise<void> {
    if (!this.apiClient) {
      return;
    }

    // Outer-retry-only window sized for real OpenCode startup latency.
    // Previous value (10 attempts * 200 ms = 2 s) was far too short, and the
    // inner exponential backoff inside healthCheck() amplified each failed
    // outer attempt to ~100 s while logging nothing — leaving auto-context
    // permanently stuck. We now call healthCheckOnce() (no inner retry) and
    // surface every failure so the operator can see what is happening.
    const maxRetries = 30;
    const delayMs = 500;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const isHealthy = await this.apiClient.healthCheckOnce();
        if (isHealthy) {
          this.httpAvailable = true;
          this.logger.info("[TerminalProvider] HTTP API is ready");
          return;
        }
        this.logger.info(
          `[TerminalProvider] Health check attempt ${attempt}/${maxRetries} returned unhealthy`,
        );
      } catch (error) {
        this.logger.info(
          `[TerminalProvider] Health check attempt ${attempt}/${maxRetries} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (attempt < maxRetries) {
        await this.sleep(delayMs);
      }
    }

    this.logger.info(
      "[TerminalProvider] HTTP API not available after retries, using message passing fallback",
    );
    this.httpAvailable = false;
  }

  public sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  public resolveStartupWorkspacePath(): StartupWorkspaceResolution {
    const instanceWorkspacePath = this.resolveWorkspacePathFromActiveInstance();
    if (instanceWorkspacePath) {
      return { workspacePath: instanceWorkspacePath, isWorkspaceScoped: true };
    }

    const workspaceFolderPath =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceFolderPath) {
      return { workspacePath: workspaceFolderPath, isWorkspaceScoped: true };
    }

    return { workspacePath: os.homedir(), isWorkspaceScoped: false };
  }

  public resolveWorkspacePathFromActiveInstance(): string | undefined {
    if (!this.instanceStore) {
      return undefined;
    }

    const record = this.instanceStore.get(this.activeInstanceId);
    const workspaceUri = record?.config.workspaceUri;
    if (!workspaceUri) {
      return undefined;
    }

    try {
      const parsed = vscode.Uri.parse(workspaceUri);
      return parsed.fsPath || undefined;
    } catch {
      return undefined;
    }
  }

  public resolveInstanceIdFromSessionId(sessionId: string): InstanceId {
    if (!this.instanceStore) {
      return this.activeInstanceId;
    }

    if (this.instanceStore.get(sessionId)) {
      return sessionId;
    }

    return this.activeInstanceId;
  }

  public formatDroppedFiles(
    paths: string[],
    options: { useAtSyntax: boolean },
  ): string {
    return this.opencodeOperator.formatDroppedFiles(paths, options);
  }

  public formatFileReference(reference: OpenCodeFileReference): string {
    return this.opencodeOperator.formatFileReference(reference);
  }

  public formatPastedImage(tempPath: string): string | undefined {
    return this.opencodeOperator.formatPastedImage(tempPath);
  }

  public subscribeToActiveInstanceChanges(): void {
    if (!this.instanceStore) {
      return;
    }

    try {
      this.activeInstanceId = this.instanceStore.getActive().config.id;
    } catch {
      // intentionally empty: no active instance is fine during init
    }

    this.activeInstanceSubscription = this.instanceStore.onDidSetActive(
      (id) => {
        this.callbacks.onActiveInstanceChanged(id);
      },
    );
  }

  private syncActiveInstance(instanceId: InstanceId): void {
    if (!this.instanceStore) {
      return;
    }
    try {
      const currentActive = this.instanceStore.getActive().config.id;
      if (currentActive !== instanceId) {
        this.instanceStore.setActive(instanceId);
      }
    } catch {
      // intentionally empty: getActive() may throw if instance removed
    }
  }

  /**
   * CLI major for the keymap flag, from `--version` output only.
   */
  private async resolveOpenCodeMajorForKeymap(
    command: string,
  ): Promise<number | undefined> {
    const major = await detectOpenCodeMajorVersion(command);
    this.logger.info(
      `[SessionRuntime] keymap major: command=${JSON.stringify(command)} resolved=${major ?? "(none)"}`,
    );
    return major;
  }

  /**
   * Delayed re-resolution of the CLI major after the session is up (the
   * v2 TUI starts its background service lazily, so the service file may
   * only appear after launch). Re-notifies the webview on a change.
   */
  private scheduleOpenCodeMajorRetry(command: string, attempt = 0): void {
    if (this.openCodeMajorRetryTimer) {
      clearTimeout(this.openCodeMajorRetryTimer);
    }
    this.openCodeMajorRetryTimer = setTimeout(
      () => {
        this.openCodeMajorRetryTimer = null;
        if (!this.isStarted) {
          return;
        }
        void this.resolveOpenCodeMajorForKeymap(command).then((major) => {
          if (major === undefined) {
            if (attempt < 1) {
              this.scheduleOpenCodeMajorRetry(command, attempt + 1);
            }
            return;
          }
          const changed = this.openCodeCliMajor !== major;
          this.openCodeCliMajor = major;
          if (changed) {
            this.notifyActiveSession();
          }
          // Late v2 confirmation: attach the HTTP client now that the
          // background service exists (the launch-time probes ran before
          // the TUI had started it).
          if (major >= 2 && !this.apiClient) {
            void resolveOpenCodeV2Service(command).then((service) => {
              if (!service || this.apiClient || !this.isStarted) {
                return;
              }
              this.apiClient = OpenCodeApiClient.fromV2Service(service, {
                maxRetries: 10,
                baseDelay: 200,
                timeoutMs: 5000,
                directory: this.resolveStartupWorkspacePath().workspacePath,
              });
              this.translationConnection = {
                protocol: "v2",
                baseUrl: service.url,
                password: service.password,
                directory: this.resolveStartupWorkspacePath().workspacePath,
              };
              void this.pollForHttpReadiness();
            });
          }
        });
      },
      attempt === 0 ? 3000 : 8000,
    );
  }

  /**
   * True when the resolved OpenCode CLI major is >= 2.
   */
  public isOpenCodeV2Active(): boolean {
    return (this.openCodeCliMajor ?? 0) >= 2;
  }

  private notifyActiveSession(): void {
    this.callbacks.postMessage({
      type: "activeSession",
      backend: "native",
      openCodeV2: this.isOpenCodeV2Active(),
      hasOhMyOpenCodeSlim: isOhMyOpenCodeSlimAvailable(),
    });
  }

  public dispose(): void {
    this.disposeListeners();
    this.serviceRestartPromptResolver?.("cancel");
    this.serviceRestartPromptResolver = undefined;
    if (this.openCodeMajorRetryTimer) {
      clearTimeout(this.openCodeMajorRetryTimer);
      this.openCodeMajorRetryTimer = null;
    }
    this.activeInstanceSubscription?.dispose();
    this.activeInstanceSubscription = undefined;
    if (this.session) {
      this.terminalManager.killByInstance(this.session.instanceId);
      this.terminalManager.killTerminal(this.session.terminalKey);
      this.portManager.releaseTerminalPorts(this.session.instanceId);
    }
    this.session = undefined;
    // Stop our editor-context WS server and clean up its lock file. Async but
    // fire-and-forget: extension deactivation has a short window.
    void this.ideContextServer?.stop();
  }

  private async startEditorContextWs(): Promise<void> {
    if (!this.ideContextServer) {
      return;
    }
    const folders =
      vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
    if (folders.length === 0) {
      this.logger.warn(
        "[TerminalProvider] Editor context WS not started: no workspace folders",
      );
      return;
    }
    try {
      const result = await this.ideContextServer.start(folders);
      if (result.started) {
        this.logger.info(
          `[TerminalProvider] Editor context WS on port ${result.port} (${result.reason})`,
        );
      } else {
        this.logger.info(
          `[TerminalProvider] Editor context WS deferred: ${result.reason}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `[TerminalProvider] Failed to start editor context WS: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private destroyActiveSession(): void {
    if (!this.session) {
      return;
    }

    this.terminalManager.killByInstance(this.session.instanceId);
    this.terminalManager.killTerminal(this.session.terminalKey);
    this.portManager.releaseTerminalPorts(this.session.instanceId);
    this.session = undefined;

    this.disposeListeners();
    this.isStarted = false;
    this.isStarting = false;
    this.httpAvailable = false;
    this.apiClient = undefined;
    this.translationConnection = undefined;
    this.activeLaunchCommand = undefined;
  }

  private findSessionByTerminalKey(terminalKey: string): SessionState | undefined {
    if (this.session?.terminalKey === terminalKey) {
      return this.session;
    }
    return undefined;
  }

  private resolveTerminalIdForInstance(instanceId: InstanceId): string {
    if (!this.instanceStore) {
      return instanceId;
    }

    try {
      return (
        this.instanceStore.get(instanceId)?.runtime.terminalKey ?? instanceId
      );
    } catch {
      return instanceId;
    }
  }

  /**
   * Builds the OpenCode launch command from the `opencode.commandPath`,
   * `opencode.args`, and `opencode.continueLastSession` settings,
   * e.g. `"opencode -c"`.
   */
  private resolveOpenCodeLaunchCommand(
    config = vscode.workspace.getConfiguration("opencode-cli-sidebar"),
  ): string {
    return this.opencodeOperator.getLaunchCommand({
      commandPath: config.get<string>("opencode.commandPath", "opencode"),
      args: config.get<string[]>("opencode.args", []),
      continueLastSession: config.get<boolean>(
        "opencode.continueLastSession",
        true,
      ),
    });
  }

  /**
   * Launch command pinned at session start; falls back to the current
   * settings when no session has been started yet.
   */
  private resolveActiveLaunchCommand(): string {
    return this.activeLaunchCommand ?? this.resolveOpenCodeLaunchCommand();
  }
}
