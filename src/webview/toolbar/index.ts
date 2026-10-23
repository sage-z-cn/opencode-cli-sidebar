import { postMessage } from "../shared/vscode-api";
import { ICONS, icon } from "../shared/icons";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { scheduleRefresh } from "../shared/utils";
import { fitFullWidth } from "../terminal/fit";
import { notifyOpenCodeUpdateCheckRequested } from "../update";

/** Matches package.json `opencode-cli-sidebar.fontSize` bounds/default. */
const MIN_FONT_SIZE = 6;
const MAX_FONT_SIZE = 25;
const DEFAULT_FONT_SIZE = 12;
const FONT_SIZE_TOOLTIP_MS = 3000;

// ── Toolbar buttons ──

export function setupReloadButton(): void {
  document.getElementById("btn-restart")?.addEventListener("click", () => {
    postMessage({ type: "requestRestart" });
  });
}

export function applyFontSize(
  next: number,
  getTerminal: () => Terminal | null,
  getFitAddon: () => FitAddon | null,
): boolean {
  const terminal = getTerminal();
  if (!terminal) {
    return false;
  }

  const clamped = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, next));
  const current = terminal.options.fontSize ?? DEFAULT_FONT_SIZE;
  if (clamped === current) {
    return false;
  }

  terminal.options.fontSize = clamped;
  const fitAddon = getFitAddon();
  if (fitAddon) {
    fitFullWidth(terminal, fitAddon);
  }
  scheduleRefresh(() => terminal.refresh(0, terminal.rows - 1));
  postMessage({ type: "updateFontSize", fontSize: clamped });
  showFontSizeTooltip(clamped);
  return true;
}

let fontSizeTooltipTimer: ReturnType<typeof setTimeout> | null = null;

function formatFontSizeLabel(size: number): string {
  if (size === DEFAULT_FONT_SIZE) {
    const strings =
      (window as unknown as { __TOOLBAR_L10N__?: Record<string, string> })
        .__TOOLBAR_L10N__ ?? {};
    const defaultLabel = strings.default ?? "default";
    return `${size}px (${defaultLabel})`;
  }
  return `${size}px`;
}

export function showFontSizeTooltip(size: number): void {
  const tooltip = document.getElementById("font-size-tooltip");
  if (!tooltip) {
    return;
  }

  tooltip.textContent = formatFontSizeLabel(size);
  tooltip.classList.remove("hidden");

  if (fontSizeTooltipTimer !== null) {
    clearTimeout(fontSizeTooltipTimer);
  }
  fontSizeTooltipTimer = setTimeout(() => {
    tooltip.classList.add("hidden");
    fontSizeTooltipTimer = null;
  }, FONT_SIZE_TOOLTIP_MS);
}

export function disposeFontSizeTooltip(): void {
  if (fontSizeTooltipTimer !== null) {
    clearTimeout(fontSizeTooltipTimer);
    fontSizeTooltipTimer = null;
  }
  document.getElementById("font-size-tooltip")?.classList.add("hidden");
}

export function setupFontSizeButtons(
  getTerminal: () => Terminal | null,
  getFitAddon: () => FitAddon | null,
): void {
  const applyDelta = (delta: number): void => {
    const terminal = getTerminal();
    if (!terminal) {
      return;
    }

    const current = terminal.options.fontSize ?? DEFAULT_FONT_SIZE;
    if (applyFontSize(current + delta, getTerminal, getFitAddon)) {
      return;
    }
    // Already at min/max: still surface the current size so the user
    // gets feedback that the click registered.
    showFontSizeTooltip(current);
  };

  document.getElementById("btn-font-increase")?.addEventListener("click", () => {
    applyDelta(1);
  });
  document.getElementById("btn-font-decrease")?.addEventListener("click", () => {
    applyDelta(-1);
  });
}

export function updateEditorAttachmentIcon(isEditorTab: boolean): void {
  const strings =
    (window as unknown as { __TOOLBAR_L10N__?: Record<string, string> })
      .__TOOLBAR_L10N__ ?? {};
  const iconEl = document.getElementById("settings-toggle-editor-icon");
  const label = document.getElementById("settings-toggle-editor-label");
  if (iconEl) {
    iconEl.innerHTML = isEditorTab
      ? icon(ICONS.arrowUpLeft)
      : icon(ICONS.arrowUpRight);
  }
  if (label) {
    label.textContent = isEditorTab
      ? (strings.switchToSidebar ?? "Switch to Sidebar")
      : (strings.switchToEditor ?? "Switch to Editor");
  }
}

// ── Settings button (dropdown menu) ──

/** Delay in ms before auto-closing settings dropdown on mouse leave. */
const SETTINGS_CLOSE_DELAY_MS = 200;

// Document-level click listener: closes the settings dropdown when a
// click lands anywhere outside it (its own button and items stop propagation).
let closeSettingsDropdown: (() => void) | null = null;
let outsideClickListenerAttached = false;

function registerSettingsDropdownClose(close: () => void): void {
  closeSettingsDropdown = close;
  if (outsideClickListenerAttached) return;
  outsideClickListenerAttached = true;
  document.addEventListener("click", () => {
    closeSettingsDropdown?.();
  });
}

export function setupSettingsButton(options?: {
  getTerminal?: () => Terminal | null;
  getFitAddon?: () => FitAddon | null;
}): void {
  const btn = document.getElementById("btn-settings");
  const dropdown = document.getElementById("dropdown-settings");
  const host = document.querySelector(".settings-host");

  if (!btn || !dropdown) return;

  let leaveTimer: ReturnType<typeof setTimeout> | null = null;

  function closeDropdown(): void {
    dropdown!.classList.add("hidden");
    if (leaveTimer !== null) {
      clearTimeout(leaveTimer);
      leaveTimer = null;
    }
  }

  function scheduleClose(): void {
    if (leaveTimer !== null) clearTimeout(leaveTimer);
    leaveTimer = setTimeout(() => closeDropdown(), SETTINGS_CLOSE_DELAY_MS);
  }

  registerSettingsDropdownClose(() => closeDropdown());

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!dropdown.classList.contains("hidden")) {
      closeDropdown();
    } else {
      dropdown.classList.remove("hidden");
    }
  });

  host?.addEventListener("pointerleave", () => {
    if (!dropdown.classList.contains("hidden")) scheduleClose();
  });

  host?.addEventListener("pointerenter", () => {
    if (leaveTimer !== null) {
      clearTimeout(leaveTimer);
      leaveTimer = null;
    }
  });

  dropdown.querySelectorAll(".settings-option").forEach((item) => {
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      const action = (item as HTMLElement).dataset.action;
      if (action === "resetFontSize") {
        const getTerminal = options?.getTerminal ?? (() => null);
        const getFitAddon = options?.getFitAddon ?? (() => null);
        const terminal = getTerminal();
        if (terminal && (terminal.options.fontSize ?? DEFAULT_FONT_SIZE) !== DEFAULT_FONT_SIZE) {
          applyFontSize(DEFAULT_FONT_SIZE, getTerminal, getFitAddon);
        } else {
          postMessage({ type: "updateFontSize", fontSize: DEFAULT_FONT_SIZE });
          showFontSizeTooltip(DEFAULT_FONT_SIZE);
        }
      } else if (action === "toggleEditor") {
        postMessage({ type: "toggleEditorAttachment" });
      } else if (action === "checkOpenCodeUpdate") {
        const item = document.getElementById("menu-oc-update-check");
        // Update in flight: the check cannot run until it finishes.
        if (!item?.classList.contains("is-disabled")) {
          notifyOpenCodeUpdateCheckRequested();
          postMessage({ type: "checkOpenCodeUpdates" });
        }
      } else if (action === "keyboardShortcuts") {
        postMessage({ type: "openKeyboardShortcuts" });
      } else {
        postMessage({ type: "openSettings" });
      }
      closeDropdown();
    });
  });
}
