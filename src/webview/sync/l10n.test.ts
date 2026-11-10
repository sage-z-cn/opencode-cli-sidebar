// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The sync webview strings resolve through `window.__OC_SYNC_L10N__`, which
 * the host fills from `sync/l10n.ts`. Those host keys are English source
 * strings, so `l10n/bundle.l10n.zh-cn.json` must translate every one of
 * them. A missing entry falls back to English, which is how the conflict
 * "Applying…" busy label shipped untranslated.
 *
 * The host module imports `vscode`, so the keys are read from its source
 * text instead of importing it: the check is about key coverage, not runtime.
 */
const projectRoot = process.cwd();
const l10nSource = readFileSync(
  resolve(projectRoot, "src/webview/sync/l10n.ts"),
  "utf8",
);
const bundle: Record<string, string> = JSON.parse(
  readFileSync(resolve(projectRoot, "l10n/bundle.l10n.zh-cn.json"), "utf8"),
);

/** Every English key the sync UI asks the host to translate. */
function syncL10nKeys(): string[] {
  const keys: string[] = [];
  for (const match of l10nSource.matchAll(/l10n\.t\(\s*"([^"\\]*(?:\\.[^"\\]*)*)"/g)) {
    keys.push(match[1].replace(/\\(.)/g, "$1"));
  }
  return keys;
}

describe("sync l10n bundle coverage", () => {
  it("collects the sync UI keys from the host strings module", () => {
    const keys = syncL10nKeys();
    expect(keys.length).toBeGreaterThan(10);
    expect(keys).toContain("Applying…");
  });

  it("translates every sync UI string the host injects", () => {
    const untranslated = syncL10nKeys().filter(
      (english) => bundle[english] === undefined,
    );
    expect(untranslated).toEqual([]);
  });

  it("translates the conflict resolution busy label", () => {
    expect(bundle["Applying…"]).toBe("正在应用…");
  });
});
