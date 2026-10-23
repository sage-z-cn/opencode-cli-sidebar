import * as fs from "fs";
import * as path from "path";

/** Result of checking the node-pty spawn-helper executable bit. */
export interface SpawnHelperRepairResult {
  /** Helper that was found, if any. */
  helperPath?: string;
  /** True when the executable bit was missing and has been restored. */
  repaired: boolean;
}

export interface EnsureSpawnHelperOptions {
  /** Defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Defaults to process.arch. */
  arch?: string;
  /** Defaults to the node-pty locations relative to the extension bundle. */
  nodePtyRoots?: string[];
}

/**
 * node-pty's Unix builds exec `spawn-helper` directly. If the VSIX was
 * packaged on a platform/filesystem that dropped the executable bit,
 * pty.spawn fails with "posix_spawn failed: Permission denied" and the
 * sidebar terminal stays black because no process is ever created.
 *
 * Restore the bit before spawning. This is a no-op on Windows, when the
 * helper is already executable, or when no bundled node-pty is found.
 */
export function ensureNodePtySpawnHelperExecutable(
  options: EnsureSpawnHelperOptions = {},
): SpawnHelperRepairResult {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return { repaired: false };
  }

  const arch = options.arch ?? process.arch;
  const roots = options.nodePtyRoots ?? defaultNodePtyRoots();

  for (const root of roots) {
    // Mirror node-pty's loadNativeModule() resolution order so we repair the
    // helper that the loaded pty.node will actually exec.
    const helperPaths = [
      path.join(root, "build", "Release", "spawn-helper"),
      path.join(root, "build", "Debug", "spawn-helper"),
      path.join(root, "prebuilds", `${platform}-${arch}`, "spawn-helper"),
    ];

    for (const helperPath of helperPaths) {
      if (!fs.existsSync(helperPath)) {
        continue;
      }
      if (isExecutable(helperPath)) {
        return { helperPath, repaired: false };
      }
      try {
        fs.chmodSync(helperPath, 0o755);
        return { helperPath, repaired: true };
      } catch {
        // Read-only installs cannot be repaired here. Let pty.spawn surface
        // its original error instead of masking it with a different one.
        return { helperPath, repaired: false };
      }
    }
  }

  return { repaired: false };
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultNodePtyRoots(): string[] {
  if (typeof __dirname === "undefined") {
    return [];
  }
  return [
    // Bundled extension: dist/extension.js -> <extension>/node_modules/node-pty
    path.join(__dirname, "..", "node_modules", "node-pty"),
    // Source/tests: src/terminals/*.ts -> <repo>/node_modules/node-pty
    path.join(__dirname, "..", "..", "node_modules", "node-pty"),
  ];
}
