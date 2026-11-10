/**
 * Localized strings for the WebDAV sync shell.
 *
 * The static shell rendered by sync/markup.ts resolves these strings through
 * the webview-side `t()` helper, which looks them up in the l10n dictionary
 * served by the host. They are built inside `buildSyncShellStrings()` instead
 * of a module-scope constant so the lookups run only after that dictionary has
 * finished loading asynchronously.
 *
 * NOTE: zh-CN translations for these keys must be added to
 * l10n/bundle.l10n.zh-cn.json (host packaging owns that file).
 */
import { t } from "../shared/i18n/core";
import type { SyncShellStrings } from "./shell";

export function buildSyncShellStrings(): SyncShellStrings {
  return {
    tipDismiss: t("Hide the sync status for now"),
    actSyncNow: t("Sync now"),
    panelTitle: t("OpenCode config sync"),
    panelIntro: t(
      "Sync OpenCode configuration files across devices via your WebDAV server.",
    ),
    panelAria: t("OpenCode config sync"),
    closeTitle: t("Close"),
    navGeneral: t("General"),
    navServer: t("Server"),
    unconfiguredBanner: t("WebDAV server is not configured yet."),
    unconfiguredGo: t("Set up now"),
    saveBtnHint: t("Save server settings"),
    navItems: t("Items"),
    navConflict: t("Conflicts"),
    navHistory: t("History"),
    navLog: t("Log"),
    fUrl: t("Server URL"),
    fUrlHint: t("http(s) WebDAV endpoint, port included"),
    fUser: t("Username"),
    fPass: t("Password"),
    passSetBadge: t("Stored in system keychain"),
    fBasePath: t("Remote directory (basePath)"),
    fRateLimit: t("Rate limit"),
    fRateLimitUnlimited: t("unlimited"),
    fRateLimitRequests: t("requests"),
    fRateLimitPer: t("per"),
    fRateLimitMinutes: t("min"),
    fRateLimitHint: t(
      "0 means no limit; e.g. 600 requests per 30 minutes for Jianguoyun.",
    ),
    fHttp: t("Allow plain HTTP"),
    fHttpHint: t("Enable only on trusted networks"),
    fSelfSigned: t("Accept self-signed certificates"),
    fSelfSignedHint: t("Skips certificate chain validation"),
    fShowIcon: t("Show sync status on the toolbar button"),
    fShowIconHint: t(
      "Shown on the config sync toolbar button; appears for syncing, pending, conflicts and errors only",
    ),
    fPreStart: t("Sync key config before OpenCode starts"),
    fPreStartHint: t(
      "Holds the launch until opencode.json, cli.json and the oh-my-opencode-slim config are current",
    ),
    preStartCooldown: t("Cooldown"),
    preStartCooldownUnit: t("min"),
    preStartHint: t(
      "Skips the launch sync when it ran within the cooldown window. 0 syncs on every launch.",
    ),
    deletionPolicy: t("When a file is deleted"),
    deletionPrompt: t("Ask first"),
    deletionIgnore: t("Keep the other copy"),
    deletionPropagate: t("Delete on both sides"),
    deletionHint: t(
      "Deleting on both sides removes the other copy only while it still matches the last sync",
    ),
    autoSync: t("Auto sync"),
    chevTitle: t("Collapse or expand trigger sources"),
    fStartup: t("Sync after the extension starts"),
    fStartupHint: t(
      "Full reconcile of every sync item; when launch sync is on, the files it covers are already current",
    ),
    fLocal: t("Upload local changes"),
    fLocalHint: t(
      "Watch the config directory and upload after a 30 s debounce; handled by polling or manual sync when off",
    ),
    fPoll: t("Poll remote changes"),
    fPollHint: t("Full two-way reconcile on every interval"),
    pollInterval: t("Poll interval"),
    pollUnit: t("min"),
    testBtn: t("Test connection"),
    saveBtn: t("Save server settings"),
    itemsTitle: t("Sync items"),
    addPlaceholder: t("Relative path or re: regex, e.g. rules/team.md"),
    addBtn: t("Add"),
    itemsHintPrefix: t("Paths are relative to the"),
    itemsHintLink: t("OpenCode config directory"),
    itemsHintSuffix: t(
      "; use an re: prefix to add a regex item",
    ),
    excludeTitle: t("Exclusions"),
    excludePlaceholder: t("Path or re: regex, e.g. logs/ or re:.*\\.tmp"),
    excludeAddBtn: t("Add"),
    excludeHint: t(
      "Excluded paths are skipped by every sync item. Adding one also deletes its files from the sync server.",
    ),
    hTime: t("Time"),
    hTrigger: t("Trigger"),
    hResult: t("Result"),
    hSummary: t("Summary"),
    histClear: t("Clear history"),
  };
}
