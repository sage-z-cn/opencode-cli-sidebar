/**
 * WebDAV sync UI runtime strings.
 *
 * English fallbacks live here; the extension host injects translated
 * values as `window.__OC_SYNC_L10N__` (see sync/l10n.ts + terminal/html.ts),
 * mirroring the update module's pattern.
 */

const injected: Record<string, string> =
  typeof window !== "undefined"
    ? (window as unknown as { __OC_SYNC_L10N__?: Record<string, string> })
        .__OC_SYNC_L10N__ ?? {}
    : {};

/** Look up a sync UI string: injected translation first, English fallback.
 * Placeholders are substituted on the resolved template, so injected strings
 * may keep `{0}`-style markers. */
export function syncT(
  key: string,
  fallback: string,
  ...values: unknown[]
): string {
  return fmt(injected[key] ?? fallback, ...values);
}

function fmt(template: string, ...values: unknown[]): string {
  return template.replace(/\{(\d+)\}/g, (match, index: string) => {
    const value = values[Number(index)];
    return value === undefined || value === null ? match : String(value);
  });
}

// ── Toolbar icon / aria ──
export const st = {
  iconSyncing: syncT("iconSyncing", "Syncing configuration"),
  iconPending: (n: number) =>
    syncT("iconPending", "{0} file(s) pending upload", n),
  iconConflict: (n: number) =>
    syncT("iconConflict", "{0} conflict(s) to resolve", n),
  iconError: syncT("iconError", "Sync error"),
  iconPaused: syncT("iconPaused", "Auto sync paused"),
  iconAuth: syncT("iconAuth", "WebDAV credentials required"),

  // ── Status line (tooltip) ──
  stSyncing: syncT("stSyncing", "Syncing…"),
  stIdle: syncT("stIdle", "Sync is enabled"),
  stPending: (n: number) =>
    syncT("stPending", "{0} file(s) pending upload", n),
  stConflict: (n: number) =>
    syncT("stConflict", "{0} file(s) need conflict resolution", n),
  stError: syncT("stError", "Cannot reach the sync server"),
  stUnconfigured: syncT("stUnconfigured", "WebDAV sync is not configured"),
  stNeedsAuth: syncT("stNeedsAuth", "WebDAV credentials required"),
  lastSync: (label: string) =>
    syncT("lastSync", "Last sync {0}", label),
  neverSynced: syncT("neverSynced", "Never synced"),
  autoOn: syncT("autoOn", "Auto sync on"),
  manualMode: syncT("manualMode", "Manual-only mode"),
  pausedBadge: syncT("pausedBadge", "Auto sync paused after repeated errors"),
  notLeaderBadge: syncT(
    "notLeaderBadge",
    "Auto-sync is handled by another window",
  ),
  actSyncNow: syncT("actSyncNow", "Sync now"),

  // ── Panel header ──
  hdrPending: (n: number) => syncT("hdrPending", "{0} pending", n),
  hdrConflict: (n: number) => syncT("hdrConflict", "{0} conflict(s)", n),

  // ── Items pane ──
  itemTagBuiltin: syncT("itemTagBuiltin", "built-in"),
  itemTagPattern: syncT("itemTagPattern", "regex"),
  itemRemove: syncT("itemRemove", "Remove"),
  itemAddBtn: syncT("itemAddBtn", "Add"),
  itemsEmpty: syncT(
    "itemsEmpty",
    "No sync items yet. Add a file or folder to sync it.",
  ),
  itemInvalidPath: syncT(
    "itemInvalidPath",
    "Path must be relative, without .. or an absolute prefix",
  ),
  excludeEmpty: syncT(
    "excludeEmpty",
    "Nothing excluded yet. Add a path to skip it.",
  ),
  excludeRemove: syncT("excludeRemove", "Remove"),
  excludeInvalid: syncT(
    "excludeInvalid",
    "Exclusion must be a relative path or a regex starting with re:",
  ),

  // ── Conflict pane ──
  conflictEmpty: syncT("conflictEmpty", "No conflicts to resolve"),
  ckLocal: syncT("ckLocal", "Local"),
  ckRemote: syncT("ckRemote", "Remote"),
  ckBothChanged: syncT("ckBothChanged", "changed on both sides"),
  ckLocalDeleted: syncT("ckLocalDeleted", "deleted locally"),
  ckRemoteDeleted: syncT("ckRemoteDeleted", "deleted on remote"),
  ckKeepLocal: syncT("ckKeepLocal", "Keep local"),
  ckUseRemote: syncT("ckUseRemote", "Use remote"),
  ckOpenDiff: syncT("ckOpenDiff", "Open diff"),
  ckSelectAll: syncT("ckSelectAll", "Select all"),
  ckSelected: (n: number) => syncT("ckSelected", "{0} selected", n),
  ckKeepLocalSelected: syncT(
    "ckKeepLocalSelected",
    "Keep local for selected conflicts",
  ),
  ckUseRemoteSelected: syncT(
    "ckUseRemoteSelected",
    "Use remote for selected conflicts",
  ),
  ckBackupHint: syncT(
    "ckBackupHint",
    "Both sides are backed up before a decision is applied.",
  ),

  // ── History pane ──
  histEmpty: syncT("histEmpty", "No sync history yet"),
  dirNone: syncT("dirNone", "—"),
  resSuccess: syncT("resSuccess", "success"),
  resPartial: syncT("resPartial", "partial"),
  resFailed: syncT("resFailed", "failed"),
  histUploads: (n: number) => syncT("histUploads", "{0} uploaded", n),
  histDownloads: (n: number) => syncT("histDownloads", "{0} downloaded", n),
  histDeletes: (n: number) => syncT("histDeletes", "{0} deleted", n),
  histUnknownTime: syncT("histUnknownTime", "—"),
  trigNone: syncT("trigNone", "—"),
  trigStartup: syncT("trigStartup", "Startup"),
  trigLocalChange: syncT("trigLocalChange", "Local change"),
  trigPoll: syncT("trigPoll", "Poll"),
  trigRetry: syncT("trigRetry", "Retry"),
  trigConfigSave: syncT("trigConfigSave", "Config save"),
  trigExcludeChange: syncT("trigExcludeChange", "Scope change"),
  trigManual: syncT("trigManual", "Manual"),

  // ── Log pane ──
  logEmpty: syncT("logEmpty", "No sync activity yet"),

  // ── Footer / results ──
  footUnconfigured: syncT("footUnconfigured", "Not configured · open settings to set up"),
  footIdle: (label: string) =>
    syncT("footIdle", "Idle · last sync {0}", label),
  footSyncing: syncT("footSyncing", "Syncing…"),
  footPending: (n: number, label: string) =>
    syncT("footPending", "{0} pending · last sync {1}", n, label),
  footConflict: (n: number, label: string) =>
    syncT("footConflict", "{0} conflict(s) · last sync {1}", n, label),
  footError: (label: string) =>
    syncT("footError", "Offline · last sync {0}", label),
  footPaused: (label: string) =>
    syncT("footPaused", "Auto sync paused · last sync {0}", label),
  footNeedsAuth: syncT(
    "footNeedsAuth",
    "Credentials required · enter the password in Server settings",
  ),
  authBannerMissing: syncT(
    "authBannerMissing",
    "The WebDAV password is not stored on this device. Enter it in Server settings to resume syncing.",
  ),
  authBannerRejected: syncT(
    "authBannerRejected",
    "The WebDAV server rejected the stored credentials. Update the username or password in Server settings.",
  ),
  authBannerGo: syncT("authBannerGo", "Enter password"),
  testOk: (ms: number) => syncT("testOk", "Connected · {0} ms", ms),
  testFail: (msg: string) => syncT("testFail", "Failed · {0}", msg),
  saveOk: syncT("saveOk", "Saved"),
  saveFail: (msg: string) => syncT("saveFail", "Save failed · {0}", msg),
  testing: syncT("testing", "Testing…"),
  passSetBadge: syncT("passSetBadge", "Stored in system keychain"),
};

export { fmt as syncFormat };
