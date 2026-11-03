import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveService = vi.fn();
const statePaths = vi.fn<() => string[]>(() => []);
const authHeader = vi.fn((password: string) => `Basic ${password}`);

vi.mock("./OpenCodeCliCompat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./OpenCodeCliCompat")>();
  return {
    ...actual,
    resolveOpenCodeV2Service: (...args: unknown[]) => resolveService(...args),
    v2ServiceStatePaths: () => statePaths(),
    buildOpenCodeV2AuthHeader: (password: string) => authHeader(password),
  };
});

import { OpenCodeReadiness } from "./OpenCodeReadiness";

const fetchMock = vi.fn();

function respond(status: number) {
  return { status, ok: status >= 200 && status < 300 };
}

beforeEach(() => {
  resolveService.mockReset();
  statePaths.mockReset();
  statePaths.mockReturnValue([]);
  authHeader.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenCodeReadiness", () => {
  it("reports down when no service is registered", async () => {
    resolveService.mockResolvedValue(undefined);
    const readiness = new OpenCodeReadiness({ command: () => "opencode" });

    await expect(readiness.probe()).resolves.toBe("down");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports ready on 200 and sends the service password", async () => {
    resolveService.mockResolvedValue({
      url: "http://127.0.0.1:28894",
      port: 28894,
      password: "secret",
    });
    fetchMock.mockResolvedValue(respond(200));
    const readiness = new OpenCodeReadiness({ command: () => "opencode" });

    await expect(readiness.probe()).resolves.toBe("ready");
    expect(authHeader).toHaveBeenCalledWith("secret");
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe("http://127.0.0.1:28894/api/info");
    expect(init.headers.Authorization).toBe("Basic secret");
  });

  it("separates a booting service from a failed one", async () => {
    resolveService.mockResolvedValue({ url: "http://127.0.0.1:28894", port: 28894 });
    const readiness = new OpenCodeReadiness({ command: () => "opencode" });

    fetchMock.mockResolvedValueOnce(respond(503));
    await expect(readiness.probe({ force: true })).resolves.toBe("starting");

    fetchMock.mockResolvedValueOnce(respond(500));
    await expect(readiness.probe({ force: true })).resolves.toBe("failed");

    fetchMock.mockResolvedValueOnce(respond(403));
    await expect(readiness.probe({ force: true })).resolves.toBe("failed");
  });

  it("treats a refused connection as down", async () => {
    resolveService.mockResolvedValue({ url: "http://127.0.0.1:28894", port: 28894 });
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const readiness = new OpenCodeReadiness({ command: () => "opencode" });

    await expect(readiness.probe()).resolves.toBe("down");
  });

  it("caches a probe result until it expires", async () => {
    resolveService.mockResolvedValue({ url: "http://127.0.0.1:28894", port: 28894 });
    fetchMock.mockResolvedValue(respond(200));
    let now = 1_000;
    const readiness = new OpenCodeReadiness({
      command: () => "opencode",
      cacheTtlMs: 500,
      now: () => now,
    });

    await expect(readiness.probe()).resolves.toBe("ready");
    await expect(readiness.probe()).resolves.toBe("ready");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now += 1_000;
    await expect(readiness.probe()).resolves.toBe("ready");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("waits through a starting service until it is ready", async () => {
    resolveService.mockResolvedValue({ url: "http://127.0.0.1:28894", port: 28894 });
    fetchMock
      .mockResolvedValueOnce(respond(503))
      .mockResolvedValueOnce(respond(503))
      .mockResolvedValue(respond(200));
    const readiness = new OpenCodeReadiness({ command: () => "opencode" });

    await expect(
      readiness.waitUntilReady({ timeoutMs: 2_000, pollMs: 10 }),
    ).resolves.toBe("ready");
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("returns immediately when nothing is starting", async () => {
    resolveService.mockResolvedValue(undefined);
    const readiness = new OpenCodeReadiness({ command: () => "opencode" });
    const startedAt = Date.now();

    await expect(
      readiness.waitUntilReady({
        settleMs: 10,
        timeoutMs: 5_000,
        pollMs: 10,
        stopWhenIdle: true,
        isStartInFlight: () => false,
      }),
    ).resolves.toBe("down");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("keeps waiting while a start is in flight", async () => {
    resolveService.mockResolvedValue({ url: "http://127.0.0.1:28894", port: 28894 });
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const readiness = new OpenCodeReadiness({ command: () => "opencode" });

    await expect(
      readiness.waitUntilReady({
        timeoutMs: 120,
        pollMs: 10,
        stopWhenIdle: true,
        isStartInFlight: () => true,
      }),
    ).resolves.toBe("down");
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it("emits only on state changes", async () => {
    resolveService.mockResolvedValue({ url: "http://127.0.0.1:28894", port: 28894 });
    fetchMock.mockResolvedValue(respond(200));
    const readiness = new OpenCodeReadiness({ command: () => "opencode" });
    const states: string[] = [];
    readiness.onDidChange((state) => states.push(state));

    await readiness.probe({ force: true });
    await readiness.probe({ force: true });

    expect(states).toEqual(["ready"]);
  });
});
