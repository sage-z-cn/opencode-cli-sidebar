import type { ITheme } from "@xterm/xterm";

/** Last-resort palette when the webview runs outside VS Code. */
export const FALLBACK_TERMINAL_BACKGROUND = "#0a0a0a";
export const FALLBACK_TERMINAL_FOREGROUND = "#cccccc";

/**
 * Terminal color-scheme change notifications (CSI ? 997). OpenCode's TUI
 * treats either value as "re-query OSC 10/11 and apply the new mode".
 */
export const COLOR_SCHEME_DARK_NOTIFICATION = "\x1b[?997;1n";
export const COLOR_SCHEME_LIGHT_NOTIFICATION = "\x1b[?997;2n";

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

function parseColorToRgb(value: string | undefined): RgbColor | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(trimmed);
  if (hex) {
    const digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      return {
        r: parseInt(`${digits[0]}${digits[0]}`, 16),
        g: parseInt(`${digits[1]}${digits[1]}`, 16),
        b: parseInt(`${digits[2]}${digits[2]}`, 16),
      };
    }
    if (digits.length === 6 || digits.length === 8) {
      return {
        r: parseInt(digits.slice(0, 2), 16),
        g: parseInt(digits.slice(2, 4), 16),
        b: parseInt(digits.slice(4, 6), 16),
      };
    }
    return null;
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(trimmed);
  if (rgb) {
    return {
      r: Math.min(255, parseInt(rgb[1], 10)),
      g: Math.min(255, parseInt(rgb[2], 10)),
      b: Math.min(255, parseInt(rgb[3], 10)),
    };
  }
  return null;
}

/**
 * Mirrors OpenCode's own luminance test (r*299 + g*587 + b*114) so the
 * notification matches the mode the TUI will derive from OSC 11.
 */
export function getColorSchemeNotification(theme: ITheme): string {
  const rgb = parseColorToRgb(theme.background);
  const isLight = rgb
    ? (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1000 > 128
    : false;
  return isLight
    ? COLOR_SCHEME_LIGHT_NOTIFICATION
    : COLOR_SCHEME_DARK_NOTIFICATION;
}

type AnsiThemeKey =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "brightBlack"
  | "brightRed"
  | "brightGreen"
  | "brightYellow"
  | "brightBlue"
  | "brightMagenta"
  | "brightCyan"
  | "brightWhite";

const ANSI_THEME_KEYS: ReadonlyArray<readonly [AnsiThemeKey, string]> = [
  ["black", "ansiBlack"],
  ["red", "ansiRed"],
  ["green", "ansiGreen"],
  ["yellow", "ansiYellow"],
  ["blue", "ansiBlue"],
  ["magenta", "ansiMagenta"],
  ["cyan", "ansiCyan"],
  ["white", "ansiWhite"],
  ["brightBlack", "ansiBrightBlack"],
  ["brightRed", "ansiBrightRed"],
  ["brightGreen", "ansiBrightGreen"],
  ["brightYellow", "ansiBrightYellow"],
  ["brightBlue", "ansiBrightBlue"],
  ["brightMagenta", "ansiBrightMagenta"],
  ["brightCyan", "ansiBrightCyan"],
  ["brightWhite", "ansiBrightWhite"],
];

export interface TerminalThemeWatcher {
  dispose: () => void;
}

export interface TerminalThemeSyncTarget {
  resetThemeOverrides: () => void;
  syncNow: (force?: boolean) => void;
}

export interface ThemeAwareTerminal {
  options: { theme?: ITheme };
  buffer: { active: { type: string } };
}

/**
 * OpenCode's TUI runs on the alternate screen by default. A residual shell
 * prompt (notably on Windows, where cmd /k and PowerShell -NoExit keep the
 * PTY alive) uses the normal screen and must not receive terminal responses.
 */
export function shouldNotifyTui(
  terminal: Pick<ThemeAwareTerminal, "buffer">,
): boolean {
  return terminal.buffer.active.type === "alternate";
}

function readComputedStyle(): CSSStyleDeclaration | null {
  if (
    typeof document === "undefined" ||
    typeof getComputedStyle !== "function"
  ) {
    return null;
  }
  return getComputedStyle(document.documentElement);
}

function readFirstCssVariable(
  style: CSSStyleDeclaration | null,
  ...names: string[]
): string | undefined {
  if (!style) {
    return undefined;
  }
  for (const name of names) {
    const value = style.getPropertyValue(name).trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

/**
 * Build an xterm theme from the CSS variables VS Code injects into every
 * webview (`terminal.*`). `terminal.background` has no default in the color
 * registry; VS Code resolves it by location, so mirror the sidebar terminal
 * order (sideBar.background, then panel.background, then editor.background).
 * Foreground, ANSI, and selection colors carry defaults; cursor colors do not,
 * so they fall back to foreground/background like VS Code's getXtermTheme().
 */
export function readVsCodeTerminalTheme(): ITheme {
  const style = readComputedStyle();
  const background =
    readFirstCssVariable(
      style,
      "--vscode-terminal-background",
      "--vscode-sideBar-background",
      "--vscode-panel-background",
      "--vscode-editor-background",
    ) ?? FALLBACK_TERMINAL_BACKGROUND;
  const foreground =
    readFirstCssVariable(
      style,
      "--vscode-terminal-foreground",
      "--vscode-foreground",
    ) ?? FALLBACK_TERMINAL_FOREGROUND;

  const theme: ITheme = {
    background,
    foreground,
    cursor:
      readFirstCssVariable(style, "--vscode-terminalCursor-foreground") ??
      foreground,
    cursorAccent:
      readFirstCssVariable(style, "--vscode-terminalCursor-background") ??
      background,
  };

  const selectionBackground = readFirstCssVariable(
    style,
    "--vscode-terminal-selectionBackground",
    "--vscode-editor-selectionBackground",
  );
  if (selectionBackground) {
    theme.selectionBackground = selectionBackground;
  }

  const selectionForeground = readFirstCssVariable(
    style,
    "--vscode-terminal-selectionForeground",
  );
  if (selectionForeground) {
    theme.selectionForeground = selectionForeground;
  }

  const inactiveSelectionBackground = readFirstCssVariable(
    style,
    "--vscode-terminal-inactiveSelectionBackground",
    "--vscode-editor-inactiveSelectionBackground",
  );
  if (inactiveSelectionBackground) {
    theme.selectionInactiveBackground = inactiveSelectionBackground;
  }

  for (const [themeKey, vscodeKey] of ANSI_THEME_KEYS) {
    const value = readFirstCssVariable(style, `--vscode-terminal-${vscodeKey}`);
    if (value) {
      theme[themeKey] = value;
    }
  }

  return theme;
}

/**
 * Publish the resolved palette to CSS. `background` is skipped after the
 * initial load because `createBackgroundSync` owns `--terminal-background`
 * once it has sampled the live buffer (a TUI may paint its own theme).
 */
export function applyTerminalThemeVariables(
  theme: ITheme,
  options: { background?: boolean } = {},
): void {
  if (typeof document === "undefined") {
    return;
  }
  if (options.background !== false) {
    document.documentElement.style.setProperty(
      "--terminal-background",
      theme.background ?? FALLBACK_TERMINAL_BACKGROUND,
    );
  }
  document.documentElement.style.setProperty(
    "--terminal-foreground",
    theme.foreground ?? FALLBACK_TERMINAL_FOREGROUND,
  );
}

/**
 * Apply a workbench theme change to a live terminal.
 *
 * Assigning `options.theme` rebuilds xterm's color set, which discards any
 * OSC colors a TUI installed. Mirror that reset in background-sync and force
 * the container layers back to the sampled color so the canvas and the gap
 * below the last row cannot disagree.
 *
 * The final notification tells TUIs that understand `CSI ? 997 n` (OpenCode
 * does) to re-query OSC 10/11, which xterm now answers with `theme`.
 */
export function applyWorkbenchThemeChange(
  terminal: ThemeAwareTerminal,
  theme: ITheme,
  backgroundSync: TerminalThemeSyncTarget,
  notifyTui: (data: string) => void,
): void {
  backgroundSync.resetThemeOverrides();
  terminal.options.theme = theme;
  applyTerminalThemeVariables(theme, { background: false });
  backgroundSync.syncNow(true);
  if (shouldNotifyTui(terminal)) {
    notifyTui(getColorSchemeNotification(theme));
  }
}

/**
 * Re-resolve the xterm theme when VS Code swaps workbench colors. The webview
 * host applies theme variables as inline styles on the document element, so
 * attribute mutations are the signal; the signature check drops unrelated
 * style/class churn.
 */
export function watchVsCodeTerminalTheme(
  onChange: (theme: ITheme) => void,
): TerminalThemeWatcher {
  if (
    typeof document === "undefined" ||
    typeof MutationObserver === "undefined"
  ) {
    return { dispose: () => undefined };
  }

  let signature = JSON.stringify(readVsCodeTerminalTheme());

  const observer = new MutationObserver(() => {
    const theme = readVsCodeTerminalTheme();
    const nextSignature = JSON.stringify(theme);
    if (nextSignature === signature) {
      return;
    }
    signature = nextSignature;
    onChange(theme);
  });

  const options: MutationObserverInit = {
    attributes: true,
    attributeFilter: ["class", "style"],
  };
  observer.observe(document.documentElement, options);
  if (document.body) {
    observer.observe(document.body, options);
  }

  return {
    dispose: () => observer.disconnect(),
  };
}
