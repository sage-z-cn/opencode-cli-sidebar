import * as vscode from "vscode";
/**
 * Terminal geometry/config fields the webview reads from `#root`.
 *
 * Intentionally structural: the provider's `getTerminalConfig()` returns the
 * same fields plus message-envelope keys, so this accepts it without a cast.
 */
export interface WebviewTerminalConfig {
  fontSize: number;
  fontFamily: string;
  cursorBlink: boolean;
  cursorStyle: "block" | "underline" | "bar";
  scrollback: number;
  sendKeybindingsToShell?: boolean;
  focusIndicatorMode?: string;
  focusIndicatorBorderWidth?: number;
}

export interface WebviewHtmlParams {
  cspSource: string;
  nonce: string;
  cssUri: string;
  scriptUri: string;
  terminalConfig: WebviewTerminalConfig;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * HTML shell for the React webview.
 *
 * One `<script nonce>` plus one `<link>` — the nine inline l10n dictionaries
 * and the pre-rendered modal fragments are gone. Localization now arrives
 * through the `getL10nBundle` request before the first render, and every
 * modal is mounted by React on demand.
 *
 * `#root` carries the terminal `data-*` config: `readTerminalConfig` reads
 * them, and keeping them on the root means React can hand the same element
 * to xterm without a second source of truth.
 */
export function renderWebviewHtml({
  cspSource,
  nonce,
  cssUri,
  scriptUri,
  terminalConfig,
}: WebviewHtmlParams): string {
  const dataAttrs = [
    `data-font-size="${escapeHtml(String(terminalConfig.fontSize))}"`,
    `data-font-family="${escapeHtml(terminalConfig.fontFamily)}"`,
    `data-cursor-blink="${terminalConfig.cursorBlink}"`,
    `data-cursor-style="${escapeHtml(terminalConfig.cursorStyle)}"`,
    `data-scrollback="${terminalConfig.scrollback}"`,
    `data-send-keybindings-to-shell="${terminalConfig.sendKeybindingsToShell}"`,
    `data-focus-indicator-mode="${escapeHtml(terminalConfig.focusIndicatorMode ?? "bottomBorder")}"`,
    `data-focus-indicator-border-width="${terminalConfig.focusIndicatorBorderWidth ?? 2}"`,
  ].join(" ");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; img-src ${cspSource} data:; font-src ${cspSource}; script-src 'nonce-${nonce}'; connect-src ${cspSource};"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>OpenCode CLI Sidebar</title>
    <link rel="stylesheet" href="${cssUri}" />
    <style>
      /* Boot placeholder: a non-white frame before the bundle evaluates.
         React replaces #root's children on the first render, so no cleanup
         is needed. Fades in after 200ms so a fast boot never shows it. */
      .oc-boot {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        color: color-mix(in srgb, var(--vscode-foreground) 70%, transparent);
        opacity: 0;
        animation: oc-boot-fade-in 0.12s ease-out 0.2s forwards;
      }
      @keyframes oc-boot-fade-in {
        to {
          opacity: 1;
        }
      }
    </style>
  </head>
  <body>
    <div id="root" ${dataAttrs}>
      <div class="oc-boot">Loading...</div>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
}
