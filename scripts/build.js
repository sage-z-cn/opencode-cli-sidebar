#!/usr/bin/env node

/**
 * Build, package, publish and install the VSIX extension.
 * Output filename: {name}-{version}.vsix
 *
 * Flags:
 *   --install    install the packaged vsix into VS Code
 *   --publish    publish the packaged vsix to the Marketplace
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const flags = new Set(process.argv.slice(2));
const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

const { name, version } = pkg;
const vsixName = `${name}-${version}.vsix`;
const buildDir = path.join(root, "build");
const vsixPath = path.join(buildDir, vsixName);

fs.mkdirSync(buildDir, { recursive: true });

// Remove stale packages so build/ only keeps the latest vsix.
for (const file of fs.readdirSync(buildDir)) {
  if (file.endsWith(".vsix")) {
    fs.unlinkSync(path.join(buildDir, file));
    console.log(`Removed old package: ${file}`);
  }
}

console.log("Compiling ...");
execSync("npm run compile", { cwd: root, stdio: "inherit" });

// node-pty's Unix prebuilds exec `spawn-helper` directly. Re-apply the
// executable bit before vsce packages the extension so Unix-built VSIX
// files keep it. This is best-effort: fs.chmod cannot set Unix execute bits
// on Windows, and read-only node_modules may reject the change. The runtime
// repair in TerminalManager covers those cases after installation.
const nodePtyDir = path.join(root, "node_modules", "node-pty");
const helperFiles = [
  path.join(nodePtyDir, "build", "Release", "spawn-helper"),
  path.join(nodePtyDir, "build", "Debug", "spawn-helper"),
];
const ptyPrebuildsDir = path.join(nodePtyDir, "prebuilds");
if (fs.existsSync(ptyPrebuildsDir)) {
  for (const dir of fs.readdirSync(ptyPrebuildsDir)) {
    helperFiles.push(path.join(ptyPrebuildsDir, dir, "spawn-helper"));
  }
}
for (const helper of helperFiles) {
  if (!fs.existsSync(helper)) {
    continue;
  }
  try {
    fs.chmodSync(helper, 0o755);
    console.log(`Ensured executable bit: ${path.relative(root, helper)}`);
  } catch (error) {
    console.warn(
      `Could not set the executable bit on ${path.relative(root, helper)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

console.log(`\nPackaging ${vsixName} ...`);
execSync(`npx @vscode/vsce package -o "${vsixPath}"`, { cwd: root, stdio: "inherit" });

if (flags.has("--publish")) {
  console.log(`\nPublishing ${vsixName} to Marketplace ...`);
  // --packagePath uploads the freshly built vsix as-is:
  // no second packaging pass, vscode:prepublish does not re-run.
  execSync(`npx @vscode/vsce publish --packagePath "${vsixPath}"`, { cwd: root, stdio: "inherit" });
}

if (flags.has("--install")) {
  console.log(`\nInstalling ${vsixName} ...`);
  execSync(`code --install-extension "${vsixPath}" --force`, { cwd: root, stdio: "inherit" });
}

console.log(`\nDone: ${vsixPath}`);
