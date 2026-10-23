import * as vscode from "vscode";
import { l10n } from "../i18n";
import { TerminalProvider } from "../providers/TerminalProvider";
import { OpenCodeCodeActionProvider } from "../providers/CodeActionProvider";
import { TerminalManager } from "../terminals/TerminalManager";
import { OutputCaptureManager } from "../services/OutputCaptureManager";
import { ContextSharingService } from "../services/ContextSharingService";
import { ContextManager } from "../services/ContextManager";
import { OutputChannelService } from "../services/OutputChannelService";
import { SettingsMigrationService } from "../services/SettingsMigrationService";
import { OpenCodeCliSettingsService } from "../services/OpenCodeCliSettingsService";
import { setOpenCodeCliCompatDiagnostics } from "../services/OpenCodeCliCompat";
import { InstanceDiscoveryService } from "../services/InstanceDiscoveryService";
import { OpenCodeApiClient } from "../services/OpenCodeApiClient";
import { InstanceStore } from "../services/InstanceStore";
import { InstanceRegistry } from "../services/InstanceRegistry";
import { InstanceQuickPick } from "../services/InstanceQuickPick";
import { InstanceController } from "../services/InstanceController";
import { NativeTerminalManager } from "../services/NativeTerminalManager";
import {
  getOpenCodeUpdateConfig,
  OpenCodeUpdateService,
} from "../services/OpenCodeUpdateService";
import { OpenCodeChangelogService } from "../services/OpenCodeChangelogService";
import { ConfigSyncService } from "../services/sync/ConfigSyncService";
import { setActiveConfigSyncService } from "../services/sync/syncServiceRegistry";
import { IdeContextServer } from "../services/ideContext/IdeContextServer";
import { PortManager } from "../services/PortManager";
import { ConnectionResolver } from "../services/ConnectionResolver";
import {
  TerminalBackendRegistry,
} from "../services/terminalBackends";
import {
  registerCommands as registerAllCommands,
  type RegisterCommandDependencies,
} from "./commands";

/**
 * SecretStorage key used as a cross-window update signal bus:
 * SecretStorage.onDidChange fires in every window of the same profile,
 * and storing the identical value twice fires nothing, so the payload
 * carries a timestamp.
 */
const UPDATE_SYNC_SECRET_KEY = "opencode-cli-sidebar.updateSync";

/**
 * Manages extension activation, service initialization, and cleanup.
 */
export class ExtensionLifecycle {
  private terminalManager: TerminalManager | undefined;
  private tuiProvider: TerminalProvider | undefined;
  private captureManager: OutputCaptureManager | undefined;
  private contextSharingService: ContextSharingService | undefined;
  private outputChannelService: OutputChannelService | undefined;
  private contextManager: ContextManager | undefined;
  private instanceDiscoveryService: InstanceDiscoveryService | undefined;
  private codeActionProvider: OpenCodeCodeActionProvider | undefined;
  private instanceStore: InstanceStore | undefined;
  private instanceRegistry: InstanceRegistry | undefined;
  private instanceQuickPick: InstanceQuickPick | undefined;
  private instanceController: InstanceController | undefined;
  private portManager: PortManager | undefined;
  private backendRegistry: TerminalBackendRegistry | undefined;
  private ideContextServer: IdeContextServer | undefined;
  private opencodeUpdateService: OpenCodeUpdateService | undefined;
  private configSyncService: ConfigSyncService | undefined;
  private activated = false;
  private tuiProviderRegistration: vscode.Disposable | undefined;
  private context?: vscode.ExtensionContext;

  // Current default terminal ID. SessionRuntime.LEGACY_TERMINAL_ID keeps the
  // pre-rename value ("ai-sidebar-terminal-main") for legacy lookups only;
  // the two constants are intentionally no longer the same.
  private static readonly TERMINAL_ID = "opencode-cli-sidebar-main";

  /** Returns the terminal ID for the active instance, falling back to the static default. */
  private getActiveTerminalId(): string {
    try {
      const active = this.instanceStore?.getActive();
      if (active?.runtime.terminalKey) {
        this.outputChannelService?.info(
          `[DIAG:getActiveTerminalId] resolved terminalKey="${active.runtime.terminalKey}" for instance="${active.config.id}"`,
        );
        return active.runtime.terminalKey;
      }
      if (active) {
        this.outputChannelService?.warn(
          `[DIAG:getActiveTerminalId] NO terminalKey for instance="${active.config.id}", falling back to config.id="${active.config.id}"`,
        );
        return active.config.id;
      }
      this.outputChannelService?.warn(
        `[DIAG:getActiveTerminalId] NO active instance, falling back to TERMINAL_ID="${ExtensionLifecycle.TERMINAL_ID}"`,
      );
      return ExtensionLifecycle.TERMINAL_ID;
    } catch (err) {
      this.outputChannelService?.error(
        `[DIAG:getActiveTerminalId] ERROR: ${err instanceof Error ? err.message : String(err)}`,
      );
      return ExtensionLifecycle.TERMINAL_ID;
    }
  }

  async activate(context: vscode.ExtensionContext): Promise<void> {
    this.context = context;
    const logger = OutputChannelService.getInstance();
    if (this.activated) {
      logger.warn(
        "[ExtensionLifecycle] activate() called while already active - skipping to prevent double provider registration",
      );
      return;
    }
    this.activated = true;
    logger.info("Initializing OpenCode CLI Sidebar...");

    // One-time silent migration of legacy ai-sidebar-terminal settings to
    // the current prefix. Runs before anything reads configuration so
    // freshly migrated values are honored immediately. Failures never
    // block activation.
    try {
      await new SettingsMigrationService(context.globalState, {
        logger,
      }).migrate();
    } catch (error) {
      logger.warn(
        `[ExtensionLifecycle] Legacy settings migration failed and was skipped: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // Keep OpenCode's TUI on its terminal-palette theme while the VS Code
    // setting is enabled. This intentionally overrides a local OpenCode theme
    // choice; users can disable the setting to manage the theme themselves.
    const followVsCodeTheme = (): boolean =>
      vscode.workspace
        .getConfiguration("opencode-cli-sidebar")
        .get<boolean>("followVsCodeTheme", true);
    const applyFollowVsCodeTheme = async (): Promise<void> => {
      if (!followVsCodeTheme()) {
        return;
      }
      try {
        const changed = await new OpenCodeCliSettingsService(
          logger,
        ).applyVsCodeTheme();
        if (changed) {
          logger.info(
            "[ExtensionLifecycle] OpenCode theme set to system to follow VS Code",
          );
        }
      } catch (error) {
        logger.warn(
          `[ExtensionLifecycle] Could not apply the VS Code theme to OpenCode: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    };
    await applyFollowVsCodeTheme();
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration(
            "opencode-cli-sidebar.followVsCodeTheme",
          )
        ) {
          void applyFollowVsCodeTheme();
        }
      }),
    );

    setOpenCodeCliCompatDiagnostics((level, message) => {
      if (level === "warn") {
        logger.warn(message);
      } else {
        logger.info(message);
      }
    });

    // One-time setup on fresh install: auto-enable sendKeybindingsToShell
    // so Ctrl+P / Ctrl+other keys go to the sidebar opencode terminal immediately.
    await this.ensureSendKeybindingsToShellDefault();

    try {
      this.terminalManager = new TerminalManager();

      this.captureManager = new OutputCaptureManager();
      this.contextSharingService = new ContextSharingService();
      this.outputChannelService = logger;
      this.contextManager = new ContextManager(this.outputChannelService);
      this.instanceDiscoveryService = new InstanceDiscoveryService();

      this.instanceStore = new InstanceStore();
      this.portManager = PortManager.getInstance(this.instanceStore);

      this.backendRegistry = new TerminalBackendRegistry();
      const nativeTerminalManager = new NativeTerminalManager(logger);
      const ideContextServer = new IdeContextServer(logger, {
        serverName: "opencode-cli-sidebar",
        serverVersion: context.extension.packageJSON?.version ?? "0.0.0",
      });
      this.ideContextServer = ideContextServer;
      // Wire editor events -> IDE context WS so OpenCode TUI sees live
      // selection/tab changes in its prompt input area.
      this.contextManager.setIdeContextServer(ideContextServer);
      this.instanceRegistry = new InstanceRegistry(context);
      this.instanceRegistry.hydrate(this.instanceStore);

      this.opencodeUpdateService = new OpenCodeUpdateService(
        context.globalState,
        { logger },
      );
      context.subscriptions.push(this.opencodeUpdateService);
      // Cross-window sync, write side: this window's update flow
      // succeeded, so announce the fresh version to every window of this
      // profile via SecretStorage. The timestamp defeats SecretStorage's
      // identical-value dedupe so each success re-fires onDidChange.
      context.subscriptions.push(
        this.opencodeUpdateService.onDidChangeStatus((event) => {
          if (event.state !== "updateSucceeded" || !event.installedVersion) {
            return;
          }
          void context.secrets
            .store(
              UPDATE_SYNC_SECRET_KEY,
              JSON.stringify({
                version: event.installedVersion,
                at: Date.now(),
              }),
            )
            .then(undefined, (error) => {
              logger.debug(
                `[ExtensionLifecycle] failed to publish the OpenCode version sync signal: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            });
        }),
      );
      // Cross-window sync, read side: another window announced a fresh
      // version. The provider may not exist yet during activation; the
      // optional chain makes that a no-op, and the provider's own state
      // guard no-ops the originating window's echo of its own signal.
      context.subscriptions.push(
        context.secrets.onDidChange(async (event) => {
          if (event.key !== UPDATE_SYNC_SECRET_KEY) {
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(
              (await context.secrets.get(UPDATE_SYNC_SECRET_KEY)) ?? "",
            );
          } catch {
            parsed = undefined;
          }
          // Valid JSON is not necessarily a payload object: "null",
          // numbers, and arrays must all be ignored, not thrown on.
          if (parsed === null || typeof parsed !== "object") {
            logger.debug(
              "[ExtensionLifecycle] ignored a malformed OpenCode version sync signal",
            );
            return;
          }
          const { version, at: rawAt } = parsed as {
            version?: unknown;
            at?: unknown;
          };
          // Validate before advancing the dedupe watermark: a signal
          // without a usable version must not swallow a later valid one.
          if (typeof version !== "string" || !version) {
            return;
          }
          const at = typeof rawAt === "number" ? rawAt : 0;
          if (at <= this.lastSyncSignalAt) {
            return;
          }
          this.lastSyncSignalAt = at;
          void this.tuiProvider?.syncOpenCodeVersionFromOtherWindow(version);
        }),
      );
      const openCodeChangelogService = new OpenCodeChangelogService(
        context.globalState,
        { logger },
      );

      context.subscriptions.push(this.contextManager);
      context.subscriptions.push(this.instanceDiscoveryService);
      this.instanceQuickPick = new InstanceQuickPick(
        this.instanceStore,
        this.instanceDiscoveryService,
      );

      const connectionResolver = new ConnectionResolver(
        this.instanceStore,
        this.instanceDiscoveryService,
        undefined,
        logger,
      );
      this.instanceController = new InstanceController(
        this.terminalManager,
        this.instanceStore,
        this.portManager,
        logger,
        connectionResolver,
      );

      context.subscriptions.push(
        vscode.window.onDidCloseTerminal((terminal) => {
          this.captureManager?.cleanup(terminal);
        }),
      );

      this.tuiProvider = new TerminalProvider(
        context,
        this.terminalManager,
        this.captureManager,
        this.portManager,
        this.instanceStore,
        this.backendRegistry,
        nativeTerminalManager,
        ideContextServer,
        this.opencodeUpdateService,
        openCodeChangelogService,
      );

      this.tuiProviderRegistration?.dispose();
      this.tuiProviderRegistration = undefined;
      try {
        const providerRegistration = vscode.window.registerWebviewViewProvider(
          TerminalProvider.viewType,
          this.tuiProvider,
          {
            webviewOptions: {
              retainContextWhenHidden: true,
            },
          },
        );
        this.tuiProviderRegistration = providerRegistration;
        context.subscriptions.push(providerRegistration);
      } catch (err) {
        if (
          err instanceof Error &&
          err.message.includes("already registered")
        ) {
          logger.warn(
            `[ExtensionLifecycle] ${TerminalProvider.viewType} provider already registered — prior activation still active. Terminal will attach on next view reveal.`,
          );
        } else {
          throw err;
        }
      }

      // WebDAV config sync: owns its own push channel mirroring the
      // openCodeUpdateStatus pattern — status deltas flow through
      // onDidChange, full replies go straight through postWebviewMessage.
      // TerminalProvider is not modified this iteration, so visibility is
      // probed through a narrow structural cast.
      this.configSyncService = new ConfigSyncService(context, {
        logger,
        postWebviewMessage: (message) =>
          this.tuiProvider?.postWebviewMessage(message),
        isWebviewVisible: () => {
          const provider = this.tuiProvider as unknown as {
            isWebviewVisible?: () => boolean;
          } | undefined;
          return provider?.isWebviewVisible?.() ?? true;
        },
      });
      context.subscriptions.push(this.configSyncService);
      setActiveConfigSyncService(this.configSyncService);
      context.subscriptions.push(
        this.configSyncService.onDidChange((delta) => {
          this.tuiProvider?.postWebviewMessage({
            type: "webdavSyncStatus",
            delta,
          });
        }),
      );
      this.configSyncService.initialize();

      this.registerCommands(context);

      // Local fast fill: a pure-local version probe puts the version on the
      // pill immediately, before the scheduled network check resolves.
      void this.tuiProvider?.refreshOpenCodeLocalVersion();

      // Fire-and-forget: offer to install the OpenCode CLI when it is
      // missing entirely. Never awaited so activation stays fast.
      void this.promptInstallIfCliMissing();

      this.scheduleOpenCodeUpdateChecks();

      this.codeActionProvider = new OpenCodeCodeActionProvider(
        this.contextManager,
        (prompt) => this.sendPromptToOpenCode(prompt),
      );

      const codeActionRegistration =
        vscode.languages.registerCodeActionsProvider(
          "*",
          this.codeActionProvider,
          {
            providedCodeActionKinds:
              OpenCodeCodeActionProvider.providedCodeActionKinds,
          },
        );
      const explainAndFixCommand = this.codeActionProvider.registerCommand();
      context.subscriptions.push(codeActionRegistration, explainAndFixCommand);

      // Expose that the extension is fully active so editor/title buttons
      // only appear after commands are registered. This prevents
      // "command not found" errors.
      await vscode.commands.executeCommand("setContext", "opencode-cli-sidebar.active", true);

      logger.info("OpenCode CLI Sidebar activated successfully");
    } catch (error) {
      logger.error(
        `Failed to activate OpenCode CLI Sidebar: ${error instanceof Error ? error.message : String(error)}`,
      );
      vscode.window.showErrorMessage(
        l10n.t("Failed to activate OpenCode CLI Sidebar: {error}", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  private getCommandDependencies(): RegisterCommandDependencies {
    const self = this;
    return {
      get provider() {
        return self.tuiProvider;
      },
      get terminalManager() {
        return self.terminalManager;
      },
      get contextSharingService() {
        return self.contextSharingService;
      },
      get contextManager() {
        return self.contextManager;
      },
      get outputChannel() {
        return self.outputChannelService;
      },
      get opencodeUpdateService() {
        return self.opencodeUpdateService;
      },
      get configSyncService() {
        return self.configSyncService;
      },
      getActiveTerminalId: () => this.getActiveTerminalId(),
      sendTerminalCwd: () => this.sendTerminalCwd(),
      sendPrompt: (prompt: string) =>
        this.tuiProvider?.sendPrompt(prompt) ?? Promise.resolve(),
    };
  }

  private registerCommands(context: vscode.ExtensionContext): void {
    registerAllCommands(context, this.getCommandDependencies());
  }

  // ── OpenCode update auto-check scheduling ──

  private updateCheckTimer: NodeJS.Timeout | undefined;

  // ── Cross-window OpenCode update sync ──

  /** Newest cross-window update sync signal timestamp already applied. */
  private lastSyncSignalAt = 0;

  // ── Missing-CLI install prompt ──

  /** True while an install or update flow owns the service state. */
  private isUpdateRunning(service: OpenCodeUpdateService): boolean {
    return service.status === "updating";
  }

  /**
   * Detects a missing OpenCode CLI after activation and surfaces the
   * install flow in the webview: the service enters the installable
   * state (arming the in-webview confirmation dialog), then the
   * sidebar view is revealed so the webview loads and receives the
   * state through the status handshake. Fire-and-forget: the probe
   * never delays activation, and the flow stays silent when the CLI
   * exists or an update flow is already running.
   */
  private async promptInstallIfCliMissing(): Promise<void> {
    const service = this.opencodeUpdateService;
    const context = this.context;
    if (!service || !context) {
      return;
    }
    if (this.isUpdateRunning(service)) {
      return;
    }

    let cliAvailable: boolean;
    try {
      cliAvailable = await service.probeCliAvailable();
    } catch (error) {
      this.outputChannelService?.warn(
        `[ExtensionLifecycle] OpenCode CLI availability probe failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    if (cliAvailable) {
      return;
    }
    // The probe took time; an install or update flow may have started
    // meanwhile and owns the state. A racing silent check ("checking" or
    // its "disabled" verdict) does not block: markCliMissing outranks it.
    if (this.isUpdateRunning(service)) {
      return;
    }

    // The pill needs the installable state; the confirmation dialog is
    // armed on every activation while the CLI is missing.
    service.markCliMissing(true);
    await this.tuiProvider?.revealSidebarView();
  }

  /**
   * Schedules silent update checks: an immediate activation check, then
   * self-rescheduling ticks spaced by
   * `update.checkIntervalHours`. Settings are re-read before each tick, so
   * disabling `update.autoCheck` stops the chain on the next boundary.
   */
  private scheduleOpenCodeUpdateChecks(): void {
    const config = getOpenCodeUpdateConfig();
    if (!config.autoCheck) {
      this.outputChannelService?.debug(
        "[ExtensionLifecycle] OpenCode update auto-check disabled by settings",
      );
      return;
    }
    this.scheduleNextOpenCodeUpdateCheck(0, true);
  }

  private scheduleNextOpenCodeUpdateCheck(
    delayMs: number,
    isActivationCheck: boolean,
  ): void {
    this.updateCheckTimer = setTimeout(() => {
      this.updateCheckTimer = undefined;
      void this.runSilentOpenCodeUpdateCheck(isActivationCheck).finally(() => {
        // A check in flight at deactivate() must not resurrect the chain.
        if (!this.activated) {
          return;
        }
        const config = getOpenCodeUpdateConfig();
        if (config.autoCheck) {
          this.scheduleNextOpenCodeUpdateCheck(
            Math.max(1, config.checkIntervalHours) * 3_600_000,
            false,
          );
        }
      });
    }, delayMs);
  }

  /**
   * Silent check for the scheduler: no notifications. The activation check
   * always runs; periodic ticks are skipped when a check ran recently
   * (across window reloads). Both are skipped while a flow is already
   * checking or updating.
   */
  private async runSilentOpenCodeUpdateCheck(
    isActivationCheck: boolean,
  ): Promise<void> {
    const service = this.opencodeUpdateService;
    if (!service) {
      return;
    }
    if (service.status === "checking" || service.status === "updating") {
      return;
    }
    // The interval-based skip applies to periodic ticks only; the
    // activation check always runs so a reload always refreshes the state.
    if (!isActivationCheck) {
      const intervalMs =
        Math.max(1, getOpenCodeUpdateConfig().checkIntervalHours) * 3_600_000;
      const lastCheckAt = service.getLastCheckAt();
      if (lastCheckAt !== undefined && Date.now() - lastCheckAt < intervalMs) {
        return;
      }
    }
    const result = await service.checkForUpdates({ manual: false });
    if (!result.ok && this.outputChannelService) {
      this.outputChannelService.debug(
        `[ExtensionLifecycle] silent OpenCode update check failed: ${
          result.error ?? "(unknown)"
        }`,
      );
    }
  }

  private async sendPromptToOpenCode(prompt: string): Promise<void> {
    if (!this.tuiProvider || !this.terminalManager) {
      throw new Error("OpenCode provider is not initialized");
    }

    if (!this.terminalManager.getTerminal(this.getActiveTerminalId())) {
      const sentByDiscovery =
        await this.trySendPromptViaDiscoveredInstance(prompt);
      if (sentByDiscovery) {
        return;
      }

      await this.tuiProvider.startOpenCode();
    }

    const apiClient = this.tuiProvider.getApiClient();
    if (apiClient && this.tuiProvider.isHttpAvailable()) {
      try {
        await apiClient.appendPrompt(prompt);
      } catch (error) {
        this.outputChannelService?.warn(
          `Failed to send prompt via HTTP API, falling back to terminal input: ${error instanceof Error ? error.message : String(error)}`,
        );
        this.terminalManager.writeToTerminal(
          this.getActiveTerminalId(),
          `${prompt}\n`,
        );
      }
    } else {
      this.terminalManager.writeToTerminal(
        this.getActiveTerminalId(),
        `${prompt}\n`,
      );
    }

    const config = vscode.workspace.getConfiguration("opencode-cli-sidebar");
    if (config.get<boolean>("autoFocusOnSend", true)) {
      vscode.commands.executeCommand("opencode-cli-sidebar.focus");
      setTimeout(() => {
        if (typeof this.tuiProvider?.focus === "function") {
          this.tuiProvider.focus();
        }
      }, 100);
    }
  }

  private async trySendPromptViaDiscoveredInstance(
    prompt: string,
  ): Promise<boolean> {
    if (!this.instanceDiscoveryService) {
      return false;
    }

    try {
      const discovered =
        await this.instanceDiscoveryService.discoverInstances();
      const primary = discovered[0];
      if (!primary) {
        return false;
      }

      const client = new OpenCodeApiClient(
        primary.port,
        3,
        200,
        3000,
        // OpenCode >=1.x requires x-opencode-directory on instance-scoped
        // routes like /tui/append-prompt. Fall back to workspace folder, or
        // omit (server uses its own cwd) when no folder is open.
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      );
      await client.appendPrompt(prompt);
      this.outputChannelService?.info(
        `Sent prompt via discovered OpenCode instance on port ${primary.port}`,
      );
      return true;
    } catch (error) {
      this.outputChannelService?.warn(
        `Failed to send prompt via discovered instance: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private sendTerminalCwd(): void {
    const activeTerminal = vscode.window.activeTerminal;
    if (!activeTerminal) {
      vscode.window.showWarningMessage(l10n.t("No active terminal"));
      return;
    }

    const cwd = activeTerminal.shellIntegration?.cwd?.fsPath;
    if (!cwd) {
      vscode.window.showWarningMessage(
        l10n.t(
          "Could not determine terminal working directory. Make sure shell integration is enabled.",
        ),
      );
      return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    const reference =
      workspaceFolders && workspaceFolders.length > 0
        ? `@${vscode.workspace.asRelativePath(cwd, false)}`
        : `@${cwd}`;

    this.terminalManager?.writeToTerminal(
      this.getActiveTerminalId(),
      reference + " ",
    );

    const config = vscode.workspace.getConfiguration("opencode-cli-sidebar");
    if (config.get<boolean>("autoFocusOnSend", true)) {
      vscode.commands.executeCommand("opencode-cli-sidebar.focus");
      setTimeout(() => {
        if (typeof this.tuiProvider?.focus === "function") {
          this.tuiProvider.focus();
        }
      }, 100);
    }
  }

  async deactivate(): Promise<void> {
    this.outputChannelService?.info("Deactivating OpenCode CLI Sidebar...");
    this.activated = false;

    if (this.updateCheckTimer) {
      clearTimeout(this.updateCheckTimer);
      this.updateCheckTimer = undefined;
    }

    if (this.tuiProviderRegistration) {
      this.tuiProviderRegistration.dispose();
      this.tuiProviderRegistration = undefined;
    }

    if (this.tuiProvider) {
      this.tuiProvider.dispose();
      this.tuiProvider = undefined;
    }

    if (this.terminalManager) {
      this.terminalManager.dispose();
      this.terminalManager = undefined;
    }

    // Stop our editor-context WS server and await lock-file cleanup so
    // stale entries don't confuse the next activation's detector.
    if (this.ideContextServer) {
      try {
        await this.ideContextServer.stop();
      } catch (error) {
        this.outputChannelService?.warn(
          `Failed to stop IDE context server: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.ideContextServer = undefined;
    }

    const logger = this.outputChannelService;

    if (this.outputChannelService) {
      setOpenCodeCliCompatDiagnostics(undefined);
      this.outputChannelService.dispose();
      this.outputChannelService = undefined;
      OutputChannelService.resetInstance();
    }

    if (this.contextManager) {
      this.contextManager.dispose();
      this.contextManager = undefined;
    }

    if (this.instanceDiscoveryService) {
      this.instanceDiscoveryService.dispose();
      this.instanceDiscoveryService = undefined;
    }

    if (this.instanceRegistry) {
      this.instanceRegistry.dispose();
      this.instanceRegistry = undefined;
    }

    if (this.instanceStore) {
      this.instanceStore = undefined;
    }

    this.opencodeUpdateService = undefined;

    // Disposal itself is owned by context.subscriptions (same as
    // opencodeUpdateService); deactivate only clears the registry entry
    // and the reference so commands stop resolving the torn-down service.
    if (this.configSyncService) {
      setActiveConfigSyncService(undefined);
      this.configSyncService = undefined;
    }

    this.codeActionProvider = undefined;

    this.captureManager = undefined;
    this.contextSharingService = undefined;

    // Clear the context key so editor/title buttons disappear cleanly
    try {
      await vscode.commands.executeCommand("setContext", "opencode-cli-sidebar.active", false);
    } catch {
      // intentionally empty: setContext during deactivation is best-effort
    }

    logger?.info("OpenCode CLI Sidebar deactivated");
  }

  /**
   * On first installation / activation, automatically enable
   * `sendKeybindingsToShell` so that Ctrl+P and other TUI shortcuts
   * work immediately in the sidebar terminal without the user having
   * to manually edit settings.
   */
  private async ensureSendKeybindingsToShellDefault(): Promise<void> {
    if (!this.context) return;

    const config = vscode.workspace.getConfiguration("opencode-cli-sidebar");
    const inspect = config.inspect<boolean>("sendKeybindingsToShell");

    const userHasExplicitValue =
      inspect?.globalValue !== undefined ||
      inspect?.workspaceValue !== undefined ||
      inspect?.workspaceFolderValue !== undefined;

    if (userHasExplicitValue) {
      return;
    }

    const alreadyAutoEnabled = this.context.globalState.get<boolean>(
      "opencode-cli-sidebar.hasAutoEnabledKeybindings",
      false,
    );

    if (alreadyAutoEnabled) {
      return;
    }

    try {
      await config.update(
        "sendKeybindingsToShell",
        true,
        vscode.ConfigurationTarget.Global,
      );
      await this.context.globalState.update(
        "opencode-cli-sidebar.hasAutoEnabledKeybindings",
        true,
      );

      this.outputChannelService?.info(
        "[ExtensionLifecycle] Automatically enabled 'sendKeybindingsToShell: true' on first install so Ctrl+P / TUI keys work in the sidebar terminal out of the box.",
      );
    } catch (err) {
      this.outputChannelService?.warn(
        `[ExtensionLifecycle] Failed to auto-enable sendKeybindingsToShell: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
