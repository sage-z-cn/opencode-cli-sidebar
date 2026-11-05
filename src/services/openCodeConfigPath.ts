import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Resolve the OpenCode cli.json path. OPENCODE_CONFIG_DIR wins even if the file is missing. */
export function resolveOpenCodeCliConfigPath(): string {
  const configDir = process.env.OPENCODE_CONFIG_DIR;
  if (configDir) {
    return path.join(configDir, "cli.json");
  }
  for (const file of openCodeCliConfigCandidates()) {
    if (fs.existsSync(file)) {
      return file;
    }
  }
  return openCodeCliConfigCandidates()[0];
}

export function openCodeCliConfigCandidates(): string[] {
  return openCodeConfigDirCandidates().map((dir) => path.join(dir, "cli.json"));
}

/** Config directories checked for OpenCode global files (cli.json / opencode.json / AGENTS.md). */
export function openCodeConfigDirCandidates(): string[] {
  const home = os.homedir();
  const configDir = process.env.OPENCODE_CONFIG_DIR;
  const out: string[] = [];
  if (configDir) {
    out.push(configDir);
  }
  out.push(path.join(home, ".config", "opencode"));
  out.push(path.join(home, "AppData", "Roaming", "opencode"));
  out.push(path.join(home, "AppData", "Local", "opencode"));
  return out;
}

/** Primary OpenCode config directory (env override or first existing candidate). */
export function resolveOpenCodeConfigDir(): string {
  const configDir = process.env.OPENCODE_CONFIG_DIR;
  if (configDir) {
    return configDir;
  }
  for (const dir of openCodeConfigDirCandidates()) {
    if (fs.existsSync(dir)) {
      return dir;
    }
  }
  return openCodeConfigDirCandidates()[0];
}

/**
 * Resolve the global AGENTS.md path (OpenCode global agent instructions).
 * OPENCODE_CONFIG_DIR wins even if the file is missing.
 * Returns an existing file when found; otherwise the preferred create/open path.
 */
export function resolveOpenCodeGlobalAgentsMdPath(): string {
  const configDir = process.env.OPENCODE_CONFIG_DIR;
  if (configDir) {
    return path.join(configDir, "AGENTS.md");
  }
  for (const dir of openCodeConfigDirCandidates()) {
    const file = path.join(dir, "AGENTS.md");
    if (fs.existsSync(file)) {
      return file;
    }
  }
  return path.join(resolveOpenCodeConfigDir(), "AGENTS.md");
}

/**
 * Resolve the global opencode.json / opencode.jsonc path.
 * OPENCODE_CONFIG_DIR wins even if the file is missing.
 * Prefers an existing file (json first, then jsonc); otherwise opencode.json
 * in the preferred config directory.
 */
export function resolveOpenCodeGlobalConfigPath(): string {
  const configDir = process.env.OPENCODE_CONFIG_DIR;
  if (configDir) {
    for (const name of ["opencode.json", "opencode.jsonc"]) {
      const file = path.join(configDir, name);
      if (fs.existsSync(file)) {
        return file;
      }
    }
    return path.join(configDir, "opencode.json");
  }
  for (const dir of openCodeConfigDirCandidates()) {
    for (const name of ["opencode.json", "opencode.jsonc"]) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) {
        return file;
      }
    }
  }
  return path.join(resolveOpenCodeConfigDir(), "opencode.json");
}

/** Global OpenCode files the toolbar can open directly. */
export type OpenCodeGlobalFileTarget =
  | "agentsMd"
  | "opencodeJson"
  | "cliJson"
  | "ohMyOpenCodeSlim";

/** Plugin package that owns the oh-my-opencode-slim config files. */
const OH_MY_OPENCODE_SLIM_PACKAGE = "oh-my-opencode-slim";

/** Config file names the oh-my-opencode-slim plugin may use, json first. */
const OH_MY_OPENCODE_SLIM_CONFIG_NAMES = [
  "oh-my-opencode-slim.json",
  "oh-my-opencode-slim.jsonc",
] as const;

/** Config file names an OpenCode config may use inside a config directory. */
const OPENCODE_CONFIG_FILE_NAMES = ["cli.json", "opencode.json", "opencode.jsonc"];

/**
 * Resolve the oh-my-opencode-slim plugin config path.
 * OPENCODE_CONFIG_DIR wins even if the file is missing.
 * Prefers an existing file, json first then jsonc; otherwise defaults to
 * oh-my-opencode-slim.json in the preferred config directory.
 */
export function resolveOhMyOpenCodeSlimConfigPath(): string {
  const configDir = process.env.OPENCODE_CONFIG_DIR;
  if (configDir) {
    for (const name of OH_MY_OPENCODE_SLIM_CONFIG_NAMES) {
      const file = path.join(configDir, name);
      if (fs.existsSync(file)) {
        return file;
      }
    }
    return path.join(configDir, "oh-my-opencode-slim.json");
  }
  for (const dir of openCodeConfigDirCandidates()) {
    for (const name of OH_MY_OPENCODE_SLIM_CONFIG_NAMES) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) {
        return file;
      }
    }
  }
  return path.join(resolveOpenCodeConfigDir(), "oh-my-opencode-slim.json");
}

/**
 * True when OpenCode carries the oh-my-opencode-slim plugin: its config file
 * exists, or the plugin is declared in an OpenCode config's `plugins` list.
 * OPENCODE_CONFIG_DIR narrows the check to that directory.
 */
export function isOhMyOpenCodeSlimAvailable(): boolean {
  const dirs = process.env.OPENCODE_CONFIG_DIR
    ? [process.env.OPENCODE_CONFIG_DIR]
    : openCodeConfigDirCandidates();
  for (const dir of dirs) {
    for (const name of OH_MY_OPENCODE_SLIM_CONFIG_NAMES) {
      if (fs.existsSync(path.join(dir, name))) {
        return true;
      }
    }
  }
  return openCodeConfigDeclaresPackage(dirs, OH_MY_OPENCODE_SLIM_PACKAGE);
}

function openCodeConfigDeclaresPackage(
  dirs: readonly string[],
  packageName: string,
): boolean {
  for (const dir of dirs) {
    for (const name of OPENCODE_CONFIG_FILE_NAMES) {
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) {
        continue;
      }
      const plugins = readConfigPlugins(file);
      if (plugins?.some((entry) => pluginPackageName(entry) === packageName)) {
        return true;
      }
    }
  }
  return false;
}

function readConfigPlugins(file: string): unknown[] | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    const plugins = (parsed as { plugins?: unknown }).plugins;
    return Array.isArray(plugins) ? plugins : undefined;
  } catch {
    // Unreadable or JSONC configs are skipped; detection stays best-effort.
    return undefined;
  }
}

/** Plugin entry may be a package spec string or an object carrying `package`. */
function pluginPackageName(entry: unknown): string | undefined {
  const spec =
    typeof entry === "string"
      ? entry
      : entry && typeof entry === "object"
        ? (entry as { package?: unknown }).package
        : undefined;
  if (typeof spec !== "string") {
    return undefined;
  }
  const name = spec.trim();
  // Drop a trailing @version while keeping a leading scope (`@scope/pkg`).
  const at = name.lastIndexOf("@");
  return at > 0 ? name.slice(0, at) : name;
}

/**
 * Ensure a global OpenCode file exists and return its path.
 * Creates an empty starter (or `{}` for JSON config) when missing.
 */
export function ensureOpenCodeGlobalFile(
  target: OpenCodeGlobalFileTarget,
): string {
  const filePath =
    target === "agentsMd"
      ? resolveOpenCodeGlobalAgentsMdPath()
      : target === "cliJson"
        ? resolveOpenCodeCliConfigPath()
        : target === "ohMyOpenCodeSlim"
          ? resolveOhMyOpenCodeSlimConfigPath()
          : resolveOpenCodeGlobalConfigPath();
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      target === "agentsMd" ? "" : "{}\n",
      "utf8",
    );
  }
  return filePath;
}
