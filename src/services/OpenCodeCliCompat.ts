import {
  execFile,
  spawn,
  type ChildProcess,
  type ExecFileOptions,
  type SpawnOptions,
} from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * OpenCode CLI compatibility helpers for v1 (TUI-hosted HTTP + `--port`) and
 * v2 (background service + Basic auth, TUI rejects `--port`).
 */

export type OpenCodeApiProtocol = "v1" | "v2";

export interface OpenCodeV2ServiceInfo {
  /** Full service base URL, e.g. http://127.0.0.1:49374 */
  url: string;
  port: number;
  /** Basic-auth password; username is always "opencode". */
  password?: string;
  version?: string;
  pid?: number;
}

/**
 * How long a cached CLI version stays fresh. Older entries count as cache
 * misses so an upgrade performed outside the extension (terminal, npm,
 * another window) is picked up by the next probe without a manual reset.
 */
export const OPENCODE_VERSION_CACHE_TTL_MS = 5_000;

/** A cached version value plus the clock reading it was recorded at. */
interface VersionCacheEntry<T> {
  value: T;
  at: number;
}

const versionCache = new Map<string, VersionCacheEntry<number>>();
const fullVersionCache = new Map<string, VersionCacheEntry<string>>();
/** In-flight full-version probes, keyed by binary: concurrent callers share one spawn. */
const fullVersionInFlight = new Map<string, Promise<string | undefined>>();
const protocolCache = new Map<string, OpenCodeApiProtocol>();

/** Clock feeding the version-cache timestamps; overridable in tests. */
let versionClock: () => number = Date.now;

/** True when an entry recorded at `at` is still within the TTL. */
function isFreshVersionEntry(at: number): boolean {
  return versionClock() - at < OPENCODE_VERSION_CACHE_TTL_MS;
}

/** Restores the default version-cache clock (tests). */
function resetVersionClock(): void {
  versionClock = Date.now;
}

export type OpenCodeCliDiagnosticLevel = "info" | "warn";
export type OpenCodeCliDiagnosticLogger = (
  level: OpenCodeCliDiagnosticLevel,
  message: string,
) => void;

let diagnosticLogger: OpenCodeCliDiagnosticLogger | undefined;

/**
 * Injects the extension-host logger for probe diagnostics.
 * Unset (default) keeps the module silent; tests reset the hook through
 * `resetOpenCodeCliCompatCaches`.
 */
export function setOpenCodeCliCompatDiagnostics(
  logger: OpenCodeCliDiagnosticLogger | undefined,
): void {
  diagnosticLogger = logger;
}

function logDiagnostic(
  level: OpenCodeCliDiagnosticLevel,
  message: string,
): void {
  diagnosticLogger?.(level, message);
}

/** Extracts the executable from a shell command string. */
export function extractCliBinary(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) {
    return "opencode";
  }

  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1);
    if (end > 0) {
      return trimmed.slice(1, end);
    }
  }

  return trimmed.split(/\s+/)[0] || trimmed;
}

/**
 * Detects whether an OpenCode launch command bypasses the shared background
 * service: `--standalone` embeds a private server, and `--server <url>`
 * attaches to an explicitly provided one. In both modes the shared service
 * is unrelated to the TUI, so service restarts and the accompanying prompt
 * must be skipped.
 */
export function commandBypassesSharedService(command: string): boolean {
  return /(?:^|\s)--(?:standalone|server)(?=[\s=]|$)/.test(command);
}

/**
 * Parses a major version from CLI version output.
 * Scans line by line: prefers an `opencode vX.Y` line, then a bare `X.Y`
 * line, so banner noise from shims (e.g. `⠩ v20.20.2`) cannot win.
 */
export function parseOpenCodeMajorVersion(versionOutput: string): number | undefined {
  const lines = versionOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const toMajor = (raw: string): number | undefined => {
    const major = Number(raw);
    return Number.isFinite(major) && major > 0 ? major : undefined;
  };

  for (const line of lines) {
    const match = line.match(/^opencode[/\s]+v?(\d+)\.\d+/i);
    if (match) {
      return toMajor(match[1]);
    }
  }
  for (const line of lines) {
    const match = line.match(/^v?(\d+)(?:\.\d+)+$/);
    if (match) {
      return toMajor(match[1]);
    }
  }
  return undefined;
}

export function protocolForMajorVersion(
  major: number | undefined,
): OpenCodeApiProtocol {
  return major !== undefined && major >= 2 ? "v2" : "v1";
}

/**
 * Extracts the full CLI version string from `--version` output.
 * Scans with the same precedence as `parseOpenCodeMajorVersion` so shim
 * banner noise cannot win; non-version output (e.g. dev builds printing
 * "local") is returned verbatim.
 */
export function parseOpenCodeFullVersion(
  versionOutput: string,
): string | undefined {
  const lines = versionOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const match = line.match(
      /^opencode[/\s]+v?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)(?=[\s(]|$)/i,
    );
    if (match) {
      return match[1];
    }
  }
  for (const line of lines) {
    const match = line.match(
      /^(?:v)?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)$/,
    );
    if (match) {
      return match[1];
    }
  }
  return lines[0];
}

let windowsShellRetry = process.platform === "win32";

/** Restores the platform-default Windows shell-retry behavior (tests). */
function resetWindowsShellRetry(): void {
  windowsShellRetry = process.platform === "win32";
}

interface ExecOutcome {
  error?: Error;
  stdout: string;
}

function execOnce(
  file: string,
  args: string[],
  timeoutMs: number,
  extraOpts: ExecFileOptions = {},
): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, ...extraOpts }, (error, stdout) => {
      resolve({
        error: error ?? undefined,
        stdout: stdout ? stdout.toString() : "",
      });
    });
  });
}

function runCli(file: string, args: string[], timeoutMs = 4000): Promise<string> {
  return runCliWithRetry(file, args, timeoutMs).then((outcome) =>
    outcome.error ? "" : outcome.stdout,
  );
}

function logExecFailure(file: string, error: Error): void {
  const code = (error as NodeJS.ErrnoException).code ?? "(none)";
  logDiagnostic(
    "warn",
    `[OpenCodeCliCompat] exec failed: file=${JSON.stringify(file)} code=${code} msg=${error.message}`,
  );
}

/** Characters that force double-quoting inside a cmd.exe command line. */
const CMD_QUOTE_PATTERN = /[\s&()^%|<>"!=;,]/;

/**
 * Builds the command string for the cmd.exe shim-retry path: file and
 * args containing whitespace or a cmd metacharacter are double-quoted
 * with inner quotes doubled; plain tokens pass through untouched.
 */
export function toCmdShellCommand(file: string, args: string[]): string {
  const quote = (part: string): string =>
    CMD_QUOTE_PATTERN.test(part)
      ? `"${part.replace(/"/g, '""')}"`
      : part;
  return [quote(file), ...args.map(quote)].join(" ");
}

/**
 * Runs a CLI command. On Windows, bare names such as `opencode` installed via
 * npm resolve to `.cmd`/`.ps1` shims that `execFile` cannot execute directly
 * (ENOENT/EINVAL), so a failed direct attempt is retried through `cmd.exe`,
 * which applies full PATHEXT resolution.
 */
async function runCliWithRetry(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<ExecOutcome> {
  const direct = await execOnce(file, args, timeoutMs);
  if (direct.error) {
    logExecFailure(file, direct.error);
  }
  if (!direct.error || !windowsShellRetry) {
    return direct;
  }

  const command = toCmdShellCommand(file, args);
  const viaShell = await execOnce(
    "cmd.exe",
    ["/d", "/s", "/c", `"${command}"`],
    timeoutMs,
    { windowsVerbatimArguments: true },
  );
  if (viaShell.error) {
    logExecFailure(file, viaShell.error);
  }
  return viaShell;
}

/**
 * Runs a CLI command through the Windows shim-retry path and rejects on
 * failure. Shared by update-flow probes so they never duplicate exec logic.
 */
export function runOpenCodeCliCommand(
  file: string,
  args: string[],
  timeoutMs = 4000,
): Promise<string> {
  return runCliWithRetry(file, args, timeoutMs).then((outcome) => {
    if (outcome.error) {
      throw outcome.error;
    }
    return outcome.stdout;
  });
}

/** Stream kind reported through `OpenCodeCliStreamOptions.onLine`. */
export type OpenCodeCliStream = "stdout" | "stderr";

export interface OpenCodeCliStreamOptions {
  timeoutMs?: number;
  /** Aborting kills the child and rejects the promise with the abort error. */
  signal?: AbortSignal;
  /** Receives each output line as it arrives (carry buffer splits chunks). */
  onLine?: (line: string, stream: OpenCodeCliStream) => void;
}

interface StreamOutcome {
  error?: Error;
  stdout: string;
  stderr: string;
}

/**
 * 终端重绘控制符：换行、回车、退格、CSI、OSC、字符集指定与双字节转义。
 * 实时输出（spinner、进度条）靠这些序列原地重写同一行，直接当文本渲染就会
 * 出现一长串重复内容。
 */
const CONTROL_TOKEN =
  /\r\n|\r|\n|\u0008|\u001b\[[0-9;?]*[a-zA-Z]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b[()#][0-9A-Za-z]|\u001b[@-_]/g;

/** 末尾被截断的转义序列，留到下一批数据再解析。 */
const INCOMPLETE_ESCAPE = /\u001b(?:\[[0-9;?]*|])?$/;

/**
 * 把原始输出切成可见行，并按终端语义处理原地重写：`\r` 与光标归位
 * （`ESC[nG`）回到行首、`ESC[2K`/`ESC[2J` 清行、退格与 `ESC[nD` 回删字符。
 * 这样 spinner 的每一帧只会覆盖上一帧，日志里留下的是最终内容。
 */
export function readOutputLines(
  carry: string,
  chunk: string,
): { lines: string[]; carry: string } {
  let text = carry + chunk;
  let pending = "";
  const tail = INCOMPLETE_ESCAPE.exec(text);
  if (tail) {
    pending = text.slice(tail.index);
    text = text.slice(0, tail.index);
  }

  const lines: string[] = [];
  let line = "";
  let offset = 0;
  for (const match of text.matchAll(CONTROL_TOKEN)) {
    const index = match.index ?? 0;
    line += text.slice(offset, index);
    const token = match[0];
    offset = index + token.length;
    if (token === "\n" || token === "\r\n") {
      lines.push(line);
      line = "";
    } else if (token === "\r") {
      line = "";
    } else if (token === "\u0008") {
      line = line.slice(0, -1);
    } else if (token.startsWith("\u001b[")) {
      const final = token.charAt(token.length - 1);
      const paramText = token.slice(2, -1);
      const param = Number(paramText || "1");
      if (final === "G" || final === "H" || final === "f") {
        line = final === "G" && param > 1 ? line.slice(0, param - 1) : "";
      } else if (final === "K" || final === "J") {
        // 擦到行尾/屏尾：光标恒在行末，已有文本必须保留；只有整行/整屏
        // 擦除（2、3）才清空，否则 `文本 + ESC[K` 会把整行吞掉。
        if (param === 2 || param === 3) {
          line = "";
        }
      } else if (final === "D") {
        line = line.slice(0, Math.max(0, line.length - param));
      } else if (final === "C") {
        line += " ".repeat(Math.max(0, param));
      }
    }
    // 其余序列（颜色、光标上下移动、隐藏光标等）不参与纯文本行
  }
  line += text.slice(offset);
  return { lines, carry: line + pending };
}

/**
 * Strips leftover control characters from one output line. `readOutputLines`
 * already resolves in-place rewrites; this is the final guard before the
 * dialog renders the text.
 */
export function sanitizeOutputLine(line: string): string {
  return line
    .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trimEnd();
}

function spawnOnce(
  file: string,
  args: string[],
  options: SpawnOptions,
  onLine: ((line: string, stream: OpenCodeCliStream) => void) | undefined,
): Promise<StreamOutcome> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let outCarry = "";
    let errCarry = "";
    let settled = false;

    let child: ChildProcess;
    try {
      child = spawn(file, args, { windowsHide: true, ...options });
    } catch (error) {
      resolve({
        error: error instanceof Error ? error : new Error(String(error)),
        stdout,
        stderr,
      });
      return;
    }

    const finish = (error: Error | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      // stdout/stderr already hold the raw chunks; flush only the pending
      // line fragments through onLine.
      if (outCarry) {
        emitLine(outCarry, "stdout");
      }
      if (errCarry) {
        emitLine(errCarry, "stderr");
      }
      resolve({ error, stdout, stderr });
    };

    /** Hands one clean, non-empty line to the listener. */
    const emitLine = (line: string, stream: OpenCodeCliStream): void => {
      if (!onLine) {
        return;
      }
      const clean = sanitizeOutputLine(line);
      if (clean) {
        onLine(clean, stream);
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      const split = readOutputLines(outCarry, chunk);
      outCarry = split.carry;
      for (const line of split.lines) {
        emitLine(line, "stdout");
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      const split = readOutputLines(errCarry, chunk);
      errCarry = split.carry;
      for (const line of split.lines) {
        emitLine(line, "stderr");
      }
    });
    child.on("error", (error: Error) => finish(error));
    child.on("close", (code: number | null) => {
      finish(
        code === 0
          ? undefined
          : new Error(`${file} exited with code ${code ?? "(unknown)"}`),
      );
    });
  });
}

/**
 * Runs a long-lived CLI command (e.g. `opencode upgrade`) with live output
 * streaming, timeout, and abort. Uses the same Windows shim retry as
 * `runCliWithRetry`; the retry is skipped once the child produced output so
 * a partially executed command is never re-run. Rejects on failure, with
 * all captured lines already delivered through `onLine`.
 */
export async function streamOpenCodeCliCommand(
  file: string,
  args: string[],
  options: OpenCodeCliStreamOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 4000;
  const spawnOptions: SpawnOptions = {
    timeout: timeoutMs,
    // 关闭颜色与交互式动画：升级命令在无终端环境下只需要纯文本行
    env: {
      ...process.env,
      TERM: "dumb",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      CI: "1",
    },
  };
  if (options.signal) {
    spawnOptions.signal = options.signal;
  }

  const direct = await spawnOnce(
    file,
    args,
    spawnOptions,
    options.onLine,
  );
  if (direct.error) {
    logExecFailure(file, direct.error);
  }

  let outcome = direct;
  if (
    direct.error &&
    !direct.stdout &&
    !direct.stderr &&
    windowsShellRetry &&
    !options.signal?.aborted
  ) {
    const command = toCmdShellCommand(file, args);
    const viaShell = await spawnOnce(
      "cmd.exe",
      ["/d", "/s", "/c", `"${command}"`],
      { ...spawnOptions, windowsVerbatimArguments: true },
      options.onLine,
    );
    if (viaShell.error) {
      logExecFailure(file, viaShell.error);
    }
    outcome = viaShell;
  }

  if (outcome.error) {
    throw outcome.error;
  }
  return outcome.stdout;
}

/**
 * Detects the OpenCode CLI major version from `<bin> --version`.
 * Cached majors expire after `OPENCODE_VERSION_CACHE_TTL_MS`; an expired
 * entry re-probes through the shared full-version probe. Returns
 * undefined when detection fails; callers should fall back to v1.
 */
export async function detectOpenCodeMajorVersion(
  commandOrBinary: string,
): Promise<number | undefined> {
  const binary = extractCliBinary(commandOrBinary);
  const cached = versionCache.get(binary);
  if (cached && isFreshVersionEntry(cached.at)) {
    return cached.value;
  }

  // Derive the major from the shared full-version probe so a single
  // `--version` run feeds every consumer (pill, update check, session
  // startup) instead of one spawn per cache. Pass the original command:
  // re-extracting an already-extracted path with spaces is lossy.
  const full = await getOpenCodeVersion(commandOrBinary);
  const major =
    full !== undefined ? parseOpenCodeMajorVersion(full) : undefined;
  logDiagnostic(
    "info",
    `[OpenCodeCliCompat] version probe: binary=${JSON.stringify(binary)} major=${major ?? "(none)"} version=${JSON.stringify(full ?? "(none)")}`,
  );
  if (major !== undefined) {
    versionCache.set(binary, {
      value: major,
      at: fullVersionCache.get(binary)?.at ?? versionClock(),
    });
  }
  return major;
}

/**
 * Resolves the full OpenCode CLI version string from `<bin> --version`
 * (e.g. "1.18.33"; dev builds print "local"). Returns undefined when the
 * probe fails. Concurrent calls for the same binary share one probe;
 * failed probes are not cached, so a later call retries. Successful
 * probes are cached for `OPENCODE_VERSION_CACHE_TTL_MS`; an expired
 * entry counts as a miss and re-probes, and the fresh result also drops
 * the cached protocol decision so a v1↔v2 transition is re-derived.
 * A probe superseded by a cache reset is discarded: it writes no caches
 * and leaves the successor's in-flight slot intact.
 */
export async function getOpenCodeVersion(
  commandOrBinary = "opencode",
): Promise<string | undefined> {
  const binary = extractCliBinary(commandOrBinary);
  const cached = fullVersionCache.get(binary);
  if (cached && isFreshVersionEntry(cached.at)) {
    return cached.value;
  }
  const inFlight = fullVersionInFlight.get(binary);
  if (inFlight) {
    return inFlight;
  }

  const pending = runCli(binary, ["--version"]).then((output) => {
    const version = parseOpenCodeFullVersion(output);
    logDiagnostic(
      "info",
      `[OpenCodeCliCompat] full version probe: binary=${JSON.stringify(binary)} version=${JSON.stringify(version ?? "(none)")} output=${JSON.stringify(output)}`,
    );
    // resetOpenCodeCliVersionCaches() may clear a probe's registration
    // while it is still in flight (cross-window sync, update check). A
    // superseded probe must not write stale values into the caches under
    // a fresh timestamp nor delete its successor's in-flight slot.
    if (fullVersionInFlight.get(binary) !== pending) {
      return version;
    }
    if (version !== undefined) {
      const at = versionClock();
      fullVersionCache.set(binary, { value: version, at });
      // One probe feeds both caches: derive the major from the full
      // version so `detectOpenCodeMajorVersion` never spawns again.
      const major = parseOpenCodeMajorVersion(version);
      if (major !== undefined) {
        versionCache.set(binary, { value: major, at });
      }
      // The fresh version may follow an external upgrade: drop the stale
      // protocol decision so the next detection re-derives it from the
      // fresh major.
      protocolCache.delete(binary);
    }
    fullVersionInFlight.delete(binary);
    return version;
  });
  fullVersionInFlight.set(binary, pending);
  return pending;
}

/**
 * Fresh cached full version for a binary without probing; undefined
 * when unknown or older than `OPENCODE_VERSION_CACHE_TTL_MS`.
 */
export function peekOpenCodeVersion(binary: string): string | undefined {
  const cached = fullVersionCache.get(binary);
  return cached && isFreshVersionEntry(cached.at) ? cached.value : undefined;
}

/** In-flight full-version probe for a binary, if one is running. */
export function peekOpenCodeVersionProbe(
  binary: string,
): Promise<string | undefined> | undefined {
  return fullVersionInFlight.get(binary);
}

/**
 * Clears cached CLI version/protocol lookups and restores the default
 * version-cache clock (tests).
 */
export function resetOpenCodeCliCompatCaches(): void {
  versionCache.clear();
  fullVersionCache.clear();
  fullVersionInFlight.clear();
  protocolCache.clear();
  resetWindowsShellRetry();
  resetVersionClock();
  diagnosticLogger = undefined;
}

/**
 * Clears only the version/protocol caches while keeping the diagnostics
 * sink and Windows shell-retry wiring intact. Production reset for the
 * self-update verify step, which must re-probe `--version` without
 * unwiring probe diagnostics.
 */
export function resetOpenCodeCliVersionCaches(): void {
  versionCache.clear();
  fullVersionCache.clear();
  fullVersionInFlight.clear();
  protocolCache.clear();
}

/** Overrides the Windows shell-retry behavior (tests only). */
export function __setWindowsShellRetryForTests(enabled: boolean): void {
  windowsShellRetry = enabled;
}

/** Overrides the version-cache clock (tests only). */
export function __setOpenCodeVersionClockForTests(clock: () => number): void {
  versionClock = clock;
}

/**
 * Builds the HTTP port CLI arg for a tool launch command.
 * v1: `--port=N`. v2: undefined (TUI attaches to the background service and
 * rejects `--port`).
 */
export function buildOpenCodeHttpPortArg(
  cliMajorVersion: number | undefined,
  port: number,
): string | undefined {
  // Unknown version: omit the flag. A v2 TUI rejects `--port` outright
  // (fatal at startup), while a v1 TUI merely runs without the HTTP API
  // (degraded but usable). The version can stay unknown when the CLI is
  // only on the user's shell PATH (e.g. bun/npm global installs), which
  // the extension host process does not inherit.
  if (
    cliMajorVersion === undefined ||
    protocolForMajorVersion(cliMajorVersion) === "v2"
  ) {
    return undefined;
  }
  return `--port=${port}`;
}

function homePath(...parts: string[]): string {
  return path.join(os.homedir(), ...parts);
}

/** Candidate service.json locations used by OpenCode v2. */
export function v2ServiceStatePaths(): string[] {
  return [
    homePath(".local", "state", "opencode", "service.json"),
    homePath(".local", "share", "opencode", "service.json"),
    homePath("AppData", "Local", "opencode", "service.json"),
    homePath("AppData", "Roaming", "opencode", "service.json"),
  ];
}

/** Candidate service password locations used by OpenCode v2. */
export function v2ServicePasswordPaths(): string[] {
  return [
    homePath(".config", "opencode", "service.json"),
    homePath(".local", "state", "opencode", "service.json"),
    homePath("AppData", "Roaming", "opencode", "service.json"),
    homePath("AppData", "Local", "opencode", "service.json"),
  ];
}

function parsePortFromUrl(url: string): number | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.port) {
      const port = Number(parsed.port);
      return Number.isFinite(port) ? port : undefined;
    }
    return parsed.protocol === "https:" ? 443 : 80;
  } catch {
    const match = url.match(/:(\d{2,5})(?:\/|$)/);
    return match ? Number(match[1]) : undefined;
  }
}

function readJsonFile(file: string): Record<string, unknown> | undefined {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore unreadable/missing files
  }
  return undefined;
}

/**
 * Resolves the OpenCode v2 background-service endpoint (URL, port, password).
 * Reads local service state first, then falls back to `opencode service status`.
 */
export async function resolveOpenCodeV2Service(
  commandOrBinary = "opencode",
): Promise<OpenCodeV2ServiceInfo | undefined> {
  let url: string | undefined;
  let password: string | undefined;
  let version: string | undefined;
  let pid: number | undefined;

  for (const file of v2ServiceStatePaths()) {
    const data = readJsonFile(file);
    if (!data) {
      continue;
    }
    if (typeof data.url === "string" && data.url) {
      url = data.url;
    }
    if (typeof data.password === "string" && data.password) {
      password = data.password;
    }
    if (typeof data.version === "string") {
      version = data.version;
    }
    if (typeof data.pid === "number") {
      pid = data.pid;
    }
    if (url) {
      break;
    }
  }

  logDiagnostic(
    "info",
    `[OpenCodeCliCompat] v2 service probe: ${v2ServiceStatePaths()
      .map((file) => `${file}=${fs.existsSync(file) ? "exists" : "missing"}`)
      .join(" | ")}`,
  );

  if (!password) {
    for (const file of v2ServicePasswordPaths()) {
      const data = readJsonFile(file);
      if (data && typeof data.password === "string" && data.password) {
        password = data.password;
        break;
      }
    }
  }

  if (!url) {
    const binary = extractCliBinary(commandOrBinary);
    const status = (await runCli(binary, ["service", "status"])).trim();
    const statusUrl = status.match(/https?:\/\/\S+/)?.[0];
    if (statusUrl) {
      url = statusUrl.replace(/[.,;]$/, "");
    }
  }

  if (!url) {
    return undefined;
  }

  const port = parsePortFromUrl(url);
  if (port === undefined) {
    return undefined;
  }

  return { url, port, password, version, pid };
}

/**
 * Resolves the HTTP API protocol for a CLI command via `--version`.
 * Unknown versions fall back to v1. A fresh version probe drops the
 * cached protocol decision, so a v1↔v2 upgrade performed outside the
 * extension is re-derived once the version cache expires or resets.
 */
export async function detectOpenCodeApiProtocol(
  commandOrBinary = "opencode",
): Promise<OpenCodeApiProtocol> {
  const binary = extractCliBinary(commandOrBinary);
  const cached = protocolCache.get(binary);
  if (cached) {
    return cached;
  }

  const major = await detectOpenCodeMajorVersion(binary);
  const protocol = protocolForMajorVersion(major);
  protocolCache.set(binary, protocol);
  return protocol;
}

/** HTTP Basic username used by OpenCode v2 service auth (`opencode pair`). */
export const OPENCODE_V2_AUTH_USERNAME = "opencode";

export function buildOpenCodeV2AuthHeader(password: string): string {
  const token = Buffer.from(
    `${OPENCODE_V2_AUTH_USERNAME}:${password}`,
    "utf8",
  ).toString("base64");
  return `Basic ${token}`;
}
