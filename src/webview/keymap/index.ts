/**
 * OpenCode v2 Keymap modal (L1 list + L2 chord editor).
 * Browser-only; communicates via WebviewMessage.
 */
import type { HostMessage, KeymapItem } from "../../types";
import {
  chordsOf,
  effectiveBinding,
  getDisplayState,
  hasUserOverride,
  isNoneValue,
  normChord,
  normalizeBinding,
  toPersistedValue,
  uniqueChords,
} from "../../services/openCodeKeymapState";
import { postMessage } from "../shared/vscode-api";
import { ICONS, icon } from "../shared/icons";

/** 注入方为 terminal/html.ts 的 nonce 脚本 window.__KEYMAP_L10N__；缺失时回退英文。 */
const keymapL10n: Record<string, string> =
  (typeof window !== "undefined"
    ? (window as unknown as { __KEYMAP_L10N__?: Record<string, string> })
        .__KEYMAP_L10N__
    : undefined) ?? {};

function t(key: string, fallback: string): string {
  return keymapL10n[key] ?? fallback;
}

/** 位置参数模板（{0}/{1}…），与 l10n.t 的占位符风格一致。 */
function formatMessage(
  template: string,
  ...values: Array<string | number>
): string {
  return template.replace(/\{(\d+)\}/g, (match, index: string) => {
    const value = values[Number(index)];
    return value === undefined ? match : String(value);
  });
}

const GROUP_ORDER = [
  "general",
  "session",
  "nav",
  "model",
  "input",
  "dialog",
  "diff",
  "whichkey",
] as const;

const GROUP_LABELS: Record<string, string> = {
  general: t("groupGeneral", "General"),
  session: t("groupSession", "Session"),
  nav: t("groupNav", "Navigation / Messages"),
  model: t("groupModel", "Models / Agents"),
  input: t("groupInput", "Input / Prompts"),
  dialog: t("groupDialog", "Dialogs"),
  diff: t("groupDiff", "Diff viewer"),
  whichkey: t("groupWhichkey", "Which-key"),
};

type CaptureState = {
  mode: "add" | "replace";
  index?: number;
  pendingLeader?: boolean;
  chord?: string;
  leaderTimer?: ReturnType<typeof setTimeout>;
};

type L2State = {
  id: string;
  draft: string[];
  def: string;
  /** 打开弹窗时的 chord 列表，用于判断未保存更改 */
  original: string[];
};

/** 待确认的快捷键冲突：用户选择是否覆盖其他命令的占用。 */
type PendingConflict = {
  chord: string;
  mode: "add" | "replace" | "save";
  index?: number;
  conflict: KeymapItem;
};

let items: KeymapItem[] = [];
let overrides: Record<string, string> = {};
let filterMode = "all";
let searchQuery = "";
let activeGroup = "general";
let l2: L2State | null = null;
let capture: CaptureState | null = null;
let pendingConflict: PendingConflict | null = null;
let navScrollLock = false;
let navScrollUnlockTimer: ReturnType<typeof setTimeout> | null = null;
/** 打开 L2 并进入录制的那次 click 会冒泡到 document，忽略以免立刻 stopCapture */
let suppressOutsideCapture = false;

/** 搜索框“录制按键搜索”状态；与 L2 capture 相互独立，L2 打开时必须为空。 */
type SearchCaptureState = {
  pendingLeader: boolean;
  leaderTimer?: ReturnType<typeof setTimeout>;
};

let searchCapture: SearchCaptureState | null = null;
/** 非录制态的搜索框 placeholder（markup 已本地化），进入录制时用于还原。 */
let searchPlaceholder = "";

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

function itemDef(id: string): string {
  return items.find((c) => c.id === id)?.def ?? "none";
}

function itemOverride(id: string): string | undefined {
  return overrides[id];
}

function eff(id: string): string {
  const value = effectiveBinding(itemOverride(id), itemDef(id));
  return isNoneValue(value) ? "none" : String(value);
}

function effChords(id: string): string[] {
  return chordsOf(eff(id));
}

/** 功能键 F1–F24 统一显示为大写 F；存储值保持小写。 */
export function formatFKeys(text: string): string {
  return String(text).replace(
    /\bf([1-9]|1[0-9]|2[0-4])\b/gi,
    (match) => match.toUpperCase(),
  );
}

function formatKey(key: string): string {
  return formatFKeys(
    String(key)
      .replace(/\+/g, " + ")
      .replace(/\bctrl\b/gi, "Ctrl")
      .replace(/\balt\b/gi, "Alt")
      .replace(/\bshift\b/gi, "Shift")
      .replace(/\bsuper\b/gi, "Super")
      .replace(/\breturn\b/gi, "Enter")
      .replace(/\benter\b/gi, "Enter")
      .replace(/\bescape\b/gi, "Esc")
      .replace(/\bpageup\b/gi, "PgUp")
      .replace(/\bpagedown\b/gi, "PgDn")
      .replace(/\bleft\b/gi, "←")
      .replace(/\bright\b/gi, "→")
      .replace(/\bup\b/gi, "↑")
      .replace(/\bdown\b/gi, "↓")
      .replace(/\bbackspace\b/gi, "Bksp")
      .replace(/\bdelete\b/gi, "Del")
      .trim(),
  );
}

function renderOneChord(chord: string, extraClass = "", extraAttrs = ""): string {
  const lower = chord.toLowerCase();
  const cls = (base: string) =>
    [base, extraClass].filter(Boolean).join(" ");
  const attrs = extraAttrs ? ` ${extraAttrs}` : "";
  if (lower.startsWith("<leader>")) {
    const rest = chord.slice(8);
    return `<span class="${cls("kbd leader")}"${attrs}>Leader${
      rest ? ` ${escapeHtml(formatKey(rest))}` : ""
    }</span>`;
  }
  return `<span class="${cls("kbd")}"${attrs}>${escapeHtml(formatKey(chord))}</span>`;
}

/**
 * 归一化一段按键文本用于搜索匹配：按逗号拆成多组合，每个组合再按 “+”
 * 逐段 normChord，让存储侧的别名（enter/esc/pgup…）与录制出的归一键名一致。
 */
export function normalizeChordText(value: string): string {
  return value
    .split(",")
    .map((chord) => chord.trim())
    .filter(Boolean)
    .map((chord) => chord.split("+").map(normChord).join("+"))
    .join(",");
}

/**
 * 搜索词形如单个按键组合（无空白/逗号，仅按键字符）时做同样的归一，
 * 其余自由文本仅做小写化，避免误改普通关键词。
 */
export function normalizeSearchQuery(query: string): string {
  const s = query.trim().toLowerCase();
  if (s && /^[+\w.<>-]+$/.test(s)) {
    return s.split("+").map(normChord).join("+");
  }
  return s;
}

/** keys 搜索匹配：原文子串或归一化子串任一命中即可（覆盖录制键与存储别名不一致）。 */
export function matchesKeyText(
  effText: string,
  defText: string,
  query: string,
): boolean {
  const raw = query.toLowerCase();
  const normalized = normalizeSearchQuery(query);
  return (
    effText.toLowerCase().includes(raw) ||
    defText.toLowerCase().includes(raw) ||
    normalizeChordText(effText).includes(normalized) ||
    normalizeChordText(defText).includes(normalized)
  );
}

function matchesFilter(item: KeymapItem): boolean {
  const state = getDisplayState(itemOverride(item.id), itemDef(item.id));
  if (filterMode === "modified" && state !== "modified") return false;
  if (filterMode === "bound" && state !== "bound") return false;
  if (filterMode === "unbound" && state !== "unbound") return false;
  if (!searchQuery) return true;
  const q = searchQuery.toLowerCase();
  return (
    item.id.toLowerCase().includes(q) ||
    item.title.toLowerCase().includes(q) ||
    item.desc.toLowerCase().includes(q) ||
    matchesKeyText(eff(item.id), item.def, searchQuery)
  );
}

function visibleInGroup(group: string): KeymapItem[] {
  return items.filter((c) => c.group === group && matchesFilter(c));
}

function renderSideNav(): void {
  const nav = $("#km-side-nav");
  if (!nav) return;
  nav.innerHTML = GROUP_ORDER.map((key) => {
    const n = visibleInGroup(key).length;
    const on = activeGroup === key;
    return `<button type="button" class="sn-item${on ? " is-on" : ""}${
      n === 0 ? " is-empty" : ""
    }" data-group="${key}" aria-current="${on ? "true" : "false"}"><span>${
      GROUP_LABELS[key]
    }</span><span class="sn-count">${n}</span></span></button>`;
  }).join("");
}

function renderList(): void {
  const body = $("#km-list");
  if (!body) return;
  let html = "";
  let total = 0;
  let rowIndex = 0;
  for (const g of GROUP_ORDER) {
    const list = visibleInGroup(g);
    if (!list.length) continue;
    total += list.length;
    html += `<div class="group-label" id="km-group-${g}">${GROUP_LABELS[g]} <span class="gl-count">(${
      list.length
    })</span></div>`;
    for (const item of list) {
      const mod = hasUserOverride(itemOverride(item.id), itemDef(item.id));
      const zebra = rowIndex % 2 === 1 ? " is-zebra" : "";
      rowIndex += 1;
      const chords = effChords(item.id);
      const keys = chords.length
        ? chords
            .map((c, i) =>
              renderOneChord(
                c,
                "is-clickable",
                `data-act="edit-chord" data-id="${escapeHtml(item.id)}" data-index="${i}" role="button" tabindex="0" title="${t("clickToEdit", "Click to edit")}"`,
              ),
            )
            .join("")
        : `<span class="kbd is-none is-clickable" data-act="edit-chord" data-id="${escapeHtml(item.id)}" data-index="0" role="button" tabindex="0" title="${t("clickToBind", "Click to bind a shortcut")}">${t("unbound", "Unbound")}</span>`;
      html += `
        <div class="kb-row${mod ? " is-modified" : ""}${zebra}" data-id="${escapeHtml(item.id)}">
          <div class="kb-info">
            <div class="kb-title-line">
              <span class="kb-title">${escapeHtml(item.title)}</span>
              <span class="kb-id">${escapeHtml(item.id)}</span>
            </div>
            <div class="kb-desc">${escapeHtml(item.desc)}</div>
            ${
              mod
                ? `<div class="kb-default-ghost">${escapeHtml(formatMessage(t("defaultLabel", "Default: {0}"), formatFKeys(item.def)))}</div>`
                : ""
            }
          </div>
          <div class="kb-keys">${keys}</div>
          <div class="kb-actions">
            ${
              mod
                ? `<button type="button" class="mini-btn reset" data-act="reset" data-id="${escapeHtml(
                    item.id,
                  )}">${t("reset", "Reset")}</button>`
                : `<button type="button" class="mini-btn reset is-placeholder" tabindex="-1" aria-hidden="true" disabled>${t("reset", "Reset")}</button>`
            }
          </div>
        </div>`;
    }
  }
  if (!total) {
    html = `<div class="empty">${t("noMatches", "No matching shortcuts")}</div>`;
  }
  body.innerHTML = html;

  const nBound = items.filter(
    (c) => getDisplayState(itemOverride(c.id), itemDef(c.id)) === "bound",
  ).length;
  const nMod = items.filter(
    (c) => getDisplayState(itemOverride(c.id), itemDef(c.id)) === "modified",
  ).length;
  const nUn = items.filter(
    (c) => getDisplayState(itemOverride(c.id), itemDef(c.id)) === "unbound",
  ).length;
  const stats = $("#km-stats");
  if (stats) {
    stats.innerHTML = formatMessage(
      t("stats", "Total {0} · Bound {1} · Modified {2} · Unbound {3}"),
      items.length,
      `<strong>${nBound}</strong>`,
      `<strong>${nMod}</strong>`,
      `<strong>${nUn}</strong>`,
    );
  }
}

function renderL2(): void {
  if (!l2) return;
  const item = items.find((c) => c.id === l2!.id);
  if (!item) return;
  const title = $("#km-l2-id");
  const desc = $("#km-l2-desc");
  const leaderEl = $("#km-l2-leader");
  const defEl = $("#km-l2-default");
  const host = $("#km-l2-chords");
  if (title) title.textContent = item.id;
  if (desc) desc.textContent = item.desc;
  if (defEl) {
    defEl.textContent = formatMessage(
      t("defaultLabel", "Default: {0}"),
      formatFKeys(item.def),
    );
  }
  if (leaderEl) {
    const leader = formatKey(eff("leader") || "ctrl+x");
    leaderEl.innerHTML = `${formatMessage(
      t("leaderLabel", "Leader key: {0}"),
      `<strong>${escapeHtml(leader)}</strong>`,
    )} · ${t(
      "leaderHint",
      "Press Leader first, then the next key when recording a sequence",
    )}`;
  }
  if (!host) return;

  const iconEdit = icon(ICONS.pencil);
  const iconDel = icon(ICONS.trash);

  const msgEl = $("#km-l2-msg");
  const showPrompt = Boolean(
    msgEl?.classList.contains("is-unsaved") ||
      msgEl?.classList.contains("is-conflict"),
  );
  const showAdd = !capture && !showPrompt;

  const showCaptureHint = (isCap: boolean): string =>
    isCap
      ? `<div class="capture-hint-inline" role="status"><span class="capture-dot" aria-hidden="true"></span>${t(
          "recording",
          "Recording",
        )}<button type="button" class="capture-cancel-link" data-l2="cancel">${t(
          "cancel",
          "Cancel",
        )}</button></div>`
      : "";

  if (l2.draft.length) {
    host.innerHTML = l2.draft
      .map((chord, i) => {
        const isCap =
          capture && capture.mode === "replace" && capture.index === i;
        return `<div class="l2-chord-line"><div class="chord-slot is-clickable${
          isCap ? " is-capture" : ""
        }" data-l2="replace" data-index="${i}" role="button" tabindex="0" title="${t("clickToEdit", "Click to edit")}">${renderOneChord(
          chord,
          isCap ? "is-capture" : "",
        )}</div>${showCaptureHint(Boolean(isCap))}<div class="chord-actions">${
          isCap
            ? ""
            : `<button type="button" class="icon-mini" data-l2="replace" data-index="${i}" title="${t("edit", "Edit")}">${iconEdit}</button>
          <button type="button" class="icon-mini danger" data-l2="delete" data-index="${i}" title="${t("delete", "Delete")}">${iconDel}</button>`
        }</div></div>`;
      })
      .join("");
  } else {
    const isCap = capture && capture.mode === "add";
    host.innerHTML = `<div class="l2-chord-line"><div class="chord-slot is-clickable${
      isCap ? " is-capture" : ""
    }" data-l2="replace" data-index="0" role="button" tabindex="0" title="${t("clickToBind", "Click to bind a shortcut")}"><span class="kbd is-none${
      isCap ? " is-capture" : ""
    }">${t("unbound", "Unbound")}</span></div>${showCaptureHint(Boolean(isCap))}<div class="chord-actions">${
      isCap
        ? ""
        : `<button type="button" class="icon-mini" data-l2="replace" data-index="0" title="${t("edit", "Edit")}">${iconEdit}</button>`
    }</div></div>`;
  }

  if (capture && capture.mode === "add" && l2.draft.length) {
    host.insertAdjacentHTML(
      "beforeend",
      `<div class="l2-chord-line"><div class="chord-slot is-capture"><span class="kbd is-none is-capture">${t(
        "unbound",
        "Unbound",
      )}</span></div>${showCaptureHint(true)}<div class="chord-actions"></div></div>`,
    );
  }

  // 「添加绑定」居中放在列表内；录制中或未保存提示时隐藏
  if (showAdd) {
    host.insertAdjacentHTML(
      "beforeend",
      `<div class="l2-add-row"><button type="button" class="km-btn" id="km-l2-add">${t(
        "addBinding",
        "+ Add binding",
      )}</button></div>`,
    );
    $("#km-l2-add")?.addEventListener("click", () => startCapture("add"));
  }
}

function render(): void {
  renderSideNav();
  renderList();
}

/** L2 内联错误/警告（不使用 toast）。 */
function setL2Msg(message: string, kind: "error" | "warning"): void {
  pendingConflict = null;
  const el = $("#km-l2-msg");
  if (!el) return;
  el.textContent = message;
  el.classList.remove("hidden", "error", "warning", "is-unsaved", "is-conflict");
  el.classList.add(kind);
  renderL2();
}

function clearL2Msg(): void {
  pendingConflict = null;
  const el = $("#km-l2-msg");
  if (!el) return;
  el.textContent = "";
  el.classList.add("hidden");
  el.classList.remove("error", "warning", "is-unsaved", "is-conflict");
  renderL2();
}

/**
 * 冲突提示：说明该按键已被哪个命令占用，由用户选择是否覆盖。
 * 覆盖即从对方命令的绑定列表中移除该按键。
 */
function showConflictPrompt(pending: PendingConflict): void {
  pendingConflict = pending;
  const el = $("#km-l2-msg");
  if (!el) return;
  el.classList.remove("hidden", "error", "warning", "is-unsaved");
  el.classList.add("warning", "is-conflict");
  el.innerHTML = `
    <div class="km-unsaved-row">
      <div class="km-unsaved-text">${escapeHtml(
        formatMessage(
          t(
            "conflictOverwrite",
            '{0} is already used by "{1}". Overwrite it?',
          ),
          formatKey(pending.chord),
          pending.conflict.title,
        ),
      )}</div>
      <div class="km-unsaved-actions">
        <button type="button" class="km-btn" id="km-l2-conflict-cancel">${t(
          "cancel",
          "Cancel",
        )}</button>
        <button type="button" class="km-btn primary" id="km-l2-conflict-overwrite">${t(
          "overwrite",
          "Overwrite",
        )}</button>
      </div>
    </div>`;
  el.querySelector("#km-l2-conflict-cancel")?.addEventListener("click", () => {
    clearL2Msg();
  });
  el.querySelector("#km-l2-conflict-overwrite")?.addEventListener(
    "click",
    () => resolveConflictOverwrite(),
  );
}

/** 把某个 chord 从另一命令的绑定中移除并落盘。 */
function unbindChordFrom(item: KeymapItem, chord: string): void {
  const n = normChord(chord);
  const remaining = effChords(item.id).filter((c) => normChord(c) !== n);
  const persisted = toPersistedValue(remaining, item.def);
  if (persisted === undefined) {
    delete overrides[item.id];
  } else {
    overrides[item.id] = persisted;
  }
  postMessage({ type: "saveKeybind", id: item.id, chords: remaining });
}

/** 用户确认覆盖：对方命令让出该按键，再继续应用/保存当前修改。 */
function resolveConflictOverwrite(): void {
  const pending = pendingConflict;
  if (!pending || !l2) {
    clearL2Msg();
    return;
  }
  pendingConflict = null;
  unbindChordFrom(pending.conflict, pending.chord);
  render();
  if (pending.mode === "save") {
    clearL2Msg();
    closeL2(true);
    return;
  }
  const applied = applyCapturedChord(
    l2.id,
    l2.draft,
    pending.chord,
    pending.mode,
    pending.index,
  );
  if (applied) {
    clearL2Msg();
  } else {
    renderL2();
  }
}

export function openKeymapModal(): void {
  postMessage({ type: "requestKeymapData" });
  hideKeymapError();
  $("#km-overlay")?.classList.remove("hidden");
  document.getElementById("btn-keymap")?.classList.add("is-active");
  activeGroup = GROUP_ORDER[0];
  render();
  $("#km-search")?.focus();
}

export function closeKeymapModal(): void {
  closeL2(false);
  setSearchCapture(false);
  $("#km-overlay")?.classList.add("hidden");
  document.getElementById("btn-keymap")?.classList.remove("is-active");
}

let keymapOpenCodeV2 = false;

/** OpenCode-only toolbar buttons that require a resolved v2 CLI. */
const OC_V2_BUTTON_IDS = ["btn-keymap", "btn-oc-cli-settings"] as const;
/** OpenCode-only toolbar buttons shown for both v1 and v2. */
const OC_ANY_BUTTON_IDS = ["btn-oc-agents-md", "btn-oc-config-json"] as const;
/** Separators around the OpenCode button group (font | oc | settings). */
const OC_SEPARATOR_IDS = [
  "toolbar-sep-font-oc",
  "toolbar-sep-oc-settings",
] as const;

function setToolbarButtonVisible(id: string, visible: boolean): void {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.classList.toggle("hidden", !visible);
  btn.setAttribute("aria-hidden", visible ? "false" : "true");
  if (!visible) {
    btn.classList.remove("is-active");
  }
}

function applyKeymapVisibility(): void {
  // OpenCode is the only supported tool; the AGENTS.md / opencode.json
  // entries show for v1 and v2, the keymap and CLI settings need a
  // resolved v2 CLI.
  const showV2 = keymapOpenCodeV2;
  const showAny = true;

  for (const id of OC_V2_BUTTON_IDS) {
    setToolbarButtonVisible(id, showV2);
  }
  for (const id of OC_ANY_BUTTON_IDS) {
    setToolbarButtonVisible(id, showAny);
  }
  for (const id of OC_SEPARATOR_IDS) {
    const sep = document.getElementById(id);
    if (!sep) continue;
    sep.classList.toggle("hidden", !showAny);
    sep.setAttribute("aria-hidden", showAny ? "false" : "true");
  }
  if (!showV2) {
    closeKeymapModal();
    // Lazy import avoided: dispatch so settings can close without a cycle.
    document.dispatchEvent(new CustomEvent("oc-settings-hide"));
  }
}

/** Host signal from activeSession: OpenCode with a resolved v2 CLI. */
export function setKeymapOpenCodeV2(openCodeV2: boolean): void {
  keymapOpenCodeV2 = openCodeV2;
  applyKeymapVisibility();
}

export function applyKeymapData(
  message: Extract<HostMessage, { type: "keymapData" }>,
): void {
  items = message.items ?? [];
  overrides = { ...(message.overrides ?? {}) };
  $("#km-reload")?.classList.remove("is-spinning");
  // 错误横幅是粘性的：宿主保存失败后会重发 keymapData，此处不清除
  if (!$("#km-overlay")?.classList.contains("hidden")) {
    render();
  }
}

/** L1 顶部错误横幅：保存/加载失败对用户可见。 */
export function showKeymapError(message?: string): void {
  const banner = $("#km-error");
  const textEl = $("#km-error-text");
  $("#km-reload")?.classList.remove("is-spinning");
  if (!banner || !textEl) return;
  textEl.textContent =
    message ?? t("loadFailed", "Failed to load keymap configuration.");
  banner.classList.remove("hidden");
}

function hideKeymapError(): void {
  $("#km-error")?.classList.add("hidden");
}

/**
 * 处理宿主的保存/重置结果：失败时展示横幅（技术细节仅进 console，
 * UI 用通用文案）；成功时清除横幅。
 */
export function handleKeymapSaveResult(
  message: Extract<HostMessage, { type: "keymapSaveResult" }>,
): void {
  if (message.ok) {
    hideKeymapError();
    return;
  }
  showKeymapError(
    t(
      "saveFailed",
      "Failed to save the shortcut. Your config file was not changed.",
    ),
  );
}

function openL2(id: string, options?: { captureIndex?: number }): void {
  const item = items.find((c) => c.id === id);
  if (!item) return;
  // L2 编辑器独占键盘录制，搜索录制态必须先退出并清理定时器
  setSearchCapture(false);
  const draft = effChords(id).slice();
  l2 = {
    id,
    draft: draft.slice(),
    def: item.def,
    original: draft.slice(),
  };
  capture = null;
  clearL2Msg();
  document.body.classList.add("km-l2-open");
  $("#km-l2-overlay")?.classList.remove("hidden");
  if (options?.captureIndex != null) {
    suppressOutsideCapture = true;
    if (!draft.length) {
      startCapture("add");
    } else {
      startCapture("replace", options.captureIndex);
    }
    // 本次 click 冒泡结束后再允许“点外退出”
    setTimeout(() => {
      suppressOutsideCapture = false;
    }, 0);
  } else {
    renderL2();
  }
}

function isL2Dirty(): boolean {
  if (!l2) return false;
  // 仅比较草稿与打开时快照；进入录制但未提交不算更改
  return (
    normalizeBinding(l2.draft.join(",")) !==
    normalizeBinding(l2.original.join(","))
  );
}

/** 关闭前检查未保存；有更改则内联确认，不直接关。 */
function requestCloseL2(): void {
  if (!l2) return;
  if (isL2Dirty()) {
    showUnsavedPrompt();
    return;
  }
  closeL2(false);
}

function showUnsavedPrompt(): void {
  const el = $("#km-l2-msg");
  if (!el) return;
  el.classList.remove("hidden", "error", "warning");
  el.classList.add("warning", "is-unsaved");
  el.innerHTML = `
    <div class="km-unsaved-row">
      <div class="km-unsaved-text">${t(
        "unsavedChanges",
        "You have unsaved changes. Closing will discard them.",
      )}</div>
      <div class="km-unsaved-actions">
        <button type="button" class="km-btn" id="km-l2-keep">${t(
          "keepEditing",
          "Keep editing",
        )}</button>
        <button type="button" class="km-btn" id="km-l2-discard">${t(
          "discardChanges",
          "Discard changes",
        )}</button>
      </div>
    </div>`;
  el.querySelector("#km-l2-discard")?.addEventListener("click", () => {
    closeL2(false);
  });
  el.querySelector("#km-l2-keep")?.addEventListener("click", () => {
    clearL2Msg();
  });
  renderL2();
}

function closeL2(save: boolean): void {
  if (!l2) return;
  if (save) {
    // 若仍在录制且已有预览键，先尝试提交
    if (
      capture?.chord &&
      !capture.chord.endsWith(" …") &&
      !capture.pendingLeader
    ) {
      const pending = capture.chord;
      const mode = capture.mode;
      const index = capture.index;
      // 冲突时改为弹出覆盖确认，不恢复录制，避免按键继续覆盖提示
      capture = null;
      if (!applyCapturedChord(l2.id, l2.draft, pending, mode, index)) {
        renderL2();
        return;
      }
    } else if (capture) {
      stopCapture();
    }

    // 保存前校验草稿全部 chord，冲突时询问是否覆盖对方绑定
    const id = l2.id;
    for (const chord of l2.draft) {
      const conflict = findConflict(id, chord);
      if (conflict) {
        showConflictPrompt({ chord, mode: "save", conflict });
        renderL2();
        return;
      }
    }

    const chords = l2.draft.slice();
    const def = l2.def;
    // 本地立即生效，不等 host 回包
    const persisted = toPersistedValue(chords, def);
    if (persisted === undefined) {
      delete overrides[id];
    } else {
      overrides[id] = persisted;
    }
    postMessage({ type: "saveKeybind", id, chords });
  }
  clearL2Msg();
  l2 = null;
  capture = null;
  document.body.classList.remove("km-l2-open");
  $("#km-l2-overlay")?.classList.add("hidden");
  render();
}

/** 将一个 chord 应用到草稿列表；失败返回 false。 */
function applyCapturedChord(
  id: string,
  draft: string[],
  chord: string,
  mode: "add" | "replace",
  index?: number,
): boolean {
  const conflict = findConflict(id, chord);
  if (conflict) {
    showConflictPrompt({ chord, mode, index, conflict });
    return false;
  }
  const list = draft.slice();
  if (mode === "replace" && index != null) {
    if (index >= 0 && index < list.length) {
      list[index] = chord;
    } else {
      list.push(chord);
    }
  } else {
    if (list.some((c) => normChord(c) === normChord(chord))) {
      setL2Msg(
        formatMessage(
          t("duplicateChord", "This command already has {0}"),
          formatKey(chord),
        ),
        "warning",
      );
      return false;
    }
    list.push(chord);
  }
  if (l2) {
    l2.draft = uniqueChords(list);
  }
  clearL2Msg();
  return true;
}

function commitChord(chord: string): void {
  if (!l2 || !capture) return;
  const mode = capture.mode;
  const index = capture.index;
  if (!applyCapturedChord(l2.id, l2.draft, chord, mode, index)) {
    // 冲突/重复：停止录制，避免预览键“假成功”
    stopCapture();
    return;
  }
  stopCapture();
}

function startCapture(mode: "add" | "replace", index?: number): void {
  // 重新录制时丢弃上一轮冲突提示，避免与录制态叠加
  clearL2Msg();
  capture = { mode, index, pendingLeader: false };
  renderL2();
}

function stopCapture(): void {
  if (capture?.leaderTimer) clearTimeout(capture.leaderTimer);
  capture = null;
  renderL2();
}

function findConflict(id: string, chord: string): KeymapItem | undefined {
  const n = normChord(chord);
  for (const other of items) {
    if (other.id === id) continue;
    if (effChords(other.id).some((c) => normChord(c) === n)) {
      return other;
    }
  }
  return undefined;
}

/** 重置需确认，避免误点直接覆盖用户配置。 */
function requestReset(id: string): void {
  const item = items.find((c) => c.id === id);
  const overlay = $("#km-confirm-overlay");
  const desc = $("#km-confirm-desc");
  if (!overlay) return;
  // 确认弹窗接管键盘，残留的搜索录制态一并退出
  setSearchCapture(false);
  if (desc) {
    desc.textContent = formatMessage(
      t(
        "resetConfirm",
        'Reset "{0}" to its default bindings? Your customization will be removed.',
      ),
      item?.title ?? id,
    );
  }
  overlay.classList.remove("hidden");
  const ok = $("#km-confirm-ok");
  const cancel = $("#km-confirm-cancel");
  const close = (): void => {
    overlay.classList.add("hidden");
    ok?.replaceWith(ok.cloneNode(true));
    cancel?.replaceWith(cancel.cloneNode(true));
  };
  const onOk = (): void => {
    postMessage({ type: "resetKeybind", id });
    close();
    render();
  };
  const onCancel = (): void => {
    close();
  };
  ok?.addEventListener("click", onOk, { once: true });
  cancel?.addEventListener("click", onCancel, { once: true });
  overlay.onclick = (e) => {
    if (e.target === overlay) onCancel();
  };
}

export function eventToChord(e: KeyboardEvent): string | null {
  const MODS = ["Shift", "Control", "Alt", "Meta", "OS"];
  if (MODS.includes(e.key)) return null;
  const key = baseKeyName(e);
  if (!key) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  if (e.metaKey) parts.push("super");
  parts.push(key);
  return parts.join("+");
}

/** e.code → OpenCode/tcell 风格键名；仅映射无歧义的物理键，映射不了返回 null。 */
function keyNameFromCode(code: string): string | null {
  if (!code) return null;
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].toLowerCase();
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code.toLowerCase();
  const namedCodes: Record<string, string> = {
    Space: "space",
    Escape: "escape",
    Enter: "return",
    NumpadEnter: "kpenter",
    Backspace: "backspace",
    Tab: "tab",
    Delete: "delete",
    Insert: "insert",
    Home: "home",
    End: "end",
    PageUp: "pageup",
    PageDown: "pagedown",
    ArrowLeft: "left",
    ArrowRight: "right",
    ArrowUp: "up",
    ArrowDown: "down",
  };
  return namedCodes[code] ?? null;
}

/** e.key → 键名兜底表（e.code 缺失或不可映射时使用）。 */
const keyNameFallbacks: Record<string, string> = {
  " ": "space",
  Escape: "escape",
  Enter: "return",
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
  PageUp: "pageup",
  PageDown: "pagedown",
};

/**
 * 解析按键事件的基础键名。
 * 单个可见字符按布局结果记录（保留 shift 符号，如 shift+1 → "!"）；
 * 其余命名键优先取物理键 e.code：IME（"Process"/keyCode 229）和环境转译
 * 可能把 e.key 报成错误的键名（例如按 ctrl+1 时 key 为 "Insert"），
 * 而 e.code 始终对应物理按键。
 */
function baseKeyName(e: KeyboardEvent): string | null {
  const key = e.key;
  if (key.length === 1) {
    const codePoint = key.codePointAt(0) ?? 0;
    if (codePoint >= 0x20) {
      return key === " " ? "space" : key.toLowerCase();
    }
    // 控制字符（Windows 上 Ctrl+字母可能报成 "\x01" 等）：改用物理键
    return keyNameFromCode(e.code);
  }
  if (key === "Process" || e.keyCode === 229) {
    // IME 组合中 e.key 不可用，但物理键 code 仍然可信
    return keyNameFromCode(e.code);
  }
  if (key === "Unidentified" || key === "Dead") {
    return null;
  }
  return keyNameFromCode(e.code) ?? keyNameFallbacks[key] ?? key.toLowerCase();
}

function currentLeaderKey(): string {
  const chords = effChords("leader");
  return chords[0] ? normChord(chords[0]) : "ctrl+x";
}

function handleCaptureKey(e: KeyboardEvent): void {
  if (!capture) return;
  const simple = eventToChord(e);
  if (!simple) return;
  if (!capture.pendingLeader && normChord(simple) === currentLeaderKey()) {
    capture.pendingLeader = true;
    capture.chord = `${formatKey(simple)} …`;
    renderL2();
    capture.leaderTimer = setTimeout(() => {
      if (capture && capture.pendingLeader) {
        capture.pendingLeader = false;
        commitChord(simple);
      }
    }, 1500);
    return;
  }
  if (capture.pendingLeader) {
    const seq = `<leader>${simple}`;
    if (capture.leaderTimer) clearTimeout(capture.leaderTimer);
    capture.pendingLeader = false;
    capture.chord = seq;
    renderL2();
    commitChord(seq);
    return;
  }
  capture.chord = simple;
  renderL2();
  commitChord(simple);
}

function searchInput(): HTMLInputElement | null {
  return $("#km-search") as HTMLInputElement | null;
}

/** 进入/退出搜索录制态；退出时清理 leader 定时器并还原输入框展示。 */
function setSearchCapture(on: boolean): void {
  if (on === Boolean(searchCapture)) return;
  const input = searchInput();
  if (on) {
    searchCapture = { pendingLeader: false };
    if (input) {
      input.readOnly = true;
      input.placeholder = t("searchRecordPlaceholder", "Press keys to search…");
      input.focus();
    }
    $("#km-search-record")?.setAttribute("aria-pressed", "true");
    $(".km-search")?.classList.add("is-recording");
    return;
  }
  if (searchCapture?.leaderTimer) clearTimeout(searchCapture.leaderTimer);
  searchCapture = null;
  if (input) {
    input.readOnly = false;
    input.placeholder = searchPlaceholder;
    // leader 等待期的临时展示（“Ctrl + X …”）不是有效搜索词，退出时还原
    if (input.value !== searchQuery) input.value = searchQuery;
  }
  $("#km-search-record")?.setAttribute("aria-pressed", "false");
  $(".km-search")?.classList.remove("is-recording");
}

/** 清除按钮仅在已有搜索词时可见。 */
function updateSearchClearBtn(): void {
  $("#km-search-clear")?.classList.toggle("hidden", !searchQuery);
}

/** 清空搜索并退出录制态，焦点回到搜索框。 */
function clearSearch(): void {
  searchQuery = "";
  const input = searchInput();
  if (input) input.value = "";
  setSearchCapture(false);
  updateSearchClearBtn();
  render();
  input?.focus();
}

/**
 * 搜索录制按键处理：参考 handleCaptureKey，支持 leader 序列
 * （1.5s 内接续下一键则搜索 “<leader>+下一键”，超时单独提交该组合）。
 */
function handleSearchCaptureKey(e: KeyboardEvent): void {
  if (!searchCapture) return;
  const chord = eventToChord(e);
  if (!chord) return; // 纯修饰键
  const input = searchInput();
  const submit = (query: string): void => {
    searchQuery = query;
    if (input) input.value = query;
    setSearchCapture(false);
    updateSearchClearBtn();
    render();
  };
  if (!searchCapture.pendingLeader && normChord(chord) === currentLeaderKey()) {
    searchCapture.pendingLeader = true;
    if (input) input.value = `${formatKey(chord)} …`;
    searchCapture.leaderTimer = setTimeout(() => {
      if (searchCapture?.pendingLeader) {
        searchCapture.pendingLeader = false;
        submit(formatFKeys(chord));
      }
    }, 1500);
    return;
  }
  if (searchCapture.pendingLeader) {
    if (searchCapture.leaderTimer) clearTimeout(searchCapture.leaderTimer);
    searchCapture.pendingLeader = false;
    submit(`<leader>${formatFKeys(chord)}`);
    return;
  }
  submit(formatFKeys(chord));
}

function scrollToGroup(key: string): void {
  const body = $("#km-list");
  const label = document.getElementById(`km-group-${key}`);
  if (!body || !label) return;
  // 锚定到该组第一条数据行：sticky 标题吸附后 offsetTop/rect 不可靠
  const row = label.nextElementSibling as HTMLElement | null;
  const target =
    row && row.classList.contains("kb-row")
      ? row
      : (label.nextElementSibling as HTMLElement) || label;
  navScrollLock = true;
  if (navScrollUnlockTimer) clearTimeout(navScrollUnlockTimer);
  activeGroup = key;
  renderSideNav();

  // 非 sticky 目标用 rect 差 + scrollTop 计算布局坐标；同时让出 sticky 标题高度，
  // 标题吸附在顶部时第一项完整显示在标题下方而不是被遮住
  const stickyOffset = target === label ? 0 : label.offsetHeight + 4;
  const top =
    target.getBoundingClientRect().top -
    body.getBoundingClientRect().top +
    body.scrollTop -
    stickyOffset;

  const unlock = (): void => {
    navScrollLock = false;
    navScrollUnlockTimer = null;
    activeGroup = key;
    renderSideNav();
  };
  body.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  body.addEventListener("scrollend", unlock, { once: true });
  navScrollUnlockTimer = setTimeout(unlock, 700);
}

function syncSideNavFromScroll(): void {
  if (navScrollLock) return;
  const body = $("#km-list");
  if (!body) return;
  const bodyTop = body.getBoundingClientRect().top;
  let current = activeGroup;
  for (const g of GROUP_ORDER) {
    const el = document.getElementById(`km-group-${g}`);
    if (!el) continue;
    if (el.getBoundingClientRect().top - bodyTop <= 8) {
      current = g;
    }
  }
  if (current !== activeGroup) {
    activeGroup = current;
    renderSideNav();
  }
}

export function initKeymapUi(): void {
  // 非录制态 placeholder 由 markup 本地化生成，这里缓存以便录制结束后还原
  searchPlaceholder = searchInput()?.getAttribute("placeholder") ?? "";
  updateSearchClearBtn();
  $("#km-close")?.addEventListener("click", () => closeKeymapModal());
  $("#km-reload")?.addEventListener("click", () => {
    // Pull the latest cli.json keybinds (external edits) and re-render on data.
    hideKeymapError();
    const btn = $("#km-reload");
    btn?.classList.add("is-spinning");
    postMessage({ type: "requestKeymapData" });
    // Clear the spinner even if the host never replies.
    window.setTimeout(() => btn?.classList.remove("is-spinning"), 1200);
  });
  $("#km-error-dismiss")?.addEventListener("click", () => hideKeymapError());
  $("#km-overlay")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeKeymapModal();
  });
  $("#km-search")?.addEventListener("input", (e) => {
    searchQuery = (e.target as HTMLInputElement).value || "";
    updateSearchClearBtn();
    render();
  });
  $("#km-search-record")?.addEventListener("click", () => {
    setSearchCapture(!searchCapture);
  });
  $("#km-search-clear")?.addEventListener("click", () => clearSearch());
  $("#km-filter")?.addEventListener("change", (e) => {
    filterMode = (e.target as HTMLSelectElement).value || "all";
    render();
  });
  $("#km-side-nav")?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("[data-group]") as HTMLElement | null;
    if (!btn) return;
    scrollToGroup(btn.dataset.group || "general");
  });
  $("#km-list")?.addEventListener("scroll", () => syncSideNavFromScroll(), {
    passive: true,
  });
  $("#km-list")?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
    if (!btn) return;
    const id = btn.dataset.id || "";
    if (btn.dataset.act === "edit-chord") {
      const index = btn.dataset.index != null ? Number(btn.dataset.index) : 0;
      openL2(id, { captureIndex: index });
    } else if (btn.dataset.act === "reset") {
      requestReset(id);
    }
  });
  $("#km-list")?.addEventListener("dblclick", (e) => {
    const row = (e.target as HTMLElement).closest(".kb-row") as HTMLElement | null;
    if (!row || (e.target as HTMLElement).closest("[data-act]")) return;
    if (row.dataset.id) openL2(row.dataset.id);
  });

  $("#km-l2-close")?.addEventListener("click", () => requestCloseL2());
  $("#km-l2-save")?.addEventListener("click", () => closeL2(true));
  $("#km-l2-disable")?.addEventListener("click", () => {
    if (!l2) return;
    stopCapture();
    l2.draft = [];
    renderL2();
  });
  $("#km-l2-reset")?.addEventListener("click", () => {
    if (!l2) return;
    stopCapture();
    l2.draft = chordsOf(l2.def);
    renderL2();
  });
  $("#km-l2-chords")?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("[data-l2]") as HTMLElement | null;
    if (!btn || !l2) return;
    const act = btn.dataset.l2;
    const index = btn.dataset.index != null ? Number(btn.dataset.index) : undefined;
    if (act === "replace") {
      if (capture && capture.mode === "replace" && capture.index === index) {
        stopCapture();
      } else if (!l2.draft.length) {
        startCapture("add");
      } else {
        startCapture("replace", index);
      }
    } else if (act === "cancel") {
      stopCapture();
    } else if (act === "delete") {
      const list = l2.draft.slice();
      if (index == null || index < 0 || index >= list.length) return;
      list.splice(index, 1);
      l2.draft = list;
      stopCapture();
    }
  });

  // 点击 kbd / 录制槽以外区域时退出输入态
  document.addEventListener("click", (e) => {
    if (!capture || !l2) return;
    if (suppressOutsideCapture) return;
    const target = e.target as HTMLElement;
    if (
      target.closest(".chord-slot") ||
      target.closest("[data-l2]") ||
      target.closest("#km-l2-add")
    ) {
      return;
    }
    stopCapture();
  });

  document.addEventListener("keydown", (e) => {
    const l1Open = !$("#km-overlay")?.classList.contains("hidden");
    const l2Open = !$("#km-l2-overlay")?.classList.contains("hidden");
    if (!l1Open && !l2Open) return;
    // Escape 优先关闭最上层的重置确认弹窗，不向下传播到 L1/L2
    if (
      e.key === "Escape" &&
      !$("#km-confirm-overlay")?.classList.contains("hidden")
    ) {
      e.preventDefault();
      $("#km-confirm-cancel")?.click();
      return;
    }
    // 搜索录制：优先于 L2 capture，录制中的按键不落入终端或其他处理器
    if (searchCapture) {
      e.preventDefault();
      e.stopPropagation();
      // 只录制物理按键；宿主或注入脚本派发的合成事件不可作为录制依据
      if (!e.isTrusted) return;
      if (e.key === "Escape") {
        setSearchCapture(false);
        return;
      }
      if (
        (e.key === "Backspace" || e.key === "Delete") &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey &&
        !e.metaKey
      ) {
        clearSearch();
        return;
      }
      handleSearchCaptureKey(e);
      return;
    }
    if (capture) {
      e.preventDefault();
      e.stopPropagation();
      // 只录制物理按键；宿主或注入脚本派发的合成事件不可作为录制依据
      if (!e.isTrusted) return;
      if (e.key === "Escape") {
        stopCapture();
        return;
      }
      if (
        (e.key === "Backspace" || e.key === "Delete") &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey &&
        !e.metaKey
      ) {
        if (capture.mode === "replace" && l2 && capture.index != null) {
          const list = l2.draft.slice();
          list.splice(capture.index, 1);
          l2.draft = list;
        }
        stopCapture();
        return;
      }
      handleCaptureKey(e);
      return;
    }
    if (pendingConflict && e.key === "Escape") {
      e.preventDefault();
      clearL2Msg();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (l2Open) requestCloseL2();
      else if (l1Open) closeKeymapModal();
    }
  });
}
