import type {
  WebDavConflictEntry,
  WebDavHistoryEntry,
  WebDavSyncSettings,
  WebDavSyncItemUi,
  WebDavSyncSnapshot,
  WebDavSyncState,
  WebDavSyncStatusDelta,
} from "../../types";

/** Merged webview-side view of the sync feature. */
export interface SyncUiState {
  state: WebDavSyncState;
  pendingCount: number;
  conflictCount: number;
  lastSyncAt?: number;
  /** Host-localized relative label, e.g. "3 min ago". */
  lastSyncLabel?: string;
  autoSyncPaused: boolean;
  /** True when this window runs the automatic sync channels. Defaults to
   * true until the first snapshot reports the real leadership. */
  leader: boolean;
  settings?: WebDavSyncSettings;
  items: WebDavSyncItemUi[];
  excludes: string[];
  conflicts: WebDavConflictEntry[];
  history: WebDavHistoryEntry[];
  logLines: string[];
}

export function initialSyncUiState(): SyncUiState {
  return {
    state: "unconfigured",
    pendingCount: 0,
    conflictCount: 0,
    autoSyncPaused: false,
    leader: true,
    items: [],
    excludes: [],
    conflicts: [],
    history: [],
    logLines: [],
  };
}

export function mergeSnapshot(
  prev: SyncUiState,
  snapshot: WebDavSyncSnapshot,
): SyncUiState {
  return {
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
    // Log is push-based, not part of the snapshot.
    logLines: prev.logLines,
  };
}

/** Merge a partial delta over the previous state; unset fields are kept. */
export function mergeDelta(
  prev: SyncUiState,
  delta: WebDavSyncStatusDelta,
): SyncUiState {
  return {
    state: delta.state ?? prev.state,
    pendingCount: delta.pendingCount ?? prev.pendingCount,
    conflictCount: delta.conflictCount ?? prev.conflictCount,
    lastSyncAt: delta.lastSyncAt ?? prev.lastSyncAt,
    lastSyncLabel: delta.lastSyncLabel ?? prev.lastSyncLabel,
    autoSyncPaused: delta.autoSyncPaused ?? prev.autoSyncPaused,
    leader: delta.leader ?? prev.leader,
    settings: prev.settings,
    items: prev.items,
    excludes: prev.excludes,
    conflicts:
      delta.conflictCount !== undefined && delta.conflictCount === 0
        ? []
        : prev.conflicts,
    history: prev.history,
    logLines: prev.logLines,
  };
}

/** Visual variant of the toolbar status icon. */
export type SyncIconKind =
  | "conflict"
  | "error"
  | "paused"
  | "auth"
  | "syncing"
  | "pending";

export interface SyncIconInfo {
  kind: SyncIconKind;
  /** Count badge for pending / conflict. */
  count?: number;
}

/**
 * Status kind by priority, ignoring the `showStatusIcon` master switch and
 * the unconfigured state: the status line and the panel jump still need a
 * target when the toolbar icon itself is hidden.
 */
export function statusIconFor(s: SyncUiState): SyncIconInfo | null {
  // A missing or rejected password blocks every sync path; surfacing it
  // above conflicts and pending counts points the user at the one fix.
  if (s.state === "needsAuth") {
    return { kind: "auth" };
  }
  if (s.conflictCount > 0) {
    return { kind: "conflict", count: s.conflictCount };
  }
  if (s.autoSyncPaused) {
    return { kind: "paused" };
  }
  if (s.state === "error") {
    return { kind: "error" };
  }
  if (s.state === "syncing") {
    return { kind: "syncing" };
  }
  if (s.pendingCount > 0) {
    return { kind: "pending", count: s.pendingCount };
  }
  return null;
}

/**
 * Visibility: syncing / error / paused states, or a non-zero pending /
 * conflict count (which may arrive while state stays "idle").
 * Unconfigured and plain idle never show. The `showStatusIcon` server
 * setting is the master switch.
 */
export function syncIconInfo(s: SyncUiState): SyncIconInfo | null {
  if (!s.settings?.showStatusIcon) {
    return null;
  }
  if (s.state === "unconfigured") {
    return null;
  }
  return statusIconFor(s);
}
