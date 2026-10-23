import { l10n } from "../../i18n";
import { ICONS, icon } from "../shared/icons";

/** Markup for the OpenCode CLI Settings modal. */
export function renderOpenCodeCliSettingsModal(): string {
  return `
<div class="occs-overlay hidden" id="occs-overlay">
  <div class="occs-modal" role="dialog" aria-modal="true" aria-label="${l10n.t("OpenCode CLI Settings")}">
    <div class="occs-header">
      <div class="occs-title-wrap">
        <h1 class="occs-title" id="occs-title">${l10n.t("OpenCode CLI Settings")}</h1>
        <div class="occs-sub-row">
          <button
            type="button"
            class="occs-sub-link"
            id="occs-open-cli-json"
            title="${l10n.t("Edit cli.json")}"
            aria-label="${l10n.t("Edit cli.json")}"
          >
            <span class="occs-sub">${l10n.t("TUI Settings")}</span>
            <span class="occs-path hidden" id="occs-path"></span>
          </button>
        </div>
      </div>
      <div class="occs-header-actions">
        <button type="button" class="occs-icon-btn" id="occs-reload" title="${l10n.t("Reload")}" aria-label="${l10n.t("Reload")}">
          ${icon(ICONS.refresh)}
        </button>
        <button type="button" class="occs-icon-btn" id="occs-close" aria-label="${l10n.t("Close")}">${icon(ICONS.x)}</button>
      </div>
    </div>
    <div class="occs-error hidden" id="occs-error" role="alert"><span id="occs-error-text"></span><button type="button" class="occs-icon-btn" id="occs-error-dismiss" aria-label="${l10n.t("Close")}">${icon(ICONS.x)}</button></div>
    <div class="occs-main">
      <nav class="occs-side-nav" id="occs-side-nav" aria-label="${l10n.t("Settings groups")}"></nav>
      <div class="occs-body">
        <div class="occs-loading" id="occs-loading" role="status" aria-live="polite">
          <span class="occs-spinner" aria-hidden="true"></span>
          <span id="occs-loading-text">${l10n.t("Loading…")}</span>
        </div>
        <div class="occs-list" id="occs-list"></div>
      </div>
    </div>
  </div>
</div>`;
}

/** Localized strings for browser-side settings module. */
export const openCodeCliSettingsL10nStrings: Record<string, string> = {
  openKeymap: l10n.t("Open keybindings"),
  editCliJson: l10n.t("Edit cli.json"),
  defaultLabel: l10n.t("Default: {0}"),
  saveFailed: l10n.t("Failed to save. Your config file was not changed."),
  loadFailed: l10n.t("Failed to load OpenCode CLI settings."),
  loading: l10n.t("Loading…"),
  addPlugin: l10n.t("Add plugin"),
  removePlugin: l10n.t("Remove plugin"),
  checkUpdates: l10n.t("Check updates"),
  checkingUpdates: l10n.t("Checking…"),
  cancel: l10n.t("Cancel"),
  noPlugins: l10n.t("No plugins configured"),
  pluginPackagePlaceholder: l10n.t(
    "npm package name, e.g. @scope/plugin",
  ),
  updateAvailable: l10n.t("Update available"),
  upToDate: l10n.t("Up to date"),
  checkFailed: l10n.t("Check failed"),
  updateCheckFailed: l10n.t("Failed to check plugin updates."),
  latestLabel: l10n.t("latest: {0}"),
  updateVersion: l10n.t("Update"),
  updateAll: l10n.t("Update all"),
  restartToTakeEffect: l10n.t("Restart OpenCode to take effect"),
};
