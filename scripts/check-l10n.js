#!/usr/bin/env node
/**
 * Cross-checks l10n keys between code and the shipped bundles.
 *
 * Two consumers read `l10n/bundle.l10n.zh-cn.json`:
 *   - the extension host, through `vscode.l10n.t(...)`
 *   - the webview, through `shared/i18n/core.ts`
 *
 * Both must agree with the bundle, and each uses different call shapes. A key
 * that resolves to nothing degrades to English at runtime with no error, so a
 * mismatch here is otherwise invisible until someone reads a Chinese UI.
 *
 * Usage: node scripts/check-l10n.js
 */
const fs = require("fs");
const path = require("path");

const bundle = JSON.parse(fs.readFileSync("l10n/bundle.l10n.zh-cn.json", "utf8"));
const bundleKeys = new Set(Object.keys(bundle));

/** Resolve the escape sequences that survive into bundle keys. */
function unescape(s) {
  return s.replace(/\\(.)/g, "$1");
}

function walk(dir, matches) {
  let results = [];
  for (const f of fs.readdirSync(dir)) {
    const fp = path.join(dir, f);
    if (fs.statSync(fp).isDirectory()) results = results.concat(walk(fp, matches));
    else if (matches(f)) results.push(fp);
  }
  return results;
}

const isHostSource = (f) =>
  f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts");
const isWebviewSource = (f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f);

const hostFiles = walk("src", isHostSource).filter(
  (f) => !f.includes("test") && !f.includes("__tests__") && !f.includes("webview"),
);

/* ---------------- Extension host: vscode.l10n.t(...) ---------------- */

// Double quotes dominate this codebase, but all three string forms must be
// read: missing one silently reports every key in that form as "extra".
const hostKeys = new Set();
for (const f of hostFiles) {
  const c = fs.readFileSync(f, "utf8");
  for (const m of c.matchAll(/l10n\.t\(\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g)) {
    hostKeys.add(unescape(m[1]));
  }
  for (const m of c.matchAll(/l10n\.t\(\s*"([^"\\]*(?:\\.[^"\\]*)*)"/g)) {
    hostKeys.add(unescape(m[1]));
  }
  for (const m of c.matchAll(/l10n\.t\(\s*`([^`]+)`/g)) {
    const k = m[1].replace(/\$\{[^}]*\}/g, (match) => {
      const paramMatch = match.match(/\{\s*(\w+)\s*\}/);
      return paramMatch ? `{${paramMatch[1]}}` : match;
    });
    if (!k.includes("l10n.t")) hostKeys.add(unescape(k));
  }
}

/* ---------------- Webview: shared i18n helpers ---------------- */

/*
 * Shape 1: `t("English source text")` / `has("English source text")` — the
 *          string is the lookup key directly.
 * Shape 2: `t("shortId", "English source text")` — the bundle is keyed by
 *          English text, so the second argument is the lookup key and the
 *          short identifier only names the call site.
 *
 * The two shapes are scanned separately; scanning only the first argument of
 * shape 2 would report every identifier as missing and bury real mismatches.
 */
const TWO_ARG = /\b(?:t|translate)\(\s*"([^"\\]*(?:\\.[^"\\]*)*)"\s*,\s*(?:'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)")/g;
const ONE_ARG = /\b(?:t|translate|has)\(\s*"([^"\\]*(?:\\.[^"\\]*)*)"\s*[),]/g;

const webviewFiles = fs.existsSync("src/webview")
  ? walk("src/webview", isWebviewSource)
  : [];
const webviewKeys = new Set();
const webviewMissing = [];

for (const f of webviewFiles) {
  const source = fs.readFileSync(f, "utf8");

  for (const m of source.matchAll(TWO_ARG)) {
    // Call sites span lines and mix quote styles; group 2 or 3 holds the
    // fallback depending on which quote the author used.
    const fallback = unescape(m[2] ?? m[3] ?? "");
    webviewKeys.add(fallback);
    if (!bundleKeys.has(fallback)) {
      webviewMissing.push({ file: f, key: fallback, shape: "fallback" });
    }
  }

  // Blank out two-arg calls so their first argument is not double-reported.
  const stripped = source.replace(TWO_ARG, '""');
  for (const m of stripped.matchAll(ONE_ARG)) {
    const key = unescape(m[1]);
    webviewKeys.add(key);
    if (!bundleKeys.has(key)) {
      webviewMissing.push({ file: f, key, shape: "direct" });
    }
  }
}

/* ---------------- Report ---------------- */

const allCodeKeys = new Set([...hostKeys, ...webviewKeys]);
const missing = [...allCodeKeys].filter((k) => !bundleKeys.has(k)).sort();

console.log("=== MISSING keys (in code but not in bundle) ===");
for (const item of webviewMissing) {
  console.log(`${item.file.replace(/\\/g, "/")}: ${JSON.stringify(item.key)} (${item.shape})`);
}
console.log(`Total missing: ${webviewMissing.length}`);

if (missing.length > 0) {
  // `missing` covers both consumers; webviewMissing is a subset with file info.
  const hostOnly = missing.filter((k) => !webviewKeys.has(k));
  for (const k of hostOnly) {
    console.log(`host-side missing: ${JSON.stringify(k)}`);
  }
}

// EXTRA is informational: the bundle is shared with older releases and keeps
// keys ahead of the code that reads them. Listing them all drowns the build
// log, so only the count is reported unless --verbose is passed.
const extra = [...bundleKeys].filter((k) => !allCodeKeys.has(k)).sort();
console.log(`\nUnused bundle keys (informational): ${extra.length}`);
if (process.argv.includes("--verbose")) {
  extra.forEach((k) => console.log(JSON.stringify(k)));
}

if (missing.length > 0) {
  process.exitCode = 1;
}
