import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  changelogAnchorId,
  changelogPageUrl,
  extractReleaseHtml,
  OpenCodeChangelogService,
  releaseNotesFromFeed,
  sanitizeChangelogHtml,
  type OpenCodeChangelogStore,
} from "./OpenCodeChangelogService";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const FEED_URL = "https://opencode.ai/changelog.json";
const PAGE_URL = "https://opencode.ai/changelog";

/** Structured release feed fixture (the service's primary source). */
const FEED = {
  releases: [
    {
      tag: "v2.3.0",
      name: "v2.3.0",
      date: "2026-11-13T08:55:07Z",
      url: "https://github.com/anomalyco/opencode/releases/tag/v2.3.0",
      highlights: [],
      sections: [],
      notes: {
        media: [],
        features: [
          {
            title: "Background **Subagents**",
            body:
              "Set `session.verbosity` or read the [docs](https://opencode.ai/docs).\n\n" +
              "- first\n- second",
            areas: ["Core"],
            prs: ["63382"],
            credits: [],
          },
        ],
        breaking: [
          {
            title: "`ImageResponse.image` is removed",
            body:
              "Read `response.images[0]` instead.\n\n" +
              "```diff\n-old\n+new\n```",
            areas: [],
            prs: ["63011"],
            credits: [],
          },
        ],
        improved: [
          {
            text: "Faster startup.",
            areas: ["Core"],
            prs: [],
            credits: ["alice"],
          },
        ],
        fixed: [
          {
            text: "Fixed a crash.",
            areas: [],
            prs: ["62034"],
            credits: [],
          },
        ],
      },
    },
    {
      tag: "v2.2.7",
      name: "v2.2.7",
      date: "2026-11-10T10:37:15Z",
      highlights: [],
      sections: [],
      notes: {
        media: [],
        features: [
          {
            title: "GitHub Copilot Auto",
            body: "Pick Auto in the model picker.",
            areas: [],
            prs: [],
            credits: [],
          },
        ],
        breaking: [],
        improved: [],
        fixed: [],
      },
    },
    {
      tag: "v1.19.5",
      name: "v1.19.5",
      date: "2026-10-01T00:00:00Z",
      highlights: [],
      sections: [{ title: "Core", items: ["First legacy item."] }],
      notes: { media: [], features: [], breaking: [], improved: [], fixed: [] },
    },
  ],
};

/** Current timeline markup: `<li id="v2.3.0"><span id="v2-3-0">`. */
const TIMELINE_ENTRY_230 =
  '<li id="v2.3.0"><span id="v2-3-0" data-slot="anchor"></span>' +
  '<header><time datetime="2026-11-13">Nov 13, 2026</time>' +
  '<a data-slot="version" href="/changelog/v2.3.0">v2.3.0</a></header>' +
  '<div data-component="changelog-entry"><h2>Background Subagents</h2>' +
  "<p>Body text.</p></div></li>";
const TIMELINE_ENTRY_227 =
  '<li id="v2.2.7"><span id="v2-2-7" data-slot="anchor"></span>' +
  '<header><time datetime="2026-11-10">Nov 10, 2026</time></header>' +
  '<div data-component="changelog-entry"><h2>GitHub Copilot Auto</h2></div></li>';

function timelinePage(...entries: string[]): string {
  return (
    '<html><body><ol data-component="changelog-timeline">' +
    entries.join("") +
    "</ol></body></html>"
  );
}

const TIMELINE_PAGE = timelinePage(TIMELINE_ENTRY_230, TIMELINE_ENTRY_227);
const TIMELINE_PAGE_WITHOUT_230 = timelinePage(TIMELINE_ENTRY_227);

/** Legacy static markup: `<article class="release" id="v2-0-28">`. */
function legacyArticle(
  version: string,
  date: string,
  title: string,
): string {
  const id = changelogAnchorId(version);
  return (
    `<article class="release" id="${id}"><header><h2><a href="#${id}">${version}</a></h2>` +
    `<time datetime="${date}">${date}</time></header>` +
    `<section class="highlights"><h3 class="label">Highlights</h3><ul>` +
    `<li><p class="title">${title}</p><p>Description</p></li>` +
    `</ul></section></article>`
  );
}

const LEGACY_PAGE =
  "<html><body><main>" +
  legacyArticle("2.0.28", "2026-10-13", "Per-Project Auto-Accept") +
  "</main></body></html>";

interface MemoryStore extends OpenCodeChangelogStore {
  data: Map<string, unknown>;
}

function createStore(): MemoryStore {
  const data = new Map<string, unknown>();
  return {
    get: vi.fn(
      <T>(key: string): T | undefined => data.get(key) as T | undefined,
    ),
    update: vi.fn(async (key: string, value: unknown): Promise<void> => {
      data.set(key, value);
    }),
    data,
  };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

function htmlResponse(body: string, ok = true, status = 200): Response {
  return { ok, status, text: async () => body } as unknown as Response;
}

function routeFetch(
  fetchMock: ReturnType<typeof vi.fn>,
  handlers: {
    feed?: (url: string) => Response;
    page?: (url: string) => Response;
  },
): void {
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).includes("changelog.json")) {
      return handlers.feed ? handlers.feed(String(url)) : jsonResponse(FEED);
    }
    return handlers.page ? handlers.page(String(url)) : htmlResponse(TIMELINE_PAGE);
  });
}

describe("OpenCodeChangelogService", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("changelogAnchorId / changelogPageUrl", () => {
    it("maps a version to its page anchor", () => {
      expect(changelogAnchorId("2.0.28")).toBe("v2-0-28");
      expect(changelogPageUrl("2.0.28")).toBe(
        "https://opencode.ai/changelog#v2-0-28",
      );
      expect(changelogPageUrl()).toBe("https://opencode.ai/changelog");
    });
  });

  describe("sanitizeChangelogHtml", () => {
    it("strips scripts, inline handlers, and javascript: URLs", () => {
      const dirty =
        '<p onclick="evil()">keep</p><script>alert(1)</script>' +
        '<a href="javascript:evil()">link</a>';
      const clean = sanitizeChangelogHtml(dirty);
      expect(clean).toContain("keep");
      expect(clean).not.toContain("script");
      expect(clean).not.toContain("onclick");
      expect(clean).not.toContain("javascript:");
    });
  });

  describe("extractReleaseHtml", () => {
    it("extracts one entry from the current timeline markup", () => {
      const entry = extractReleaseHtml(TIMELINE_PAGE, "2.3.0");
      expect(entry).toBeDefined();
      expect(entry?.date).toBe("2026-11-13");
      expect(entry?.html).toContain("Background Subagents");
      expect(entry?.html).not.toContain("<header>");
      expect(entry?.html).not.toContain("2.3.0");
      expect(entry?.html).not.toContain("Copilot");
    });

    it("still extracts legacy article blocks", () => {
      const entry = extractReleaseHtml(LEGACY_PAGE, "2.0.28");
      expect(entry?.date).toBe("2026-10-13");
      expect(entry?.html).toContain("Per-Project Auto-Accept");
      expect(entry?.html).not.toContain("<header>");
    });

    it("keeps a release block intact when it nests list items", () => {
      const page =
        '<ol><li id="v2.3.0"><span id="v2-3-0" data-slot="anchor"></span>' +
        "<header><time datetime=\"2026-11-13\">Nov 13, 2026</time></header>" +
        "<div><ul><li>first</li><li>second</li></ul></div></li>" +
        '<li id="v2.2.7"><span id="v2-2-7"></span></li></ol>';
      const entry = extractReleaseHtml(page, "2.3.0");
      expect(entry?.html).toContain("<li>first</li><li>second</li>");
      expect(entry?.html).not.toContain("v2.2.7");
    });

    it("returns undefined for a version missing from the page", () => {
      expect(extractReleaseHtml(TIMELINE_PAGE, "2.0.20")).toBeUndefined();
    });

    it("returns undefined when the block is unterminated", () => {
      const broken =
        '<li id="v2.3.0"><span id="v2-3-0" data-slot="anchor"></span><p>no end';
      expect(extractReleaseHtml(broken, "2.3.0")).toBeUndefined();
    });
  });

  describe("releaseNotesFromFeed", () => {
    it("renders features, breaking changes, improvements, and fixes", () => {
      const entry = releaseNotesFromFeed(FEED, "2.3.0");
      expect(entry).toBeDefined();
      expect(entry?.date).toBe("2026-11-13");
      const html = entry?.html ?? "";
      expect(html).toContain('<section class="highlights">');
      expect(html).toContain("<strong>Subagents</strong>");
      expect(html).toContain("<code>session.verbosity</code>");
      expect(html).toContain('<a href="https://opencode.ai/docs">docs</a>');
      expect(html).toContain("<li>first</li><li>second</li>");
      expect(html).toContain("Breaking changes");
      expect(html).toContain("<pre><code>-old");
      expect(html).toContain("<strong>Core:</strong> Faster startup.");
      expect(html).toContain("github.com/anomalyco/opencode/pull/63382");
      expect(html).toContain("github.com/alice");
      expect(html).toContain("Improvements");
      expect(html).toContain("Fixes");
    });

    it("supports legacy section-based releases", () => {
      const entry = releaseNotesFromFeed(FEED, "1.19.5");
      expect(entry?.html).toContain("First legacy item.");
      expect(entry?.html).toContain(">Core<");
    });

    it("returns undefined for a missing version or malformed payload", () => {
      expect(releaseNotesFromFeed(FEED, "2.0.20")).toBeUndefined();
      expect(releaseNotesFromFeed(null, "2.3.0")).toBeUndefined();
      expect(releaseNotesFromFeed({ releases: "nope" }, "2.3.0")).toBeUndefined();
    });

    it("escapes feed markup instead of injecting it", () => {
      const payload = {
        releases: [
          {
            tag: "v2.3.0",
            notes: {
              features: [
                {
                  title: "Unsafe",
                  body: '<script>alert("x")</script>',
                  areas: [],
                  prs: [],
                  credits: [],
                },
              ],
            },
          },
        ],
      };
      const html = releaseNotesFromFeed(payload, "2.3.0")?.html ?? "";
      expect(html).not.toContain("<script>");
      expect(html).toContain("&lt;script&gt;");
    });
  });

  describe("fetchChangelog", () => {
    it("resolves notes from the feed and caches them permanently", async () => {
      routeFetch(fetchMock, {});
      const store = createStore();
      const service = new OpenCodeChangelogService(store, { logger });

      const first = await service.fetchChangelog("2.3.0");

      expect(first.ok).toBe(true);
      if (first.ok) {
        expect(first.date).toBe("2026-11-13");
        expect(first.html).toContain("Background <strong>Subagents</strong>");
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe(FEED_URL);
      expect(store.update).toHaveBeenCalledWith("opencodeChangelog.2.3.0", {
        version: "2.3.0",
        date: "2026-11-13",
        html: expect.any(String),
      });

      // Cache hit: no second fetch.
      const second = await service.fetchChangelog("2.3.0");
      expect(second.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("falls back to the page when the feed lags the release", async () => {
      routeFetch(fetchMock, {
        feed: () =>
          jsonResponse({
            releases: FEED.releases.filter((r) => r.tag !== "v2.3.0"),
          }),
        page: () => htmlResponse(TIMELINE_PAGE),
      });
      const service = new OpenCodeChangelogService(createStore(), { logger });

      const result = await service.fetchChangelog("2.3.0");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.date).toBe("2026-11-13");
        expect(result.html).toContain("Background Subagents");
      }
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
        FEED_URL,
        PAGE_URL,
      ]);
    });

    it("dedupes concurrent requests onto one fetch", async () => {
      routeFetch(fetchMock, {});
      const service = new OpenCodeChangelogService(createStore(), { logger });

      const [a, b] = await Promise.all([
        service.fetchChangelog("2.3.0"),
        service.fetchChangelog("2.3.0"),
      ]);

      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does not cache failures so a later call retries", async () => {
      let feedReady = false;
      routeFetch(fetchMock, {
        feed: () =>
          feedReady
            ? jsonResponse(FEED)
            : jsonResponse({
                releases: FEED.releases.filter((r) => r.tag !== "v2.3.0"),
              }),
        page: () =>
          feedReady
            ? htmlResponse(TIMELINE_PAGE)
            : htmlResponse(TIMELINE_PAGE_WITHOUT_230),
      });
      const store = createStore();
      const service = new OpenCodeChangelogService(store, { logger });

      const missing = await service.fetchChangelog("2.3.0");
      expect(missing.ok).toBe(false);
      expect(store.update).not.toHaveBeenCalled();

      feedReady = true;
      const later = await service.fetchChangelog("2.3.0");
      expect(later.ok).toBe(true);
    });

    it("returns ok:false when both sources fail", async () => {
      routeFetch(fetchMock, {
        feed: () => jsonResponse({}, false, 500),
        page: () => htmlResponse("", false, 502),
      });
      const service = new OpenCodeChangelogService(createStore(), { logger });

      const result = await service.fetchChangelog("2.3.0");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("changelog feed returned 500");
        expect(result.error).toContain("changelog page returned 502");
      }
    });

    it("rejects non-release versions without touching the network", async () => {
      const service = new OpenCodeChangelogService(createStore(), { logger });

      expect((await service.fetchChangelog("local")).ok).toBe(false);
      expect((await service.fetchChangelog("../evil")).ok).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
