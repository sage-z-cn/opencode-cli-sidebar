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
import { SYNC_ICONS } from "./icons";
import { st } from "./strings";
import { isWebdavConfirmVisible } from "./confirm";
import {
  applyModeUi,
  applyPreStartCooldownEnabled,
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
  startConflictBatchResolution,
  startConflictResolution,
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

/** Footer accent: only the conflict line carries a warning tone; every
 *  earlier state in footerText keeps the neutral description color. */
export function footerTone(state: SyncUiState): "warn" | undefined {
  if (
    state.state === "unconfigured" ||
    state.state === "needsAuth" ||
    state.state === "syncing" ||
    state.state === "error" ||
    state.autoSyncPaused
  ) {
    return undefined;
  }
  return state.conflictCount > 0 ? "warn" : undefined;
}

/** Refresh all panel regions from merged state. */
export function renderPanel(state: SyncUiState): void {
  const auth = state.state === "needsAuth";

  const navCount = el("dav-nav-conflict-count");
  navCount.classList.toggle("hidden", !(state.conflictCount > 0));
  navCount.textContent = String(state.conflictCount);

  const syncing = state.state === "syncing";
  const syncBtn = el<HTMLButtonElement>("dav-foot-sync");
  syncBtn.disabled = syncing;
  syncBtn.classList.toggle("is-loading", syncing);
  syncBtn.setAttribute("aria-busy", String(syncing));
  syncBtn.innerHTML = syncNowButtonLabel(syncing);
  for (const id of ["dav-btn-force-pull", "dav-btn-force-push"]) {
    const button = document.getElementById(id) as HTMLButtonElement | null;
    if (button) {
      button.disabled = syncing;
    }
  }
  const foot = el("dav-foot-st");
  foot.textContent = footerText(state);
  foot.classList.toggle("is-warn", footerTone(state) === "warn");

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
  applyModeUi(snapshot.settings.mode);
  applyPreStartCooldownEnabled(snapshot.settings.preStartSync ?? false);
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
  onForcePull: () => void;
  onForcePush: () => void;
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
      !el("dav-overlay").classList.contains("hidden") &&
      // The confirmation sits above the panel; its own Esc handler owns the
      // key while it is open, so closing the panel here would stack one
      // dismissal on top of the other.
      !isWebdavConfirmVisible()
    ) {
      closeSyncPanel();
    }
  });

  el("dav-modal-close").addEventListener("click", closeSyncPanel);
  el("dav-foot-sync").addEventListener("click", handlers.onSyncNow);
  el("dav-btn-force-pull").addEventListener("click", handlers.onForcePull);
  el("dav-btn-force-push").addEventListener("click", handlers.onForcePush);
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
  ["dav-f-master", "dav-f-startup", "dav-f-local", "dav-f-poll", "dav-f-showicon", "dav-f-prestart"].forEach(
    (id) => {
      el<HTMLInputElement>(id).addEventListener("change", handlers.onApplyOptions);
    },
  );
  el("dav-f-interval").addEventListener("change", handlers.onApplyOptions);
  el("dav-f-prestart-cooldown").addEventListener(
    "change",
    handlers.onApplyOptions,
  );
  el("dav-f-deletions").addEventListener("change", handlers.onApplyOptions);
  const modeSelect = el<HTMLSelectElement>("dav-f-mode");
  modeSelect.addEventListener("change", () => {
    // Apply the dependent controls immediately; the persisted snapshot will
    // confirm the same value on its way back.
    applyModeUi(
      modeSelect.value === "followServer" ? "followServer" : "bidirectional",
    );
    handlers.onApplyOptions();
  });

  // History pane: quiet clear action in the header meta row.
  el("dav-hist-clear").addEventListener("click", handlers.onClearHistory);

  // Master switch: checkbox toggles, chevron only collapses.
  const master = el<HTMLInputElement>("dav-f-master");
  master.addEventListener("change", () => applyMasterEnabled(master.checked));
  const poll = el<HTMLInputElement>("dav-f-poll");
  poll.addEventListener("change", () => applyPollEnabled(poll.checked));
  const preStart = el<HTMLInputElement>("dav-f-prestart");
  preStart.addEventListener("change", () =>
    applyPreStartCooldownEnabled(preStart.checked),
  );
  applyPreStartCooldownEnabled(preStart.checked);
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
  const useSelected = el<HTMLButtonElement>("dav-conflict-use");
  // Labels are swapped between their idle and busy form by the bar
  // refresh. Both variants carry the spinner markup slot, so the
  // init-time value is the idle one and the refresh only swaps classes.
  keepSelected.dataset.idleLabel = st.ckKeepLocal;
  keepSelected.dataset.busyLabel = `${SYNC_ICONS.spinner}${st.ckResolving}`;
  keepSelected.title = st.ckKeepLocalSelected;
  keepSelected.setAttribute("aria-label", st.ckKeepLocalSelected);
  useSelected.dataset.idleLabel = st.ckUseRemote;
  useSelected.dataset.busyLabel = `${SYNC_ICONS.spinner}${st.ckResolving}`;
  useSelected.title = st.ckUseRemoteSelected;
  useSelected.setAttribute("aria-label", st.ckUseRemoteSelected);
  for (const [button, label] of [
    [keepSelected, st.ckKeepLocal],
    [useSelected, st.ckUseRemote],
  ] as const) {
    button.textContent = label;
    button.classList.remove("is-loading");
    button.setAttribute("aria-busy", "false");
  }

  el("dav-conflict-list").addEventListener("change", (event) => {
    const target = event.target as HTMLInputElement;
    if (target.classList.contains("dav-conflict-check")) {
      setConflictSelected(target.dataset.select ?? "", target.checked);
    }
  });
  el("dav-conflict-all").addEventListener("change", (event) => {
    setAllConflictsSelected((event.target as HTMLInputElement).checked);
  });
  keepSelected.addEventListener("click", () =>
    startConflictBatchResolution("local", (payload) =>
      handlers.onConflictResolveMany(payload.ids, payload.resolution),
    ),
  );
  useSelected.addEventListener("click", () =>
    startConflictBatchResolution("remote", (payload) =>
      handlers.onConflictResolveMany(payload.ids, payload.resolution),
    ),
  );

  el("dav-conflict-list").addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const resolve = target.closest<HTMLElement>("[data-conflict]");
    if (resolve?.dataset.conflict && resolve.dataset.resolution) {
      startConflictResolution(
        resolve.dataset.conflict,
        resolve.dataset.resolution as "local" | "remote",
        (payload) => handlers.onConflictResolve(payload.id, payload.resolution),
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
