/**
 * WebDAV sync UI runtime strings.
 *
 * Values resolve through the shared webview i18n dictionary (`t`). The
 * `fallback` argument is only used when the dictionary has no entry, which
 * keeps English as the source of truth instead of duplicating it here.
 */

import { has, t as translate } from "../shared/i18n/core";

/** Look up a sync UI string: dictionary translation first, English fallback.
 * Placeholders are substituted on the resolved template.
 *
 * The bundle is keyed by English source text, so `fallback` is the lookup key;
 * `key` only names the call site. */
export function syncT(
  _key: string,
  fallback: string,
  ...values: unknown[]
): string {
  const template = has(fallback) ? translate(fallback) : fallback;
  return fmt(template, ...values);
}

function fmt(template: string, ...values: unknown[]): string {
  return template.replace(/\{(\d+)\}/g, (match, index: string) => {
    const value = values[Number(index)];
    return value === undefined || value === null ? match : String(value);
  });
}

// ── Toolbar status / aria ──
function buildStrings() {
  return {
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
  actSyncNow: syncT("actSyncNow", "Sync now"),

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
  ckBothChanged: syncT("ckBothChanged", "Both sides changed"),
  ckLocalDeleted: syncT("ckLocalDeleted", "Deleted locally, still on remote"),
  ckRemoteDeleted: syncT("ckRemoteDeleted", "Deleted on remote, still local"),
  ckKeepLocal: syncT("ckKeepLocal", "Use local version"),
  ckUseRemote: syncT("ckUseRemote", "Use remote version"),
  ckResolving: syncT("ckResolving", "Applying…"),
  ckOpenDiff: syncT("ckOpenDiff", "Open diff"),
  ckSelectAll: syncT("ckSelectAll", "Select all"),
  ckSelected: (n: number) => syncT("ckSelected", "{0} selected", n),
  ckKeepLocalSelected: syncT(
    "ckKeepLocalSelected",
    "Make the local side win for the selected conflicts",
  ),
  ckUseRemoteSelected: syncT(
    "ckUseRemoteSelected",
    "Make the remote side win for the selected conflicts",
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
  trigPreStart: syncT("trigPreStart", "Launch sync"),
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
}

export type SyncStrings = ReturnType<typeof buildStrings>;

/**
 * Lazily resolved sync UI strings.
 *
 * Every value is computed on first access rather than at module evaluation:
 * the i18n bundle arrives asynchronously after this module is imported, so a
 * plain object literal would freeze English text before translations load.
 */
export const st: SyncStrings = new Proxy({} as SyncStrings, {
  get(_target, prop, receiver) {
    return Reflect.get(buildStrings(), prop, receiver);
  },
  has(_target, prop) {
    return Reflect.has(buildStrings(), prop);
  },
  ownKeys() {
    return Reflect.ownKeys(buildStrings());
  },
  getOwnPropertyDescriptor(_target, prop) {
    return Reflect.getOwnPropertyDescriptor(buildStrings(), prop);
  },
});

export { fmt as syncFormat };
