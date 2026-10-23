// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  COLOR_SCHEME_DARK_NOTIFICATION,
  COLOR_SCHEME_LIGHT_NOTIFICATION,
  FALLBACK_TERMINAL_BACKGROUND,
  FALLBACK_TERMINAL_FOREGROUND,
  applyTerminalThemeVariables,
  applyWorkbenchThemeChange,
  getColorSchemeNotification,
  readVsCodeTerminalTheme,
  shouldNotifyTui,
  watchVsCodeTerminalTheme,
} from "./theme";

const ANSI_VARIABLES: ReadonlyArray<readonly [string, string]> = [
  ["--vscode-terminal-ansiBlack", "#101010"],
  ["--vscode-terminal-ansiRed", "#202020"],
  ["--vscode-terminal-ansiGreen", "#303030"],
  ["--vscode-terminal-ansiYellow", "#404040"],
  ["--vscode-terminal-ansiBlue", "#505050"],
  ["--vscode-terminal-ansiMagenta", "#606060"],
  ["--vscode-terminal-ansiCyan", "#707070"],
  ["--vscode-terminal-ansiWhite", "#808080"],
  ["--vscode-terminal-ansiBrightBlack", "#909090"],
  ["--vscode-terminal-ansiBrightRed", "#a0a0a0"],
  ["--vscode-terminal-ansiBrightGreen", "#b0b0b0"],
  ["--vscode-terminal-ansiBrightYellow", "#c0c0c0"],
  ["--vscode-terminal-ansiBrightBlue", "#d0d0d0"],
  ["--vscode-terminal-ansiBrightMagenta", "#e0e0e0"],
  ["--vscode-terminal-ansiBrightCyan", "#f0f0f0"],
  ["--vscode-terminal-ansiBrightWhite", "#ffffff"],
];

const RESET_VARIABLES = [
  "--vscode-terminal-background",
  "--vscode-terminal-foreground",
  "--vscode-terminalCursor-foreground",
  "--vscode-terminalCursor-background",
  "--vscode-terminal-selectionBackground",
  "--vscode-terminal-selectionForeground",
  "--vscode-terminal-inactiveSelectionBackground",
  "--vscode-editor-background",
  "--vscode-sideBar-background",
  "--vscode-panel-background",
  "--vscode-foreground",
  "--vscode-editor-selectionBackground",
  "--vscode-editor-inactiveSelectionBackground",
  "--terminal-background",
  "--terminal-foreground",
  ...ANSI_VARIABLES.map(([name]) => name),
];

function setCssVariable(name: string, value: string): void {
  document.documentElement.style.setProperty(name, value);
}

function flushMutations(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  for (const name of RESET_VARIABLES) {
    document.documentElement.style.removeProperty(name);
  }
  document.body.className = "";
});

describe("readVsCodeTerminalTheme", () => {
  it("reads terminal background and foreground from webview variables", () => {
    setCssVariable("--vscode-terminal-background", "#1e1e1e");
    setCssVariable("--vscode-terminal-foreground", "#d4d4d4");

    const theme = readVsCodeTerminalTheme();

    expect(theme.background).toBe("#1e1e1e");
    expect(theme.foreground).toBe("#d4d4d4");
    expect(theme.cursor).toBe("#d4d4d4");
    expect(theme.cursorAccent).toBe("#1e1e1e");
    expect(theme.selectionForeground).toBeUndefined();
  });

  it("prefers the sidebar background for this sidebar view", () => {
    setCssVariable("--vscode-sideBar-background", "#f3f3f3");
    setCssVariable("--vscode-panel-background", "#f8f8f8");
    setCssVariable("--vscode-editor-background", "#ffffff");

    expect(readVsCodeTerminalTheme().background).toBe("#f3f3f3");
  });

  it("falls back to the panel background without a sidebar color", () => {
    setCssVariable("--vscode-panel-background", "#f8f8f8");
    setCssVariable("--vscode-editor-background", "#ffffff");

    expect(readVsCodeTerminalTheme().background).toBe("#f8f8f8");
  });

  it("falls back to editor colors when location colors are absent", () => {
    setCssVariable("--vscode-editor-background", "#ffffff");
    setCssVariable("--vscode-foreground", "#333333");

    const theme = readVsCodeTerminalTheme();

    expect(theme.background).toBe("#ffffff");
    expect(theme.foreground).toBe("#333333");
  });

  it("falls back to the built-in palette outside VS Code", () => {
    const theme = readVsCodeTerminalTheme();

    expect(theme.background).toBe(FALLBACK_TERMINAL_BACKGROUND);
    expect(theme.foreground).toBe(FALLBACK_TERMINAL_FOREGROUND);
    expect(theme.cursor).toBe(FALLBACK_TERMINAL_FOREGROUND);
    expect(theme.cursorAccent).toBe(FALLBACK_TERMINAL_BACKGROUND);
  });

  it("maps the full ANSI palette", () => {
    for (const [name, value] of ANSI_VARIABLES) {
      setCssVariable(name, value);
    }

    const theme = readVsCodeTerminalTheme();
    const ansiKeys = [
      "black",
      "red",
      "green",
      "yellow",
      "blue",
      "magenta",
      "cyan",
      "white",
      "brightBlack",
      "brightRed",
      "brightGreen",
      "brightYellow",
      "brightBlue",
      "brightMagenta",
      "brightCyan",
      "brightWhite",
    ] as const;

    ansiKeys.forEach((key, index) => {
      expect(theme[key]).toBe(ANSI_VARIABLES[index][1]);
    });
  });

  it("maps cursor and selection colors", () => {
    setCssVariable("--vscode-terminalCursor-foreground", "#111111");
    setCssVariable("--vscode-terminalCursor-background", "#222222");
    setCssVariable("--vscode-terminal-selectionBackground", "#333333");
    setCssVariable("--vscode-terminal-selectionForeground", "#777777");
    setCssVariable("--vscode-terminal-inactiveSelectionBackground", "#444444");

    const theme = readVsCodeTerminalTheme();

    expect(theme.cursor).toBe("#111111");
    expect(theme.cursorAccent).toBe("#222222");
    expect(theme.selectionBackground).toBe("#333333");
    expect(theme.selectionForeground).toBe("#777777");
    expect(theme.selectionInactiveBackground).toBe("#444444");
  });

  it("falls back to editor selection colors", () => {
    setCssVariable("--vscode-editor-selectionBackground", "#555555");
    setCssVariable("--vscode-editor-inactiveSelectionBackground", "#666666");

    const theme = readVsCodeTerminalTheme();

    expect(theme.selectionBackground).toBe("#555555");
    expect(theme.selectionInactiveBackground).toBe("#666666");
  });
});

describe("applyTerminalThemeVariables", () => {
  it("publishes the resolved palette to CSS variables", () => {
    applyTerminalThemeVariables({
      background: "#abcdef",
      foreground: "#fedcba",
    });

    expect(
      document.documentElement.style.getPropertyValue("--terminal-background"),
    ).toBe("#abcdef");
    expect(
      document.documentElement.style.getPropertyValue("--terminal-foreground"),
    ).toBe("#fedcba");
  });

  it("leaves the background to background-sync when asked", () => {
    setCssVariable("--terminal-background", "#123456");

    applyTerminalThemeVariables(
      { background: "#abcdef", foreground: "#fedcba" },
      { background: false },
    );

    expect(
      document.documentElement.style.getPropertyValue("--terminal-background"),
    ).toBe("#123456");
    expect(
      document.documentElement.style.getPropertyValue("--terminal-foreground"),
    ).toBe("#fedcba");
  });
});

describe("getColorSchemeNotification", () => {
  it("reports a dark scheme for dark backgrounds", () => {
    expect(getColorSchemeNotification({ background: "#1e1e1e" })).toBe(
      COLOR_SCHEME_DARK_NOTIFICATION,
    );
  });

  it("reports a light scheme for light backgrounds", () => {
    expect(getColorSchemeNotification({ background: "#ffffff" })).toBe(
      COLOR_SCHEME_LIGHT_NOTIFICATION,
    );
  });

  it("accepts short hex and rgb() backgrounds", () => {
    expect(getColorSchemeNotification({ background: "#fff" })).toBe(
      COLOR_SCHEME_LIGHT_NOTIFICATION,
    );
    expect(getColorSchemeNotification({ background: "rgb(0, 0, 0)" })).toBe(
      COLOR_SCHEME_DARK_NOTIFICATION,
    );
  });

  it("defaults to dark when the background is unknown", () => {
    expect(getColorSchemeNotification({})).toBe(
      COLOR_SCHEME_DARK_NOTIFICATION,
    );
  });
});

describe("shouldNotifyTui", () => {
  it("notifies only while the alternate screen is active", () => {
    expect(
      shouldNotifyTui({ buffer: { active: { type: "alternate" } } }),
    ).toBe(true);
    expect(shouldNotifyTui({ buffer: { active: { type: "normal" } } })).toBe(
      false,
    );
  });
});

describe("applyWorkbenchThemeChange", () => {
  it("resets xterm/background-sync overrides, repaints, and notifies the TUI", () => {
    const terminal = {
      options: { theme: { background: "#000000" } as Record<string, string> },
      buffer: { active: { type: "alternate" } },
    };
    const backgroundSync = {
      resetThemeOverrides: vi.fn(),
      syncNow: vi.fn(),
    };
    const notifyTui = vi.fn();
    const nextTheme = { background: "#abcdef", foreground: "#fedcba" };

    applyWorkbenchThemeChange(terminal, nextTheme, backgroundSync, notifyTui);

    expect(backgroundSync.resetThemeOverrides).toHaveBeenCalledTimes(1);
    expect(terminal.options.theme).toEqual(nextTheme);
    expect(backgroundSync.syncNow).toHaveBeenCalledWith(true);
    expect(notifyTui).toHaveBeenCalledWith(COLOR_SCHEME_LIGHT_NOTIFICATION);
    expect(
      document.documentElement.style.getPropertyValue("--terminal-foreground"),
    ).toBe("#fedcba");
  });

  it("does not notify the TUI from a normal shell buffer", () => {
    const terminal = {
      options: { theme: { background: "#000000" } as Record<string, string> },
      buffer: { active: { type: "normal" } },
    };
    const backgroundSync = {
      resetThemeOverrides: vi.fn(),
      syncNow: vi.fn(),
    };
    const notifyTui = vi.fn();

    applyWorkbenchThemeChange(
      terminal,
      { background: "#abcdef", foreground: "#fedcba" },
      backgroundSync,
      notifyTui,
    );

    expect(notifyTui).not.toHaveBeenCalled();
    expect(backgroundSync.syncNow).toHaveBeenCalledWith(true);
  });
});

describe("watchVsCodeTerminalTheme", () => {
  it("reports a theme change when VS Code rewrites its variables", async () => {
    setCssVariable("--vscode-terminal-background", "#111111");
    const onChange = vi.fn();
    const watcher = watchVsCodeTerminalTheme(onChange);

    setCssVariable("--vscode-terminal-background", "#eeeeee");

    await vi.waitFor(() => {
      expect(onChange).toHaveBeenCalledTimes(1);
    });
    expect(onChange.mock.calls[0][0].background).toBe("#eeeeee");

    watcher.dispose();
  });

  it("ignores mutations that do not change the theme", async () => {
    setCssVariable("--vscode-terminal-background", "#111111");
    const onChange = vi.fn();
    const watcher = watchVsCodeTerminalTheme(onChange);

    document.body.classList.add("vscode-light");
    await flushMutations();

    expect(onChange).not.toHaveBeenCalled();

    watcher.dispose();
  });

  it("stops reporting after dispose", async () => {
    setCssVariable("--vscode-terminal-background", "#111111");
    const onChange = vi.fn();
    const watcher = watchVsCodeTerminalTheme(onChange);
    watcher.dispose();

    setCssVariable("--vscode-terminal-background", "#eeeeee");
    await flushMutations();

    expect(onChange).not.toHaveBeenCalled();
  });
});
