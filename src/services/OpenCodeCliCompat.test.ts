import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  buildOpenCodeHttpPortArg,
  buildOpenCodeV2AuthHeader,
  __setOpenCodeVersionClockForTests,
  __setWindowsShellRetryForTests,
  detectOpenCodeApiProtocol,
  detectOpenCodeMajorVersion,
  extractCliBinary,
  commandBypassesSharedService,
  getOpenCodeVersion,
  OPENCODE_VERSION_CACHE_TTL_MS,
  parseOpenCodeFullVersion,
  parseOpenCodeMajorVersion,
  peekOpenCodeVersion,
  peekOpenCodeVersionProbe,
  protocolForMajorVersion,
  resetOpenCodeCliCompatCaches,
  resetOpenCodeCliVersionCaches,
  resolveOpenCodeV2Service,
  runOpenCodeCliCommand,
  readOutputLines,
  sanitizeOutputLine,
  streamOpenCodeCliCommand,
  toCmdShellCommand,
  setOpenCodeCliCompatDiagnostics,
} from "./OpenCodeCliCompat";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: vi.fn(),
    existsSync: vi.fn(),
  };
});

const mockExecFile = vi.mocked(execFile);
const mockSpawn = vi.mocked(spawn);
const mockReadFileSync = vi.mocked(fs.readFileSync);

interface FakeStream extends EventEmitter {
  setEncoding: ReturnType<typeof vi.fn>;
}

function fakeStream(): FakeStream {
  const stream = new EventEmitter() as FakeStream;
  stream.setEncoding = vi.fn();
  return stream;
}

interface FakeChild extends EventEmitter {
  stdout: FakeStream;
  stderr: FakeStream;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = fakeStream();
  child.stderr = fakeStream();
  return child;
}

const asChildProcess = (child: FakeChild): ChildProcess =>
  child as unknown as ChildProcess;

describe("OpenCodeCliCompat", () => {
  beforeEach(() => {
    resetOpenCodeCliCompatCaches();
    vi.clearAllMocks();
  });

  describe("toCmdShellCommand", () => {
    it("passes plain tokens through unchanged", () => {
      expect(
        toCmdShellCommand("opencode", ["upgrade", "--method", "npm"]),
      ).toBe("opencode upgrade --method npm");
    });

    it("quotes file and args containing whitespace", () => {
      expect(
        toCmdShellCommand("C:\\Program Files\\opencode\\oc.exe", ["run me"]),
      ).toBe('"C:\\Program Files\\opencode\\oc.exe" "run me"');
    });

    it("quotes args containing cmd metacharacters", () => {
      expect(toCmdShellCommand("opencode", ["a&b", "x=y", "p|q", "(v)", "^c"])).toBe(
        'opencode "a&b" "x=y" "p|q" "(v)" "^c"',
      );
    });

    it("doubles inner double quotes inside quoted parts", () => {
      expect(toCmdShellCommand("opencode", ['say "hi"'])).toBe(
        'opencode "say ""hi"""',
      );
    });
  });

  describe("extractCliBinary", () => {
    it("extracts bare and quoted binaries", () => {
      expect(extractCliBinary("opencode -c")).toBe("opencode");
      expect(extractCliBinary('"/opt/bin/opencode" --headless')).toBe(
        "/opt/bin/opencode",
      );
      expect(extractCliBinary("'/opt/bin/opencode' -c")).toBe(
        "/opt/bin/opencode",
      );
      expect(extractCliBinary("")).toBe("opencode");
    });
  });

  describe("commandBypassesSharedService", () => {
    it("detects --standalone and --server flags as standalone tokens", () => {
      expect(commandBypassesSharedService("opencode --standalone")).toBe(true);
      expect(commandBypassesSharedService("opencode --standalone -c")).toBe(
        true,
      );
      expect(
        commandBypassesSharedService('"/opt/bin/opencode" --standalone'),
      ).toBe(true);
      expect(commandBypassesSharedService("opencode --server http://x:1")).toBe(
        true,
      );
      expect(
        commandBypassesSharedService("opencode --server=http://x:1"),
      ).toBe(true);
    });

    it("ignores similar-looking flags and plain commands", () => {
      expect(commandBypassesSharedService("opencode")).toBe(false);
      expect(commandBypassesSharedService("opencode -c")).toBe(false);
      expect(commandBypassesSharedService("opencode --standalone-foo")).toBe(
        false,
      );
      expect(
        commandBypassesSharedService("opencode --server-port 4096"),
      ).toBe(false);
      expect(
        commandBypassesSharedService('"/opt/bin/opencode-standalone"'),
      ).toBe(false);
      expect(commandBypassesSharedService("")).toBe(false);
    });
  });

  describe("parseOpenCodeMajorVersion", () => {
    it("parses common version strings", () => {
      expect(parseOpenCodeMajorVersion("opencode v2.0.6")).toBe(2);
      expect(parseOpenCodeMajorVersion("2.0.6")).toBe(2);
      expect(parseOpenCodeMajorVersion("opencode/1.18.0")).toBe(1);
      expect(parseOpenCodeMajorVersion("1.17.11")).toBe(1);
      expect(parseOpenCodeMajorVersion("not a version")).toBeUndefined();
    });

    it("skips shim banner noise line by line", () => {
      expect(parseOpenCodeMajorVersion("\u2829 v20.20.2\nopencode v2.0.16\n")).toBe(2);
      expect(parseOpenCodeMajorVersion("node v20.20.2\n2.0.16\n")).toBe(2);
      expect(parseOpenCodeMajorVersion("OpenCode v2.0.16 (bun)")).toBe(2);
    });
  });

  describe("parseOpenCodeFullVersion", () => {
    it("extracts full versions from common output shapes", () => {
      expect(parseOpenCodeFullVersion("1.18.33\n")).toBe("1.18.33");
      expect(parseOpenCodeFullVersion("opencode v2.0.6")).toBe("2.0.6");
      expect(parseOpenCodeFullVersion("opencode/1.18.0")).toBe("1.18.0");
      expect(parseOpenCodeFullVersion("OpenCode v2.0.16 (bun)")).toBe(
        "2.0.16",
      );
      expect(parseOpenCodeFullVersion("v1.18.9")).toBe("1.18.9");
      expect(parseOpenCodeFullVersion("2.0.6-beta.1")).toBe("2.0.6-beta.1");
    });

    it("returns non-version output verbatim", () => {
      expect(parseOpenCodeFullVersion("local")).toBe("local");
      expect(parseOpenCodeFullVersion("")).toBeUndefined();
    });

    it("skips shim banner noise line by line", () => {
      expect(parseOpenCodeFullVersion("⠩ v20.20.2\n2.0.16\n")).toBe("2.0.16");
      expect(parseOpenCodeFullVersion("node v20.20.2\nopencode v2.0.16\n")).toBe(
        "2.0.16",
      );
    });
  });

  describe("getOpenCodeVersion", () => {
    type ExecCb = (error: Error | null, stdout: string) => void;
    const lastArgAsCb = (args: unknown[]): ExecCb =>
      args[args.length - 1] as ExecCb;

    it("returns the full version and caches per binary", async () => {
      mockExecFile.mockImplementation((...args: unknown[]) => {
        lastArgAsCb(args)(null, "1.18.33\n");
        return {} as ReturnType<typeof execFile>;
      });

      await expect(getOpenCodeVersion("opencode")).resolves.toBe("1.18.33");
      await expect(getOpenCodeVersion("opencode")).resolves.toBe("1.18.33");
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    it("returns dev build output verbatim", async () => {
      mockExecFile.mockImplementation((...args: unknown[]) => {
        lastArgAsCb(args)(null, "local\n");
        return {} as ReturnType<typeof execFile>;
      });

      await expect(getOpenCodeVersion("opencode")).resolves.toBe("local");
    });

    it("returns undefined when the version command fails", async () => {
      __setWindowsShellRetryForTests(false);
      mockExecFile.mockImplementation((...args: unknown[]) => {
        lastArgAsCb(args)(new Error("nope"), "");
        return {} as ReturnType<typeof execFile>;
      });

      await expect(getOpenCodeVersion("missing-bin")).resolves.toBeUndefined();
    });

    it("clears the cache through resetOpenCodeCliCompatCaches", async () => {
      mockExecFile.mockImplementation((...args: unknown[]) => {
        lastArgAsCb(args)(null, "2.0.6\n");
        return {} as ReturnType<typeof execFile>;
      });

      await getOpenCodeVersion("opencode");
      resetOpenCodeCliCompatCaches();
      await getOpenCodeVersion("opencode");
      expect(mockExecFile).toHaveBeenCalledTimes(2);
    });
  });

  describe("version cache TTL", () => {
    type ExecCb = (error: Error | null, stdout: string) => void;
    const lastArgAsCb = (args: unknown[]): ExecCb =>
      args[args.length - 1] as ExecCb;

    it("re-probes after the TTL expires but not within it", async () => {
      let clock = 1_000;
      __setOpenCodeVersionClockForTests(() => clock);
      mockExecFile.mockImplementation((...args: unknown[]) => {
        lastArgAsCb(args)(null, "2.0.6\n");
        return {} as ReturnType<typeof execFile>;
      });

      await expect(getOpenCodeVersion("opencode")).resolves.toBe("2.0.6");

      clock += 1_000;
      await expect(getOpenCodeVersion("opencode")).resolves.toBe("2.0.6");
      expect(mockExecFile).toHaveBeenCalledTimes(1);

      clock += OPENCODE_VERSION_CACHE_TTL_MS;
      await expect(getOpenCodeVersion("opencode")).resolves.toBe("2.0.6");
      expect(mockExecFile).toHaveBeenCalledTimes(2);
    });

    it("expires the major cache and the peek after the TTL", async () => {
      let clock = 0;
      __setOpenCodeVersionClockForTests(() => clock);
      mockExecFile.mockImplementation((...args: unknown[]) => {
        lastArgAsCb(args)(null, "opencode v2.0.6\n");
        return {} as ReturnType<typeof execFile>;
      });

      await expect(detectOpenCodeMajorVersion("opencode")).resolves.toBe(2);
      expect(peekOpenCodeVersion("opencode")).toBe("2.0.6");

      clock += OPENCODE_VERSION_CACHE_TTL_MS + 1;
      expect(peekOpenCodeVersion("opencode")).toBeUndefined();

      // The expired major counts as a miss and re-probes the new major.
      mockExecFile.mockImplementation((...args: unknown[]) => {
        lastArgAsCb(args)(null, "opencode v1.18.9\n");
        return {} as ReturnType<typeof execFile>;
      });
      await expect(detectOpenCodeMajorVersion("opencode")).resolves.toBe(1);
      expect(mockExecFile).toHaveBeenCalledTimes(2);
    });

    it("drops the cached protocol for a binary after a fresh version probe", async () => {
      let clock = 0;
      __setOpenCodeVersionClockForTests(() => clock);
      mockExecFile.mockImplementation((...args: unknown[]) => {
        lastArgAsCb(args)(null, "opencode v1.18.9\n");
        return {} as ReturnType<typeof execFile>;
      });

      await expect(detectOpenCodeApiProtocol("opencode")).resolves.toBe("v1");

      // External upgrade to v2: once the version cache expires, the fresh
      // probe must also invalidate the cached v1 protocol decision.
      clock += OPENCODE_VERSION_CACHE_TTL_MS + 1;
      mockExecFile.mockImplementation((...args: unknown[]) => {
        lastArgAsCb(args)(null, "opencode v2.0.6\n");
        return {} as ReturnType<typeof execFile>;
      });
      await expect(getOpenCodeVersion("opencode")).resolves.toBe("2.0.6");
      await expect(detectOpenCodeApiProtocol("opencode")).resolves.toBe("v2");
      expect(mockExecFile).toHaveBeenCalledTimes(2);
    });
  });

  describe("in-flight probe reset race", () => {
    type ExecCb = (error: Error | null, stdout: string) => void;
    const lastArgAsCb = (args: unknown[]): ExecCb =>
      args[args.length - 1] as ExecCb;

    it("discards a superseded in-flight probe without touching the successor", async () => {
      const callbacks: ExecCb[] = [];
      mockExecFile.mockImplementation((...args: unknown[]) => {
        callbacks.push(lastArgAsCb(args));
        return {} as ReturnType<typeof execFile>;
      });

      const first = getOpenCodeVersion("opencode");
      // A cross-window sync / update check resets while the first probe
      // is still in flight, so a second probe is spawned and registered.
      resetOpenCodeCliVersionCaches();
      const second = getOpenCodeVersion("opencode");
      expect(callbacks).toHaveLength(2);

      // The stale probe completes: no cache write, no slot delete.
      callbacks[0](null, "2.0.6\n");
      await expect(first).resolves.toBe("2.0.6");
      expect(peekOpenCodeVersion("opencode")).toBeUndefined();
      expect(peekOpenCodeVersionProbe("opencode")).toBeDefined();

      // The successor completes and owns the cache.
      callbacks[1](null, "2.0.7\n");
      await expect(second).resolves.toBe("2.0.7");
      expect(peekOpenCodeVersion("opencode")).toBe("2.0.7");
    });
  });

  describe("runOpenCodeCliCommand", () => {
    type ExecCb = (error: Error | null, stdout: string) => void;
    const lastArgAsCb = (args: unknown[]): ExecCb =>
      args[args.length - 1] as ExecCb;

    it("resolves with stdout on success", async () => {
      __setWindowsShellRetryForTests(false);
      mockExecFile.mockImplementation((...args: unknown[]) => {
        lastArgAsCb(args)(null, "2.0.6\n");
        return {} as ReturnType<typeof execFile>;
      });

      await expect(
        runOpenCodeCliCommand("opencode", ["--version"]),
      ).resolves.toBe("2.0.6\n");
    });

    it("rejects when the command fails", async () => {
      __setWindowsShellRetryForTests(false);
      mockExecFile.mockImplementation((...args: unknown[]) => {
        lastArgAsCb(args)(new Error("spawn failed"), "");
        return {} as ReturnType<typeof execFile>;
      });

      await expect(
        runOpenCodeCliCommand("opencode", ["--version"]),
      ).rejects.toThrow("spawn failed");
    });
  });

  describe("streamOpenCodeCliCommand", () => {
    it("collapses in-place spinner redraws into one line", () => {
      const out = readOutputLines(
        "",
        "T  Upgrade\n│\n•  Using method: npm\n│\n" +
          "\u001b[1G•  Upgradingo\u001b[2K\u001b[1G•  UpgradingO\u001b[1G•  Upgrade complete\n",
      );

      expect(out.lines).toEqual([
        "T  Upgrade",
        "│",
        "•  Using method: npm",
        "│",
        "•  Upgrade complete",
      ]);
      expect(out.carry).toBe("");
    });

    it("keeps a partially received escape sequence for the next chunk", () => {
      const first = readOutputLines("", "step \u001b[3");
      expect(first.lines).toEqual([]);
      expect(first.carry).toBe("step \u001b[3");

      const second = readOutputLines(first.carry, "5mok\u001b[0m\n");
      expect(second.lines).toEqual(["step ok"]);
    });

    it("collapses clack spinner frames that repaint with cursor.to + erase.down", () => {
      const frame = (glyph: string, text: string) =>
        `\u001b[35m${glyph}\u001b[39m  ${text}`;
      const repaint = "\u001b[1G\u001b[J";
      const out = readOutputLines(
        "",
        "\u001b[90m│\u001b[39m\n" +
          frame("◒", "Upgrading") +
          repaint +
          frame("◐", "Upgrading.") +
          repaint +
          frame("◓", "Upgrading..") +
          repaint +
          `\u001b[32m◇\u001b[39m  Upgrade complete\n`,
      );

      expect(out.lines).toEqual(["│", "◇  Upgrade complete"]);
    });

    it("keeps the text before an erase-to-end-of-line sequence", () => {
      const out = readOutputLines("", "added 12 packages\u001b[K\n");

      expect(out.lines).toEqual(["added 12 packages"]);
    });

    it("collapses backspace-erased spinner frames", () => {
      const first = "◒  Upgrading";
      const erase = "\b".repeat(first.length);
      const out = readOutputLines(
        "",
        `${first}${erase}◐  Upgrading${erase}◇  Upgrade complete\n`,
      );

      expect(out.lines).toEqual(["◇  Upgrade complete"]);
    });

    it("honours cursor-left moves when a frame is shorter than the last", () => {
      const out = readOutputLines(
        "",
        "◑  Upgrading...\u001b[16D◇  Done\n",
      );

      expect(out.lines).toEqual(["◇  Done"]);
    });

    it("collapses spinner frames that arrive across chunk boundaries", async () => {
      __setWindowsShellRetryForTests(false);
      const child = fakeChild();
      mockSpawn.mockImplementation(() => asChildProcess(child));
      const lines: string[] = [];

      const pending = streamOpenCodeCliCommand("opencode", ["upgrade"], {
        onLine: (line) => lines.push(line),
      });
      const repaint = "\u001b[1G\u001b[J";
      child.stdout.emit("data", "\u001b[35m◒\u001b[39m  Upgrading");
      child.stdout.emit("data", `${repaint}\u001b[35m◐\u001b[39m  Upgrading.`);
      // 转义序列被切断在 chunk 边界上
      child.stdout.emit("data", "\u001b[1G\u001b[");
      child.stdout.emit("data", "J\u001b[32m◇\u001b[39m  Upgrade complete\n");
      child.emit("close", 0);

      await pending;

      expect(lines).toEqual(["◇  Upgrade complete"]);
    });

    it("strips ANSI escapes and progress rewrites from streamed lines", async () => {
      __setWindowsShellRetryForTests(false);
      const child = fakeChild();
      mockSpawn.mockImplementation(() => asChildProcess(child));
      const lines: string[] = [];

      const pending = streamOpenCodeCliCommand("opencode", ["upgrade"], {
        timeoutMs: 1000,
        onLine: (line) => lines.push(line),
      });
      child.stdout.emit(
        "data",
        "\u001b[?9001h\u001b[?25l\u001b[35mUpgrading…\u001b[0m\u001b[?25h\n",
      );
      child.stdout.emit("data", "0%\r50%\r\u001b[32mUpgrade complete\u001b[0m\n");
      // spinner 逐帧原行重写：只应留下最后一帧的内容
      child.stdout.emit(
        "data",
        "\u001b[1GUpgradingo\u001b[1GUpgradingO\u001b[1GUpgrade complete\n",
      );
      child.emit("close", 0);

      await pending;

      expect(lines).toEqual([
        "Upgrading…",
        "Upgrade complete",
        "Upgrade complete",
      ]);
    });

    it("streams stdout and stderr lines and resolves with stdout", async () => {
      __setWindowsShellRetryForTests(false);
      const child = fakeChild();
      mockSpawn.mockImplementation(() => asChildProcess(child));
      const lines: Array<[string, string]> = [];

      const pending = streamOpenCodeCliCommand("opencode", ["upgrade"], {
        timeoutMs: 1000,
        onLine: (line, stream) => lines.push([line, stream]),
      });
      child.stdout.emit("data", "downloa");
      child.stdout.emit("data", "ding\nhalf ");
      child.stderr.emit("data", "warn line\n");
      child.stdout.emit("data", "done\ntail without newline");
      child.emit("close", 0);

      await expect(pending).resolves.toBe(
        "downloading\nhalf done\ntail without newline",
      );
      expect(lines).toEqual([
        ["downloading", "stdout"],
        ["warn line", "stderr"],
        ["half done", "stdout"],
        ["tail without newline", "stdout"],
      ]);
    });

    it("rejects on non-zero exit while keeping delivered lines", async () => {
      __setWindowsShellRetryForTests(false);
      const child = fakeChild();
      mockSpawn.mockImplementation(() => asChildProcess(child));
      const lines: string[] = [];

      const pending = streamOpenCodeCliCommand("opencode", ["upgrade"], {
        onLine: (line) => lines.push(line),
      });
      child.stdout.emit("data", "step one\n");
      child.emit("close", 1);

      await expect(pending).rejects.toThrow("opencode exited with code 1");
      expect(lines).toEqual(["step one"]);
    });

    it("rejects when the child errors", async () => {
      __setWindowsShellRetryForTests(false);
      const child = fakeChild();
      mockSpawn.mockImplementation(() => asChildProcess(child));

      const pending = streamOpenCodeCliCommand("opencode", ["upgrade"], {});
      child.emit("error", new Error("spawn ENOENT"));

      await expect(pending).rejects.toThrow("spawn ENOENT");
    });

    it("retries through cmd.exe when the direct spawn fails on Windows", async () => {
      __setWindowsShellRetryForTests(true);
      const direct = fakeChild();
      const viaShell = fakeChild();
      mockSpawn.mockImplementation((file: string) =>
        asChildProcess(file === "cmd.exe" ? viaShell : direct),
      );
      const lines: string[] = [];

      const pending = streamOpenCodeCliCommand("opencode", ["--version"], {
        onLine: (line) => lines.push(line),
      });
      direct.emit(
        "error",
        Object.assign(new Error("spawn opencode EINVAL"), { code: "EINVAL" }),
      );
      // Let the retry spawn attach its listeners before driving its output.
      await Promise.resolve();
      await Promise.resolve();
      viaShell.stdout.emit("data", "2.0.6\n");
      viaShell.emit("close", 0);

      await expect(pending).resolves.toBe("2.0.6\n");
      expect(lines).toEqual(["2.0.6"]);
      expect(mockSpawn).toHaveBeenLastCalledWith(
        "cmd.exe",
        ["/d", "/s", "/c", '"opencode --version"'],
        expect.objectContaining({ windowsVerbatimArguments: true }),
      );
    });

    it("does not re-run a partially executed command through cmd.exe", async () => {
      __setWindowsShellRetryForTests(true);
      const child = fakeChild();
      mockSpawn.mockImplementation(() => asChildProcess(child));

      const pending = streamOpenCodeCliCommand("opencode", ["upgrade"], {});
      child.stdout.emit("data", "working\n");
      child.emit("error", new Error("killed mid-run"));

      await expect(pending).rejects.toThrow("killed mid-run");
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it("rejects with the abort error and skips the shell retry", async () => {
      __setWindowsShellRetryForTests(true);
      const child = fakeChild();
      mockSpawn.mockImplementation(() => asChildProcess(child));
      const controller = new AbortController();

      const pending = streamOpenCodeCliCommand("opencode", ["upgrade"], {
        signal: controller.signal,
      });
      controller.abort();
      child.emit("error", new Error("The operation was aborted"));

      await expect(pending).rejects.toThrow("The operation was aborted");
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it("rejects when spawn throws synchronously", async () => {
      __setWindowsShellRetryForTests(false);
      mockSpawn.mockImplementation(() => {
        throw new Error("spawn EINVAL");
      });

      await expect(
        streamOpenCodeCliCommand("opencode", ["--version"]),
      ).rejects.toThrow("spawn EINVAL");
    });
  });

  describe("resetOpenCodeCliVersionCaches", () => {
    type ExecCb = (error: Error | null, stdout: string) => void;
    const lastArgAsCb = (args: unknown[]): ExecCb =>
      args[args.length - 1] as ExecCb;

    it("clears version caches while keeping the diagnostics sink", async () => {
      const lines: Array<[string, string]> = [];
      setOpenCodeCliCompatDiagnostics((level, message) => {
        lines.push([level, message]);
      });
      mockExecFile.mockImplementation((...args: unknown[]) => {
        lastArgAsCb(args)(null, "opencode v2.0.6\n");
        return {} as ReturnType<typeof execFile>;
      });

      await getOpenCodeVersion("opencode");
      await getOpenCodeVersion("opencode");
      expect(mockExecFile).toHaveBeenCalledTimes(1);

      resetOpenCodeCliVersionCaches();
      await getOpenCodeVersion("opencode");
      expect(mockExecFile).toHaveBeenCalledTimes(2);

      // The diagnostics sink survives the cache-only reset.
      expect(
        lines.some(
          ([, message]) =>
            message.includes("full version probe") &&
            message.includes("2.0.6"),
        ),
      ).toBe(true);
    });

    it("keeps the Windows shell-retry override intact", async () => {
      __setWindowsShellRetryForTests(false);
      resetOpenCodeCliVersionCaches();
      mockExecFile.mockImplementation((...args: unknown[]) => {
        lastArgAsCb(args)(new Error("spawn opencode ENOENT"), "");
        return {} as ReturnType<typeof execFile>;
      });

      await expect(detectOpenCodeMajorVersion("opencode")).resolves.toBeUndefined();
      // The disabled shell retry was not reset to the platform default.
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });
  });

  describe("buildOpenCodeHttpPortArg", () => {
    it("emits --port=N only for a confirmed v1; omits it for v2 and unknown", () => {
      expect(buildOpenCodeHttpPortArg(1, 59867)).toBe("--port=59867");
      // Unknown must NOT pass --port: a v2 TUI rejects the flag fatally,
      // while a v1 TUI merely runs without the HTTP API.
      expect(buildOpenCodeHttpPortArg(undefined, 59867)).toBeUndefined();
      expect(buildOpenCodeHttpPortArg(2, 59867)).toBeUndefined();
      expect(buildOpenCodeHttpPortArg(3, 59867)).toBeUndefined();
    });
  });

  describe("protocolForMajorVersion", () => {
    it("maps major versions to API protocols", () => {
      expect(protocolForMajorVersion(undefined)).toBe("v1");
      expect(protocolForMajorVersion(1)).toBe("v1");
      expect(protocolForMajorVersion(2)).toBe("v2");
    });
  });

  describe("detectOpenCodeMajorVersion", () => {
    type ExecCb = (error: Error | null, stdout: string) => void;
    const lastArgAsCb = (args: unknown[]): ExecCb =>
      args[args.length - 1] as ExecCb;

    it("parses and caches CLI version output", async () => {
      mockExecFile.mockImplementation((...args: unknown[]) => {
        lastArgAsCb(args)(null, "opencode v2.0.6\n");
        return {} as ReturnType<typeof execFile>;
      });

      await expect(detectOpenCodeMajorVersion("opencode")).resolves.toBe(2);
      await expect(detectOpenCodeMajorVersion("opencode")).resolves.toBe(2);
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    it("returns undefined when version command fails", async () => {
      mockExecFile.mockImplementation((...args: unknown[]) => {
        lastArgAsCb(args)(new Error("nope"), "");
        return {} as ReturnType<typeof execFile>;
      });

      await expect(detectOpenCodeMajorVersion("missing-bin")).resolves.toBeUndefined();
    });

    it("retries through cmd.exe when direct exec fails on Windows", async () => {
      __setWindowsShellRetryForTests(true);
      const enoent = Object.assign(new Error("spawn opencode ENOENT"), {
        code: "ENOENT",
      });
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const cb = lastArgAsCb(args);
        if (args[0] === "cmd.exe") {
          cb(null, "opencode v2.0.16\n");
        } else {
          cb(enoent, "");
        }
        return {} as ReturnType<typeof execFile>;
      });

      await expect(detectOpenCodeMajorVersion("opencode")).resolves.toBe(2);
      expect(mockExecFile).toHaveBeenCalledTimes(2);
      const retryCall = mockExecFile.mock.calls[1];
      expect(retryCall[0]).toBe("cmd.exe");
      expect(retryCall[1]).toEqual(["/d", "/s", "/c", '"opencode --version"']);
    });

    it("quotes the binary in the cmd.exe retry when it contains spaces", async () => {
      __setWindowsShellRetryForTests(true);
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const cb = lastArgAsCb(args);
        if (args[0] === "cmd.exe") {
          cb(null, "opencode v1.18.0\n");
        } else {
          cb(new Error("spawn failed"), "");
        }
        return {} as ReturnType<typeof execFile>;
      });

      await expect(
        detectOpenCodeMajorVersion('"C:\\Program Files\\OpenCode\\opencode.cmd"'),
      ).resolves.toBe(1);
      const retryCall = mockExecFile.mock.calls.at(-1);
      expect(retryCall?.[1]).toEqual([
        "/d",
        "/s",
        "/c",
        '""C:\\Program Files\\OpenCode\\opencode.cmd" --version"',
      ]);
    });

    it("returns undefined when the shell retry also fails", async () => {
      __setWindowsShellRetryForTests(true);
      mockExecFile.mockImplementation((...args: unknown[]) => {
        lastArgAsCb(args)(new Error("The system cannot find the path specified."), "");
        return {} as ReturnType<typeof execFile>;
      });

      await expect(detectOpenCodeMajorVersion("opencode")).resolves.toBeUndefined();
      expect(mockExecFile).toHaveBeenCalledTimes(2);
    });

    it("skips the shell retry when disabled", async () => {
      __setWindowsShellRetryForTests(false);
      mockExecFile.mockImplementation((...args: unknown[]) => {
        lastArgAsCb(args)(new Error("spawn opencode ENOENT"), "");
        return {} as ReturnType<typeof execFile>;
      });

      await expect(detectOpenCodeMajorVersion("opencode")).resolves.toBeUndefined();
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });
  });

  describe("resolveOpenCodeV2Service", () => {
    it("reads url and password from local service state", async () => {
      mockReadFileSync.mockImplementation((file) => {
        const value = String(file);
        if (value.includes("state") && value.endsWith("service.json")) {
          return JSON.stringify({
            url: "http://127.0.0.1:49374",
            password: "secret",
            version: "2.0.6",
            pid: 42,
          });
        }
        throw new Error("ENOENT");
      });

      const service = await resolveOpenCodeV2Service();
      expect(service).toMatchObject({
        url: "http://127.0.0.1:49374",
        port: 49374,
        password: "secret",
        version: "2.0.6",
        pid: 42,
      });
    });

    it("falls back to `service status` when state files are missing", async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1] as (
          e: Error | null,
          out: string,
        ) => void;
        const cliArgs = args[1];
        if (Array.isArray(cliArgs) && cliArgs[0] === "service") {
          cb(null, "http://127.0.0.1:41234\n");
        } else {
          cb(new Error("nope"), "");
        }
        return {} as ReturnType<typeof execFile>;
      });

      const service = await resolveOpenCodeV2Service("opencode");
      expect(service).toMatchObject({
        url: "http://127.0.0.1:41234",
        port: 41234,
      });
    });
  });

  describe("detectOpenCodeApiProtocol", () => {
    type ExecCb = (error: Error | null, stdout: string) => void;
    const lastArgAsCb = (args: unknown[]): ExecCb =>
      args[args.length - 1] as ExecCb;

    it("returns v2 when major version is 2+", async () => {
      mockExecFile.mockImplementation((...args: unknown[]) => {
        lastArgAsCb(args)(null, "opencode v2.0.6");
        return {} as ReturnType<typeof execFile>;
      });

      await expect(detectOpenCodeApiProtocol("opencode")).resolves.toBe("v2");
    });

    it("returns v1 when major version is 1", async () => {
      mockExecFile.mockImplementation((...args: unknown[]) => {
        lastArgAsCb(args)(null, "1.18.0");
        return {} as ReturnType<typeof execFile>;
      });

      await expect(detectOpenCodeApiProtocol("opencode")).resolves.toBe("v1");
    });

    it("treats an undetectable version as v1 even when v2 service state exists", async () => {
      __setWindowsShellRetryForTests(false);
      mockExecFile.mockImplementation((...args: unknown[]) => {
        lastArgAsCb(args)(new Error("spawn opencode ENOENT"), "");
        return {} as ReturnType<typeof execFile>;
      });
      mockReadFileSync.mockImplementation(() =>
        JSON.stringify({
          url: "http://127.0.0.1:49374",
          password: "secret",
          version: "2.0.6",
          pid: 42,
        }),
      );

      await expect(detectOpenCodeApiProtocol("opencode")).resolves.toBe("v1");
    });
  });

  describe("probe diagnostics", () => {
    type ExecCb = (error: Error | null, stdout: string) => void;
    const lastArgAsCb = (args: unknown[]): ExecCb =>
      args[args.length - 1] as ExecCb;

    it("logs exec failure and version probe lines through the injected logger", async () => {
      __setWindowsShellRetryForTests(false);
      const lines: Array<[string, string]> = [];
      setOpenCodeCliCompatDiagnostics((level, message) => {
        lines.push([level, message]);
      });
      const enoent = Object.assign(new Error("spawn opencode ENOENT"), {
        code: "ENOENT",
      });
      mockExecFile.mockImplementation((...args: unknown[]) => {
        lastArgAsCb(args)(enoent, "");
        return {} as ReturnType<typeof execFile>;
      });

      await expect(detectOpenCodeMajorVersion("opencode")).resolves.toBeUndefined();
      expect(lines).toEqual([
        [
          "warn",
          '[OpenCodeCliCompat] exec failed: file="opencode" code=ENOENT msg=spawn opencode ENOENT',
        ],
        [
          "info",
          '[OpenCodeCliCompat] full version probe: binary="opencode" version="(none)" output=""',
        ],
        [
          "info",
          '[OpenCodeCliCompat] version probe: binary="opencode" major=(none) version="(none)"',
        ],
      ]);
    });

    it("logs v2 service state paths as missing when absent", async () => {
      const lines: Array<[string, string]> = [];
      setOpenCodeCliCompatDiagnostics((level, message) => {
        lines.push([level, message]);
      });
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      mockExecFile.mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1] as (e: Error | null, out: string) => void;
        const cliArgs = args[1];
        if (Array.isArray(cliArgs) && cliArgs[0] === "service") {
          cb(null, "http://127.0.0.1:41234\n");
        } else {
          cb(new Error("nope"), "");
        }
        return {} as ReturnType<typeof execFile>;
      });

      await resolveOpenCodeV2Service("opencode");
      const probeLine = lines.find(([, message]) =>
        message.includes("v2 service probe"),
      );
      expect(probeLine?.[0]).toBe("info");
      expect(probeLine?.[1]).toMatch(/^\[OpenCodeCliCompat\] v2 service probe: /);
      expect(probeLine?.[1].match(/=missing/g)?.length).toBe(4);
    });
  });

  describe("buildOpenCodeV2AuthHeader", () => {
    it("builds Basic auth for the opencode user", () => {
      const header = buildOpenCodeV2AuthHeader("secret");
      expect(header.startsWith("Basic ")).toBe(true);
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
      expect(decoded).toBe("opencode:secret");
    });
  });
});
