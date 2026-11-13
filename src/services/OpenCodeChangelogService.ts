import { OutputChannelService } from "./OutputChannelService";

/**
 * Fetches per-version release notes for the OpenCode v2 CLI.
 *
 * The primary source is the official `changelog.json` feed: one structured
 * release per tag with features, breaking changes, improvements, fixes,
 * dates, PRs, and credits. The rendered changelog page used to carry
 * static `<article>` blocks, but the current page is a client-rendered
 * timeline (`<li id="v2.3.0"><span id="v2-3-0">…`) whose markup no longer
 * matches; it stays as a fallback for versions the JSON feed has not
 * published yet, because the two endpoints can be served from different
 * cache generations while a release is rolling out.
 */

const CHANGELOG_PAGE_URL = "https://opencode.ai/changelog";
const CHANGELOG_FEED_URL = "https://opencode.ai/changelog.json";
const CHANGELOG_FETCH_TIMEOUT_MS = 10_000;
const CACHE_KEY_PREFIX = "opencodeChangelog.";

/** Release notes are immutable, so a successful fetch is cached forever. */
export interface OpenCodeChangelogEntry {
  version: string;
  date?: string;
  html: string;
}

export type OpenCodeChangelogResult =
  | ({ ok: true } & OpenCodeChangelogEntry)
  | { ok: false; version: string; error: string };

/** Minimal Memento-shaped persistence for changelog entries. */
export interface OpenCodeChangelogStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export interface OpenCodeChangelogServiceOptions {
  logger?: Pick<
    OutputChannelService,
    "debug" | "info" | "warn" | "error"
  >;
}

/** Release anchors encode the version with dashes: 2.0.28 -> v2-0-28. */
export function changelogAnchorId(version: string): string {
  return `v${version.replace(/\./g, "-")}`;
}

/** Changelog page URL, with the per-version anchor when a version is known. */
export function changelogPageUrl(version?: string): string {
  return version
    ? `${CHANGELOG_PAGE_URL}#${changelogAnchorId(version)}`
    : CHANGELOG_PAGE_URL;
}

/**
 * Defense-in-depth cleanup of the official HTML. The webview CSP already
 * blocks injected scripts (nonce-only script-src), and anchors are
 * intercepted at click time, so this only needs to remove the obvious
 * hazards in case the upstream page is ever compromised.
 */
export function sanitizeChangelogHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/javascript:/gi, "#blocked:");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** One structured release entry from the changelog feed. */
interface ChangelogFeedItem {
  title?: string;
  body?: string;
  text?: string;
  areas: string[];
  prs: string[];
  credits: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function feedItems(value: unknown): ChangelogFeedItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).map((item) => ({
    title: typeof item.title === "string" ? item.title : undefined,
    body: typeof item.body === "string" ? item.body : undefined,
    text: typeof item.text === "string" ? item.text : undefined,
    areas: asStrings(item.areas),
    prs: asStrings(item.prs),
    credits: asStrings(item.credits),
  }));
}

/**
 * Minimal Markdown rendering for feed bodies: inline code, bold, links,
 * flat lists, fenced code, and paragraphs. Everything is escaped before
 * formatting, so feed text can never inject markup.
 */
function renderInline(text: string): string {
  const codeSpans: string[] = [];
  let html = escapeHtml(text).replace(/`([^`]+)`/g, (_match, code: string) => {
    const index = codeSpans.push(`<code>${code}</code>`) - 1;
    return `\u0000${index}\u0000`;
  });
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_match, label: string, href: string) =>
      `<a href="${href}">${label}</a>`,
  );
  return html.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => {
    return codeSpans[Number(index)] ?? "";
  });
}

const LIST_ITEM_RE = /^[-*]\s+(.*)$/;

function renderBlocks(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length) {
      html.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };
  const flushList = (): void => {
    if (list.length) {
      html.push(
        `<ul>${list.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ul>`,
      );
      list = [];
    }
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      flushParagraph();
      flushList();
      const code: string[] = [];
      for (index++; index < lines.length; index++) {
        if (lines[index].trim().startsWith("```")) {
          break;
        }
        code.push(lines[index]);
      }
      html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }
    const item = LIST_ITEM_RE.exec(trimmed);
    if (item) {
      flushParagraph();
      list.push(item[1]);
      continue;
    }
    flushList();
    paragraph.push(trimmed);
  }
  flushParagraph();
  flushList();
  return html.join("");
}

const PR_NUMBER_RE = /^\d+$/;
const CREDIT_NAME_RE = /^[A-Za-z0-9-]+$/;

/** PR and contributor links appended after one feed item. */
function renderFeedRefs(item: ChangelogFeedItem): string {
  const links = [
    ...item.prs.filter((pr) => PR_NUMBER_RE.test(pr)).map(
      (pr) =>
        `<a href="https://github.com/anomalyco/opencode/pull/${pr}">#${pr}</a>`,
    ),
    ...item.credits.filter((name) => CREDIT_NAME_RE.test(name)).map(
      (name) => `<a href="https://github.com/${name}">@${name}</a>`,
    ),
  ];
  return links.length ? `<p class="refs">(${links.join(", ")})</p>` : "";
}

function renderFeatures(items: ChangelogFeedItem[]): string {
  if (!items.length) {
    return "";
  }
  const entries = items
    .map((item) => {
      const title = item.title
        ? `<p class="title">${renderInline(item.title)}</p>`
        : "";
      const body = item.body ?? item.text ?? "";
      return `<li>${title}${body ? renderBlocks(body) : ""}${renderFeedRefs(item)}</li>`;
    })
    .join("");
  return `<section class="highlights"><ul>${entries}</ul></section>`;
}

function renderFeedList(items: ChangelogFeedItem[], label: string): string {
  if (!items.length) {
    return "";
  }
  const entries = items
    .map((item) => {
      const area = item.areas.length
        ? `<strong>${escapeHtml(item.areas.join(", "))}:</strong> `
        : "";
      const text = item.text ?? item.body ?? "";
      return `<li>${area}${renderInline(text)}${renderFeedRefs(item)}</li>`;
    })
    .join("");
  return (
    `<details class="section" open><summary><span class="label">${label}</span></summary>` +
    `<div class="markdown"><ul>${entries}</ul></div></details>`
  );
}

function renderBreaking(items: ChangelogFeedItem[]): string {
  if (!items.length) {
    return "";
  }
  const entries = items
    .map((item) => {
      const title = item.title
        ? `<p><strong>${renderInline(item.title)}</strong></p>`
        : "";
      const body = item.body ?? item.text ?? "";
      return `<li>${title}${body ? renderBlocks(body) : ""}${renderFeedRefs(item)}</li>`;
    })
    .join("");
  return (
    `<details class="section" open><summary><span class="label">Breaking changes</span></summary>` +
    `<div class="markdown"><ul>${entries}</ul></div></details>`
  );
}

/** Legacy v1 feed sections: `{ title, items: [markdown] }`. */
function renderLegacySections(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .filter(isRecord)
    .map((section) => {
      const items = asStrings(section.items);
      if (!items.length) {
        return "";
      }
      const label =
        typeof section.title === "string" && section.title
          ? escapeHtml(section.title)
          : "Changes";
      const entries = items
        .map((item) => `<li>${renderInline(item)}</li>`)
        .join("");
      return (
        `<details class="section" open><summary><span class="label">${label}</span></summary>` +
        `<div class="markdown"><ul>${entries}</ul></div></details>`
      );
    })
    .join("");
}

/**
 * Builds the release-notes HTML from one `changelog.json` payload. Returns
 * undefined when the payload is malformed or the version is absent. The
 * generated markup reuses the dialog's existing class names
 * (`highlights`, `section`, `markdown`), so no webview change is needed.
 */
export function releaseNotesFromFeed(
  payload: unknown,
  version: string,
): { html: string; date?: string } | undefined {
  const releases =
    isRecord(payload) && Array.isArray(payload.releases)
      ? payload.releases.filter(isRecord)
      : [];
  const wanted = new Set([version, `v${version}`]);
  const release = releases.find(
    (entry) =>
      (typeof entry.tag === "string" && wanted.has(entry.tag)) ||
      (typeof entry.name === "string" && wanted.has(entry.name)),
  );
  if (!release) {
    return undefined;
  }

  const notes = isRecord(release.notes) ? release.notes : {};
  const features = feedItems(notes.features);
  const html = sanitizeChangelogHtml(
    [
      features.length ? renderFeatures(features) : renderFeatures(feedItems(release.highlights)),
      renderBreaking(feedItems(notes.breaking)),
      renderFeedList(feedItems(notes.improved), "Improvements"),
      renderFeedList(feedItems(notes.fixed), "Fixes"),
      renderLegacySections(release.sections),
    ].join(""),
  ).trim();
  if (!html) {
    return undefined;
  }

  const rawDate = typeof release.date === "string" ? release.date : "";
  const date = /^\d{4}-\d{2}-\d{2}/.test(rawDate)
    ? rawDate.slice(0, 10)
    : undefined;
  return { html, date };
}

function lastIndexBefore(html: string, pattern: RegExp, before: number): number {
  let found = -1;
  pattern.lastIndex = 0;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    if (match.index >= before) {
      break;
    }
    found = match.index;
  }
  return found;
}

/**
 * Finds the closing tag that pairs with an already-opened wrapper, so a
 * list item nested inside a release entry cannot truncate the block.
 */
function findClosingTag(
  html: string,
  name: string,
  afterOpenTag: number,
): number {
  const openRe = new RegExp(`<${name}\\b`, "gi");
  const closeRe = new RegExp(`</${name}>`, "gi");
  let depth = 1;
  let cursor = afterOpenTag;
  while (true) {
    openRe.lastIndex = cursor;
    closeRe.lastIndex = cursor;
    const open = openRe.exec(html);
    const close = closeRe.exec(html);
    if (!close) {
      return -1;
    }
    if (open && open.index < close.index) {
      depth++;
      cursor = open.index + open[0].length;
    } else {
      depth--;
      if (depth === 0) {
        return close.index;
      }
      cursor = close.index + close[0].length;
    }
  }
}

/**
 * Extracts one release entry from the changelog page HTML. Supports both
 * the current timeline markup (`<li id="v2.3.0"><span id="v2-3-0">`) and
 * the legacy `<article id="v2-0-28">` blocks. Returns the entry's inner
 * HTML without its header (the dialog title carries the version) plus the
 * release date, or undefined when the version is not on the page.
 */
export function extractReleaseHtml(
  pageHtml: string,
  version: string,
): { html: string; date?: string } | undefined {
  const anchors = [
    `id="${changelogAnchorId(version)}"`,
    `id="v${version}"`,
  ];
  let anchorAt = -1;
  for (const anchor of anchors) {
    anchorAt = pageHtml.indexOf(anchor);
    if (anchorAt !== -1) {
      break;
    }
  }
  if (anchorAt === -1) {
    return undefined;
  }

  const starts = [
    { start: lastIndexBefore(pageHtml, /<article\b/gi, anchorAt), name: "article" },
    { start: lastIndexBefore(pageHtml, /<li\b/gi, anchorAt), name: "li" },
  ].filter((candidate) => candidate.start !== -1);
  if (!starts.length) {
    return undefined;
  }
  const wrapper = starts.sort((a, b) => b.start - a.start)[0];
  const openTagEnd = pageHtml.indexOf(">", wrapper.start);
  if (openTagEnd === -1) {
    return undefined;
  }
  const end = findClosingTag(pageHtml, wrapper.name, openTagEnd + 1);
  if (end === -1) {
    return undefined;
  }
  const endTag = `</${wrapper.name}>`;

  const block = pageHtml.slice(wrapper.start, end + endTag.length);
  const date = block.match(/datetime="([^"]+)"/)?.[1];
  const inner = block
    .replace(new RegExp(`^<${wrapper.name}\\b[^>]*>`, "i"), "")
    .replace(new RegExp(`</${wrapper.name}>\\s*$`, "i"), "")
    // Drop the version header: the dialog title already shows it.
    .replace(/<header[\s\S]*?<\/header>/i, "")
    .trim();
  return { html: sanitizeChangelogHtml(inner), date };
}

export class OpenCodeChangelogService {
  private readonly store: OpenCodeChangelogStore;
  private readonly logger: Pick<
    OutputChannelService,
    "debug" | "info" | "warn" | "error"
  >;
  private readonly inFlight = new Map<string, Promise<OpenCodeChangelogResult>>();

  public constructor(
    store: OpenCodeChangelogStore,
    { logger = OutputChannelService.getInstance() }: OpenCodeChangelogServiceOptions = {},
  ) {
    this.store = store;
    this.logger = logger;
  }

  /**
   * Resolves the release notes for one version: permanent cache first,
   * then one feed/page fetch shared by concurrent callers. Never throws;
   * failures return `{ ok: false, error }` and are not cached, so a
   * later call retries (e.g. after the feed publishes the version).
   */
  public async fetchChangelog(version: string): Promise<OpenCodeChangelogResult> {
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
      // Dev builds ("local") and garbage never hit the network.
      return { ok: false, version, error: "invalid version" };
    }
    const cached = this.store.get<OpenCodeChangelogEntry>(
      CACHE_KEY_PREFIX + version,
    );
    if (cached) {
      return { ok: true, ...cached };
    }
    const pending = this.inFlight.get(version);
    if (pending) {
      return pending;
    }
    const task = this.fetchRelease(version);
    this.inFlight.set(version, task);
    try {
      return await task;
    } finally {
      if (this.inFlight.get(version) === task) {
        this.inFlight.delete(version);
      }
    }
  }

  private async fetchRelease(
    version: string,
  ): Promise<OpenCodeChangelogResult> {
    const feed = await this.fetchFromFeed(version);
    let entry = feed.entry;
    let source = "feed";
    if (!entry) {
      const page = await this.fetchFromPage(version);
      entry = page.entry;
      source = "page";
      if (!entry) {
        const error = `${feed.error}; ${page.error}`;
        this.logger.debug(
          `[OpenCodeChangelogService] changelog unavailable for ${version}: ${error}`,
        );
        return { ok: false, version, error };
      }
    }

    const resolved: OpenCodeChangelogEntry = {
      version,
      date: entry.date,
      html: entry.html,
    };
    try {
      await this.store.update(CACHE_KEY_PREFIX + version, resolved);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[OpenCodeChangelogService] caching changelog for ${version} failed: ${message}`,
      );
    }
    this.logger.debug(
      `[OpenCodeChangelogService] cached changelog for ${version} from ${source} (${entry.html.length} chars)`,
    );
    return { ok: true, ...resolved };
  }

  private async fetchFromFeed(
    version: string,
  ): Promise<{ entry?: { html: string; date?: string }; error: string }> {
    try {
      const response = await fetch(CHANGELOG_FEED_URL, {
        signal: AbortSignal.timeout(CHANGELOG_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        return { error: `changelog feed returned ${response.status}` };
      }
      const entry = releaseNotesFromFeed(await response.json(), version);
      return entry
        ? { entry, error: "" }
        : { error: "version not found in the changelog feed" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: message };
    }
  }

  private async fetchFromPage(
    version: string,
  ): Promise<{ entry?: { html: string; date?: string }; error: string }> {
    try {
      const response = await fetch(CHANGELOG_PAGE_URL, {
        signal: AbortSignal.timeout(CHANGELOG_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        return { error: `changelog page returned ${response.status}` };
      }
      const entry = extractReleaseHtml(await response.text(), version);
      return entry
        ? { entry, error: "" }
        : { error: "version not found on the changelog page" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: message };
    }
  }
}
