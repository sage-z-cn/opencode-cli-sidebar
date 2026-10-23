import {
  renderTerminalContainer,
  type TerminalContainerParams,
} from "./terminal-container";
import { renderToolbar, toolbarL10nStrings } from "./toolbar";
import { keymapL10nStrings, renderKeymapModals } from "../keymap/markup";
import {
  openCodeCliSettingsL10nStrings,
  renderOpenCodeCliSettingsModal,
} from "../opencode-cli-settings/markup";
import { openCodeUpdateL10nStrings } from "../update/l10n";
import { serviceRestartPromptL10nStrings } from "../service-restart-prompt/l10n";
import { syncL10nStrings } from "../sync/l10n";
import { renderSyncUi } from "../sync/markup";

export interface TerminalHtmlParams extends TerminalContainerParams {
  cspSource: string;
  nonce: string;
  cssUri: string;
  scriptUri: string;
}

export function renderTerminalHtml({
  cspSource,
  nonce,
  cssUri,
  scriptUri,
  fontSize,
  fontFamily,
  cursorBlink,
  cursorStyle,
  scrollback,
  sendKeybindingsToShell,
  focusIndicatorMode,
  focusIndicatorBorderWidth,
}: TerminalHtmlParams): string {
  const toolbarL10nScript = `<script nonce="${nonce}">window.__TOOLBAR_L10N__=${JSON.stringify(toolbarL10nStrings)};</script>`;
  const keymapL10nScript = `<script nonce="${nonce}">window.__KEYMAP_L10N__=${JSON.stringify(keymapL10nStrings)};</script>`;
  const ocCliSettingsL10nScript = `<script nonce="${nonce}">window.__OC_CLI_SETTINGS_L10N__=${JSON.stringify(openCodeCliSettingsL10nStrings)};</script>`;
  const ocUpdateL10nScript = `<script nonce="${nonce}">window.__OC_UPDATE_L10N__=${JSON.stringify(openCodeUpdateL10nStrings)};</script>`;
  const serviceRestartPromptL10nScript = `<script nonce="${nonce}">window.__SERVICE_RESTART_L10N__=${JSON.stringify(serviceRestartPromptL10nStrings)};</script>`;
  const syncL10nScript = `<script nonce="${nonce}">window.__OC_SYNC_L10N__=${JSON.stringify(syncL10nStrings)};</script>`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <!-- Icons: Lucide (https://lucide.dev), ISC License -->
    <title>OpenCode CLI Sidebar</title>
    <link rel="stylesheet" href="${cssUri}" />
    ${toolbarL10nScript}
    ${keymapL10nScript}
    ${ocCliSettingsL10nScript}
    ${ocUpdateL10nScript}
    ${serviceRestartPromptL10nScript}
    ${syncL10nScript}
  </head>
  <body>
    ${renderToolbar()}
    ${renderTerminalContainer({
      fontSize,
      fontFamily,
      cursorBlink,
      cursorStyle,
      scrollback,
      sendKeybindingsToShell,
      focusIndicatorMode,
      focusIndicatorBorderWidth,
    })}
    ${renderKeymapModals()}
    ${renderOpenCodeCliSettingsModal()}
    ${renderSyncUi()}
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
}
