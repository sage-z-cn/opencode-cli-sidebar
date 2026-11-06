import { l10n } from "../../i18n";
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
        <h1 class="eset-title" id="eset-title">${l10n.t("Extension Settings")}</h1>
        <div class="eset-sub" id="eset-sub">${l10n.t("Changes apply immediately.")}</div>
      </div>
      <div class="eset-header-actions">
        <div class="eset-scope" role="group" aria-label="${l10n.t("Apply settings to")}">
          <button type="button" class="eset-scope-btn is-on" data-eset-scope="user" aria-pressed="true">${l10n.t("User")}</button>
          <button type="button" class="eset-scope-btn" data-eset-scope="workspace" aria-pressed="false">${l10n.t("Workspace")}</button>
        </div>
        <button type="button" class="eset-icon-btn" id="eset-close" title="${l10n.t("Close")}" aria-label="${l10n.t("Close")}">${icon(ICONS.x)}</button>
      </div>
    </div>
    <div class="eset-note hidden" id="eset-scope-note">${l10n.t("No workspace folder is open, so settings can only be saved for the user.")}</div>
    <div class="eset-main">
      <nav class="eset-nav" id="eset-nav" aria-label="${l10n.t("Settings groups")}"></nav>
      <div class="eset-body" id="eset-body">
        <div class="eset-loading" id="eset-loading" role="status" aria-live="polite">
          <span class="eset-spinner" aria-hidden="true"></span>
          <span id="eset-loading-text">${l10n.t("Loading…")}</span>
        </div>
        <div class="eset-panes" id="eset-panes"></div>
      </div>
    </div>
    <div class="eset-footer">
      <span class="eset-status" id="eset-status" role="status" aria-live="polite"></span>
      <button type="button" class="eset-btn eset-btn--secondary" id="eset-open-settings" title="${l10n.t("Open the VS Code settings page for this extension")}">${l10n.t("Open VS Code settings")}</button>
    </div>
  </div>
</div>`;
}

/**
 * Runtime strings injected as `window.__EXT_SETTINGS_L10N__` for the
 * browser-side module. Keys are the English source text, so the module can
 * look a row label up directly.
 */
export const extensionSettingsL10nStrings: Record<string, string> = {
  // Groups
  "Terminal appearance": l10n.t("Terminal appearance"),
  "Interaction": l10n.t("Interaction"),
  "Startup and command line": l10n.t("Startup and command line"),
  "Context and diagnostics": l10n.t("Context and diagnostics"),
  "Logging and network": l10n.t("Logging and network"),
  "Updates": l10n.t("Updates"),
  "Config sync": l10n.t("Config sync"),
  // Group intros
  "Font and focus cues for the terminal.": l10n.t(
    "Font and focus cues for the terminal.",
  ),
  "How the sidebar sends files and where focus goes afterwards.": l10n.t(
    "How the sidebar sends files and where focus goes afterwards.",
  ),
  "When OpenCode starts, the command it runs, and the shell behind the terminal.":
    l10n.t(
      "When OpenCode starts, the command it runs, and the shell behind the terminal.",
    ),
  "Editor context and diagnostic details shared with OpenCode.": l10n.t(
    "Editor context and diagnostic details shared with OpenCode.",
  ),
  "Log detail and network timeouts.": l10n.t(
    "Log detail and network timeouts.",
  ),
  "How often the extension looks for OpenCode updates.": l10n.t(
    "How often the extension looks for OpenCode updates.",
  ),
  // Setting labels
  "Terminal font family": l10n.t("Terminal font family"),
  "Focus indicator": l10n.t("Focus indicator"),
  "Focus indicator width": l10n.t("Focus indicator width"),
  "Send keybindings to the terminal": l10n.t(
    "Send keybindings to the terminal",
  ),
  "Focus the sidebar after sending": l10n.t(
    "Focus the sidebar after sending",
  ),
  "How files are sent": l10n.t("How files are sent"),
  "Share editor context": l10n.t("Share editor context"),
  "Coordinate startup across windows": l10n.t(
    "Coordinate startup across windows",
  ),
  "Continue the last session": l10n.t("Continue the last session"),
  "OpenCode command": l10n.t("OpenCode command"),
  "Launch arguments": l10n.t("Launch arguments"),
  "Shell path": l10n.t("Shell path"),
  "Shell arguments": l10n.t("Shell arguments"),
  "Context update delay": l10n.t("Context update delay"),
  "Diagnostic message limit": l10n.t("Diagnostic message limit"),
  "Diagnostic levels": l10n.t("Diagnostic levels"),
  "Log level": l10n.t("Log level"),
  "Request timeout": l10n.t("Request timeout"),
  "Check for OpenCode updates": l10n.t("Check for OpenCode updates"),
  "Check interval": l10n.t("Check interval"),
  // Setting descriptions
  "Font used by the terminal. A Nerd Font is recommended for Powerline glyphs.":
    l10n.t(
      "Font used by the terminal. A Nerd Font is recommended for Powerline glyphs.",
    ),
  "Highlights the terminal border while the terminal has keyboard focus.":
    l10n.t("Highlights the terminal border while the terminal has keyboard focus."),
  "Border thickness in pixels. Used when the focus indicator is on.": l10n.t(
    "Border thickness in pixels. Used when the focus indicator is on.",
  ),
  "Give Ctrl or Cmd plus letter shortcuts to the terminal instead of VS Code. Control keys such as Ctrl+C always reach the terminal.":
    l10n.t(
      "Give Ctrl or Cmd plus letter shortcuts to the terminal instead of VS Code. Control keys such as Ctrl+C always reach the terminal.",
    ),
  "Return keyboard focus to the terminal after files or text are sent.":
    l10n.t("Return keyboard focus to the terminal after files or text are sent."),
  "Attach files to the composer, or type their paths into the prompt.":
    l10n.t("Attach files to the composer, or type their paths into the prompt."),
  "Share open files and selections with OpenCode. Takes effect the next time a session starts.":
    l10n.t(
      "Share open files and selections with OpenCode. Takes effect the next time a session starts.",
    ),
  "Keep several VS Code windows from starting the background service at the same time. Takes effect after the window reloads.":
    l10n.t(
      "Keep several VS Code windows from starting the background service at the same time. Takes effect after the window reloads.",
    ),
  "Resume the most recent session instead of starting a new one. Takes effect the next time a session starts.":
    l10n.t(
      "Resume the most recent session instead of starting a new one. Takes effect the next time a session starts.",
    ),
  "Command or path used to launch the OpenCode CLI. Takes effect the next time a session starts.":
    l10n.t(
      "Command or path used to launch the OpenCode CLI. Takes effect the next time a session starts.",
    ),
  "One argument per line. Arguments reach the launch command in order. Takes effect the next time a session starts.":
    l10n.t(
      "One argument per line. Arguments reach the launch command in order. Takes effect the next time a session starts.",
    ),
  "Shell used for the terminal. Leave empty to use the shell from VS Code. Takes effect the next time the terminal starts.":
    l10n.t(
      "Shell used for the terminal. Leave empty to use the shell from VS Code. Takes effect the next time the terminal starts.",
    ),
  "One argument per line. Leave empty to detect the arguments automatically. Takes effect the next time the terminal starts.":
    l10n.t(
      "One argument per line. Leave empty to detect the arguments automatically. Takes effect the next time the terminal starts.",
    ),
  "Wait time before an editor change is sent as new context, in milliseconds. Takes effect after the window reloads.":
    l10n.t(
      "Wait time before an editor change is sent as new context, in milliseconds. Takes effect after the window reloads.",
    ),
  "Longest diagnostic message included in code actions, in characters.":
    l10n.t("Longest diagnostic message included in code actions, in characters."),
  "Diagnostic levels that offer OpenCode code actions.": l10n.t(
    "Diagnostic levels that offer OpenCode code actions.",
  ),
  "Amount of detail written to the extension log.": l10n.t(
    "Amount of detail written to the extension log.",
  ),
  "Wait time for an OpenCode HTTP response, in milliseconds. Takes effect the next time a session starts.":
    l10n.t(
      "Wait time for an OpenCode HTTP response, in milliseconds. Takes effect the next time a session starts.",
    ),
  "Look for OpenCode updates in the background.": l10n.t(
    "Look for OpenCode updates in the background.",
  ),
  "Hours between automatic update checks. Takes effect after the window reloads.":
    l10n.t(
      "Hours between automatic update checks. Takes effect after the window reloads.",
    ),
  // Option labels
  "Off": l10n.t("Off"),
  "Bottom border": l10n.t("Bottom border"),
  "Full border": l10n.t("Full border"),
  "Attachment": l10n.t("Attachment"),
  "Path text": l10n.t("Path text"),
  "Debug": l10n.t("Debug"),
  "Info": l10n.t("Info"),
  "Warning": l10n.t("Warning"),
  "Error": l10n.t("Error"),
  "Errors": l10n.t("Errors"),
  "Warnings": l10n.t("Warnings"),
  "Information": l10n.t("Information"),
  "Hints": l10n.t("Hints"),
  // Row actions and layer hints
  "Loading…": l10n.t("Loading…"),
  "Workspace settings override this value.": l10n.t(
    "Workspace settings override this value.",
  ),
  "This value comes from your user settings.": l10n.t(
    "This value comes from your user settings.",
  ),
  "Switch to workspace": l10n.t("Switch to workspace"),
  "Reset": l10n.t("Reset"),
  "Reset to the default": l10n.t("Reset to the default"),
  "Saved": l10n.t("Saved"),
  "Could not save this setting. The stored value was kept.": l10n.t(
    "Could not save this setting. The stored value was kept.",
  ),
  // Config sync group
  "Sync your OpenCode configuration across machines. The sync panel has its own setup.":
    l10n.t(
      "Sync your OpenCode configuration across machines. The sync panel has its own setup.",
    ),
  "Open config sync": l10n.t("Open config sync"),
};
