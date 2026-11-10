import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
// `./terminal.css` is loaded by the host HTML via a <link> pointing at
// dist/terminal.css (see providers/webviewHtml.ts); importing it here would
// inject a second copy through style-loader.

import { initI18n } from "./shared/i18n";
import { DialogHost } from "./shared/components/DialogHost";
import { TerminalApp } from "./terminal/TerminalApp";
import { getActiveTerminalHandle } from "./terminal/useTerminal";
import { installHostMessageHandlers } from "./messages/host-handlers";
import { initKeymapUi } from "./keymap";
import { initOpenCodeCliSettingsUi } from "./opencode-cli-settings";
import { initOpenCodeUpdateUi } from "./update";
import { initSyncUi } from "./sync";
import { initExtensionSettingsUi } from "./extension-settings";

/**
 * Elements the feature controllers look up by id at init time.
 *
 * Listed so a boot-order regression reports exactly what is missing instead of
 * throwing from somewhere deep inside a controller.
 */
const REQUIRED_IDS = [
  "toolbar",
  "btn-dav-sync-panel",
  "dav-sync-tip",
  "btn-restart",
  "btn-settings",
  "oc-dialog-host",
  "terminal-container",
] as const;

function findMissingElements(): string[] {
  return REQUIRED_IDS.filter((id) => !document.getElementById(id));
}

/**
 * Wait until `check()` passes, polling on animation frames.
 *
 * React commits asynchronously, so a single rAF is not a guarantee that the
 * toolbar markup and injected dialog shells are in the DOM.
 */
function waitFor(check: () => boolean, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const tick = (): void => {
      if (check()) {
        resolve(true);
        return;
      }
      if (performance.now() - startedAt > timeoutMs) {
        resolve(false);
        return;
      }
      requestAnimationFrame(tick);
    };
    tick();
  });
}

/**
 * Webview entry.
 *
 * Boot order is load-bearing:
 *  1. The host message listener attaches before any render, because the host
 *     starts the PTY as soon as `ready` arrives and pushes the first screen
 *     immediately.
 *  2. The i18n bundle resolves before the first render so the toolbar and
 *     dialogs paint in the user's language instead of flashing English.
 *  3. React mounts the terminal and the dialog shells.
 *  4. Feature controllers attach to those shells.
 */
function boot(): void {
  const root = document.getElementById("root");
  if (!root) {
    throw new Error("Root element not found");
  }

  // NOTE: deliberately not wrapped in StrictMode. StrictMode double-invokes
  // effects, which would mount xterm, post `ready` (starting the PTY on the
  // host), then dispose and remount it — losing the session's screen buffer.
  // The terminal owns an external resource, so it must mount exactly once.
  const reactRoot = createRoot(root);

  // The handler resolves the terminal per message, so attaching it while xterm
  // is still mounting is safe and loses no output.
  installHostMessageHandlers(getActiveTerminalHandle);

  // A rejection falls back to source strings, so a translation problem can
  // delay the terminal but never block it.
  void initI18n()
    .catch((error) => {
      console.warn("[webview] i18n init failed", error);
    })
    .finally(() => {
      reactRoot.render(
        <>
          <TerminalApp />
          <DialogHost />
        </>,
      );

      void waitFor(
        () =>
          Boolean(document.getElementById("toolbar")) &&
          Boolean(document.getElementById("oc-dialog-host")),
      ).then((ready) => {
        const missing = findMissingElements();
        if (!ready || missing.length > 0) {
          console.error(
            "[webview] boot incomplete; feature controllers may misbehave",
            { ready, missing },
          );
        }

        initKeymapUi();
        initOpenCodeCliSettingsUi();
        initOpenCodeUpdateUi();
        initSyncUi();
        initExtensionSettingsUi();
      });
    });
}

try {
  boot();
} catch (error) {
  console.error("[webview] failed to start", error);
}
