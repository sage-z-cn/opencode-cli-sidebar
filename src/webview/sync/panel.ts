/**
 * Sync panel (L2): overlay open/close, section navigation, auto-sync
 * master-switch collapse group, footer status, lazy log loading.
 */
import { postMessage } from "../shared/vscode-api";
import type {
  WebDavSyncSnapshot,
} from "../../types";
import {
  statusIconFor,
  type SyncUiState,
} from "./state";
import { st } from "./strings";
import {
  clearConflictSelection,
  collectConnectionDraft,
  collectServerConfig,
  collectSyncOptions,
  isServerFormDirty,
  populateGeneralForm,
  renderConflicts,
  renderExcludes,
  renderHistory,
  renderItems,
  renderLog,
  selectedConflictIds,
  setAllConflictsSelected,
  setConflictSelected,
  syncNowButtonLabel,
} from "./panes";

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

export type SyncPaneName = "general" | "server" | "items" | "conflict" | "history" | "log";

/** Section the toolbar sync button points at while carrying a status, so
 *  a click lands where the fix or the detail lives. */
export function paneForStatus(state: SyncUiState): SyncPaneName {
  if (state.state === "unconfigured") {
    return "general";
  }
  switch (statusIconFor(state)?.kind) {
    case "conflict":
      return "conflict";
    case "pending":
      return "items";
    case "auth":
      // Land on General so the credentials banner and its one-click jump
      // to the password field are visible; the Server pane itself carries
      // no explanation of why the user was sent there.
      return "general";
    case "error":
      return "log";
    default:
      return "general";
  }
}

// ── Collapse state (session-only; reset to expanded when re-enabled) ──

let subCollapsed = false;

function setSubCollapsed(collapsed: boolean): void {
  subCollapsed = collapsed;
  const chev = el<HTMLButtonElement>("dav-sub-toggle");
  chev.classList.toggle("is-collapsed", collapsed);
  chev.setAttribute("aria-expanded", String(!collapsed));
  el("dav-sub-body").classList.toggle("is-collapsed", collapsed);
}

/** Master switch off → hide group + chevron; on → always force-expand. */
function applyMasterEnabled(enabled: boolean): void {
  el("dav-auto-group").classList.toggle("hidden", !enabled);
  el("dav-sub-toggle").classList.toggle("hidden", !enabled);
  if (enabled) {
    setSubCollapsed(false);
  }
}

function applyPollEnabled(enabled: boolean): void {
  const interval = el<HTMLInputElement>("dav-f-interval");
  interval.disabled = !enabled;
}

// ── Navigation ──

export function switchPane(name: SyncPaneName): void {
  document
    .querySelectorAll<HTMLButtonElement>("#dav-nav .dav-nav-item")
    .forEach((btn) => btn.classList.toggle("is-on", btn.dataset.pane === name));
  document
    .querySelectorAll<HTMLElement>(".dav-pane")
    .forEach((pane) => pane.classList.toggle("is-on", pane.dataset.pane === name));
  const body = el("dav-body");
  if (name === "log") {
    postMessage({ type: "requestWebdavLog" });
    const raf =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (cb: FrameRequestCallback) => cb(0);
    raf(() => {
      // The log pane owns its own scroller: entering the tab always
      // lands on the latest lines.
      const pre = document.getElementById("dav-log-pre");
      if (pre) {
        pre.scrollTop = pre.scrollHeight;
      }
    });
  } else {
    body.scrollTop = 0;
  }
}

export function openSyncPanel(pane?: SyncPaneName): void {
  el("dav-overlay").classList.remove("hidden");
  if (pane) {
    switchPane(pane);
  }
}

export function closeSyncPanel(): void {
  clearConflictSelection();
  el("dav-overlay").classList.add("hidden");
}

// ── Error banner ──

function showError(message: string): void {
  el("dav-error-text").textContent = message;
  el("dav-error").classList.remove("hidden");
}

export function clearSyncError(): void {
  el("dav-error").classList.add("hidden");
}

// ── Rendering ──

export function footerText(state: SyncUiState): string {
  const label = state.lastSyncLabel ?? st.neverSynced;
  if (state.state === "unconfigured") {
    return st.footUnconfigured;
  }
  if (state.state === "needsAuth") {
    return st.footNeedsAuth;
  }
  if (state.autoSyncPaused) {
    return st.footPaused(label);
  }
  if (state.state === "syncing") {
    return st.footSyncing;
  }
  if (state.state === "error") {
    return st.footError(label);
  }
  if (state.conflictCount > 0) {
    return st.footConflict(state.conflictCount, label);
  }
  if (state.pendingCount > 0) {
    return st.footPending(state.pendingCount, label);
  }
  return st.footIdle(label);
}

/** Refresh all panel regions from merged state. */
export function renderPanel(state: SyncUiState): void {
  const pending = el("dav-sub-pending");
  pending.hidden = !(state.pendingCount > 0);
  pending.textContent = state.pendingCount > 0 ? st.hdrPending(state.pendingCount) : "";
  const conflict = el("dav-sub-conflict");
  conflict.hidden = !(state.conflictCount > 0);
  conflict.textContent = state.conflictCount > 0 ? st.hdrConflict(state.conflictCount) : "";
  el("dav-sub-paused").hidden = !state.autoSyncPaused;
  const auth = state.state === "needsAuth";
  const authBadge = el("dav-sub-auth");
  authBadge.hidden = !auth;
  authBadge.textContent = auth ? st.stNeedsAuth : "";
  // Non-leader window: another window owns the auto-sync channels.
  const follower =
    state.leader === false && state.state !== "unconfigured";
  const leaderBadge = el("dav-sub-leader");
  leaderBadge.hidden = !follower;
  leaderBadge.textContent = follower ? st.notLeaderBadge : "";

  const navCount = el("dav-nav-conflict-count");
  navCount.classList.toggle("hidden", !(state.conflictCount > 0));
  navCount.textContent = String(state.conflictCount);

  const syncing = state.state === "syncing";
  const syncBtn = el<HTMLButtonElement>("dav-foot-sync");
  syncBtn.disabled = syncing;
  syncBtn.classList.toggle("is-loading", syncing);
  syncBtn.setAttribute("aria-busy", String(syncing));
  syncBtn.innerHTML = syncNowButtonLabel(syncing);
  el("dav-foot-st").textContent = footerText(state);

  renderItems(state);
  renderExcludes(state);
  renderConflicts(state);
  renderHistory(state);
  renderLog(state);

  const banner = document.getElementById("dav-unconfigured-banner");
  if (banner) {
    banner.classList.toggle("hidden", state.state !== "unconfigured");
  }
  const authBanner = document.getElementById("dav-auth-banner");
  if (authBanner) {
    authBanner.classList.toggle("hidden", !auth);
    if (auth) {
      el("dav-auth-banner-text").textContent =
        state.settings?.passwordSet === false
          ? st.authBannerMissing
          : st.authBannerRejected;
    }
  }
}

/** Populate the form side from a fresh snapshot. `keepServerForm` skips
 *  the form population while the user has unsaved server-card edits;
 *  non-form updates (master/poll state) still apply. */
export function applySnapshotToPanel(
  snapshot: WebDavSyncSnapshot,
  keepServerForm = false,
): void {
  if (!keepServerForm) {
    populateGeneralForm({
      state: snapshot.state,
      pendingCount: snapshot.pendingCount,
      conflictCount: snapshot.conflictCount,
      lastSyncAt: snapshot.lastSyncAt,
      lastSyncLabel: snapshot.lastSyncLabel,
      autoSyncPaused: snapshot.autoSyncPaused,
      leader: snapshot.leader,
      settings: snapshot.settings,
      items: snapshot.items,
      excludes: snapshot.excludes,
      conflicts: snapshot.conflicts,
      history: snapshot.history,
      logLines: [],
    });
  }
  applyMasterEnabled(snapshot.settings.autoSync.enabled);
  applyPollEnabled(snapshot.settings.autoSync.remotePoll);
}

export function setTestResult(ok: boolean, latencyMs?: number, message?: string): void {
  const span = el("dav-test-result");
  span.classList.toggle("ok", ok);
  span.classList.toggle("fail", !ok);
  span.textContent = ok
    ? (message ?? st.testOk(latencyMs ?? 0))
    : st.testFail(message ?? "");
}

export function setSaveResult(ok: boolean, error?: string): void {
  if (ok) {
    const span = el("dav-test-result");
    span.classList.add("ok");
    span.classList.remove("fail");
    span.textContent = st.saveOk;
    return;
  }
  showError(st.saveFail(error ?? ""));
}

export function setTesting(): void {
  const span = el("dav-test-result");
  span.classList.remove("ok", "fail");
  span.textContent = st.testing;
}

/** Wire one-time panel events; called from initSyncUi. */

/** Hide the inline add error as soon as its input is edited again. */
function wireAddErrorClear(inputId: string, errorId: string): void {
  const input = el<HTMLInputElement>(inputId);
  input.addEventListener("input", () => {
    document.getElementById(errorId)?.classList.add("hidden");
    input.classList.remove("is-error");
  });
}

export function initPanel(handlers: {
  onSyncNow: () => void;
  onSaveServer: () => void;
  onTest: () => void;
  onApplyOptions: () => void;
  onServerFieldChange: () => void;
  onItemToggle: (id: string, enabled: boolean) => void;
  onItemRemove: (id: string) => void;
  onItemAdd: (path: string) => void;
  onExcludeAdd: (path: string) => void;
  onExcludeRemove: (path: string) => void;
  onConflictResolve: (id: string, resolution: "local" | "remote") => void;
  onConflictResolveMany: (
    ids: string[],
    resolution: "local" | "remote",
  ) => void;
  onConflictDiff: (id: string) => void;
  onClearHistory: () => void;
}): void {
  document.addEventListener("keydown", (event) => {
    if (
      event.key === "Escape" &&
      !el("dav-overlay").classList.contains("hidden")
    ) {
      closeSyncPanel();
    }
  });

  el("dav-modal-close").addEventListener("click", closeSyncPanel);
  el("dav-foot-sync").addEventListener("click", handlers.onSyncNow);
  el("dav-btn-save").addEventListener("click", handlers.onSaveServer);
  el("dav-btn-test").addEventListener("click", handlers.onTest);
  el("dav-unconfigured-go").addEventListener("click", () => switchPane("server"));
  el("dav-auth-go").textContent = `${st.authBannerGo} ›`;
  el("dav-auth-go").addEventListener("click", () => {
    switchPane("server");
    el<HTMLInputElement>("dav-f-pass").focus();
  });

  document
    .querySelectorAll<HTMLButtonElement>("#dav-nav .dav-nav-item")
    .forEach((btn) =>
      btn.addEventListener("click", () => {
        switchPane(btn.dataset.pane as SyncPaneName);
      }),
    );

  // Server card fields: track unsaved edits for the save-button highlight.
  [
    "dav-f-url",
    "dav-f-user",
    "dav-f-pass",
    "dav-f-basepath",
    "dav-f-ratelimit-req",
    "dav-f-ratelimit-window",
  ].forEach((id) => {
    el<HTMLInputElement>(id).addEventListener("input", handlers.onServerFieldChange);
  });
  ["dav-f-http", "dav-f-selfsigned"].forEach((id) => {
    el<HTMLInputElement>(id).addEventListener("change", handlers.onServerFieldChange);
  });

  // Immediate-apply options: every toggle posts the full options object.
  // The interval input commits on change (= blur or Enter), never per keystroke.
  ["dav-f-master", "dav-f-startup", "dav-f-local", "dav-f-poll", "dav-f-showicon"].forEach(
    (id) => {
      el<HTMLInputElement>(id).addEventListener("change", handlers.onApplyOptions);
    },
  );
  el("dav-f-interval").addEventListener("change", handlers.onApplyOptions);

  // History pane: quiet clear action in the header meta row.
  el("dav-hist-clear").addEventListener("click", handlers.onClearHistory);

  // Master switch: checkbox toggles, chevron only collapses.
  const master = el<HTMLInputElement>("dav-f-master");
  master.addEventListener("change", () => applyMasterEnabled(master.checked));
  const poll = el<HTMLInputElement>("dav-f-poll");
  poll.addEventListener("change", () => applyPollEnabled(poll.checked));
  el("dav-sub-toggle").addEventListener("click", () => {
    setSubCollapsed(!subCollapsed);
  });

  // Items list: delegated toggle / remove.
  el("dav-items-list").addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement;
    if (target.classList.contains("dav-item-toggle")) {
      handlers.onItemToggle(target.dataset.toggle ?? "", target.checked);
    }
  });
  el("dav-items-list").addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const remove = target.closest<HTMLElement>("[data-remove]");
    if (remove?.dataset.remove) {
      handlers.onItemRemove(remove.dataset.remove);
    }
  });
  const addInput = el<HTMLInputElement>("dav-item-add-input");
  const submitAdd = (): void => {
    const value = addInput.value.trim();
    if (value) {
      handlers.onItemAdd(value);
      addInput.value = "";
    }
  };
  el("dav-item-add-btn").addEventListener("click", submitAdd);
  addInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submitAdd();
    }
  });
  wireAddErrorClear("dav-item-add-input", "dav-item-add-error");

  // Excludes: add row + delegated remove.
  const excludeInput = el<HTMLInputElement>("dav-exclude-add-input");
  const submitExclude = (): void => {
    const value = excludeInput.value.trim();
    if (value) {
      handlers.onExcludeAdd(value);
      excludeInput.value = "";
    }
  };
  el("dav-exclude-add-btn").addEventListener("click", submitExclude);
  excludeInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submitExclude();
    }
  });
  wireAddErrorClear("dav-exclude-add-input", "dav-exclude-add-error");
  el("dav-exclude-list").addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const remove = target.closest<HTMLElement>("[data-remove-exclude]");
    if (remove?.dataset.removeExclude) {
      handlers.onExcludeRemove(remove.dataset.removeExclude);
    }
  });

  // Conflict list: delegated resolve / diff, plus multi-select for batch
  // decisions. The bar labels stay out of the shell so they follow the
  // injected locale like every other runtime string.
  el("dav-conflict-all-label").textContent = st.ckSelectAll;
  const keepSelected = el<HTMLButtonElement>("dav-conflict-keep");
  keepSelected.textContent = st.ckKeepLocal;
  keepSelected.title = st.ckKeepLocalSelected;
  keepSelected.setAttribute("aria-label", st.ckKeepLocalSelected);
  const useSelected = el<HTMLButtonElement>("dav-conflict-use");
  useSelected.textContent = st.ckUseRemote;
  useSelected.title = st.ckUseRemoteSelected;
  useSelected.setAttribute("aria-label", st.ckUseRemoteSelected);

  el("dav-conflict-list").addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement;
    if (target.classList.contains("dav-conflict-check")) {
      setConflictSelected(target.dataset.select ?? "", target.checked);
    }
  });
  el<HTMLInputElement>("dav-conflict-all").addEventListener("change", (event) => {
    setAllConflictsSelected((event.target as HTMLInputElement).checked);
  });
  const resolveSelected = (resolution: "local" | "remote"): void => {
    const ids = selectedConflictIds();
    if (ids.length === 0) {
      return;
    }
    clearConflictSelection();
    handlers.onConflictResolveMany(ids, resolution);
  };
  keepSelected.addEventListener("click", () => resolveSelected("local"));
  useSelected.addEventListener("click", () => resolveSelected("remote"));

  el("dav-conflict-list").addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const resolve = target.closest<HTMLElement>("[data-conflict]");
    if (resolve?.dataset.conflict && resolve.dataset.resolution) {
      handlers.onConflictResolve(
        resolve.dataset.conflict,
        resolve.dataset.resolution as "local" | "remote",
      );
      return;
    }
    const diff = target.closest<HTMLElement>("[data-diff]");
    if (diff?.dataset.diff) {
      handlers.onConflictDiff(diff.dataset.diff);
    }
  });
}

/** Current form values for save/test handlers. */
export { collectServerConfig, collectSyncOptions, collectConnectionDraft };

/** Toggle the save-button highlight for unsaved server-card edits. */
export function renderSaveDirty(state: SyncUiState): void {
  const btn = document.getElementById("dav-btn-save");
  if (!btn) {
    return;
  }
  btn.classList.toggle("dav-btn--attention", isServerFormDirty(state));
}
