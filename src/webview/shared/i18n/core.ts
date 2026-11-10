/**
 * Runtime localization for the React webview.
 *
 * The host serves the `l10n/bundle.l10n.<locale>.json` bundle in response to a
 * `getL10nBundle` request. Previously every feature shipped its own dictionary
 * as an inline `<script>` in the HTML shell; that is gone, so a single bundle
 * round trip replaces nine injected globals.
 */

let strings: Record<string, string> = {};

/** Replace the dictionary. Called once during boot, before first render. */
export function setStrings(next: Record<string, string>): void {
  strings = next;
}

/** True when the dictionary carries an explicit translation for `key`. */
export function has(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(strings, key);
}

/**
 * Translate `key`, falling back to the key itself.
 *
 * `{0}`, `{1}`, ... placeholders are replaced positionally, matching the
 * `vscode.l10n` convention used by the host-side source strings.
 */
export function t(key: string, ...args: Array<string | number>): string {
  const template = strings[key] ?? key;
  if (args.length === 0) {
    return template;
  }
  return template.replace(/\{(\d+)\}/g, (match, index: string) => {
    const value = args[Number(index)];
    return value === undefined ? match : String(value);
  });
}
