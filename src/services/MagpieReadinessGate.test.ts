import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ILogger } from "./ILogger";
import {
  buildMagpieProbeUrl,
  MAGPIE_DEFAULTS,
  MagpieReadinessGate,
  type MagpieGateConfig,
  type MagpieWaitOutcome,
} from "./MagpieReadinessGate";

const logger: ILogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function config(overrides: Partial<MagpieGateConfig> = {}): MagpieGateConfig {
  return {
    enabled: true,
    baseUrl: MAGPIE_DEFAULTS.baseUrl,
    probePath: MAGPIE_DEFAULTS.probePath,
    timeoutMs: 3000,
    pollIntervalMs: 1000,
    ...overrides,
  };
}

function httpResponse(status = 200): Response {
  return new Response(null, { status });
}

function gateWith(
  fetchImpl: typeof fetch,
  overrides: Partial<MagpieGateConfig> = {},
  onActiveChange?: (active: boolean) => void,
): MagpieReadinessGate {
  return new MagpieReadinessGate({
    logger,
    readConfig: () => config(overrides),
    fetchImpl,
    onActiveChange,
  });
}

describe("buildMagpieProbeUrl", () => {
  it("joins the base path and the probe path", () => {
    expect(buildMagpieProbeUrl("http://127.0.0.1:3425/v1", "/models")).toBe(
      "http://127.0.0.1:3425/v1/models",
    );
  });

  it("normalizes duplicate separators", () => {
    expect(buildMagpieProbeUrl("http://127.0.0.1:3425/v1/", "models")).toBe(
      "http://127.0.0.1:3425/v1/models",
    );
  });

  it("keeps the base URL when the probe path is empty", () => {
    expect(buildMagpieProbeUrl("http://127.0.0.1:3425/v1", "  ")).toBe(
      "http://127.0.0.1:3425/v1",
    );
  });

  it("rejects empty, malformed and non-http addresses", () => {
    expect(buildMagpieProbeUrl("", "/models")).toBeUndefined();
    expect(buildMagpieProbeUrl("not a url", "/models")).toBeUndefined();
    expect(buildMagpieProbeUrl("file:///tmp/magpie", "/models")).toBeUndefined();
  });
});

describe("MagpieReadinessGate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("returns immediately when the feature is off", async () => {
    const fetchImpl = vi.fn();
    const gate = gateWith(fetchImpl as unknown as typeof fetch, {
      enabled: false,
    });

    await expect(gate.waitForReady()).resolves.toBe("disabled");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns ready on the first HTTP response and toggles the active state", async () => {
    const active: boolean[] = [];
    const fetchImpl = vi.fn(async () => httpResponse(200));
    const gate = gateWith(
      fetchImpl as unknown as typeof fetch,
      {},
      (value) => active.push(value),
    );

    await expect(gate.waitForReady()).resolves.toBe("ready");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(active).toEqual([true, false]);
  });

  it("treats an unauthorized response as proof the service is up", async () => {
    const fetchImpl = vi.fn(async () => httpResponse(401));
    const gate = gateWith(fetchImpl as unknown as typeof fetch);

    await expect(gate.waitForReady()).resolves.toBe("ready");
  });

  it("polls until the service answers", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(httpResponse(200));
    const gate = gateWith(fetchImpl as unknown as typeof fetch);

    const wait = gate.waitForReady();
    await vi.advanceTimersByTimeAsync(2500);

    await expect(wait).resolves.toBe("ready");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("settles on timeout when the service never answers", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const gate = gateWith(fetchImpl as unknown as typeof fetch, {
      timeoutMs: 2500,
    });

    const wait = gate.waitForReady();
    await vi.advanceTimersByTimeAsync(4000);

    await expect(wait).resolves.toBe<MagpieWaitOutcome>("timeout");
  });

  it("cancels an in-flight wait", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const gate = gateWith(fetchImpl as unknown as typeof fetch);
    const active: boolean[] = [];
    const gateWithCallback = new MagpieReadinessGate({
      logger,
      readConfig: () => config(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onActiveChange: (value) => active.push(value),
    });

    const wait = gateWithCallback.waitForReady();
    await vi.advanceTimersByTimeAsync(100);
    expect(gateWithCallback.isWaiting()).toBe(true);
    expect(gateWithCallback.cancel()).toBe(true);

    await expect(wait).resolves.toBe("cancelled");
    expect(gateWithCallback.isWaiting()).toBe(false);
    expect(active).toEqual([true, false]);
    expect(gate.cancel()).toBe(false);
  });

  it("reports that nothing was cancelled when idle", () => {
    const gate = gateWith(vi.fn() as unknown as typeof fetch);
    expect(gate.cancel()).toBe(false);
  });

  it("reuses one in-flight wait for concurrent callers", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const gate = gateWith(fetchImpl as unknown as typeof fetch, {
      timeoutMs: 1500,
    });

    const first = gate.waitForReady();
    const second = gate.waitForReady();
    expect(second).toBe(first);

    await vi.advanceTimersByTimeAsync(2000);
    await expect(first).resolves.toBe("timeout");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("stops waiting when disposed", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const gate = gateWith(fetchImpl as unknown as typeof fetch);

    const wait = gate.waitForReady();
    await vi.advanceTimersByTimeAsync(100);
    gate.dispose();

    await expect(wait).resolves.toBe("cancelled");
  });
});
