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
  renderFontSizeCurrent(getTerminal);
  return true;
}

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

function renderFontSizeCurrent(getTerminal: () => Terminal | null): void {
  const label = document.getElementById("font-size-current");
  if (!label) {
    return;
  }
  const size = getTerminal()?.options.fontSize ?? DEFAULT_FONT_SIZE;
  label.textContent = formatFontSizeLabel(size);
}

export function setupFontSizeMenu(
  getTerminal: () => Terminal | null,
  getFitAddon: () => FitAddon | null,
): void {
  const btn = document.getElementById("btn-font-size");
  const dropdown = document.getElementById("dropdown-font-size");
  if (!btn || !dropdown) {
    return;
  }

  const setOpen = (open: boolean): void => {
    dropdown.classList.toggle("hidden", !open);
    btn.setAttribute("aria-expanded", String(open));
    if (open) {
      closeSettingsDropdown?.();
      renderFontSizeCurrent(getTerminal);
    }
  };
  const close = (): void => setOpen(false);

  registerDropdownClose("fontSize", close);

  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    setOpen(dropdown.classList.contains("hidden"));
  });
  // The menu stays open across item clicks so sizes can be stepped repeatedly.
  dropdown.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  const applyDelta = (delta: number): void => {
    const terminal = getTerminal();
    if (!terminal) {
      return;
    }
    const current = terminal.options.fontSize ?? DEFAULT_FONT_SIZE;
    applyFontSize(current + delta, getTerminal, getFitAddon);
    renderFontSizeCurrent(getTerminal);
  };

  const reset = (): void => {
    const terminal = getTerminal();
    if (!terminal) {
      return;
    }
    if ((terminal.options.fontSize ?? DEFAULT_FONT_SIZE) !== DEFAULT_FONT_SIZE) {
      applyFontSize(DEFAULT_FONT_SIZE, getTerminal, getFitAddon);
    } else {
      postMessage({ type: "updateFontSize", fontSize: DEFAULT_FONT_SIZE });
    }
    renderFontSizeCurrent(getTerminal);
  };

  dropdown.querySelectorAll<HTMLElement>(".settings-option").forEach((item) => {
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      const action = item.dataset.action;
      if (action === "increaseFontSize") {
        applyDelta(1);
      } else if (action === "decreaseFontSize") {
        applyDelta(-1);
      } else if (action === "resetFontSize") {
        reset();
      }
    });
  });

  renderFontSizeCurrent(getTerminal);
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

// Document-level listeners close open toolbar dropdowns when a click lands
// anywhere outside them (their own buttons and items stop propagation).
let closeSettingsDropdown: (() => void) | null = null;
let closeFontSizeDropdown: (() => void) | null = null;
let dropdownCloseListenersAttached = false;

function registerDropdownClose(
  target: "settings" | "fontSize",
  close: () => void,
): void {
  if (target === "settings") {
    closeSettingsDropdown = close;
  } else {
    closeFontSizeDropdown = close;
  }
  if (dropdownCloseListenersAttached) return;
  dropdownCloseListenersAttached = true;
  document.addEventListener("click", () => {
    closeSettingsDropdown?.();
    closeFontSizeDropdown?.();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeFontSizeDropdown?.();
    }
  });
}

export function setupSettingsButton(): void {
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

  registerDropdownClose("settings", () => closeDropdown());

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!dropdown.classList.contains("hidden")) {
      closeDropdown();
    } else {
      closeFontSizeDropdown?.();
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
      if (action === "toggleEditor") {
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
