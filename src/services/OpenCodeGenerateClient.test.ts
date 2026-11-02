import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutputChannelService } from "./OutputChannelService";
import {
  OpenCodeGenerateClient,
  OpenCodeGenerateError,
} from "./OpenCodeGenerateClient";

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as OutputChannelService;

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

function requestInit(fetchMock: ReturnType<typeof vi.fn>, index: number) {
  return fetchMock.mock.calls[index]?.[1] as RequestInit;
}

describe("OpenCodeGenerateClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const signal = new AbortController().signal;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts to the v2 generate endpoint and reads data.text", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { text: "hello" } }));
    const client = new OpenCodeGenerateClient(
      {
        protocol: "v2",
        baseUrl: "http://127.0.0.1:49374/",
        password: "secret",
        directory: "/workspace",
      },
      logger,
    );

    await expect(client.generate("translate this", signal)).resolves.toBe(
      "hello",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:49374/api/experimental/generate/text",
    );
    const init = requestInit(fetchMock, 0);
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ prompt: "translate this" }));
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      "x-opencode-directory": "/workspace",
      Authorization: `Basic ${Buffer.from("opencode:secret", "utf8").toString("base64")}`,
    });
  });

  it("throws on a non-2xx v2 response", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false, 500));
    const client = new OpenCodeGenerateClient(
      { protocol: "v2", baseUrl: "http://127.0.0.1:49374" },
      logger,
    );

    await expect(client.generate("prompt", signal)).rejects.toThrow("500");
  });

  it("throws when the v2 payload has no text", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: {} }));
    const client = new OpenCodeGenerateClient(
      { protocol: "v2", baseUrl: "http://127.0.0.1:49374" },
      logger,
    );

    await expect(client.generate("prompt", signal)).rejects.toThrow(
      "data.text",
    );
  });

  it("creates a v1 session, sends the message, joins text parts, and deletes the session", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: "session-1" }))
      .mockResolvedValueOnce(
        jsonResponse({
          parts: [
            { type: "text", text: "first " },
            { type: "tool", text: "ignored" },
            { type: "text", text: "second" },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({}));

    const client = new OpenCodeGenerateClient(
      {
        protocol: "v1",
        baseUrl: "http://localhost:41000",
        directory: "/workspace",
      },
      logger,
    );

    await expect(client.generate("translate", signal)).resolves.toBe(
      "first second",
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://localhost:41000/session",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "http://localhost:41000/session/session-1/message",
    );
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "http://localhost:41000/session/session-1",
    );
    expect(requestInit(fetchMock, 1).headers).toMatchObject({
      "x-opencode-directory": "/workspace",
    });
    expect(requestInit(fetchMock, 1).body).toBe(
      JSON.stringify({
        parts: [{ type: "text", text: "translate" }],
        tools: {},
      }),
    );
    expect(requestInit(fetchMock, 2).method).toBe("DELETE");
  });

  it("does not wait for v1 session cleanup before returning", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: "session-3" }))
      .mockResolvedValueOnce(
        jsonResponse({ parts: [{ type: "text", text: "done" }] }),
      )
      .mockImplementationOnce(() => new Promise(() => {}));

    const client = new OpenCodeGenerateClient(
      { protocol: "v1", baseUrl: "http://localhost:41000" },
      logger,
    );

    await expect(client.generate("prompt", signal)).resolves.toBe("done");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(requestInit(fetchMock, 2).method).toBe("DELETE");
  });

  it("throws when v1 session creation returns no id", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    const client = new OpenCodeGenerateClient(
      { protocol: "v1", baseUrl: "http://localhost:41000" },
      logger,
    );

    await expect(client.generate("prompt", signal)).rejects.toThrow("id");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws on a non-2xx v1 message response and still cleans up", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: "session-2" }))
      .mockResolvedValueOnce(jsonResponse({}, false, 503))
      .mockResolvedValueOnce(jsonResponse({}));

    const client = new OpenCodeGenerateClient(
      { protocol: "v1", baseUrl: "http://localhost:41000" },
      logger,
    );

    await expect(client.generate("prompt", signal)).rejects.toThrow("503");
    expect(requestInit(fetchMock, 2).method).toBe("DELETE");
  });

  it("throws when the model returns only whitespace", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { text: "   " } }));
    const client = new OpenCodeGenerateClient(
      { protocol: "v2", baseUrl: "http://127.0.0.1:49374" },
      logger,
    );

    await expect(client.generate("prompt", signal)).rejects.toThrow("empty");
  });

  it("classifies a 429 response as rate-limit", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { reason: "rate_limit", message: "Free usage limit reached" },
        false,
        429,
      ),
    );
    const client = new OpenCodeGenerateClient(
      { protocol: "v2", baseUrl: "http://127.0.0.1:49374" },
      logger,
    );

    await expect(client.generate("prompt", signal)).rejects.toMatchObject({
      failure: "rate-limit",
      status: 429,
    });
  });

  it("classifies a 503 response as not-ready", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          _tag: "ServiceUnavailableError",
          message: "Location plugins did not finish activating",
        },
        false,
        503,
      ),
    );
    const client = new OpenCodeGenerateClient(
      { protocol: "v2", baseUrl: "http://127.0.0.1:49374" },
      logger,
    );

    await expect(client.generate("prompt", signal)).rejects.toMatchObject({
      failure: "not-ready",
      status: 503,
    });
  });

  it("reads the provider status out of a 502 gateway body", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          _tag: "ProviderRequestError",
          providerID: "opencode",
          reason: "rate_limit",
          message: "Free usage limit reached",
          status: 429,
        },
        false,
        502,
      ),
    );
    const client = new OpenCodeGenerateClient(
      { protocol: "v2", baseUrl: "http://127.0.0.1:49374" },
      logger,
    );

    await expect(client.generate("prompt", signal)).rejects.toMatchObject({
      failure: "rate-limit",
      status: 429,
      providerID: "opencode",
    });
  });

  it("classifies a network failure as unreachable", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const client = new OpenCodeGenerateClient(
      { protocol: "v2", baseUrl: "http://127.0.0.1:49374" },
      logger,
    );

    const error = (await client.generate("prompt", signal).catch((e) => e)) as
      | OpenCodeGenerateError
      | undefined;
    expect(error).toBeInstanceOf(OpenCodeGenerateError);
    expect(error?.failure).toBe("unreachable");
  });

  it("reads the default model from the v2 endpoint", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { providerID: "opencode", id: "flint-40b-free" } }),
    );
    const client = new OpenCodeGenerateClient(
      {
        protocol: "v2",
        baseUrl: "http://127.0.0.1:49374",
        directory: "/workspace",
      },
      logger,
    );

    await expect(client.getDefaultModel()).resolves.toBe(
      "opencode/flint-40b-free",
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:49374/api/model/default",
    );
    expect(requestInit(fetchMock, 0).headers).toMatchObject({
      "x-opencode-directory": "/workspace",
    });
  });

  it("does not query the default model for v1", async () => {
    const client = new OpenCodeGenerateClient(
      { protocol: "v1", baseUrl: "http://localhost:41000" },
      logger,
    );

    await expect(client.getDefaultModel()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
