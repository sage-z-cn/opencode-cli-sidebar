import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLinkProvider } from "./index";
import { postMessage } from "../shared/vscode-api";

vi.mock("../shared/vscode-api", () => ({
  postMessage: vi.fn(),
}));

type ProvidedLink = {
  readonly decorations?: { underline: boolean; pointerCursor: boolean };
  readonly range?: {
    start: { x: number; y: number };
    end: { x: number; y: number };
  };
  readonly text?: string;
  readonly activate: (...args: unknown[]) => void;
  readonly hover?: (...args: unknown[]) => void;
  readonly leave?: (...args: unknown[]) => void;
  readonly dispose?: () => void;
};

type MockRow = {
  readonly text: string;
  readonly isWrapped?: boolean;
};

type FakeElement = {
  className: string;
  style: Record<string, string>;
  children: FakeElement[];
  parent?: FakeElement;
  removed: boolean;
  appendChild: (child: FakeElement) => void;
  remove: () => void;
};

const createFakeElement = (): FakeElement => {
  const element: FakeElement = {
    className: "",
    style: {},
    children: [],
    removed: false,
    appendChild(child) {
      child.parent = element;
      element.children.push(child);
    },
    remove() {
      element.removed = true;
      if (!element.parent) return;
      const index = element.parent.children.indexOf(element);
      if (index >= 0) {
        element.parent.children.splice(index, 1);
      }
    },
  };
  return element;
};

const CELL_WIDTH = 10;
const CELL_HEIGHT = 20;

const createTerminalMock = (rows: ReadonlyArray<MockRow>, cols = 200) => {
  const lines = rows.map((row) => ({
    isWrapped: row.isWrapped ?? false,
    length: row.text.length,
    translateToString: () => row.text,
  }));

  const screen = createFakeElement() as FakeElement & {
    ownerDocument: { createElement: () => FakeElement };
    getBoundingClientRect: () => { width: number; height: number };
  };
  screen.ownerDocument = {
    createElement: vi.fn(() => createFakeElement()),
  };
  screen.getBoundingClientRect = vi.fn(() => ({
    width: cols * CELL_WIDTH,
    height: rows.length * CELL_HEIGHT,
  }));

  const getLine = vi.fn((index: number) => lines[index]);
  const terminal = {
    cols,
    rows: rows.length,
    element: { querySelector: vi.fn(() => screen) },
    buffer: { active: { viewportY: 0, getLine } },
  };

  return { terminal, screen };
};

const provideLinksForRows = (
  rows: ReadonlyArray<MockRow>,
  targetRow: number,
  cols = 200,
) =>
  new Promise<ReadonlyArray<ProvidedLink> | undefined>((resolve) => {
    const getLine = vi.fn((index: number) => {
      const row = rows[index];
      if (!row) {
        return undefined;
      }
      return {
        isWrapped: row.isWrapped ?? false,
        length: row.text.length,
        translateToString: () => row.text,
      };
    });
    const terminal = { cols, buffer: { active: { getLine } } };

    createLinkProvider(terminal as never).provideLinks(targetRow + 1, (links) => {
      // xterm.js passes 1-based bufferLineNumber, our code converts to
      // 0-based for getLine: getLine(bufferLineNumber - 1) = getLine(0)
      expect(getLine).toHaveBeenCalledWith(targetRow);
      resolve(links as unknown as ReadonlyArray<ProvidedLink> | undefined);
    });
  });

const provideLinksForLine = (lineText: string) =>
  provideLinksForRows([{ text: lineText }], 0);

describe("createLinkProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("links at-prefixed opencode paths with line and column suffix", async () => {
    const links = await provideLinksForLine("open @src/providers/MessageRouter.ts:120:5 now");

    expect(links).toHaveLength(1);
    links?.[0]?.activate();

    expect(postMessage).toHaveBeenCalledWith({
      type: "openFile",
      path: "src/providers/MessageRouter.ts",
      line: 120,
      endLine: undefined,
      column: 5,
    });
  });

  it("links absolute file URLs and decodes encoded spaces", async () => {
    const links = await provideLinksForLine("see file:///workspace/My%20File.ts:12");

    expect(links).toHaveLength(1);
    links?.[0]?.activate();

    expect(postMessage).toHaveBeenCalledWith({
      type: "openFile",
      path: "/workspace/My File.ts",
      line: 12,
      endLine: undefined,
      column: undefined,
    });
  });

  it("does not link malformed paths or oversized terminal lines", async () => {
    const malformedLinks = await provideLinksForLine("see http://example.com/not-a-file.ts");
    const oversizedLinks = await provideLinksForLine("a".repeat(10001));

    expect(malformedLinks).toHaveLength(0);
    expect(oversizedLinks).toBeUndefined();
  });

  it("computes range in cell coordinates so CJK width does not shift the underline", async () => {
    // 8 CJK chars (each 2 cells) precede the path, so cell x must be
    // stringIndex + 8, not stringIndex.
    const links = await provideLinksForLine("这是终端链接里的 src/webview/links/index.ts 文件");

    expect(links).toHaveLength(1);
    const range = links?.[0]?.range;
    // "这是终端链接里的 " = 8 CJK chars (16 cells) + 1 space = 17 cells.
    // path starts at string index 9 -> cell 17 -> xterm 1-based x = 18.
    expect(range?.start).toEqual({ x: 18, y: 1 });
    // path "src/webview/links/index.ts" is 26 chars, all width 1 -> 26 cells.
    expect(range?.end).toEqual({ x: 17 + 26, y: 1 });

    links?.[0]?.activate();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "openFile", path: "src/webview/links/index.ts" }),
    );
  });

  it("treats fullwidth punctuation as token boundaries", async () => {
    // Fullwidth 。 must cut the token, so the opened path is just the file.
    const links = await provideLinksForLine(
      "代码在 src/webview/links/index.ts。我先读源码分析根因。",
    );

    expect(links).toHaveLength(1);
    links?.[0]?.activate();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ path: "src/webview/links/index.ts" }),
    );

    // Fullwidth comma must also cut: ".json，30" should not glue together.
    const jsonLinks = await provideLinksForLine(
      "持久化到 .config/core-beat/holiday/{year}.json，30 天 TTL。",
    );
    jsonLinks?.[0]?.activate();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ path: ".config/core-beat/holiday/{year}.json" }),
    );
  });

  it("strips trailing ASCII/fullwidth punctuation even when CJK follows", async () => {
    // ASCII comma directly after the file, then CJK text (no space).
    const links = await provideLinksForLine(
      "代码在 src/webview/links/index.ts,可归为两条根因:",
    );

    expect(links).toHaveLength(1);
    const range = links?.[0]?.range;
    // underline must end exactly at the end of "index.ts", not the comma.
    const startCell = range?.start?.x ?? 0;
    const endCell = range?.end?.x ?? 0;
    expect(endCell - startCell + 1).toBe("src/webview/links/index.ts".length);

    links?.[0]?.activate();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ path: "src/webview/links/index.ts" }),
    );
  });

  it("does not treat slash-joined plain words without an extension as a path", async () => {
    const links = await provideLinksForLine("区分 once/repeat/workday 三种类型");
    expect(links).toHaveLength(0);
  });

  it("does not treat localized/code snippets with a dot and slash as a path", async () => {
    // Contains "." and "/" but also CJK chars and "(", so not a path.
    const links = await provideLinksForLine('说明 ".不加(保护扩展名/相对路径" 的取舍');
    expect(links).toHaveLength(0);
  });

  it("links Windows-style backslash relative paths", async () => {
    const links = await provideLinksForLine(
      "后端 liveai-server\\liveai-engine\\src\\main\\java\\com\\apexsoft\\util\\text\\TextUtil.java 改动",
    );

    expect(links).toHaveLength(1);
    links?.[0]?.activate();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "openFile",
        path: "liveai-server\\liveai-engine\\src\\main\\java\\com\\apexsoft\\util\\text\\TextUtil.java",
      }),
    );
  });

  it("stitches a hard-wrapped path across rows", async () => {
    const rows = [
      { text: "  src/webview/links/inde" },
      { text: "  x.ts" },
    ];

    const first = await provideLinksForRows(rows, 0);
    expect(first).toHaveLength(1);
    expect(first?.[0]?.text).toBe("src/webview/links/inde");
    expect(first?.[0]?.range).toEqual({
      start: { x: 3, y: 1 },
      end: { x: 24, y: 1 },
    });
    first?.[0]?.activate();
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "openFile",
      path: "src/webview/links/index.ts",
      line: undefined,
      endLine: undefined,
      column: undefined,
    });

    const continuation = await provideLinksForRows(rows, 1);
    expect(continuation).toHaveLength(1);
    expect(continuation?.[0]?.text).toBe("x.ts");
    continuation?.[0]?.activate();
    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "openFile", path: "src/webview/links/index.ts" }),
    );
  });

  it("underlines every wrapped fragment while any fragment is hovered", async () => {
    const rows = [
      { text: "  src/webview/links/inde" },
      { text: "  x.ts" },
    ];
    const { terminal, screen } = createTerminalMock(rows);
    const provider = createLinkProvider(terminal as never);
    const getLinks = (targetRow: number) =>
      new Promise<ReadonlyArray<ProvidedLink> | undefined>((resolve) => {
        provider.provideLinks(targetRow + 1, (links) => {
          resolve(links as unknown as ReadonlyArray<ProvidedLink> | undefined);
        });
      });

    const first = await getLinks(0);
    expect(first).toHaveLength(1);
    // Single-row links keep xterm from drawing its rectangular multi-row
    // underline over the sidebar.
    expect(first?.[0]?.decorations?.underline).toBe(false);

    first?.[0]?.hover?.();

    expect(screen.children).toHaveLength(1);
    const layer = screen.children[0];
    expect(layer?.children).toHaveLength(2);
    expect(layer?.style.pointerEvents).toBe("none");
    expect(layer?.children[0]?.style).toMatchObject({
      left: "20px",
      top: "0px",
      width: "220px",
      height: "20px",
    });
    expect(layer?.children[1]?.style).toMatchObject({
      left: "20px",
      top: "20px",
      width: "40px",
    });
    expect(layer?.children[0]?.style.borderBottom).toContain("1px solid");
    expect(layer?.children[0]?.style.pointerEvents).toBe("none");

    first?.[0]?.leave?.();
    expect(layer?.removed).toBe(true);
    expect(screen.children).toHaveLength(0);

    // Hovering the continuation row must underline the first fragment too.
    const continuation = await getLinks(1);
    continuation?.[0]?.hover?.();

    expect(screen.children).toHaveLength(1);
    const continuationLayer = screen.children[0];
    expect(continuationLayer?.children).toHaveLength(2);
    expect(continuationLayer?.children[0]?.style.width).toBe("220px");
    expect(continuationLayer?.children[1]?.style.width).toBe("40px");

    continuation?.[0]?.dispose?.();
    expect(continuationLayer?.removed).toBe(true);
    expect(screen.children).toHaveLength(0);
  });

  it("keeps a dot split at the wrap boundary as part of the path", async () => {
    const rows = [
      { text: "  src/foo/v1." },
      { text: "  2.ts" },
    ];

    const first = await provideLinksForRows(rows, 0);
    expect(first).toHaveLength(1);
    first?.[0]?.activate();
    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "openFile", path: "src/foo/v1.2.ts" }),
    );

    const continuation = await provideLinksForRows(rows, 1);
    continuation?.[0]?.activate();
    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "openFile", path: "src/foo/v1.2.ts" }),
    );
  });

  it("does not join prose rows into a wrapped path", async () => {
    const rows = [
      { text: "  see src/components/" },
      { text: "  and then continue" },
      { text: "  v2.0 released" },
    ];

    expect(await provideLinksForRows(rows, 0)).toHaveLength(0);
    expect(await provideLinksForRows(rows, 1)).toHaveLength(0);
    expect(await provideLinksForRows(rows, 2)).toHaveLength(0);
  });

  it("does not continue a transcript fragment into the sidebar", async () => {
    const rows = [
      { text: "  src/foo/" },
      { text: " ".repeat(80) + "main.js" },
    ];

    expect(await provideLinksForRows(rows, 0, 120)).toHaveLength(0);

    // The sidebar token is still its own single-line link.
    const sidebar = await provideLinksForRows(rows, 1, 120);
    expect(sidebar).toHaveLength(1);
    sidebar?.[0]?.activate();
    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "openFile", path: "main.js" }),
    );
  });

  it("stitches a path wrapped across three rows", async () => {
    const rows = [
      { text: "  src/very/long/pa" },
      { text: "  th/to/the/fi" },
      { text: "  le.ts" },
    ];
    const expected = "src/very/long/path/to/the/file.ts";

    const first = await provideLinksForRows(rows, 0);
    expect(first?.[0]?.text).toBe("src/very/long/pa");
    first?.[0]?.activate();
    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "openFile", path: expected }),
    );

    const middle = await provideLinksForRows(rows, 1);
    expect(middle).toHaveLength(1);
    expect(middle?.[0]?.text).toBe("th/to/the/fi");
    middle?.[0]?.activate();
    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "openFile", path: expected }),
    );

    const last = await provideLinksForRows(rows, 2);
    expect(last).toHaveLength(1);
    expect(last?.[0]?.text).toBe("le.ts");
    last?.[0]?.activate();
    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "openFile", path: expected }),
    );
  });

  it("keeps sidebar text out of wrapped transcript paths", async () => {
    const sidebar = " ".repeat(60) + "src/other/side";
    const rows = [
      { text: `  src/webview/links/inde${sidebar}` },
      { text: "  x.ts" },
    ];

    const links = await provideLinksForRows(rows, 0, 120);

    expect(links).toHaveLength(1);
    links?.[0]?.activate();
    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "openFile", path: "src/webview/links/index.ts" }),
    );
  });

  it("restores a line suffix split across rows", async () => {
    const rows = [
      { text: "  src/foo/bar.ts:" },
      { text: "  120" },
    ];

    const links = await provideLinksForRows(rows, 0);

    expect(links).toHaveLength(1);
    links?.[0]?.activate();
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "openFile",
      path: "src/foo/bar.ts",
      line: 120,
      endLine: undefined,
      column: undefined,
    });
  });

  it("does not stitch unrelated adjacent lines into a path", async () => {
    const rows = [
      { text: "  see src/components/" },
      { text: "  and then continue" },
    ];

    expect(await provideLinksForRows(rows, 0)).toHaveLength(0);
    expect(await provideLinksForRows(rows, 1)).toHaveLength(0);
  });
});
