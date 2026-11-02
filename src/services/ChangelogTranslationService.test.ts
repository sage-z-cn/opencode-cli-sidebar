import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChangelogTranslationService,
  type ChangelogTranslationStore,
} from "./ChangelogTranslationService";
import type { OutputChannelService } from "./OutputChannelService";
import type { OpenCodeGenerateConnection } from "./OpenCodeGenerateClient";
import type { ChangelogTextBlock } from "../types";

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as OutputChannelService;

const CONNECTION: OpenCodeGenerateConnection = {
  protocol: "v2",
  baseUrl: "http://127.0.0.1:49374",
  password: "secret",
};

interface MemoryStore extends ChangelogTranslationStore {
  data: Map<string, unknown>;
}

function createStore(initial?: Record<string, unknown>): MemoryStore {
  const data = new Map<string, unknown>(Object.entries(initial ?? {}));
  return {
    get: <T>(key: string): T | undefined => data.get(key) as T | undefined,
    update: vi.fn(async (key: string, value: unknown): Promise<void> => {
      data.set(key, value);
    }),
    data,
  };
}

function response(text: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: { text } }),
  } as unknown as Response;
}

/** Extracts the input ids from the JSON block appended to the prompt. */
function promptIds(init: RequestInit): string[] {
  const body = JSON.parse(String(init.body)) as { prompt: string };
  return [...body.prompt.matchAll(/"id": "([^"]+)"/g)].map(
    (match) => match[1],
  );
}

const signal = new AbortController().signal;

describe("ChangelogTranslationService", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a cached translation without calling the model", async () => {
    const store = createStore({
      "opencodeChangelogTranslation.zh-cn.2.0.1.abc123": { a: "缓存" },
    });
    const service = new ChangelogTranslationService(
      store,
      () => undefined,
      logger,
    );

    const result = await service.translate(
      {
        version: "2.0.1",
        htmlHash: "abc123",
        targetLanguage: "zh-cn",
        blocks: [{ id: "a", text: "Cached" }],
      },
      signal,
    );

    expect(result).toEqual({ a: "缓存" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("splits oversized input into batches and merges the results", async () => {
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const translations = Object.fromEntries(
        promptIds(init).map((id) => [id, `translated ${id}`]),
      );
      return response(JSON.stringify(translations));
    });
    const store = createStore();
    const service = new ChangelogTranslationService(
      store,
      () => CONNECTION,
      logger,
    );
    const blocks: ChangelogTextBlock[] = [
      { id: "a", text: "x".repeat(4000) },
      { id: "b", text: "y".repeat(4000) },
      { id: "c", text: "z" },
    ];

    const result = await service.translate(
      {
        version: "2.0.1",
        htmlHash: "hash",
        targetLanguage: "zh-cn",
        blocks,
      },
      signal,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBatch = promptIds(fetchMock.mock.calls[0]?.[1] as RequestInit);
    const secondBatch = promptIds(fetchMock.mock.calls[1]?.[1] as RequestInit);
    expect(firstBatch).toEqual(["a"]);
    expect(secondBatch).toEqual(["b", "c"]);
    expect(result).toEqual({
      a: "translated a",
      b: "translated b",
      c: "translated c",
    });
    expect(store.update).toHaveBeenCalledWith(
      "opencodeChangelogTranslation.zh-cn.2.0.1.hash",
      result,
    );
  });

  it("retries once when the response is not JSON", async () => {
    fetchMock
      .mockResolvedValueOnce(response("sorry, I cannot do that"))
      .mockResolvedValueOnce(response(JSON.stringify({ a: "A" })));
    const service = new ChangelogTranslationService(
      createStore(),
      () => CONNECTION,
      logger,
    );

    await expect(
      service.translate(
        {
          version: "2.0.1",
          htmlHash: "hash",
          targetLanguage: "zh-cn",
          blocks: [{ id: "a", text: "Alpha" }],
        },
        signal,
      ),
    ).resolves.toEqual({ a: "A" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("strips markdown fences around the JSON object", async () => {
    fetchMock.mockResolvedValueOnce(
      response('```json\n{"a": "甲"}\n```'),
    );
    const service = new ChangelogTranslationService(
      createStore(),
      () => CONNECTION,
      logger,
    );

    await expect(
      service.translate(
        {
          version: "2.0.1",
          htmlHash: "hash",
          targetLanguage: "zh-cn",
          blocks: [{ id: "a", text: "Alpha" }],
        },
        signal,
      ),
    ).resolves.toEqual({ a: "甲" });
  });

  it("retries a missing id once, then falls back to the source text", async () => {
    fetchMock.mockImplementation(async () => response(JSON.stringify({ a: "A" })));
    const service = new ChangelogTranslationService(
      createStore(),
      () => CONNECTION,
      logger,
    );

    const result = await service.translate(
      {
        version: "2.0.1",
        htmlHash: "hash",
        targetLanguage: "zh-cn",
        blocks: [
          { id: "a", text: "Alpha" },
          { id: "b", text: "Beta" },
        ],
      },
      signal,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ a: "A", b: "Beta" });
  });

  it("throws without caching when no OpenCode connection is available", async () => {
    const store = createStore();
    const service = new ChangelogTranslationService(store, () => undefined, logger);

    await expect(
      service.translate(
        {
          version: "2.0.1",
          htmlHash: "hash",
          targetLanguage: "zh-cn",
          blocks: [{ id: "a", text: "Alpha" }],
        },
        signal,
      ),
    ).rejects.toThrow("connection");
    expect(store.update).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not cache a failed translation", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const store = createStore();
    const service = new ChangelogTranslationService(store, () => CONNECTION, logger);

    await expect(
      service.translate(
        {
          version: "2.0.1",
          htmlHash: "hash",
          targetLanguage: "zh-cn",
          blocks: [{ id: "a", text: "Alpha" }],
        },
        signal,
      ),
    ).rejects.toThrow("500");
    expect(store.update).not.toHaveBeenCalled();
  });

  it("returns the translation even when the cache write fails", async () => {
    fetchMock.mockResolvedValueOnce(response(JSON.stringify({ a: "甲" })));
    const store = createStore();
    store.update = vi.fn(async () => {
      throw new Error("storage full");
    });
    const service = new ChangelogTranslationService(
      store,
      () => CONNECTION,
      logger,
    );

    await expect(
      service.translate(
        {
          version: "2.0.1",
          htmlHash: "hash",
          targetLanguage: "zh-cn",
          blocks: [{ id: "a", text: "Alpha" }],
        },
        signal,
      ),
    ).resolves.toEqual({ a: "甲" });
  });

  it("reports no-connection when the session is not available", async () => {
    const service = new ChangelogTranslationService(
      createStore(),
      () => undefined,
      logger,
    );

    const error = (await service
      .translate(
        {
          version: "2.0.1",
          htmlHash: "hash",
          targetLanguage: "zh-cn",
          blocks: [{ id: "a", text: "Alpha" }],
        },
        signal,
      )
      .catch((e) => e)) as { failure?: string };

    expect(error.failure).toBe("no-connection");
  });

  it("maps a 429 response to rate-limit and reports the current model", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: async () => ({
          reason: "rate_limit",
          message: "quota",
          providerID: "opencode",
          status: 429,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: { providerID: "opencode", id: "flint-40b-free" },
        }),
      });
    const service = new ChangelogTranslationService(
      createStore(),
      () => CONNECTION,
      logger,
    );

    const error = (await service
      .translate(
        {
          version: "2.0.1",
          htmlHash: "hash",
          targetLanguage: "zh-cn",
          blocks: [{ id: "a", text: "Alpha" }],
        },
        signal,
      )
      .catch((e) => e)) as {
      failure?: string;
      status?: number;
      providerID?: string;
      model?: string;
    };

    expect(error.failure).toBe("rate-limit");
    expect(error.status).toBe(429);
    expect(error.providerID).toBe("opencode");
    expect(error.model).toBe("opencode/flint-40b-free");
  });

  it("maps an unparseable model reply to invalid-response", async () => {
    fetchMock.mockImplementation(async () =>
      response("I cannot translate that."),
    );
    const service = new ChangelogTranslationService(
      createStore(),
      () => CONNECTION,
      logger,
    );

    const error = (await service
      .translate(
        {
          version: "2.0.1",
          htmlHash: "hash",
          targetLanguage: "zh-cn",
          blocks: [{ id: "a", text: "Alpha" }],
        },
        signal,
      )
      .catch((e) => e)) as { failure?: string };

    expect(error.failure).toBe("invalid-response");
  });
});
