/**
 * Host-side sync UI strings.
 *
 * `syncL10nStrings` is evaluated on the extension host and injected into
 * the webview document as `window.__OC_SYNC_L10N__` by terminal/html.ts
 * (same pattern as update/l10n.ts). `syncShellStrings` localizes the
 * static shell rendered by sync/markup.ts.
 *
 * NOTE: zh-CN translations for these keys must be added to
 * l10n/bundle.l10n.zh-cn.json (host packaging owns that file).
 */
import { l10n } from "../../i18n";
import type { SyncShellStrings } from "./shell";

export const syncL10nStrings: Record<string, string> = {
  // Toolbar icon aria
  iconSyncing: l10n.t("Syncing configuration"),
  iconPending: l10n.t("{0} file(s) pending upload"),
  iconConflict: l10n.t("{0} conflict(s) to resolve"),
  iconError: l10n.t("Sync error"),
  iconPaused: l10n.t("Auto sync paused"),
  iconAuth: l10n.t("WebDAV credentials required"),

  // Status line / panel actions
  stSyncing: l10n.t("Syncing…"),
  stIdle: l10n.t("Sync is enabled"),
  stPending: l10n.t("{0} file(s) pending upload"),
  stConflict: l10n.t("{0} file(s) need conflict resolution"),
  stError: l10n.t("Cannot reach the sync server"),
  stUnconfigured: l10n.t("WebDAV sync is not configured"),
  stNeedsAuth: l10n.t("WebDAV credentials required"),
  lastSync: l10n.t("Last sync {0}"),
  neverSynced: l10n.t("Never synced"),
  autoOn: l10n.t("Auto sync on"),
  manualMode: l10n.t("Manual-only mode"),
  pausedBadge: l10n.t("Auto sync paused after repeated errors"),
  notLeaderBadge: l10n.t("Auto-sync is handled by another window"),
  actSyncNow: l10n.t("Sync now"),

  // Panel header modes
  hdrPending: l10n.t("{0} pending"),
  hdrConflict: l10n.t("{0} conflict(s)"),

  // Items pane
  itemTagBuiltin: l10n.t("built-in"),
  itemTagPattern: l10n.t("regex"),
  itemRemove: l10n.t("Remove"),
  itemsEmpty: l10n.t("No sync items yet. Add a file or folder to sync it."),
  excludeEmpty: l10n.t("Nothing excluded yet. Add a path to skip it."),
  excludeRemove: l10n.t("Remove"),
  itemAddBtn: l10n.t("Add"),
  itemInvalidPath: l10n.t(
    "Path must be relative, without .. or an absolute prefix",
  ),
  excludeInvalid: l10n.t(
    "Exclusion must be a relative path or a regex starting with re:",
  ),

  // Conflict pane
  conflictEmpty: l10n.t("No conflicts to resolve"),
  ckLocal: l10n.t("Local"),
  ckRemote: l10n.t("Remote"),
  ckBothChanged: l10n.t("changed on both sides"),
  ckLocalDeleted: l10n.t("deleted locally"),
  ckRemoteDeleted: l10n.t("deleted on remote"),
  ckKeepLocal: l10n.t("Keep local"),
  ckUseRemote: l10n.t("Use remote"),
  ckOpenDiff: l10n.t("Open diff"),
  ckSelectAll: l10n.t("Select all"),
  ckSelected: l10n.t("{0} selected"),
  ckKeepLocalSelected: l10n.t("Keep local for selected conflicts"),
  ckUseRemoteSelected: l10n.t("Use remote for selected conflicts"),
  ckBackupHint: l10n.t(
    "Both sides are backed up before a decision is applied.",
  ),

  // History pane
  histEmpty: l10n.t("No sync history yet"),
  dirNone: l10n.t("—"),
  resSuccess: l10n.t("success"),
  resPartial: l10n.t("partial"),
  resFailed: l10n.t("failed"),
  histUploads: l10n.t("{0} uploaded"),
  histDownloads: l10n.t("{0} downloaded"),
  histDeletes: l10n.t("{0} deleted"),
  histUnknownTime: l10n.t("—"),
  trigNone: l10n.t("—"),
  trigStartup: l10n.t("Startup"),
  trigLocalChange: l10n.t("Local change"),
  trigPoll: l10n.t("Poll"),
  trigRetry: l10n.t("Retry"),
  trigConfigSave: l10n.t("Config save"),
  trigExcludeChange: l10n.t("Scope change"),
  trigManual: l10n.t("Manual"),

  // Log pane
  logEmpty: l10n.t("No sync activity yet"),

  // Footer / results
  footUnconfigured: l10n.t("Not configured · open settings to set up"),
  footIdle: l10n.t("Idle · last sync {0}"),
  footSyncing: l10n.t("Syncing…"),
  footPending: l10n.t("{0} pending · last sync {1}"),
  footConflict: l10n.t("{0} conflict(s) · last sync {1}"),
  footError: l10n.t("Offline · last sync {0}"),
  footPaused: l10n.t("Auto sync paused · last sync {0}"),
  footNeedsAuth: l10n.t(
    "Credentials required · enter the password in Server settings",
  ),
  authBannerMissing: l10n.t(
    "The WebDAV password is not stored on this device. Enter it in Server settings to resume syncing.",
  ),
  authBannerRejected: l10n.t(
    "The WebDAV server rejected the stored credentials. Update the username or password in Server settings.",
  ),
  authBannerGo: l10n.t("Enter password"),
  testOk: l10n.t("Connected · {0} ms"),
  testFail: l10n.t("Failed · {0}"),
  saveOk: l10n.t("Saved"),
  saveFail: l10n.t("Save failed · {0}"),
  testing: l10n.t("Testing…"),
  passSetBadge: l10n.t("Stored in system keychain"),
};

export const syncShellStrings: SyncShellStrings = {
  tipDismiss: l10n.t("Hide the status icon for now"),
  actSyncNow: l10n.t("Sync now"),
  panelTitle: l10n.t("OpenCode config sync"),
  panelIntro: l10n.t(
    "Sync OpenCode configuration files across devices via your WebDAV server.",
  ),
  panelAria: l10n.t("OpenCode config sync"),
  closeTitle: l10n.t("Close"),
  navGeneral: l10n.t("General"),
  navServer: l10n.t("Server"),
  unconfiguredBanner: l10n.t("WebDAV server is not configured yet."),
  unconfiguredGo: l10n.t("Set up now"),
  saveBtnHint: l10n.t("Save server settings"),
  navItems: l10n.t("Items"),
  navConflict: l10n.t("Conflicts"),
  navHistory: l10n.t("History"),
  navLog: l10n.t("Log"),
  fUrl: l10n.t("Server URL"),
  fUrlHint: l10n.t("http(s) WebDAV endpoint, port included"),
  fUser: l10n.t("Username"),
  fPass: l10n.t("Password"),
  passSetBadge: l10n.t("Stored in system keychain"),
  fBasePath: l10n.t("Remote directory (basePath)"),
  fRateLimit: l10n.t("Rate limit"),
  fRateLimitUnlimited: l10n.t("unlimited"),
  fRateLimitRequests: l10n.t("requests"),
  fRateLimitPer: l10n.t("per"),
  fRateLimitMinutes: l10n.t("min"),
  fRateLimitHint: l10n.t(
    "0 means no limit; e.g. 600 requests per 30 minutes for Jianguoyun.",
  ),
  fHttp: l10n.t("Allow plain HTTP"),
  fHttpHint: l10n.t("Enable only on trusted networks"),
  fSelfSigned: l10n.t("Accept self-signed certificates"),
  fSelfSignedHint: l10n.t("Skips certificate chain validation"),
  fShowIcon: l10n.t("Show sync status icon"),
  fShowIconHint: l10n.t(
    "Small icon next to the version badge; appears for syncing, pending, conflicts and errors only",
  ),
  autoSync: l10n.t("Auto sync"),
  chevTitle: l10n.t("Collapse or expand trigger sources"),
  fStartup: l10n.t("Sync on startup"),
  fStartupHint: l10n.t("Full reconcile once after the extension starts"),
  fLocal: l10n.t("Upload local changes"),
  fLocalHint: l10n.t(
    "Watch the config directory and upload after a 30 s debounce; handled by polling or manual sync when off",
  ),
  fPoll: l10n.t("Poll remote changes"),
  fPollHint: l10n.t("Full two-way reconcile on every interval"),
  pollInterval: l10n.t("Poll interval"),
  pollUnit: l10n.t("min"),
  testBtn: l10n.t("Test connection"),
  saveBtn: l10n.t("Save server settings"),
  itemsTitle: l10n.t("Sync items"),
  addPlaceholder: l10n.t("Relative path or re: regex, e.g. rules/team.md"),
  addBtn: l10n.t("Add"),
  itemsHintPrefix: l10n.t("Paths are relative to the"),
  itemsHintLink: l10n.t("OpenCode config directory"),
  itemsHintSuffix: l10n.t(
    "; use an re: prefix to add a regex item",
  ),
  excludeTitle: l10n.t("Exclusions"),
  excludePlaceholder: l10n.t("Path or re: regex, e.g. logs/ or re:.*\\.tmp"),
  excludeAddBtn: l10n.t("Add"),
  excludeHint: l10n.t(
    "Excluded paths are skipped by every sync item. Adding one also deletes its files from the sync server.",
  ),
  hTime: l10n.t("Time"),
  hTrigger: l10n.t("Trigger"),
  hResult: l10n.t("Result"),
  hSummary: l10n.t("Summary"),
  histClear: l10n.t("Clear history"),
};
