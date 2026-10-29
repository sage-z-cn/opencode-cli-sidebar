import { execFile } from "node:child_process";
import * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetOpenCodeCliCompatCaches, resetOpenCodeCliVersionCaches } from "./OpenCodeCliCompat";
import type { RunFn } from "./OpenCodeInstallMethod";
import {
  getOpenCodeUpdateConfig,
  OpenCodeUpdateService,
  type OpenCodeUpdateStatus,
  type OpenCodeUpdateStateStore,
  type UpgradeExecFn,
} from "./OpenCodeUpdateService";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

const mockExecFile = vi.mocked(execFile);

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const NPM_OFFICIAL_URL = "https://registry.npmjs.org/@opencode/cli/latest";
const NPM_MIRROR_URL = "https://registry.npmmirror.com/@opencode/cli/latest";
const TENCENT_MIRROR_URL =
  "https://mirrors.tencent.com/npm/@opencode/cli/latest";
const HELP_WITH_CHOICES =
  "  -m, --method string   installation method (choices: curl, npm, pnpm)";
const V2_0_6 = "opencode v2.0.6\n";
const V2_0_7 = "opencode v2.0.7\n";
const BLOCKED_OUTPUT = [
  "NVM blocked package-manager execution",
  "Reason: the module could not be trusted",
  "File: C:\\Users\\sage\\AppData\\Roaming\\nvm\\node_modules\\@opencode\\cli\\bin\\opencode.cmd",
];

type ExecCb = (error: Error | null, stdout: string) => void;
const lastArgAsCb = (args: unknown[]): ExecCb =>
  args[args.length - 1] as ExecCb;

function respondVersion(stdout: string): void {
  mockExecFile.mockImplementation((...args: unknown[]) => {
    lastArgAsCb(args)(null, stdout);
    return {} as ReturnType<typeof execFile>;
  });
}

/** Serves one output per execFile call; the last entry repeats. */
function respondVersionSequence(outputs: string[]): void {
  let call = 0;
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const output = call < outputs.length ? outputs[call] : outputs.at(-1);
    call += 1;
    lastArgAsCb(args)(null, `${output}\n`);
    return {} as ReturnType<typeof execFile>;
  });
}

function failVersion(): void {
  mockExecFile.mockImplementation((...args: unknown[]) => {
    lastArgAsCb(args)(new Error("spawn opencode ENOENT"), "");
    return {} as ReturnType<typeof execFile>;
  });
}

interface MemoryStore extends OpenCodeUpdateStateStore {
  data: Map<string, unknown>;
}

function createStore(initial?: Record<string, unknown>): MemoryStore {
  const data = new Map<string, unknown>(Object.entries(initial ?? {}));
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

const unexpectingExec: RunFn = async () => {
  throw new Error("unexpected exec");
};

const unexpectingUpgrade: UpgradeExecFn = async () => {
  throw new Error("unexpected upgrade exec");
};

function makeService(options?: {
  store?: MemoryStore;
  exec?: RunFn;
  execUpgrade?: UpgradeExecFn;
  getBinary?: () => string;
  now?: () => number;
}): { store: MemoryStore; service: OpenCodeUpdateService } {
  const store = options?.store ?? createStore();
  const service = new OpenCodeUpdateService(store, {
    logger,
    now: options?.now ?? (() => 12345),
    exec: options?.exec ?? unexpectingExec,
    execUpgrade: options?.execUpgrade ?? unexpectingUpgrade,
    getBinary: options?.getBinary ?? (() => "opencode"),
  });
  return { store, service };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

function collectEvents(service: OpenCodeUpdateService): OpenCodeUpdateStatus[] {
  const events: OpenCodeUpdateStatus[] = [];
  service.onDidChangeStatus((event) => events.push(event));
  return events;
}

describe("OpenCodeUpdateService", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetOpenCodeCliCompatCaches();
    vi.clearAllMocks();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("checkForUpdates", () => {
    it("disables the update flow for v1 CLIs", async () => {
      respondVersion("opencode v1.18.33\n");
      const { store, service } = makeService();

      const result = await service.checkForUpdates();

      expect(result).toEqual({ ok: true, state: "disabled" });
      expect(service.status).toBe("disabled");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(store.update).not.toHaveBeenCalled();
    });

    it("disables the update flow when the CLI cannot be probed", async () => {
      failVersion();
      const { service } = makeService();

      const result = await service.checkForUpdates();

      expect(result).toEqual({ ok: true, state: "disabled" });
      expect(service.status).toBe("disabled");
    });

    it("reports an available update when the remote version is newer", async () => {
      respondVersion(V2_0_6);
      fetchMock.mockResolvedValueOnce(jsonResponse({ version: "2.0.7" }));
      const { store, service } = makeService();
      const events = collectEvents(service);

      const result = await service.checkForUpdates();

      expect(result).toEqual({
        ok: true,
        state: "available",
        current: "2.0.6",
        latest: "2.0.7",
      });
      expect(service.status).toBe("available");
      expect(events.map((event) => event.state)).toEqual([
        "checking",
        "available",
      ]);
      expect(fetchMock).toHaveBeenCalledWith(
        NPM_OFFICIAL_URL,
        expect.objectContaining({
          headers: { Accept: "application/json" },
          signal: expect.any(AbortSignal),
        }),
      );
      expect(store.update).toHaveBeenCalledWith(
        "opencodeUpdate.lastCheckAt",
        12345,
      );
    });

    it("marks status events with the manual flag", async () => {
      respondVersion(V2_0_6);
      fetchMock.mockResolvedValue(jsonResponse({ version: "2.0.6" }));
      const { service } = makeService();
      const manualFlags: Array<boolean | undefined> = [];
      service.onDidChangeStatus((event) => manualFlags.push(event.manual));

      await service.checkForUpdates({ manual: true });
      expect(manualFlags).toEqual([true, true]);

      manualFlags.length = 0;
      await service.checkForUpdates();
      expect(manualFlags).toEqual([false, false]);
    });

    it("reports up to date on equal versions", async () => {
      respondVersion(V2_0_6);
      fetchMock.mockResolvedValueOnce(jsonResponse({ version: "2.0.6" }));
      const { service } = makeService();

      const result = await service.checkForUpdates();

      expect(result).toEqual({
        ok: true,
        state: "upToDate",
        current: "2.0.6",
        latest: "2.0.6",
      });
      expect(service.status).toBe("upToDate");
    });

    it("falls back to npm mirrors when the official registry fails", async () => {
      respondVersion(V2_0_6);
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({ error: "unavailable" }, false, 500),
        )
        .mockResolvedValueOnce(jsonResponse({ version: "2.0.7" }));
      const { service } = makeService();

      const result = await service.checkForUpdates();

      expect(result).toEqual({
        ok: true,
        state: "available",
        current: "2.0.6",
        latest: "2.0.7",
      });
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        NPM_MIRROR_URL,
        expect.objectContaining({
          headers: { Accept: "application/json" },
          signal: expect.any(AbortSignal),
        }),
      );
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining("registry.npmjs.org"),
      );
    });

    it("falls back to the tencent mirror when official and npmmirror fail", async () => {
      respondVersion(V2_0_6);
      fetchMock
        .mockResolvedValueOnce(jsonResponse({}, false, 500))
        .mockResolvedValueOnce(jsonResponse({}, false, 502))
        .mockResolvedValueOnce(jsonResponse({ version: "2.0.7" }));
      const { service } = makeService();

      const result = await service.checkForUpdates();

      expect(result).toEqual({
        ok: true,
        state: "available",
        current: "2.0.6",
        latest: "2.0.7",
      });
      expect(fetchMock).toHaveBeenNthCalledWith(
        3,
        TENCENT_MIRROR_URL,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it("returns ok:false without throwing when every endpoint fails", async () => {
      respondVersion(V2_0_6);
      fetchMock
        .mockResolvedValueOnce(jsonResponse({}, false, 500))
        .mockResolvedValueOnce(jsonResponse({}, false, 503))
        .mockResolvedValueOnce(jsonResponse({}, false, 404));
      const { service } = makeService();

      const result = await service.checkForUpdates();

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/all latest-version endpoints failed/);
      expect(service.status).toBe("idle");
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("[OpenCodeUpdateService] update check failed"),
      );
    });

    it("rejects malformed registry bodies and falls through to the next mirror", async () => {
      respondVersion(V2_0_6);
      fetchMock
        .mockResolvedValueOnce(jsonResponse({}))
        .mockResolvedValueOnce(jsonResponse({}))
        .mockResolvedValueOnce(jsonResponse({ version: "2.0.6" }));
      const { service } = makeService();

      const result = await service.checkForUpdates();

      expect(result).toEqual({
        ok: true,
        state: "upToDate",
        current: "2.0.6",
        latest: "2.0.6",
      });
    });

    it("fails when every endpoint returns a malformed body", async () => {
      respondVersion(V2_0_6);
      fetchMock
        .mockResolvedValueOnce(jsonResponse({}))
        .mockResolvedValueOnce(jsonResponse({}))
        .mockResolvedValueOnce(jsonResponse({}));
      const { service } = makeService();

      const result = await service.checkForUpdates();

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/all latest-version endpoints failed/);
      expect(service.status).toBe("idle");
    });

    it("restores the previous status after a failed re-check", async () => {
      respondVersion(V2_0_6);
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ version: "2.0.7" }))
        .mockResolvedValueOnce(jsonResponse({}, false, 503))
        .mockResolvedValueOnce(jsonResponse({}, false, 503))
        .mockResolvedValueOnce(jsonResponse({}, false, 503));
      const { service } = makeService();

      await service.checkForUpdates();
      expect(service.status).toBe("available");

      const result = await service.checkForUpdates();

      expect(result.ok).toBe(false);
      expect(service.status).toBe("available");
    });

    it("fails gracefully when the local full version is unavailable", async () => {
      failVersion();
      const { service } = makeService();

      const result = await service.checkForUpdates();

      // An unprobeable CLI keeps the v2-only feature disabled, not failed.
      expect(result).toEqual({ ok: true, state: "disabled" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("probes --version once per cold check", async () => {
      respondVersion(V2_0_6);
      fetchMock.mockResolvedValueOnce(jsonResponse({ version: "2.0.6" }));
      const { service } = makeService();

      await service.checkForUpdates();

      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    it("probes the disk fresh so an external upgrade is not reported as pending", async () => {
      // Prime the version cache the way the activation pill does.
      respondVersion(V2_0_6);
      const { service } = makeService();
      await expect(service.probeLocalVersion()).resolves.toBe("2.0.6");

      // The user upgrades the CLI outside the extension; the next check
      // must compare the new disk version, not the cached old one.
      respondVersion(V2_0_7);
      fetchMock.mockResolvedValueOnce(jsonResponse({ version: "2.0.7" }));

      const result = await service.checkForUpdates();

      expect(result).toEqual({
        ok: true,
        state: "upToDate",
        current: "2.0.7",
        latest: "2.0.7",
      });
      expect(service.status).toBe("upToDate");
    });

    it("dedupes concurrent checks onto the in-flight check", async () => {
      respondVersion(V2_0_6);
      fetchMock.mockResolvedValue(jsonResponse({ version: "2.0.6" }));
      const { service } = makeService();

      const first = service.checkForUpdates();
      const second = service.checkForUpdates();
      const [a, b] = await Promise.all([first, second]);

      expect(a).toEqual(b);
      // One check races all three endpoints concurrently.
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("rejects checkForUpdates while an update is in progress", async () => {
      respondVersionSequence([V2_0_6, V2_0_7]);
      fetchMock.mockResolvedValue(jsonResponse({ version: "2.0.7" }));
      const execUpgrade = vi.fn(
        (_file: string, _args: string[], options?: { signal?: AbortSignal }) =>
          new Promise<string>((_, reject) => {
            options?.signal?.addEventListener("abort", () => {
              reject(new Error("The operation was aborted"));
            });
          }),
      );
      const { service } = makeService({ execUpgrade });

      const pending = service.startUpdate("curl");
      await vi.waitFor(() => expect(execUpgrade).toHaveBeenCalled());
      const fetchCallsBefore = fetchMock.mock.calls.length;

      const result = await service.checkForUpdates();

      expect(result).toMatchObject({ ok: false, error: "update in progress" });
      expect(service.status).toBe("updating");
      expect(fetchMock.mock.calls.length).toBe(fetchCallsBefore);

      service.abandonUpdate();
      const done = await pending;
      expect(done.ok).toBe(false);
    });

    it("resolves the binary through the injected getter", async () => {
      respondVersion(V2_0_6);
      fetchMock.mockResolvedValueOnce(jsonResponse({ version: "2.0.6" }));
      const { service } = makeService({
        getBinary: () => '"C:\\Tools\\opencode\\opencode.exe" --verbose',
      });

      const result = await service.checkForUpdates();

      expect(result.ok).toBe(true);
      expect(mockExecFile.mock.calls[0][0]).toBe(
        "C:\\Tools\\opencode\\opencode.exe",
      );
    });

    it("returns a failed install to installable on the re-check", async () => {
      failVersion();
      let installRuns = 0;
      const execUpgrade = vi.fn(async () => {
        installRuns += 1;
        if (installRuns === 1) {
          throw new Error("npm install failed");
        }
        return "installed";
      });
      const { service } = makeService({ execUpgrade });

      service.markCliMissing(false);
      const first = await service.startInstall("npm");
      expect(first.ok).toBe(false);
      expect(service.status).toBe("failed");

      // The re-check still finds no CLI: the service must hand the entry
      // back to installable instead of stranding the failed state.
      const check = await service.checkForUpdates({ manual: true });
      expect(check.ok).toBe(true);
      expect(check.state).toBe("installable");
      expect(service.status).toBe("installable");

      // The install entry works again after the re-check.
      respondVersion(V2_0_7);
      const second = await service.startInstall("npm");
      expect(second).toMatchObject({ ok: true, state: "updateSucceeded" });
      expect(execUpgrade).toHaveBeenCalledTimes(2);
    });

    it("re-arms installable when the CLI probe follows a disabled check verdict", async () => {
      failVersion();
      const { service } = makeService();

      const result = await service.checkForUpdates();
      expect(result.state).toBe("disabled");
      expect(service.status).toBe("disabled");

      // The activation availability probe settles after the racing check:
      // its fresh "CLI missing" verdict must outrank the stale disabled one.
      service.markCliMissing(true);
      expect(service.status).toBe("installable");
    });

    it("keeps an installable state armed while a check is still resolving", async () => {
      let releaseVersion: ((stdout: string) => void) | undefined;
      mockExecFile.mockImplementation((...args: unknown[]) => {
        releaseVersion = (stdout: string) => lastArgAsCb(args)(null, stdout);
        return {} as ReturnType<typeof execFile>;
      });
      const { service } = makeService();

      const check = service.checkForUpdates();
      await vi.waitFor(() => expect(releaseVersion).toBeDefined());
      expect(service.status).toBe("checking");

      // The activation probe arms the install entry mid-check.
      service.markCliMissing(true);
      expect(service.status).toBe("installable");

      releaseVersion?.("");
      const result = await check;

      expect(result.ok).toBe(true);
      expect(result.state).toBe("installable");
      expect(service.status).toBe("installable");
    });
  });

  describe("probeLocalVersion", () => {
    it("returns the version for a v2 CLI without fetching or changing state", async () => {
      respondVersion("opencode v2.0.7\n");
      const { service } = makeService();
      const events = collectEvents(service);

      await expect(service.probeLocalVersion()).resolves.toBe("2.0.7");

      expect(fetchMock).not.toHaveBeenCalled();
      expect(service.status).toBe("idle");
      expect(events).toEqual([]);
    });

    it("returns undefined for v1 CLIs and unprobeable binaries", async () => {
      respondVersion("opencode v1.18.33\n");
      const v1Service = makeService().service;
      await expect(v1Service.probeLocalVersion()).resolves.toBeUndefined();

      failVersion();
      const unprobeableService = makeService().service;
      await expect(unprobeableService.probeLocalVersion()).resolves.toBeUndefined();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(v1Service.status).toBe("idle");
      expect(unprobeableService.status).toBe("idle");
    });
  });

  describe("probeCliAvailable", () => {
    it("returns true when the --version probe succeeds", async () => {
      const exec = vi.fn(async () => "opencode v2.0.7\n");
      const { service } = makeService({ exec });

      await expect(service.probeCliAvailable()).resolves.toBe(true);

      expect(exec).toHaveBeenCalledWith("opencode", ["--version"], 10_000);
      expect(service.status).toBe("idle");
    });

    it("returns false when the --version probe throws", async () => {
      const exec = vi.fn(async () => {
        throw new Error("spawn opencode ENOENT");
      });
      const { service } = makeService({ exec });

      await expect(service.probeCliAvailable()).resolves.toBe(false);

      expect(service.status).toBe("idle");
    });

    it("resolves the binary through the configured command", async () => {
      const exec = vi.fn(async () => "opencode v2.0.7\n");
      const { service } = makeService({
        exec,
        getBinary: () => '"C:\\tools\\opencode.exe" --http',
      });

      await expect(service.probeCliAvailable()).resolves.toBe(true);

      expect(exec).toHaveBeenCalledWith("C:\\tools\\opencode.exe", [
        "--version",
      ], 10_000);
    });

    it("relaxes the probe timeout for cold starts", async () => {
      const exec: RunFn = vi.fn(async () => "opencode v2.1.0\n");
      const { service } = makeService({ exec });

      await expect(service.probeCliAvailable()).resolves.toBe(true);

      expect(exec).toHaveBeenLastCalledWith(
        "opencode",
        ["--version"],
        10_000,
      );
    });
  });

  describe("recheckCliAvailable", () => {
    it("settles idle when the CLI appeared and resets the version cache", async () => {
      const exec: RunFn = vi.fn(async () => "opencode v2.1.0\n");
      const { service } = makeService({ exec });
      service.markCliMissing();
      // Prime the local-version cache with a stale value so the reset
      // inside the re-check is observable.
      respondVersion(V2_0_6);
      await service.probeLocalVersion();

      await expect(service.recheckCliAvailable()).resolves.toBe(true);

      expect(service.status).toBe("idle");
      respondVersion(V2_0_7);
      await expect(service.probeLocalVersion()).resolves.toBe("2.0.7");
    });

    it("returns to installable with the prompt cleared when still missing", async () => {
      const exec: RunFn = vi.fn(async () => {
        throw new Error("spawn opencode ENOENT");
      });
      const { service } = makeService({ exec });
      service.markCliMissing();
      const events = collectEvents(service);

      await expect(service.recheckCliAvailable()).resolves.toBe(false);

      expect(service.status).toBe("installable");
      expect(events.map((event) => event.state)).toEqual([
        "checking",
        "installable",
      ]);
      expect(events.at(-1)?.installPromptPending).toBe(false);
    });

    it("ignores the re-check while an install is running", async () => {
      let resolveInstall: ((value: string) => void) | undefined;
      const execUpgrade = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveInstall = resolve;
          }),
      );
      const exec: RunFn = vi.fn(async () => "opencode v2.1.0\n");
      const { service } = makeService({ exec, execUpgrade });
      service.markCliMissing(false);

      const pending = service.startInstall("npm");
      await vi.waitFor(() => expect(execUpgrade).toHaveBeenCalled());

      await expect(service.recheckCliAvailable()).resolves.toBe(false);
      expect(service.status).toBe("updating");
      expect(exec).not.toHaveBeenCalled();

      service.abandonUpdate();
      resolveInstall?.("done");
      await pending;
    });

    it("dedupes a concurrent check onto the in-flight re-detect probe", async () => {
      let resolveProbe: ((stdout: string) => void) | undefined;
      const exec: RunFn = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveProbe = resolve;
          }),
      );
      const { service } = makeService({ exec });
      service.markCliMissing();

      const recheck = service.recheckCliAvailable();
      await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(1));
      expect(service.status).toBe("checking");

      // A manual check arriving mid-probe must piggyback on the probe
      // instead of stacking a second --version run and a registry fetch.
      const check = service.checkForUpdates();
      resolveProbe?.("opencode v2.1.0\n");
      const [available, result] = await Promise.all([recheck, check]);

      expect(available).toBe(true);
      expect(result).toEqual({ ok: true, state: "idle" });
      expect(exec).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(service.status).toBe("idle");
    });
  });

  describe("startUpdate", () => {
    it("rejects method ids outside the whitelist without touching state", async () => {
      const { service } = makeService();

      for (const method of ["npm; calc", "curl && whoami", "-npm", ""]) {
        const result = await service.startUpdate(method);
        expect(result).toMatchObject({ ok: false, error: "invalid method" });
      }

      expect(service.status).toBe("idle");
    });

    it("runs the full pipeline and reports updateSucceeded", async () => {
      respondVersionSequence([V2_0_6, V2_0_7]);
      fetchMock.mockResolvedValue(jsonResponse({ version: "2.0.7" }));
      const execUpgrade = vi.fn(async () => "upgraded");
      const { store, service } = makeService({ execUpgrade });
      const events = collectEvents(service);

      const result = await service.startUpdate("curl");

      expect(result).toEqual({
        ok: true,
        state: "updateSucceeded",
        targetVersion: "2.0.7",
        installedVersion: "2.0.7",
      });
      expect(service.status).toBe("updateSucceeded");
      expect(execUpgrade).toHaveBeenCalledTimes(1);
      expect(execUpgrade).toHaveBeenCalledWith(
        "opencode",
        ["upgrade", "--method", "curl"],
        expect.objectContaining({ timeoutMs: 10 * 60 * 1000 }),
      );
      expect(store.data.get("opencodeUpdate.lastMethod")).toBe("curl");
      expect(events.map((event) => [event.state, event.step])).toEqual([
        ["updating", "prepare-target"],
        ["updating", "prepare-local"],
        ["updating", "execute"],
        ["updating", "verify"],
        ["updateSucceeded", undefined],
      ]);
    });

    it("reshims nvm-windows after an npm-family upgrade", async () => {
      respondVersionSequence([V2_0_6, V2_0_7]);
      fetchMock.mockResolvedValue(jsonResponse({ version: "2.0.7" }));
      const exec = vi.fn(async (file: string, args: string[]) => {
        if (file === "nvm" && args[0] === "version") {
          return "2.0.1-hotfix.2";
        }
        throw new Error(`unexpected probe: ${file}`);
      });
      const execUpgrade = vi.fn(async () => "done");
      const { service } = makeService({ exec, execUpgrade });

      const result = await service.startUpdate("npm");

      expect(result.ok).toBe(true);
      expect(
        execUpgrade.mock.calls.map(([file, args]) => [file, ...args].join(" ")),
      ).toEqual([
        "opencode upgrade --method npm",
        "nvm reshim",
        "nvm firewall trust module opencode",
      ]);
      expect(service.status).toBe("updateSucceeded");
    });

    it.each(["curl", "brew", "vp"])(
      "skips nvm reshim for method %s",
      async (method) => {
        respondVersionSequence([V2_0_6, V2_0_7]);
        fetchMock.mockResolvedValue(jsonResponse({ version: "2.0.7" }));
        const execUpgrade = vi.fn(async () => "done");
        const { service } = makeService({ execUpgrade });

        const result = await service.startUpdate(method);

        expect(result.ok).toBe(true);
        expect(execUpgrade).toHaveBeenCalledTimes(1);
      },
    );

    it("remediates NVM4306 blocks, re-runs the upgrade, then verifies", async () => {
      respondVersionSequence([V2_0_6, V2_0_7]);
      fetchMock.mockResolvedValue(jsonResponse({ version: "2.0.7" }));
      const exec = vi.fn(async (file: string, args: string[]) => {
        if (file === "nvm" && args[0] === "version") {
          return "2.0.1";
        }
        throw new Error(`unexpected probe: ${file}`);
      });
      let upgradeRuns = 0;
      const execUpgrade = vi.fn(
        async (
          file: string,
          args: string[],
          options?: { onLine?: (line: string, stream: "stdout" | "stderr") => void },
        ) => {
          if (file === "opencode") {
            upgradeRuns += 1;
            if (upgradeRuns === 1) {
              for (const line of BLOCKED_OUTPUT) {
                options?.onLine?.(line, "stdout");
              }
              throw new Error("opencode exited with code 1");
            }
            return "upgraded";
          }
          return "ok";
        },
      );
      const { service } = makeService({ exec, execUpgrade });
      const events = collectEvents(service);

      const result = await service.startUpdate("npm");

      expect(result).toEqual({
        ok: true,
        state: "updateSucceeded",
        targetVersion: "2.0.7",
        installedVersion: "2.0.7",
      });
      expect(
        execUpgrade.mock.calls.map(([file, args]) => [file, ...args].join(" ")),
      ).toEqual([
        "opencode upgrade --method npm",
        "nvm firewall trust module opencode",
        "nvm reshim",
        "opencode upgrade --method npm",
        "nvm firewall trust module opencode",
      ]);
      expect(events.map((event) => event.step)).toEqual([
        "prepare-target",
        "prepare-local",
        "execute",
        "remediate-trust",
        "remediate-reshim",
        "execute",
        "verify",
        undefined,
      ]);
    });

    it("fails with manual commands when the re-run is blocked again", async () => {
      respondVersionSequence([V2_0_6]);
      fetchMock.mockResolvedValue(jsonResponse({ version: "2.0.7" }));
      const execUpgrade = vi.fn(
        async (
          file: string,
          args: string[],
          options?: { onLine?: (line: string, stream: "stdout" | "stderr") => void },
        ) => {
          if (file === "opencode") {
            for (const line of BLOCKED_OUTPUT) {
              options?.onLine?.(line, "stdout");
            }
            throw new Error("opencode exited with code 1");
          }
          return "ok";
        },
      );
      const { service } = makeService({ execUpgrade });

      const result = await service.startUpdate("npm");

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/blocked again by the nvm firewall/);
      expect(result.remediationCommands).toEqual([
        "nvm firewall trust module opencode",
        "nvm reshim",
      ]);
      expect(service.status).toBe("failed");
    });

    it("fails with the two manual commands when nvm trust fails", async () => {
      respondVersionSequence([V2_0_6]);
      fetchMock.mockResolvedValue(jsonResponse({ version: "2.0.7" }));
      const execUpgrade = vi.fn(
        async (
          file: string,
          args: string[],
          options?: { onLine?: (line: string, stream: "stdout" | "stderr") => void },
        ) => {
          if (file === "opencode") {
            for (const line of BLOCKED_OUTPUT) {
              options?.onLine?.(line, "stdout");
            }
            throw new Error("opencode exited with code 1");
          }
          throw new Error("trust denied");
        },
      );
      const { service } = makeService({ execUpgrade });
      const events = collectEvents(service);

      const result = await service.startUpdate("npm");

      expect(result.ok).toBe(false);
      expect(result.state).toBe("failed");
      expect(result.remediationCommands).toEqual([
        "nvm firewall trust module opencode",
        "nvm reshim",
      ]);
      expect(service.status).toBe("failed");
      expect(events.at(-1)).toMatchObject({
        state: "failed",
        remediationCommands: [
          "nvm firewall trust module opencode",
          "nvm reshim",
        ],
        targetVersion: "2.0.7",
      });
      // Verification never ran.
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    it("fails with manual commands when the remediation reshim fails", async () => {
      respondVersionSequence([V2_0_6]);
      fetchMock.mockResolvedValue(jsonResponse({ version: "2.0.7" }));
      const execUpgrade = vi.fn(
        async (
          file: string,
          args: string[],
          options?: { onLine?: (line: string, stream: "stdout" | "stderr") => void },
        ) => {
          if (file === "opencode") {
            for (const line of BLOCKED_OUTPUT) {
              options?.onLine?.(line, "stdout");
            }
            throw new Error("opencode exited with code 1");
          }
          if (args[0] === "firewall") {
            return "trusted";
          }
          throw new Error("reshim failed");
        },
      );
      const { service } = makeService({ execUpgrade });

      const result = await service.startUpdate("npm");

      expect(result.ok).toBe(false);
      expect(result.state).toBe("failed");
      expect(result.error).toMatch(/nvm reshim failed/);
      expect(result.remediationCommands).toEqual([
        "nvm firewall trust module opencode",
        "nvm reshim",
      ]);
    });

    it("fails without commands when the blocked module path is unparseable", async () => {
      respondVersionSequence([V2_0_6]);
      fetchMock.mockResolvedValue(jsonResponse({ version: "2.0.7" }));
      const execUpgrade = vi.fn(
        async (
          file: string,
          args: string[],
          options?: { onLine?: (line: string, stream: "stdout" | "stderr") => void },
        ) => {
          if (file === "opencode") {
            options?.onLine?.("NVM blocked package-manager execution", "stderr");
            throw new Error("opencode exited with code 1");
          }
          return "ok";
        },
      );
      const { service } = makeService({ execUpgrade });

      const result = await service.startUpdate("npm");

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/unparseable/);
      expect(result.remediationCommands).toBeUndefined();
    });

    it("fails when verification still reports the old version", async () => {
      respondVersionSequence([V2_0_6, V2_0_6]);
      fetchMock.mockResolvedValue(jsonResponse({ version: "2.0.7" }));
      const execUpgrade = vi.fn(async () => "done");
      const { service } = makeService({ execUpgrade });

      const result = await service.startUpdate("curl");

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/version verification failed/);
      expect(service.status).toBe("failed");
    });

    it("fails when verification reports a dev build", async () => {
      respondVersionSequence([V2_0_6, "local"]);
      fetchMock.mockResolvedValue(jsonResponse({ version: "2.0.7" }));
      const execUpgrade = vi.fn(async () => "done");
      const { service } = makeService({ execUpgrade });

      const result = await service.startUpdate("curl");

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/version verification failed.*local/);
    });

    it("fails when the upgrade command errors or times out", async () => {
      respondVersionSequence([V2_0_6]);
      fetchMock.mockResolvedValue(jsonResponse({ version: "2.0.7" }));
      const execUpgrade = vi.fn(async () => {
        throw new Error("opencode exited with code (unknown)");
      });
      const { service } = makeService({ execUpgrade });

      const result = await service.startUpdate("curl");

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/upgrade command failed/);
      expect(service.status).toBe("failed");
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    it("aborts before executing when the target cannot be resolved", async () => {
      respondVersion(V2_0_6);
      fetchMock.mockRejectedValue(new Error("network down"));
      const execUpgrade = vi.fn(async () => "should not run");
      const { service } = makeService({ execUpgrade });

      const result = await service.startUpdate("curl");

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/all latest-version endpoints failed/);
      expect(execUpgrade).not.toHaveBeenCalled();
      expect(service.status).toBe("failed");
    });

    it("rejects startUpdate when the update flow is disabled", async () => {
      respondVersion("opencode v1.18.33\n");
      const execUpgrade = vi.fn(async () => "should not run");
      const { service } = makeService({ execUpgrade });

      const fresh = await service.startUpdate("npm");
      expect(fresh).toMatchObject({ ok: false, state: "disabled" });
      expect(execUpgrade).not.toHaveBeenCalled();

      const guard = await service.startUpdate("npm");
      expect(guard).toMatchObject({ ok: false, state: "disabled" });
    });

    it("waits for an in-flight check and continues the update afterwards", async () => {
      // execFile call order: each check probes --version fresh (both see
      // the old disk version), and the verify probe after the upgrade
      // reports the new one.
      respondVersionSequence([V2_0_6, V2_0_6, V2_0_7]);
      fetchMock.mockResolvedValue(jsonResponse({ version: "2.0.7" }));
      const execUpgrade = vi.fn(async () => "upgraded");
      const { service } = makeService({ execUpgrade });

      const first = await service.checkForUpdates();
      expect(first.state).toBe("available");

      // The second check pends on its fetch; the update click lands in
      // that window and must wait instead of being rejected.
      let releaseFetch: ((response: Response) => void) | undefined;
      fetchMock.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            releaseFetch = resolve;
          }),
      );
      const second = service.checkForUpdates({ manual: true });
      await vi.waitFor(() => expect(releaseFetch).toBeDefined());

      const update = service.startUpdate("curl");
      releaseFetch?.(jsonResponse({ version: "2.0.7" }));
      const [checkResult, updateResult] = await Promise.all([
        second,
        update,
      ]);

      expect(checkResult.state).toBe("available");
      expect(updateResult).toMatchObject({
        ok: true,
        state: "updateSucceeded",
        installedVersion: "2.0.7",
      });
      expect(service.status).toBe("updateSucceeded");
      expect(execUpgrade).toHaveBeenCalledTimes(1);
    });

    it("reuses a recent check result as the upgrade target", async () => {
      respondVersionSequence([V2_0_6, V2_0_7]);
      fetchMock.mockResolvedValueOnce(jsonResponse({ version: "2.0.7" }));
      const execUpgrade = vi.fn(async () => "done");
      const { service } = makeService({ execUpgrade });

      await service.checkForUpdates();
      fetchMock.mockClear();
      fetchMock.mockRejectedValue(new Error("offline"));

      const result = await service.startUpdate("curl");

      expect(result.ok).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("re-checks when the cached target is older than five minutes", async () => {
      let nowValue = 1000;
      respondVersionSequence([V2_0_6, V2_0_7]);
      fetchMock.mockResolvedValue(jsonResponse({ version: "2.0.7" }));
      const execUpgrade = vi.fn(async () => "done");
      const { service } = makeService({ execUpgrade, now: () => nowValue });

      await service.checkForUpdates();
      nowValue += 6 * 60 * 1000;

      const result = await service.startUpdate("curl");

      expect(result.ok).toBe(true);
      // Two checks; each races all three endpoints.
      expect(fetchMock).toHaveBeenCalledTimes(6);
    });

    it.each(["2.0.8", "2.0.9"])(
      "short-circuits to upToDate when the cached target is already on disk at %s",
      async (diskVersion) => {
        respondVersion(V2_0_7);
        fetchMock.mockResolvedValueOnce(jsonResponse({ version: "2.0.8" }));
        const execUpgrade = vi.fn(
          async (_file: string, _args: string[]) => "should not run",
        );
        const { service } = makeService({ execUpgrade });
        const events = collectEvents(service);

        await service.checkForUpdates();
        expect(service.status).toBe("available");

        // The user updated the binary outside the extension; the next
        // disk probe must see the new version, not the cached one.
        resetOpenCodeCliVersionCaches();
        respondVersion(`opencode v${diskVersion}\n`);
        fetchMock.mockClear();

        const result = await service.startUpdate("curl");

        expect(result).toEqual({
          ok: true,
          state: "upToDate",
          targetVersion: "2.0.8",
          installedVersion: diskVersion,
        });
        expect(service.status).toBe("upToDate");
        expect(fetchMock).not.toHaveBeenCalled();
        expect(
          execUpgrade.mock.calls.filter(([, args]) => args[0] === "upgrade"),
        ).toHaveLength(0);
        expect(events.map((event) => [event.state, event.step])).toEqual([
          ["checking", undefined],
          ["available", undefined],
          ["updating", "prepare-target"],
          ["updating", "prepare-local"],
          ["upToDate", undefined],
        ]);
        expect(events.at(-1)).toMatchObject({
          state: "upToDate",
          manual: true,
          currentVersion: diskVersion,
          latestVersion: "2.0.8",
        });
      },
    );

    it("short-circuits a stale-target re-check to upToDate instead of failed", async () => {
      let nowValue = 1000;
      respondVersion(V2_0_6);
      fetchMock.mockResolvedValueOnce(jsonResponse({ version: "2.0.7" }));
      const execUpgrade = vi.fn(
        async (_file: string, _args: string[]) => "should not run",
      );
      const { service } = makeService({ execUpgrade, now: () => nowValue });
      const events = collectEvents(service);

      await service.checkForUpdates();
      expect(service.status).toBe("available");

      nowValue += 6 * 60 * 1000;
      // The target cache rotted while the user updated the binary
      // outside the extension; the re-check finds the disk current.
      resetOpenCodeCliVersionCaches();
      respondVersion(V2_0_7);
      fetchMock.mockResolvedValue(jsonResponse({ version: "2.0.7" }));

      const result = await service.startUpdate("curl");

      expect(result).toEqual({
        ok: true,
        state: "upToDate",
        targetVersion: "2.0.7",
        installedVersion: "2.0.7",
      });
      expect(service.status).toBe("upToDate");
      // Initial check plus the stale-target re-check: 2 × 3 raced calls.
      expect(fetchMock).toHaveBeenCalledTimes(6);
      expect(
        execUpgrade.mock.calls.filter(([, args]) => args[0] === "upgrade"),
      ).toHaveLength(0);
      expect(events.map((event) => [event.state, event.step])).toEqual([
        ["checking", undefined],
        ["available", undefined],
        ["updating", "prepare-target"],
        ["upToDate", undefined],
      ]);
      expect(events.at(-1)).toMatchObject({
        state: "upToDate",
        manual: true,
        currentVersion: "2.0.7",
        latestVersion: "2.0.7",
      });
    });

    it("ignores startUpdate while an update is already running", async () => {
      respondVersionSequence([V2_0_6, V2_0_7]);
      fetchMock.mockResolvedValue(jsonResponse({ version: "2.0.7" }));
      const execUpgrade = vi.fn(
        (_file: string, _args: string[], options?: { signal?: AbortSignal }) =>
          new Promise<string>((_, reject) => {
            options?.signal?.addEventListener("abort", () => {
              reject(new Error("The operation was aborted"));
            });
          }),
      );
      const { service } = makeService({ execUpgrade });

      const first = service.startUpdate("curl");
      await vi.waitFor(() => expect(execUpgrade).toHaveBeenCalled());

      const second = await service.startUpdate("curl");
      expect(second).toMatchObject({
        ok: false,
        error: "update already in progress",
      });
      expect(service.status).toBe("updating");
      expect(execUpgrade).toHaveBeenCalledTimes(1);

      service.abandonUpdate();
      const result = await first;
      expect(result.ok).toBe(false);
      expect(service.status).toBe("available");
    });

    it("abandons an in-flight upgrade and restores available", async () => {
      respondVersionSequence([V2_0_6, V2_0_7]);
      fetchMock.mockResolvedValue(jsonResponse({ version: "2.0.7" }));
      const execUpgrade = vi.fn(
        (_file: string, _args: string[], options?: { signal?: AbortSignal }) =>
          new Promise<string>((_, reject) => {
            options?.signal?.addEventListener("abort", () => {
              reject(new Error("The operation was aborted"));
            });
          }),
      );
      const { service } = makeService({ execUpgrade });
      const events = collectEvents(service);

      const pending = service.startUpdate("curl");
      await vi.waitFor(() => expect(execUpgrade).toHaveBeenCalled());

      service.abandonUpdate();
      const result = await pending;

      expect(result).toMatchObject({
        ok: false,
        state: "available",
        error: "update abandoned",
      });
      expect(service.status).toBe("available");
      // No verify step ran after the abandonment.
      expect(mockExecFile).toHaveBeenCalledTimes(1);
      expect(events.map((event) => event.state)).toEqual([
        "updating",
        "updating",
        "updating",
        "available",
      ]);
    });

    it("abandonUpdate is safe when nothing is running", () => {
      const { service } = makeService();

      service.abandonUpdate();

      expect(service.status).toBe("idle");
    });

    it("waits out a failing in-flight check and reports its own failure", async () => {
      respondVersion(V2_0_6);
      let rejectFetch: ((error: Error) => void) | undefined;
      fetchMock.mockImplementationOnce(
        () =>
          new Promise<Response>((_, reject) => {
            rejectFetch = reject;
          }),
      );
      fetchMock.mockImplementation(() =>
        Promise.reject(new Error("network down")),
      );
      const execUpgrade = vi.fn(async () => "should not run");
      const { service } = makeService({ execUpgrade });

      const pending = service.checkForUpdates();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

      // The update click no longer rejects during the checking window:
      // it waits, the check fails, and the update then fails its own
      // target resolution without executing anything.
      const update = service.startUpdate("curl");
      rejectFetch?.(new Error("first fetch failed"));
      const [check, result] = await Promise.all([pending, update]);

      expect(check.ok).toBe(false);
      expect(result).toMatchObject({
        ok: false,
        error: "all latest-version endpoints failed",
      });
      expect(execUpgrade).not.toHaveBeenCalled();
      expect(service.status).toBe("failed");
    });

    it("streams upgrade output through onDidOutputLine", async () => {
      respondVersionSequence([V2_0_6, V2_0_7]);
      fetchMock.mockResolvedValue(jsonResponse({ version: "2.0.7" }));
      const execUpgrade = vi.fn(
        async (
          file: string,
          _args: string[],
          options?: {
            onLine?: (line: string, stream: "stdout" | "stderr") => void;
          },
        ) => {
          if (file === "opencode") {
            options?.onLine?.("added 10 packages", "stdout");
            return "upgraded";
          }
          return "ok";
        },
      );
      const { service } = makeService({ execUpgrade });
      const lines: string[] = [];
      service.onDidOutputLine((line) => lines.push(line));

      await service.startUpdate("npm");

      expect(lines).toContain("added 10 packages");
    });
  });

  describe("startInstall", () => {
    it("installs via the mapped npm command and verifies the new CLI", async () => {
      respondVersion(V2_0_7);
      const exec = vi.fn(async () => {
        throw new Error("unexpected probe");
      });
      const execUpgrade = vi.fn(async () => "installed");
      const { service } = makeService({ exec, execUpgrade });
      const events = collectEvents(service);

      const result = await service.startInstall("npm");

      expect(result).toEqual({
        ok: true,
        state: "updateSucceeded",
        installedVersion: "2.0.7",
      });
      expect(service.status).toBe("updateSucceeded");
      expect(execUpgrade).toHaveBeenCalledTimes(1);
      expect(execUpgrade).toHaveBeenCalledWith(
        "npm",
        ["install", "-g", "@opencode/cli"],
        expect.objectContaining({ timeoutMs: 10 * 60 * 1000 }),
      );
      expect(events.map((event) => [event.state, event.step])).toEqual([
        ["updating", "installing"],
        ["updating", "verify"],
        ["updateSucceeded", undefined],
      ]);
    });

    it("runs the official install script for methods without a direct command", async () => {
      respondVersion(V2_0_7);
      const execUpgrade = vi.fn(async () => "installed");
      const { service } = makeService({ execUpgrade });

      const result = await service.startInstall("source");

      expect(result.ok).toBe(true);
      if (process.platform === "win32") {
        expect(execUpgrade).toHaveBeenCalledWith(
          "powershell",
          [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "irm https://opencode.ai/install.ps1 | iex",
          ],
          expect.anything(),
        );
      } else {
        expect(execUpgrade).toHaveBeenCalledWith(
          "bash",
          ["-c", "curl -fsSL https://opencode.ai/install | bash"],
          expect.anything(),
        );
      }
    });

    it("reshims nvm-windows after an npm-family install", async () => {
      respondVersion(V2_0_7);
      const exec = vi.fn(async (file: string, args: string[]) => {
        if (file === "nvm" && args[0] === "version") {
          return "2.0.1-hotfix.2";
        }
        throw new Error(`unexpected probe: ${file}`);
      });
      const execUpgrade = vi.fn(async () => "done");
      const { service } = makeService({ exec, execUpgrade });

      const result = await service.startInstall("pnpm");

      expect(result.ok).toBe(true);
      expect(
        execUpgrade.mock.calls.map(([file, args]) => [file, ...args].join(" ")),
      ).toEqual([
        "pnpm add -g @opencode/cli",
        "nvm reshim",
        "nvm firewall trust module opencode",
      ]);
      expect(service.status).toBe("updateSucceeded");
    });

    it("skips the reshim for non-npm-family methods", async () => {
      respondVersion(V2_0_7);
      const exec = vi.fn(async () => "2.0.1-hotfix.2");
      const execUpgrade = vi.fn(async () => "done");
      const { service } = makeService({ exec, execUpgrade });

      const result = await service.startInstall("brew");

      expect(result.ok).toBe(true);
      expect(execUpgrade).toHaveBeenCalledTimes(1);
      expect(execUpgrade).toHaveBeenCalledWith(
        "brew",
        ["install", "opencode"],
        expect.anything(),
      );
    });

    it("rejects method ids outside the whitelist without touching state", async () => {
      const { service } = makeService();

      const result = await service.startInstall("npm; calc");

      expect(result).toMatchObject({ ok: false, error: "invalid method" });
      expect(service.status).toBe("idle");
    });

    it("fails with manual commands when the install command errors", async () => {
      respondVersion(V2_0_7);
      const execUpgrade = vi.fn(async () => {
        throw new Error("scoop exited with code 1");
      });
      const { service } = makeService({ execUpgrade });

      const result = await service.startInstall("scoop");

      expect(result.ok).toBe(false);
      expect(result.error).toContain("scoop exited with code 1");
      expect(result.remediationCommands).toEqual([
        "scoop install opencode",
        expect.stringMatching(/opencode\.ai\/install/),
      ]);
      expect(service.status).toBe("failed");
    });

    it("fails when verification cannot read the installed version", async () => {
      failVersion();
      const execUpgrade = vi.fn(async () => "installed");
      const { service } = makeService({ execUpgrade });

      const result = await service.startInstall("npm");

      expect(result.ok).toBe(false);
      expect(result.error).toContain("version verification failed");
      expect(result.remediationCommands).toEqual([
        expect.stringMatching(/opencode\.ai\/install/),
      ]);
      expect(service.status).toBe("failed");
    });

    it("ignores startInstall while another install is in progress", async () => {
      let resolveInstall: ((value: string) => void) | undefined;
      const execUpgrade = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveInstall = resolve;
          }),
      );
      const { service } = makeService({ execUpgrade });

      const first = service.startInstall("npm");
      const second = await service.startInstall("npm");

      expect(second).toMatchObject({
        ok: false,
        error: "update already in progress",
      });

      respondVersion(V2_0_7);
      await vi.waitFor(() => expect(execUpgrade).toHaveBeenCalledTimes(1));
      resolveInstall?.("done");
      const firstResult = await first;
      expect(firstResult.ok).toBe(true);
    });

    it("restores the installable state when the install is abandoned", async () => {
      let resolveInstall: ((value: string) => void) | undefined;
      const execUpgrade = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveInstall = resolve;
          }),
      );
      const { service } = makeService({ execUpgrade });
      service.markCliMissing();

      const pending = service.startInstall("npm");
      await vi.waitFor(() => expect(execUpgrade).toHaveBeenCalled());
      service.abandonUpdate();
      resolveInstall?.("done");
      const result = await pending;

      expect(result.ok).toBe(false);
      expect(service.status).toBe("installable");
    });

    it("waits for an in-flight check and runs the install afterwards", async () => {
      let servedHeldProbe = false;
      let held: ExecCb | undefined;
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const cb = lastArgAsCb(args);
        if (!servedHeldProbe) {
          // The check's --version probe pends until released.
          servedHeldProbe = true;
          held = cb;
          return {} as ReturnType<typeof execFile>;
        }
        cb(null, V2_0_7);
        return {} as ReturnType<typeof execFile>;
      });
      const execUpgrade = vi.fn(async () => "installed");
      const { service } = makeService({ execUpgrade });
      service.markCliMissing(false);

      const check = service.checkForUpdates({ manual: true });
      await vi.waitFor(() => expect(held).toBeDefined());

      // The install click lands inside the checking window: the service
      // must wait out the check instead of rejecting the click.
      const install = service.startInstall("npm");
      // The check's probe completes without a version (CLI missing).
      held?.(null, "");
      const [checkResult, installResult] = await Promise.all([
        check,
        install,
      ]);

      expect(checkResult).toMatchObject({ ok: true, state: "installable" });
      expect(installResult).toMatchObject({
        ok: true,
        state: "updateSucceeded",
        installedVersion: "2.0.7",
      });
      expect(service.status).toBe("updateSucceeded");
      expect(execUpgrade).toHaveBeenCalledTimes(1);
    });

    it("rejects startInstall when the flow is disabled", async () => {
      respondVersion("opencode v1.18.33\n");
      const execUpgrade = vi.fn(async () => "should not run");
      const { service } = makeService({ execUpgrade });

      await service.checkForUpdates();
      expect(service.status).toBe("disabled");

      const result = await service.startInstall("npm");

      expect(result).toMatchObject({
        ok: false,
        state: "disabled",
        error: "updates disabled for this CLI",
      });
      expect(execUpgrade).not.toHaveBeenCalled();
    });

    it("falls back to the bare name when the configured binary stops probing", async () => {
      const CUSTOM = "D:\\tools\\opencode.exe";
      let customProbes = 0;
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const cb = lastArgAsCb(args);
        const file = String(args[0]);
        if (file === CUSTOM) {
          customProbes += 1;
          cb(null, "");
          return {} as ReturnType<typeof execFile>;
        }
        cb(null, file === "opencode" ? V2_0_7 : "");
        return {} as ReturnType<typeof execFile>;
      });
      const execUpgrade = vi.fn(async () => "installed");
      const { service } = makeService({ execUpgrade, getBinary: () => CUSTOM });

      const result = await service.startInstall("npm");

      // Verification through the custom path failed; the bare-name
      // retry confirmed the install instead of reporting a false failure.
      expect(result).toMatchObject({
        ok: true,
        state: "updateSucceeded",
        installedVersion: "2.0.7",
      });
      expect(customProbes).toBe(1);
    });
  });

  describe("nvm module trust", () => {
    /** exec mock answering only the nvm-windows detection and path probes. */
    const makeNvmExec = (version = "2.0.1"): RunFn =>
      vi.fn(async (file: string, args: string[]) => {
        if (file === "nvm" && args[0] === "version") {
          return `${version}\n`;
        }
        if (file === "where") {
          return "C:\\Users\\sage\\AppData\\Roaming\\nvm\\opencode.cmd\n";
        }
        throw new Error(`unexpected probe: ${file} ${args.join(" ")}`);
      });

    it("trusts the opencode module before verification after an npm upgrade", async () => {
      respondVersionSequence([V2_0_6, V2_0_7]);
      fetchMock.mockResolvedValue(jsonResponse({ version: "2.0.7" }));
      let execFileCallsAtTrust = -1;
      const execUpgrade = vi.fn(async (file: string, args: string[]) => {
        if (file === "nvm" && args[0] === "firewall") {
          execFileCallsAtTrust = mockExecFile.mock.calls.length;
        }
        return "done";
      });
      const { service } = makeService({ exec: makeNvmExec(), execUpgrade });

      const result = await service.startUpdate("npm");

      expect(result).toEqual({
        ok: true,
        state: "updateSucceeded",
        targetVersion: "2.0.7",
        installedVersion: "2.0.7",
      });
      expect(
        execUpgrade.mock.calls.map(([file, args]) => [file, ...args].join(" ")),
      ).toEqual([
        "opencode upgrade --method npm",
        "nvm reshim",
        "nvm firewall trust module opencode",
      ]);
      // Only the prepare-local probe ran before the trust call; the
      // verify probe happens after it.
      expect(execFileCallsAtTrust).toBe(1);
    });

    it("keeps the upgrade result when the trust command fails", async () => {
      respondVersionSequence([V2_0_6, V2_0_7]);
      fetchMock.mockResolvedValue(jsonResponse({ version: "2.0.7" }));
      const execUpgrade = vi.fn(async (file: string, args: string[]) => {
        if (file === "nvm" && args[0] === "firewall") {
          throw new Error("unknown subcommand: firewall");
        }
        return "done";
      });
      const { service } = makeService({ exec: makeNvmExec(), execUpgrade });

      const result = await service.startUpdate("npm");

      expect(result).toMatchObject({ ok: true, state: "updateSucceeded" });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("nvm module trust failed"),
      );
    });

    it("offers the trust commands when verification still fails under nvm", async () => {
      // The local probe works once; the post-upgrade probe stays blocked.
      let probes = 0;
      mockExecFile.mockImplementation((...args: unknown[]) => {
        probes += 1;
        if (probes > 1) {
          lastArgAsCb(args)(new Error("spawn opencode ENOENT"), "");
        } else {
          lastArgAsCb(args)(null, V2_0_6);
        }
        return {} as ReturnType<typeof execFile>;
      });
      fetchMock.mockResolvedValue(jsonResponse({ version: "2.0.7" }));
      const execUpgrade = vi.fn(async () => "done");
      const { service } = makeService({ exec: makeNvmExec(), execUpgrade });

      const result = await service.startUpdate("npm");

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/version verification failed/);
      expect(result.remediationCommands).toEqual([
        "nvm firewall trust module opencode",
        "nvm reshim",
      ]);
    });

    it("also trusts opencode after the NVM4306 remediation re-run", async () => {
      respondVersionSequence([V2_0_6, V2_0_7]);
      fetchMock.mockResolvedValue(jsonResponse({ version: "2.0.7" }));
      let upgradeRuns = 0;
      const execUpgrade = vi.fn(
        async (
          file: string,
          args: string[],
          options?: {
            onLine?: (line: string, stream: "stdout" | "stderr") => void;
          },
        ) => {
          if (file === "opencode") {
            upgradeRuns += 1;
            if (upgradeRuns === 1) {
              for (const line of BLOCKED_OUTPUT) {
                options?.onLine?.(line, "stdout");
              }
              throw new Error("opencode exited with code 1");
            }
            return "upgraded";
          }
          return "ok";
        },
      );
      const { service } = makeService({ exec: makeNvmExec(), execUpgrade });

      const result = await service.startUpdate("npm");

      expect(result.ok).toBe(true);
      // The remediation trust belongs to the blocked first run; the
      // module re-trust must still run after the second upgrade.
      expect(
        execUpgrade.mock.calls.map(([file, args]) => [file, ...args].join(" ")),
      ).toEqual([
        "opencode upgrade --method npm",
        "nvm firewall trust module opencode",
        "nvm reshim",
        "opencode upgrade --method npm",
        "nvm firewall trust module opencode",
      ]);
    });

    it("trusts the opencode module after an npm-family install", async () => {
      respondVersion(V2_0_7);
      const execUpgrade = vi.fn(async () => "done");
      const { service } = makeService({ exec: makeNvmExec(), execUpgrade });

      const result = await service.startInstall("npm");

      expect(result).toEqual({
        ok: true,
        state: "updateSucceeded",
        installedVersion: "2.0.7",
      });
      expect(
        execUpgrade.mock.calls.map(([file, args]) => [file, ...args].join(" ")),
      ).toEqual([
        "npm install -g @opencode/cli",
        "nvm reshim",
        "nvm firewall trust module opencode",
      ]);
    });

    it("adds the trust commands to a failed install verification", async () => {
      failVersion();
      const execUpgrade = vi.fn(async () => "done");
      const { service } = makeService({ exec: makeNvmExec(), execUpgrade });

      const result = await service.startInstall("npm");

      expect(result.ok).toBe(false);
      expect(result.error).toContain("version verification failed");
      expect(result.remediationCommands).toEqual([
        "nvm firewall trust module opencode",
        "nvm reshim",
        expect.stringMatching(/opencode\.ai\/install/),
      ]);
    });

    it("self-heals a firewall-blocked probe during a check", async () => {
      let healed = false;
      mockExecFile.mockImplementation((...args: unknown[]) => {
        if (!healed) {
          lastArgAsCb(args)(new Error("spawn opencode ENOENT"), "");
        } else {
          lastArgAsCb(args)(null, "opencode v2.0.29\n");
        }
        return {} as ReturnType<typeof execFile>;
      });
      fetchMock.mockResolvedValue(jsonResponse({ version: "2.0.29" }));
      const execUpgrade = vi.fn(async () => {
        healed = true;
        return "trusted";
      });
      const { service } = makeService({ exec: makeNvmExec(), execUpgrade });

      const result = await service.checkForUpdates();

      expect(result).toEqual({
        ok: true,
        state: "upToDate",
        current: "2.0.29",
        latest: "2.0.29",
      });
      expect(service.status).toBe("upToDate");
      expect(execUpgrade).toHaveBeenCalledWith(
        "nvm",
        ["firewall", "trust", "module", "opencode"],
        expect.objectContaining({ timeoutMs: 60_000 }),
      );
    });

    it("keeps the disabled verdict when the self-heal trust fails", async () => {
      failVersion();
      const execUpgrade = vi.fn(async () => {
        throw new Error("firewall subcommand missing");
      });
      const { service } = makeService({ exec: makeNvmExec(), execUpgrade });

      const result = await service.checkForUpdates();

      expect(result).toEqual({ ok: true, state: "disabled" });
      expect(service.status).toBe("disabled");
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("nvm module trust failed"),
      );
    });

    it("skips the module trust for non-nvm-family methods", async () => {
      respondVersionSequence([V2_0_6, V2_0_7]);
      fetchMock.mockResolvedValue(jsonResponse({ version: "2.0.7" }));
      const execUpgrade = vi.fn(async () => "done");
      const { service } = makeService({ exec: makeNvmExec(), execUpgrade });

      const result = await service.startUpdate("curl");

      expect(result.ok).toBe(true);
      expect(
        execUpgrade.mock.calls.some(([file]) => file === "nvm"),
      ).toBe(false);
    });
  });

  describe("markCliMissing", () => {
    it("enters the installable state with the fixed method list and a pending prompt", () => {
      const { service } = makeService();
      const events = collectEvents(service);

      service.markCliMissing();

      expect(service.status).toBe("installable");
      expect(events).toEqual([
        {
          state: "installable",
          methods: [
            "npm",
            "pnpm",
            "yarn",
            "bun",
            "brew",
            "scoop",
            "choco",
            "curl",
          ],
          defaultMethod: "npm",
          installPromptPending: true,
        },
      ]);
    });

    it("arms no prompt when told the dismissal is remembered", () => {
      const { service } = makeService();
      const events = collectEvents(service);

      service.markCliMissing(false);

      expect(events.at(-1)).toMatchObject({ installPromptPending: false });
    });

    it("preselects the persisted last-used method", () => {
      const { service } = makeService({
        store: createStore({ "opencodeUpdate.lastMethod": "pnpm" }),
      });
      const events = collectEvents(service);

      service.markCliMissing();

      expect(events.at(-1)).toMatchObject({ defaultMethod: "pnpm" });
    });

    it("does not overwrite an active or resolved flow state", async () => {
      respondVersion(V2_0_6);
      fetchMock.mockResolvedValue(jsonResponse({ version: "2.0.7" }));
      const { service } = makeService();
      await service.checkForUpdates();
      expect(service.status).toBe("available");

      service.markCliMissing();

      expect(service.status).toBe("available");
    });

    it("keeps the installable state when a check finds no CLI", async () => {
      failVersion();
      const { service } = makeService();
      service.markCliMissing(false);
      const events = collectEvents(service);
      const eventCount = events.length;

      const result = await service.checkForUpdates();

      expect(result).toEqual({ ok: true, state: "installable" });
      expect(service.status).toBe("installable");
      expect(events.length).toBeGreaterThan(eventCount);
    });
  });

  describe("clearInstallPrompt", () => {
    it("re-announces installable without the pending flag, exactly once", () => {
      const { service } = makeService();
      service.markCliMissing();
      const events = collectEvents(service);
      const marked = events.length;

      service.clearInstallPrompt();

      expect(events.length).toBe(marked + 1);
      expect(events.at(-1)).toMatchObject({
        state: "installable",
        installPromptPending: false,
      });
      expect(service.status).toBe("installable");

      // Idempotent: no further events once the flag is cleared.
      service.clearInstallPrompt();
      expect(events.length).toBe(marked + 1);
    });

    it("never fires when no prompt is pending", () => {
      const { service } = makeService();
      const events = collectEvents(service);

      service.clearInstallPrompt();

      expect(events).toEqual([]);
    });

    it("only clears the flag silently once the flow moved on", async () => {
      respondVersion(V2_0_7);
      let resolveInstall: ((value: string) => void) | undefined;
      const execUpgrade = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveInstall = resolve;
          }),
      );
      const { service } = makeService({ execUpgrade });
      service.markCliMissing();
      const pending = service.startInstall("npm");
      await vi.waitFor(() => expect(execUpgrade).toHaveBeenCalled());
      expect(service.status).toBe("updating");

      const events = collectEvents(service);
      service.clearInstallPrompt();
      expect(events).toEqual([]);

      service.abandonUpdate();
      resolveInstall?.("done");
      await pending;
      expect(service.status).toBe("installable");
    });
  });

  describe("getDefaultMethodForUi", () => {
    function makeExecWithHelp(help: string | Error): RunFn {
      return async (file: string, args: string[]) => {
        if (args[0] === "upgrade") {
          if (help instanceof Error) {
            throw help;
          }
          return help;
        }
        if (file === "npm") {
          return "@opencode/cli@2.0.20";
        }
        throw new Error("not installed");
      };
    }

    it("prefers the persisted last method when still offered", async () => {
      const { store, service } = makeService({
        store: createStore({ "opencodeUpdate.lastMethod": "curl" }),
        exec: makeExecWithHelp(HELP_WITH_CHOICES),
      });

      await expect(service.getDefaultMethodForUi()).resolves.toBe("curl");
      expect(store.get).toHaveBeenCalledWith("opencodeUpdate.lastMethod");
    });

    it("uses the detected method when no last method is persisted", async () => {
      const { service } = makeService({
        exec: makeExecWithHelp(HELP_WITH_CHOICES),
      });

      await expect(service.getDefaultMethodForUi()).resolves.toBe("npm");
    });

    it("caches upgrade choices per binary", async () => {
      const exec = vi.fn(makeExecWithHelp(HELP_WITH_CHOICES));
      const { service } = makeService({ exec });

      await service.getDefaultMethodForUi();
      await service.getDefaultMethodForUi();

      const helpCalls = exec.mock.calls.filter(
        ([, args]) => args[0] === "upgrade",
      );
      expect(helpCalls).toHaveLength(1);
    });

    it("falls back to the last method when choices cannot be parsed", async () => {
      const { service } = makeService({
        store: createStore({ "opencodeUpdate.lastMethod": "scoop" }),
        exec: makeExecWithHelp("no choices in this output"),
      });

      await expect(service.getDefaultMethodForUi()).resolves.toBe("scoop");
    });

    it("falls back to npm when the help probe fails and nothing is detected", async () => {
      const exec: RunFn = async () => {
        throw new Error("nothing works");
      };
      const { service } = makeService({ exec });

      await expect(service.getDefaultMethodForUi()).resolves.toBe("npm");
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining("upgrade help probe failed"),
      );
    });

    it("resolves the absolute binary path so curl installs detect correctly", async () => {
      // Path lookup uses `where` on win32 (the test host platform).
      const curlPath = "C:\\Users\\sage\\.opencode\\bin\\opencode.exe";
      const exec = vi.fn(async (file: string, args: string[]) => {
        if (file === "where" && args[0] === "opencode") {
          return `${curlPath}\r\n`;
        }
        if (args[0] === "upgrade") {
          return HELP_WITH_CHOICES;
        }
        throw new Error(`unexpected probe: ${file} ${args.join(" ")}`);
      });
      const { service } = makeService({ exec });

      const details = await service.getUpgradeMethodDetails();

      expect(details.detectedMethod).toBe("curl");
      // Path heuristics matched; no package-manager probes ran.
      expect(exec.mock.calls.some(([file]) => file === "npm")).toBe(false);

      // The resolved path is cached per binary.
      await service.getUpgradeMethodDetails();
      expect(exec.mock.calls.filter(([file]) => file === "where")).toHaveLength(
        1,
      );
    });

    it("falls back to the bare name when the path lookup fails", async () => {
      const exec = vi.fn(async (file: string, args: string[]) => {
        if (file === "where") {
          throw new Error("not found");
        }
        if (args[0] === "upgrade") {
          return HELP_WITH_CHOICES;
        }
        if (file === "npm") {
          return "@opencode/cli@2.0.20";
        }
        throw new Error("not installed");
      });
      const { service } = makeService({ exec });

      const details = await service.getUpgradeMethodDetails();

      expect(details.detectedMethod).toBe("npm");
    });
  });

  describe("setLastMethod", () => {
    it("persists the method for future preselection", async () => {
      const { store, service } = makeService({
        exec: makeServiceHelpExec(),
      });

      await service.setLastMethod("pnpm");

      expect(store.update).toHaveBeenCalledWith(
        "opencodeUpdate.lastMethod",
        "pnpm",
      );
      await expect(service.getDefaultMethodForUi()).resolves.toBe("pnpm");
    });
  });

  describe("getOpenCodeUpdateConfig", () => {
    it("returns the defaults when unset", () => {
      expect(getOpenCodeUpdateConfig()).toEqual({
        autoCheck: true,
        checkIntervalHours: 24,
      });
    });

    it("reads configured update settings", () => {
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValueOnce({
        get: vi.fn((key: string, defaultValue?: unknown) => {
          if (key === "update.autoCheck") {
            return false;
          }
          if (key === "update.checkIntervalHours") {
            return 6;
          }
          return defaultValue;
        }),
      } as unknown as ReturnType<typeof vscode.workspace.getConfiguration>);

      expect(getOpenCodeUpdateConfig()).toEqual({
        autoCheck: false,
        checkIntervalHours: 6,
      });
    });
  });

  it("constructs with default options", () => {
    const store = createStore();
    const service = new OpenCodeUpdateService(store);
    expect(service.status).toBe("idle");
    service.dispose();
  });
});

function makeServiceHelpExec(): RunFn {
  return async (file: string, args: string[]) => {
    if (args[0] === "upgrade") {
      return HELP_WITH_CHOICES;
    }
    if (file === "pnpm") {
      return "@opencode/cli 2.0.20";
    }
    throw new Error("not installed");
  };
}
