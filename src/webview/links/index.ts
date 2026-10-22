import type { Terminal } from "@xterm/xterm";
import { postMessage } from "../shared/vscode-api";

interface Link {
  text: string;
  range: {
    start: { x: number; y: number };
    end: { x: number; y: number };
  };
  decorations: { underline: boolean; pointerCursor: boolean };
  activate: (event: MouseEvent, text: string) => void;
  hover?: (event: MouseEvent, text: string) => void;
  leave?: (event: MouseEvent, text: string) => void;
  dispose?: () => void;
}

const MAX_LINE_LENGTH = 10000;
const MAX_WRAP_ROWS = 6;
const MAX_WRAPPED_REFERENCE_LENGTH = 4096;

// OpenCode renders the transcript next to a fixed-width right pane without a
// border character, so sidebar tokens share buffer rows with chat content.
const OPENCODE_SIDEBAR_WIDTH = 42;

type ParsedFileReference = {
  readonly path: string;
  readonly line?: number;
  readonly endLine?: number;
  readonly column?: number;
};

type CandidateReference = {
  readonly text: string;
  readonly startIndex: number;
};

type LineToken = {
  readonly text: string;
  // Token text before trailing prose punctuation was stripped. Cross-line
  // joins use this so a wrap after "v1." is not corrupted into "v12.ts".
  readonly rawText: string;
  readonly startIndex: number;
  readonly endIndex: number;
};

type RowFragment = {
  readonly row: number;
  readonly token: LineToken;
  readonly cellOffsets: ReadonlyArray<number>;
};

type CrossLineReference = {
  readonly reference: ParsedFileReference;
  readonly fragments: ReadonlyArray<RowFragment>;
};

type RowData = {
  readonly text: string | null;
  readonly cellOffsets: number[] | null;
  readonly tokens: ReadonlyArray<LineToken>;
};

const isTokenBoundary = (char: string): boolean => {
  if (char === "") return false;
  if (/\s/.test(char) || char === "\"" || char === "'") return true;

  // Common prose punctuation that never starts/continues a path token.
  // NOTE: ":" and "." are intentionally NOT boundaries — they are needed for
  // drive letters (C:), line:col suffixes (file.ts:120:5), extensions, and
  // relative paths (./, ../). They are handled by trailing-punctuation strip.
  if (",;!?".includes(char)) return true;

  // Treat CJK / fullwidth punctuation as boundaries so paths are not glued
  // to surrounding localized text (e.g. "index.ts。我先" / "file.json，30").
  const code = char.codePointAt(0) ?? 0;
  if (code >= 0xff01 && code <= 0xff60) return true; // Fullwidth ASCII variants
  if (code >= 0xffe0 && code <= 0xffe6) return true; // Fullwidth signs
  if (code >= 0x3000 && code <= 0x303f) return true; // CJK Symbols and Punctuation
  if (code >= 0xfe30 && code <= 0xfe4f) return true; // CJK Compatibility Forms
  return false;
};

// Approximate xterm cell width for a codepoint. CJK / fullwidth / emoji
// characters occupy 2 cells; combining/control chars occupy 0; the rest 1.
const getCellWidth = (code: number): number => {
  if (code < 0x20 || code === 0x7f) return 0;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3040 && code <= 0x33bf) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0xa4cf) ||
    (code >= 0xa960 && code <= 0xa97f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
};

// Trailing punctuation that may legitimately appear right after a path in
// prose (ASCII + CJK/fullwidth) but is never part of the path itself.
// Stripped after tokenization so the opened path and underline end exactly
// on the last path character.
const TRAILING_PUNCTUATION = new Set([
  ",", ".", ";", "!", "?", ")", "]", "}",
  "\u3001", "\u3002",           // 、 。
  "\uff0c", "\uff0e", "\uff1b", "\uff01", "\uff1f", "\uff09", "\uff3d", // ， ． ； ！ ？ ） ］
  "\u300b", "\u300d", "\u300f", "\u3011", "\u3017", // 》 」 』 】 〗
]);

const stripTrailingPunctuation = (text: string): string => {
  let end = text.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(text[end - 1] ?? "")) {
    end--;
  }
  return end === text.length ? text : text.slice(0, end);
};

// Build a map from UTF-16 string index -> starting cell x for every position,
// plus the total cell width at the end. Used to convert string offsets
// (returned by the tokenizer) into xterm cell coordinates.
const buildCellOffsets = (lineText: string): number[] => {
  const offsets: number[] = new Array<number>(lineText.length + 1);
  let cell = 0;
  let index = 0;

  while (index < lineText.length) {
    const codePoint = lineText.codePointAt(index) ?? 0;
    const charLength = codePoint > 0xffff ? 2 : 1;
    offsets[index] = cell;
    if (charLength === 2) {
      offsets[index + 1] = cell;
    }
    cell += getCellWidth(codePoint);
    index += charLength;
  }

  offsets[lineText.length] = cell;
  return offsets;
};

const collectCandidateReferences = (
  lineText: string,
): ReadonlyArray<CandidateReference> => {
  const candidates: CandidateReference[] = [];
  let index = 0;

  while (index < lineText.length) {
    while (index < lineText.length && isTokenBoundary(lineText[index] ?? "")) {
      index++;
    }

    const startIndex = index;
    while (index < lineText.length && !isTokenBoundary(lineText[index] ?? "")) {
      index++;
    }

    if (index > startIndex) {
      candidates.push({
        text: lineText.slice(startIndex, index),
        startIndex,
      });
    }
  }

  return candidates;
};

const collectTokens = (lineText: string): LineToken[] => {
  const tokens: LineToken[] = [];

  for (const candidate of collectCandidateReferences(lineText)) {
    const text = stripTrailingPunctuation(candidate.text);
    if (!text) continue;
    tokens.push({
      text,
      rawText: candidate.text,
      startIndex: candidate.startIndex,
      endIndex: candidate.startIndex + text.length,
    });
  }

  return tokens;
};

const SINGLE_FILE_RE =
  /^[A-Za-z0-9_.-]+\.(?:c|cc|cpp|cs|css|cts|env|fish|go|h|hpp|html|java|js|json|jsx|kt|lock|lua|md|mjs|mts|php|py|rb|rs|scss|sh|swift|toml|ts|tsx|txt|yaml|yml|zsh)(?::\d+(?::\d+)?)?(?:#L?\d+(?:-L?\d+)?)?$/i;

const hasNonDriveLabelPrefix = (reference: string): boolean => {
  const colonIdx = reference.indexOf(":");
  if (colonIdx <= 0) {
    return false;
  }

  const beforeColon = reference.slice(0, colonIdx);
  const afterColon = reference.slice(colonIdx + 1);
  return (
    !/^[A-Za-z]$/.test(beforeColon) &&
    !reference.startsWith("file://") &&
    afterColon.includes("/")
  );
};

const isLikelyFileReference = (candidate: string): boolean => {
  const withoutAtPrefix = candidate.startsWith("@")
    ? candidate.slice(1)
    : candidate;

  // The first character must be a plausible path-start character to
  // avoid false positives when CJK text is adjacent to a file path
  // without a space separator (e.g. "因为some/path.ts").
  if (!/^[a-zA-Z0-9_\-\.\/\\~]/.test(withoutAtPrefix)) {
    return false;
  }

  // Reject label:path patterns where a non-drive-letter word precedes
  // a slash-containing path (e.g. "Error:src/file.ts", "git:some/branch").
  if (hasNonDriveLabelPrefix(withoutAtPrefix)) {
    return false;
  }

  return (
    withoutAtPrefix.startsWith("file://") ||
    withoutAtPrefix.startsWith("/") ||
    withoutAtPrefix.startsWith("./") ||
    withoutAtPrefix.startsWith("../") ||
    /^[A-Za-z]:\\/.test(withoutAtPrefix) ||
    SINGLE_FILE_RE.test(withoutAtPrefix) ||
    // Bare relative path fallback (e.g. "src/webview/links/index.ts" or
    // Windows-style "liveai-server\src\main\java\...\PptExtractor.java").
    // Require a path separator ("/" or "\"), a ".", AND restrict to ASCII
    // path chars so localized text or code snippets are not misread.
    (!/^[a-z][a-z0-9+\-.]*:\/\//i.test(withoutAtPrefix) &&
      (withoutAtPrefix.includes("/") || withoutAtPrefix.includes("\\")) &&
      withoutAtPrefix.includes(".") &&
      /^[@A-Za-z0-9._\-/\\~:{}]+$/.test(withoutAtPrefix))
  );
};

const parsePositiveInteger = (value: string | undefined): number | undefined => {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const extractHashLineSuffix = (
  reference: string,
): { readonly reference: string; readonly line?: number; readonly endLine?: number } => {
  // Accept both `#L10`-style and OpenCode's bare `#10` suffixes; the digits
  // must immediately follow `#` so plain `#` text is not swallowed.
  const match = /^(.*)#L?(\d+)(?:-L?(\d+))?$/.exec(reference);
  if (!match) {
    return { reference };
  }

  return {
    reference: match[1] ?? reference,
    line: parsePositiveInteger(match[2]),
    endLine: parsePositiveInteger(match[3]),
  };
};

const extractColonSuffix = (
  reference: string,
): { readonly reference: string; readonly line?: number; readonly column?: number } => {
  const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(reference);
  if (!match) {
    return { reference };
  }

  return {
    reference: match[1] ?? reference,
    line: parsePositiveInteger(match[2]),
    column: parsePositiveInteger(match[3]),
  };
};

const parseFileReference = (candidate: string): ParsedFileReference | null => {
  const withoutAtPrefix = candidate.startsWith("@")
    ? candidate.slice(1)
    : candidate;
  const hashSuffix = extractHashLineSuffix(withoutAtPrefix);
  const colonSuffix = extractColonSuffix(hashSuffix.reference);
  let path = colonSuffix.reference;

  if (!path) {
    return null;
  }

  if (path.startsWith("file://")) {
    try {
      const url = new URL(path);
      path = decodeURIComponent(url.pathname);
      if (url.hostname && !url.pathname.startsWith("/")) {
        path = `${url.hostname}:${path}`;
      }
    } catch {
      return null;
    }
  }

  return {
    path,
    line: hashSuffix.line ?? colonSuffix.line,
    endLine: hashSuffix.endLine,
    column: colonSuffix.column,
  };
};

const PATH_TOKEN_RE = /^[@A-Za-z0-9._\-/\\~:{}#]+$/;

const isPathToken = (text: string): boolean => {
  const withoutAtPrefix = text.startsWith("@") ? text.slice(1) : text;
  return (
    /^[a-zA-Z0-9_\-\.\/\\~]/.test(withoutAtPrefix) &&
    PATH_TOKEN_RE.test(text) &&
    !hasNonDriveLabelPrefix(withoutAtPrefix)
  );
};

const stripReferenceSuffixes = (text: string): string => {
  const withoutAtPrefix = text.startsWith("@") ? text.slice(1) : text;
  const withoutHash = withoutAtPrefix.replace(/#L?\d+(?:-L?\d+)?$/, "");
  return withoutHash.replace(/:\d+(?::\d+)?$/, "");
};

const hasCompletePathEnding = (text: string): boolean => {
  const value = stripReferenceSuffixes(text);
  const basename = value.split(/[/\\]/).pop() ?? "";

  if (!basename || basename.endsWith(".")) {
    return false;
  }

  return /\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(basename);
};

const isIncompletePathToken = (text: string): boolean =>
  isPathToken(text) &&
  /[A-Za-z0-9]/.test(text) &&
  (text.includes("/") || text.includes("\\")) &&
  !hasCompletePathEnding(text);

const isPathContinuationToken = (text: string): boolean =>
  isPathToken(text) && /[A-Za-z0-9]/.test(text);

const isPathLikeJoined = (text: string): boolean =>
  isPathToken(text) && (text.includes("/") || text.includes("\\"));

const tokenStartCell = (data: RowData, token: LineToken): number =>
  data.cellOffsets?.[token.startIndex] ?? 0;

// A wrapped path fragment is the last transcript content on its row. Any
// following prose means the path ended there rather than continuing below.
// Trailing dots are allowed because a wrap can split right after "v1.".
const hasFollowingTranscriptText = (
  data: RowData,
  token: LineToken,
  sidebarStart: number,
): boolean => {
  const text = data.text;
  const cellOffsets = data.cellOffsets;
  if (text === null || !cellOffsets) {
    return false;
  }

  let index = token.endIndex;
  while (text[index] === ".") {
    index++;
  }

  for (; index < text.length; index++) {
    if ((cellOffsets[index] ?? 0) >= sidebarStart) {
      break;
    }
    if (!/\s/.test(text[index] ?? "")) {
      return true;
    }
  }

  return false;
};

const createRowReader = (terminal: Terminal) => {
  const cache = new Map<number, RowData>();

  return (row: number): RowData => {
    const cached = cache.get(row);
    if (cached) {
      return cached;
    }

    const line = row >= 0 ? terminal.buffer.active.getLine(row) : undefined;
    if (!line) {
      const data: RowData = { text: null, cellOffsets: null, tokens: [] };
      cache.set(row, data);
      return data;
    }

    const text = line.translateToString(true);
    if (text.length > MAX_LINE_LENGTH) {
      const data: RowData = { text: null, cellOffsets: null, tokens: [] };
      cache.set(row, data);
      return data;
    }

    const data: RowData = {
      text,
      cellOffsets: buildCellOffsets(text),
      tokens: collectTokens(text),
    };
    cache.set(row, data);
    return data;
  };
};

const getSidebarStart = (terminal: Terminal): number => {
  const cols = terminal.cols;
  return typeof cols === "number" && cols > OPENCODE_SIDEBAR_WIDTH
    ? cols - OPENCODE_SIDEBAR_WIDTH
    : Number.POSITIVE_INFINITY;
};

const overlaps = (a: LineToken, b: LineToken): boolean =>
  a.startIndex < b.endIndex && b.startIndex < a.endIndex;

type HoverUnderlineManager = {
  show(fragments: ReadonlyArray<RowFragment>, owner: object): void;
  hide(owner: object): void;
};

const createUnderlineLayer = (
  screen: HTMLElement,
  terminal: Terminal,
  fragments: ReadonlyArray<RowFragment>,
): HTMLElement | null => {
  const rect = screen.getBoundingClientRect();
  const cellWidth = rect.width / terminal.cols;
  const cellHeight = rect.height / terminal.rows;

  if (
    !Number.isFinite(cellWidth) ||
    !Number.isFinite(cellHeight) ||
    cellWidth <= 0 ||
    cellHeight <= 0
  ) {
    return null;
  }

  const doc = screen.ownerDocument;
  const layer = doc.createElement("div");
  layer.className = "opencode-link-underline-layer";
  layer.style.position = "absolute";
  layer.style.left = "0";
  layer.style.top = "0";
  layer.style.width = "100%";
  layer.style.height = "100%";
  layer.style.pointerEvents = "none";
  layer.style.zIndex = "6";

  const viewportY = terminal.buffer.active.viewportY;

  for (const fragment of fragments) {
    const viewportRow = fragment.row - viewportY;
    if (viewportRow < 0 || viewportRow >= terminal.rows) continue;

    const startCell = fragment.cellOffsets[fragment.token.startIndex] ?? 0;
    const endCell = fragment.cellOffsets[fragment.token.endIndex] ?? startCell;
    if (endCell <= startCell) continue;

    const line = doc.createElement("div");
    line.className = "opencode-link-underline";
    line.style.position = "absolute";
    line.style.left = `${startCell * cellWidth}px`;
    line.style.top = `${viewportRow * cellHeight}px`;
    line.style.width = `${(endCell - startCell) * cellWidth}px`;
    line.style.height = `${cellHeight}px`;
    line.style.boxSizing = "border-box";
    line.style.borderBottom =
      "1px solid var(--terminal-foreground, #cccccc)";
    line.style.pointerEvents = "none";
    layer.appendChild(line);
  }

  screen.appendChild(layer);
  return layer;
};

const createHoverUnderlineManager = (
  terminal: Terminal,
): HoverUnderlineManager => {
  let activeOwner: object | undefined;
  let layer: HTMLElement | undefined;

  const clear = (): void => {
    layer?.remove();
    layer = undefined;
    activeOwner = undefined;
  };

  return {
    show(fragments, owner) {
      clear();

      // xterm hides BufferDecorations while the alternate screen buffer is
      // active, which is how full-screen TUIs like OpenCode run, so the
      // underline is a plain overlay positioned from the cell grid instead.
      const screen = terminal.element?.querySelector<HTMLElement>(
        ".xterm-screen",
      );
      if (!screen) return;

      const nextLayer = createUnderlineLayer(screen, terminal, fragments);
      if (!nextLayer) return;

      layer = nextLayer;
      activeOwner = owner;
    },
    hide(owner) {
      if (activeOwner === owner) {
        clear();
      }
    },
  };
};

type CrossLineLinkOptions = {
  readonly underline: HoverUnderlineManager;
  readonly fragments: ReadonlyArray<RowFragment>;
};

const createFileLink = (
  row: number,
  cellOffsets: ReadonlyArray<number>,
  token: LineToken,
  reference: ParsedFileReference,
  crossLine?: CrossLineLinkOptions,
): Link => {
  const startCell = cellOffsets[token.startIndex] ?? 0;
  const endCell = cellOffsets[token.endIndex] ?? startCell;
  const owner = {};

  const link: Link = {
    text: token.text,
    range: {
      start: { x: startCell + 1, y: row + 1 },
      end: { x: endCell, y: row + 1 },
    },
    // xterm underlines multi-row ranges as one rectangle, which would cover
    // the OpenCode sidebar; wrapped links draw a per-fragment DOM overlay
    // instead so hovering any fragment underlines the whole path.
    decorations: { underline: crossLine === undefined, pointerCursor: true },
    activate: () => {
      postMessage({
        type: "openFile",
        path: reference.path,
        line: reference.line,
        endLine: reference.endLine,
        column: reference.column,
      });
    },
  };

  if (crossLine) {
    link.hover = () => crossLine.underline.show(crossLine.fragments, owner);
    link.leave = () => crossLine.underline.hide(owner);
    link.dispose = () => crossLine.underline.hide(owner);
  }

  return link;
};

const findCrossLineReference = (
  terminal: Terminal,
  requestedRow: number,
  readRow: (row: number) => RowData,
): CrossLineReference | null => {
  const sidebarStart = getSidebarStart(terminal);
  const firstStartRow = Math.max(0, requestedRow - MAX_WRAP_ROWS + 1);

  const startCandidates = (
    data: RowData,
    includeSidebar: boolean,
  ): LineToken[] => {
    const candidates: LineToken[] = [];

    for (const token of data.tokens) {
      if (!isIncompletePathToken(token.text)) continue;
      const inSidebar = tokenStartCell(data, token) >= sidebarStart;
      if (inSidebar === includeSidebar) {
        candidates.push(token);
      }
    }

    return candidates.reverse();
  };

  const continuationCandidate = (
    data: RowData,
    includeSidebar: boolean,
  ): LineToken | undefined => {
    const transcript: LineToken[] = [];
    const sidebar: LineToken[] = [];

    for (const token of data.tokens) {
      if (!isPathContinuationToken(token.text)) continue;
      if (tokenStartCell(data, token) < sidebarStart) {
        transcript.push(token);
      } else {
        sidebar.push(token);
      }
    }

    // Sidebar tokens are only a fallback when the pane is hidden (pass 2);
    // in pass 1 a transcript fragment must continue in the transcript.
    return transcript[0] ?? (includeSidebar ? sidebar[0] : undefined);
  };

  // Try transcript fragments first so sidebar paths never win over a real
  // wrapped transcript path. Sidebar candidates remain a fallback for when
  // the pane is hidden and chat text legitimately extends into that region.
  for (const includeSidebar of [false, true]) {
    for (let startRow = firstStartRow; startRow <= requestedRow; startRow++) {
      const startData = readRow(startRow);
      const startCellOffsets = startData.cellOffsets;
      if (!startCellOffsets) continue;

      for (const startToken of startCandidates(startData, includeSidebar)) {
        if (hasFollowingTranscriptText(startData, startToken, sidebarStart)) {
          continue;
        }

        const fragments: RowFragment[] = [
          { row: startRow, token: startToken, cellOffsets: startCellOffsets },
        ];
        let joined = startToken.rawText;
        let completed = false;

        for (let row = startRow + 1; row < startRow + MAX_WRAP_ROWS; row++) {
          const data = readRow(row);
          if (data.text === null || !data.cellOffsets) break;

          const token = continuationCandidate(data, includeSidebar);
          if (!token) break;

          const tentative = joined + token.rawText;
          if (tentative.length > MAX_WRAPPED_REFERENCE_LENGTH) break;
          if (!isPathLikeJoined(tentative)) break;

          // The last fragment may be followed by prose (e.g. ": 179 passed");
          // intermediate fragments must occupy the rest of the wrapped row.
          const completedTentative = joined + token.text;
          const completes =
            isPathLikeJoined(completedTentative) &&
            hasCompletePathEnding(completedTentative);

          if (!completes && hasFollowingTranscriptText(data, token, sidebarStart)) {
            break;
          }

          fragments.push({ row, token, cellOffsets: data.cellOffsets });
          joined = completes ? completedTentative : tentative;

          if (completes) {
            completed = true;
            break;
          }
        }

        if (!completed) continue;
        if (!fragments.some((fragment) => fragment.row === requestedRow)) continue;

        const reference = parseFileReference(joined);
        if (!reference || !isLikelyFileReference(joined)) continue;

        return { reference, fragments };
      }
    }
  }

  return null;
};

export function createLinkProvider(terminal: Terminal) {
  const underline = createHoverUnderlineManager(terminal);

  return {
    provideLinks(
      bufferLineNumber: number,
      callback: (links: Link[] | undefined) => void,
    ) {
      // xterm.js passes 1-based bufferLineNumber; getLine expects 0-based.
      const row = bufferLineNumber - 1;
      const readRow = createRowReader(terminal);
      const current = readRow(row);

      if (current.text === null || !current.cellOffsets) {
        callback(undefined);
        return;
      }

      const crossLine = findCrossLineReference(terminal, row, readRow);
      const crossFragment = crossLine?.fragments.find(
        (fragment) => fragment.row === row,
      );

      const links: Link[] = [];
      if (crossLine && crossFragment) {
        links.push(
          createFileLink(
            row,
            current.cellOffsets,
            crossFragment.token,
            crossLine.reference,
            { underline, fragments: crossLine.fragments },
          ),
        );
      }

      for (const token of current.tokens) {
        if (crossFragment && overlaps(token, crossFragment.token)) continue;
        if (!isLikelyFileReference(token.text)) continue;

        const reference = parseFileReference(token.text);
        if (!reference) continue;
        links.push(createFileLink(row, current.cellOffsets, token, reference));
      }

      callback(links);
    },
  };
}
