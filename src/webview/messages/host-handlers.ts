import type { HostMessage } from "../../types";
import type { TerminalHandle } from "../terminal/useTerminal";
import { createMessageHandler, type MessageHandlerCallbacks } from "./index";
import { showServiceRestartPrompt } from "../service-restart-prompt";
import { setSendKeybindingsToShell } from "../terminal/keyboard";
import { applyStartupPhase } from "../startup-status";
import { updateEditorAttachmentIcon } from "../toolbar";
import {
  applyKeymapData,
  handleKeymapSaveResult,
  showKeymapError,
  setKeymapOpenCodeV2,
  setOpenCodeSlimAvailable,
} from "../keymap";
import {
  applyOpenCodeCliSettingsData,
  clearOpenCodeCliPluginRestartPending,
  handleOpenCodeCliPluginUpdateCheckResult,
  handleOpenCodeCliSettingsSaveResult,
  showOpenCodeCliSettingsError,
} from "../opencode-cli-settings";
import {
  applyOpenCodeUpdateStatus,
  applyOpenCodeChangelog,
  applyOpenCodeChangelogTranslation,
  appendOpenCodeUpdateOutput,
} from "../update";
import {
  applyWebdavLog,
  applyWebdavSaveResult,
  applyWebdavSyncData,
  applyWebdavStatus,
  applyWebdavTestResult,
} from "../sync";
import { createFocusIndicator } from "../terminal/focus-indicator";

/**
 * Bridges host pushes into the imperative feature controllers.
 *
 * These controllers still own their own DOM; this module is the single place
 * that translates `HostMessage` variants into their entry points, replacing
 * the callback table that used to live in `main.ts`.
 *
 * `getTerminal` is a live accessor rather than a snapshot: this handler is
 * installed before xterm finishes mounting, and `terminalOutput` arriving
 * before the handle exists would otherwise be dropped (black terminal).
 */
export function installHostMessageHandlers(
  getTerminal: () => TerminalHandle | null,
): void {
  const focusIndicator = createFocusIndicator();

  const callbacks: MessageHandlerCallbacks = {
    onActiveSession(message) {
      const toolbarControls = document.querySelector(".toolbar-controls");
      if (toolbarControls) {
        toolbarControls.classList.add("hidden");
      }
      setKeymapOpenCodeV2(Boolean(message.openCodeV2));
      setOpenCodeSlimAvailable(Boolean(message.hasOhMyOpenCodeSlim));
    },

    onShowServiceRestartPrompt() {
      showServiceRestartPrompt();
    },

    onPlatformInfo() {},

    onTerminalConfig(message) {
      if (message.isEditorTab !== undefined) {
        updateEditorAttachmentIcon(message.isEditorTab);
      }
      if (message.sendKeybindingsToShell !== undefined) {
        setSendKeybindingsToShell(message.sendKeybindingsToShell);
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
    },

    onOpenCodeUpdateStatus(message) {
      applyOpenCodeUpdateStatus(message.status);
    },

    onOpenCodeChangelog(message) {
      applyOpenCodeChangelog(message.payload);
    },

    onOpenCodeChangelogTranslation(message) {
      applyOpenCodeChangelogTranslation(message);
    },

    onOpenCodeUpdateOutput(message) {
      appendOpenCodeUpdateOutput(message.lines);
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

    onStartupPhase(message) {
      applyStartupPhase(message.phase);
    },
  };

  const handler = createMessageHandler(callbacks);

  window.addEventListener("message", (event: MessageEvent) => {
    // Resolve the terminal on every message: the handle is created in a later
    // React effect, so a snapshot taken here would stay null forever and every
    // `terminalOutput` would be dropped.
    const handle = getTerminal();
    handler.terminal = handle?.terminal ?? null;
    handler.fitAddon = handle?.fitAddon ?? null;
    handler.handleEvent(event as MessageEvent<HostMessage>);
  });
}
