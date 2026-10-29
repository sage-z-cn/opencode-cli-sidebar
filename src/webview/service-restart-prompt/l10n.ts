/**
 * Service-restart prompt strings.
 *
 * Evaluated on the extension host (same pattern as update/l10n.ts) and
 * injected into the webview document as `window.__SERVICE_RESTART_L10N__`
 * by terminal/html.ts. The webview module reads it with English fallbacks.
 *
 * NOTE: zh-CN translations for these keys live in
 * l10n/bundle.l10n.zh-cn.json (host packaging owns that file).
 */
import { l10n } from "../../i18n";

export const serviceRestartPromptL10nStrings: Record<string, string> = {
  title: l10n.t("Restart confirmation"),
  body: l10n.t(
    "The terminal is about to restart. Full Restart restarts both the OpenCode service and the current terminal; a session that is still running resumes automatically afterwards. Restart Terminal only reopens the terminal.",
  ),
  restartService: l10n.t("Full Restart"),
  terminalOnly: l10n.t("Restart Terminal"),
  cancel: l10n.t("Cancel"),
  close: l10n.t("Close"),
};
