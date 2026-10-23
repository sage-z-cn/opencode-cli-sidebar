// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { IBufferCell, Terminal } from "@xterm/xterm";
import {
  buildPalette,
  createBackgroundSync,
  normalizeCssColor,
  resolveCellBackground,
  sampleDominantBackground,
  type BackgroundPalette,
} from "./background-sync";

function makeCell(overrides: {
  bgDefault?: boolean;
  bgPalette?: boolean;
  bgRgb?: boolean;
  bg?: number;
  fgDefault?: boolean;
  fgPalette?: boolean;
  fgRgb?: boolean;
  fg?: number;
  inverse?: boolean;
}): IBufferCell {
  return {
    isBgDefault: () => overrides.bgDefault ?? true,
    isBgPalette: () => overrides.bgPalette ?? false,
    isBgRGB: () => overrides.bgRgb ?? false,
    getBgColor: () => overrides.bg ?? -1,
    isFgDefault: () => overrides.fgDefault ?? true,
    isFgPalette: () => overrides.fgPalette ?? false,
    isFgRGB: () => overrides.fgRgb ?? false,
    getFgColor: () => overrides.fg ?? -1,
    isInverse: () => overrides.inverse ?? false,
  } as unknown as IBufferCell;
}

const palette: BackgroundPalette = {
  defaultBackground: "#0a0a0a",
  ansi: [
    "#000000", "#cd0000", "#00cd00", "#cdcd00",
    "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
    "#7f7f7f", "#ff0000", "#00ff00", "#ffff00",
    "#5c5cff", "#ff00ff", "#00ffff", "#ffffff",
  ],
};

function makeTerminal(options: {
  rows?: number;
  cols?: number;
  cells: IBufferCell[][];
  theme?: Record<string, unknown>;
}): Terminal {
  const rows = options.rows ?? options.cells.length;
  const cols = options.cols ?? options.cells[0]?.length ?? 0;
  return {
    rows,
    cols,
    options: { theme: options.theme ?? { background: "#0a0a0a" } },
    buffer: {
      active: {
        viewportY: 0,
        getLine: (y: number) => {
          const row = options.cells[y];
          if (!row) {
            return undefined;
          }
          return {
            getCell: (x: number, reuse?: IBufferCell) => {
              const source = row[x];
              if (!source) {
                return undefined;
              }
              if (!reuse) {
                return source;
              }
              // Copy fields onto the reusable cell like xterm does.
              const target = reuse as unknown as Record<string, unknown>;
              const src = source as unknown as Record<string, unknown>;
              for (const key of [
                "isBgDefault",
                "isBgPalette",
                "isBgRGB",
                "getBgColor",
                "isFgDefault",
                "isFgPalette",
                "isFgRGB",
                "getFgColor",
                "isInverse",
              ]) {
                target[key] = src[key];
              }
              return reuse;
            },
          };
        },
        getNullCell: () => makeCell({}),
      },
    },
  } as unknown as Terminal;
}

describe("normalizeCssColor", () => {
  it("normalizes 6-digit hex", () => {
    expect(normalizeCssColor("#AABBCC")).toBe("#aabbcc");
  });

  it("expands 3-digit hex", () => {
    expect(normalizeCssColor("#abc")).toBe("#aabbcc");
  });

  it("converts rgb() to hex", () => {
    expect(normalizeCssColor("rgb(10, 20, 30)")).toBe("#0a141e");
  });

  it("passes through unrecognized values", () => {
    expect(normalizeCssColor("tomato")).toBe("tomato");
  });
});

describe("buildPalette", () => {
  it("applies theme overrides for the first 16 ANSI slots", () => {
    const terminal = makeTerminal({
      cells: [],
      theme: { background: "#112233", red: "#ff0000", brightWhite: "#fff" },
    });
    const p = buildPalette(terminal);
    expect(p.defaultBackground).toBe("#112233");
    expect(p.ansi[1]).toBe("#ff0000");
    expect(p.ansi[15]).toBe("#ffffff");
  });

  it("falls back to the standard 256-color table", () => {
    const terminal = makeTerminal({ cells: [], theme: {} });
    const p = buildPalette(terminal);
    // 6x6x6 cube index 16 is (0,0,0)
    expect(p.ansi[16]).toBe("#000000");
    // grayscale tail
    expect(p.ansi[232]).toBe("#080808");
  });
});

describe("resolveCellBackground", () => {
  it("uses theme default for default-bg cells", () => {
    const cell = makeCell({ bgDefault: true });
    expect(resolveCellBackground(cell, palette)).toBe("#0a0a0a");
  });

  it("decodes truecolor cells", () => {
    // 0x1a2b3c
    const cell = makeCell({ bgDefault: false, bgRgb: true, bg: 0x1a2b3c });
    expect(resolveCellBackground(cell, palette)).toBe("#1a2b3c");
  });

  it("maps palette cells through the ANSI table", () => {
    const cell = makeCell({ bgDefault: false, bgPalette: true, bg: 1 });
    expect(resolveCellBackground(cell, palette)).toBe("#cd0000");
  });

  it("uses foreground color when inverse is set", () => {
    const cell = makeCell({
      inverse: true,
      fgDefault: false,
      fgRgb: true,
      fg: 0xff8800,
    });
    expect(resolveCellBackground(cell, palette)).toBe("#ff8800");
  });
});

describe("sampleDominantBackground", () => {
  it("returns the majority painted background", () => {
    const tuiBg = makeCell({ bgDefault: false, bgRgb: true, bg: 0x112233 });
    const accent = makeCell({ bgDefault: false, bgRgb: true, bg: 0xff0000 });
    const terminal = makeTerminal({
      rows: 4,
      cols: 8,
      cells: [
        [tuiBg, tuiBg, tuiBg, tuiBg, tuiBg, tuiBg, tuiBg, accent],
        [tuiBg, tuiBg, tuiBg, tuiBg, tuiBg, tuiBg, tuiBg, tuiBg],
        [tuiBg, tuiBg, tuiBg, tuiBg, tuiBg, tuiBg, tuiBg, tuiBg],
        [tuiBg, tuiBg, tuiBg, tuiBg, tuiBg, tuiBg, tuiBg, tuiBg],
      ],
    });

    expect(sampleDominantBackground(terminal, palette)).toBe("#112233");
  });

  it("falls back to default background when cells are mostly default", () => {
    const empty = makeCell({ bgDefault: true });
    const terminal = makeTerminal({
      rows: 3,
      cols: 4,
      cells: [
        [empty, empty, empty, empty],
        [empty, empty, empty, empty],
        [empty, empty, empty, empty],
      ],
    });

    expect(sampleDominantBackground(terminal, palette)).toBe("#0a0a0a");
  });

  it("returns default background for an empty terminal", () => {
    const terminal = makeTerminal({ rows: 0, cols: 0, cells: [] });
    expect(sampleDominantBackground(terminal, palette)).toBe("#0a0a0a");
  });
});

describe("createBackgroundSync", () => {
  function attachParser(terminal: Terminal): {
    handlers: Map<number, (data: string) => boolean>;
  } {
    const handlers = new Map<number, (data: string) => boolean>();
    (terminal as unknown as { parser: unknown }).parser = {
      registerOscHandler: (ident: number, cb: (data: string) => boolean) => {
        handlers.set(ident, cb);
        return { dispose: () => handlers.delete(ident) };
      },
    };
    (terminal as unknown as { onRender: unknown }).onRender = vi.fn(() => ({
      dispose: vi.fn(),
    }));
    (terminal as unknown as { onResize: unknown }).onResize = vi.fn(() => ({
      dispose: vi.fn(),
    }));
    return { handlers };
  }

  it("applies the sampled color to the container on create", () => {
    const tuiBg = makeCell({ bgDefault: false, bgRgb: true, bg: 0x224466 });
    const terminal = makeTerminal({
      rows: 2,
      cols: 4,
      cells: [
        [tuiBg, tuiBg, tuiBg, tuiBg],
        [tuiBg, tuiBg, tuiBg, tuiBg],
      ],
    });
    attachParser(terminal);

    const container = document.createElement("div");
    document.body.appendChild(container);

    const sync = createBackgroundSync(terminal, container);
    expect(container.style.backgroundColor).toBe("rgb(34, 68, 102)");

    sync.dispose();
    container.remove();
  });

  it("tracks OSC 11 default background for default-colored cells", () => {
    const empty = makeCell({ bgDefault: true });
    const terminal = makeTerminal({
      rows: 2,
      cols: 2,
      cells: [
        [empty, empty],
        [empty, empty],
      ],
    });
    const { handlers } = attachParser(terminal);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const sync = createBackgroundSync(terminal, container);
    expect(container.style.backgroundColor).toBe("rgb(10, 10, 10)");

    // OpenCode-style OSC 11 with 16-bit-per-channel rgb
    handlers.get(11)?.("rgb:1a1a/2b2b/3c3c");
    sync.syncNow();
    expect(container.style.backgroundColor).toBe("rgb(26, 43, 60)");

    // OSC 111 restores the themed default
    handlers.get(111)?.("");
    sync.syncNow();
    expect(container.style.backgroundColor).toBe("rgb(10, 10, 10)");

    sync.dispose();
    container.remove();
  });

  it("force-reapplies the sampled color after xterm rewrites a layer", () => {
    const tuiBg = makeCell({ bgDefault: false, bgRgb: true, bg: 0x224466 });
    const terminal = makeTerminal({
      rows: 1,
      cols: 2,
      cells: [[tuiBg, tuiBg]],
    });
    attachParser(terminal);

    const container = document.createElement("div");
    const surface = document.createElement("div");
    surface.className = "xterm";
    const scrollable = document.createElement("div");
    scrollable.className = "xterm-scrollable-element";
    surface.appendChild(scrollable);
    container.appendChild(surface);
    document.body.appendChild(container);

    const sync = createBackgroundSync(terminal, container);
    expect(scrollable.style.backgroundColor).toBe("rgb(34, 68, 102)");

    // xterm's Viewport repaints this layer with theme.background on a change.
    scrollable.style.backgroundColor = "rgb(255, 255, 255)";
    sync.syncNow();
    expect(scrollable.style.backgroundColor).toBe("rgb(255, 255, 255)");

    sync.syncNow(true);
    expect(scrollable.style.backgroundColor).toBe("rgb(34, 68, 102)");

    sync.dispose();
    container.remove();
  });

  it("drops the recorded OSC 11 default when the theme resets", () => {
    const empty = makeCell({ bgDefault: true });
    const terminal = makeTerminal({
      rows: 1,
      cols: 2,
      cells: [[empty, empty]],
    });
    const { handlers } = attachParser(terminal);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const sync = createBackgroundSync(terminal, container);

    handlers.get(11)?.("rgb:1a1a/2b2b/3c3c");
    sync.syncNow();
    expect(container.style.backgroundColor).toBe("rgb(26, 43, 60)");

    sync.resetThemeOverrides();
    sync.syncNow(true);
    expect(container.style.backgroundColor).toBe("rgb(10, 10, 10)");

    sync.dispose();
    container.remove();
  });

  it("stops reacting after dispose", () => {
    const terminal = makeTerminal({
      rows: 1,
      cols: 2,
      cells: [[makeCell({ bgDefault: true }), makeCell({ bgDefault: true })]],
    });
    const renderHandlers: Array<() => void> = [];
    (terminal as unknown as { onRender: unknown }).onRender = vi.fn(
      (cb: () => void) => {
        renderHandlers.push(cb);
        return { dispose: vi.fn() };
      },
    );
    (terminal as unknown as { onResize: unknown }).onResize = vi.fn(() => ({
      dispose: vi.fn(),
    }));
    (terminal as unknown as { parser: unknown }).parser = {
      registerOscHandler: () => ({ dispose: vi.fn() }),
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const sync = createBackgroundSync(terminal, container);

    const before = container.style.backgroundColor;
    sync.dispose();
    renderHandlers.forEach((cb) => cb());
    // rAF may still be pending; flush microtask then assert no throw + no change
    return Promise.resolve().then(() => {
      expect(container.style.backgroundColor).toBe(before);
      container.remove();
    });
  });
});
