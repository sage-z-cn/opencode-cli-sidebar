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
import { l10n } from "../i18n";
import { resolveOpenCodeCliConfigPath } from "./openCodeConfigPath";
import { OutputChannelService } from "./OutputChannelService";
import { isVersionNewer } from "./semver";
import type { OpenCodeCliPluginUpdateInfo } from "../types";

/**
 * cli.json exists but cannot be read or parsed. Callers that report the
 * failure for one specific operation can recognize it and reword the message
 * while keeping the original text as `cause`.
 */
export class ConfigUnreadableError extends Error {
  public readonly cause: unknown;

  public constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "ConfigUnreadableError";
    this.cause = cause;
  }
}

export interface OpenCodeCliSettingsPayload {
  /** Effective values keyed by dotted path (defaults filled in). */
  values: Record<string, unknown>;
  /** Keys present in cli.json (true user overrides). */
  overrides: Record<string, boolean>;
  configPath: string;
  /** Theme options: builtin + discovered theme files. */
  themeOptions: OpenCodeCliSettingOption[];
  plugins: unknown[];
  /** Installed versions from OpenCode's npm cache, keyed by package name. */
  installedPluginVersions: Record<string, string>;
  /**
   * npm latest version for plugins that follow latest, keyed by package name.
   * `checkPluginUpdates` skips those entries, so the staleness hint needs its
   * own registry data. Lookup failures are omitted rather than reported.
   */
  pluginLatestVersions: Record<string, string>;
}

/** How long a registry `latest` answer is reused across settings loads. */
const PLUGIN_LATEST_CACHE_TTL_MS = 60_000;

/**
 * Reads/writes OpenCode cli.json settings other than `keybinds`.
 * Writing a value equal to the default removes the key.
 */
export class OpenCodeCliSettingsService {
  /**
   * Registry answers reused for `PLUGIN_LATEST_CACHE_TTL_MS`. `load()` runs
   * after every settings action, so without this each push would cost one
   * request per follow-latest plugin. The TTL keeps a fresh publish visible
   * within a minute.
   */
  private readonly latestVersionCache = new Map<
    string,
    { version: string; fetchedAt: number }
  >();

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

    // Both sources are independent I/O; one settings load must not serialize
    // disk reads behind registry calls.
    const [installedPluginVersions, pluginLatestVersions] = await Promise.all([
      this.loadInstalledPluginVersions(plugins),
      this.loadPluginLatestVersions(plugins),
    ]);

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
      installedPluginVersions,
      pluginLatestVersions,
    };
  }

  /**
   * Installed versions read from OpenCode's npm cache, keyed by package name.
   * The cache is a best-effort source: a missing or damaged entry is skipped so
   * it can never break the settings view. Reads are async so a cold cache does
   * not block the extension host.
   */
  public async loadInstalledPluginVersions(
    plugins: readonly unknown[],
  ): Promise<Record<string, string>> {
    const cacheDir = resolveOpenCodePluginCacheDir();
    const versions: Record<string, string> = {};
    for (const plugin of plugins) {
      const parsed = parsePluginSpec(plugin);
      if (!parsed) continue;
      const version = await this.readInstalledVersion(
        cacheDir,
        parsed.name,
        parsed.version,
      );
      if (version) {
        versions[parsed.name] = version;
      }
    }
    return versions;
  }

  /**
   * OpenCode caches one directory per installed spec. The configured spec is
   * tried first; `latest` is the fallback because a bare name maps to it and
   * because a pruned generation may leave only the tracking directory behind.
   */
  private async readInstalledVersion(
    cacheDir: string,
    name: string,
    spec: string | null,
  ): Promise<string | undefined> {
    const keys = spec && spec !== "latest" ? [spec, "latest"] : ["latest"];
    for (const key of keys) {
      const version = await this.readCacheGenerationVersion(
        path.join(cacheDir, pluginCacheKey(name, key)),
        name,
      );
      if (version) return version;
    }
    return undefined;
  }

  /** Highest numeric generation directory wins, matching OpenCode's own pick. */
  private async readCacheGenerationVersion(
    dir: string,
    name: string,
  ): Promise<string | undefined> {
    let entries: string[];
    try {
      entries = await fs.promises.readdir(dir);
    } catch (error) {
      this.logger.debug(
        `[OpenCodeCliSettingsService] No plugin cache at ${dir}: ${errorText(error)}`,
      );
      return undefined;
    }
    const generations = entries
      .filter((entry) => /^\d+$/.test(entry))
      .sort((a, b) => Number(a) - Number(b));
    const current = generations[generations.length - 1];
    if (!current) return undefined;
    const manifestPath = path.join(
      dir,
      current,
      "node_modules",
      name,
      "package.json",
    );
    try {
      const raw = await fs.promises.readFile(manifestPath, "utf8");
      const manifest = JSON.parse(raw) as unknown;
      if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
        return undefined;
      }
      const version = (manifest as { version?: unknown }).version;
      return typeof version === "string" && version.trim()
        ? version.trim()
        : undefined;
    } catch (error) {
      this.logger.debug(
        `[OpenCodeCliSettingsService] Cannot read plugin manifest ${manifestPath}: ${errorText(error)}`,
      );
      return undefined;
    }
  }

  /**
   * npm `latest` for the entries that follow latest, keyed by package name.
   * `checkPluginUpdates` deliberately skips those entries, so this is the only
   * registry data that can prove a cached install is behind npm. A failed or
   * unknown lookup is dropped instead of reported: the hint is optional and an
   * error row would duplicate the update-check surface.
   */
  public async loadPluginLatestVersions(
    plugins: readonly unknown[],
  ): Promise<Record<string, string>> {
    const names = new Set<string>();
    for (const plugin of plugins) {
      const parsed = parsePluginSpec(plugin);
      // Same rule as `checkPluginUpdates`: exact pins are checked elsewhere and
      // must not cost a second request here.
      if (!parsed || !followsLatest(parsed.version)) continue;
      names.add(parsed.name);
    }
    const entries = await Promise.all(
      [...names].map(async (name): Promise<[string, string] | null> => {
        const version = await this.lookupLatestVersion(name);
        return version ? [name, version] : null;
      }),
    );
    const versions: Record<string, string> = {};
    for (const entry of entries) {
      if (entry) versions[entry[0]] = entry[1];
    }
    return versions;
  }

  /**
   * Cached registry lookup. Only successes are cached so a transient network
   * failure cannot hide the hint for the whole TTL.
   */
  private async lookupLatestVersion(name: string): Promise<string | null> {
    const cached = this.latestVersionCache.get(name);
    if (cached && Date.now() - cached.fetchedAt < PLUGIN_LATEST_CACHE_TTL_MS) {
      return cached.version;
    }
    try {
      const version = await fetchNpmLatestVersion(name);
      this.latestVersionCache.set(name, { version, fetchedAt: Date.now() });
      return version;
    } catch (error) {
      this.latestVersionCache.delete(name);
      this.logger.debug(
        `[OpenCodeCliSettingsService] npm latest lookup failed for ${name}: ${errorText(error)}`,
      );
      return null;
    }
  }

  /**
   * Delete the `<name>@latest` cache directory so the next OpenCode start
   * reinstalls the plugin instead of reusing the stale install. Other specs,
   * including exact pins, are never touched.
   */
  public async clearPluginCache(name: string): Promise<void> {
    const pkg = name.trim();
    if (!pkg) {
      throw new Error("Plugin package name is required");
    }
    const cacheDir = path.resolve(resolveOpenCodePluginCacheDir());
    const key = pluginCacheKey(pkg, "latest");
    const target = path.resolve(cacheDir, key);
    const relative = path.relative(cacheDir, target);
    // The key must stay a plain relative path inside the cache root: a `..`
    // segment, a drive change or an empty key could reach another directory.
    const plainSegments = key
      .split(/[\\/]/)
      .every((segment) => segment !== "" && segment !== "." && segment !== "..");
    const insideCacheRoot =
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative);
    if (!plainSegments || !insideCacheRoot) {
      this.logger.warn(
        `[OpenCodeCliSettingsService] Refusing to clear plugin cache for ${JSON.stringify(pkg)}: target ${target} is outside ${cacheDir}`,
      );
      throw new Error(
        l10n.t("This plugin cannot be refreshed from here."),
      );
    }
    if (!fs.existsSync(target)) {
      // Already clean: the click is idempotent and must not report a failure.
      return;
    }
    try {
      await fs.promises.rm(target, { recursive: true, force: true });
      this.latestVersionCache.delete(pkg);
    } catch (error) {
      this.logger.error(
        `[OpenCodeCliSettingsService] Cannot delete plugin cache ${target}: ${errorText(error)}`,
      );
      throw new Error(
        l10n.t(
          "Cannot delete the cached plugin files. Close any program that uses them and try again.",
        ),
      );
    }
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
    const incoming = parsePluginSpec(spec);
    if (!incoming) {
      throw new Error(`Invalid plugin package: "${spec}"`);
    }
    await this.mutateDoc((doc) => {
      const existing = Array.isArray(doc.plugins) ? (doc.plugins as unknown[]) : [];
      // Same package name is a duplicate regardless of the version spec, so
      // compare canonical names and ignore unusable entries.
      const duplicate = existing.some(
        (entry) => parsePluginSpec(entry)?.name === incoming.name,
      );
      if (duplicate) {
        throw new Error(`Plugin "${incoming.name}" is already added.`);
      }
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
   * Pin a plugin entry to `version`, or keep it tracking npm. Entries that
   * already follow latest (no version, a range, or a dist-tag) stay unpinned so
   * the user's follow switch does not flip to pinned after an update. Pinned
   * entries get the version written into `package`.
   *
   * The index only selects the entry. The write itself targets the package
   * name, so a config rewritten in between cannot make the version land on a
   * different plugin that shifted into that index.
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
    try {
      const targetName = this.pluginNameAtIndex(index);
      await this.mutateDoc((doc) => {
        const existing = Array.isArray(doc.plugins)
          ? (doc.plugins as unknown[])
          : [];
        const target = existing.findIndex(
          (plugin) => parsePluginSpec(plugin)?.name === targetName,
        );
        if (target < 0) {
          throw new Error(`Plugin "${targetName}" is no longer configured.`);
        }
        doc.plugins = existing.map((plugin, i) => {
          if (i !== target) return plugin;
          const parsed = parsePluginSpec(plugin);
          // Follow-latest entries must not gain a version: OpenCode re-resolves
          // the registry on restart, so writing an exact pin would be a change
          // the user never asked for.
          if (parsed && followsLatest(parsed.version)) {
            return applyPluginFollowLatest(plugin);
          }
          return applyPluginVersion(plugin, ver);
        });
      });
    } catch (error) {
      if (error instanceof ConfigUnreadableError) {
        throw new ConfigUnreadableError(
          l10n.t(
            "Cannot update the plugin version because the OpenCode CLI config file cannot be read. Fix {0} and try again.",
            path.resolve(this.resolveConfigPath()),
          ),
          error,
        );
      }
      throw error;
    }
  }

  /**
   * Replace one entry's `options`. A string entry is promoted to
   * `{ package, options }` so the package and its version survive; an empty
   * object removes the field instead of writing `options: {}`.
   */
  public async setPluginOptions(
    index: number,
    options: Record<string, unknown>,
  ): Promise<void> {
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`Invalid plugin index: ${index}`);
    }
    await this.mutateDoc((doc) => {
      const existing = Array.isArray(doc.plugins) ? (doc.plugins as unknown[]) : [];
      if (index >= existing.length) {
        throw new Error(`Plugin index out of range: ${index}`);
      }
      doc.plugins = existing.map((plugin, i) =>
        i === index ? applyPluginOptions(plugin, options) : plugin,
      );
    });
  }

  /**
   * Package name configured at `index`. The index is only a selector: every
   * write resolves the entry by this name so a concurrent rewrite of cli.json
   * cannot redirect the write to a different plugin.
   */
  private pluginNameAtIndex(index: number): string {
    const doc = this.readDoc(this.resolveConfigPath());
    const plugins = Array.isArray(doc.plugins) ? (doc.plugins as unknown[]) : [];
    const plugin = plugins[index];
    if (plugin === undefined) {
      throw new Error(`Plugin index out of range: ${index}`);
    }
    const parsed = parsePluginSpec(plugin);
    if (!parsed) {
      throw new Error("This plugin entry cannot be updated.");
    }
    return parsed.name;
  }

  /**
   * Check npm for a newer version of every pinned plugin.
   * Entries that follow latest (no exact version in `package`) are skipped:
   * OpenCode resolves those from the registry on its own, so a manual check has
   * nothing actionable to report and no result entry is returned for them.
   * Unreadable entries are still checked so their `Unrecognized plugin entry`
   * error stays visible.
   * An unreadable config rejects instead of reporting an empty list: without
   * the plugin list there is nothing to check, and an empty result would read
   * as "no plugins installed".
   */
  public async checkPluginUpdates(): Promise<OpenCodeCliPluginUpdateInfo[]> {
    const configPath = this.resolveConfigPath();
    const doc = this.readDoc(configPath);
    const plugins = Array.isArray(doc.plugins) ? (doc.plugins as unknown[]) : [];
    const pinned = plugins.filter((plugin) => {
      const parsed = parsePluginSpec(plugin);
      // Same rule as `followsLatest` so the check list cannot drift from the
      // auto-update switch the user sees.
      return parsed ? !followsLatest(parsed.version) : true;
    });
    return Promise.all(
      pinned.map((plugin) => this.checkOnePlugin(plugin)),
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

  /**
   * Read cli.json. A missing file is an empty config; an existing file that
   * cannot be parsed throws, because returning `{}` would render every setting
   * as its default and silently hide the damage from the user.
   */
  private readDoc(configPath: string): Record<string, unknown> {
    if (!fs.existsSync(configPath)) {
      return {};
    }
    let raw: string;
    try {
      raw = fs.readFileSync(configPath, "utf8");
    } catch (error) {
      throw this.configUnreadableError(configPath, error);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw this.configUnreadableError(configPath, error);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.logger.error(
        `[OpenCodeCliSettingsService] Refusing ${configPath}: top-level JSON value is not an object`,
      );
      throw new Error(
        l10n.t(
          "The OpenCode CLI config file must contain a JSON object. Fix {0} and reload.",
          path.resolve(configPath),
        ),
      );
    }
    return parsed as Record<string, unknown>;
  }

  /**
   * Log the technical cause and return a message the user can act on. The raw
   * parser message stays in the log; the user text only names the file.
   */
  private configUnreadableError(
    configPath: string,
    cause: unknown,
  ): ConfigUnreadableError {
    const detail = cause instanceof Error ? cause.message : String(cause);
    this.logger.error(
      `[OpenCodeCliSettingsService] Cannot parse ${configPath}: ${detail}`,
    );
    const message = l10n.t(
      "Cannot read the OpenCode CLI config file. Fix the JSON syntax in {0} and reload.",
      path.resolve(configPath),
    );
    return new ConfigUnreadableError(message, cause);
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

/**
 * Parse a plugin entry (`"pkg"` / `"pkg@1.0.0"` / `{ package: "pkg@1.0.0" }`).
 * OpenCode v2 only honors a version embedded in `package`; an object `version`
 * field is silently ignored by the runtime, so it is ignored here as well.
 */
export function parsePluginSpec(plugin: unknown): {
  name: string;
  version: string | null;
} | null {
  if (typeof plugin === "string") {
    return splitPackageSpec(plugin);
  }
  if (plugin && typeof plugin === "object" && !Array.isArray(plugin)) {
    const nameRaw = (plugin as { package?: unknown }).package;
    if (typeof nameRaw === "string" && nameRaw.trim()) {
      return splitPackageSpec(nameRaw.trim());
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

/** A single exact semver pin, as opposed to a range or a dist-tag. */
function isExactVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version);
}

/**
 * Whether the entry stays on OpenCode's update path. No version, a range such
 * as `^1.2.0` and a dist-tag such as `latest` all resolve through the registry;
 * only a single exact version pins the entry and stops the checks.
 */
function followsLatest(version: string | null): boolean {
  return version === null || !isExactVersion(version);
}

/**
 * Rewrite one plugin entry to pin `version`, keeping the entry's shape
 * (plain string spec vs `{ package, options, ... }` object). The version is
 * written into `package` because OpenCode v2 ignores an object `version`
 * field; a leftover `version` field is dropped from the result.
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
      const next: Record<string, unknown> = { ...rec, package: `${name}@${version}` };
      delete next.version;
      return next;
    }
  }
  // Unrecognized shape — pin as a plain package@version string.
  return `${String(plugin)}@${version}`;
}

/**
 * Rewrite one plugin entry to follow npm again: the version part is removed
 * from `package` while the entry shape and every other field are preserved.
 * A legacy object `version` field is dropped as well.
 */
function applyPluginFollowLatest(plugin: unknown): unknown {
  if (typeof plugin === "string") {
    const spec = plugin.trim();
    if (!spec) {
      throw new Error("This plugin entry cannot change its update setting.");
    }
    return splitPackageSpec(spec).name;
  }
  if (plugin && typeof plugin === "object" && !Array.isArray(plugin)) {
    const rec = plugin as Record<string, unknown>;
    const nameRaw = rec.package;
    if (typeof nameRaw === "string" && nameRaw.trim()) {
      const next: Record<string, unknown> = {
        ...rec,
        package: splitPackageSpec(nameRaw.trim()).name,
      };
      delete next.version;
      return next;
    }
  }
  throw new Error("This plugin entry cannot change its update setting.");
}

/**
 * Replace one entry's `options`. A string entry becomes an object so the
 * package string, including any pinned version, survives; an empty object
 * removes the field instead of writing `options: {}`.
 */
function applyPluginOptions(
  plugin: unknown,
  options: Record<string, unknown>,
): unknown {
  const hasOptions = Object.keys(options).length > 0;
  if (typeof plugin === "string") {
    const spec = plugin.trim();
    if (!spec) {
      throw new Error("This plugin entry cannot store options.");
    }
    if (!hasOptions) return plugin;
    return { package: spec, options };
  }
  if (plugin && typeof plugin === "object" && !Array.isArray(plugin)) {
    const rec = plugin as Record<string, unknown>;
    const nameRaw = rec.package;
    if (typeof nameRaw !== "string" || !nameRaw.trim()) {
      throw new Error("This plugin entry cannot store options.");
    }
    const next: Record<string, unknown> = { ...rec };
    if (hasOptions) {
      next.options = options;
    } else {
      delete next.options;
    }
    return next;
  }
  throw new Error("This plugin entry cannot store options.");
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Directory OpenCode installs npm plugins into. OpenCode resolves its cache
 * root through XDG on every platform, including Windows, so
 * `%LOCALAPPDATA%` must not be consulted here.
 */
function resolveOpenCodePluginCacheDir(): string {
  const cacheRoot =
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(cacheRoot, "opencode", "npm");
}

/** Characters Windows rejects in a file name. */
const WINDOWS_ILLEGAL_PATH_CHARS = new Set(["<", ">", ":", '"', "|", "?", "*"]);

/**
 * Cache-key sanitizing mirroring OpenCode's `sanitize`: only Windows rewrites
 * characters, and control characters always become `_`.
 */
function sanitizeCacheKey(value: string): string {
  if (process.platform !== "win32") return value;
  return Array.from(value, (char) =>
    WINDOWS_ILLEGAL_PATH_CHARS.has(char) || char.charCodeAt(0) < 32 ? "_" : char,
  ).join("");
}

/** `<name>@<spec>` cache directory name, sanitized the way OpenCode does. */
function pluginCacheKey(name: string, spec: string): string {
  return sanitizeCacheKey(`${name}@${spec}`);
}


