import { useEffect, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { ICONS, icon } from "../shared/icons";
import { t } from "../shared/i18n/core";
import {
  setupFontSizeMenu,
  setupReloadButton,
  setupSettingsButton,
  updateEditorAttachmentIcon,
} from "./index";
import { postMessage } from "../shared/vscode-api";
import { openExtensionSettingsDialog } from "../extension-settings";
import { notifyOpenCodeUpdateCheckRequested } from "../update";
import type { TerminalHandle } from "../terminal/useTerminal";
import template from "../terminal/toolbar.html?raw";

/** Placeholder -> l10n source string. Keys match `{{t:<key>}}` in the template. */
const TITLE_KEYS: Record<string, string> = {
  toggleEditor: "Switch to Editor",
  restart: "Restart Terminal",
  fontDecrease: "Decrease Font Size",
  fontIncrease: "Increase Font Size",
  fontReset: "Reset Font Size",
  fontSize: "Font Size",
  settings: "Settings",
  extensionSettings: "Extension Settings",
  keybindSettings: "Keyboard Shortcut Settings",
  keymap: "OpenCode Keymap",
  openCodeCliSettings: "OpenCode CLI Config",
  openCodeGlobalAgentsMd: "Open Global AGENTS.md File",
  openCodeGlobalConfig: "Open OpenCode Config File",
  openCodeSlimConfig: "Open OMO-Slim Config File",
  openCodeUpdate: "Install OpenCode",
  checkOpenCodeUpdates: "Check for OpenCode Updates",
  davOpenPanel: "OpenCode config sync",
};

function localizeTitles(input: string): string {
  return input.replace(/\{\{t:(\w+)\}\}/g, (match, key: string) => {
    const source = TITLE_KEYS[key];
    return source ? t(source) : match;
  });
}

function localizeIcons(input: string): string {
  return input.replace(
    /\{\{icon:(\w+)(?::(\d+))?\}\}/g,
    (match, key: string, size: string | undefined) => {
      const node = ICONS[key as keyof typeof ICONS];
      return node ? icon(node, size ? Number(size) : 14) : match;
    },
  );
}

interface ToolbarProps {
  /** Live xterm handle, or null before the terminal mounts. */
  getHandle: () => TerminalHandle | null;
}

/**
 * Toolbar shell.
 *
 * The markup stays the exact string the DOM entry used, injected once via
 * `dangerouslySetInnerHTML`. That keeps every id/class the imperative
 * controllers look up (`btn-restart`, `dropdown-settings`, ...) unchanged, so
 * `setupFontSizeMenu`/`setupSettingsButton` keep working untouched. Turning
 * this into a component tree is a separate refactor: the dropdowns rely on
 * document-level click and pointer-leave semantics that must move in one piece.
 */
export function Toolbar({ getHandle }: ToolbarProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const getHandleRef = useRef<() => TerminalHandle | null>(getHandle);
  getHandleRef.current = getHandle;

  useEffect(() => {
    // `getHandleRef` is read lazily so the toolbar always sees the terminal
    // mounted after this effect ran.
    const getTerminal = (): Terminal | null =>
      getHandleRef.current()?.terminal ?? null;
    const getFitAddon = (): FitAddon | null =>
      getHandleRef.current()?.fitAddon ?? null;

    // Deferred one frame: `useTerminal` mounts xterm in a sibling effect that
    // runs after this one, and `setupFontSizeMenu` reads the live font size
    // immediately to seed its label.
    let frame = 0;
    let disposed = false;
    frame = requestAnimationFrame(() => {
      if (disposed) {
        return;
      }
      setupReloadButton();
      setupFontSizeMenu(getTerminal, getFitAddon);
      setupSettingsButton();
    });

    const onClick = (id: string, handler: () => void): void => {
      document.getElementById(id)?.addEventListener("click", handler);
    };

    onClick("btn-keymap", () => {
      void import("../keymap").then((m) => m.openKeymapModal());
    });
    onClick("btn-oc-cli-settings", () => {
      void import("../opencode-cli-settings").then((m) =>
        m.openOpenCodeCliSettingsModal(),
      );
    });
    onClick("btn-oc-agents-md", () => {
      postMessage({ type: "openOpenCodeGlobalFile", target: "agentsMd" });
    });
    onClick("btn-oc-config-json", () => {
      postMessage({ type: "openOpenCodeGlobalFile", target: "opencodeJson" });
    });
    onClick("btn-oc-slim-config", () => {
      postMessage({
        type: "openOpenCodeGlobalFile",
        target: "ohMyOpenCodeSlim",
      });
    });

    // Referenced so tree-shaking keeps the lazy chunks' dependencies alive.
    void openExtensionSettingsDialog;
    void notifyOpenCodeUpdateCheckRequested;

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
    };
  }, []);

  const markup = localizeIcons(localizeTitles(template));

  return (
    <div
      ref={hostRef}
      dangerouslySetInnerHTML={{ __html: markup }}
      style={{ display: "contents" }}
    />
  );
}

/** Re-export so `messages/` can flip the editor/sidebar label after a tab move. */
export { updateEditorAttachmentIcon };
