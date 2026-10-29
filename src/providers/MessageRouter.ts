
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import * as vscode from "vscode";
import { l10n } from "../i18n";
import { ContextSharingService } from "../services/ContextSharingService";
import { InstanceId, InstanceStore } from "../services/InstanceStore";
import { OpenCodeApiClient } from "../services/OpenCodeApiClient";
import { isValidOpenCodeUpdateMethod } from "../services/OpenCodeUpdateService";
import { OutputCaptureManager } from "../services/OutputCaptureManager";
import { OutputChannelService } from "../services/OutputChannelService";
import { TerminalManager } from "../terminals/TerminalManager";
import {
  ALLOWED_IMAGE_TYPES,
  DroppedBlobFile,
  MAX_IMAGE_SIZE,
  WebviewMessage,
} from "../types";
import type {
  CliInstallPromptAction,
  ServiceRestartPromptAction,
  TerminalBackendType,
} from "../types";
import {
  createSelection,
  fuzzyMatchFile,
  openFileInEditor,
} from "./openFile";
import {
  ensureOpenCodeGlobalFile,
  resolveOpenCodeConfigDir,
} from "../services/openCodeConfigPath";
import { getActiveConfigSyncService } from "../services/sync/syncServiceRegistry";
import { toRelativeReference } from "./relativeReference";

export interface MessageRouterProviderBridge {
  startOpenCode(): Promise<void>;
  restart(): void;
  answerServiceRestartPrompt(action: ServiceRestartPromptAction): void;
  openSettings(): void;
  openKeyboardShortcuts(): void;
  toggleEditorAttachment(): Promise<void>;
  pasteText(text: string): void;
  getActiveInstanceId(): InstanceId;
  getActiveTerminalId(): string;
  setLastKnownTerminalSize(cols: number, rows: number): void;
  getLastKnownTerminalSize(): { cols: number; rows: number };
  isStarted(): boolean;
  resizeActiveTerminal(cols: number, rows: number): void;
  postWebviewMessage(message: unknown): void;
  formatDroppedFiles(paths: string[], useAtSyntax: boolean): string;
  formatPastedImage(tempPath: string): string | undefined;
  resendActiveSession(): void;
  saveKeybind(id: string, chords: string[]): Promise<void>;
  resetKeybind(id: string): Promise<void>;
  requestKeymapData(): Promise<void>;
  requestOpenCodeCliSettingsData(): Promise<void>;
  saveOpenCodeCliSetting(path: string, value: unknown): Promise<void>;
  resetOpenCodeCliSetting(path: string): Promise<void>;
  addOpenCodeCliPlugin(packageName: string): Promise<void>;
  removeOpenCodeCliPlugin(index: number): Promise<void>;
  setOpenCodeCliPluginOptions(
    index: number,
    options: Record<string, unknown>,
  ): Promise<void>;
  clearOpenCodeCliPluginCache(name: string): Promise<void>;
  checkOpenCodeCliPluginUpdates(): Promise<void>;
  updateOpenCodeCliPlugin(index: number, version: string): Promise<void>;
  requestOpenCodeUpdateStatus(): Promise<void>;
  startOpenCodeUpdate(method: string): Promise<void>;
  checkOpenCodeUpdates(): Promise<void>;
  abandonOpenCodeUpdate(): void;
  restartAfterUpdate(): Promise<void>;
  dismissOpenCodeUpdate(): void;
  retryCliProbe(): Promise<void>;
  answerCliInstallPrompt(action: CliInstallPromptAction): Promise<void>;
  requestOpenCodeChangelog(
    version?: string,
    mode?: "upcoming" | "installed",
  ): Promise<void>;
  sendChangelogToOpenCode(text: string): Promise<void>;
}

export class MessageRouter {
  public constructor(
    private readonly provider: MessageRouterProviderBridge,
    private readonly context: vscode.ExtensionContext,
    private readonly terminalManager: TerminalManager,
    private readonly captureManager: OutputCaptureManager,
    _apiClient: OpenCodeApiClient | undefined,
    _contextSharingService: ContextSharingService,
    private readonly logger: OutputChannelService,
    _instanceStore: InstanceStore | undefined,
  ) {}

  public async handleMessage(rawMessage: unknown): Promise<void> {
    if (!rawMessage || typeof rawMessage !== "object") {
      return;
    }

    const message = rawMessage as WebviewMessage;
    switch (message.type) {
      case "terminalInput":
        this.handleTerminalInput(message.data);
        break;
      case "terminalResize":
        this.handleTerminalResize(message.cols, message.rows);
        break;
      case "ready":
        this.handleReady(message.cols, message.rows);
        break;
      case "filesDropped":
        await this.handleFilesDropped(
          message.files ?? [],
          message.shiftKey ?? false,
          message.dropCell,
          message.blobFiles,
        );
        break;
      case "openUrl":
        if (typeof message.url === "string") {
          void vscode.env.openExternal(vscode.Uri.parse(message.url));
        }
        break;
      case "openFile":
        if (typeof message.path === "string") {
          void this.handleOpenFile(
            message.path,
            message.line,
            message.endLine,
            message.column,
          );
        }
        break;
      case "listTerminals":
        void this.handleListTerminals();
        break;
      case "setClipboard":
        if (typeof message.text === "string") {
          void this.handleSetClipboard(message.text);
        }
        break;
      case "triggerPaste":
        void this.handlePaste();
        break;
      case "imagePasted":
        if (typeof message.data === "string") {
          void this.handleImagePasted(message.data);
        }
        break;
      case "toggleEditorAttachment":
        await this.provider.toggleEditorAttachment();
        break;
      case "requestRestart":
        this.provider.restart();
        break;
      case "serviceRestartPromptAnswer":
        this.provider.answerServiceRestartPrompt(message.action);
        break;
      case "openSettings":
        this.provider.openSettings();
        break;
      case "openKeyboardShortcuts":
        this.provider.openKeyboardShortcuts();
        break;
      case "openOpenCodeGlobalFile":
        await this.handleOpenOpenCodeGlobalFile(message.target);
        break;
      case "openOpenCodeConfigDir":
        await this.openOpenCodeConfigDir();
        break;
      case "updateFontSize":
        await this.handleUpdateFontSize(message.fontSize);
        break;
      case "saveKeybind":
        if (typeof message.id === "string" && Array.isArray(message.chords)) {
          await this.provider.saveKeybind(message.id, message.chords.map(String));
        }
        break;
      case "resetKeybind":
        if (typeof message.id === "string") {
          await this.provider.resetKeybind(message.id);
        }
        break;
      case "requestKeymapData":
        await this.provider.requestKeymapData();
        break;
      case "requestOpenCodeCliSettingsData":
        await this.provider.requestOpenCodeCliSettingsData();
        break;
      case "saveOpenCodeCliSetting":
        if (typeof message.path === "string") {
          await this.provider.saveOpenCodeCliSetting(message.path, message.value);
        }
        break;
      case "resetOpenCodeCliSetting":
        if (typeof message.path === "string") {
          await this.provider.resetOpenCodeCliSetting(message.path);
        }
        break;
      case "addOpenCodeCliPlugin":
        if (typeof message.packageName === "string") {
          await this.provider.addOpenCodeCliPlugin(message.packageName);
        }
        break;
      case "removeOpenCodeCliPlugin":
        if (typeof message.index === "number") {
          await this.provider.removeOpenCodeCliPlugin(message.index);
        }
        break;
      case "checkOpenCodeCliPluginUpdates":
        await this.provider.checkOpenCodeCliPluginUpdates();
        break;
      case "updateOpenCodeCliPlugin":
        if (
          typeof message.index === "number" &&
          typeof message.version === "string"
        ) {
          await this.provider.updateOpenCodeCliPlugin(
            message.index,
            message.version,
          );
        }
        break;
      case "setOpenCodeCliPluginOptions":
        if (
          typeof message.index === "number" &&
          message.options &&
          typeof message.options === "object"
        ) {
          await this.provider.setOpenCodeCliPluginOptions(
            message.index,
            message.options,
          );
        }
        break;
      case "clearOpenCodeCliPluginCache":
        if (typeof message.name === "string") {
          await this.provider.clearOpenCodeCliPluginCache(message.name);
        }
        break;
      case "requestOpenCodeUpdateStatus":
        await this.provider.requestOpenCodeUpdateStatus();
        break;
      case "startOpenCodeUpdate":
        if (typeof message.method === "string") {
          if (!isValidOpenCodeUpdateMethod(message.method)) {
            // Silently drop crafted method ids; the webview never sends
            // these on its own, so no user-facing hint is needed.
            this.logger.debug(
              `[MessageRouter] startOpenCodeUpdate rejected: invalid method ${JSON.stringify(message.method)}`,
            );
            break;
          }
          await this.provider.startOpenCodeUpdate(message.method);
        }
        break;
      case "checkOpenCodeUpdates":
        await this.provider.checkOpenCodeUpdates();
        break;
      case "abandonOpenCodeUpdate":
        this.provider.abandonOpenCodeUpdate();
        break;
      case "restartAfterUpdate":
        await this.provider.restartAfterUpdate();
        break;
      case "dismissOpenCodeUpdate":
        this.provider.dismissOpenCodeUpdate();
        break;
      case "retryCliProbe":
        await this.provider.retryCliProbe();
        break;
      case "answerCliInstallPrompt":
        if (message.action === "install" || message.action === "notNow") {
          await this.provider.answerCliInstallPrompt(message.action);
        }
        break;
      case "requestOpenCodeChangelog":
        await this.provider.requestOpenCodeChangelog(
          typeof message.version === "string" ? message.version : undefined,
          message.mode === "upcoming" ? "upcoming" : "installed",
        );
        break;
      case "sendChangelogToOpenCode":
        if (typeof message.text === "string" && message.text) {
          await this.provider.sendChangelogToOpenCode(message.text);
        }
        break;
      /* ===================== WebDAV config sync ===================== */
      case "requestWebdavSyncData":
        await getActiveConfigSyncService()?.requestSyncData();
        break;
      case "saveWebdavServerConfig":
        await getActiveConfigSyncService()?.saveServerConfig(
          message.config,
          message.password,
        );
        break;
      case "applyWebdavSyncOptions":
        await getActiveConfigSyncService()?.applySyncOptions(message.options);
        break;
      case "testWebdavConnection":
        await getActiveConfigSyncService()?.testConnection(message.draft);
        break;
      case "setWebdavItemEnabled":
        if (typeof message.id === "string") {
          await getActiveConfigSyncService()?.setItemEnabled(
            message.id,
            message.enabled,
          );
        }
        break;
      case "addWebdavItem":
        if (typeof message.path === "string") {
          await getActiveConfigSyncService()?.addItem(message.path);
        }
        break;
      case "removeWebdavItem":
        if (typeof message.id === "string") {
          await getActiveConfigSyncService()?.removeItem(message.id);
        }
        break;
      case "addWebdavExclude":
        if (typeof message.path === "string") {
          await getActiveConfigSyncService()?.addExclude(message.path);
        }
        break;
      case "removeWebdavExclude":
        if (typeof message.path === "string") {
          await getActiveConfigSyncService()?.removeExclude(message.path);
        }
        break;
      case "syncWebdavNow":
        await getActiveConfigSyncService()?.syncNow();
        break;
      case "requestWebdavLog":
        await getActiveConfigSyncService()?.requestLog();
        break;
      case "clearWebdavHistory":
        await getActiveConfigSyncService()?.clearHistory();
        break;
      case "resolveWebdavConflict":
        if (
          typeof message.id === "string" &&
          (message.resolution === "local" || message.resolution === "remote")
        ) {
          await getActiveConfigSyncService()?.resolveConflict(
            message.id,
            message.resolution,
          );
        }
        break;
      case "resolveWebdavConflicts":
        if (
          Array.isArray(message.ids) &&
          (message.resolution === "local" || message.resolution === "remote")
        ) {
          const ids = message.ids.filter(
            (id): id is string => typeof id === "string",
          );
          if (ids.length > 0) {
            await getActiveConfigSyncService()?.resolveConflicts(
              ids,
              message.resolution,
            );
          }
        }
        break;
      case "openWebdavDiff":
        if (typeof message.id === "string") {
          await getActiveConfigSyncService()?.openDiff(message.id);
        }
        break;
      default:
        break;
    }
  }

  private async handleUpdateFontSize(fontSize: number | undefined): Promise<void> {
    if (typeof fontSize !== "number" || !Number.isFinite(fontSize)) {
      return;
    }

    const clamped = Math.min(25, Math.max(6, Math.round(fontSize)));
    await vscode.workspace
      .getConfiguration("opencode-cli-sidebar")
      .update("fontSize", clamped, vscode.ConfigurationTarget.Global);
  }

  /**
   * Open OpenCode global AGENTS.md, opencode.json/jsonc, or cli.json in the
   * VS Code editor. Creates a starter file when the target does not exist yet.
   */
  private async handleOpenOpenCodeGlobalFile(
    target: "agentsMd" | "opencodeJson" | "cliJson",
  ): Promise<void> {
    const filePath = ensureOpenCodeGlobalFile(target);
    await vscode.window.showTextDocument(vscode.Uri.file(filePath), {
      preview: false,
    });
  }

  /** Open the OpenCode config directory in the OS file manager. */
  private async openOpenCodeConfigDir(): Promise<void> {
    await vscode.env.openExternal(
      vscode.Uri.file(resolveOpenCodeConfigDir()),
    );
  }

  public handleTerminalInput(data: string | undefined): void {
    if (typeof data !== "string") {
      return;
    }

    this.terminalManager.writeToTerminal(this.provider.getActiveTerminalId(), data);
  }

  public handleTerminalResize(
    cols: number | undefined,
    rows: number | undefined,
  ): void {
    if (typeof cols !== "number" || typeof rows !== "number") {
      return;
    }

    this.provider.setLastKnownTerminalSize(cols, rows);
    this.terminalManager.resizeTerminal(
      this.provider.getActiveTerminalId(),
      cols,
      rows,
    );
  }

  public handleReady(
    cols: number | undefined,
    rows: number | undefined,
  ): void {
    if (typeof cols === "number" && typeof rows === "number") {
      this.provider.setLastKnownTerminalSize(cols, rows);
    }

    if (!this.provider.isStarted()) {
      void this.provider.startOpenCode();
    } else {
      const size = this.provider.getLastKnownTerminalSize();
      if (size.cols && size.rows) {
        this.provider.resizeActiveTerminal(size.cols, size.rows);
      }
      // The webview (re)loaded after the session was already started:
      // earlier activeSession posts may have been dropped before the
      // webview script attached its listener, so re-send the snapshot.
      this.provider.resendActiveSession();
    }

    this.provider.postWebviewMessage({
      type: "platformInfo",
      platform: process.platform,
      activeBackend: "native" as TerminalBackendType,
    });
  }

  public async handleOpenFile(
    filePath: string,
    line?: number,
    endLine?: number,
    column?: number,
  ): Promise<void> {
    await openFileInEditor(filePath, line, endLine, column, (message) => {
      this.logger.error(message);
    });
  }

  public async handleFilesDropped(
    files: string[],
    shiftKey: boolean,
    dropCell?: { col: number; row: number },
    blobFiles?: DroppedBlobFile[],
  ): Promise<void> {
    this.logger.info(
      `[PROVIDER] handleFilesDropped - files: ${JSON.stringify(files)} shiftKey: ${shiftKey} dropCell: ${JSON.stringify(dropCell)}`,
    );

    const normalizedFiles = files.map((file) => {
      if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(file)) {
        try {
          return vscode.Uri.parse(file).fsPath;
        } catch {
        }
      }
      return file;
    });

    let dedupedFiles = [
      ...new Set(normalizedFiles.map((p) => path.normalize(p))),
    ];

    if (dedupedFiles.length === 0 && blobFiles && blobFiles.length > 0) {
      const materializedBlobPaths =
        await this.materializeDroppedBlobFiles(blobFiles);
      dedupedFiles = [
        ...new Set(materializedBlobPaths.map((p) => path.normalize(p))),
      ];
    }

    if (dedupedFiles.length === 0) {
      this.logger.warn("[PROVIDER] No usable dropped file paths were resolved");
      return;
    }

    const terminalId = this.provider.getActiveTerminalId();

    if (shiftKey) {
      const fileRefs = this.provider.formatDroppedFiles(
        dedupedFiles.map(toRelativeReference),
        true,
      );
      this.logger.info(`[PROVIDER] Writing with @: ${fileRefs}`);

      this.terminalManager.writeToTerminal(terminalId, fileRefs + " ");
    } else {
      const filePaths = this.provider.formatDroppedFiles(
        dedupedFiles.map(toRelativeReference),
        false,
      );
      this.logger.info(`[PROVIDER] Writing without @: ${filePaths}`);
      this.terminalManager.writeToTerminal(terminalId, filePaths + " ");
    }
  }

  public async handlePaste(): Promise<void> {
    try {
      const text = await vscode.env.clipboard.readText();
      if (text) {
        this.provider.pasteText(text);
        return;
      }
    } catch (error) {
      this.logger.error(
        `[TerminalProvider] Failed to paste: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // No text in clipboard — delegate to webview for image detection.
    // The webview will try navigator.clipboard.read() and send
    // imagePasted if an image is found.  We do NOT fall back to
    // triggerPaste from the webview to avoid an infinite loop.
    this.provider.postWebviewMessage({ type: "requestPaste" });
  }

  public async handleSetClipboard(text: string): Promise<void> {
    try {
      await vscode.env.clipboard.writeText(text);
    } catch (error) {
      this.logger.error(
        `[TerminalProvider] Failed to write clipboard: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  public async handleImagePasted(data: string): Promise<void> {
    try {
      const parsedDataUrl = this.parseDataUrl(data);
      if (!parsedDataUrl) {
        this.logger.error("[TerminalProvider] Invalid image data URL format");
        return;
      }

      const { mimeType, buffer } = parsedDataUrl;
      if (!ALLOWED_IMAGE_TYPES.includes(mimeType)) {
        this.logger.error(
          `[TerminalProvider] Unsupported image type: ${mimeType}`,
        );
        return;
      }

      if (buffer.length > MAX_IMAGE_SIZE) {
        this.logger.error("[TerminalProvider] Image exceeds 10MB size limit");
        return;
      }

      const extension = mimeType.split("/")[1];
      const tmpPath = await this.writeSecureTempFile(
        `opencode-clipboard-${randomUUID()}.${extension}`,
        buffer,
      );

      const formattedImage = this.provider.formatPastedImage(tmpPath);
      if (formattedImage) {
        this.provider.pasteText(formattedImage);
      }

      this.scheduleTempFileCleanup(tmpPath);
    } catch (error) {
      this.logger.error(
        `[TerminalProvider] Failed to handle pasted image: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private parseDataUrl(
    data: string,
  ): { mimeType: string; buffer: Buffer } | undefined {
    const base64Match = data.match(
      /^data:([a-zA-Z0-9/+.-]+);base64,([A-Za-z0-9+/=]+)$/,
    );
    if (!base64Match) {
      return undefined;
    }

    return {
      mimeType: base64Match[1],
      buffer: Buffer.from(base64Match[2], "base64"),
    };
  }

  private sanitizeDroppedBlobFileName(name: string): string {
    const baseName = name.split(/[\\/]/).pop()?.trim() || "dropped-file";
    const sanitized = baseName.replace(/[^a-zA-Z0-9._-]/g, "_");
    return sanitized.length > 0 ? sanitized : "dropped-file";
  }

  private async writeSecureTempFile(
    fileName: string,
    buffer: Buffer,
  ): Promise<string> {
    const tmpPath = path.join(os.tmpdir(), fileName);
    await fs.promises.writeFile(tmpPath, buffer, {
      flag: "wx",
      mode: 0o600,
    });
    return tmpPath;
  }

  private scheduleTempFileCleanup(tmpPath: string): void {
    setTimeout(
      async () => {
        try {
          await fs.promises.unlink(tmpPath);
          this.logger.debug(
            `[TerminalProvider] Cleaned up temp file: ${tmpPath}`,
          );
        } catch (err) {
          this.logger.warn(
            `[TerminalProvider] Failed to cleanup temp file: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      5 * 60 * 1000,
    );
  }

  private async materializeDroppedBlobFiles(
    blobFiles: DroppedBlobFile[],
  ): Promise<string[]> {
    const materializedPaths: string[] = [];

    for (const blobFile of blobFiles) {
      try {
        const parsedDataUrl = this.parseDataUrl(blobFile.data);
        if (!parsedDataUrl) {
          this.logger.error(
            `[TerminalProvider] Invalid dropped blob data URL for ${blobFile.name}`,
          );
          continue;
        }

        if (parsedDataUrl.buffer.length > MAX_IMAGE_SIZE) {
          this.logger.error(
            `[TerminalProvider] Dropped file exceeds 10MB size limit: ${blobFile.name}`,
          );
          continue;
        }

        const safeName = this.sanitizeDroppedBlobFileName(blobFile.name);
        const tmpPath = await this.writeSecureTempFile(
          `opencode-drop-${randomUUID()}-${safeName}`,
          parsedDataUrl.buffer,
        );
        this.scheduleTempFileCleanup(tmpPath);
        materializedPaths.push(tmpPath);
      } catch (error) {
        this.logger.error(
          `[TerminalProvider] Failed to materialize dropped blob ${blobFile.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return materializedPaths;
  }

  public async handleListTerminals(): Promise<void> {
    const terminals = await this.getTerminalEntries();
    this.provider.postWebviewMessage({
      type: "terminalList",
      terminals,
    });
  }

  public async sendCommandToTerminal(
    terminal: vscode.Terminal,
    command: string,
  ): Promise<void> {
    const configKey = "opencode-cli-sidebar.allowTerminalCommands";
    const allowed = this.context.globalState.get<boolean>(configKey);

    if (allowed) {
      terminal.sendText(command);
      return;
    }

    const result = await vscode.window.showInformationMessage(
      l10n.t("Allow OpenCode to send commands to external terminals?"),
      l10n.t("Yes"),
      l10n.t("Yes, don't ask again"),
      l10n.t("No"),
    );

    if (result === l10n.t("Yes")) {
      terminal.sendText(command);
      return;
    }

    if (result === l10n.t("Yes, don't ask again")) {
      await this.context.globalState.update(configKey, true);
      terminal.sendText(command);
    }
  }

  public startTerminalCapture(
    terminal: vscode.Terminal,
    terminalName: string,
  ): void {
    const result = this.captureManager.startCapture(terminal);
    if (result.success) {
      void vscode.window.showInformationMessage(
        l10n.t("Started capturing terminal: {terminalName}", { terminalName }),
      );
      return;
    }

    void vscode.window.showErrorMessage(
      l10n.t("Failed to start capture: {error}", { error: result.error ?? "Unknown error" }),
    );
  }

  public async getTerminalEntries(): Promise<
    Array<{ name: string; cwd: string }>
  > {
    const entries: Array<{ name: string; cwd: string }> = [];

    for (const terminal of vscode.window.terminals) {
      if (terminal.name === "OpenCode CLI Sidebar") {
        continue;
      }

      let cwd = "";
      try {
        cwd = terminal.shellIntegration?.cwd?.fsPath ?? "";
      } catch {
        cwd = "";
      }

      entries.push({
        name: terminal.name,
        cwd,
      });
    }

    return entries;
  }

  public createSelection(
    line?: number,
    endLine?: number,
    column?: number,
  ): vscode.Range | undefined {
    return createSelection(line, endLine, column);
  }

  public async fuzzyMatchFile(filePath: string): Promise<vscode.Uri | null> {
    return fuzzyMatchFile(filePath, (message) => {
      this.logger.error(message);
    });
  }
}
