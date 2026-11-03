import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ILogger } from "./ILogger";
import type { OpenCodeReadiness, OpenCodeServiceState } from "./OpenCodeReadiness";
import { StartupCoordinator, type StartupLeaseData } from "./StartupCoordinator";

let dir: string;

const logger: ILogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function fakeReadiness(initial: OpenCodeServiceState = "down") {
  const readiness = {
    state: initial,
    sleepMs: 5,
    async probe() {
      return readiness.state;
    },
    async waitUntilReady() {
      await new Promise((resolve) => setTimeout(resolve, readiness.sleepMs));
      return readiness.state;
    },
  };
  return readiness;
}

function coordinator(
  readiness: ReturnType<typeof fakeReadiness>,
  overrides: Partial<ConstructorParameters<typeof StartupCoordinator>[0]> = {},
) {
  return new StartupCoordinator({
    storageDir: path.join(dir, "startup"),
    readiness: readiness as unknown as OpenCodeReadiness,
    logger,
    leaseMs: 1_000,
    heartbeatMs: 200,
    acquireRetryMs: 10,
    readyTimeoutMs: 400,
    pollMs: 20,
    now: () => Date.now(),
    ...overrides,
  });
}

function leasePath(): string {
  return path.join(dir, "startup", "warmup.lock");
}

function writeLease(data: Partial<StartupLeaseData>): void {
  fs.mkdirSync(path.dirname(leasePath()), { recursive: true });
  fs.writeFileSync(
    leasePath(),
    JSON.stringify({
      lockId: "another-window",
      pid: 1,
      hostname: "elsewhere",
      acquiredAt: Date.now(),
      renewedAt: Date.now(),
      ...data,
    }),
    "utf8",
  );
}

/** Writes arbitrary lease contents and backdates the file when asked. */
function writeRawLease(content: string, ageMs = 0): void {
  fs.mkdirSync(path.dirname(leasePath()), { recursive: true });
  fs.writeFileSync(leasePath(), content, "utf8");
  if (ageMs > 0) {
    const stamp = new Date(Date.now() - ageMs);
    fs.utimesSync(leasePath(), stamp, stamp);
  }
}

function readLeaseFile(): StartupLeaseData {
  return JSON.parse(fs.readFileSync(leasePath(), "utf8")) as StartupLeaseData;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-startup-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("StartupCoordinator", () => {
  it("skips the gate when the service already answers", async () => {
    const gate = coordinator(fakeReadiness("ready"));

    await expect(gate.beforeStart()).resolves.toBe("ready");
    expect(fs.existsSync(leasePath())).toBe(false);
  });

  it("claims ownership without waiting for the service", async () => {
    const gate = coordinator(fakeReadiness("down"));
    const startedAt = Date.now();

    await expect(gate.beforeStart()).resolves.toBe("owner");
    // The caller starts its TUI immediately; only the lease is held.
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(fs.existsSync(leasePath())).toBe(true);
    expect(readLeaseFile().pid).toBe(process.pid);
  });

  it("releases the lease once its own service answers", async () => {
    const readiness = fakeReadiness("down");
    const gate = coordinator(readiness);

    await expect(gate.beforeStart()).resolves.toBe("owner");
    expect(gate.isWarmupInFlight()).toBe(true);

    readiness.state = "ready";
    await vi.waitFor(() => {
      if (fs.existsSync(leasePath())) {
        throw new Error("waiting for the lease release");
      }
    }, 2_000);
    expect(gate.isWarmupInFlight()).toBe(false);
  });

  it("releases the lease when the service never answers", async () => {
    const gate = coordinator(fakeReadiness("down"), { readyTimeoutMs: 80 });

    await expect(gate.beforeStart()).resolves.toBe("owner");
    await vi.waitFor(() => {
      if (fs.existsSync(leasePath())) {
        throw new Error("waiting for the lease release");
      }
    }, 2_000);
  });

  it("waits for the window that owns the lease", async () => {
    writeLease({ renewedAt: Date.now() });
    const readiness = fakeReadiness("down");
    const gate = coordinator(readiness);

    setTimeout(() => {
      readiness.state = "ready";
    }, 60);

    await expect(gate.beforeStart()).resolves.toBe("ready");
    // The other window keeps the lease; this one never took it over.
    expect(readLeaseFile().lockId).toBe("another-window");
  });

  it("takes over a stale lease", async () => {
    writeLease({ renewedAt: Date.now() - 60_000 });
    const gate = coordinator(fakeReadiness("down"));

    await expect(gate.beforeStart()).resolves.toBe("owner");
    expect(readLeaseFile().lockId).not.toBe("another-window");
  });

  it("treats a freshly created empty lease as held", async () => {
    // `writeFile` with `wx` creates the file before writing its content, so a
    // competing window can see zero bytes for a moment.
    writeRawLease("");
    const readiness = fakeReadiness("down");
    const gate = coordinator(readiness);

    setTimeout(() => {
      readiness.state = "ready";
    }, 60);

    await expect(gate.beforeStart()).resolves.toBe("ready");
    expect(fs.existsSync(leasePath())).toBe(true);
  });

  it("takes over an empty lease that has aged", async () => {
    writeRawLease("", 60_000);
    const gate = coordinator(fakeReadiness("down"));

    await expect(gate.beforeStart()).resolves.toBe("owner");
    expect(readLeaseFile().pid).toBe(process.pid);
  });

  it("does not spin when a stale lease cannot be deleted", async () => {
    writeRawLease("not json", 60_000);
    const remove = vi
      .spyOn(fs.promises, "rm")
      .mockRejectedValue(new Error("EPERM: file is locked"));
    const gate = coordinator(fakeReadiness("down"), {
      acquireTimeoutMs: 0,
      readyTimeoutMs: 120,
      pollMs: 20,
    });

    // Must terminate: the delete failure is swallowed, so only the deadline
    // in `acquire()` keeps this from looping forever.
    await expect(gate.beforeStart()).resolves.toBe("timeout");
    expect(remove).toHaveBeenCalled();
  });

  it("falls back to a direct start when the service reports a failure", async () => {
    writeLease({ renewedAt: Date.now() });
    const gate = coordinator(fakeReadiness("failed"), { readyTimeoutMs: 5_000 });

    await expect(gate.beforeStart()).resolves.toBe("timeout");
  });

  it("skips commands that bypass the shared service", async () => {
    const gate = coordinator(fakeReadiness("down"), {
      launchCommand: () => "opencode --standalone",
    });

    await expect(gate.beforeStart()).resolves.toBe("skipped");
    expect(fs.existsSync(leasePath())).toBe(false);
  });

  it("skips the gate when coordination is disabled", async () => {
    const gate = coordinator(fakeReadiness("down"), { isEnabled: () => false });

    await expect(gate.beforeStart()).resolves.toBe("skipped");
    expect(fs.existsSync(leasePath())).toBe(false);
  });

  it("reports the starting phase for the window that starts the service", async () => {
    const readiness = fakeReadiness("down");
    const phases: string[] = [];
    const gate = coordinator(readiness, {
      onPhase: (phase) => phases.push(phase),
    });

    await gate.beforeStart();
    expect(phases[0]).toBe("starting");

    readiness.state = "ready";
    await vi.waitFor(() => {
      if (!phases.includes("ready")) {
        throw new Error("waiting for the ready phase");
      }
    }, 2_000);
  });

  it("reports the starting phase while another window starts the service", async () => {
    writeLease({ renewedAt: Date.now() });
    const readiness = fakeReadiness("down");
    const phases: string[] = [];
    const gate = coordinator(readiness, {
      onPhase: (phase) => phases.push(phase),
    });

    setTimeout(() => {
      readiness.state = "ready";
    }, 60);

    await expect(gate.beforeStart()).resolves.toBe("ready");
    expect(phases).toEqual(["starting", "ready"]);
  });

  it("treats a fresh foreign lease as a start in flight", () => {
    writeLease({ renewedAt: Date.now() });
    const gate = coordinator(fakeReadiness("down"));

    expect(gate.isWarmupInFlight()).toBe(true);
  });

  it("ignores a stale foreign lease", () => {
    writeLease({ renewedAt: Date.now() - 60_000 });
    const gate = coordinator(fakeReadiness("down"));

    expect(gate.isWarmupInFlight()).toBe(false);
  });

  it("releases the lease on dispose", async () => {
    const gate = coordinator(fakeReadiness("down"), { readyTimeoutMs: 5_000 });

    await expect(gate.beforeStart()).resolves.toBe("owner");
    expect(fs.existsSync(leasePath())).toBe(true);

    gate.dispose();
    await vi.waitFor(() => {
      if (fs.existsSync(leasePath())) {
        throw new Error("waiting for the lease release");
      }
    }, 2_000);
  });
});
