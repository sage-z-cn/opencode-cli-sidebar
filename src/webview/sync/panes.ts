/**
 * Sync panel content renderers (server form, items, conflicts, history, log).
 *
 * Browser-only; all data flows through the message contract. Lists use
 * event delegation so re-renders never rebind handlers.
 */
import type {
  WebDavConflictEntry,
  WebDavConnectionDraft,
  WebDavHistoryEntry,
  WebDavServerConfig,
  WebDavSyncItemUi,
  WebDavSyncOptions,
} from "../../types";
import { SYNC_ICONS } from "./icons";
import { st } from "./strings";
import type { SyncUiState } from "./state";

export function escapeHtml(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function input(id: string): HTMLInputElement {
  return el<HTMLInputElement>(id);
}

// ── Server form ──

/** Fill the server form from the snapshot; called on snapshot arrival. */
export function populateGeneralForm(state: SyncUiState): void {
  const settings = state.settings;
  if (!settings) {
    return;
  }
  input("dav-f-url").value = settings.url;
  input("dav-f-user").value = settings.username;
  const passInput = input("dav-f-pass");
  passInput.value = "";
  passInput.placeholder = settings.passwordSet ? "******" : "";
  input("dav-f-basepath").value = settings.basePath;
  // 0 renders as an empty "unlimited" input; the dirty check reads the
  // same empty-to-0 conversion, so representation stays consistent.
  const rateLimitMax = settings.rateLimitMaxRequests ?? 0;
  input("dav-f-ratelimit-req").value =
    rateLimitMax > 0 ? String(rateLimitMax) : "";
  input("dav-f-ratelimit-window").value = String(
    Math.max(1, settings.rateLimitWindowMinutes ?? 30),
  );
  input("dav-f-http").checked = settings.allowInsecureHttp;
  input("dav-f-selfsigned").checked = settings.acceptSelfSigned;
  input("dav-f-showicon").checked = settings.showStatusIcon;
  input("dav-f-master").checked = settings.autoSync.enabled;
  input("dav-f-startup").checked = settings.autoSync.onStartup;
  input("dav-f-local").checked = settings.autoSync.onLocalChange;
  input("dav-f-poll").checked = settings.autoSync.remotePoll;
  input("dav-f-interval").value = String(
    Math.max(1, settings.pollIntervalMinutes),
  );
  el("dav-f-passbadge").classList.toggle("hidden", !settings.passwordSet);
}

/** Read the server card into an explicit-save payload; password only when retyped. */
export function collectServerConfig(): {
  config: WebDavServerConfig;
  password?: string;
} {
  const password = input("dav-f-pass").value;
  const config: WebDavServerConfig = {
    url: input("dav-f-url").value.trim(),
    username: input("dav-f-user").value.trim(),
    basePath: input("dav-f-basepath").value.trim(),
    allowInsecureHttp: input("dav-f-http").checked,
    acceptSelfSigned: input("dav-f-selfsigned").checked,
    // Empty inputs fall back to the "no limit" / default-window values.
    rateLimitMaxRequests: Math.max(
      0,
      Math.floor(Number(input("dav-f-ratelimit-req").value) || 0),
    ),
    rateLimitWindowMinutes: Math.max(
      1,
      Math.floor(Number(input("dav-f-ratelimit-window").value) || 30),
    ),
  };
  return { config, password: password ? password : undefined };
}

/** Read the immediate-apply options (auto sync group + status indication). */
export function collectSyncOptions(): WebDavSyncOptions {
  return {
    autoSync: {
      enabled: input("dav-f-master").checked,
      onStartup: input("dav-f-startup").checked,
      onLocalChange: input("dav-f-local").checked,
      remotePoll: input("dav-f-poll").checked,
    },
    pollIntervalMinutes: Math.max(
      1,
      Number(input("dav-f-interval").value) || 30,
    ),
    showStatusIcon: input("dav-f-showicon").checked,
  };
}

/** True when server-card fields differ from the snapshot (unsaved edits). */
export function isServerFormDirty(state: SyncUiState): boolean {
  const settings = state.settings;
  if (!settings) {
    return false;
  }
  if (input("dav-f-pass").value !== "") {
    return true;
  }
  const { config } = collectServerConfig();
  return (
    config.url !== settings.url ||
    config.username !== settings.username ||
    config.basePath !== settings.basePath ||
    config.allowInsecureHttp !== settings.allowInsecureHttp ||
    config.acceptSelfSigned !== settings.acceptSelfSigned ||
    config.rateLimitMaxRequests !== (settings.rateLimitMaxRequests ?? 0) ||
    config.rateLimitWindowMinutes !==
      (settings.rateLimitWindowMinutes ?? 30)
  );
}

/** Clear the retype-password field once its value was consumed by a save. */
export function clearServerPassword(): void {
  input("dav-f-pass").value = "";
}

/** Connection-test draft from the current form values. */
export function collectConnectionDraft(): WebDavConnectionDraft {
  const { config, password } = collectServerConfig();
  return {
    url: config.url,
    username: config.username,
    password,
    basePath: config.basePath,
    allowInsecureHttp: config.allowInsecureHttp,
    acceptSelfSigned: config.acceptSelfSigned,
  };
}

// ── Items pane ──

function itemTag(item: WebDavSyncItemUi): string {
  if (item.kind === "pattern") {
    return st.itemTagPattern;
  }
  if (item.builtin) {
    return st.itemTagBuiltin;
  }
  return "";
}

export function renderItems(state: SyncUiState): void {
  const host = el("dav-items-list");
  if (!host) {
    return;
  }
  if (state.items.length === 0) {
    host.innerHTML = `<div class="dav-item-empty">${st.itemsEmpty}</div>`;
    return;
  }
  const rows = state.items.map((item) => {
    const tag = itemTag(item);
    return `
  <div class="dav-item-row${item.enabled ? "" : " is-off"}" data-id="${escapeHtml(item.id)}">
    <input type="checkbox" class="dav-item-toggle" data-toggle="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.path)}"${item.enabled ? " checked" : ""}>
    <span class="dav-item-path" title="${escapeHtml(item.path)}">${escapeHtml(item.path)}</span>
    ${tag ? `<span class="dav-item-tag">${escapeHtml(tag)}</span>` : ""}
    ${item.builtin ? "" : `<button type="button" class="dav-item-rm" data-remove="${escapeHtml(item.id)}" aria-label="${st.itemRemove} ${escapeHtml(item.path)}" title="${st.itemRemove}">${SYNC_ICONS.close}</button>`}
  </div>`;
  });
  host.innerHTML = rows.join("");
}

// ── Excludes section ──

function excludeIsRegex(path: string): boolean {
  return path.startsWith("re:");
}

export function renderExcludes(state: SyncUiState): void {
  const host = el("dav-exclude-list");
  if (!host) {
    return;
  }
  if (state.excludes.length === 0) {
    host.innerHTML = `<div class="dav-item-empty">${st.excludeEmpty}</div>`;
    return;
  }
  host.innerHTML = state.excludes
    .map(
      (path) => `
  <div class="dav-item-row dav-exclude-row">
    <span class="dav-item-path" title="${escapeHtml(path)}">${escapeHtml(path)}</span>
    ${excludeIsRegex(path) ? `<span class="dav-item-tag">${st.itemTagPattern}</span>` : ""}
    <button type="button" class="dav-item-rm" data-remove-exclude="${escapeHtml(path)}" aria-label="${st.excludeRemove} ${escapeHtml(path)}" title="${st.excludeRemove}">${SYNC_ICONS.close}</button>
  </div>`,
    )
    .join("");
}

// ── Conflict pane ──

function formatBytes(n?: number): string {
  if (n === undefined || n === null) {
    return "—";
  }
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMtime(t?: number): string {
  if (!t) {
    return "—";
  }
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function conflictReason(kind: WebDavConflictEntry["kind"]): string {
  switch (kind) {
    case "localDeleted":
      return st.ckLocalDeleted;
    case "remoteDeleted":
      return st.ckRemoteDeleted;
    default:
      return st.ckBothChanged;
  }
}

/** Multi-select state for batch decisions; pruned against the rendered
 *  conflicts on every render so stale ids cannot leak into a batch. */
const selectedConflicts = new Set<string>();

/** Mirror the selection set into the batch bar, select-all state and
 *  the highlighted cards. Reads the DOM for the current conflict rows. */
function refreshConflictBar(): void {
  const checks = Array.from(
    document.querySelectorAll<HTMLInputElement>(".dav-conflict-check"),
  );
  let selected = 0;
  for (const check of checks) {
    const id = check.dataset.select ?? "";
    const on = selectedConflicts.has(id);
    check.checked = on;
    check
      .closest<HTMLElement>(".dav-conflict-card")
      ?.classList.toggle("is-selected", on);
    if (on) {
      selected += 1;
    }
  }
  const total = checks.length;
  const bar = document.getElementById("dav-conflict-bar");
  if (!bar) {
    return;
  }
  bar.classList.toggle("hidden", total === 0);
  const all = document.getElementById(
    "dav-conflict-all",
  ) as HTMLInputElement | null;
  if (all) {
    all.disabled = total === 0;
    all.checked = total > 0 && selected === total;
    all.indeterminate = selected > 0 && selected < total;
  }
  const count = document.getElementById("dav-conflict-sel");
  if (count) {
    count.textContent = selected > 0 ? st.ckSelected(selected) : "";
  }
  for (const id of ["dav-conflict-keep", "dav-conflict-use"]) {
    const button = document.getElementById(id) as HTMLButtonElement | null;
    if (button) {
      button.disabled = selected === 0;
    }
  }
}

export function setConflictSelected(id: string, selected: boolean): void {
  if (selected) {
    selectedConflicts.add(id);
  } else {
    selectedConflicts.delete(id);
  }
  refreshConflictBar();
}

export function setAllConflictsSelected(selected: boolean): void {
  selectedConflicts.clear();
  if (selected) {
    document
      .querySelectorAll<HTMLInputElement>(".dav-conflict-check")
      .forEach((check) => {
        if (check.dataset.select) {
          selectedConflicts.add(check.dataset.select);
        }
      });
  }
  refreshConflictBar();
}

/** Selected ids in list order for a batch action. */
export function selectedConflictIds(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>(".dav-conflict-check"),
  )
    .map((check) => check.dataset.select ?? "")
    .filter((id) => id !== "" && selectedConflicts.has(id));
}

export function clearConflictSelection(): void {
  selectedConflicts.clear();
  refreshConflictBar();
}

export function renderConflicts(state: SyncUiState): void {
  const host = el("dav-conflict-list");
  if (!host) {
    return;
  }
  const liveIds = new Set(state.conflicts.map((conflict) => conflict.id));
  for (const id of [...selectedConflicts]) {
    if (!liveIds.has(id)) {
      selectedConflicts.delete(id);
    }
  }
  if (state.conflicts.length === 0) {
    selectedConflicts.clear();
    host.innerHTML = `<div class="dav-empty">${st.conflictEmpty}</div>`;
    refreshConflictBar();
    return;
  }
  host.innerHTML =
    state.conflicts
      .map((c) => {
        const selected = selectedConflicts.has(c.id);
        return `
  <div class="dav-conflict-card${selected ? " is-selected" : ""}" data-id="${escapeHtml(c.id)}">
    <div class="dav-conflict-head">
      <input type="checkbox" class="dav-conflict-check" data-select="${escapeHtml(c.id)}" aria-label="${escapeHtml(c.path)}"${selected ? " checked" : ""}>
      <div class="dav-conflict-path" title="${escapeHtml(c.path)}">${escapeHtml(c.path)}</div>
    </div>
    <div class="dav-conflict-meta">
      <span>${st.ckLocal} <b>${formatMtime(c.localMtime)} · ${formatBytes(c.localSize)}</b></span>
      <span>${st.ckRemote} <b>${formatMtime(c.remoteMtime)} · ${formatBytes(c.remoteSize)}</b></span>
      <span>${escapeHtml(conflictReason(c.kind))}</span>
    </div>
    <div class="dav-act-row">
      <button type="button" class="dav-btn" data-resolution="local" data-conflict="${escapeHtml(c.id)}">${st.ckKeepLocal}</button>
      <button type="button" class="dav-btn dav-btn--secondary" data-resolution="remote" data-conflict="${escapeHtml(c.id)}">${st.ckUseRemote}</button>
      <button type="button" class="dav-btn dav-btn--link" data-diff="${escapeHtml(c.id)}">${st.ckOpenDiff} ›</button>
    </div>
  </div>`;
      })
      .join("") + `<div class="dav-hint">${st.ckBackupHint}</div>`;
  refreshConflictBar();
}

// ── History pane ──

function historyTime(t: number): string {
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Glyph+count chips for the merged action column. */
function historyActions(h: WebDavHistoryEntry): string {
  const counts: string[] = [];
  if (h.uploads) {
    counts.push(
      `<span class="dav-hist-up" title="${escapeHtml(st.histUploads(h.uploads))}">↑${h.uploads}</span>`,
    );
  }
  if (h.downloads) {
    counts.push(
      `<span class="dav-hist-down" title="${escapeHtml(st.histDownloads(h.downloads))}">↓${h.downloads}</span>`,
    );
  }
  if (h.deletes) {
    counts.push(
      `<span class="dav-hist-del" title="${escapeHtml(st.histDeletes(h.deletes))}">−${h.deletes}</span>`,
    );
  }
  if (counts.length > 0) {
    return counts.join("");
  }
  if (
    h.uploads !== undefined ||
    h.downloads !== undefined ||
    h.deletes !== undefined
  ) {
    return st.dirNone;
  }
  // Entries persisted before per-action counts only know direction + total.
  switch (h.direction) {
    case "up":
      return `↑${h.files}`;
    case "down":
      return `↓${h.files}`;
    case "both":
      return `↑↓${h.files}`;
    default:
      return st.dirNone;
  }
}

function triggerLabel(trigger: WebDavHistoryEntry["trigger"]): string {
  switch (trigger) {
    case "startup":
      return st.trigStartup;
    case "localChange":
      return st.trigLocalChange;
    case "poll":
      return st.trigPoll;
    case "retry":
      return st.trigRetry;
    case "configSave":
      return st.trigConfigSave;
    case "excludeChange":
      return st.trigExcludeChange;
    case "manual":
      return st.trigManual;
    default:
      return st.trigNone;
  }
}

function resultBadge(result: WebDavHistoryEntry["result"]): string {
  const cls =
    result === "success" ? "ok" : result === "partial" ? "part" : "fail";
  const label =
    result === "success"
      ? st.resSuccess
      : result === "partial"
        ? st.resPartial
        : st.resFailed;
  return `<span class="dav-badge dav-badge--${cls}">${label}</span>`;
}

export function renderHistory(state: SyncUiState): void {
  const host = el("dav-hist-list");
  if (!host) {
    return;
  }
  if (state.history.length === 0) {
    host.innerHTML = `<div class="dav-empty">${st.histEmpty}</div>`;
    return;
  }
  host.innerHTML = state.history
    .map(
      (h) => `
  <div class="dav-hist-grid dav-hist-row">
    <span class="dav-hist-t">${h.time ? historyTime(h.time) : st.histUnknownTime}</span>
    <span class="dav-hist-trig">${triggerLabel(h.trigger)}</span>
    ${resultBadge(h.result)}
    <span class="dav-hist-sum">
      <span class="dav-hist-act">${historyActions(h)}</span>
      ${h.message ? `<span class="dav-hist-msg">${escapeHtml(h.message)}</span>` : ""}
    </span>
  </div>`,
    )
    .join("");
}

// ── Log pane ──

export function renderLog(state: SyncUiState): void {
  const pre = el("dav-log-pre");
  const empty = el("dav-log-empty");
  if (!pre) {
    return;
  }
  const hasLogs = state.logLines.length > 0;
  // Follow the tail only when the reader is already near the bottom, so
  // scrolling up to older lines is never yanked back down.
  const nearBottom =
    pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  pre.textContent = hasLogs ? state.logLines.join("\n") : "";
  pre.classList.toggle("hidden", !hasLogs);
  if (empty) {
    empty.textContent = hasLogs ? "" : st.logEmpty;
    empty.classList.toggle("hidden", hasLogs);
  }
  const logPaneActive = document
    .getElementById("dav-pane-log")
    ?.classList.contains("is-on");
  if (hasLogs && nearBottom && logPaneActive) {
    pre.scrollTop = pre.scrollHeight;
  }
}

/** Footer / panel sync button label; a running pass turns the glyph into
 *  a spinner and swaps the action label for its progress state. */
export function syncNowButtonLabel(syncing = false): string {
  return syncing
    ? `${SYNC_ICONS.spinner}${st.stSyncing}`
    : `${SYNC_ICONS.refresh}${st.actSyncNow}`;
}
