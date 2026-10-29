import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { HostMessage, type FocusIndicatorMode } from "../../types";
import { handlePasteWithImageSupport } from "../clipboard";
import { postMessage } from "../shared/vscode-api";
import { scheduleRefresh } from "../shared/utils";
import { fitFullWidth } from "../terminal/fit";
import { isInstallPromptVisible } from "../update";

export interface MessageHandlerCallbacks {
  onActiveSession: (
    message: Extract<HostMessage, { type: "activeSession" }>,
  ) => void;
  onShowServiceRestartPrompt?: (
    message: Extract<HostMessage, { type: "showServiceRestartPrompt" }>,
  ) => void;
  onPlatformInfo?: (
    message: Extract<HostMessage, { type: "platformInfo" }>,
  ) => void;
  onTerminalConfig?: (
    message: Extract<HostMessage, { type: "terminalConfig" }>,
  ) => void;
  onFocusIndicatorConfig?: (mode: FocusIndicatorMode, width: number) => void;
  onKeymapData?: (
    message: Extract<HostMessage, { type: "keymapData" }>,
  ) => void;
  onKeymapSaveResult?: (
    message: Extract<HostMessage, { type: "keymapSaveResult" }>,
  ) => void;
  onKeymapError?: (
    message: Extract<HostMessage, { type: "keymapError" }>,
  ) => void;
  onOpenCodeCliSettingsData?: (
    message: Extract<HostMessage, { type: "openCodeCliSettingsData" }>,
  ) => void;
  onOpenCodeCliSettingsSaveResult?: (
    message: Extract<HostMessage, { type: "openCodeCliSettingsSaveResult" }>,
  ) => void;
  onOpenCodeCliSettingsError?: (
    message: Extract<HostMessage, { type: "openCodeCliSettingsError" }>,
  ) => void;
  onOpenCodeCliPluginUpdateCheckResult?: (
    message: Extract<
      HostMessage,
      { type: "openCodeCliPluginUpdateCheckResult" }
    >,
  ) => void;
  onOpenCodeSessionStarted?: (
    message: Extract<HostMessage, { type: "openCodeSessionStarted" }>,
  ) => void;
  onOpenCodeUpdateStatus?: (
    message: Extract<HostMessage, { type: "openCodeUpdateStatus" }>,
  ) => void;
  onOpenCodeChangelog?: (
    message: Extract<HostMessage, { type: "openCodeChangelog" }>,
  ) => void;
  onOpenCodeUpdateOutput?: (
    message: Extract<HostMessage, { type: "openCodeUpdateOutput" }>,
  ) => void;
  onWebdavSyncData?: (
    message: Extract<HostMessage, { type: "webdavSyncData" }>,
  ) => void;
  onWebdavSyncStatus?: (
    message: Extract<HostMessage, { type: "webdavSyncStatus" }>,
  ) => void;
  onWebdavTestResult?: (
    message: Extract<HostMessage, { type: "webdavTestResult" }>,
  ) => void;
  onWebdavSaveResult?: (
    message: Extract<HostMessage, { type: "webdavSaveResult" }>,
  ) => void;
  onWebdavLog?: (
    message: Extract<HostMessage, { type: "webdavLog" }>,
  ) => void;
}

export interface MessageHandler {
  terminal: Terminal | null;
  fitAddon: FitAddon | null;
  handleEvent: (event: MessageEvent<HostMessage>) => void;
}

function postTerminalResize(terminal: Terminal): void {
  postMessage({
    type: "terminalResize",
    cols: terminal.cols,
    rows: terminal.rows,
  });
}

export function createMessageHandler(
  callbacks: MessageHandlerCallbacks,
): MessageHandler {
  const state: MessageHandler = {
    terminal: null,
    fitAddon: null,
    handleEvent(event: MessageEvent<HostMessage>) {
      const message = event.data;
      const { terminal, fitAddon } = state;

      switch (message.type) {
        case "terminalOutput":
          if (terminal) {
            terminal.write(message.data);
          }
          break;

        case "terminalExited":
          if (terminal) {
            terminal.write("\r\n\x1b[31mOpenCode exited\x1b[0m\r\n");
          }
          break;

        case "clearTerminal":
          if (terminal) {
            terminal.clear();
            terminal.reset();
            if (fitAddon) {
              fitFullWidth(terminal, fitAddon);
              postTerminalResize(terminal);
            }
          }
          break;

        case "focusTerminal":
          // Never steal focus from the visible install confirmation:
          // its primary button owns the keyboard until answered.
          if (terminal && !isInstallPromptVisible()) {
            terminal.focus();
          }
          break;

        case "webviewVisible":
          setTimeout(() => {
            if (terminal && fitAddon) {
              fitFullWidth(terminal, fitAddon);
              scheduleRefresh(() => terminal.refresh(0, terminal.rows - 1));
              postTerminalResize(terminal);
            }
          }, 50);
          break;

        case "platformInfo":
          callbacks.onPlatformInfo?.(message);
          break;

        case "terminalConfig": {
          // Only touch xterm when a terminal-affecting field actually
          // changed. Focus-indicator-only updates must skip the refit:
          // fitting a hidden webview would shrink the PTY to minimum
          // dimensions until the next visible fit.
          if (terminal) {
            const options = terminal.options;
            const needsTerminalUpdate =
              options.fontSize !== message.fontSize ||
              options.fontFamily !== message.fontFamily ||
              options.cursorBlink !== message.cursorBlink ||
              options.cursorStyle !== message.cursorStyle;
            if (needsTerminalUpdate) {
              options.fontSize = message.fontSize;
              options.fontFamily = message.fontFamily;
              options.cursorBlink = message.cursorBlink;
              options.cursorStyle = message.cursorStyle;
              if (fitAddon) {
                fitFullWidth(terminal, fitAddon);
              }
              scheduleRefresh(() => terminal.refresh(0, terminal.rows - 1));
            }
          }
          callbacks.onTerminalConfig?.(message);
          callbacks.onFocusIndicatorConfig?.(
            message.focusIndicatorMode ?? "bottomBorder",
            message.focusIndicatorBorderWidth ?? 2,
          );
          break;
        }

        case "requestPaste":
          void handlePasteWithImageSupport();
          break;

        case "clipboardContent":
          if (message.text && terminal) {
            terminal.paste(message.text);
          }
          break;

        case "activeSession":
          callbacks.onActiveSession(message);
          break;

        case "showServiceRestartPrompt":
          callbacks.onShowServiceRestartPrompt?.(message);
          break;

        case "keymapData":
          callbacks.onKeymapData?.(message);
          break;

        case "keymapSaveResult":
          callbacks.onKeymapSaveResult?.(message);
          break;

        case "keymapError":
          callbacks.onKeymapError?.(message);
          break;

        case "openCodeCliSettingsData":
          callbacks.onOpenCodeCliSettingsData?.(message);
          break;

        case "openCodeCliSettingsSaveResult":
          callbacks.onOpenCodeCliSettingsSaveResult?.(message);
          break;

        case "openCodeCliSettingsError":
          callbacks.onOpenCodeCliSettingsError?.(message);
          break;

        case "openCodeCliPluginUpdateCheckResult":
          callbacks.onOpenCodeCliPluginUpdateCheckResult?.(message);
          break;

        case "openCodeSessionStarted":
          callbacks.onOpenCodeSessionStarted?.(message);
          break;

        case "openCodeUpdateStatus":
          callbacks.onOpenCodeUpdateStatus?.(message);
          break;

        case "openCodeChangelog":
          callbacks.onOpenCodeChangelog?.(message);
          break;

        case "openCodeUpdateOutput":
          callbacks.onOpenCodeUpdateOutput?.(message);
          break;

        case "webdavSyncData":
          callbacks.onWebdavSyncData?.(message);
          break;

        case "webdavSyncStatus":
          callbacks.onWebdavSyncStatus?.(message);
          break;

        case "webdavTestResult":
          callbacks.onWebdavTestResult?.(message);
          break;

        case "webdavSaveResult":
          callbacks.onWebdavSaveResult?.(message);
          break;

        case "webdavLog":
          callbacks.onWebdavLog?.(message);
          break;
      }
    },
  };

  return state;
}
