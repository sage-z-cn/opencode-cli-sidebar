import { l10n } from "../../i18n";
import { ICONS, icon } from "../shared/icons";

/** Markup for the OpenCode Keymap L1/L2 modals. */
export function renderKeymapModals(): string {
  return `
<div class="km-overlay hidden" id="km-overlay">
  <div class="km-modal" role="dialog" aria-modal="true" aria-label="${l10n.t("OpenCode Keymap")}">
    <div class="km-header">
      <div class="km-title-wrap">
        <h1 class="km-title">${l10n.t("OpenCode Keymap")}</h1>
        <div class="km-sub-row">
          <span class="km-sub">${l10n.t("View and edit OpenCode TUI key bindings")}</span>
          <span class="km-stats" id="km-stats"></span>
        </div>
      </div>
      <div class="km-header-actions">
        <button type="button" class="km-icon-btn" id="km-reload" title="${l10n.t("Reload")}" aria-label="${l10n.t("Reload")}">
          ${icon(ICONS.refresh)}
        </button>
        <button type="button" class="km-icon-btn" id="km-close" aria-label="${l10n.t("Close")}">${icon(ICONS.x)}</button>
      </div>
    </div>
    <div class="km-error hidden" id="km-error" role="alert"><span id="km-error-text"></span><button type="button" class="km-error-dismiss" id="km-error-dismiss" aria-label="${l10n.t("Close")}">${icon(ICONS.x, 12)}</button></div>
    <div class="km-main">
      <nav class="km-side-nav" id="km-side-nav" aria-label="${l10n.t("Shortcut categories")}"></nav>
      <div class="km-content">
        <div class="km-tools">
          <select id="km-filter" class="km-filter" aria-label="${l10n.t("Filter")}">
            <option value="all">${l10n.t("All")}</option>
            <option value="modified">${l10n.t("Modified")}</option>
            <option value="bound">${l10n.t("Bound")}</option>
            <option value="unbound">${l10n.t("Unbound")}</option>
          </select>
          <div class="km-search">
            <input type="search" id="km-search" placeholder="${l10n.t("Search commands, descriptions, or keys…")}" autocomplete="off" />
            <div class="km-search-actions">
              <button type="button" class="km-search-btn" id="km-search-record" title="${l10n.t("Record keys to search")}" aria-label="${l10n.t("Record keys to search")}" aria-pressed="false">
                ${icon(ICONS.keyboard)}
                <span class="capture-dot" aria-hidden="true"></span>
              </button>
              <button type="button" class="km-search-btn hidden" id="km-search-clear" title="${l10n.t("Clear search")}" aria-label="${l10n.t("Clear search")}">
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
  <div class="km-l2-modal" role="dialog" aria-modal="true" aria-label="${l10n.t("Edit shortcut")}">
    <div class="km-l2-header">
      <div>
        <div class="km-l2-title-line">
          <span class="km-l2-title">${l10n.t("Edit shortcut")}</span>
          <span class="km-l2-id" id="km-l2-id"></span>
        </div>
        <div class="km-l2-desc" id="km-l2-desc"></div>
      </div>
      <button type="button" class="km-icon-btn" id="km-l2-close" aria-label="${l10n.t("Close")}">${icon(ICONS.x)}</button>
    </div>
    <div class="km-l2-body">
      <div class="km-l2-label">${l10n.t("Binding list (multiple shortcuts allowed)")}</div>
      <div class="km-l2-leader" id="km-l2-leader"></div>
      <div class="km-l2-default" id="km-l2-default"></div>
      <div id="km-l2-chords"></div>
      <div class="km-l2-msg hidden" id="km-l2-msg" role="alert"></div>
    </div>
    <div class="km-l2-footer">
      <div class="km-l2-footer-left">
        <button type="button" class="km-btn" id="km-l2-disable">${l10n.t("Disable")}</button>
        <button type="button" class="km-btn" id="km-l2-reset">${l10n.t("Reset to default")}</button>
      </div>
      <div class="km-l2-footer-right">
        <button type="button" class="km-btn primary" id="km-l2-save">${l10n.t("Save")}</button>
      </div>
    </div>
  </div>
</div>
<div class="km-confirm-overlay hidden" id="km-confirm-overlay">
  <div class="km-confirm" role="alertdialog" aria-modal="true" aria-labelledby="km-confirm-title">
    <div class="km-confirm-title" id="km-confirm-title">${l10n.t("Reset shortcut")}</div>
    <div class="km-confirm-desc" id="km-confirm-desc">${l10n.t("Reset to default bindings? Custom configuration will be removed.")}</div>
    <div class="km-confirm-actions">
      <button type="button" class="km-btn" id="km-confirm-cancel">${l10n.t("Cancel")}</button>
      <button type="button" class="km-btn primary" id="km-confirm-ok">${l10n.t("Reset")}</button>
    </div>
  </div>
</div>`;
}

/**
 * Localized strings for the browser-side keymap module, injected by
 * terminal/html.ts as `window.__KEYMAP_L10N__` (same pattern as
 * toolbarL10nStrings / `window.__TOOLBAR_L10N__`). Values may contain
 * `{0}`-style positional placeholders resolved in keymap/index.ts.
 */
export const keymapL10nStrings: Record<string, string> = {
  groupGeneral: l10n.t("General"),
  groupSession: l10n.t("Session"),
  groupNav: l10n.t("Navigation / Messages"),
  groupModel: l10n.t("Models / Agents"),
  groupInput: l10n.t("Input / Prompts"),
  groupDialog: l10n.t("Dialogs"),
  groupDiff: l10n.t("Diff viewer"),
  groupWhichkey: l10n.t("Which-key"),
  unbound: l10n.t("Unbound"),
  recording: l10n.t("Recording"),
  recordKeysTitle: l10n.t("Record keys to search"),
  clearSearchTitle: l10n.t("Clear search"),
  searchRecordPlaceholder: l10n.t("Press keys to search…"),
  cancel: l10n.t("Cancel"),
  addBinding: l10n.t("+ Add binding"),
  clickToEdit: l10n.t("Click to edit"),
  clickToBind: l10n.t("Click to bind a shortcut"),
  edit: l10n.t("Edit"),
  delete: l10n.t("Delete"),
  reset: l10n.t("Reset"),
  defaultLabel: l10n.t("Default: {0}"),
  leaderLabel: l10n.t("Leader key: {0}"),
  leaderHint: l10n.t(
    "Press Leader first, then the next key when recording a sequence",
  ),
  noMatches: l10n.t("No matching shortcuts"),
  unsavedChanges: l10n.t(
    "You have unsaved changes. Closing will discard them.",
  ),
  keepEditing: l10n.t("Keep editing"),
  discardChanges: l10n.t("Discard changes"),
  duplicateChord: l10n.t("This command already has {0}"),
  conflictOverwrite: l10n.t(
    '{0} is already used by "{1}". Overwrite it?',
  ),
  overwrite: l10n.t("Overwrite"),
  resetConfirm: l10n.t(
    'Reset "{0}" to its default bindings? Your customization will be removed.',
  ),
  stats: l10n.t("Total {0} · Bound {1} · Modified {2} · Unbound {3}"),
  saveFailed: l10n.t(
    "Failed to save the shortcut. Your config file was not changed.",
  ),
  loadFailed: l10n.t("Failed to load keymap configuration."),
};
