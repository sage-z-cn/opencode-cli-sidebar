
import "@xterm/xterm/css/xterm.css";
import type { HostMessage } from "../types";
import { TerminalManager } from "./terminal-manager";
import {
  copySelectionToClipboard,
  handlePasteEventWithImageSupport,
} from "./clipboard";
import { postMessage } from "./shared/vscode-api";
import { showServiceRestartPrompt } from "./service-restart-prompt";
import { initTerminal, type TerminalInstance } from "./terminal";
import { readTerminalConfig } from "./terminal/config";
import { createFocusIndicator } from "./terminal/focus-indicator";
import { createMessageHandler, type MessageHandlerCallbacks } from "./messages";
import {
  setupReloadButton,
  setupFontSizeButtons,
  setupSettingsButton,
  updateEditorAttachmentIcon,
} from "./toolbar";
import {
  applyKeymapData,
  handleKeymapSaveResult,
  initKeymapUi,
  openKeymapModal,
  showKeymapError,
  setKeymapOpenCodeV2,
} from "./keymap";
import {
  applyOpenCodeCliSettingsData,
  clearOpenCodeCliPluginRestartPending,
  handleOpenCodeCliPluginUpdateCheckResult,
  handleOpenCodeCliSettingsSaveResult,
  initOpenCodeCliSettingsUi,
  openOpenCodeCliSettingsModal,
  showOpenCodeCliSettingsError,
} from "./opencode-cli-settings";
import {
  applyOpenCodeUpdateStatus,
  applyOpenCodeChangelog,
  initOpenCodeUpdateUi,
  notifyOpenCodeSessionStarted,
} from "./update";
import {
  applyWebdavLog,
  applyWebdavSaveResult,
  applyWebdavSyncData,
  applyWebdavStatus,
  applyWebdavTestResult,
  initSyncUi,
} from "./sync";

const focusIndicator = createFocusIndicator();

const callbacks: MessageHandlerCallbacks = {
  onActiveSession(message) {
    const toolbarControls = document.querySelector(".toolbar-controls");

    if (toolbarControls) {
      toolbarControls.classList.add("hidden");
    }

    setKeymapOpenCodeV2(Boolean(message.openCodeV2));
  },

  onShowServiceRestartPrompt(message) {
    void message;
    showServiceRestartPrompt();
  },

  onPlatformInfo(message) {
    void message;
  },

  onTerminalConfig(message) {
    if (message.isEditorTab !== undefined) {
      updateEditorAttachmentIcon(message.isEditorTab);
    }
  },

  onKeymapData(message) {
    applyKeymapData(message);
  },

  onKeymapSaveResult(message) {
    if (!message.ok && message.error) {
      console.warn("keymap save failed", message.error);
    }
    handleKeymapSaveResult(message);
  },

  onKeymapError(message) {
    console.warn("keymap load failed", message.error);
    showKeymapError();
  },

  onOpenCodeCliSettingsData(message) {
    applyOpenCodeCliSettingsData(message);
  },

  onOpenCodeCliSettingsSaveResult(message) {
    if (!message.ok && message.error) {
      console.warn("openCode settings save failed", message.error);
    }
    handleOpenCodeCliSettingsSaveResult(message);
  },

  onOpenCodeCliSettingsError(message) {
    console.warn("openCode settings load failed", message.error);
    showOpenCodeCliSettingsError(message.error);
  },

  onOpenCodeCliPluginUpdateCheckResult(message) {
    handleOpenCodeCliPluginUpdateCheckResult(message);
  },

  onOpenCodeSessionStarted() {
    clearOpenCodeCliPluginRestartPending();
    notifyOpenCodeSessionStarted();
  },

  onOpenCodeUpdateStatus(message) {
    applyOpenCodeUpdateStatus(message.status);
  },

  onOpenCodeChangelog(message) {
    applyOpenCodeChangelog(message.payload);
  },

  onWebdavSyncData(message) {
    applyWebdavSyncData(message.snapshot);
  },

  onWebdavSyncStatus(message) {
    applyWebdavStatus(message.delta);
  },

  onWebdavTestResult(message) {
    applyWebdavTestResult(message.ok, message.latencyMs, message.message);
  },

  onWebdavSaveResult(message) {
    applyWebdavSaveResult(message.ok, message.error);
  },

  onWebdavLog(message) {
    applyWebdavLog(message.lines);
  },

  onFocusIndicatorConfig(mode, width) {
    focusIndicator.update(mode, width);
  },
};

const messageHandler = createMessageHandler(callbacks);

let terminalManager: TerminalManager | null = null;
let terminalInstance: TerminalInstance | null = null;

function disposeTerminal(): void {
  terminalInstance?.dispose();
  terminalInstance = null;
  terminalManager?.destroy();
  terminalManager = null;
}

function initApp(): void {
  // Clean up previous instance if webview is reused
  disposeTerminal();

  const container = document.getElementById("terminal-container");
  if (!container) return;

  const focusConfig = readTerminalConfig(container);
  focusIndicator.update(
    focusConfig.focusIndicatorMode,
    focusConfig.focusIndicatorBorderWidth,
  );

  const instance = initTerminal(container, {
    onData: (data) => {
      postMessage({ type: "terminalInput", data });
    },
    onResize: (cols, rows) => {
      postMessage({ type: "terminalResize", cols, rows });
    },
  });
  terminalInstance = instance;

  if (instance) {
    messageHandler.terminal = instance.terminal;
    messageHandler.fitAddon = instance.fitAddon;
  }

  terminalManager = new TerminalManager();
  terminalManager.init(container);
  terminalManager.register(instance?.terminal ?? null, instance?.fitAddon ?? null, container);

  container.addEventListener(
    "paste",
    (event: ClipboardEvent) => {
      if (!handlePasteEventWithImageSupport(event)) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
    },
    { capture: true },
  );

  container.addEventListener(
    "copy",
    (event: ClipboardEvent) => {
      const selection = instance?.terminal.hasSelection()
        ? instance.terminal.getSelection()
        : "";
      if (!selection) {
        return;
      }

      event.preventDefault();
      copySelectionToClipboard(selection);
    },
    { capture: true },
  );

  setupReloadButton();
  setupFontSizeButtons(
    () => messageHandler.terminal,
    () => messageHandler.fitAddon,
  );
  setupSettingsButton({
    getTerminal: () => messageHandler.terminal,
    getFitAddon: () => messageHandler.fitAddon,
  });
  document.getElementById("btn-keymap")?.addEventListener("click", () => {
    openKeymapModal();
  });
  document.getElementById("btn-oc-cli-settings")?.addEventListener("click", () => {
    openOpenCodeCliSettingsModal();
  });
  document.getElementById("btn-oc-agents-md")?.addEventListener("click", () => {
    postMessage({ type: "openOpenCodeGlobalFile", target: "agentsMd" });
  });
  document.getElementById("btn-oc-config-json")?.addEventListener("click", () => {
    postMessage({ type: "openOpenCodeGlobalFile", target: "opencodeJson" });
  });
  initKeymapUi();
  initOpenCodeCliSettingsUi();
  initOpenCodeUpdateUi();
  initSyncUi();

  window.addEventListener("message", (event: MessageEvent) => {
    messageHandler.handleEvent(event as MessageEvent<HostMessage>);
  });
}

const boot = () => {
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => initApp());
  } else {
    initApp();
  }
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
