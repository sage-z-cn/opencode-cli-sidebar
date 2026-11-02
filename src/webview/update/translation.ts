/**
 * Changelog translation helpers (webview side).
 *
 * The host only ever translates plain text blocks. This module extracts
 * text from the release-notes HTML, replaces everything that must stay
 * verbatim (inline code, links, version numbers, URLs) with numbered
 * placeholders, and rebuilds the HTML from the translated text. Model
 * output is never injected as markup: only text nodes and clones of the
 * original inline nodes are written back.
 *
 * Browser-only: uses a detached `div` for parsing.
 */
import type { ChangelogTextBlock } from "../../types";

declare global {
  interface Window {
    /** UI language injected by terminal/html.ts (`vscode.env.language`). */
    __OC_UPDATE_LANG__?: string;
  }
}

/** Blocks whose own text is translated. */
const BLOCK_SELECTOR = "p, li, h2, h3, h4, blockquote, td, th";
const BLOCK_TAGS = new Set([
  "p",
  "li",
  "h2",
  "h3",
  "h4",
  "blockquote",
  "td",
  "th",
]);

/**
 * Containers that end a block's own text. These are skipped while walking
 * a block's children and re-attached untouched after re-rendering, so
 * nested lists and tables keep their structure.
 */
const NESTED_BLOCK_TAGS = new Set([
  ...BLOCK_TAGS,
  "ul",
  "ol",
  "dl",
  "dt",
  "dd",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "div",
  "section",
  "article",
  "aside",
  "header",
  "footer",
  "figure",
  "figcaption",
]);

/** Inline nodes kept verbatim through a numbered placeholder. */
const INLINE_PLACEHOLDER_TAGS = new Set([
  "code",
  "pre",
  "kbd",
  "samp",
  "a",
  "strong",
  "em",
  "br",
]);

/** Marks re-attached nested containers; stripped before the output. */
const NESTED_MARK = "data-ocu-cl-nested";

const PLACEHOLDER_SPLIT_RE = /(⟦\d+⟧)/;
const PLACEHOLDER_RE = /^⟦(\d+)⟧$/;
const PROTECTED_TEXT_RE = /https?:\/\/\S+|\bv?\d+\.\d+(?:\.\d+)?\b|#\d+/g;

type PlaceholderSource =
  | { kind: "node"; node: Node }
  | { kind: "text"; text: string };

interface BlockRecord {
  id: string;
  /** Index inside `container.querySelectorAll(BLOCK_SELECTOR)`. */
  index: number;
  /** Placeholder numbers that belong to this block, in source order. */
  placeholders: number[];
}

/** Translation target language, or undefined when the UI is English. */
export function translationLanguage(): string | undefined {
  const value =
    typeof window === "undefined" ? undefined : window.__OC_UPDATE_LANG__;
  if (typeof value !== "string" || !value) return undefined;
  return value.toLowerCase().startsWith("en") ? undefined : value;
}

export interface ExtractedChangelog {
  blocks: ChangelogTextBlock[];
  render(translations: Record<string, string>): string;
}

function token(number: number): string {
  return `⟦${number}⟧`;
}

/**
 * Splits release-notes HTML into translatable text blocks and keeps the
 * parsed DOM so `render` can rebuild it without re-parsing.
 */
export function extractChangelog(html: string): ExtractedChangelog {
  const container = document.createElement("div");
  container.innerHTML = html;

  const placeholders = new Map<number, PlaceholderSource>();
  let nextNumber = 0;

  const addPlaceholder = (source: PlaceholderSource): number => {
    const number = nextNumber++;
    placeholders.set(number, source);
    return number;
  };

  const blocks: ChangelogTextBlock[] = [];
  const records: BlockRecord[] = [];
  const elements = Array.from(
    container.querySelectorAll<HTMLElement>(BLOCK_SELECTOR),
  );

  elements.forEach((element, index) => {
    if (element.closest("pre")) return;
    const parts: string[] = [];
    const numbers: number[] = [];
    collectOwnText(element, parts, numbers, addPlaceholder);
    const text = parts.join("").replace(/\s+/g, " ").trim();
    if (!text) return;
    const id = `b${blocks.length}`;
    blocks.push({ id, text });
    records.push({ id, index, placeholders: numbers });
  });

  return {
    blocks,
    render(translations: Record<string, string>): string {
      return renderChangelog(container, records, placeholders, translations);
    },
  };
}

function collectOwnText(
  parent: Element,
  parts: string[],
  numbers: number[],
  addPlaceholder: (source: PlaceholderSource) => number,
): void {
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      parts.push(protectText(child.nodeValue ?? "", numbers, addPlaceholder));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const element = child as Element;
    const tag = element.tagName.toLowerCase();
    if (INLINE_PLACEHOLDER_TAGS.has(tag)) {
      const number = addPlaceholder({ kind: "node", node: element });
      numbers.push(number);
      parts.push(token(number));
      continue;
    }
    if (NESTED_BLOCK_TAGS.has(tag)) {
      // Re-attached after re-rendering; never translated on its own here.
      element.setAttribute(NESTED_MARK, "");
      continue;
    }
    collectOwnText(element, parts, numbers, addPlaceholder);
  }
}

/** Replaces version numbers, issue refs and URLs so they stay verbatim. */
function protectText(
  text: string,
  numbers: number[],
  addPlaceholder: (source: PlaceholderSource) => number,
): string {
  let output = "";
  let last = 0;
  PROTECTED_TEXT_RE.lastIndex = 0;
  for (
    let match = PROTECTED_TEXT_RE.exec(text);
    match !== null;
    match = PROTECTED_TEXT_RE.exec(text)
  ) {
    output += text.slice(last, match.index);
    const number = addPlaceholder({ kind: "text", text: match[0] });
    numbers.push(number);
    output += token(number);
    last = match.index + match[0].length;
  }
  output += text.slice(last);
  return output;
}

function renderChangelog(
  container: HTMLElement,
  records: BlockRecord[],
  placeholders: Map<number, PlaceholderSource>,
  translations: Record<string, string>,
): string {
  const clone = container.cloneNode(true) as HTMLElement;
  const elements = Array.from(
    clone.querySelectorAll<HTMLElement>(BLOCK_SELECTOR),
  );

  // Deepest blocks first: a nested container keeps its already translated
  // content when the parent block is rebuilt and re-appends it.
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    const element = elements[record.index];
    const translated = translations[record.id];
    if (!element || typeof translated !== "string") continue;
    if (!translated.trim()) continue;

    const nested = Array.from(
      element.querySelectorAll<HTMLElement>(`[${NESTED_MARK}]`),
    );
    element.textContent = "";

    const used = new Set<number>();
    for (const part of translated.split(PLACEHOLDER_SPLIT_RE)) {
      const match = PLACEHOLDER_RE.exec(part);
      if (!match) {
        if (part) element.appendChild(document.createTextNode(part));
        continue;
      }
      const number = Number(match[1]);
      const source = placeholders.get(number);
      if (!source) continue;
      appendSource(element, source);
      used.add(number);
    }

    // Whatever the translation dropped goes back at the end so no inline
    // code, link or version number disappears.
    for (const number of record.placeholders) {
      if (used.has(number)) continue;
      const source = placeholders.get(number);
      if (source) appendSource(element, source);
    }

    for (const node of nested) element.appendChild(node);
  }

  clone
    .querySelectorAll<HTMLElement>(`[${NESTED_MARK}]`)
    .forEach((node) => node.removeAttribute(NESTED_MARK));

  return clone.innerHTML;
}

function appendSource(parent: HTMLElement, source: PlaceholderSource): void {
  if (source.kind === "node") {
    parent.appendChild(source.node.cloneNode(true));
    return;
  }
  parent.appendChild(document.createTextNode(source.text));
}
