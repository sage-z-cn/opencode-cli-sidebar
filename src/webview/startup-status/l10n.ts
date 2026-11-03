/**
 * Host-side startup indicator strings.
 *
 * `startupL10nStrings` is evaluated on the extension host and injected into
 * the webview document as `window.__OC_STARTUP_L10N__` by terminal/html.ts,
 * the same pattern as the update and sync panels.
 *
 * NOTE: zh-CN translations for these keys live in l10n/bundle.l10n.zh-cn.json.
 */
import { l10n } from "../../i18n";

export const startupL10nStrings: Record<string, string> = {
  starting: l10n.t("Waiting for the OpenCode background service..."),
  aria: l10n.t("OpenCode is starting"),
};
