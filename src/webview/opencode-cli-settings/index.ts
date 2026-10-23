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
};

let pluginAddFormOpen = false;
let pluginCheckPending = false;
/** Plugin name → new version, for rows that need a restart after update. */
const pluginRestartPending = new Map<string, string>();

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
let syncingNav = false;
let pendingRerender = false;
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

function pluginLabel(plugin: unknown): string {
  if (typeof plugin === "string") return plugin;
  if (plugin && typeof plugin === "object") {
    const pkg = (plugin as { package?: unknown }).package;
    if (typeof pkg === "string" && pkg.trim()) return pkg.trim();
  }
  return String(plugin);
}

/** Split `name@version` / `@scope/name@version` for display. */
function splitPluginLabel(label: string): { name: string; version: string } {
  const at = label.lastIndexOf("@");
  if (at > 0) {
    return { name: label.slice(0, at), version: label.slice(at) };
  }
  return { name: label, version: "" };
}

/** Canonical plugin name for matching host update-check results. */
function pluginNameOf(plugin: unknown): string {
  return splitPluginLabel(pluginLabel(plugin)).name;
}

/** Version pinned in the entry itself (string spec or object field), null when unpinned. */
function pluginPinnedVersion(plugin: unknown): string | null {
  if (typeof plugin === "string") {
    const spec = plugin.trim();
    const at = spec.lastIndexOf("@");
    if (at > 0) return spec.slice(at + 1) || null;
    return null;
  }
  if (plugin && typeof plugin === "object" && !Array.isArray(plugin)) {
    const rec = plugin as { package?: unknown; version?: unknown };
    if (typeof rec.version === "string" && rec.version.trim()) {
      return rec.version.trim();
    }
    if (typeof rec.package === "string") {
      const spec = rec.package.trim();
      const at = spec.lastIndexOf("@");
      if (at > 0) return spec.slice(at + 1) || null;
    }
  }
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

/** Inline version hint next to the package name (no second row). */
function pluginVersionHint(name: string): string {
  if (pluginRestartPending.has(name)) {
    return "";
  }
  const info = pluginUpdateInfoOf(name);
  if (!info) return "";
  if (info.error) {
    return `<span class="occs-plugin-ver is-error" title="${escapeHtml(info.error)}">${escapeHtml(t("checkFailed", "Check failed"))}</span>`;
  }
  if (info.hasUpdate && info.current && info.latest) {
    // Current version is already shown beside the name; only append the target.
    return `<span class="occs-plugin-ver is-update" title="${escapeHtml(t("updateAvailable", "Update available"))}">→ ${escapeHtml(info.latest)}</span>`;
  }
  if (info.latest && !info.current) {
    // Unpinned package: report the registry latest instead of a status word.
    return `<span class="occs-plugin-ver is-ok" title="${escapeHtml(t("upToDate", "Up to date"))}">${escapeHtml(formatMessage(t("latestLabel", "latest: {0}"), info.latest))}</span>`;
  }
  if (info.latest) {
    // Pinned and equal to latest.
    return `<span class="occs-plugin-ver is-ok" title="${escapeHtml(t("upToDate", "Up to date"))}">${escapeHtml(t("upToDate", "Up to date"))}</span>`;
  }
  return "";
}

function pluginActionsHtml(name: string): string {
  const index = state.plugins.findIndex((p) => pluginNameOf(p) === name);
  const info = pluginUpdateInfoOf(name);
  const canUpdate =
    index >= 0 &&
    !pluginRestartPending.has(name) &&
    Boolean(info?.hasUpdate && info?.latest);
  const updateBtn = canUpdate
    ? `<button type="button" class="occs-icon-btn" data-oc-plugin-update="${index}" data-oc-plugin-version="${escapeHtml(info?.latest ?? "")}" title="${escapeHtml(t("updateVersion", "Update"))}" aria-label="${escapeHtml(t("updateVersion", "Update"))}">
        ${icon(ICONS.upload, 12)}
      </button>`
    : "";
  return `<div class="occs-plugin-actions">
    ${updateBtn}
    <button type="button" class="occs-icon-btn" data-oc-plugin-remove="${index}" title="${escapeHtml(t("removePlugin", "Remove plugin"))}" aria-label="${escapeHtml(t("removePlugin", "Remove plugin"))}">${icon(ICONS.x, 12)}</button>
  </div>`;
}

function pluginsSectionHtml(): string {
  const items = state.plugins
    .map((plugin, index) => {
      const label = pluginLabel(plugin);
      const { name, version } = splitPluginLabel(label);
      const restartVer = pluginRestartPending.get(name);
      let hint: string;
      if (restartVer !== undefined) {
        hint = `<span class="occs-plugin-ver is-success">${escapeHtml(version || `@${restartVer}`)}</span>
          <button type="button" class="occs-plugin-ver is-success occs-plugin-restart" data-oc-plugin-restart="1" title="${escapeHtml(t("restartToTakeEffect", "Restart OpenCode to take effect"))}">${escapeHtml(t("restartToTakeEffect", "Restart OpenCode to take effect"))}</button>`;
      } else {
        // Always show the pinned version; update check appends after it.
        const verHtml = version
          ? `<span class="occs-plugin-ver">${escapeHtml(version)}</span>`
          : "";
        hint = verHtml + pluginVersionHint(name);
      }
      return `<div class="occs-plugin-item" data-oc-plugin-index="${index}">
        <div class="occs-plugin-main">
          <span class="occs-plugin-name">${escapeHtml(name)}</span>
          ${hint}
        </div>
        ${pluginActionsHtml(name)}
      </div>`;
    })
    .join("");
  const empty = state.plugins.length
    ? ""
    : `<div class="occs-plugin-empty">${escapeHtml(t("noPlugins", "No plugins configured"))}</div>`;
  const addForm = pluginAddFormOpen
    ? `<div class="occs-plugin-add-form">
        <input class="occs-input occs-plugin-add-input" id="occs-plugin-add-input" type="text" placeholder="${escapeHtml(t("pluginPackagePlaceholder", "npm package name, e.g. @scope/plugin"))}" />
        <button type="button" class="occs-btn occs-btn-primary" id="occs-plugin-add-confirm">${escapeHtml(t("addPlugin", "Add plugin"))}</button>
        <button type="button" class="occs-btn" id="occs-plugin-add-cancel">${escapeHtml(t("cancel", "Cancel"))}</button>
      </div>`
    : "";
  const updatableCount = pluginUpdateAllQueue.length > 0
    ? pluginUpdateAllQueue.length
    : updatablePluginNames().length;
  const updateAllBtn = updatableCount > 0
    ? `<button type="button" class="occs-btn${pluginUpdateAllQueue.length ? " is-busy" : ""}" id="occs-plugin-update-all"${pluginUpdateAllQueue.length ? " disabled" : ""}>${escapeHtml(t("updateAll", "Update all"))}</button>`
    : "";
  return `<div class="occs-section">
    <div class="group-label" id="occs-group-plugins">${escapeHtml(groupTitle("plugins"))}</div>
    <div class="occs-plugin-toolbar">
      <button type="button" class="occs-btn" id="occs-plugin-add">${escapeHtml(t("addPlugin", "Add plugin"))}</button>
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

function flushPendingRerender(): void {
  if (!pendingRerender) return;
  if (navScrollTarget !== null) return;
  if (isFocusInList()) return;
  pendingRerender = false;
  renderNav();
  renderList();
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
  state.pluginUpdates = reconcilePluginUpdates(state.pluginUpdates, state.plugins);
  settingsLoaded = true;
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
      pendingPluginUpdate = null;
    }
    renderList();
    showSettingsError(
      message.error || t("saveFailed", "Failed to save. Your config file was not changed."),
    );
    return;
  }
  // Plugin version writes land via this result; mark the row for restart.
  if (message.path === "plugins" && pendingPluginUpdate) {
    const { name, version } = pendingPluginUpdate;
    pendingPluginUpdate = null;
    pluginRestartPending.set(name, version);
    renderList();
    if (pluginUpdateAllQueue.length) {
      updateNextPluginInQueue();
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
  pluginAddFormOpen = false;
  postMessage({ type: "addOpenCodeCliPlugin", packageName: value });
}

function removePluginAt(index: number): void {
  const label = pluginLabel(state.plugins[index]);
  pluginRestartPending.delete(splitPluginLabel(label).name);
  postMessage({ type: "removeOpenCodeCliPlugin", index });
}

function updatePluginVersion(index: number, version: string): void {
  const label = pluginLabel(state.plugins[index]);
  pendingPluginUpdate = { name: splitPluginLabel(label).name, version };
  postMessage({ type: "updateOpenCodeCliPlugin", index, version });
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
  showSettingsError(error || t("loadFailed", "Failed to load OpenCode CLI settings."));
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
    if (target && target.dataset && target.dataset.ocCliSet) {
      onControlChange(target);
    }
  });

  $("#occs-list")?.addEventListener("input", (e) => {
    const target = e.target as HTMLElement;
    if (target && target.dataset && target.dataset.ocCliSet) {
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
      // Focus moved elsewhere within the list; keep waiting.
      if (list.contains(document.activeElement)) return;
      pendingRerender = false;
      renderNav();
      renderList();
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
      const index = Number(
        (removeBtn as HTMLElement).dataset.ocPluginRemove ?? "-1",
      );
      if (Number.isInteger(index) && index >= 0) {
        removePluginAt(index);
      }
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
      if (Number.isInteger(index) && index >= 0 && version) {
        updatePluginVersion(index, version);
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
