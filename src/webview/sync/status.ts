/**
 * One-line status content for the toolbar button hover tooltip.
 * Pure: no DOM access, so it stays testable.
 */
import { SYNC_ICONS } from "./icons";
import { statusIconFor, type SyncUiState } from "./state";
import { st } from "./strings";

export interface SyncStatusLine {
  text: string;
  color: string;
  iconHtml: string;
  blink: boolean;
}

export function syncStatusLine(state: SyncUiState): SyncStatusLine {
  const warn = "var(--vscode-errorForeground, #f87171)";
  const blue = "var(--vscode-focusBorder, #0078d4)";
  const dim = "var(--vscode-descriptionForeground, #8a8a8a)";
  const yellow = "var(--vscode-editorWarning-foreground, #cca700)";
  if (state.state === "unconfigured") {
    return {
      text: st.stUnconfigured,
      color: dim,
      iconHtml: SYNC_ICONS.cloudCheck,
      blink: false,
    };
  }
  const icon = statusIconFor(state);
  if (icon?.kind === "conflict") {
    return {
      text: st.stConflict(state.conflictCount),
      color: warn,
      iconHtml: SYNC_ICONS.conflict,
      blink: false,
    };
  }
  if (icon?.kind === "paused") {
    return {
      text: st.iconPaused,
      color: warn,
      iconHtml: SYNC_ICONS.off,
      blink: false,
    };
  }
  if (icon?.kind === "auth") {
    return {
      text: st.stNeedsAuth,
      color: yellow,
      iconHtml: SYNC_ICONS.auth,
      blink: false,
    };
  }
  if (icon?.kind === "error") {
    return {
      text: st.stError,
      color: warn,
      iconHtml: SYNC_ICONS.off,
      blink: false,
    };
  }
  if (icon?.kind === "syncing" || state.state === "syncing") {
    return {
      text: st.stSyncing,
      color: blue,
      iconHtml: SYNC_ICONS.cloudSync,
      blink: true,
    };
  }
  if (icon?.kind === "pending") {
    return {
      text: st.stPending(state.pendingCount),
      color: yellow,
      iconHtml: SYNC_ICONS.pending,
      blink: false,
    };
  }
  return {
    text: st.stIdle,
    color: dim,
    iconHtml: SYNC_ICONS.cloudCheck,
    blink: false,
  };
}
