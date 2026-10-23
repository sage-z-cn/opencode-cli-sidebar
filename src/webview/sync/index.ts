/**
 * WebDAV config sync UI (webview side).
 *
 * Browser-only; all host I/O goes through WebviewMessage. Layers:
 * L0 toolbar config button carrying the sync status, L1 hover status
 * tooltip, L2 full panel (km-modal pattern) with
 * server/items/conflicts/history/log.
 */
import { postMessage } from "../shared/vscode-api";
import type {
  WebDavSyncSnapshot,
  WebDavSyncStatusDelta,
} from "../../types";
import { SYNC_ICONS } from "./icons";
import {
  initialSyncUiState,
  mergeDelta,
  mergeSnapshot,
  syncIconInfo,
  type SyncIconKind,
  type SyncUiState,
} from "./state";
import { st } from "./strings";
import { closeSyncTooltip, initSyncTooltip, updateSyncTooltip } from "./tooltip";
import { clearServerPassword, isServerFormDirty } from "./panes";
import {
  applySnapshotToPanel,
  clearSyncError,
  closeSyncPanel,
  initPanel,
  openSyncPanel,
  paneForStatus,
  renderPanel,
  renderSaveDirty,
  setSaveResult,
  setTestResult,
  setTesting,
  collectServerConfig,
  collectSyncOptions,
  collectConnectionDraft,
} from "./panel";

let initialized = false;
let state: SyncUiState = initialSyncUiState();

/** Routes webdavSaveResult feedback: server save vs immediate options/items. */
let lastSaveKind: "server" | "options" | "items" | null = null;

/** Transient notice (delta.notice) with a 4.5 s TTL. */
let noticeText = "";
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
const NOTICE_TTL_MS = 4500;

/** Add-item inline error with the same TTL. The owning input gets an
 *  error border so the message reads as part of the add composite. */
let addItemErrorTimer: ReturnType<typeof setTimeout> | null = null;

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function addInputForError(errorId: string): HTMLInputElement | null {
  return document.getElementById(
    errorId.replace("-add-error", "-add-input"),
  ) as HTMLInputElement | null;
}

function hideAddItemError(errorId: string): void {
  document.getElementById(errorId)?.classList.add("hidden");
  addInputForError(errorId)?.classList.remove("is-error");
}

function showAddItemError(
  message: string,
  errorId = "dav-item-add-error",
): void {
  const node = el(errorId);
  node.textContent = message;
  node.classList.remove("hidden");
  addInputForError(errorId)?.classList.add("is-error");
  if (addItemErrorTimer) {
    clearTimeout(addItemErrorTimer);
  }
  addItemErrorTimer = setTimeout(() => {
    hideAddItemError(errorId);
  }, NOTICE_TTL_MS);
}

// ── Toolbar sync entry button (L0) ──

/** Acknowledged status kind (tooltip ✕ or button click): pure webview-side
 *  gating, in-memory only. The button keeps its plain entry glyph while
 *  syncIconInfo returns the same kind; a different kind or a cleared
 *  status resets it. */
let dismissedIconKind: SyncIconKind | null = null;

/** Plain entry glyph and labels captured on first render, restored whenever
 *  the button carries no status. */
let entryGlyphHtml: string | null = null;
let entryLabel: string | null = null;
let entryTitle: string | null = null;

const ICON_KIND_STATE: Record<string, string> = {
  conflict: "conflict",
  error: "error",
  paused: "error",
  auth: "auth",
  syncing: "syncing",
  pending: "pending",
};

function iconLabel(info: NonNullable<ReturnType<typeof syncIconInfo>>): string {
  switch (info.kind) {
    case "conflict":
      return st.iconConflict(info.count ?? 0);
    case "pending":
      return st.iconPending(info.count ?? 0);
    case "syncing":
      return st.iconSyncing;
    case "paused":
      return st.iconPaused;
    case "auth":
      return st.iconAuth;
    default:
      return st.iconError;
  }
}

/** Acknowledge the current status so the button drops its status glyph
 *  until the kind changes or the status clears. Used by both the button
 *  click and the tooltip ✕. */
function dismissStatusIcon(): void {
  const info = syncIconInfo(state);
  if (!info) {
    return;
  }
  dismissedIconKind = info.kind;
  render();
}

/** True when the toolbar button currently carries the status. */
function statusShown(): boolean {
  const info = syncIconInfo(state);
  return info !== null && dismissedIconKind !== info.kind;
}

function renderIcon(): void {
  const btn = document.getElementById("btn-dav-sync-panel");
  const glyph = document.getElementById("dav-sync-glyph");
  const count = document.getElementById("dav-sync-count");
  if (!btn || !glyph || !count) {
    return;
  }
  entryGlyphHtml ??= glyph.innerHTML;
  entryLabel ??= btn.getAttribute("aria-label") ?? "";
  entryTitle ??= btn.getAttribute("title");
  const info = syncIconInfo(state);
  if (!info) {
    // Status cleared: any dismissal is forgotten.
    dismissedIconKind = null;
  }
  if (!info || dismissedIconKind === info.kind) {
    btn.removeAttribute("data-state");
    btn.setAttribute("aria-label", entryLabel);
    if (entryTitle === null) {
      btn.removeAttribute("title");
    } else {
      btn.setAttribute("title", entryTitle);
    }
    glyph.innerHTML = entryGlyphHtml;
    count.textContent = "";
    count.classList.add("hidden");
    closeSyncTooltip();
    return;
  }
  dismissedIconKind = null;
  btn.dataset.state = ICON_KIND_STATE[info.kind] ?? "error";
  // The hover tooltip replaces the native title while a status is shown.
  btn.removeAttribute("title");
  btn.setAttribute(
    "aria-label",
    entryLabel ? `${entryLabel}: ${iconLabel(info)}` : iconLabel(info),
  );
  const iconHtml =
    info.kind === "syncing"
      ? SYNC_ICONS.cloudSync
      : info.kind === "pending"
        ? SYNC_ICONS.up
        : info.kind === "conflict"
          ? SYNC_ICONS.warn
          : info.kind === "auth"
            ? SYNC_ICONS.key
            : SYNC_ICONS.off;
  glyph.innerHTML =
    info.kind === "syncing"
      ? `<span class="dav-blink">${iconHtml}</span>`
      : iconHtml;
  const n = info.count ?? 0;
  count.textContent = String(n);
  count.classList.toggle("hidden", n <= 0);
}

// ── Notice / inline errors ──

function showNotice(text: string): void {
  noticeText = text;
  if (noticeTimer) {
    clearTimeout(noticeTimer);
  }
  noticeTimer = setTimeout(() => {
    noticeText = "";
    render();
  }, NOTICE_TTL_MS);
  render();
}

// ── Global render ──

function render(): void {
  renderIcon();
  updateSyncTooltip(state);
  renderPanel(state);
  renderSaveDirty(state);
  if (noticeText) {
    el("dav-foot-st").textContent = noticeText;
  }
}

// ── Host message entry points ──

export function applyWebdavSyncData(snapshot: WebDavSyncSnapshot): void {
  // Freeze the form side while the user has unsaved server-card edits so
  // a background snapshot cannot wipe them. Before the first snapshot
  // state.settings is undefined, so isServerFormDirty is false and the
  // form is populated normally.
  const keepServerForm = isServerFormDirty(state);
  state = mergeSnapshot(state, snapshot);
  applySnapshotToPanel(snapshot, keepServerForm);
  clearSyncError();
  render();
}

export function applyWebdavStatus(delta: WebDavSyncStatusDelta): void {
  const prevConflictCount = state.conflictCount;
  state = mergeDelta(state, delta);
  if (delta.notice) {
    showNotice(delta.notice);
  }
  // Deltas never carry the conflicts array: when conflicts appear or
  // grow, ask the host for a full snapshot so the list is fresh. The
  // panel is never auto-opened; the user opens it from the toolbar.
  if (
    delta.conflictCount !== undefined && delta.conflictCount > prevConflictCount
  ) {
    postMessage({ type: "requestWebdavSyncData" });
  }
  render();
}

export function applyWebdavTestResult(
  ok: boolean,
  latencyMs?: number,
  message?: string,
): void {
  setTestResult(ok, latencyMs, message);
}

export function applyWebdavSaveResult(ok: boolean, error?: string): void {
  const kind = lastSaveKind;
  lastSaveKind = null;
  if (!ok) {
    // 失败统一走面板顶部错误横幅，明确可见。
    setSaveResult(false, error);
    return;
  }
  if (kind === "server") {
    setSaveResult(true);
    // The typed password is consumed by the successful save; clearing it
    // here keeps the post-save form state clean even though the snapshot
    // reply no longer repopulates the form while it held edits.
    clearServerPassword();
    return;
  }
  // 即改即生效的成功反馈保持低调：瞬时 notice。
  // 来源不明的回执不渲染任何内容，避免在服务器页误显“已保存”。
  if (kind === "options" || kind === "items") {
    showNotice(st.saveOk);
  }
}

export function applyWebdavLog(lines: string[]): void {
  state = { ...state, logLines: lines };
  renderPanel(state);
}

// ── Init ──

/** Input classification for item/exclude add rows: plain relative path or re: regex. */
function classifyInput(value: string): "path" | "regex" | "invalid" {
  if (value.startsWith("re:")) {
    const pattern = value.slice(3);
    if (!pattern) {
      return "invalid";
    }
    try {
      void new RegExp(pattern);
      return "regex";
    } catch {
      return "invalid";
    }
  }
  if (
    !value ||
    value.includes("..") ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[a-zA-Z]:[\\/]/.test(value)
  ) {
    return "invalid";
  }
  return /^[-_.a-zA-Z0-9][a-zA-Z0-9 ._\/\\:*\[\]-]*$/.test(value)
    ? "path"
    : "invalid";
}

export function initSyncUi(): void {
  if (initialized) {
    return;
  }
  initialized = true;

  // One button carries the status and opens the panel: a shown status is
  // acknowledged and lands on its matching section, a plain entry click
  // opens General.
  const panelBtn = document.getElementById("btn-dav-sync-panel");
  // The button ships hidden in toolbar.html; reveal it once the sync UI owns it.
  panelBtn?.classList.remove("hidden");
  panelBtn?.addEventListener("click", () => {
    const jumpToStatus = statusShown();
    if (jumpToStatus) {
      dismissStatusIcon();
    }
    openSyncPanel(jumpToStatus ? paneForStatus(state) : "general");
  });

  initSyncTooltip({ onDismiss: dismissStatusIcon });

  initPanel({
    onSyncNow: () => postMessage({ type: "syncWebdavNow" }),
    onSaveServer: () => {
      const { config, password } = collectServerConfig();
      lastSaveKind = "server";
      postMessage({ type: "saveWebdavServerConfig", config, password });
    },
    onApplyOptions: () => {
      lastSaveKind = "options";
      postMessage({ type: "applyWebdavSyncOptions", options: collectSyncOptions() });
    },
    onServerFieldChange: () => renderSaveDirty(state),
    onTest: () => {
      setTesting();
      postMessage({ type: "testWebdavConnection", draft: collectConnectionDraft() });
    },
    onItemToggle: (id, enabled) => {
      lastSaveKind = "items";
      postMessage({ type: "setWebdavItemEnabled", id, enabled });
    },
    onItemRemove: (id) => {
      lastSaveKind = "items";
      postMessage({ type: "removeWebdavItem", id });
    },
    onItemAdd: (path) => {
      if (classifyInput(path) === "invalid") {
        showAddItemError(st.itemInvalidPath);
        return;
      }
      lastSaveKind = "items";
      postMessage({ type: "addWebdavItem", path });
    },
    onExcludeAdd: (path) => {
      if (classifyInput(path) === "invalid") {
        showAddItemError(st.excludeInvalid, "dav-exclude-add-error");
        return;
      }
      lastSaveKind = "items";
      postMessage({ type: "addWebdavExclude", path });
    },
    onExcludeRemove: (path) => {
      lastSaveKind = "items";
      postMessage({ type: "removeWebdavExclude", path });
    },
    onConflictResolve: (id, resolution) =>
      postMessage({ type: "resolveWebdavConflict", id, resolution }),
    onConflictResolveMany: (ids, resolution) =>
      postMessage({ type: "resolveWebdavConflicts", ids, resolution }),
    onConflictDiff: (id) => postMessage({ type: "openWebdavDiff", id }),
    onClearHistory: () => postMessage({ type: "clearWebdavHistory" }),
  });

  document
    .getElementById("dav-open-config-dir")
    ?.addEventListener("click", () =>
      postMessage({ type: "openOpenCodeConfigDir" }),
    );

  render();
  postMessage({ type: "requestWebdavSyncData" });
}

export { closeSyncPanel, openSyncPanel };
