import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreStartSyncProgress } from "../../types";
import type { ILogger } from "../ILogger";
import type { SyncPassResult } from "./ConfigSyncService";
import {
  isStampFresh,
  parsePreStartStamp,
  PRE_START_BUDGET_MS,
  PreStartSyncGate,
  preStartConnectionKey,
  preStartScopeFor,
  type PreStartSyncRunner,
  type PreStartSyncStamp,
} from "./PreStartSyncGate";
import { syncStorageDir } from "./SyncManifest";

const vscode = await vi.importActual<typeof import("../../test/mocks/vscode")>(
  "../../test/mocks/vscode",
);

let storageDir: string;
let settings: Record<string, unknown>;

function makeLogger(): ILogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as ILogger;
}

/** Runner whose pass settles on demand, so tests own the timing. */
class ScriptedRunner implements PreStartSyncRunner {
  public result: SyncPassResult = "done";
  public blocked = false;
  /** When true the pass stays in flight until `release()` is called. */
  public hold = false;
  public readonly calls: Array<{ scopePaths: readonly string[] }> = [];
  public aborted = false;
  public reconcile: (() => void) | undefined;
  private releaseResolve: (() => void) | undefined;

  public isAutoPassBlocked(): boolean {
    return this.blocked;
  }

  public reconcileAfterLaunch(): void {
    this.reconcile?.();
  }

  /** Let a held pass settle. */
  public release(): void {
    this.releaseResolve?.();
    this.releaseResolve = undefined;
  }

  public async runScopedPass(options: {
    scopePaths: readonly string[];
    signal: AbortSignal;
    onProgress?: (progress: PreStartSyncProgress) => void;
  }): Promise<SyncPassResult> {
    this.calls.push({ scopePaths: options.scopePaths });
    options.onProgress?.({
      phase: "transfer",
      current: 1,
      total: 2,
      path: "cli.json",
    });
    options.signal.addEventListener("abort", () => {
      this.aborted = true;
    });
    if (this.hold) {
      await new Promise<void>((resolve) => {
        this.releaseResolve = resolve;
      });
    }
    return this.result;
  }
}

/** Poll until `predicate` holds; the gate's entry path awaits file IO. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function makeGate(
  runner: PreStartSyncRunner | undefined,
  overrides: Partial<Parameters<typeof PreStartSyncGate>[0]> = {},
): {
  gate: PreStartSyncGate;
  progress: Array<PreStartSyncProgress | undefined>;
  active: boolean[];
} {
  const progress: Array<PreStartSyncProgress | undefined> = [];
  const active: boolean[] = [];
  const gate = new PreStartSyncGate({
    resolveRunner: () => runner,
    logger: makeLogger(),
    globalStoragePath: storageDir,
    onProgress: (entry) => progress.push(entry),
    onActiveChange: (value) => active.push(value),
    ...overrides,
  });
  return { gate, progress, active };
}

function stampPath(): string {
  return path.join(syncStorageDir(storageDir), "prestart.json");
}

function writeStamp(stamp: Partial<PreStartSyncStamp>): void {
  fs.mkdirSync(path.dirname(stampPath()), { recursive: true });
  fs.writeFileSync(
    stampPath(),
    JSON.stringify({
      completedAt: Date.now(),
      writeId: "seed",
      result: "ok",
      connectionKey: preStartConnectionKey("https://dav.test", "/base/", "user"),
      paths: ["cli.json"],
      ...stamp,
    }),
    "utf8",
  );
}

function readStamp(): PreStartSyncStamp {
  return JSON.parse(fs.readFileSync(stampPath(), "utf8")) as PreStartSyncStamp;
}

beforeEach(() => {
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-prestart-"));
  settings = {
    "sync.enabled": true,
    "sync.url": "https://dav.test",
    "sync.username": "user",
    "sync.basePath": "/base/",
    "sync.autoSyncEnabled": true,
    "sync.preStartSync": true,
    "sync.preStartSyncCooldownMinutes": 4,
  };
  vi.mocked(vscode.workspace.getConfiguration).mockImplementation(((
    _section?: string,
  ) => ({
    get: (key: string, defaultValue?: unknown) =>
      key in settings ? settings[key] : defaultValue,
  })) as never);
});

afterEach(() => {
  fs.rmSync(storageDir, { recursive: true, force: true });
});

describe("preStartScopeFor", () => {
  it("covers every pre-start file when no service is ready", () => {
    expect(preStartScopeFor({ v2ServiceReady: false })).toEqual([
      "opencode.json",
      "opencode.jsonc",
      "cli.json",
      "oh-my-opencode-slim.json",
      "oh-my-opencode-slim.jsonc",
    ]);
  });

  it("keeps only cli.json when a ready service owns the rest", () => {
    // The service watches and hot reloads its own files; cli.json is read
    // per TUI process and has no watcher.
    expect(preStartScopeFor({ v2ServiceReady: true })).toEqual(["cli.json"]);
  });
});

describe("stamp freshness", () => {
  const key = "key-a";
  const now = 1_700_000_000_000;

  it("accepts a successful pass inside the cooldown", () => {
    expect(
      isStampFresh(
        {
          completedAt: now - 60_000,
          writeId: "a",
          result: "ok",
          connectionKey: key,
          paths: [],
        },
        key,
        now,
        5 * 60_000,
      ),
    ).toBe(true);
  });

  it("rejects a successful pass outside the cooldown", () => {
    expect(
      isStampFresh(
        {
          completedAt: now - 20 * 60_000,
          writeId: "a",
          result: "ok",
          connectionKey: key,
          paths: [],
        },
        key,
        now,
        5 * 60_000,
      ),
    ).toBe(false);
  });

  it("treats a zero cooldown as always stale", () => {
    expect(
      isStampFresh(
        {
          completedAt: now,
          writeId: "a",
          result: "ok",
          connectionKey: key,
          paths: [],
        },
        key,
        now,
        0,
      ),
    ).toBe(false);
  });

  it("rejects a stamp from another server", () => {
    expect(
      isStampFresh(
        {
          completedAt: now,
          writeId: "a",
          result: "ok",
          connectionKey: "other",
          paths: [],
        },
        key,
        now,
        5 * 60_000,
      ),
    ).toBe(false);
  });

  it("never lets an aborted pass satisfy the cooldown", () => {
    expect(
      isStampFresh(
        {
          completedAt: now,
          writeId: "a",
          result: "aborted",
          connectionKey: key,
          paths: [],
        },
        key,
        now,
        5 * 60_000,
      ),
    ).toBe(false);
  });

  it("backs off a failed pass until its next attempt", () => {
    const stamp: PreStartSyncStamp = {
      completedAt: now,
      writeId: "a",
      result: "failed",
      connectionKey: key,
      paths: [],
      nextAttemptAt: now + 120_000,
    };
    expect(isStampFresh(stamp, key, now + 60_000, 5 * 60_000)).toBe(true);
    expect(isStampFresh(stamp, key, now + 130_000, 5 * 60_000)).toBe(false);
  });

  it("distrusts a stamp from the future", () => {
    // A backwards clock jump must not freeze the launch sync forever.
    expect(
      isStampFresh(
        {
          completedAt: now + 5 * 60_000,
          writeId: "a",
          result: "ok",
          connectionKey: key,
          paths: [],
        },
        key,
        now,
        5 * 60_000,
      ),
    ).toBe(false);
  });
});

describe("parsePreStartStamp", () => {
  it("rejects malformed payloads", () => {
    expect(parsePreStartStamp("not json")).toBeUndefined();
    expect(parsePreStartStamp("{}")).toBeUndefined();
    expect(
      parsePreStartStamp(JSON.stringify({ completedAt: 1, result: "weird" })),
    ).toBeUndefined();
  });

  it("keeps valid entries and drops non-string paths", () => {
    const parsed = parsePreStartStamp(
      JSON.stringify({
        completedAt: 5,
        writeId: "w",
        result: "ok",
        connectionKey: "k",
        paths: ["a", 7],
      }),
    );
    expect(parsed?.paths).toEqual(["a"]);
  });
});

describe("PreStartSyncGate", () => {
  it("skips the pass when the feature is off", async () => {
    settings["sync.preStartSync"] = false;
    const runner = new ScriptedRunner();
    const { gate } = makeGate(runner);
    await expect(
      gate.beforeOpenCodeStart({ v2ServiceReady: false }),
    ).resolves.toBe("disabled");
    expect(runner.calls).toHaveLength(0);
  });

  it("skips the pass when sync itself is unconfigured", async () => {
    settings["sync.url"] = "";
    const runner = new ScriptedRunner();
    const { gate } = makeGate(runner);
    await expect(
      gate.beforeOpenCodeStart({ v2ServiceReady: false }),
    ).resolves.toBe("disabled");
  });

  it("skips the pass while the breaker is paused", async () => {
    const runner = new ScriptedRunner();
    runner.blocked = true;
    const { gate } = makeGate(runner);
    await expect(
      gate.beforeOpenCodeStart({ v2ServiceReady: false }),
    ).resolves.toBe("disabled");
    expect(runner.calls).toHaveLength(0);
  });

  it("runs the pass and records a successful stamp", async () => {
    const runner = new ScriptedRunner();
    const { gate, progress, active } = makeGate(runner);
    await expect(
      gate.beforeOpenCodeStart({ v2ServiceReady: false }),
    ).resolves.toBe("synced");

    expect(runner.calls[0]?.scopePaths).toContain("cli.json");
    expect(progress.at(0)).toEqual({ phase: "scan", current: 0, total: 0 });
    expect(progress.some((entry) => entry?.path === "cli.json")).toBe(true);
    expect(progress.at(-1)).toBeUndefined();
    expect(active).toEqual([true, false]);

    const stamp = readStamp();
    expect(stamp.result).toBe("ok");
    expect(stamp.connectionKey).toBe(
      preStartConnectionKey("https://dav.test", "/base/", "user"),
    );
  });

  it("honours the cooldown without touching the network", async () => {
    writeStamp({ completedAt: Date.now() - 60_000 });
    const runner = new ScriptedRunner();
    const { gate } = makeGate(runner);
    await expect(
      gate.beforeOpenCodeStart({ v2ServiceReady: false }),
    ).resolves.toBe("cooldown");
    expect(runner.calls).toHaveLength(0);
  });

  it("re-runs the pass once the cooldown expired", async () => {
    writeStamp({ completedAt: Date.now() - 20 * 60_000 });
    const runner = new ScriptedRunner();
    const { gate } = makeGate(runner);
    await expect(
      gate.beforeOpenCodeStart({ v2ServiceReady: false }),
    ).resolves.toBe("synced");
    expect(runner.calls).toHaveLength(1);
  });

  it("syncs on every launch when the cooldown is zero", async () => {
    settings["sync.preStartSyncCooldownMinutes"] = 0;
    const runner = new ScriptedRunner();
    const { gate } = makeGate(runner);
    await expect(
      gate.beforeOpenCodeStart({ v2ServiceReady: false }),
    ).resolves.toBe("synced");
    await expect(
      gate.beforeOpenCodeStart({ v2ServiceReady: false }),
    ).resolves.toBe("synced");
    expect(runner.calls).toHaveLength(2);
  });

  it("ignores a stamp recorded for another server", async () => {
    writeStamp({ connectionKey: "some-other-server" });
    const runner = new ScriptedRunner();
    const { gate } = makeGate(runner);
    await expect(
      gate.beforeOpenCodeStart({ v2ServiceReady: false }),
    ).resolves.toBe("synced");
    expect(runner.calls).toHaveLength(1);
  });

  it("records an aborted stamp when the user skips", async () => {
    const runner = new ScriptedRunner();
    runner.hold = true;
    const { gate } = makeGate(runner);
    const pass = gate.beforeOpenCodeStart({ v2ServiceReady: false });
    await waitFor(() => gate.isRunning());
    expect(gate.skip()).toBe(true);
    expect(runner.aborted).toBe(true);
    runner.release();

    await expect(pass).resolves.toBe("skipped");
    const stamp = readStamp();
    // Aborted never satisfies the cooldown, but it must exist so a sibling
    // window waiting on the stamp does not burn its whole budget.
    expect(stamp.result).toBe("aborted");
    expect(stamp.nextAttemptAt).toBeUndefined();
  });

  it("records a failed stamp with a negative cache", async () => {
    const runner = new ScriptedRunner();
    runner.result = "failed";
    const { gate } = makeGate(runner);
    await expect(
      gate.beforeOpenCodeStart({ v2ServiceReady: false }),
    ).resolves.toBe("failed");
    const stamp = readStamp();
    expect(stamp.result).toBe("failed");
    expect(stamp.nextAttemptAt).toBeGreaterThan(stamp.completedAt);
  });

  it("skips retrying while the negative cache holds", async () => {
    writeStamp({
      result: "failed",
      nextAttemptAt: Date.now() + 60_000,
    });
    const runner = new ScriptedRunner();
    const { gate } = makeGate(runner);
    await expect(
      gate.beforeOpenCodeStart({ v2ServiceReady: false }),
    ).resolves.toBe("cooldown");
    expect(runner.calls).toHaveLength(0);
  });

  it("aborts the pass and releases the launch when the budget elapses", async () => {
    const runner = new ScriptedRunner();
    runner.hold = true;
    const { gate } = makeGate(runner, { budgetMs: 60 });
    const started = Date.now();
    await expect(
      gate.beforeOpenCodeStart({ v2ServiceReady: false }),
    ).resolves.toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(runner.aborted).toBe(true);
    // A timeout still writes a stamp: without it every sibling window would
    // wait out its own full budget.
    expect(readStamp().result).toBe("aborted");
    runner.release();
  });

  it("waits for a sibling pass instead of starting a second one", async () => {
    const busyRunner: PreStartSyncRunner = {
      isAutoPassBlocked: () => false,
      runScopedPass: async () => "busy",
    };
    const { gate } = makeGate(busyRunner);
    const pass = gate.beforeOpenCodeStart({ v2ServiceReady: false });
    // The sibling settles its stamp shortly after this window observes busy.
    await new Promise((resolve) => setTimeout(resolve, 100));
    writeStamp({ completedAt: Date.now(), result: "ok" });
    await expect(pass).resolves.toBe("busy-waited");
  });

  it("gives up waiting for a sibling when the budget elapses", async () => {
    const busyRunner: PreStartSyncRunner = {
      isAutoPassBlocked: () => false,
      runScopedPass: async () => "busy",
    };
    const { gate } = makeGate(busyRunner, { budgetMs: 300 });
    await expect(
      gate.beforeOpenCodeStart({ v2ServiceReady: false }),
    ).resolves.toBe("timeout");
  });

  it("reports no running pass after it settles", async () => {
    const runner = new ScriptedRunner();
    runner.hold = true;
    const { gate } = makeGate(runner);
    expect(gate.isRunning()).toBe(false);
    const pass = gate.beforeOpenCodeStart({ v2ServiceReady: false });
    await waitFor(() => gate.isRunning());
    runner.release();
    await pass;
    expect(gate.isRunning()).toBe(false);
  });

  it("ignores skip when no pass is running", () => {
    const { gate } = makeGate(new ScriptedRunner());
    expect(gate.skip()).toBe(false);
  });

  it("reports a sibling-won pass as a verdict instead of returning early", async () => {
    // The launch still deserves a verdict: another window synced the same
    // machine, so this launch's files are current.
    const busyRunner: PreStartSyncRunner = {
      isAutoPassBlocked: () => false,
      runScopedPass: async () => "busy",
    };
    const results: string[] = [];
    const { gate } = makeGate(busyRunner, {
      onResult: (outcome) => results.push(outcome),
    });
    const pass = gate.beforeOpenCodeStart({ v2ServiceReady: false });
    await new Promise((resolve) => setTimeout(resolve, 100));
    writeStamp({ completedAt: Date.now(), result: "ok" });
    await expect(pass).resolves.toBe("busy-waited");
    expect(results).toEqual(["busy-waited"]);
  });

  it("keeps the budget at ten seconds", () => {
    // The launch path cannot afford the minutes a rate-limit cooldown may
    // sleep, so the constant is deliberately short.
    expect(PRE_START_BUDGET_MS).toBe(10_000);
  });

  it("hands the rest of the scope to a background reconcile", async () => {
    // The launch only needed the boot-read files; AGENTS.md and skills/ are
    // left to a fire-and-forget pass so the launch never waits for them.
    const runner = new ScriptedRunner();
    runner.reconcile = vi.fn();
    const { gate } = makeGate(runner);
    await expect(
      gate.beforeOpenCodeStart({ v2ServiceReady: false }),
    ).resolves.toBe("synced");
    expect(runner.reconcile).toHaveBeenCalledTimes(1);
  });

  it("does not reconcile after a skipped or failed pass", async () => {
    // A pass that did not finish says nothing about the remaining files;
    // reconciling would just repeat the same failing work.
    for (const result of ["aborted", "failed"] as const) {
      const runner = new ScriptedRunner();
      runner.result = result;
      runner.reconcile = vi.fn();
      const { gate } = makeGate(runner);
      await gate.beforeOpenCodeStart({ v2ServiceReady: false });
      expect(runner.reconcile).not.toHaveBeenCalled();
    }
  });

  it("reports the settled verdict to the UI", async () => {
    const results: string[] = [];
    const runner = new ScriptedRunner();
    const { gate } = makeGate(runner, {
      onResult: (outcome) => results.push(outcome),
    });
    await expect(
      gate.beforeOpenCodeStart({ v2ServiceReady: false }),
    ).resolves.toBe("synced");
    expect(results).toEqual(["synced"]);
  });

  it("reports a timeout distinctly from a user skip", async () => {
    // Both abort the pass, but the user must be able to tell "it timed out"
    // from "I skipped it"; only the outcome carries that difference.
    const results: string[] = [];
    const runner = new ScriptedRunner();
    runner.hold = true;
    const { gate } = makeGate(runner, {
      budgetMs: 60,
      onResult: (outcome) => results.push(outcome),
    });
    await expect(
      gate.beforeOpenCodeStart({ v2ServiceReady: false }),
    ).resolves.toBe("timeout");
    expect(results).toEqual(["timeout"]);
    runner.release();
  });

  it("reports a skip when the user aborts", async () => {
    const results: string[] = [];
    const runner = new ScriptedRunner();
    runner.hold = true;
    const { gate } = makeGate(runner, {
      onResult: (outcome) => results.push(outcome),
    });
    const pass = gate.beforeOpenCodeStart({ v2ServiceReady: false });
    await waitFor(() => gate.isRunning());
    gate.skip();
    runner.release();
    await expect(pass).resolves.toBe("skipped");
    // The user just chose to skip; telling them so adds nothing. The gate
    // still reports the outcome, the UI layer drops it.
    expect(results).toEqual(["skipped"]);
  });

  it("stays silent when the feature is off", async () => {
    settings["sync.preStartSync"] = false;
    const results: string[] = [];
    const { gate } = makeGate(new ScriptedRunner(), {
      onResult: (outcome) => results.push(outcome),
    });
    await gate.beforeOpenCodeStart({ v2ServiceReady: false });
    // Nothing ran, so there is no verdict worth showing.
    expect(results).toEqual([]);
  });
});
