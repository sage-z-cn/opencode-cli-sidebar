/**
 * OpenCode CLI Settings modal (cli.json non-keybind settings).
 * Browser-only; communicates via WebviewMessage.
 */
import type {
  HostMessage,
  OpenCodeCliPluginUpdateInfo,
  OpenCodeCliSettingItem,
  OpenCodeCliSettingOption,
  OpenCodeCliSettingsGroupMeta,
  OpenCodeThemeSwatch,
} from "../../types";
import { postMessage } from "../shared/vscode-api";
import { ICONS, icon } from "../shared/icons";
import { openKeymapModal } from "../keymap";

const l10nStrings: Record<string, string> =
  (typeof window !== "undefined"
    ? (window as unknown as { __OC_CLI_SETTINGS_L10N__?: Record<string, string> })
        .__OC_CLI_SETTINGS_L10N__
    : undefined) ?? {};

function t(key: string, fallback: string): string {
  return l10nStrings[key] ?? fallback;
}

function formatMessage(
  template: string,
  ...values: Array<string | number>
): string {
  return template.replace(/\{(\d+)\}/g, (match, index: string) => {
    const value = values[Number(index)];
    return value === undefined ? match : String(value);
  });
}

type SettingsState = {
  items: OpenCodeCliSettingItem[];
  groups: OpenCodeCliSettingsGroupMeta[];
  values: Record<string, unknown>;
  overrides: Record<string, boolean>;
  configPath: string;
  themeOptions: OpenCodeCliSettingOption[];
  plugins: unknown[];
  /** npm version check results, aligned with `plugins` by index. */
  pluginUpdates: OpenCodeCliPluginUpdateInfo[] | null;
  /** Actually installed versions keyed by package name, from OpenCode's cache. */
  installedPluginVersions: Record<string, string>;
};

const state: SettingsState = {
  items: [],
  groups: [],
  values: {},
  overrides: {},
  configPath: "",
  themeOptions: [],
  plugins: [],
  pluginUpdates: null,
  installedPluginVersions: {},
};

let pluginAddFormOpen = false;
let pluginCheckPending = false;
/** Row index awaiting inline remove confirmation; null when no row is armed. */
let pendingRemoveIndex: number | null = null;
/** Rows whose detail panel is expanded, keyed by package name. */
const expandedPlugins = new Set<string>();
/**
 * Optimistic auto-update intent per package name. It stays out of
 * `state.plugins` because the webview must not guess the exact spec the host
 * writes when pinning or unpinning; the next host push clears the map.
 */
const pluginAutoUpdateOverrides = new Map<string, boolean>();
/** Optimistic options per package name, same lifecycle as the auto-update map. */
const pluginOptionsOverrides = new Map<string, Record<string, unknown>>();

/** Options JSON editor, open for at most one plugin row at a time. */
type PluginOptionsEditor = {
  name: string;
  draft: string;
  error: string | null;
};

let pluginOptionsEditor: PluginOptionsEditor | null = null;

/**
 * Last plugin-list mutation applied optimistically and not yet confirmed by
 * the host. A failed save reverts exactly this one entry, using the recorded
 * position rather than a value lookup so duplicate package names stay safe.
 */
type OptimisticPluginMutation =
  | { kind: "add"; index: number; value: unknown }
  | {
      kind: "remove";
      index: number;
      value: unknown;
      name: string;
      restartVersion: string | undefined;
      updateInfo: OpenCodeCliPluginUpdateInfo | undefined;
    }
  | {
      kind: "autoUpdate";
      index: number;
      name: string;
      autoUpdate: boolean;
      /** Override active before this write; null when the row had none. */
      previous: boolean | null;
    }
  | {
      kind: "options";
      index: number;
      name: string;
      options: Record<string, unknown>;
      /** Override active before this write; null when the row had none. */
      previous: Record<string, unknown> | null;
    };

let pendingOptimisticPlugin: OptimisticPluginMutation | null = null;
/** Plugin name → new version, for rows that need a restart after update. */
const pluginRestartPending = new Map<string, string>();

/**
 * Drop loaded config state after a failed load. Keeping the previous values
 * would show default settings as if they were the real configuration, and an
 * empty plugin list would read as "nothing configured" instead of "cli.json
 * cannot be read".
 */
function resetLoadedState(): void {
  state.items = [];
  state.groups = [];
  state.values = {};
  state.overrides = {};
  state.plugins = [];
  state.pluginUpdates = null;
  state.installedPluginVersions = {};
  pluginAddFormOpen = false;
  pluginCheckPending = false;
  pendingRemoveIndex = null;
  pendingOptimisticPlugin = null;
  pluginOptionsEditor = null;
  expandedPlugins.clear();
  pluginAutoUpdateOverrides.clear();
  pluginOptionsOverrides.clear();
  pluginRestartPending.clear();
}

const THEME_PREVIEW_DEBOUNCE_MS = 280;

type ThemePickerState = {
  open: boolean;
  /** Value when the dropdown opened — restored on Escape. */
  originalValue: string;
  activeValue: string;
  timer: ReturnType<typeof setTimeout> | null;
};

const themePicker: ThemePickerState = {
  open: false,
  originalValue: "",
  activeValue: "",
  timer: null,
};

let activeGroup = "appearance";
let settingsOpen = false;
/** True once the host has delivered settings data at least once this session. */
let settingsLoaded = false;
/**
 * True after a failed host load. Nothing on screen is trustworthy then: the
 * stored values may be stale and the plugin list would look empty even though
 * cli.json exists and is only unparsable.
 */
let settingsLoadFailed = false;
let syncingNav = false;
let pendingRerender = false;
let pendingRerenderTimer: ReturnType<typeof setTimeout> | null = null;
let navScrollTarget: number | null = null;
let navScrollUnlockTimer: ReturnType<typeof setTimeout> | null = null;

function $(sel: string): HTMLElement | null {
  return document.querySelector(sel);
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) < 1e-9;
  }
  return false;
}

function formatVal(v: unknown): string {
  if (v === undefined || v === null || v === "") return "—";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

function isOverride(id: string): boolean {
  return Boolean(state.overrides[id]);
}

function effectiveValue(item: OpenCodeCliSettingItem): unknown {
  const v = state.values[item.id];
  return v === undefined ? item.def : v;
}

function showSettingsError(message: string): void {
  const box = $("#occs-error");
  const text = $("#occs-error-text");
  $("#occs-reload")?.classList.remove("is-spinning");
  if (text) text.textContent = message;
  box?.classList.remove("hidden");
  setLoadingVisible(false);
}

function hideSettingsError(): void {
  $("#occs-error")?.classList.add("hidden");
}

function setLoadingVisible(visible: boolean): void {
  $("#occs-loading")?.classList.toggle("hidden", !visible);
  $("#occs-list")?.classList.toggle("is-loading", visible);
}

function updateConfigPathUi(): void {
  const pathEl = $("#occs-path");
  if (!pathEl) return;
  const path = state.configPath;
  pathEl.textContent = path;
  // Hide the empty pill/link rather than rendering a blank capsule.
  pathEl.classList.toggle("hidden", !path);
}

/** Persist one setting. Value equal to default deletes the key. */
function persist(item: OpenCodeCliSettingItem, value: unknown): void {
  if (sameValue(value, item.def)) {
    postMessage({ type: "resetOpenCodeCliSetting", path: item.id });
    return;
  }
  postMessage({ type: "saveOpenCodeCliSetting", path: item.id, value });
}

function themeItem(): OpenCodeCliSettingItem | undefined {
  return itemById("theme.name");
}

function currentThemeValue(): string {
  return String(state.values["theme.name"] ?? "");
}

function clearThemePreviewTimer(): void {
  if (themePicker.timer !== null) {
    clearTimeout(themePicker.timer);
    themePicker.timer = null;
  }
}

function updateThemeTriggerUi(value: string): void {
  const trigger = document.querySelector("[data-oc-theme-trigger]");
  if (!trigger) return;
  const opt = state.themeOptions.find((o) => o.value === value);
  const dots = trigger.querySelector(".occs-theme-dots");
  if (dots && opt) {
    dots.outerHTML = swatchDotsHtml(opt.swatch, "is-trigger");
  }
  const label = trigger.querySelector(".occs-theme-label");
  if (label) label.textContent = opt?.label || value || "Default";
}

function setActiveThemeOption(value: string, schedulePreview: boolean): void {
  themePicker.activeValue = value;
  document.querySelectorAll("[data-oc-theme-opt]").forEach((el) => {
    const on = (el as HTMLElement).dataset.ocThemeOpt === value;
    el.classList.toggle("is-active", on);
    if (on) {
      el.scrollIntoView({ block: "nearest" });
    }
  });
  updateThemeTriggerUi(value);
  if (!schedulePreview) return;
  clearThemePreviewTimer();
  themePicker.timer = setTimeout(() => {
    themePicker.timer = null;
    const item = themeItem();
    if (!item) return;
    persist(item, value);
  }, THEME_PREVIEW_DEBOUNCE_MS);
}

function openThemePicker(): void {
  const menu = document.querySelector("[data-oc-theme-menu]");
  const trigger = document.querySelector("[data-oc-theme-trigger]");
  if (!menu || !trigger) return;
  themePicker.open = true;
  themePicker.originalValue = currentThemeValue();
  themePicker.activeValue = themePicker.originalValue;
  menu.classList.remove("hidden");
  trigger.setAttribute("aria-expanded", "true");
  document.getElementById("occs-overlay")?.classList.add("is-preview");
  setActiveThemeOption(themePicker.activeValue, false);
}

function closeThemePicker(options?: { restore?: boolean }): void {
  clearThemePreviewTimer();
  const menu = document.querySelector("[data-oc-theme-menu]");
  const trigger = document.querySelector("[data-oc-theme-trigger]");
  menu?.classList.add("hidden");
  trigger?.setAttribute("aria-expanded", "false");
  document.getElementById("occs-overlay")?.classList.remove("is-preview");
  document.querySelectorAll("[data-oc-theme-opt]").forEach((el) => {
    el.classList.remove("is-active");
  });
  if (options?.restore) {
    const item = themeItem();
    if (item && themePicker.activeValue !== themePicker.originalValue) {
      persist(item, themePicker.originalValue);
      updateThemeTriggerUi(themePicker.originalValue);
    }
  }
  themePicker.open = false;
  themePicker.activeValue = "";
  // A deferred settings re-render was blocked by the open picker.
  flushPendingRerender();
}

function commitThemeChoice(value: string): void {
  clearThemePreviewTimer();
  const item = themeItem();
  if (item) {
    persist(item, value);
  }
  updateThemeTriggerUi(value);
  closeThemePicker();
}

function themePickerIndexDelta(delta: number): void {
  const options = state.themeOptions;
  if (!options.length) return;
  const idx = options.findIndex((o) => o.value === themePicker.activeValue);
  const next = options[(idx + delta + options.length) % options.length];
  if (next) {
    setActiveThemeOption(next.value, true);
  }
}

function swatchDotsHtml(swatch?: OpenCodeThemeSwatch, extraClass = ""): string {
  const colors = [swatch?.bg, swatch?.panel, swatch?.primary, swatch?.accent]
    .filter((c): c is string => Boolean(c))
    .slice(0, 3);
  if (!colors.length) {
    return `<span class="occs-theme-dots ${extraClass}"></span>`;
  }
  const dots = colors
    .map((c) => `<i style="background:${escapeHtml(c)}"></i>`)
    .join("");
  return `<span class="occs-theme-dots ${extraClass}">${dots}</span>`;
}

function themePickerHtml(current: string): string {
  const options = state.themeOptions;
  const active = options.find((o) => o.value === current) ?? options[0];
  const activeLabel = active?.label || current || t("defaultLabel", "Default");
  const list = options
    .map((opt) => {
      const selected = opt.value === current ? " is-selected" : "";
      return `<div class="occs-theme-option${selected}" role="option" data-oc-theme-opt="${escapeHtml(opt.value)}" aria-selected="${opt.value === current}">
        ${swatchDotsHtml(opt.swatch)}
        <span class="occs-theme-option-label">${escapeHtml(opt.label)}</span>
      </div>`;
    })
    .join("");
  return `<div class="occs-theme-picker" data-oc-theme-picker>
    <button type="button" class="occs-theme-trigger" data-oc-theme-trigger aria-haspopup="listbox" aria-expanded="false">
      ${swatchDotsHtml(active?.swatch, "is-trigger")}
      <span class="occs-theme-label">${escapeHtml(activeLabel)}</span>
      <span class="occs-theme-chevron" aria-hidden="true">▾</span>
    </button>
    <div class="occs-theme-menu hidden" data-oc-theme-menu role="listbox">${list}</div>
  </div>`;
}

function controlHtml(item: OpenCodeCliSettingItem): string {
  const val = effectiveValue(item);

  if (item.type === "boolean") {
    const on = Boolean(val);
    return `<label class="occs-toggle" title="${escapeHtml(item.title)}">
      <input type="checkbox" data-oc-cli-set="${escapeHtml(item.id)}"${on ? " checked" : ""} />
      <span class="slider"></span>
    </label>`;
  }

  if (item.id === "theme.name") {
    return themePickerHtml(String(val ?? ""));
  }

  if (item.type === "enum") {
    let options = item.options ?? [];
    let current = String(val ?? "");
    if (item.id === "debug.turn_tokens") {
      current = val === true ? "on" : val === "verbose" ? "verbose" : "off";
    }
    const opts = options
      .map((opt) => {
        const selected = opt.value === current ? " selected" : "";
        return `<option value="${escapeHtml(opt.value)}"${selected}>${escapeHtml(opt.label)}</option>`;
      })
      .join("");
    return `<select class="occs-select" data-oc-cli-set="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.title)}">${opts}</select>`;
  }

  if (item.type === "range") {
    const min = item.min ?? 0;
    const max = item.max ?? 1;
    const step = item.step ?? 0.05;
    const num = Number(val);
    return `<div class="occs-range-wrap">
      <input type="range" data-oc-cli-set="${escapeHtml(item.id)}" min="${min}" max="${max}" step="${step}" value="${num}" />
      <span class="occs-range-val">${num.toFixed(2)}</span>
    </div>`;
  }

  if (item.type === "number") {
    const num = Number(val);
    return `<input class="occs-number" type="number" data-oc-cli-set="${escapeHtml(item.id)}" value="${num}"${item.min !== undefined ? ` min="${item.min}"` : ""}${item.step !== undefined ? ` step="${item.step}"` : ""} />`;
  }

  if (item.type === "readonly") {
    // Advanced-config pointer: no editable control, only a jump into cli.json.
    // No data-oc-cli-set, so change/input/focusout delegation skips this button.
    return `<button type="button" class="occs-btn occs-readonly-btn" data-oc-cli-open="cliJson">${escapeHtml(t("editCliJson", "Edit cli.json"))}</button>`;
  }

  const text = val === undefined || val === null ? "" : String(val);
  return `<input class="occs-input" type="text" data-oc-cli-set="${escapeHtml(item.id)}" value="${escapeHtml(text)}" />`;
}

function rowHtml(item: OpenCodeCliSettingItem): string {
  const readonly = item.type === "readonly";
  // Readonly entries have no scalar default and are never override-tracked.
  const mod = !readonly && isOverride(item.id);
  return `<div class="occs-row${mod ? " is-modified" : ""}${readonly ? " is-readonly" : ""}" data-oc-cli-row="${escapeHtml(item.id)}">
    <div class="occs-row-info">
      <div class="occs-title-line">
        <span class="occs-row-title">${escapeHtml(item.title)}</span>
        <span class="occs-row-id">${escapeHtml(item.id)}</span>
      </div>
      <div class="occs-row-desc">${escapeHtml(item.desc)}</div>
      ${mod ? `<div class="occs-default-ghost">${escapeHtml(formatMessage(t("defaultLabel", "Default: {0}"), formatVal(item.def)))}</div>` : ""}
    </div>
    <div class="occs-row-control">${controlHtml(item)}</div>
  </div>`;
}

function keybindsSectionHtml(): string {
  return `<div class="occs-section">
    <div class="group-label" id="occs-group-keybinds">${escapeHtml(groupTitle("keybinds"))}</div>
    <div>
      <button type="button" class="occs-jump-link" id="occs-open-keymap">${escapeHtml(t("openKeymap", "Open keybindings"))} →</button>
    </div>
  </div>`;
}

/**
 * Display label for a plugin entry. Object entries keep the version inside
 * `package` (OpenCode v2 ignores an object `version` field), so the raw package
 * string is the label and `splitPluginLabel` can still split it.
 * Exported for tests.
 */
export function pluginLabel(plugin: unknown): string {
  if (typeof plugin === "string") return plugin;
  if (plugin && typeof plugin === "object") {
    const pkg = (plugin as { package?: unknown }).package;
    if (typeof pkg === "string" && pkg.trim()) return pkg.trim();
  }
  return String(plugin);
}

/** Split `name@version` / `@scope/name@version` for display. */
export function splitPluginLabel(label: string): { name: string; version: string } {
  const at = label.lastIndexOf("@");
  if (at > 0) {
    return { name: label.slice(0, at), version: label.slice(at) };
  }
  return { name: label, version: "" };
}

/**
 * Canonical plugin name for matching host update-check results. Object entries
 * read `package` directly, so the name stays version-free even when the
 * package string carries an `@version` suffix.
 */
export function pluginNameOf(plugin: unknown): string {
  if (plugin && typeof plugin === "object") {
    const pkg = (plugin as { package?: unknown }).package;
    if (typeof pkg === "string" && pkg.trim()) {
      return splitPluginLabel(pkg.trim()).name;
    }
  }
  return splitPluginLabel(pluginLabel(plugin)).name;
}

/**
 * Version pinned in the entry itself, null when unpinned. Only the `package`
 * string is consulted: OpenCode v2 ignores an object `version` field, so
 * trusting it would show a version the runtime never uses.
 */
function pluginPinnedVersion(plugin: unknown): string | null {
  let spec = "";
  if (typeof plugin === "string") {
    spec = plugin.trim();
  } else if (plugin && typeof plugin === "object" && !Array.isArray(plugin)) {
    const pkg = (plugin as { package?: unknown }).package;
    if (typeof pkg === "string") spec = pkg.trim();
  }
  if (!spec) return null;
  const at = spec.lastIndexOf("@");
  if (at > 0) return spec.slice(at + 1) || null;
  return null;
}

/** Find update-check info by plugin name (entries may no longer align by index). */
function pluginUpdateInfoOf(name: string): OpenCodeCliPluginUpdateInfo | undefined {
  return state.pluginUpdates?.find((info) => info.name === name);
}

/** Keep update-check entries that still match the freshly loaded plugin list. */
function reconcilePluginUpdates(
  updates: OpenCodeCliPluginUpdateInfo[] | null,
  plugins: unknown[],
): OpenCodeCliPluginUpdateInfo[] | null {
  if (!updates) return null;
  const kept = updates.filter((info) => {
    if (pluginRestartPending.has(info.name)) return false;
    const plugin = plugins.find((p) => pluginNameOf(p) === info.name);
    if (!plugin) return false;
    return pluginPinnedVersion(plugin) === (info.current ?? null);
  });
  return kept.length ? kept : null;
}

/** Exact semver pin; anything else counts as a range or a dist-tag. */
function isExactVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version);
}

/**
 * Whether OpenCode keeps checking npm for this entry. A missing version, a
 * range such as `^1.2.0` or a dist-tag such as `latest` stays on the update
 * path; only a single exact version pins the entry and stops the checks.
 */
function pluginFollowsLatest(plugin: unknown): boolean {
  const version = pluginPinnedVersion(plugin);
  return !version || !isExactVersion(version);
}

/** Effective auto-update state, honouring an in-flight optimistic toggle. */
function pluginFollowsLatestState(plugin: unknown, name: string): boolean {
  return pluginAutoUpdateOverrides.get(name) ?? pluginFollowsLatest(plugin);
}

/** `options` of an object entry, null when the entry carries none. */
function pluginOptionsOf(plugin: unknown): Record<string, unknown> | null {
  if (plugin && typeof plugin === "object" && !Array.isArray(plugin)) {
    const options = (plugin as { options?: unknown }).options;
    if (options && typeof options === "object" && !Array.isArray(options)) {
      return options as Record<string, unknown>;
    }
  }
  return null;
}

/** Options as currently rendered, including an optimistic replacement. */
function effectivePluginOptions(
  plugin: unknown,
  name: string,
): Record<string, unknown> | null {
  return pluginOptionsOverrides.get(name) ?? pluginOptionsOf(plugin);
}

/**
 * Version chip. The version written in cli.json wins because the user put it
 * there; when the entry follows latest it carries no version, so the version
 * actually installed in OpenCode's cache is shown instead. Nothing renders when
 * neither is known.
 */
function pluginVersionHtml(plugin: unknown, name: string): string {
  const pinned = pluginPinnedVersion(plugin);
  if (pinned) {
    const title = isExactVersion(pinned)
      ? t("currentVersion", "Current version")
      : t("versionRange", "Version range");
    return `<span class="occs-plugin-ver" title="${escapeHtml(title)}">${escapeHtml(pinned)}</span>`;
  }
  const installed = state.installedPluginVersions[name];
  if (!installed) return "";
  const title = t("installedVersion", "Installed version");
  return `<span class="occs-plugin-ver" title="${escapeHtml(title)}">${escapeHtml(installed)}</span>`;
}

/** Follow-latest switch. Its label is constant; the switch carries the state. */
function pluginAutoUpdateHtml(index: number, follows: boolean): string {
  const id = `occs-plugin-auto-${index}`;
  const label = escapeHtml(t("followLatest", "Auto update"));
  // The 24h caveat lives in the tooltip so the row keeps a single line.
  const tip = escapeHtml(
    t(
      "followLatestHint",
      "Turning this on makes OpenCode check for updates and install the latest version on its next start.",
    ),
  );
  return `<div class="occs-plugin-auto" title="${tip}">
    <label class="occs-toggle">
      <input type="checkbox" id="${id}" data-oc-plugin-autoupdate="${index}" aria-label="${label}"${follows ? " checked" : ""} />
      <span class="slider"></span>
    </label>
    <label class="occs-plugin-auto-label" for="${id}">${label}</label>
  </div>`;
}

/** Right side of the meta line: restart, update availability, or nothing yet. */
function pluginStatusHtml(
  name: string,
  info: OpenCodeCliPluginUpdateInfo | undefined,
): string {
  if (pluginRestartPending.has(name)) {
    return `<span class="occs-plugin-status is-restart">${escapeHtml(t("restartRequired", "Restart required"))}</span>
      <button type="button" class="occs-plugin-link" data-oc-plugin-restart="1" title="${escapeHtml(t("restartToTakeEffect", "Restart OpenCode to take effect"))}">${escapeHtml(t("restartOpenCode", "Restart OpenCode"))}</button>`;
  }
  if (!info) return "";
  if (info.error) {
    return `<span class="occs-plugin-status is-error" title="${escapeHtml(info.error)}">${escapeHtml(t("checkFailed", "Check failed"))}</span>`;
  }
  if (info.hasUpdate && info.latest) {
    return `<span class="occs-plugin-status is-update">${escapeHtml(formatMessage(t("newVersion", "New version {0}"), info.latest))}</span>`;
  }
  if (info.latest) {
    return `<span class="occs-plugin-status is-ok" title="${escapeHtml(formatMessage(t("latestLabel", "latest: {0}"), info.latest))}">${escapeHtml(t("upToDate", "Up to date"))}</span>`;
  }
  return "";
}

/**
 * Row actions for one plugin entry. `index` is the real array position handed
 * down by `pluginsSectionHtml`, not a name lookup, so duplicate package names
 * cannot target the wrong row.
 */
function pluginActionsHtml(name: string, index: number): string {
  const info = pluginUpdateInfoOf(name);
  const canUpdate =
    !pluginRestartPending.has(name) && Boolean(info?.hasUpdate && info?.latest);
  const updateBtn = canUpdate
    ? `<button type="button" class="occs-btn occs-btn-compact occs-btn-accent" data-oc-plugin-update="${index}" data-oc-plugin-update-name="${escapeHtml(name)}" data-oc-plugin-version="${escapeHtml(info?.latest ?? "")}" title="${escapeHtml(formatMessage(t("newVersion", "New version {0}"), info?.latest ?? ""))}">${escapeHtml(t("updateVersion", "Update"))}</button>`
    : "";
  return `<div class="occs-plugin-actions">
    ${updateBtn}
    <button type="button" class="occs-icon-btn occs-plugin-remove" data-oc-plugin-remove="${index}" title="${escapeHtml(t("removePlugin", "Remove plugin"))}" aria-label="${escapeHtml(t("removePlugin", "Remove plugin"))}">${icon(ICONS.trash, 13)}</button>
  </div>`;
}

/** Inline remove confirmation, rendered in the meta line of the armed row. */
function pluginRemoveConfirmHtml(index: number): string {
  return `<div class="occs-plugin-confirm">
    <span class="occs-plugin-remove-label">${escapeHtml(t("confirmRemovePlugin", "Remove this plugin?"))}</span>
    <button type="button" class="occs-btn occs-btn-compact occs-btn-danger" data-oc-plugin-remove-confirm="${index}">${escapeHtml(t("remove", "Remove"))}</button>
    <button type="button" class="occs-btn occs-btn-compact" data-oc-plugin-remove-cancel="1">${escapeHtml(t("cancel", "Cancel"))}</button>
  </div>`;
}

function pluginOptionRowHtml(
  index: number,
  key: string,
  value: unknown,
): string {
  const label = escapeHtml(key);
  const attrs = `data-oc-plugin-opt="${index}" data-oc-opt-key="${label}"`;
  let control: string;
  if (typeof value === "boolean") {
    control = `<label class="occs-toggle"><input type="checkbox" ${attrs} data-oc-opt-type="boolean" aria-label="${label}"${value ? " checked" : ""} /><span class="slider"></span></label>`;
  } else if (typeof value === "number") {
    control = `<input class="occs-input occs-plugin-opt-input" type="number" step="any" ${attrs} data-oc-opt-type="number" aria-label="${label}" value="${escapeHtml(String(value))}" />`;
  } else if (typeof value === "string") {
    control = `<input class="occs-input occs-plugin-opt-input" type="text" ${attrs} data-oc-opt-type="string" aria-label="${label}" value="${escapeHtml(value)}" />`;
  } else if (value === null || value === undefined) {
    control = `<input class="occs-input occs-plugin-opt-input" type="text" ${attrs} data-oc-opt-type="string" aria-label="${label}" placeholder="null" />`;
  } else {
    // Objects and arrays have no general purpose widget; the JSON editor keeps
    // their shape intact instead of guessing a per-type form.
    control = `<button type="button" class="occs-btn occs-btn-compact" data-oc-plugin-options-json="${index}">${escapeHtml(t("editAsJson", "Edit as JSON"))}</button>`;
  }
  return `<div class="occs-plugin-opt">
    <span class="occs-plugin-opt-key" title="${label}">${label}</span>
    <div class="occs-plugin-opt-control">${control}</div>
  </div>`;
}

function pluginOptionsJsonHtml(editor: PluginOptionsEditor): string {
  const error = editor.error
    ? `<div class="occs-plugin-json-error" id="occs-plugin-options-error">${escapeHtml(editor.error)}</div>`
    : `<div class="occs-plugin-json-error hidden" id="occs-plugin-options-error"></div>`;
  return `<div class="occs-plugin-json">
    <textarea class="occs-plugin-json-input" id="occs-plugin-options-json" data-oc-plugin-options-draft="1" rows="5" spellcheck="false" aria-label="${escapeHtml(t("pluginOptions", "Plugin options"))}">${escapeHtml(editor.draft)}</textarea>
    ${error}
    <div class="occs-plugin-json-hint">${escapeHtml(t("optionsJsonHint", "Saving replaces all options for this plugin."))}</div>
    <div class="occs-plugin-json-actions">
      <button type="button" class="occs-btn occs-btn-compact occs-btn-primary" data-oc-plugin-options-save="1">${escapeHtml(t("save", "Save"))}</button>
      <button type="button" class="occs-btn occs-btn-compact" data-oc-plugin-options-cancel="1">${escapeHtml(t("cancel", "Cancel"))}</button>
    </div>
  </div>`;
}

/** Expanded panel: the plugin's own options, either as a roster or as JSON. */
function pluginDetailHtml(
  plugin: unknown,
  index: number,
  name: string,
): string {
  const options = effectivePluginOptions(plugin, name);
  const keys = options ? Object.keys(options) : [];
  const editor =
    pluginOptionsEditor && pluginOptionsEditor.name === name
      ? pluginOptionsEditor
      : null;
  let body: string;
  if (editor) {
    body = pluginOptionsJsonHtml(editor);
  } else if (!options || !keys.length) {
    body = `<div class="occs-plugin-options-empty">${escapeHtml(t("noOptions", "No options added yet."))}</div>`;
  } else {
    body = `<div class="occs-plugin-options-list">${keys
      .map((key) => pluginOptionRowHtml(index, key, options[key]))
      .join("")}</div>`;
  }
  const count = keys.length
    ? `<span class="occs-plugin-options-count">${escapeHtml(formatMessage(t("optionsCount", "{0} options"), keys.length))}</span>`
    : "";
  // With no options yet the button opens the same JSON editor on `{}`.
  const action = editor
    ? ""
    : `<div class="occs-plugin-options-actions">
        <button type="button" class="occs-btn occs-btn-compact" data-oc-plugin-options-json="${index}">${escapeHtml(keys.length ? t("editAsJson", "Edit as JSON") : t("addOptions", "Add options"))}</button>
      </div>`;
  return `<div class="occs-plugin-detail" id="occs-plugin-detail-${index}">
    <div class="occs-plugin-options-head">
      <span class="occs-plugin-options-title">${escapeHtml(t("pluginOptions", "Plugin options"))}</span>
      ${count}
      ${action}
    </div>
    ${body}
  </div>`;
}

function pluginItemHtml(plugin: unknown, index: number): string {
  const name = pluginNameOf(plugin);
  const open = expandedPlugins.has(name);
  const armed = index === pendingRemoveIndex;
  const follows = pluginFollowsLatestState(plugin, name);
  const info = pluginUpdateInfoOf(name);
  const detail =
    open && !armed ? pluginDetailHtml(plugin, index, name) : "";
  // The meta line lives on the name row, so the row stays one line tall until
  // the options panel is expanded.
  const meta = armed
    ? pluginRemoveConfirmHtml(index)
    : `${pluginVersionHtml(plugin, name)}${pluginAutoUpdateHtml(index, follows)}${pluginStatusHtml(name, info)}`;
  return `<div class="occs-plugin-item${open ? " is-open" : ""}" data-oc-plugin-index="${index}">
    <div class="occs-plugin-head">
      <button type="button" class="occs-plugin-toggle" data-oc-plugin-expand="${index}" aria-expanded="${open}"${open ? ` aria-controls="occs-plugin-detail-${index}"` : ""} title="${escapeHtml(name)}">
        <span class="occs-plugin-chevron" aria-hidden="true">${icon(ICONS.chevronDown, 12)}</span>
        <span class="occs-plugin-name">${escapeHtml(name)}</span>
      </button>
      <div class="occs-plugin-meta">${meta}</div>
      ${armed ? "" : pluginActionsHtml(name, index)}
    </div>
    ${detail}
  </div>`;
}

/** Drop per-row UI state that points at plugins no longer in the list. */
function prunePluginUiState(plugins: unknown[]): void {
  if (!expandedPlugins.size && !pluginOptionsEditor) return;
  const names = new Set(plugins.map((plugin) => pluginNameOf(plugin)));
  for (const name of expandedPlugins) {
    if (!names.has(name)) expandedPlugins.delete(name);
  }
  if (pluginOptionsEditor && !names.has(pluginOptionsEditor.name)) {
    pluginOptionsEditor = null;
  }
}

function pluginsSectionHtml(): string {
  const items = state.plugins
    .map((plugin, index) => pluginItemHtml(plugin, index))
    .join("");
  const empty = state.plugins.length
    ? ""
    : `<div class="occs-plugin-empty">
        <span class="occs-plugin-empty-title">${escapeHtml(t("noPlugins", "No plugins configured"))}</span>
        <span>${escapeHtml(t("pluginsEmptyHint", "Plugins extend OpenCode. Add an npm package name to install one."))}</span>
      </div>`;
  const addForm = pluginAddFormOpen
    ? `<div class="occs-plugin-add-form">
        <input class="occs-input occs-plugin-add-input" id="occs-plugin-add-input" type="text" placeholder="${escapeHtml(t("pluginPackagePlaceholder", "npm package name, e.g. @scope/plugin"))}" aria-label="${escapeHtml(t("addPlugin", "Add plugin"))}" />
        <div class="occs-plugin-add-actions">
          <button type="button" class="occs-btn occs-btn-primary occs-btn-compact" id="occs-plugin-add-confirm">${escapeHtml(t("addPlugin", "Add plugin"))}</button>
          <button type="button" class="occs-btn occs-btn-compact" id="occs-plugin-add-cancel">${escapeHtml(t("cancel", "Cancel"))}</button>
        </div>
      </div>`
    : "";
  const updatableCount = pluginUpdateAllQueue.length > 0
    ? pluginUpdateAllQueue.length
    : updatablePluginNames().length;
  const updateAllBtn = updatableCount > 0
    ? `<button type="button" class="occs-btn${pluginUpdateAllQueue.length ? " is-busy" : ""}" id="occs-plugin-update-all"${pluginUpdateAllQueue.length ? " disabled" : ""}>${escapeHtml(t("updateAll", "Update all"))}</button>`
    : "";
  return `<div class="occs-section occs-plugin-section">
    <div class="group-label" id="occs-group-plugins">${escapeHtml(groupTitle("plugins"))}</div>
    <div class="occs-plugin-toolbar">
      <button type="button" class="occs-btn occs-btn-primary" id="occs-plugin-add">${escapeHtml(t("addPlugin", "Add plugin"))}</button>
      <button type="button" class="occs-btn${pluginCheckPending ? " is-busy" : ""}" id="occs-plugin-check"${pluginCheckPending ? " disabled" : ""}>${escapeHtml(pluginCheckPending ? t("checkingUpdates", "Checking…") : t("checkUpdates", "Check updates"))}</button>
      ${updateAllBtn}
    </div>
    ${addForm}
    <div class="occs-plugin-list">${empty}${items}</div>
  </div>`;
}

function groupTitle(id: string): string {
  return state.groups.find((g) => g.id === id)?.title ?? id;
}

function renderNav(): void {
  const nav = $("#occs-side-nav");
  if (!nav) return;
  nav.innerHTML = state.groups
    .map((g) => {
      const on = g.id === activeGroup;
      return `<button type="button" class="sn-item${on ? " is-on" : ""}" data-group="${escapeHtml(g.id)}" aria-current="${on ? "true" : "false"}"><span>${escapeHtml(g.title)}</span></button>`;
    })
    .join("");
}

function renderList(): void {
  const list = $("#occs-list");
  if (!list) return;
  if (themePicker.open) {
    // Don't tear down an in-progress theme preview.
    return;
  }
  if (settingsLoadFailed) {
    // No data to render: the error banner above the list carries the message.
    // An empty body must not degrade into the "no plugins configured" state.
    list.innerHTML = "";
    setLoadingVisible(false);
    return;
  }
  if (!settingsLoaded) {
    // First open: host data is still in flight — keep the loading placeholder.
    list.innerHTML = "";
    setLoadingVisible(true);
    return;
  }
  setLoadingVisible(false);
  clearThemePreviewTimer();
  const scrollTop = list.scrollTop;
  let html = "";
  for (const group of state.groups) {
    if (group.id === "keybinds") {
      html += keybindsSectionHtml();
      continue;
    }
    if (group.id === "plugins") {
      html += pluginsSectionHtml();
      continue;
    }
    const rows = state.items.filter((item) => item.group === group.id);
    html += `<div class="occs-section">
      <div class="group-label" id="occs-group-${escapeHtml(group.id)}">${escapeHtml(group.title)}</div>
      ${rows.map((item) => rowHtml(item)).join("")}
    </div>`;
  }
  list.innerHTML = html;
  list.scrollTop = scrollTop;
}

function listEl(): HTMLElement | null {
  return $("#occs-list");
}

function isFocusInList(): boolean {
  const list = listEl();
  return Boolean(
    list &&
      document.activeElement instanceof Node &&
      list.contains(document.activeElement),
  );
}

/** Focused element accepts free text; re-rendering it would drop typing. */
function isTextEntryFocused(): boolean {
  if (!isFocusInList()) return false;
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) {
    // Buttons/checkbox/radio keep no draft text, so they may re-render.
    const type = el.type;
    return type !== "checkbox" && type !== "radio" && type !== "button";
  }
  return false;
}

type FocusSnapshot = {
  id: string;
  attrs: Array<[string, string]>;
  /** Nearest row-level ancestor, used to scope the attribute fallback. */
  anchor: { attr: string; value: string } | null;
};

/**
 * Row-level markers that identify the container a focused control lives in.
 * There is no data-oc-group in the rendered markup: groups carry ids only, so
 * data-oc-cli-row is the nearest row container for plain setting rows.
 */
const FOCUS_ANCHOR_ATTRS = [
  "data-oc-plugin-index",
  "data-oc-cli-row",
  "data-oc-cli-set",
];

/** Remember where focus was so a re-render can put it back on the same control. */
function captureFocusSnapshot(): FocusSnapshot | null {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return null;
  const list = listEl();
  if (!list || !list.contains(el)) return null;
  const attrs: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(el.dataset)) {
    if (value === undefined) continue;
    const attr = `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    attrs.push([attr, value]);
  }
  let anchor: { attr: string; value: string } | null = null;
  for (const attr of FOCUS_ANCHOR_ATTRS) {
    const holder = el.closest<HTMLElement>(`[${attr}]`);
    if (!holder || !list.contains(holder)) continue;
    const value = holder.getAttribute(attr);
    if (value !== null) {
      anchor = { attr, value };
      break;
    }
  }
  return { id: el.id, attrs, anchor };
}

/** Best-effort focus restore by id, then by identical data attributes. */
function restoreFocusSnapshot(snapshot: FocusSnapshot | null): void {
  if (!snapshot) return;
  const list = listEl();
  if (!list) return;
  if (snapshot.id) {
    const byId = document.getElementById(snapshot.id);
    if (byId instanceof HTMLElement && list.contains(byId)) {
      byId.focus();
      return;
    }
  }
  if (!snapshot.attrs.length) return;
  const matches = (root: ParentNode): HTMLElement | undefined => {
    const self = root instanceof HTMLElement ? root : null;
    if (
      self &&
      snapshot.attrs.every(([attr, value]) => self.getAttribute(attr) === value)
    ) {
      return self;
    }
    return Array.from(root.querySelectorAll<HTMLElement>("*")).find((el) =>
      snapshot.attrs.every(([attr, value]) => el.getAttribute(attr) === value),
    );
  };
  // Row-scoped search first: per-row markers such as data-oc-plugin-remove-cancel="1"
  // repeat on every row, so a global scan would land on the first row.
  const anchor = snapshot.anchor;
  if (anchor) {
    const scopes = Array.from(
      list.querySelectorAll<HTMLElement>(`[${anchor.attr}]`),
    ).filter((el) => el.getAttribute(anchor.attr) === anchor.value);
    for (const scope of scopes) {
      const hit = matches(scope);
      if (hit) {
        hit.focus();
        return;
      }
    }
  }
  matches(list)?.focus();
}

function flushPendingRerender(): void {
  if (!pendingRerender) return;
  if (navScrollTarget !== null) return;
  if (themePicker.open) return;
  if (pendingRerenderTimer !== null) {
    clearTimeout(pendingRerenderTimer);
    pendingRerenderTimer = null;
  }
  // A text control holds an uncommitted draft; the focusout handler flushes
  // once the user leaves it. Everything else may re-render right away.
  if (isTextEntryFocused()) return;
  pendingRerender = false;
  const focus = captureFocusSnapshot();
  renderNav();
  renderList();
  restoreFocusSnapshot(focus);
}

/** Safety net: a deferred re-render must still land without a later flush trigger. */
function schedulePendingRerenderFlush(): void {
  if (pendingRerenderTimer !== null) return;
  pendingRerenderTimer = setTimeout(() => {
    pendingRerenderTimer = null;
    flushPendingRerender();
  }, 0);
}

function scrollToGroup(groupId: string): void {
  const list = listEl();
  const label = document.getElementById(`occs-group-${groupId}`);
  if (!list || !label) return;
  // Anchor to the group's first data row: a sticky label pinned inside a
  // scrolled-past section reports a shifted rect, not its layout position.
  const row = label.nextElementSibling as HTMLElement | null;
  const anchor =
    row && row.classList.contains("occs-row")
      ? row
      : (label.nextElementSibling as HTMLElement) || label;
  syncingNav = true;
  if (navScrollUnlockTimer !== null) {
    clearTimeout(navScrollUnlockTimer);
  }
  activeGroup = groupId;
  renderNav();

  // Layout coordinate of the anchor (viewport-independent). Land the first
  // row below the stuck sticky label so the label does not cover it.
  const labelHeight = label.getBoundingClientRect().height;
  const top = Math.max(
    0,
    anchor.getBoundingClientRect().top -
      list.getBoundingClientRect().top +
      list.scrollTop -
      (anchor === label ? 0 : labelHeight + 4),
  );
  navScrollTarget = top;

  const unlock = (): void => {
    if (navScrollUnlockTimer !== null) {
      clearTimeout(navScrollUnlockTimer);
      navScrollUnlockTimer = null;
    }
    syncingNav = false;
    // 动画被中途取消（滚轮惯性、重渲染）时瞬时补齐到目标。
    if (
      navScrollTarget !== null &&
      Math.abs(list.scrollTop - navScrollTarget) >= 2
    ) {
      list.scrollTo({ top: navScrollTarget, behavior: "auto" });
    }
    navScrollTarget = null;
    activeGroup = groupId;
    renderNav();
    flushPendingRerender();
  };
  list.scrollTo({ top, behavior: "smooth" });
  list.addEventListener("scrollend", unlock, { once: true });
  navScrollUnlockTimer = setTimeout(unlock, 700);
}

function syncNavFromScroll(): void {
  if (syncingNav || !state.groups.length) return;
  const list = listEl();
  if (!list) return;
  const listTop = list.getBoundingClientRect().top;
  let current = activeGroup;
  for (const g of state.groups) {
    const node = document.getElementById(`occs-group-${g.id}`);
    if (!node) continue;
    if (node.getBoundingClientRect().top - listTop <= 8) {
      current = g.id;
    }
  }
  if (current !== activeGroup) {
    activeGroup = current;
    renderNav();
  }
}

function itemById(id: string): OpenCodeCliSettingItem | undefined {
  return state.items.find((item) => item.id === id);
}

function onControlChange(target: HTMLElement): void {
  const id = target.dataset.ocCliSet;
  if (!id) return;
  const item = itemById(id);
  if (!item) return;

  if (item.type === "boolean") {
    persist(item, (target as HTMLInputElement).checked);
    return;
  }
  if (item.type === "enum") {
    let value: unknown = (target as HTMLSelectElement).value;
    if (item.id === "debug.turn_tokens") {
      // Schema is boolean | "verbose"; UI maps off → default, on → true.
      if (value === "off") value = item.def;
      else if (value === "on") value = true;
      else value = "verbose";
    }
    persist(item, value);
    return;
  }
  if (item.type === "range") {
    const num = Number((target as HTMLInputElement).value);
    const label = target.parentElement?.querySelector(".occs-range-val");
    if (label) label.textContent = num.toFixed(2);
    persist(item, num);
    return;
  }
  if (item.type === "number") {
    const raw = (target as HTMLInputElement).value;
    const num = Number(raw);
    if (raw.trim() === "" || Number.isNaN(num)) {
      // Restore the effective value; do not persist a coerced 0.
      (target as HTMLInputElement).value = String(effectiveValue(item));
      return;
    }
    persist(item, num);
    return;
  }
  persist(item, (target as HTMLInputElement).value.trim());
}

function onControlInput(target: HTMLElement): void {
  if (target.dataset.ocCliSet && target instanceof HTMLInputElement) {
    const item = itemById(target.dataset.ocCliSet);
    if (item?.type === "range") {
      const label = target.parentElement?.querySelector(".occs-range-val");
      if (label) label.textContent = Number(target.value).toFixed(2);
    }
  }
}

export function applyOpenCodeCliSettingsData(
  message: Extract<HostMessage, { type: "openCodeCliSettingsData" }>,
): void {
  state.items = message.items ?? [];
  state.groups = message.groups ?? [];
  state.values = message.values ?? {};
  state.overrides = message.overrides ?? {};
  state.configPath = message.configPath ?? "";
  state.themeOptions = message.themeOptions ?? [];
  state.plugins = message.plugins ?? [];
  state.installedPluginVersions = message.installedPluginVersions ?? {};
  // Authoritative data supersedes any unconfirmed optimistic mutation.
  pendingOptimisticPlugin = null;
  pluginAutoUpdateOverrides.clear();
  pluginOptionsOverrides.clear();
  prunePluginUiState(state.plugins);
  state.pluginUpdates = reconcilePluginUpdates(state.pluginUpdates, state.plugins);
  if (pendingRemoveIndex !== null && pendingRemoveIndex >= state.plugins.length) {
    // Authoritative list shrank underneath the inline confirm row.
    pendingRemoveIndex = null;
  }
  settingsLoaded = true;
  if (settingsLoadFailed) {
    // A successful load supersedes the previous load error; save errors are
    // tracked separately and stay visible.
    settingsLoadFailed = false;
    hideSettingsError();
  }
  $("#occs-reload")?.classList.remove("is-spinning");
  updateConfigPathUi();
  if (!settingsOpen) {
    return;
  }
  // Theme preview writes trigger a host reload. Keep the open picker mounted
  // so hover/key browsing is not interrupted.
  if (themePicker.open) {
    const current = currentThemeValue();
    if (themePicker.activeValue && themePicker.activeValue !== current) {
      // Host reverted a failed write; show the real value again.
      setActiveThemeOption(current, false);
    }
    updateThemeTriggerUi(themePicker.activeValue || current);
    return;
  }
  if (state.groups.length && !state.groups.some((g) => g.id === activeGroup)) {
    activeGroup = state.groups[0].id;
  }
  if (isFocusInList() || navScrollTarget !== null) {
    // Defer the full re-render while a control in the list has focus or a
    // nav jump animation is still in flight; otherwise the innerHTML swap
    // would cancel the smooth scroll mid-flight.
    pendingRerender = true;
    schedulePendingRerenderFlush();
    return;
  }
  renderNav();
  renderList();
}

export function handleOpenCodeCliSettingsSaveResult(
  message: Extract<HostMessage, { type: "openCodeCliSettingsSaveResult" }>,
): void {
  if (!message.ok) {
    pluginUpdateAllQueue = [];
    if (message.path === "plugins") {
      // Version writes report their failure through this same result; only an
      // add/remove mutation changed the list, so only that needs a rollback.
      if (pendingPluginUpdate === null) {
        rollbackPendingOptimisticPlugin();
      }
      pendingPluginUpdate = null;
    }
    renderList();
    showSettingsError(
      message.error || t("saveFailed", "Failed to save. Your config file was not changed."),
    );
    return;
  }
  if (message.path === "plugins") {
    // The write landed; the host's next data push is authoritative.
    pendingOptimisticPlugin = null;
  }
  // Plugin version writes land via this result; mark the row for restart.
  if (message.path === "plugins" && pendingPluginUpdate) {
    const { name, version } = pendingPluginUpdate;
    pendingPluginUpdate = null;
    // The list may have changed while the write was in flight. Skip the restart
    // badge for an entry that is gone: nothing would ever clear it.
    if (state.plugins.some((plugin) => pluginNameOf(plugin) === name)) {
      pluginRestartPending.set(name, version);
    }
    renderList();
    if (pluginUpdateAllQueue.length) {
      updateNextPluginInQueue();
    }
  }
}

/** Put a per-plugin override back to its pre-write value. */
function restorePluginOverride<T>(
  map: Map<string, T>,
  name: string,
  value: T | null,
): void {
  if (value === null) {
    map.delete(name);
  } else {
    map.set(name, value);
  }
}

/** Revert the single optimistic plugin mutation that a failed save left behind. */
function rollbackPendingOptimisticPlugin(): void {
  const mutation = pendingOptimisticPlugin;
  pendingOptimisticPlugin = null;
  if (!mutation) return;
  if (mutation.kind === "add") {
    // The pushed entry must still sit exactly where it was inserted; if the
    // list was rewritten meanwhile, leave it alone rather than delete a
    // different plugin that happens to share the same package name.
    if (
      mutation.index < state.plugins.length &&
      state.plugins[mutation.index] === mutation.value
    ) {
      state.plugins.splice(mutation.index, 1);
    }
    return;
  }
  if (mutation.kind === "autoUpdate") {
    restorePluginOverride(pluginAutoUpdateOverrides, mutation.name, mutation.previous);
    return;
  }
  if (mutation.kind === "options") {
    restorePluginOverride(pluginOptionsOverrides, mutation.name, mutation.previous);
    return;
  }
  // Reinsert at the original position; a shrunken list appends instead.
  if (mutation.index >= state.plugins.length) {
    state.plugins.push(mutation.value);
  } else {
    state.plugins.splice(mutation.index, 0, mutation.value);
  }
  // Restore the row's side state that the optimistic delete cleared.
  if (mutation.restartVersion !== undefined) {
    pluginRestartPending.set(mutation.name, mutation.restartVersion);
  }
  const info = mutation.updateInfo;
  if (info) {
    const existing = state.pluginUpdates ?? [];
    if (!existing.some((entry) => entry.name === info.name)) {
      state.pluginUpdates = [...existing, info];
    }
  }
}

let pendingPluginUpdate: { name: string; version: string } | null = null;

/** Pending "Update all" queue: plugin names awaiting sequential version writes. */
let pluginUpdateAllQueue: string[] = [];

export function handleOpenCodeCliPluginUpdateCheckResult(
  message: Extract<HostMessage, { type: "openCodeCliPluginUpdateCheckResult" }>,
): void {
  pluginCheckPending = false;
  if (!message.ok) {
    showSettingsError(
      message.error || t("updateCheckFailed", "Failed to check plugin updates."),
    );
    renderList();
    return;
  }
  state.pluginUpdates = message.results ?? [];
  renderList();
}

/** OpenCode runtime (re)started; pinned plugin versions are now active. */
export function clearOpenCodeCliPluginRestartPending(): void {
  if (!pluginRestartPending.size) return;
  pluginRestartPending.clear();
  renderList();
}

function openPluginAddForm(): void {
  pluginAddFormOpen = true;
  renderList();
  const input = document.getElementById(
    "occs-plugin-add-input",
  ) as HTMLInputElement | null;
  input?.focus();
}

function closePluginAddForm(): void {
  pluginAddFormOpen = false;
  renderList();
}

function confirmPluginAdd(): void {
  const input = document.getElementById(
    "occs-plugin-add-input",
  ) as HTMLInputElement | null;
  const value = input?.value.trim() ?? "";
  if (!value) {
    input?.focus();
    return;
  }
  // Reject a duplicate package name locally for instant feedback; the host
  // re-checks authoritatively and still refuses its own duplicate writes.
  const name = splitPluginLabel(value).name;
  if (state.plugins.some((plugin) => pluginNameOf(plugin) === name)) {
    showSettingsError(t("pluginAlreadyAdded", "This plugin is already added."));
    input?.focus();
    return;
  }
  // Optimistic local insert: the host round-trip would otherwise leave the
  // form and its text on screen with no visible reaction. The authoritative
  // list from the host replaces `state.plugins` wholesale afterwards.
  const insertIndex = state.plugins.length;
  pendingOptimisticPlugin = { kind: "add", index: insertIndex, value };
  state.plugins.push(value);
  pluginAddFormOpen = false;
  renderList();
  postMessage({ type: "addOpenCodeCliPlugin", packageName: value });
}

function removePluginAt(index: number): void {
  pendingRemoveIndex = null;
  const removed = state.plugins[index];
  if (removed === undefined) {
    renderList();
    return;
  }
  const name = pluginNameOf(removed);
  // Capture the row's side state first: the optimistic delete clears it below,
  // and a failed save must be able to put it back exactly as it was.
  const restartVersion = pluginRestartPending.get(name);
  const updateInfo = state.pluginUpdates?.find((info) => info.name === name);
  pendingOptimisticPlugin = {
    kind: "remove",
    index,
    value: removed,
    name,
    restartVersion,
    updateInfo,
  };
  // Optimistic local removal keeps the list in sync before the host reply.
  state.plugins.splice(index, 1);
  pluginRestartPending.delete(name);
  pluginAutoUpdateOverrides.delete(name);
  pluginOptionsOverrides.delete(name);
  expandedPlugins.delete(name);
  if (pluginOptionsEditor?.name === name) pluginOptionsEditor = null;
  if (state.pluginUpdates) {
    const kept = state.pluginUpdates.filter((info) => info.name !== name);
    state.pluginUpdates = kept.length ? kept : null;
  }
  renderList();
  postMessage({ type: "removeOpenCodeCliPlugin", index });
}

/**
 * Write one pinned version. `name` is the package the rendered row belonged to;
 * the send is dropped when that index no longer holds it, so a list changed
 * underneath the click cannot update a different plugin.
 */
function updatePluginVersion(
  index: number,
  version: string,
  name: string,
): void {
  if (!name || pluginNameOf(state.plugins[index]) !== name) {
    pendingPluginUpdate = null;
    return;
  }
  pendingPluginUpdate = { name, version };
  postMessage({ type: "updateOpenCodeCliPlugin", index, version });
}

/** Flip update tracking. The host rewrites `package` and keeps `options`. */
function commitPluginAutoUpdate(index: number, autoUpdate: boolean): void {
  const plugin = state.plugins[index];
  if (!plugin) return;
  const name = pluginNameOf(plugin);
  const previous = pluginAutoUpdateOverrides.get(name) ?? null;
  pluginAutoUpdateOverrides.set(name, autoUpdate);
  pendingOptimisticPlugin = {
    kind: "autoUpdate",
    index,
    name,
    autoUpdate,
    previous,
  };
  postMessage({ type: "setOpenCodeCliPluginAutoUpdate", index, autoUpdate });
}

/** Replace one entry's whole options object; `options` is stored verbatim. */
function commitPluginOptions(
  index: number,
  options: Record<string, unknown>,
): void {
  const plugin = state.plugins[index];
  if (!plugin) return;
  const name = pluginNameOf(plugin);
  const previous = pluginOptionsOverrides.get(name) ?? null;
  pluginOptionsOverrides.set(name, options);
  pendingOptimisticPlugin = {
    kind: "options",
    index,
    name,
    options,
    previous,
  };
  postMessage({ type: "setOpenCodeCliPluginOptions", index, options });
}

function togglePluginDetail(index: number): void {
  // renderList() is a no-op while a theme preview is open; toggling here would
  // record state the user cannot see yet.
  if (themePicker.open) return;
  const plugin = state.plugins[index];
  if (!plugin) return;
  const name = pluginNameOf(plugin);
  if (expandedPlugins.has(name)) {
    expandedPlugins.delete(name);
    if (pluginOptionsEditor?.name === name) pluginOptionsEditor = null;
  } else {
    expandedPlugins.add(name);
  }
  const focus = captureFocusSnapshot();
  renderList();
  restoreFocusSnapshot(focus);
}

function focusPluginOptionsJson(): void {
  const input = document.getElementById("occs-plugin-options-json");
  if (!(input instanceof HTMLTextAreaElement)) return;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function openPluginOptionsEditor(index: number): void {
  if (themePicker.open) return;
  const plugin = state.plugins[index];
  if (!plugin) return;
  const name = pluginNameOf(plugin);
  const options = effectivePluginOptions(plugin, name) ?? {};
  pluginOptionsEditor = {
    name,
    draft: JSON.stringify(options, null, 2),
    error: null,
  };
  expandedPlugins.add(name);
  renderList();
  focusPluginOptionsJson();
}

function closePluginOptionsEditor(): void {
  if (!pluginOptionsEditor) return;
  pluginOptionsEditor = null;
  renderList();
}

/** Keep the draft in state so a re-render cannot drop typed JSON. */
function syncPluginOptionsDraft(textarea: HTMLTextAreaElement): void {
  if (!pluginOptionsEditor) return;
  pluginOptionsEditor.draft = textarea.value;
  if (!pluginOptionsEditor.error) return;
  pluginOptionsEditor.error = null;
  const box = document.getElementById("occs-plugin-options-error");
  if (box) {
    box.textContent = "";
    box.classList.add("hidden");
  }
}

/**
 * Report a JSON problem without leaving the editor: patching the existing
 * error node keeps the textarea, its caret and its scroll position intact.
 */
function showPluginOptionsError(message: string): void {
  if (pluginOptionsEditor) pluginOptionsEditor.error = message;
  const box = document.getElementById("occs-plugin-options-error");
  if (box) {
    box.textContent = message;
    box.classList.remove("hidden");
  }
}

function savePluginOptions(): void {
  const editor = pluginOptionsEditor;
  if (!editor) return;
  // The live textarea wins over the tracked draft: a value set without an
  // input event would otherwise save stale JSON.
  const textarea = document.getElementById("occs-plugin-options-json");
  const draft =
    textarea instanceof HTMLTextAreaElement ? textarea.value : editor.draft;
  editor.draft = draft;
  const raw = draft.trim();
  let parsed: unknown = {};
  if (raw) {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      showPluginOptionsError(t("optionsInvalidJson", "Options are not valid JSON."));
      return;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    showPluginOptionsError(
      t("optionsNotObject", "Options must be a JSON object."),
    );
    return;
  }
  const index = state.plugins.findIndex(
    (plugin) => pluginNameOf(plugin) === editor.name,
  );
  pluginOptionsEditor = null;
  if (index < 0) {
    renderList();
    return;
  }
  commitPluginOptions(index, parsed as Record<string, unknown>);
  renderList();
}

function onPluginAutoUpdateChange(target: HTMLElement): void {
  const index = Number(target.dataset.ocPluginAutoupdate ?? "-1");
  if (!Number.isInteger(index) || index < 0) return;
  commitPluginAutoUpdate(index, (target as HTMLInputElement).checked);
  const focus = captureFocusSnapshot();
  renderList();
  restoreFocusSnapshot(focus);
}

function onPluginOptionChange(target: HTMLElement): void {
  const index = Number(target.dataset.ocPluginOpt ?? "-1");
  const key = target.dataset.ocOptKey ?? "";
  const type = target.dataset.ocOptType ?? "";
  if (!Number.isInteger(index) || index < 0 || !key) return;
  const plugin = state.plugins[index];
  if (!plugin) return;
  const current = effectivePluginOptions(plugin, pluginNameOf(plugin)) ?? {};
  const next: Record<string, unknown> = { ...current };
  if (type === "boolean") {
    next[key] = (target as HTMLInputElement).checked;
  } else if (type === "number") {
    const input = target as HTMLInputElement;
    const num = Number(input.value);
    if (input.value.trim() === "" || Number.isNaN(num)) {
      // Never coerce an empty field into 0; put the stored value back.
      const stored = current[key];
      input.value = typeof stored === "number" ? String(stored) : "";
      return;
    }
    next[key] = num;
  } else {
    next[key] = (target as HTMLInputElement).value;
  }
  commitPluginOptions(index, next);
}

function updatablePluginNames(): string[] {
  return state.plugins
    .map((plugin) => pluginNameOf(plugin))
    .filter((name) => {
      if (pluginRestartPending.has(name)) return false;
      const info = pluginUpdateInfoOf(name);
      return Boolean(info?.hasUpdate && info.latest);
    });
}

function startUpdateAllPlugins(): void {
  if (pluginUpdateAllQueue.length) return;
  const names = updatablePluginNames();
  if (!names.length) return;
  pluginUpdateAllQueue = names;
  updateNextPluginInQueue();
}

function updateNextPluginInQueue(): void {
  while (pluginUpdateAllQueue.length) {
    const name = pluginUpdateAllQueue.shift();
    if (name === undefined) return;
    const info = pluginUpdateInfoOf(name);
    const index = state.plugins.findIndex((p) => pluginNameOf(p) === name);
    if (info?.latest && index >= 0) {
      pendingPluginUpdate = { name, version: info.latest };
      postMessage({ type: "updateOpenCodeCliPlugin", index, version: info.latest });
      return;
    }
    // Stale entry (list changed underneath); skip to the next one.
  }
}

function checkPluginUpdates(): void {
  if (pluginCheckPending) return;
  pluginCheckPending = true;
  hideSettingsError();
  postMessage({ type: "checkOpenCodeCliPluginUpdates" });
  renderList();
}

export function showOpenCodeCliSettingsError(error: string): void {
  // The host could not read cli.json. Drop everything loaded so far instead of
  // leaving stale or default-filled values on screen, then render the message.
  settingsLoadFailed = true;
  settingsLoaded = false;
  // renderList() keeps an open theme picker mounted, so close it first; its
  // rows belong to data that is no longer trustworthy.
  closeThemePicker();
  resetLoadedState();
  renderNav();
  renderList();
  showSettingsError(
    error || t("loadFailed", "Failed to load OpenCode CLI settings."),
  );
}

export function openOpenCodeCliSettingsModal(): void {
  settingsOpen = true;
  hideSettingsError();
  updateConfigPathUi();
  postMessage({ type: "requestOpenCodeCliSettingsData" });
  // First paint: loading placeholder until host data arrives.
  if (!settingsLoaded) {
    setLoadingVisible(true);
    const list = $("#occs-list");
    if (list) list.innerHTML = "";
  }
  renderNav();
  renderList();
  const list = $("#occs-list");
  if (list) list.scrollTop = 0;
  $("#occs-overlay")?.classList.remove("hidden");
  document.getElementById("btn-oc-cli-settings")?.classList.add("is-active");
}

export function closeOpenCodeCliSettingsModal(): void {
  settingsOpen = false;
  pendingRerender = false;
  pendingRemoveIndex = null;
  if (pendingRerenderTimer !== null) {
    clearTimeout(pendingRerenderTimer);
    pendingRerenderTimer = null;
  }
  if (navScrollUnlockTimer !== null) {
    clearTimeout(navScrollUnlockTimer);
    navScrollUnlockTimer = null;
  }
  navScrollTarget = null;
  $("#occs-overlay")?.classList.add("hidden");
  document.getElementById("btn-oc-cli-settings")?.classList.remove("is-active");
}

export function isOpenCodeCliSettingsOpen(): boolean {
  return settingsOpen;
}

export function initOpenCodeCliSettingsUi(): void {
  $("#occs-close")?.addEventListener("click", () => {
    closeOpenCodeCliSettingsModal();
  });
  $("#occs-reload")?.addEventListener("click", () => {
    // Pull the latest cli.json settings (external edits) and re-render on data.
    hideSettingsError();
    const btn = $("#occs-reload");
    btn?.classList.add("is-spinning");
    postMessage({ type: "requestOpenCodeCliSettingsData" });
    window.setTimeout(() => btn?.classList.remove("is-spinning"), 1200);
  });
  $("#occs-error-dismiss")?.addEventListener("click", () => {
    hideSettingsError();
  });
  $("#occs-open-cli-json")?.addEventListener("click", () => {
    // Open the bound cli.json (create a starter file if missing).
    postMessage({ type: "openOpenCodeGlobalFile", target: "cliJson" });
  });
  $("#occs-overlay")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeOpenCodeCliSettingsModal();
  });

  document.addEventListener("oc-settings-hide", () => {
    closeOpenCodeCliSettingsModal();
  });

  $("#occs-side-nav")?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("[data-group]") as HTMLElement | null;
    if (!btn) return;
    scrollToGroup(btn.dataset.group || "appearance");
  });

  $("#occs-list")?.addEventListener("scroll", () => syncNavFromScroll(), {
    passive: true,
  });

  $("#occs-list")?.addEventListener("change", (e) => {
    const target = e.target as HTMLElement;
    if (!target) return;
    if (target.dataset.ocPluginAutoupdate) {
      onPluginAutoUpdateChange(target);
      return;
    }
    if (target.dataset.ocPluginOpt) {
      onPluginOptionChange(target);
      return;
    }
    if (target.dataset.ocCliSet) {
      onControlChange(target);
    }
  });

  $("#occs-list")?.addEventListener("input", (e) => {
    const target = e.target as HTMLElement;
    if (!target) return;
    if (
      target instanceof HTMLTextAreaElement &&
      target.dataset.ocPluginOptionsDraft
    ) {
      syncPluginOptionsDraft(target);
      return;
    }
    if (target.dataset.ocCliSet) {
      onControlInput(target);
    }
  });

  $("#occs-list")?.addEventListener("focusout", () => {
    setTimeout(() => {
      if (!pendingRerender) return;
      const list = $("#occs-list");
      if (!list || !list.isConnected) {
        pendingRerender = false;
        return;
      }
      // A focused text control keeps its node; everything else may re-render
      // now, with focus restored to the equivalent new node.
      if (isTextEntryFocused()) return;
      flushPendingRerender();
    }, 0);
  });

  $("#occs-list")?.addEventListener("click", (e) => {
    const jump = (e.target as HTMLElement).closest("#occs-open-keymap");
    if (jump) {
      closeOpenCodeCliSettingsModal();
      openKeymapModal();
      return;
    }

    const openFileBtn = (e.target as HTMLElement).closest("[data-oc-cli-open]");
    if (openFileBtn) {
      // Readonly rows jump into the raw config file, same as the header link.
      e.preventDefault();
      const target = (openFileBtn as HTMLElement).dataset.ocCliOpen;
      if (target === "agentsMd" || target === "opencodeJson" || target === "cliJson") {
        postMessage({ type: "openOpenCodeGlobalFile", target });
      }
      return;
    }

    const addBtn = (e.target as HTMLElement).closest("#occs-plugin-add");
    if (addBtn) {
      e.preventDefault();
      openPluginAddForm();
      return;
    }

    const addConfirm = (e.target as HTMLElement).closest(
      "#occs-plugin-add-confirm",
    );
    if (addConfirm) {
      e.preventDefault();
      confirmPluginAdd();
      return;
    }

    const addCancel = (e.target as HTMLElement).closest(
      "#occs-plugin-add-cancel",
    );
    if (addCancel) {
      e.preventDefault();
      closePluginAddForm();
      return;
    }

    const expandBtn = (e.target as HTMLElement).closest(
      "[data-oc-plugin-expand]",
    );
    if (expandBtn) {
      e.preventDefault();
      const index = Number(
        (expandBtn as HTMLElement).dataset.ocPluginExpand ?? "-1",
      );
      if (Number.isInteger(index) && index >= 0) {
        togglePluginDetail(index);
      }
      return;
    }

    const optionsJsonBtn = (e.target as HTMLElement).closest(
      "[data-oc-plugin-options-json]",
    );
    if (optionsJsonBtn) {
      e.preventDefault();
      const index = Number(
        (optionsJsonBtn as HTMLElement).dataset.ocPluginOptionsJson ?? "-1",
      );
      if (Number.isInteger(index) && index >= 0) {
        openPluginOptionsEditor(index);
      }
      return;
    }

    const optionsSave = (e.target as HTMLElement).closest(
      "[data-oc-plugin-options-save]",
    );
    if (optionsSave) {
      e.preventDefault();
      savePluginOptions();
      return;
    }

    const optionsCancel = (e.target as HTMLElement).closest(
      "[data-oc-plugin-options-cancel]",
    );
    if (optionsCancel) {
      e.preventDefault();
      closePluginOptionsEditor();
      return;
    }

    const checkBtn = (e.target as HTMLElement).closest("#occs-plugin-check");
    if (checkBtn) {
      e.preventDefault();
      checkPluginUpdates();
      return;
    }

    const updateAllBtn = (e.target as HTMLElement).closest("#occs-plugin-update-all");
    if (updateAllBtn) {
      e.preventDefault();
      startUpdateAllPlugins();
      return;
    }

    const removeBtn = (e.target as HTMLElement).closest(
      "[data-oc-plugin-remove]",
    );
    if (removeBtn) {
      e.preventDefault();
      // renderList() is a no-op while the theme picker is open, so arming the
      // confirm row here would leak a row state that cannot be rendered.
      if (themePicker.open) return;
      const index = Number(
        (removeBtn as HTMLElement).dataset.ocPluginRemove ?? "-1",
      );
      if (Number.isInteger(index) && index >= 0) {
        // Arm the row's inline confirmation instead of removing immediately.
        pendingRemoveIndex = index;
        renderList();
        listEl()
          ?.querySelector<HTMLElement>("[data-oc-plugin-remove-confirm]")
          ?.focus();
      }
      return;
    }

    const removeConfirm = (e.target as HTMLElement).closest(
      "[data-oc-plugin-remove-confirm]",
    );
    if (removeConfirm) {
      e.preventDefault();
      const index = Number(
        (removeConfirm as HTMLElement).dataset.ocPluginRemoveConfirm ?? "-1",
      );
      pendingRemoveIndex = null;
      if (Number.isInteger(index) && index >= 0) {
        removePluginAt(index);
      } else {
        renderList();
      }
      return;
    }

    const removeCancel = (e.target as HTMLElement).closest(
      "[data-oc-plugin-remove-cancel]",
    );
    if (removeCancel) {
      e.preventDefault();
      pendingRemoveIndex = null;
      renderList();
      return;
    }

    const updateBtn = (e.target as HTMLElement).closest(
      "[data-oc-plugin-update]",
    );
    if (updateBtn) {
      e.preventDefault();
      const el = updateBtn as HTMLElement;
      const index = Number(el.dataset.ocPluginUpdate ?? "-1");
      const version = el.dataset.ocPluginVersion ?? "";
      const name = el.dataset.ocPluginUpdateName ?? "";
      if (Number.isInteger(index) && index >= 0 && version) {
        updatePluginVersion(index, version, name);
      }
      return;
    }

    const restartBtn = (e.target as HTMLElement).closest(
      "[data-oc-plugin-restart]",
    );
    if (restartBtn) {
      e.preventDefault();
      closeOpenCodeCliSettingsModal();
      postMessage({ type: "requestRestart" });
      return;
    }

    const trigger = (e.target as HTMLElement).closest("[data-oc-theme-trigger]");
    if (trigger) {
      e.preventDefault();
      if (themePicker.open) {
        commitThemeChoice(themePicker.activeValue);
      } else {
        openThemePicker();
      }
      return;
    }

    const option = (e.target as HTMLElement).closest("[data-oc-theme-opt]");
    if (option && themePicker.open) {
      e.preventDefault();
      const value = (option as HTMLElement).dataset.ocThemeOpt || "";
      commitThemeChoice(value);
    }
  });

  $("#occs-list")?.addEventListener("mouseover", (e) => {
    const option = (e.target as HTMLElement).closest("[data-oc-theme-opt]");
    if (!option || !themePicker.open) return;
    const value = (option as HTMLElement).dataset.ocThemeOpt || "";
    if (value !== themePicker.activeValue) {
      setActiveThemeOption(value, true);
    }
  });

  $("#occs-list")?.addEventListener("keydown", (e) => {
    const addInput = (e.target as HTMLElement).closest(
      "#occs-plugin-add-input",
    );
    if (addInput) {
      if (e.key === "Enter") {
        e.preventDefault();
        confirmPluginAdd();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closePluginAddForm();
      }
      return;
    }

    if (pendingRemoveIndex !== null && e.key === "Escape") {
      // Cancel the row confirmation before the theme picker / modal handlers.
      e.preventDefault();
      e.stopPropagation();
      pendingRemoveIndex = null;
      renderList();
      return;
    }

    const optionsJson = (e.target as HTMLElement).closest(
      "#occs-plugin-options-json",
    );
    if (optionsJson && e.key === "Escape") {
      // Leave the JSON editor without discarding the rest of the settings.
      e.preventDefault();
      e.stopPropagation();
      closePluginOptionsEditor();
      return;
    }

    const picker = (e.target as HTMLElement).closest("[data-oc-theme-picker]");
    if (!picker && !themePicker.open) return;
    if (e.key === "Escape" && themePicker.open) {
      e.preventDefault();
      e.stopPropagation();
      closeThemePicker({ restore: true });
      return;
    }
    if (!themePicker.open) {
      if (
        e.key === "ArrowDown" ||
        e.key === "ArrowUp" ||
        e.key === "Enter" ||
        e.key === " "
      ) {
        const trigger = (e.target as HTMLElement).closest("[data-oc-theme-trigger]");
        if (trigger) {
          e.preventDefault();
          openThemePicker();
          if (e.key === "ArrowUp") {
            setActiveThemeOption(state.themeOptions[state.themeOptions.length - 1]?.value || "", true);
          }
        }
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      themePickerIndexDelta(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      themePickerIndexDelta(-1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      commitThemeChoice(themePicker.activeValue);
    }
  });

  $("#occs-list")?.addEventListener(
    "wheel",
    (e) => {
      if (!themePicker.open) return;
      // Theme menu lives inside the settings list; keep its own scrolling.
      const target = e.target as HTMLElement | null;
      if (target?.closest?.("[data-oc-theme-menu]")) return;
      e.preventDefault();
    },
    { passive: false },
  );

  document.addEventListener("click", (e) => {
    if (!themePicker.open) return;
    const target = e.target as HTMLElement;
    if (target.closest?.("[data-oc-theme-picker]")) return;
    // Outside click keeps the last previewed theme.
    clearThemePreviewTimer();
    closeThemePicker();
  });
}
