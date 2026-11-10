#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const bundle = JSON.parse(fs.readFileSync("l10n/bundle.l10n.zh-cn.json", "utf8"));
const bundleKeys = new Set(Object.keys(bundle));

function walk(dir) {
  let results = [];
  for (const f of fs.readdirSync(dir)) {
    const fp = path.join(dir, f);
    if (fs.statSync(fp).isDirectory()) results = results.concat(walk(fp));
    else if (f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))
      results.push(fp);
  }
  return results;
}

const files = walk("src").filter((f) => !f.includes("test") && !f.includes("__tests__"));

// Extract keys from l10n.t('...'), l10n.t("...") and l10n.t(`...`) calls.
// Double quotes dominate this codebase, so all three forms must be read;
// missing a form silently reports every one of its keys as "extra".
const codeKeys = new Set();
for (const f of files) {
  const c = fs.readFileSync(f, "utf8");
  // Single-quoted strings: l10n.t('...')
  for (const m of c.matchAll(/l10n\.t\(\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g)) {
    codeKeys.add(unescape(m[1]));
  }
  // Double-quoted strings: l10n.t("...")
  for (const m of c.matchAll(/l10n\.t\(\s*"([^"\\]*(?:\\.[^"\\]*)*)"/g)) {
    codeKeys.add(unescape(m[1]));
  }
  // Template literals: l10n.t(`...`)
  for (const m of c.matchAll(/l10n\.t\(\s*`([^`]+)`/g)) {
    const k = m[1].replace(/\$\{[^}]*\}/g, (match) => {
      // Convert template interpolation to l10n placeholder format
      const paramMatch = match.match(/\{\s*(\w+)\s*\}/);
      return paramMatch ? `{${paramMatch[1]}}` : match;
    });
    if (!k.includes("l10n.t")) codeKeys.add(unescape(k));
  }
}

/** Resolve the escape sequences that survive into bundle keys. */
function unescape(s) {
  return s.replace(/\\(.)/g, "$1");
}

const missing = [...codeKeys].filter((k) => !bundleKeys.has(k)).sort();
const extra = [...bundleKeys].filter((k) => !codeKeys.has(k)).sort();

console.log("=== MISSING keys (in code but not in bundle) ===");
missing.forEach((k) => console.log(JSON.stringify(k)));
console.log(`\nTotal missing: ${missing.length}`);

console.log("\n=== EXTRA keys (in bundle but not in code) ===");
extra.forEach((k) => console.log(JSON.stringify(k)));
console.log(`\nTotal extra: ${extra.length}`);
