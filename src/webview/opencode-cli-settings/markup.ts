import { t } from "../shared/i18n/core";
import { ICONS, icon } from "../shared/icons";

/** Markup for the OpenCode CLI Settings modal. */
export function renderOpenCodeCliSettingsModal(): string {
  return `
<div class="occs-overlay hidden" id="occs-overlay">
  <div class="occs-modal" role="dialog" aria-modal="true" aria-label="${t("OpenCode CLI Settings")}">
    <div class="occs-header">
      <div class="occs-title-wrap">
        <h1 class="occs-title" id="occs-title">${t("OpenCode CLI Settings")}</h1>
        <div class="occs-sub-row">
          <button
            type="button"
            class="occs-sub-link"
            id="occs-open-cli-json"
            title="${t("Edit cli.json")}"
            aria-label="${t("Edit cli.json")}"
          >
            <span class="occs-sub">${t("TUI Settings")}</span>
            <span class="occs-path hidden" id="occs-path"></span>
          </button>
        </div>
      </div>
      <div class="occs-header-actions">
        <button type="button" class="occs-icon-btn" id="occs-reload" title="${t("Reload")}" aria-label="${t("Reload")}">
          ${icon(ICONS.refresh)}
        </button>
        <button type="button" class="occs-icon-btn" id="occs-close" aria-label="${t("Close")}">${icon(ICONS.x)}</button>
      </div>
    </div>
    <div class="occs-error hidden" id="occs-error" role="alert"><span id="occs-error-text"></span><button type="button" class="occs-icon-btn" id="occs-error-dismiss" aria-label="${t("Close")}">${icon(ICONS.x)}</button></div>
    <div class="occs-main">
      <nav class="occs-side-nav" id="occs-side-nav" aria-label="${t("Settings groups")}"></nav>
      <div class="occs-body">
        <div class="occs-loading" id="occs-loading" role="status" aria-live="polite">
          <span class="occs-spinner" aria-hidden="true"></span>
          <span id="occs-loading-text">${t("Loading…")}</span>
        </div>
        <div class="occs-list" id="occs-list"></div>
      </div>
    </div>
  </div>
</div>`;
}
