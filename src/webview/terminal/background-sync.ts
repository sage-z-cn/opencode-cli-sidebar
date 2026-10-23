import type { IBufferCell, Terminal } from "@xterm/xterm";

const DEFAULT_BACKGROUND = "#0a0a0a";

/** Standard xterm 256-color palette (0-15 theme-overridable). */
function buildDefaultAnsi256(): string[] {
  const colors: string[] = [
    "#000000", "#cd0000", "#00cd00", "#cdcd00",
    "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
    "#7f7f7f", "#ff0000", "#00ff00", "#ffff00",
    "#5c5cff", "#ff00ff", "#00ffff", "#ffffff",
  ];
  const levels = [0, 95, 135, 175, 215, 255];
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        colors.push(rgbToHex(levels[r], levels[g], levels[b]));
      }
    }
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    colors.push(rgbToHex(v, v, v));
  }
  return colors;
}

const DEFAULT_ANSI_256 = buildDefaultAnsi256();

function rgbToHex(r: number, g: number, b: number): string {
  const to2 = (n: number) => n.toString(16).padStart(2, "0");
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}

/** Normalize a CSS color string to `#rrggbb` when parseable; else return as-is. */
export function normalizeCssColor(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const hex6 = /^#([0-9a-f]{6})$/.exec(trimmed);
  if (hex6) {
    return `#${hex6[1]}`;
  }
  const hex3 = /^#([0-9a-f]{3})$/.exec(trimmed);
  if (hex3) {
    const [r, g, b] = hex3[1];
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(trimmed);
  if (rgb) {
    return rgbToHex(
      Math.min(255, parseInt(rgb[1], 10)),
      Math.min(255, parseInt(rgb[2], 10)),
      Math.min(255, parseInt(rgb[3], 10)),
    );
  }
  return trimmed;
}

export interface BackgroundPalette {
  /** Resolved default background (theme / OSC 11). */
  defaultBackground: string;
  /** ANSI 0-255 colors, theme-overridden where provided. */
  ansi: readonly string[];
}

/**
 * OSC 11 / 111 default-background overrides, keyed by terminal instance so
 * tests and multi-terminal hosts do not share state.
 */
const oscDefaultByTerminal = new WeakMap<Terminal, string | null>();

/** Parse `rgb:rrrr/gggg/bbbb` or `#rgb` / `#rrggbb` OSC color payloads. */
function parseOscColor(data: string): string | null {
  const rgb = /^rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})$/i.exec(
    data.trim(),
  );
  if (rgb) {
    const scale = (hex: string) => {
      const n = parseInt(hex, 16);
      const max = (1 << (hex.length * 4)) - 1;
      return Math.round((n / max) * 255);
    };
    return rgbToHex(scale(rgb[1]), scale(rgb[2]), scale(rgb[3]));
  }
  if (/^#[0-9a-f]{3,8}$/i.test(data.trim())) {
    return normalizeCssColor(data);
  }
  return null;
}

export function buildPalette(terminal: Terminal): BackgroundPalette {
  const theme = terminal.options.theme ?? {};
  const ansi = DEFAULT_ANSI_256.slice();
  const overrides: (string | undefined)[] = [
    theme.black, theme.red, theme.green, theme.yellow,
    theme.blue, theme.magenta, theme.cyan, theme.white,
    theme.brightBlack, theme.brightRed, theme.brightGreen, theme.brightYellow,
    theme.brightBlue, theme.brightMagenta, theme.brightCyan, theme.brightWhite,
  ];
  for (let i = 0; i < overrides.length; i++) {
    if (overrides[i]) {
      ansi[i] = normalizeCssColor(overrides[i]!);
    }
  }
  if (theme.extendedAnsi) {
    for (let i = 0; i < theme.extendedAnsi.length && i + 16 < ansi.length; i++) {
      ansi[i + 16] = normalizeCssColor(theme.extendedAnsi[i]);
    }
  }
  const oscDefault = oscDefaultByTerminal.get(terminal);
  return {
    defaultBackground: normalizeCssColor(
      oscDefault ?? theme.background ?? DEFAULT_BACKGROUND,
    ),
    ansi,
  };
}

/**
 * Resolve a cell's *visual* background to a comparable color key.
 * Inverse video swaps fg/bg at paint time, so account for that.
 */
export function resolveCellBackground(
  cell: IBufferCell,
  palette: BackgroundPalette,
): string {
  if (cell.isInverse()) {
    // Visual bg is the foreground color.
    if (cell.isFgDefault()) {
      return palette.defaultBackground;
    }
    if (cell.isFgPalette()) {
      return palette.ansi[cell.getFgColor()] ?? palette.defaultBackground;
    }
    if (cell.isFgRGB()) {
      const v = cell.getFgColor();
      return rgbToHex((v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
    }
    return palette.defaultBackground;
  }

  if (cell.isBgRGB()) {
    const v = cell.getBgColor();
    return rgbToHex((v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
  }
  if (cell.isBgPalette()) {
    return palette.ansi[cell.getBgColor()] ?? palette.defaultBackground;
  }
  return palette.defaultBackground;
}

/**
 * Sparse-sample the visible viewport and return the dominant visual background.
 * Falls back to the palette default when cells are mostly default-colored.
 */
export function sampleDominantBackground(
  terminal: Terminal,
  palette: BackgroundPalette = buildPalette(terminal),
): string {
  const buf = terminal.buffer.active;
  const rows = terminal.rows;
  const cols = terminal.cols;
  if (rows <= 0 || cols <= 0) {
    return palette.defaultBackground;
  }

  const colStride = Math.max(1, Math.floor(cols / 16));
  const counts = new Map<string, number>();
  const cell = buf.getNullCell();

  for (let y = 0; y < rows; y++) {
    const line = buf.getLine(buf.viewportY + y);
    if (!line) {
      continue;
    }
    for (let x = 0; x < cols; x += colStride) {
      const c = line.getCell(x, cell);
      if (!c) {
        continue;
      }
      const key = resolveCellBackground(c, palette);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  if (counts.size === 0) {
    return palette.defaultBackground;
  }

  let winner = palette.defaultBackground;
  let winnerCount = 0;
  for (const [color, count] of counts) {
    if (count > winnerCount) {
      winner = color;
      winnerCount = count;
    }
  }
  return winner;
}

export interface BackgroundSync {
  /**
   * Resample + apply immediately. `force` rewrites every surface layer even
   * when the sampled color is unchanged, which is required after xterm's
   * theme change rewrites the scrollable layer.
   */
  syncNow: (force?: boolean) => void;
  /** Drop the recorded OSC 11 override (xterm resets it on theme change). */
  resetThemeOverrides: () => void;
  dispose: () => void;
}

/**
 * Keeps the webview gap (below the last cell row) painted with the terminal's
 * dominant background so TUI themes (OpenCode, Claude Code, Codex, …) and
 * plain shells all look continuous. Agent-agnostic: purely buffer-driven.
 */
export function createBackgroundSync(
  terminal: Terminal,
  container: HTMLElement,
): BackgroundSync {
  let disposed = false;
  let rafId: number | null = null;
  let applied = "";

  const apply = (color: string, force = false): void => {
    if (!force && applied === color) {
      return;
    }
    applied = color;
    container.style.backgroundColor = color;
    container.style.setProperty("--terminal-background", color);
    document.documentElement.style.setProperty(
      "--terminal-background",
      color,
    );
    // Stretch surface layers so the leftover strip shares the same fill.
    const surface = container.querySelector(".terminal, .xterm");
    if (surface instanceof HTMLElement) {
      surface.style.backgroundColor = color;
    }
    const viewport = container.querySelector(".xterm-viewport");
    if (viewport instanceof HTMLElement) {
      viewport.style.backgroundColor = color;
    }
    // Viewport.ts paints this node with theme.background via inline style;
    // overwrite it so TUI cell colors win over the xterm default.
    const scrollable = container.querySelector(
      ".xterm-scrollable-element",
    );
    if (scrollable instanceof HTMLElement) {
      scrollable.style.backgroundColor = color;
    }
  };

  const syncNow = (force = false): void => {
    if (disposed) {
      return;
    }
    apply(sampleDominantBackground(terminal), force);
  };

  const resetThemeOverrides = (): void => {
    oscDefaultByTerminal.delete(terminal);
  };

  const schedule = (): void => {
    if (disposed || rafId !== null) {
      return;
    }
    rafId = requestAnimationFrame(() => {
      rafId = null;
      syncNow();
    });
  };

  const renderDisposable = terminal.onRender(() => schedule());
  // Fonts/fit can change cell metrics without a render of new content.
  const resizeDisposable = terminal.onResize(() => schedule());

  // OSC 11 sets / OSC 111 restores the default background. Returning false
  // lets xterm's own handler still update ThemeService.
  const osc11 = terminal.parser.registerOscHandler(11, (data) => {
    // `?` is a color query — leave it to xterm.
    if (data.trim() !== "?") {
      const parsed = parseOscColor(data);
      if (parsed) {
        oscDefaultByTerminal.set(terminal, parsed);
        schedule();
      }
    }
    return false;
  });
  const osc111 = terminal.parser.registerOscHandler(111, () => {
    oscDefaultByTerminal.delete(terminal);
    schedule();
    return false;
  });

  syncNow();

  return {
    syncNow,
    resetThemeOverrides,
    dispose: () => {
      disposed = true;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      renderDisposable.dispose();
      resizeDisposable.dispose();
      osc11.dispose();
      osc111.dispose();
    },
  };
}
