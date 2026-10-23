
import * as vscode from "vscode";
import { l10n } from "../i18n";
import { TerminalManager } from "../terminals/TerminalManager";
import { OutputCaptureManager } from "../services/OutputCaptureManager";
import { OpenCodeApiClient } from "../services/OpenCodeApiClient";
import { PortManager } from "../services/PortManager";
import { ContextSharingService } from "../services/ContextSharingService";
import { OutputChannelService } from "../services/OutputChannelService";
import {
  changelogPageUrl,
  OpenCodeChangelogService,
} from "../services/OpenCodeChangelogService";
import { DataThrottleService } from "../services/DataThrottleService";
import { InstanceId, InstanceStore } from "../services/InstanceStore";
import { isVersionNewer } from "../services/semver";
import {
  FocusIndicatorMode,
  HostMessage,
  OpenCodeUpdateStep,
  OpenCodeUpdateUiStatus,
  ServiceRestartPromptAction,
  TerminalBackendType,
  CliInstallPromptAction,
} from "../types";
import {
  OpenCodeFileReference,
  OpenCodeToolOperator,
} from "../services/aiTools/OpenCodeToolOperator";
import type { IdeContextServer } from "../services/ideContext/IdeContextServer";
import { MessageRouter, MessageRouterProviderBridge } from "./MessageRouter";
import { SessionRuntime, type ServiceRestartPolicy } from "./SessionRuntime";
import { toRelativeReference } from "./relativeReference";
import { renderTerminalHtml } from "../webview/terminal/html";
import { NativeTerminalManager } from "../services/NativeTerminalManager";
import { TerminalBackendRegistry } from "../services/terminalBackends";
import { OpenCodeKeymapService } from "../services/OpenCodeKeymapService";
import { OpenCodeCliSettingsService } from "../services/OpenCodeCliSettingsService";
import {
  OpenCodeUpdateService,
  type OpenCodeUpdateStatus,
} from "../services/OpenCodeUpdateService";
import { localizeKeymapItems } from "../services/aiTools/openCodeKeybindCatalog";
import {
  OPENCODE_CLI_SETTINGS_CATALOG,
  OPENCODE_CLI_SETTINGS_GROUPS,
} from "../services/aiTools/openCodeCliSettingsCatalog";

export class TerminalProvider
  implements vscode.WebviewViewProvider, vscode.WebviewPanelSerializer
{
  public static readonly viewType = "opencode-cli-sidebar-view";
  public static readonly panelViewType = "opencode-cli-sidebar.terminalEditor";

  private _view?: vscode.WebviewView;
  private _panel?: vscode.WebviewPanel;
  private readonly contextSharingService: ContextSharingService;
  private readonly logger = OutputChannelService.getInstance();
  private readonly opencodeOperator: OpenCodeToolOperator;
  private readonly sessionRuntime: SessionRuntime;
  private readonly messageRouter: MessageRouter;
  private readonly dataThrottleService: DataThrottleService;
  private readonly keymapService = new OpenCodeKeymapService();
  private readonly openCodeCliSettingsService = new OpenCodeCliSettingsService();
  private readonly pendingWebviewMessages: HostMessage[] = [];
  private pendingQueueablePostChecks = 0;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly opencodeUpdateService?: OpenCodeUpdateService;
  private readonly changelogService?: OpenCodeChangelogService;
  /** Current self-update UI snapshot; pushed in full on every change. */
  private updateUi: OpenCodeUpdateUiStatus = { state: "idle", step: "" };
  /** Completed update steps for the progress card and log drawer. */
  private updateUiHistory: Array<{ step: string; ok: boolean; label: string }> =
    [];
  private lastUpdateStep: OpenCodeUpdateStep = "";

  /** True while the current flow is a missing-CLI install, not an update. */
  private updateFlowFromInstall = false;
  /** True while a cross-window version sync probe is in flight. */
  private syncingVersionFromOtherWindow = false;
  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly terminalManager: TerminalManager,
    private readonly captureManager: OutputCaptureManager,
    private readonly portManager: PortManager = PortManager.getInstance(),
    private readonly instanceStore?: InstanceStore,
    private readonly backendRegistry: TerminalBackendRegistry = new TerminalBackendRegistry(),
    private readonly nativeTerminalManager?: NativeTerminalManager,
    private readonly ideContextServer?: IdeContextServer,
    opencodeUpdateService?: OpenCodeUpdateService,
    changelogService?: OpenCodeChangelogService,
  ) {
    this.contextSharingService = new ContextSharingService();
    this.opencodeOperator = new OpenCodeToolOperator();
    this.opencodeUpdateService = opencodeUpdateService;
    this.changelogService = changelogService;
    this.dataThrottleService = new DataThrottleService((batch) => {
      for (const item of batch) {
        this.postWebviewMessageNow({
          type: "terminalOutput",
          data: item.data,
        });
      }
    });

    this.sessionRuntime = new SessionRuntime(
      this.terminalManager,
      this.captureManager,
      undefined,
      this.portManager,
      this.backendRegistry,
      this.instanceStore,
      this.logger,
      this.contextSharingService,
      this.opencodeOperator,
      {
        postMessage: (message) => this.postWebviewMessage(message),
        onActiveInstanceChanged: (instanceId) => {
          void this.switchToInstance(instanceId);
        },
        requestStartOpenCode: () => this.startOpenCode(),
      },
      this.nativeTerminalManager,
      this.ideContextServer,
    );

    const routerBridge: MessageRouterProviderBridge = {
      startOpenCode: () => this.startOpenCode(),
      restart: () => this.restart(),
      answerServiceRestartPrompt: (action) =>
        this.answerServiceRestartPrompt(action),
      openSettings: () => this.openSettings(),
      openKeyboardShortcuts: () => this.openKeyboardShortcuts(),
      toggleEditorAttachment: () => this.toggleEditorAttachment(),
      pasteText: (text) => this.pasteText(text),
      getActiveInstanceId: () => this.getActiveInstanceId(),
      setLastKnownTerminalSize: (cols, rows) =>
        this.setLastKnownTerminalSize(cols, rows),
      getLastKnownTerminalSize: () => this.getLastKnownTerminalSize(),
      isStarted: () => this.isStarted(),
      resizeActiveTerminal: (cols, rows) =>
        this.resizeActiveTerminal(cols, rows),
      getActiveTerminalId: () => this.activeTerminalId,
      postWebviewMessage: (message) => this.postWebviewMessage(message),
      formatDroppedFiles: (paths, useAtSyntax) =>
        this.sessionRuntime.formatDroppedFiles(paths, { useAtSyntax }),
      formatPastedImage: (tempPath) =>
        this.sessionRuntime.formatPastedImage(tempPath),
      saveKeybind: (id, chords) => this.saveKeybind(id, chords),
      resetKeybind: (id) => this.resetKeybind(id),
      requestKeymapData: () => this.requestKeymapData(),
      requestOpenCodeCliSettingsData: () => this.requestOpenCodeCliSettingsData(),
      saveOpenCodeCliSetting: (path, value) => this.saveOpenCodeCliSetting(path, value),
      resetOpenCodeCliSetting: (path) => this.resetOpenCodeCliSetting(path),
      addOpenCodeCliPlugin: (packageName) => this.addOpenCodeCliPlugin(packageName),
      removeOpenCodeCliPlugin: (index) => this.removeOpenCodeCliPlugin(index),
      checkOpenCodeCliPluginUpdates: () => this.checkOpenCodeCliPluginUpdates(),
      updateOpenCodeCliPlugin: (index, version) =>
        this.updateOpenCodeCliPlugin(index, version),
      resendActiveSession: () => this.resendActiveSession(),
      requestOpenCodeUpdateStatus: () => this.requestOpenCodeUpdateStatus(),
      startOpenCodeUpdate: (method) => this.startOpenCodeUpdate(method),
      checkOpenCodeUpdates: () => this.checkOpenCodeUpdates(),
      abandonOpenCodeUpdate: () => this.abandonOpenCodeUpdate(),
      restartAfterUpdate: () => this.restartAfterUpdate(),
      dismissOpenCodeUpdate: () => this.dismissOpenCodeUpdate(),
      retryCliProbe: () => this.retryCliProbe(),
      answerCliInstallPrompt: (action) =>
        this.answerCliInstallPrompt(action),
      requestOpenCodeChangelog: () => this.requestOpenCodeChangelog(),
      sendChangelogToOpenCode: (text) =>
        this.sendPrompt(text, { asPaste: true }),
    };

    this.messageRouter = new MessageRouter(
      routerBridge,
      this.context,
      this.terminalManager,
      this.captureManager,
      this.getApiClient(),
      this.contextSharingService,
      this.logger,
      this.instanceStore,
    );

    // Self-update status drives the webview UI. Subscribed in the
    // constructor so events are never missed across webview reloads; pushes
    // before the webview exists are dropped and covered by the
    // requestOpenCodeUpdateStatus handshake.
    if (this.opencodeUpdateService) {
      this.disposables.push(
        this.opencodeUpdateService.onDidChangeStatus((event) => {
          this.handleUpdateServiceStatus(event);
        }),
      );
    }

    // Registered in the constructor so the listener is added exactly once even
    // when resolveWebviewView runs multiple times. Events fired before the
    // webview exists are dropped by postWebviewMessage, which is safe:
    // resolveWebviewView rebuilds the HTML from current settings and
    // explicitly re-posts the terminal config.
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration(
            "opencode-cli-sidebar.focusIndicatorMode",
          ) ||
          event.affectsConfiguration(
            "opencode-cli-sidebar.focusIndicatorBorderWidth",
          )
        ) {
          this.postTerminalConfig();
        }
      }),
    );
  }

  private get activeInstanceId(): InstanceId {
    return this.sessionRuntime.getActiveInstanceId();
  }

  private get activeTerminalId(): string {
    return this.sessionRuntime.getActiveTerminalId();
  }

  public get lastKnownCols(): number {
    return this.sessionRuntime.getLastKnownTerminalSize().cols;
  }

  public set lastKnownCols(cols: number) {
    const size = this.sessionRuntime.getLastKnownTerminalSize();
    this.sessionRuntime.setLastKnownTerminalSize(cols, size.rows);
  }

  public get lastKnownRows(): number {
    return this.sessionRuntime.getLastKnownTerminalSize().rows;
  }

  public set lastKnownRows(rows: number) {
    const size = this.sessionRuntime.getLastKnownTerminalSize();
    this.sessionRuntime.setLastKnownTerminalSize(size.cols, rows);
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void | Thenable<void> {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    const processAlive = this.sessionRuntime.hasLiveTerminalProcess();
    if (this.sessionRuntime.isStartedFlag() && !processAlive) {
      this.sessionRuntime.resetState();
    }

    webviewView.webview.onDidReceiveMessage((message) => {
      this.handleMessage(message);
    });

    if (processAlive) {
      this.sessionRuntime.reconnectListeners();
    }

    this.postTerminalConfig();
    this.postCurrentSessionState(webviewView.webview);
    this.flushPendingWebviewMessages(webviewView.webview);

    const config = vscode.workspace.getConfiguration("opencode-cli-sidebar");
    const autoStartOnOpen = config.get<boolean>("autoStartOnOpen", true);
    const visibilityListener = webviewView.onDidChangeVisibility(() => {
      if (!webviewView.visible) {
        return;
      }

      const hadPendingMessages =
        this.pendingWebviewMessages.length > 0 ||
        this.pendingQueueablePostChecks > 0;
      this.flushPendingWebviewMessages(webviewView.webview);
      if (!hadPendingMessages) {
        this.postWebviewVisible();
        this.postTerminalConfig();
      }

      if (autoStartOnOpen && !this.isStarted()) {
        if (this.getNativeRestoreRecord()) {
          void this.promptNativeRestore().then((restored) => {
            if (!restored) {
              void this.startOpenCode();
            }
          });
        } else {
          void this.startOpenCode();
        }
        visibilityListener.dispose();
      }
    });
    webviewView.onDidDispose(() => visibilityListener.dispose());

    if (autoStartOnOpen) {
      if (webviewView.visible) {
        if (!this.isStarted()) {
          if (this.getNativeRestoreRecord()) {
            void this.promptNativeRestore().then((restored) => {
              if (!restored) {
                void this.startOpenCode();
              }
            });
          } else {
            void this.startOpenCode();
          }
        }
      }
    } else if (webviewView.visible && !this.isStarted()) {
      void this.promptNativeRestore();
    }
  }

  public focus(): void {
    this._panel?.reveal(vscode.ViewColumn.Active);
    this.postWebviewMessage({
      type: "focusTerminal",
    });
  }

  public async toggleEditorAttachment(): Promise<void> {
    const currentPanel = this._panel;
    if (currentPanel) {
      this._panel = undefined;
      currentPanel.dispose();
      this.postTerminalConfig();
      await this.revealSidebarView();
      return;
    }

    this.openInEditorTab();
  }

  public async openInEditorTab(): Promise<void> {
    if (this._panel) {
      this._panel.reveal(vscode.ViewColumn.Active);
      this.focus();
      return;
    }

    const config = vscode.workspace.getConfiguration("opencode-cli-sidebar");

    if (config.get<boolean>("collapseSecondaryBarOnEditorOpen", true)) {
      await vscode.commands.executeCommand(
        "workbench.action.closeAuxiliaryBar",
      );
    }

    const panel = vscode.window.createWebviewPanel(
      TerminalProvider.panelViewType,
      l10n.t("OpenCode CLI Sidebar"),
      vscode.ViewColumn.Beside,
      this.getEditorPanelOptions(),
    );

    this.initializeEditorPanel(panel);

    await vscode.commands.executeCommand("workbench.action.lockEditorGroup");
  }

  public async deserializeWebviewPanel(
    webviewPanel: vscode.WebviewPanel,
    _state: unknown,
  ): Promise<void> {
    this.initializeEditorPanel(webviewPanel);
  }

  public formatFileReference(reference: OpenCodeFileReference): string {
    return this.sessionRuntime.formatFileReference(reference);
  }

  public formatUriReference(uri: vscode.Uri): string {
    return this.formatFileReference({
      path: toRelativeReference(uri),
    });
  }

  public formatEditorReference(editor: vscode.TextEditor): string {
    const relativePath = vscode.workspace.asRelativePath(
      editor.document.uri,
      false,
    );
    const selection = editor.selection;
    return this.formatFileReference({
      path: relativePath,
      selectionStart: selection.isEmpty ? undefined : selection.start.line + 1,
      selectionEnd: selection.isEmpty ? undefined : selection.end.line + 1,
    });
  }

  public pasteText(text: string): void {
    this.postWebviewMessage({
      type: "clipboardContent",
      text,
    });
  }

  public requestPaste(): void {
    this.postWebviewMessage({
      type: "requestPaste",
    });
  }

  public getApiClient(): OpenCodeApiClient | undefined {
    return this.sessionRuntime.getApiClient();
  }

  public isHttpAvailable(): boolean {
    return this.sessionRuntime.isHttpAvailable();
  }

  public async startOpenCode(): Promise<void> {
    await this.sessionRuntime.startOpenCode();
  }

  public restart(serviceRestart: ServiceRestartPolicy = "prompt"): void {
    this.sessionRuntime.restart(serviceRestart);
  }

  /** Forwards the webview's service-restart prompt answer to the session runtime. */
  public answerServiceRestartPrompt(action: ServiceRestartPromptAction): void {
    this.sessionRuntime.answerServiceRestartPrompt(action);
  }

  public openSettings(): void {
    vscode.commands.executeCommand("workbench.action.openSettings", "opencode-cli-sidebar.");
  }

  public openKeyboardShortcuts(): void {
    vscode.commands.executeCommand(
      "workbench.action.openGlobalKeybindings",
      "@ext:sagez.opencode-cli-sidebar",
    );
  }

  /** Load OpenCode keymap data and send it to the webview. */
  public async requestKeymapData(): Promise<void> {
    try {
      const payload = await this.keymapService.load();
      this.postWebviewMessage({
        type: "keymapData",
        items: localizeKeymapItems(payload.items),
        overrides: payload.overrides,
        configPath: payload.configPath,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[TerminalProvider] keymap load failed: ${message}`);
      this.postWebviewMessage({
        type: "keymapError",
        error: message,
      });
    }
  }

  public async saveKeybind(id: string, chords: string[]): Promise<void> {
    try {
      await this.keymapService.save(id, chords);
      this.postWebviewMessage({ type: "keymapSaveResult", ok: true, id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[TerminalProvider] keymap save failed: ${message}`);
      this.postWebviewMessage({
        type: "keymapSaveResult",
        ok: false,
        id,
        error: message,
      });
    }
    // Always refresh so the webview's optimistic override matches the file.
    await this.requestKeymapData();
  }

  public async resetKeybind(id: string): Promise<void> {
    try {
      await this.keymapService.reset(id);
      this.postWebviewMessage({ type: "keymapSaveResult", ok: true, id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[TerminalProvider] keymap reset failed: ${message}`);
      this.postWebviewMessage({
        type: "keymapSaveResult",
        ok: false,
        id,
        error: message,
      });
    }
    await this.requestKeymapData();
  }

  public async requestOpenCodeCliSettingsData(): Promise<void> {
    try {
      const payload = await this.openCodeCliSettingsService.load(
        this.resolveProjectDir(),
      );
      this.postWebviewMessage({
        type: "openCodeCliSettingsData",
        items: [...OPENCODE_CLI_SETTINGS_CATALOG],
        groups: [...OPENCODE_CLI_SETTINGS_GROUPS],
        values: payload.values,
        overrides: payload.overrides,
        configPath: payload.configPath,
        themeOptions: payload.themeOptions,
        plugins: payload.plugins,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `[TerminalProvider] openCode settings load failed: ${message}`,
      );
      this.postWebviewMessage({
        type: "openCodeCliSettingsError",
        error: message,
      });
    }
  }

  public async addOpenCodeCliPlugin(packageName: string): Promise<void> {
    try {
      await this.openCodeCliSettingsService.addPlugin(packageName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `[TerminalProvider] openCode plugin add failed: ${message}`,
      );
      this.postWebviewMessage({
        type: "openCodeCliSettingsSaveResult",
        ok: false,
        path: "plugins",
        error: message,
      });
    }
    await this.requestOpenCodeCliSettingsData();
  }

  public async removeOpenCodeCliPlugin(index: number): Promise<void> {
    try {
      await this.openCodeCliSettingsService.removePlugin(index);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `[TerminalProvider] openCode plugin remove failed: ${message}`,
      );
      this.postWebviewMessage({
        type: "openCodeCliSettingsSaveResult",
        ok: false,
        path: "plugins",
        error: message,
      });
    }
    await this.requestOpenCodeCliSettingsData();
  }

  public async checkOpenCodeCliPluginUpdates(): Promise<void> {
    try {
      const results = await this.openCodeCliSettingsService.checkPluginUpdates();
      this.postWebviewMessage({
        type: "openCodeCliPluginUpdateCheckResult",
        ok: true,
        results,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `[TerminalProvider] openCode plugin update check failed: ${message}`,
      );
      this.postWebviewMessage({
        type: "openCodeCliPluginUpdateCheckResult",
        ok: false,
        error: message,
      });
    }
  }

  // ── OpenCode self-update UI bridge ──

  /** Replies with the current update-UI snapshot (late webview catch-up). */
  public async requestOpenCodeUpdateStatus(): Promise<void> {
    this.postUpdateUiStatus(this.currentUpdateUiSnapshot());
    // A late-arriving webview may have missed the method enrichment
    // (e.g. the webview reloaded): fill the gap; enrichment is cached
    // and only pushes while still available, so it cannot reopen UI.
    if (
      this.updateUi.state === "available" &&
      !(this.updateUi.methods && this.updateUi.methods.length)
    ) {
      void this.enrichUpdateMethods();
    }
  }

  /**
   * Local-only version probe at startup: shows the version pill before the
   * scheduled network check resolves. Skipped when the flow has already
   * moved past idle so it can never clobber a real check result.
   */
  public async refreshOpenCodeLocalVersion(): Promise<void> {
    const version = await this.opencodeUpdateService?.probeLocalVersion();
    if (!version || this.updateUi.state !== "idle") return;
    this.updateUi = {
      ...this.updateUi,
      installedVersion: version,
      currentVersion: version,
    };
    this.postUpdateUiStatus(this.currentUpdateUiSnapshot());
  }

  /**
   * Cross-window version sync: another window finished an OpenCode
   * self-update, so this window's pill may be stale. Silent by design —
   * no notices, no popover, only the corrected versions. An in-flight
   * flow (updating) or this window's own success card owns the UI and
   * wins; an installable state means the other window installed the CLI,
   * which is the re-detect flow's job to resolve. The originating window
   * also receives its own signal: its success state guard makes that a
   * no-op.
   */
  public async syncOpenCodeVersionFromOtherWindow(
    expectedVersion?: string,
  ): Promise<void> {
    if (!this.opencodeUpdateService) {
      return;
    }
    if (
      this.updateUi.state === "updating" ||
      this.updateUi.state === "success"
    ) {
      return;
    }
    if (this.updateUi.state === "installable") {
      await this.retryCliProbe();
      return;
    }
    if (this.syncingVersionFromOtherWindow) {
      return;
    }
    this.syncingVersionFromOtherWindow = true;
    try {
      const version = await this.opencodeUpdateService.probeLocalVersion(true);
      if (!version) {
        this.logger.debug(
          `[TerminalProvider] cross-window sync could not re-probe the OpenCode version (expected ${
            expectedVersion ?? "(unknown)"
          })`,
        );
        return;
      }
      const previousState = this.updateUi.state;
      const stillOutdated =
        previousState === "available" &&
        !!this.updateUi.latestVersion &&
        isVersionNewer(this.updateUi.latestVersion, version);
      // Explicit empties when settling idle: the webview merge keeps
      // stale values for absent keys, so failed-flow leftovers must be
      // cleared here. latestVersion is kept for tooltips.
      const settlesIdle =
        !stillOutdated &&
        (previousState === "available" || previousState === "failed");
      this.updateUi = {
        ...this.updateUi,
        installedVersion: version,
        currentVersion: version,
        ...(settlesIdle && {
          state: "idle" as const,
          step: "",
          detail: "",
          manualCommands: [],
          remediationCommands: [],
          notice: undefined,
        }),
      };
      this.postUpdateUiStatus(this.currentUpdateUiSnapshot());
      this.logger.info(
        `[TerminalProvider] OpenCode version re-synced from another window: ${version}`,
      );
    } finally {
      this.syncingVersionFromOtherWindow = false;
    }
  }

  /**
   * Install confirmation "Re-detect": re-probes the CLI after a manual
   * external install. On success this resets the UI so the local-version
   * refresh can repopulate the pill; the session start is driven by the
   * installable-to-idle transition in handleUpdateServiceStatus, not by
   * a tail call here (a tail call would double-start whenever the start
   * outruns the version probe).
   * On failure the service's installable event already drove the
   * push (prompt flag cleared, dialog stays a webview-local concern).
   */
  public async retryCliProbe(): Promise<void> {
    if (!this.opencodeUpdateService) {
      return;
    }
    const available = await this.opencodeUpdateService.recheckCliAvailable();
    if (!available) {
      return;
    }
    this.updateUiHistory = [];
    this.lastUpdateStep = "";
    this.updateFlowFromInstall = false;
    this.updateUi = {
      state: "idle",
      step: "",
      detail: "",
      manualCommands: [],
      remediationCommands: [],
      sessionAutoStarted: undefined,
    };
    this.postUpdateUiStatus(this.currentUpdateUiSnapshot());
    await this.refreshOpenCodeLocalVersion();
  }

  public async startOpenCodeUpdate(method: string): Promise<void> {
    if (!this.opencodeUpdateService) {
      return;
    }
    // Route on the UI truth: during the checking window the webview still
    // shows the entry that was clicked (installable keeps the install
    // pill) while the service already reports "checking". The service
    // waits out its in-flight check, so both flows survive the window.
    const result =
      this.updateUi.state === "installable"
        ? await this.opencodeUpdateService.startInstall(method)
        : await this.opencodeUpdateService.startUpdate(method);
    if (!result.ok) {
      this.logger.warn(
        `[TerminalProvider] OpenCode update did not complete: ${
          result.error ?? "(unknown)"
        }`,
      );
      // A failure already drives its own card through the status event;
      // guard rejections (no flow started) surface as a transient hint so
      // the click is never silently dropped.
      const cardAlreadyShowing =
        this.updateUi.state === "updating" ||
        this.updateUi.state === "success" ||
        this.updateUi.state === "failed";
      if (!cardAlreadyShowing) {
        this.postWebviewMessage({
          type: "openCodeUpdateStatus",
          status: {
            ...this.currentUpdateUiSnapshot(),
            notice: l10n.t('Could not start the OpenCode install. Try again.'),
          },
        });
      }
    }
  }

  /**
   * Manual check from the settings dropdown. Success states arrive through
   * the status subscription (marked manual so the up-to-date notice card
   * shows); only failures need an explicit notice here.
   */
  public async checkOpenCodeUpdates(): Promise<void> {
    if (!this.opencodeUpdateService) {
      return;
    }
    const result = await this.opencodeUpdateService.checkForUpdates({
      manual: true,
    });
    if (!result.ok) {
      // Keep the current state (available/failed/...): a failed manual
      // check must not wipe the UI back to idle. The notice is transient
      // and only rides on this single push.
      this.postWebviewMessage({
        type: "openCodeUpdateStatus",
        status: {
          ...this.currentUpdateUiSnapshot(),
          notice: l10n.t(
            'Could not check for updates. Check your network connection and try again.',
          ),
        },
      });
    }
  }

  /** Resolves the target version's release notes for the webview dialog. */
  public async requestOpenCodeChangelog(): Promise<void> {
    const version =
      this.updateUi.targetVersion ??
      this.updateUi.latestVersion ??
      this.updateUi.installedVersion ??
      this.updateUi.currentVersion;
    const fallbackUrl = changelogPageUrl(version);
    if (!version || !this.changelogService) {
      this.postWebviewMessage({
        type: "openCodeChangelog",
        payload: { version: version ?? "", ok: false, fallbackUrl },
      });
      return;
    }
    const result = await this.changelogService.fetchChangelog(version);
    this.postWebviewMessage({
      type: "openCodeChangelog",
      payload: result.ok
        ? {
            version,
            ok: true,
            date: result.date,
            html: result.html,
            fallbackUrl,
          }
        : { version, ok: false, fallbackUrl },
    });
  }

  public abandonOpenCodeUpdate(): void {
    this.opencodeUpdateService?.abandonUpdate();
  }

  /** Restarts the session onto the updated binary, then clears the UI. */
  public async restartAfterUpdate(): Promise<void> {
    const installed = this.updateUi.installedVersion;
    // "always": the updated CLI binary must replace the running shared
    // background service, so no prompt is shown.
    this.restart("always");
    this.updateUi = {
      ...this.updateUi,
      state: "idle",
      step: "",
      currentVersion: installed ?? this.updateUi.currentVersion,
    };
    this.lastUpdateStep = "";
    this.postUpdateUiStatus(this.currentUpdateUiSnapshot());
  }

  /** "Later" on the success card: keep the version pill, drop the card. */
  public dismissOpenCodeUpdate(): void {
    this.updateUi = { ...this.updateUi, state: "idle", step: "" };
    this.lastUpdateStep = "";
    this.postUpdateUiStatus(this.currentUpdateUiSnapshot());
  }

  /**
   * Answer to the in-webview missing-CLI install confirmation: every
   * action clears the pending flag. The install itself is driven
   * entirely by the webview popover.
   */
  public async answerCliInstallPrompt(action: CliInstallPromptAction): Promise<void> {
    void action;
    this.opencodeUpdateService?.clearInstallPrompt();
  }

  /** Translates service status events into webview UI pushes. */
  private handleUpdateServiceStatus(event: OpenCodeUpdateStatus): void {
    const wasInstallable = this.updateUi.state === "installable";
    switch (event.state) {
      case "disabled":
        // No installable fabrication here: the service returns failed
        // installs to "installable" through its re-check, whose event
        // re-announces the install entry naturally.
        this.updateUiHistory = [];
        this.lastUpdateStep = "";
        this.updateUi = { state: "idle", step: "" };
        this.postUpdateUiStatus(this.currentUpdateUiSnapshot());
        break;
      case "idle":
      case "checking":
        // Keep the current UI; the webview shows its own check card while
        // checking and nothing at all when idle.
        break;
      case "installable": {
        this.updateUiHistory = [];
        this.lastUpdateStep = "";
        this.updateUi = {
          ...this.updateUi,
          state: "installable",
          step: "",
          methods: event.methods ?? this.updateUi.methods,
          defaultMethod: event.defaultMethod ?? this.updateUi.defaultMethod,
          installPromptPending: event.installPromptPending === true,
          // The detected mark belongs to update flows only; the webview
          // merge keeps stale values for absent keys.
          detectedMethod: undefined,
          // Explicit empties: the webview merge keeps stale values for
          // absent keys, so failed-flow leftovers must be cleared here.
          detail: "",
          manualCommands: [],
          remediationCommands: [],
          notice: undefined,
        };
        this.postUpdateUiStatus(this.currentUpdateUiSnapshot());
        break;
      }
      case "available": {
        this.updateUiHistory = [];
        this.lastUpdateStep = "";
        this.updateFlowFromInstall = false;
        this.updateUi = {
          ...this.updateUi,
          state: "available",
          step: "",
          currentVersion: event.currentVersion ?? this.updateUi.currentVersion,
          latestVersion: event.latestVersion ?? this.updateUi.latestVersion,
          targetVersion: event.targetVersion ?? this.updateUi.targetVersion,
          // Explicit empties: the webview merge keeps stale values for
          // absent keys, so failed-flow leftovers must be cleared here.
          detail: "",
          manualCommands: [],
          remediationCommands: [],
          notice: undefined,
        };
        // The signal is transient: injected into this single push only, so
        // follow-up pushes (method enrichment, late catch-up) can never
        // re-open the popover.
        this.postUpdateUiStatus({
          ...this.currentUpdateUiSnapshot(),
          // Manual checks surface the method popover directly; automatic
          // ones only mark the pill.
          openMethodPicker: event.manual === true,
        });
        void this.enrichUpdateMethods();
        break;
      }
      case "upToDate": {
        // The notice is transient: injected into this single push only, so
        // later pushes can never re-pop the hint card.
        this.updateFlowFromInstall = false;
        this.updateUi = {
          ...this.updateUi,
          state: "idle",
          step: "",
          installedVersion:
            event.currentVersion ?? this.updateUi.installedVersion,
          latestVersion: event.latestVersion ?? this.updateUi.latestVersion,
          sessionAutoStarted: undefined,
        };
        this.postUpdateUiStatus({
          ...this.currentUpdateUiSnapshot(),
          checkOutcome: "upToDate",
          notice:
            event.manual === true
              ? l10n.t(
                  'Already up to date: {0}',
                  event.latestVersion ?? event.currentVersion ?? "",
                )
              : undefined,
        });
        break;
      }
      case "updating": {
        const step = event.step ?? "";
        // Flow-entry steps reset the step history; "installing" starts the
        // missing-CLI install pipeline instead of an upgrade.
        if (step === "prepare-target" || step === "installing") {
          this.updateUiHistory = [];
          this.lastUpdateStep = "";
          this.updateFlowFromInstall = step === "installing";
        }
        if (this.lastUpdateStep && this.lastUpdateStep !== step) {
          this.updateUiHistory.push({
            step: this.lastUpdateStep,
            ok: true,
            label: "",
          });
        }
        this.lastUpdateStep = step;
        this.updateUi = {
          ...this.updateUi,
          state: "updating",
          step,
          detail: event.detail ?? "",
          targetVersion: event.targetVersion ?? this.updateUi.targetVersion,
          notice: undefined,
        };
        this.postUpdateUiStatus(this.currentUpdateUiSnapshot());
        break;
      }
      case "updateSucceeded": {
        if (this.lastUpdateStep) {
          this.updateUiHistory.push({
            step: this.lastUpdateStep,
            ok: true,
            label: "",
          });
          this.lastUpdateStep = "";
        }
        // Auto-start first so the push can tell the webview whether the
        // restart actions are obsolete (session already running).
        const sessionAutoStarted =
          this.updateFlowFromInstall && this.startOpenCodeAfterInstall();
        this.updateFlowFromInstall = false;
        this.updateUi = {
          ...this.updateUi,
          state: "success",
          step: "",
          installedVersion:
            event.installedVersion ?? this.updateUi.installedVersion,
          targetVersion: event.targetVersion ?? this.updateUi.targetVersion,
          runningVersion: this.updateUi.currentVersion,
          sessionAutoStarted: sessionAutoStarted || undefined,
          // Explicit empties so failed-flow leftovers cannot survive.
          detail: "",
          manualCommands: [],
          remediationCommands: [],
          notice: undefined,
        };
        this.postUpdateUiStatus(this.currentUpdateUiSnapshot());
        break;
      }
      case "failed": {
        if (this.lastUpdateStep) {
          this.updateUiHistory.push({
            step: this.lastUpdateStep,
            ok: false,
            label: "",
          });
          this.lastUpdateStep = "";
        }
        // Restore-events after a failed manual check carry no payload;
        // keep the previous detail/commands so the card survives.
        this.updateUi = {
          ...this.updateUi,
          state: "failed",
          step: "",
          detail: event.detail ?? this.updateUi.detail,
          targetVersion: event.targetVersion ?? this.updateUi.targetVersion,
          remediationCommands:
            event.remediationCommands ?? this.updateUi.remediationCommands,
          manualCommands:
            event.remediationCommands ?? this.updateUi.manualCommands,
          notice: undefined,
        };
        this.postUpdateUiStatus(this.currentUpdateUiSnapshot());
        break;
      }
    }
    // Another window may have installed the CLI while this one was showing
    // the install prompt; a periodic check then moves the state off
    // installable with the CLI healthy. Start the session so the window
    // does not sit idle with a ready CLI (no-op when a session runs).
    if (
      wasInstallable &&
      (event.state === "idle" ||
        event.state === "available" ||
        event.state === "upToDate")
    ) {
      this.startOpenCodeAfterInstall();
    }
  }

  /** Fetches popover method details and re-pushes while still available. */
  private async enrichUpdateMethods(): Promise<void> {
    if (!this.opencodeUpdateService) {
      return;
    }
    try {
      const details =
        await this.opencodeUpdateService.getUpgradeMethodDetails();
      this.updateUi = {
        ...this.updateUi,
        methods: details.methods,
        defaultMethod: details.defaultMethod,
        detectedMethod: details.detectedMethod,
        lastUsedMethod: details.lastUsedMethod,
      };
      if (this.updateUi.state === "available") {
        this.postUpdateUiStatus(this.currentUpdateUiSnapshot());
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.debug(
        `[TerminalProvider] update method details unavailable: ${message}`,
      );
    }
  }

  private currentUpdateUiSnapshot(): OpenCodeUpdateUiStatus {
    return {
      ...this.updateUi,
      history: this.updateUiHistory.slice(),
      // The pending flag is only meaningful in the installable state;
      // stale values must never leak into other states' pushes.
      installPromptPending:
        this.updateUi.state === "installable" &&
        this.updateUi.installPromptPending === true,
    };
  }

  /**
   * Boots the sidebar session once after a successful missing-CLI install,
   * but only when no terminal session is running yet. Returns whether the
   * session was started, so the success push can replace the restart
   * actions with an informational line. Replaces the old
   * ExtensionLifecycle notification flow; results surface through the
   * webview success card.
   *
   * A started session is only restarted on zombie evidence: the CLI major
   * never resolved and no launch is in flight. A session started while the
   * CLI was missing cannot have parsed a version, so major undefined plus
   * not-starting means the launcher shell is idling after a
   * command-not-found error. A resolved major means a real session, e.g.
   * from a probe false negative or a manual start, and is left alone; a
   * launch still in progress is never interrupted.
   */
  private startOpenCodeAfterInstall(): boolean {
    if (this.isStarted()) {
      if (this.sessionRuntime.getCliMajorVersion() !== undefined) {
        // Real session running OpenCode: keep it, the restart actions
        // stay meaningful for a binary swapped underneath.
        this.logger.info(
          "[TerminalProvider] OpenCode session already running; skipping the post-install start",
        );
        return false;
      }
      if (this.sessionRuntime.isStartingSession()) {
        // A launch is still resolving; interrupting it would race the
        // startup pipeline.
        this.logger.info(
          "[TerminalProvider] session launch in progress; skipping the post-install start",
        );
        return false;
      }
      this.logger.info(
        "[TerminalProvider] restarting the error shell after the CLI became available",
      );
      this.restart("always");
      return true;
    }
    this.logger.info(
      "[TerminalProvider] starting OpenCode after the CLI install",
    );
    void this.startOpenCode().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[TerminalProvider] could not start OpenCode after install: ${message}`,
      );
    });
    return true;
  }

  /**
   * Pushes the update UI status to the webview. Version fields are never
   * stale here: the session always runs OpenCode.
   */
  private postUpdateUiStatus(status: OpenCodeUpdateUiStatus): void {
    this.postWebviewMessage({
      type: "openCodeUpdateStatus",
      status,
    });
  }


  public async updateOpenCodeCliPlugin(
    index: number,
    version: string,
  ): Promise<void> {
    try {
      await this.openCodeCliSettingsService.updatePluginVersion(index, version);
      this.postWebviewMessage({
        type: "openCodeCliSettingsSaveResult",
        ok: true,
        path: "plugins",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `[TerminalProvider] openCode plugin version update failed: ${message}`,
      );
      this.postWebviewMessage({
        type: "openCodeCliSettingsSaveResult",
        ok: false,
        path: "plugins",
        error: message,
      });
    }
    await this.requestOpenCodeCliSettingsData();
  }

  private resolveProjectDir(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  public async saveOpenCodeCliSetting(
    path: string,
    value: unknown,
  ): Promise<void> {
    // An explicit theme choice in the settings modal is a stronger signal
    // than the follow-VS-Code default. Turn the default off before saving so
    // the choice is not silently reverted on the next activation.
    if (path === "theme.name" || path === "theme.mode") {
      const config = vscode.workspace.getConfiguration("opencode-cli-sidebar");
      if (config.get<boolean>("followVsCodeTheme", true)) {
        try {
          await config.update(
            "followVsCodeTheme",
            false,
            vscode.ConfigurationTarget.Global,
          );
          this.logger.info(
            "[TerminalProvider] Disabled followVsCodeTheme after a manual theme change",
          );
        } catch (error) {
          this.logger.warn(
            `[TerminalProvider] Failed to disable followVsCodeTheme after a manual theme change: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
    try {
      await this.openCodeCliSettingsService.save(path, value);
      this.postWebviewMessage({
        type: "openCodeCliSettingsSaveResult",
        ok: true,
        path,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `[TerminalProvider] openCode settings save failed: ${message}`,
      );
      this.postWebviewMessage({
        type: "openCodeCliSettingsSaveResult",
        ok: false,
        path,
        error: message,
      });
    }
    await this.requestOpenCodeCliSettingsData();
  }

  public async resetOpenCodeCliSetting(path: string): Promise<void> {
    try {
      await this.openCodeCliSettingsService.reset(path);
      this.postWebviewMessage({
        type: "openCodeCliSettingsSaveResult",
        ok: true,
        path,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `[TerminalProvider] openCode settings reset failed: ${message}`,
      );
      this.postWebviewMessage({
        type: "openCodeCliSettingsSaveResult",
        ok: false,
        path,
        error: message,
      });
    }
    await this.requestOpenCodeCliSettingsData();
  }

  public async switchToInstance(
    instanceId: InstanceId,
    options?: { forceRestart?: boolean },
  ): Promise<void> {
    await this.sessionRuntime.switchToInstance(instanceId, options);
  }

  public async sendPrompt(
    prompt: string,
    options?: { asPaste?: boolean },
  ): Promise<void> {
    const apiClient = this.sessionRuntime.getApiClient();
    if (apiClient && this.sessionRuntime.isHttpAvailable()) {
      try {
        await apiClient.appendPrompt(prompt);
        return;
      } catch (error) {
        this.logger.warn(
          `HTTP API send failed, falling back to terminal write: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Large payloads go out as a bracketed paste: the TUI inserts the
    // whole block in one event instead of processing it keystroke by
    // keystroke, which reflows its composer per character.
    const payload =
      options?.asPaste === true
        ? `\x1b[200~${prompt}\x1b[201~`
        : prompt;
    this.terminalManager.writeToTerminal(this.activeTerminalId, payload);
  }

  private handleMessage(message: unknown): void {
    this.messageRouter.handleMessage(message);
  }

  private getNativeRestoreRecord():
    | ReturnType<InstanceStore["getActive"]>
    | undefined {
    let record: ReturnType<InstanceStore["getActive"]> | undefined;
    try {
      record = this.instanceStore?.getActive();
    } catch (error) {
      this.logger.info(
        `[TerminalProvider] Native restore skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }

    if (!record || record.state !== "disconnected") {
      return undefined;
    }

    return record;
  }

  private async promptNativeRestore(): Promise<boolean> {
    const record = this.getNativeRestoreRecord();

    if (!record) {
      return false;
    }

    this.logger.info(
      `[TerminalProvider] Auto-restoring native terminal for ${record.config.id}`,
    );

    await this.sessionRuntime.startOpenCode();
    return true;
  }

  private resizeActiveTerminal(cols: number, rows: number): void {
    this.terminalManager.resizeTerminal(this.activeTerminalId, cols, rows);
  }

  private getActiveInstanceId(): InstanceId {
    return this.activeInstanceId;
  }

  private setLastKnownTerminalSize(cols: number, rows: number): void {
    this.sessionRuntime.setLastKnownTerminalSize(cols, rows);
  }

  private getLastKnownTerminalSize(): { cols: number; rows: number } {
    return this.sessionRuntime.getLastKnownTerminalSize();
  }

  private isStarted(): boolean {
    return this.sessionRuntime.isStartedFlag();
  }

  /** Re-post the activeSession snapshot (webview reloaded after startup). */
  public resendActiveSession(): void {
    const webview = this._panel?.webview ?? this._view?.webview;
    if (webview) {
      this.postCurrentSessionState(webview);
    }
  }

  /** Public so lifecycle wiring (config sync pushes) can post host messages. */
  postWebviewMessage(message: unknown): void {
    if (this.isTerminalOutputHostMessage(message)) {
      this.dataThrottleService.push(message.data);
      return;
    }

    this.postWebviewMessageNow(message);
  }

  private postWebviewVisible(): void {
    this.postWebviewMessage({
      type: "webviewVisible",
    });
  }

  private postWebviewMessageNow(message: unknown): void {
    const webview = this._panel?.webview ?? this._view?.webview;
    if (webview) {
      const postResult = webview.postMessage(message) as
        | boolean
        | Thenable<boolean>;
      if (this.isThenablePostResult(postResult)) {
        if (this.isQueueableHostMessage(message)) {
          this.pendingQueueablePostChecks += 1;
        }
        void postResult.then((delivered) => {
          if (this.isQueueableHostMessage(message)) {
            this.pendingQueueablePostChecks = Math.max(
              0,
              this.pendingQueueablePostChecks - 1,
            );
          }
          if (!delivered && this.isQueueableHostMessage(message)) {
            this.replacePendingWebviewMessage(message);
            if (this.isWebviewVisible()) {
              this.flushPendingWebviewMessages(webview);
            }
          }
        });
        return;
      }

      if (!postResult && this.isQueueableHostMessage(message)) {
        this.replacePendingWebviewMessage(message);
      }
      return;
    }

    if (this.isQueueableHostMessage(message)) {
      this.replacePendingWebviewMessage(message);
    }
  }

  private isWebviewVisible(): boolean {
    return this._panel?.visible === true || this._view?.visible === true;
  }

  private isThenablePostResult(
    value: boolean | Thenable<boolean>,
  ): value is Thenable<boolean> {
    return typeof value === "object" && value !== null && "then" in value;
  }

  private isTerminalOutputHostMessage(
    message: unknown,
  ): message is Extract<HostMessage, { type: "terminalOutput" }> {
    return (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "terminalOutput" &&
      "data" in message &&
      typeof message.data === "string"
    );
  }

  private isQueueableHostMessage(
    message: unknown,
  ): message is Extract<HostMessage, { type: "activeSession" }> {
    return (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "activeSession"
    );
  }

  private replacePendingWebviewMessage(message: HostMessage): void {
    const existingIndex = this.pendingWebviewMessages.findIndex(
      (pendingMessage) => pendingMessage.type === message.type,
    );
    if (existingIndex >= 0) {
      this.pendingWebviewMessages.splice(existingIndex, 1, message);
      return;
    }

    this.pendingWebviewMessages.push(message);
  }

  private flushPendingWebviewMessages(webview: vscode.Webview): void {
    const messages = this.pendingWebviewMessages.splice(0);
    for (const message of messages) {
      const postResult = webview.postMessage(message) as
        | boolean
        | Thenable<boolean>;
      if (this.isThenablePostResult(postResult)) {
        void postResult.then((delivered) => {
          if (!delivered && this.isQueueableHostMessage(message)) {
            this.replacePendingWebviewMessage(message);
          }
        });
      } else if (!postResult && this.isQueueableHostMessage(message)) {
        this.replacePendingWebviewMessage(message);
      }
    }
  }

  private postCurrentSessionState(webview: vscode.Webview): void {
    webview.postMessage({
      type: "activeSession",
      backend: "native" as TerminalBackendType,
      openCodeV2: this.sessionRuntime.isOpenCodeV2Active(),
    });

    // Session switches re-sync the self-update pill.
    this.postUpdateUiStatus(this.currentUpdateUiSnapshot());
  }

  private postTerminalConfig(): void {
    const terminalConfig = this.getTerminalConfig();
    this.postWebviewMessage({
      type: "terminalConfig",
      ...terminalConfig,
    });
  }

  private getTerminalConfig(): Omit<
    Extract<HostMessage, { type: "terminalConfig" }>,
    "type"
  > {
    const config = vscode.workspace.getConfiguration("opencode-cli-sidebar");
    const focusIndicatorBorderWidth = config.get<number>(
      "focusIndicatorBorderWidth",
      2,
    );
    return {
      fontSize: config.get<number>("fontSize", 14),
      fontFamily: config.get<string>(
        "fontFamily",
        "'JetBrainsMono Nerd Font', 'FiraCode Nerd Font', 'CascadiaCode NF', Menlo, monospace",
      ),
      cursorBlink: config.get<boolean>("cursorBlink", true),
      cursorStyle: config.get<"block" | "underline" | "bar">(
        "cursorStyle",
        "block",
      ),
      scrollback: config.get<number>("scrollback", 10000),
      sendKeybindingsToShell: config.get<boolean>(
        "sendKeybindingsToShell",
        true,
      ),
      focusIndicatorMode: config.get<FocusIndicatorMode>(
        "focusIndicatorMode",
        "bottomBorder",
      ),
      focusIndicatorBorderWidth: Math.min(
        8,
        Math.max(
          1,
          Number.isFinite(focusIndicatorBorderWidth)
            ? focusIndicatorBorderWidth
            : 2,
        ),
      ),
      isEditorTab: this._panel !== undefined,
    };
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview
      .asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js"),
      )
      .toString();
    const cssUri = webview
      .asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, "dist", "terminal.css"),
      )
      .toString();
    const nonce = this.getNonce();

    const terminalConfig = this.getTerminalConfig();

    const html = renderTerminalHtml({
      cspSource: webview.cspSource,
      nonce,
      cssUri,
      scriptUri,
      fontSize: String(terminalConfig.fontSize),
      fontFamily: terminalConfig.fontFamily,
      cursorBlink: String(terminalConfig.cursorBlink),
      cursorStyle: terminalConfig.cursorStyle,
      scrollback: String(terminalConfig.scrollback),
      sendKeybindingsToShell: String(terminalConfig.sendKeybindingsToShell),
      focusIndicatorMode:
        terminalConfig.focusIndicatorMode ?? "bottomBorder",
      focusIndicatorBorderWidth: String(
        terminalConfig.focusIndicatorBorderWidth ?? 2,
      ),
    });

    return html;
  }

  private getNonce(): string {
    let text = "";
    const possible =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  private getEditorPanelOptions(): vscode.WebviewOptions &
    vscode.WebviewPanelOptions {
    return {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [this.context.extensionUri],
    };
  }

  private initializeEditorPanel(panel: vscode.WebviewPanel): void {
    this._panel = panel;
    panel.webview.options = this.getEditorPanelOptions();
    panel.webview.html = this.getHtmlForWebview(panel.webview);

    const processAlive = this.sessionRuntime.hasLiveTerminalProcess();
    if (this.sessionRuntime.isStartedFlag() && !processAlive) {
      this.sessionRuntime.resetState();
    }

    panel.webview.onDidReceiveMessage((message) => {
      this.handleMessage(message);
    });

    if (processAlive) {
      this.sessionRuntime.reconnectListeners();
    }

    this.postTerminalConfig();
    this.postCurrentSessionState(panel.webview);
    this.flushPendingWebviewMessages(panel.webview);

    panel.onDidDispose(() => {
      if (this._panel === panel) {
        this._panel = undefined;
        if (this._view) {
          this.postTerminalConfig();
        }
      }
    });
  }

  /** Reveals the sidebar view (best-effort) and focuses the terminal. */
  public async revealSidebarView(): Promise<void> {
    try {
      await vscode.commands.executeCommand(
        "workbench.view.extension.opencode-cli-sidebarContainer",
      );
    } catch {
      // intentionally empty: sidebar reveal is best-effort
    }

    this._view?.show?.(true);
    this.postWebviewMessage({
      type: "focusTerminal",
    });
  }

  public dispose(): void {
    this.disposables.forEach((disposable) => disposable.dispose());
    this.disposables.length = 0;
    this.dataThrottleService.dispose();
    this.sessionRuntime.dispose();
  }
}
