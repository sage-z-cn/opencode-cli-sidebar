import { t } from "../shared/i18n/core";
import { ICONS, icon } from "../shared/icons";

/**
 * Markup for the extension settings dialog, rendered once into the body.
 *
 * The dialog edits the extension's own VS Code settings with immediate
 * apply. Groups, rows and controls are filled in by the browser module
 * (`extension-settings/index.ts`) once the host pushes a snapshot; this
 * shell only carries the frame, the scope switch and the loading state.
 */
export function renderExtensionSettingsModal(): string {
  return `
<div class="eset-overlay hidden" id="eset-overlay">
  <div class="eset-modal" id="eset-modal" role="dialog" aria-modal="true" aria-labelledby="eset-title">
    <div class="eset-header">
      <div class="eset-title-wrap">
        <h1 class="eset-title" id="eset-title">${t("Extension Settings")}</h1>
        <div class="eset-sub" id="eset-sub">${t("Changes apply immediately.")}</div>
      </div>
      <div class="eset-header-actions">
        <div class="eset-scope" role="group" aria-label="${t("Apply settings to")}">
          <button type="button" class="eset-scope-btn is-on" data-eset-scope="user" aria-pressed="true">${t("User")}</button>
          <button type="button" class="eset-scope-btn" data-eset-scope="workspace" aria-pressed="false">${t("Workspace")}</button>
        </div>
        <button type="button" class="eset-icon-btn" id="eset-close" title="${t("Close")}" aria-label="${t("Close")}">${icon(ICONS.x)}</button>
      </div>
    </div>
    <div class="eset-note hidden" id="eset-scope-note">${t("No workspace folder is open, so settings can only be saved for the user.")}</div>
    <div class="eset-main">
      <nav class="eset-nav" id="eset-nav" aria-label="${t("Settings groups")}"></nav>
      <div class="eset-body" id="eset-body">
        <div class="eset-loading" id="eset-loading" role="status" aria-live="polite">
          <span class="eset-spinner" aria-hidden="true"></span>
          <span id="eset-loading-text">${t("Loading…")}</span>
        </div>
        <div class="eset-panes" id="eset-panes"></div>
      </div>
    </div>
    <div class="eset-footer">
      <span class="eset-status" id="eset-status" role="status" aria-live="polite"></span>
      <button type="button" class="eset-btn eset-btn--secondary" id="eset-open-settings" title="${t("Open the VS Code settings page for this extension")}">${t("Open VS Code settings")}</button>
    </div>
  </div>
</div>`;
}
