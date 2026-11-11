
import * as vscode from "vscode";
import { createHash } from "crypto";
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
import {
  ChangelogTranslationError,
  type ChangelogTranslationFailure,
  type ChangelogTranslationService,
} from "../services/ChangelogTranslationService";
import type { OpenCodeGenerateConnection } from "../services/OpenCodeGenerateClient";
import { DataThrottleService } from "../services/DataThrottleService";
import { InstanceId, InstanceStore } from "../services/InstanceStore";
import { isVersionNewer } from "../services/semver";
import { isOhMyOpenCodeSlimAvailable } from "../services/openCodeConfigPath";
import {
  FocusIndicatorMode,
  HostMessage,
  OpenCodeUpdateStep,
  OpenCodeUpdateUiStatus,
  ServiceRestartPromptAction,
  TerminalBackendType,
  CliInstallPromptAction,
  ExtensionSettingsScope,
  WebviewMessage,
} from "../types";
import {
  OpenCodeFileReference,
  OpenCodeToolOperator,
} from "../services/aiTools/OpenCodeToolOperator";
import type { IdeContextServer } from "../services/ideContext/IdeContextServer";
import { MessageRouter, MessageRouterProviderBridge } from "./MessageRouter";
import { SessionRuntime, type ServiceRestartPolicy } from "./SessionRuntime";
import {
  toReferencePath,
  type ReferencePathStyle,
} from "./relativeReference";
import { WebviewRequestRouter } from "./WebviewRequestRouter";
import { renderWebviewHtml } from "./webviewHtml";
import { NativeTerminalManager } from "../services/NativeTerminalManager";
import type { LaunchGate } from "../services/LaunchGate";
import { TerminalBackendRegistry } from "../services/terminalBackends";
import { OpenCodeKeymapService } from "../services/OpenCodeKeymapService";
import { OpenCodeCliSettingsService } from "../services/OpenCodeCliSettingsService";
import { ExtensionSettingsService } from "../services/ExtensionSettingsService";
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

  private readonly requestRouter: WebviewRequestRouter;
  private readonly dataThrottleService: DataThrottleService;
  private readonly keymapService = new OpenCodeKeymapService();
  private readonly openCodeCliSettingsService = new OpenCodeCliSettingsService();
  private readonly extensionSettingsService = new ExtensionSettingsService();
  private readonly pendingWebviewMessages: HostMessage[] = [];
  private pendingQueueablePostChecks = 0;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly opencodeUpdateService?: OpenCodeUpdateService;
  private readonly changelogService?: OpenCodeChangelogService;
  private readonly changelogTranslationService?: ChangelogTranslationService;
  /** In-flight translation requests, keyed by the webview's request id. */
  private readonly changelogTranslationRequests = new Map<
    string,
    AbortController
  >();
  /** Current self-update UI snapshot; pushed in full on every change. */
  private updateUi: OpenCodeUpdateUiStatus = { state: "idle", step: "" };
  /** Completed update steps for the progress card and log drawer. */
  private updateUiHistory: Array<{ step: string; ok: boolean; label: string }> =
    [];
  private lastUpdateStep: OpenCodeUpdateStep = "";

  /** True while the current flow is a missing-CLI install, not an update. */
  private updateFlowFromInstall = false;
  /** Pending output lines waiting for the next batched webview push. */
  private updateOutputBuffer: string[] = [];
  private updateOutputTimer: NodeJS.Timeout | undefined;
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
    changelogTranslationService?: ChangelogTranslationService,
    launchGate?: LaunchGate,
  ) {
    this.contextSharingService = new ContextSharingService();
    this.opencodeOperator = new OpenCodeToolOperator();
    this.opencodeUpdateService = opencodeUpdateService;
    this.changelogService = changelogService;
    this.changelogTranslationService = changelogTranslationService;
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
      launchGate,
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
      setOpenCodeCliPluginOptions: (index, options) =>
        this.setOpenCodeCliPluginOptions(index, options),
      clearOpenCodeCliPluginCache: (name) =>
        this.clearOpenCodeCliPluginCache(name),
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
      requestOpenCodeChangelog: (version, mode) =>
        this.requestOpenCodeChangelog(version, mode),
      translateOpenCodeChangelog: (request) =>
        this.translateOpenCodeChangelog(request),
      cancelOpenCodeChangelogTranslation: (requestId) =>
        this.cancelOpenCodeChangelogTranslation(requestId),
      sendChangelogToOpenCode: (text) =>
        this.sendPrompt(text, { asPaste: true }),
      requestExtensionSettingsData: () => this.requestExtensionSettingsData(),
      updateExtensionSetting: (key, value, scope) =>
        this.updateExtensionSetting(key, value, scope),
      resetExtensionSetting: (key, scope) =>
        this.resetExtensionSetting(key, scope),
      // The gate is owned by ExtensionLifecycle, which also registers the
      // skip command; routing the webview request through that command keeps
      // a single implementation instead of widening this provider's
      // constructor. The boolean reports that the request was dispatched: the
      // command itself owns the authoritative skip result. Rejections are
      // swallowed because the command may not be registered yet during
      // activation.
      skipPreStartSync: () => {
        void vscode.commands
          .executeCommand("opencode-cli-sidebar.skipPreStartSync")
          .then(undefined, () => undefined);
        return true;
      },
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

    this.requestRouter = new WebviewRequestRouter(
      this.context,
      this.logger,
      (message) => this.postWebviewMessage(message),
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
        this.opencodeUpdateService.onDidOutputLine((line) => {
          this.queueUpdateOutputLine(line);
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
          ) ||
          event.affectsConfiguration("opencode-cli-sidebar.fontFamily") ||
          event.affectsConfiguration(
            "opencode-cli-sidebar.sendKeybindingsToShell",
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

    // Listener must be attached before the HTML is assigned: assigning `html`
    // starts loading the webview script immediately, and the script's first
    // message is the l10n bundle request. Registering afterwards loses that
    // request, which leaves the whole UI untranslated.
    webviewView.webview.onDidReceiveMessage((message) => {
      this.handleMessage(message);
    });

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    const processAlive = this.sessionRuntime.hasLiveTerminalProcess();
    if (this.sessionRuntime.isStartedFlag() && !processAlive) {
      this.sessionRuntime.resetState();
    }

    if (processAlive) {
      this.sessionRuntime.reconnectListeners();
    }

    this.postTerminalConfig();
    this.postCurrentSessionState(webviewView.webview);
    this.flushPendingWebviewMessages(webviewView.webview);

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
        visibilityListener.dispose();
      }
    });
    webviewView.onDidDispose(() => visibilityListener.dispose());

    if (webviewView.visible && !this.isStarted()) {
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

  /**
   * Formats a `@path` text reference. `relative` is the default and keeps
   * references short; `absolute` is used by the dedicated absolute-path send
   * command so references survive a session whose working directory differs
   * from the workspace root.
   */
  public formatUriReference(
    uri: vscode.Uri,
    pathStyle: ReferencePathStyle = "relative",
  ): string {
    return this.formatFileReference({
      path: toReferencePath(uri, pathStyle),
    });
  }

  public formatEditorReference(editor: vscode.TextEditor): string {
    const selection = editor.selection;
    return this.formatFileReference({
      path: toReferencePath(editor.document.uri, "relative"),
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

  /** Live generation endpoint for the active session, when HTTP is ready. */
  public getGenerateConnection(): OpenCodeGenerateConnection | undefined {
    return this.sessionRuntime.getGenerateConnection();
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

  // ── Extension settings dialog bridge ──

  /** Replies with every setting value, authored layer and default. */
  public async requestExtensionSettingsData(): Promise<void> {
    try {
      const settings = this.extensionSettingsService.readSnapshot();
      this.postWebviewMessage({ type: "extensionSettingsData", settings });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `[TerminalProvider] extension settings snapshot failed: ${message}`,
      );
      this.postWebviewMessage({
        type: "extensionSettingsSaveResult",
        ok: false,
        error: message,
      });
    }
  }

  /** Validates and persists one setting at the requested scope. */
  public async updateExtensionSetting(
    key: string,
    value: unknown,
    scope: ExtensionSettingsScope,
  ): Promise<void> {
    try {
      await this.extensionSettingsService.update(key, value, scope);
      this.postWebviewMessage({
        type: "extensionSettingsSaveResult",
        ok: true,
        key,
      });
      await this.requestExtensionSettingsData();
    } catch (error) {
      this.postExtensionSettingsFailure("update", key, scope, error);
    }
  }

  /** Clears one layer's value so the setting falls back to the next layer. */
  public async resetExtensionSetting(
    key: string,
    scope: ExtensionSettingsScope,
  ): Promise<void> {
    try {
      await this.extensionSettingsService.reset(key, scope);
      this.postWebviewMessage({
        type: "extensionSettingsSaveResult",
        ok: true,
        key,
      });
      await this.requestExtensionSettingsData();
    } catch (error) {
      this.postExtensionSettingsFailure("reset", key, scope, error);
    }
  }

  private postExtensionSettingsFailure(
    action: "update" | "reset",
    key: string,
    scope: ExtensionSettingsScope,
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    // The key and scope stay in the log; the receipt carries only the
    // short, user-facing reason.
    this.logger.error(
      `[TerminalProvider] extension setting ${action} failed (${key}, ${scope}): ${message}`,
    );
    this.postWebviewMessage({
      type: "extensionSettingsSaveResult",
      ok: false,
      key,
      error: message,
    });
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
        installedPluginVersions: payload.installedPluginVersions,
        pluginLatestVersions: payload.pluginLatestVersions,
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

  public async setOpenCodeCliPluginOptions(
    index: number,
    options: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.openCodeCliSettingsService.setPluginOptions(index, options);
      this.postWebviewMessage({
        type: "openCodeCliSettingsSaveResult",
        ok: true,
        path: "plugins",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `[TerminalProvider] openCode plugin options change failed: ${message}`,
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

  /**
   * Drop the stale `<name>@latest` cache directory. The plugin reuses the cache
   * until it is gone, so removing it is the only way to pick up npm latest.
   */
  public async clearOpenCodeCliPluginCache(name: string): Promise<void> {
    try {
      await this.openCodeCliSettingsService.clearPluginCache(name);
      this.postWebviewMessage({
        type: "openCodeCliSettingsSaveResult",
        ok: true,
        path: "plugins",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `[TerminalProvider] openCode plugin cache clear failed for ${name}: ${message}`,
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

  /**
   * Resolves release notes for the update dialog. `version` names the
   * release explicitly; otherwise an upcoming request reads the flow's
   * target, and an installed request reads what is on disk.
   */
  public async requestOpenCodeChangelog(
    version?: string,
    mode: "upcoming" | "installed" = "installed",
  ): Promise<void> {
    const resolved =
      version ||
      (mode === "upcoming"
        ? this.updateUi.targetVersion ?? this.updateUi.latestVersion
        : this.updateUi.installedVersion ??
          this.updateUi.currentVersion ??
          this.updateUi.latestVersion ??
          this.updateUi.targetVersion) ||
      "";
    const fallbackUrl = changelogPageUrl(resolved);
    if (!resolved || !this.changelogService) {
      this.postWebviewMessage({
        type: "openCodeChangelog",
        payload: { version: resolved, ok: false, fallbackUrl, mode },
      });
      return;
    }
    const result = await this.changelogService.fetchChangelog(resolved);
    this.postWebviewMessage({
      type: "openCodeChangelog",
      payload: result.ok
        ? {
            version: resolved,
            ok: true,
            date: result.date,
            html: result.html,
            htmlHash: createHash("sha256")
              .update(result.html)
              .digest("hex")
              .slice(0, 16),
            fallbackUrl,
            mode,
          }
        : { version: resolved, ok: false, fallbackUrl, mode },
    });
  }

  /**
   * Translates the changelog blocks the webview extracted. Failures reply
   * with `ok: false` and no detail; the reason stays in the log. A cancelled
   * request produces no reply because the webview is no longer listening.
   */
  public async translateOpenCodeChangelog(
    request: Extract<WebviewMessage, { type: "translateOpenCodeChangelog" }>,
  ): Promise<void> {
    const { requestId } = request;
    const service = this.changelogTranslationService;
    if (!service) {
      this.postWebviewMessage({
        type: "openCodeChangelogTranslation",
        requestId,
        ok: false,
        error: l10n.t("Not connected to an OpenCode session"),
      });
      return;
    }

    const controller = new AbortController();
    this.changelogTranslationRequests.get(requestId)?.abort();
    this.changelogTranslationRequests.set(requestId, controller);

    try {
      const translations = await service.translate(
        {
          version: request.version,
          htmlHash: request.htmlHash,
          targetLanguage: request.targetLanguage,
          blocks: request.blocks,
        },
        controller.signal,
      );
      if (controller.signal.aborted) {
        return;
      }
      this.postWebviewMessage({
        type: "openCodeChangelogTranslation",
        requestId,
        ok: true,
        translations,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        this.logger.debug(
          `[TerminalProvider] changelog translation cancelled (${requestId})`,
        );
        return;
      }
      this.logger.debug(
        `[TerminalProvider] changelog translation failed (${requestId}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.postWebviewMessage({
        type: "openCodeChangelogTranslation",
        requestId,
        ok: false,
        error: this.describeTranslationFailure(error),
      });
    } finally {
      if (this.changelogTranslationRequests.get(requestId) === controller) {
        this.changelogTranslationRequests.delete(requestId);
      }
    }
  }

  /** Aborts one in-flight translation; used when the dialog closes. */
  public cancelOpenCodeChangelogTranslation(requestId: string): void {
    const controller = this.changelogTranslationRequests.get(requestId);
    if (!controller) {
      return;
    }
    this.changelogTranslationRequests.delete(requestId);
    controller.abort();
  }

  /** Maps a translation failure to a short reason shown in the dialog. */
  private describeTranslationFailure(error: unknown): string {
    if (!(error instanceof ChangelogTranslationError)) {
      return l10n.t("Unknown error");
    }
    const failure: ChangelogTranslationFailure = error.failure;
    switch (failure) {
      case "no-connection":
        return l10n.t("Not connected to an OpenCode session");
      case "rate-limit": {
        if (error.providerID === "opencode") {
          return error.model
            ? l10n.t(
                'The OpenCode free model {0} has no quota left. Switch to another model; if you still use the built-in default, set a top-level "model" in ~/.config/opencode/opencode.json.',
                error.model,
              )
            : l10n.t(
                'The OpenCode free model has no quota left. Switch to another model; if you still use the built-in default, set a top-level "model" in ~/.config/opencode/opencode.json.',
              );
        }
        return error.model
          ? l10n.t(
              "Model {0} is rate limited or out of quota. Switch models or retry later.",
              error.model,
            )
          : l10n.t(
              "Model quota exhausted or rate limited. Switch models or retry later.",
            );
      }
      case "timeout":
        return l10n.t("Request timed out");
      case "service-unavailable":
        return l10n.t("OpenCode service is not ready");
      case "unreachable":
        return l10n.t("Cannot reach the OpenCode service");
      case "invalid-response":
        return l10n.t("Model response could not be parsed");
      case "empty-response":
        return l10n.t("Model returned no content");
      case "http":
        return typeof error.status === "number"
          ? l10n.t("OpenCode service returned error {0}", String(error.status))
          : l10n.t("OpenCode service returned an error");
      case "aborted":
        return l10n.t("Translation was cancelled");
      case "unknown":
        return l10n.t("Unknown error");
    }
  }

  /**
   * Warms the changelog cache as soon as an update is detected, so the
   * notes step opens without a loading flash. Failures stay silent: the
   * dialog retries on open and the update never depends on notes.
   */
  private prefetchOpenCodeChangelog(version?: string): void {
    if (!version || !this.changelogService) {
      return;
    }
    void this.changelogService
      .fetchChangelog(version)
      .catch(() => undefined);
  }

  public abandonOpenCodeUpdate(): void {
    this.opencodeUpdateService?.abandonUpdate();
  }

  /**
   * 更新已装好：webview 侧已确认过重启意愿，这里直接重启会话并收尾。
   */
  public async restartAfterUpdate(): Promise<void> {
    const installed = this.updateUi.installedVersion;
    // "always": the updated CLI binary must replace the running shared
    // background service, so no second prompt is shown.
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

  /** Dialog close on the success result: keep the version pill, drop the flow. */
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
        // re-open the dialog.
        this.postUpdateUiStatus({
          ...this.currentUpdateUiSnapshot(),
          // Manual checks open the release notes; automatic ones only
          // mark the pill.
          openUpdateDialog: event.manual === true ? "notes" : undefined,
        });
        this.prefetchOpenCodeChangelog(
          event.latestVersion ?? this.updateUi.latestVersion,
        );
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
          this.resetUpdateOutput();
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

  /**
   * Buffers one upgrade/install output line and pushes the batch on a
   * short timer. npm installs can print hundreds of lines per second, so
   * posting each line individually would stall the webview.
   */
  private queueUpdateOutputLine(line: string): void {
    this.updateOutputBuffer.push(line);
    if (this.updateOutputTimer) {
      return;
    }
    this.updateOutputTimer = setTimeout(() => {
      this.updateOutputTimer = undefined;
      const lines = this.updateOutputBuffer.splice(0);
      if (!lines.length) {
        return;
      }
      this.postWebviewMessage({ type: "openCodeUpdateOutput", lines });
    }, 100);
  }

  /** Drops buffered output when a new flow starts. */
  private resetUpdateOutput(): void {
    this.updateOutputBuffer = [];
    if (this.updateOutputTimer) {
      clearTimeout(this.updateOutputTimer);
      this.updateOutputTimer = undefined;
    }
  }


  public async updateOpenCodeCliPlugin(
    index: number,
    version: string,
  ): Promise<void> {
    try {
      await this.openCodeCliSettingsService.updatePluginVersion(
        index,
        version,
        this.resolveProjectDir(),
      );
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
    // Bridge requests carry a request envelope; the terminal hot path and all
    // legacy messages stay flat and go to MessageRouter unchanged.
    if (WebviewRequestRouter.isRequest(message)) {
      void this.requestRouter.dispatch(message);
      return;
    }
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
      hasOhMyOpenCodeSlim: isOhMyOpenCodeSlimAvailable(),
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
      cursorBlink: true,
      cursorStyle: "block",
      scrollback: 10000,
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

    return renderWebviewHtml({
      cspSource: webview.cspSource,
      nonce,
      cssUri,
      scriptUri,
      terminalConfig,
    });
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

    // Attach before assigning `html`, for the same reason as
    // `resolveWebviewView`: the first webview message is the l10n request.
    panel.webview.onDidReceiveMessage((message) => {
      this.handleMessage(message);
    });

    panel.webview.html = this.getHtmlForWebview(panel.webview);

    const processAlive = this.sessionRuntime.hasLiveTerminalProcess();
    if (this.sessionRuntime.isStartedFlag() && !processAlive) {
      this.sessionRuntime.resetState();
    }

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
    for (const controller of this.changelogTranslationRequests.values()) {
      controller.abort();
    }
    this.changelogTranslationRequests.clear();
    this.resetUpdateOutput();
    this.dataThrottleService.dispose();
    this.sessionRuntime.dispose();
  }
}
