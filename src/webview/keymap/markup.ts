import { t } from "../shared/i18n/core";
import { ICONS, icon } from "../shared/icons";

/** Markup for the OpenCode Keymap L1/L2 modals. */
export function renderKeymapModals(): string {
  return `
<div class="km-overlay hidden" id="km-overlay">
  <div class="km-modal" role="dialog" aria-modal="true" aria-label="${t("OpenCode Keymap")}">
    <div class="km-header">
      <div class="km-title-wrap">
        <h1 class="km-title">${t("OpenCode Keymap")}</h1>
        <div class="km-sub-row">
          <span class="km-sub">${t("View and edit OpenCode TUI key bindings")}</span>
          <span class="km-stats" id="km-stats"></span>
        </div>
      </div>
      <div class="km-header-actions">
        <button type="button" class="km-icon-btn" id="km-reload" title="${t("Reload")}" aria-label="${t("Reload")}">
          ${icon(ICONS.refresh)}
        </button>
        <button type="button" class="km-icon-btn" id="km-close" aria-label="${t("Close")}">${icon(ICONS.x)}</button>
      </div>
    </div>
    <div class="km-error hidden" id="km-error" role="alert"><span id="km-error-text"></span><button type="button" class="km-error-dismiss" id="km-error-dismiss" aria-label="${t("Close")}">${icon(ICONS.x, 12)}</button></div>
    <div class="km-main">
      <nav class="km-side-nav" id="km-side-nav" aria-label="${t("Shortcut categories")}"></nav>
      <div class="km-content">
        <div class="km-tools">
          <select id="km-filter" class="km-filter" aria-label="${t("Filter")}">
            <option value="all">${t("All")}</option>
            <option value="modified">${t("Modified")}</option>
            <option value="bound">${t("Bound")}</option>
            <option value="unbound">${t("Unbound")}</option>
          </select>
          <div class="km-search">
            <input type="search" id="km-search" placeholder="${t("Search commands, descriptions, or keys…")}" autocomplete="off" />
            <div class="km-search-actions">
              <button type="button" class="km-search-btn" id="km-search-record" title="${t("Record keys to search")}" aria-label="${t("Record keys to search")}" aria-pressed="false">
                ${icon(ICONS.keyboard)}
                <span class="capture-dot" aria-hidden="true"></span>
              </button>
              <button type="button" class="km-search-btn hidden" id="km-search-clear" title="${t("Clear search")}" aria-label="${t("Clear search")}">
                ${icon(ICONS.x)}
              </button>
            </div>
          </div>
        </div>
        <div class="km-list" id="km-list"></div>
      </div>
    </div>
  </div>
</div>
<div class="km-l2-overlay hidden" id="km-l2-overlay">
  <div class="km-l2-modal" role="dialog" aria-modal="true" aria-label="${t("Edit shortcut")}">
    <div class="km-l2-header">
      <div>
        <div class="km-l2-title-line">
          <span class="km-l2-title">${t("Edit shortcut")}</span>
          <span class="km-l2-id" id="km-l2-id"></span>
        </div>
        <div class="km-l2-desc" id="km-l2-desc"></div>
      </div>
      <button type="button" class="km-icon-btn" id="km-l2-close" aria-label="${t("Close")}">${icon(ICONS.x)}</button>
    </div>
    <div class="km-l2-body">
      <div class="km-l2-label">${t("Binding list (multiple shortcuts allowed)")}</div>
      <div class="km-l2-leader" id="km-l2-leader"></div>
      <div class="km-l2-default" id="km-l2-default"></div>
      <div id="km-l2-chords"></div>
      <div class="km-l2-msg hidden" id="km-l2-msg" role="alert"></div>
    </div>
    <div class="km-l2-footer">
      <div class="km-l2-footer-left">
        <button type="button" class="km-btn" id="km-l2-disable">${t("Disable")}</button>
        <button type="button" class="km-btn" id="km-l2-reset">${t("Reset to default")}</button>
      </div>
      <div class="km-l2-footer-right">
        <button type="button" class="km-btn primary" id="km-l2-save">${t("Save")}</button>
      </div>
    </div>
  </div>
</div>
<div class="km-confirm-overlay hidden" id="km-confirm-overlay">
  <div class="km-confirm" role="alertdialog" aria-modal="true" aria-labelledby="km-confirm-title">
    <div class="km-confirm-title" id="km-confirm-title">${t("Reset shortcut")}</div>
    <div class="km-confirm-desc" id="km-confirm-desc">${t("Reset to default bindings? Custom configuration will be removed.")}</div>
    <div class="km-confirm-actions">
      <button type="button" class="km-btn" id="km-confirm-cancel">${t("Cancel")}</button>
      <button type="button" class="km-btn primary" id="km-confirm-ok">${t("Reset")}</button>
    </div>
  </div>
</div>`;
}
