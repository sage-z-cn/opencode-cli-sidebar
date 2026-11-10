/**
 * Verifies the shipped bundles parse as JavaScript.
 *
 * Webpack happily emits bundles that reference globals the webview lacks
 * (`process`, for example) or that contain syntax the target rejects. Those
 * failures only surface at runtime, inside a webview console the developer has
 * to open manually. A parse check catches the whole class here instead.
 *
 * Usage: node scripts/check-bundles.js
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const BUNDLES = ["dist/extension.js", "dist/webview.js"];

function check(file) {
  const absolute = path.resolve(__dirname, "..", file);
  if (!fs.existsSync(absolute)) {
    return { file, ok: false, reason: "missing; run `npm run compile` first" };
  }

  try {
    execFileSync(process.execPath, ["--check", absolute], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { file, ok: true };
  } catch (error) {
    const stderr = error.stderr ? error.stderr.toString() : String(error);
    return { file, ok: false, reason: stderr.trim().split("\n").slice(0, 4).join("\n") };
  }
}

/** Globals that exist in Node but not in a browser webview. */
const WEBVIEW_FORBIDDEN = [
  { pattern: /\bprocess\.env\b/, why: "process.env (add a DefinePlugin entry)" },
];

function findBrowserGlobals(file) {
  const absolute = path.resolve(__dirname, "..", file);
  if (!fs.existsSync(absolute)) {
    return [];
  }
  const source = fs.readFileSync(absolute, "utf8");
  return WEBVIEW_FORBIDDEN.filter(({ pattern }) => pattern.test(source)).map(
    ({ why }) => why,
  );
}

let failed = false;

for (const bundle of BUNDLES) {
  const result = check(bundle);
  if (!result.ok) {
    failed = true;
    console.error(`[check-bundles] ${result.file}: ${result.reason}`);
    continue;
  }
  console.log(`[check-bundles] ${result.file}: ok`);
}

const leaked = findBrowserGlobals("dist/webview.js");
if (leaked.length > 0) {
  failed = true;
  for (const why of leaked) {
    console.error(`[check-bundles] dist/webview.js references ${why}`);
  }
}

if (failed) {
  process.exit(1);
}
