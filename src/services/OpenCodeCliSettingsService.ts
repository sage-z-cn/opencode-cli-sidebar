import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  OPENCODE_BUILTIN_THEMES,
  OPENCODE_CLI_SETTINGS_CATALOG,
  findOpenCodeCliSetting,
  type OpenCodeCliSettingOption,
} from "./aiTools/openCodeCliSettingsCatalog";
import {
  discoverOpenCodeThemesFromDisk,
  mergeThemeCatalogs,
} from "./aiTools/openCodeThemeDiscovery";
import { resolveOpenCodeCliConfigPath } from "./openCodeConfigPath";
import { OutputChannelService } from "./OutputChannelService";
import { isVersionNewer } from "./semver";
import type { OpenCodeCliPluginUpdateInfo } from "../types";

/**
 * OpenCode's terminal-palette theme. Unlike the default `opencode` theme,
 * which only has light/dark variants, `system` reads the terminal's ANSI
 * palette, which the webview mirrors from VS Code's terminal colors.
 */
export const VSCODE_TERMINAL_THEME_NAME = "system";
export const VSCODE_TERMINAL_THEME_MODE = "system";

export interface OpenCodeCliSettingsPayload {
  /** Effective values keyed by dotted path (defaults filled in). */
  values: Record<string, unknown>;
  /** Keys present in cli.json (true user overrides). */
  overrides: Record<string, boolean>;
  configPath: string;
  /** Theme options: builtin + discovered theme files. */
  themeOptions: OpenCodeCliSettingOption[];
  plugins: unknown[];
}

/**
 * Reads/writes OpenCode cli.json settings other than `keybinds`.
 * Writing a value equal to the default removes the key.
 */
export class OpenCodeCliSettingsService {
  public constructor(
    private readonly logger: Pick<
      OutputChannelService,
      "info" | "warn" | "error" | "debug"
    > = OutputChannelService.getInstance(),
  ) {}

  public resolveConfigPath(): string {
    return resolveOpenCodeCliConfigPath();
  }

  public async load(projectDir?: string): Promise<OpenCodeCliSettingsPayload> {
    const configPath = this.resolveConfigPath();
    const doc = this.readDoc(configPath);
    const values: Record<string, unknown> = {};
    const overrides: Record<string, boolean> = {};

    for (const item of OPENCODE_CLI_SETTINGS_CATALOG) {
      if (item.type === "readonly") {
        continue;
      }
      const has = hasPath(doc, item.id);
      const raw = has ? getPath(doc, item.id) : undefined;
      values[item.id] = has && raw !== undefined ? raw : item.def;
      if (has && raw !== undefined && !sameValue(raw, item.def)) {
        overrides[item.id] = true;
      }
    }

    const pluginsRaw = doc.plugins;
    const plugins = Array.isArray(pluginsRaw) ? pluginsRaw : [];

    return {
      values,
      overrides,
      configPath,
      themeOptions: this.buildThemeOptions(
        typeof values["theme.name"] === "string"
          ? (values["theme.name"] as string)
          : "",
        projectDir,
      ),
      plugins,
    };
  }

  /** Write one dotted path. Value equal to default deletes the key. */
  public async save(id: string, value: unknown): Promise<void> {
    this.assertNotReadonly(id);
    await this.mutateDoc((doc) => {
      setPath(doc, id, value);
    });
  }

  /** Delete one dotted path override. */
  public async reset(id: string): Promise<void> {
    this.assertNotReadonly(id);
    await this.mutateDoc((doc) => {
      deletePath(doc, id);
    });
  }

  /**
   * Make OpenCode use the terminal palette so the TUI follows VS Code's
   * terminal theme. Writes both `theme.name` and `theme.mode` to `system`,
   * overriding a local OpenCode theme choice. Callers gate this on the
   * `followVsCodeTheme` setting.
   *
   * @returns true when the config file was changed.
   */
  public async applyVsCodeTheme(): Promise<boolean> {
    const configPath = this.resolveConfigPath();
    const doc = this.readDoc(configPath);
    if (
      getPath(doc, "theme.name") === VSCODE_TERMINAL_THEME_NAME &&
      getPath(doc, "theme.mode") === VSCODE_TERMINAL_THEME_MODE
    ) {
      return false;
    }
    await this.mutateDoc((current) => {
      setPath(current, "theme.name", VSCODE_TERMINAL_THEME_NAME);
      setPath(current, "theme.mode", VSCODE_TERMINAL_THEME_MODE);
    });
    return true;
  }

  /** Readonly display entries are edited manually in cli.json only. */
  private assertNotReadonly(id: string): void {
    if (findOpenCodeCliSetting(id)?.type === "readonly") {
      throw new Error(`Readonly setting cannot be modified here: ${id}`);
    }
  }

  /** Append one plugin entry (npm package spec) to cli.json `plugins`. */
  public async addPlugin(packageSpec: string): Promise<void> {
    const spec = packageSpec.trim();
    if (!spec) {
      throw new Error("Plugin package name is required");
    }
    await this.mutateDoc((doc) => {
      const existing = Array.isArray(doc.plugins) ? (doc.plugins as unknown[]) : [];
      doc.plugins = [...existing, spec];
    });
  }

  /** Remove a plugin entry by index in the `plugins` array. */
  public async removePlugin(index: number): Promise<void> {
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`Invalid plugin index: ${index}`);
    }
    await this.mutateDoc((doc) => {
      const existing = Array.isArray(doc.plugins) ? (doc.plugins as unknown[]) : [];
      if (index >= existing.length) {
        throw new Error(`Plugin index out of range: ${index}`);
      }
      doc.plugins = existing.filter((_, i) => i !== index);
    });
  }

  /**
   * Pin a plugin entry to `version`. Accepts string specs and
   * `{ package, version }` objects; preserves other object fields.
   */
  public async updatePluginVersion(
    index: number,
    version: string,
  ): Promise<void> {
    const ver = version.trim();
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`Invalid plugin index: ${index}`);
    }
    if (!ver) {
      throw new Error("Plugin version is required");
    }
    await this.mutateDoc((doc) => {
      const existing = Array.isArray(doc.plugins) ? (doc.plugins as unknown[]) : [];
      if (index >= existing.length) {
        throw new Error(`Plugin index out of range: ${index}`);
      }
      doc.plugins = existing.map((plugin, i) =>
        i === index ? applyPluginVersion(plugin, ver) : plugin,
      );
    });
  }

  /**
   * Check npm for a newer version of every configured plugin.
   * Unpinned packages report `current: null` with the registry latest.
   */
  public async checkPluginUpdates(): Promise<OpenCodeCliPluginUpdateInfo[]> {
    const configPath = this.resolveConfigPath();
    const doc = this.readDoc(configPath);
    const plugins = Array.isArray(doc.plugins) ? (doc.plugins as unknown[]) : [];
    return Promise.all(
      plugins.map((plugin) => this.checkOnePlugin(plugin)),
    );
  }

  private async checkOnePlugin(
    plugin: unknown,
  ): Promise<OpenCodeCliPluginUpdateInfo> {
    const parsed = parsePluginSpec(plugin);
    if (!parsed) {
      return {
        name: String(plugin),
        current: null,
        latest: null,
        hasUpdate: false,
        error: "Unrecognized plugin entry",
      };
    }
    try {
      const latest = await fetchNpmLatestVersion(parsed.name);
      const hasUpdate =
        parsed.version !== null && latest !== null
          ? isVersionNewer(latest, parsed.version)
          : false;
      return {
        name: parsed.name,
        current: parsed.version,
        latest,
        hasUpdate,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[OpenCodeCliSettingsService] npm version check failed for ${parsed.name}: ${message}`,
      );
      return {
        name: parsed.name,
        current: parsed.version,
        latest: null,
        hasUpdate: false,
        error: message,
      };
    }
  }

  private buildThemeOptions(
    current: string,
    projectDir?: string,
  ): OpenCodeCliSettingOption[] {
    // Runtime discovery (theme/assets + themes/*.json) tracks OpenCode updates
    // when those folders exist; the hardcoded catalog fills gaps otherwise.
    const discovered = discoverOpenCodeThemesFromDisk(projectDir);
    return mergeThemeCatalogs(discovered, OPENCODE_BUILTIN_THEMES, current);
  }

  private readDoc(configPath: string): Record<string, unknown> {
    try {
      if (!fs.existsSync(configPath)) {
        return {};
      }
      const raw = fs.readFileSync(configPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch (error) {
      this.logger.warn(
        `[OpenCodeCliSettingsService] Failed to read ${configPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {};
    }
  }

  private async mutateDoc(
    mutate: (doc: Record<string, unknown>) => void,
  ): Promise<void> {
    const configPath = this.resolveConfigPath();
    let doc: Record<string, unknown> = {};
    if (fs.existsSync(configPath)) {
      try {
        const raw = fs.readFileSync(configPath, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          doc = parsed as Record<string, unknown>;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `[OpenCodeCliSettingsService] Refusing to rewrite unreadable config ${configPath}: ${message}`,
        );
        throw new Error(`Config file is not valid JSON: ${configPath}`);
      }
    }

    mutate(doc);

    try {
      const dir = path.dirname(configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(configPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `[OpenCodeCliSettingsService] Failed to write ${configPath}: ${message}`,
      );
      throw new Error(message);
    }
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) < 1e-9;
  }
  return false;
}

function pathParts(id: string): string[] {
  return id.split(".").filter(Boolean);
}

function hasPath(doc: Record<string, unknown>, id: string): boolean {
  let cur: unknown = doc;
  for (const part of pathParts(id)) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return false;
    if (!(part in (cur as Record<string, unknown>))) return false;
    cur = (cur as Record<string, unknown>)[part];
  }
  return true;
}

function getPath(doc: Record<string, unknown>, id: string): unknown {
  let cur: unknown = doc;
  for (const part of pathParts(id)) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function setPath(doc: Record<string, unknown>, id: string, value: unknown): void {
  const parts = pathParts(id);
  if (!parts.length) return;
  let cur = doc;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    const next = cur[key];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      cur[key] = {};
    }
    cur = cur[key] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (value === undefined) {
    delete cur[last];
    return;
  }
  cur[last] = value;
}

function deletePath(doc: Record<string, unknown>, id: string): void {
  const parts = pathParts(id);
  if (!parts.length) return;
  let cur: Record<string, unknown> | undefined = doc;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const next = cur?.[parts[i]];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      return;
    }
    cur = next as Record<string, unknown>;
  }
  if (cur) {
    delete cur[parts[parts.length - 1]];
    // prune empty parent objects (e.g. theme: {})
    if (parts.length > 1) {
      pruneEmpty(doc, parts.slice(0, -1));
    }
  }
}

function pruneEmpty(
  doc: Record<string, unknown>,
  parts: readonly string[],
): void {
  if (!parts.length) return;
  let cur: Record<string, unknown> | undefined = doc;
  const stack: Array<{ obj: Record<string, unknown>; key: string }> = [];
  for (const part of parts) {
    const next = cur?.[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) return;
    stack.push({ obj: cur, key: part });
    cur = next as Record<string, unknown>;
  }
  if (cur && Object.keys(cur).length === 0 && stack.length) {
    const last = stack[stack.length - 1];
    delete last.obj[last.key];
  }
}

/** Parse a plugin entry (`"pkg"` / `"pkg@1.0.0"` / `{ package, version }`). */
export function parsePluginSpec(plugin: unknown): {
  name: string;
  version: string | null;
} | null {
  if (typeof plugin === "string") {
    return splitPackageSpec(plugin);
  }
  if (plugin && typeof plugin === "object" && !Array.isArray(plugin)) {
    const rec = plugin as { package?: unknown; version?: unknown };
    const nameRaw = rec.package;
    const versionRaw = rec.version;
    if (typeof nameRaw === "string" && nameRaw.trim()) {
      const fromName = splitPackageSpec(nameRaw.trim());
      const version =
        typeof versionRaw === "string" && versionRaw.trim()
          ? versionRaw.trim()
          : fromName.version;
      return { name: fromName.name, version };
    }
  }
  return null;
}

function splitPackageSpec(spec: string): {
  name: string;
  version: string | null;
} {
  // Scoped packages start with '@'; the version separator is the last '@'
  // that is not at index 0.
  const at = spec.lastIndexOf("@");
  if (at > 0) {
    const name = spec.slice(0, at);
    const version = spec.slice(at + 1).trim();
    return { name, version: version || null };
  }
  return { name: spec, version: null };
}

/**
 * Rewrite one plugin entry to pin `version`, keeping the entry's shape
 * (plain string spec vs `{ package, version, ... }` object).
 */
function applyPluginVersion(plugin: unknown, version: string): unknown {
  if (typeof plugin === "string") {
    const { name } = splitPackageSpec(plugin.trim());
    return `${name}@${version}`;
  }
  if (plugin && typeof plugin === "object" && !Array.isArray(plugin)) {
    const rec = plugin as Record<string, unknown>;
    const nameRaw = rec.package;
    if (typeof nameRaw === "string" && nameRaw.trim()) {
      const { name } = splitPackageSpec(nameRaw.trim());
      return { ...rec, package: name, version };
    }
  }
  // Unrecognized shape — pin as a plain package@version string.
  return `${String(plugin)}@${version}`;
}

async function fetchNpmLatestVersion(name: string): Promise<string> {
  // Scoped names need the slash percent-encoded for the registry URL.
  const encoded = name
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("%2F");
  const url = `https://registry.npmjs.org/${encoded}/latest`;
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`npm registry returned ${response.status}`);
  }
  const body = (await response.json()) as { version?: unknown };
  const version = body?.version;
  if (typeof version !== "string" || !version.trim()) {
    throw new Error("npm registry response missing version");
  }
  return version.trim();
}


