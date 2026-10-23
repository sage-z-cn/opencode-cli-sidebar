import { afterEach, beforeEach, describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ensureNodePtySpawnHelperExecutable } from "./NodePtySpawnHelper";

const PLATFORM = "darwin" as NodeJS.Platform;
const ARCH = "arm64";

describe("ensureNodePtySpawnHelperExecutable", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "node-pty-helper-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeHelper(relativePath: string, mode: number): string {
    const helperPath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(helperPath), { recursive: true });
    fs.writeFileSync(helperPath, "#!/bin/sh\n");
    fs.chmodSync(helperPath, mode);
    return helperPath;
  }

  it.skipIf(process.platform === "win32")(
    "restores the executable bit when it is missing",
    () => {
      const helperPath = writeHelper(
        path.join("prebuilds", `${PLATFORM}-${ARCH}`, "spawn-helper"),
        0o644,
      );

      const result = ensureNodePtySpawnHelperExecutable({
        platform: PLATFORM,
        arch: ARCH,
        nodePtyRoots: [root],
      });

      expect(result).toEqual({ helperPath, repaired: true });
      expect(fs.statSync(helperPath).mode & 0o777).toBe(0o755);
    },
  );

  it.skipIf(process.platform === "win32")(
    "leaves an executable helper untouched",
    () => {
      const helperPath = writeHelper(
        path.join("prebuilds", `${PLATFORM}-${ARCH}`, "spawn-helper"),
        0o755,
      );

      const result = ensureNodePtySpawnHelperExecutable({
        platform: PLATFORM,
        arch: ARCH,
        nodePtyRoots: [root],
      });

      expect(result).toEqual({ helperPath, repaired: false });
      expect(fs.statSync(helperPath).mode & 0o777).toBe(0o755);
    },
  );

  it.skipIf(process.platform === "win32")("falls back to build/Release", () => {
    const helperPath = writeHelper(
      path.join("build", "Release", "spawn-helper"),
      0o644,
    );

    const result = ensureNodePtySpawnHelperExecutable({
      platform: PLATFORM,
      arch: ARCH,
      nodePtyRoots: [root],
    });

    expect(result).toEqual({ helperPath, repaired: true });
    expect(fs.statSync(helperPath).mode & 0o777).toBe(0o755);
  });

  it.skipIf(process.platform === "win32")(
    "prefers the helper node-pty actually loads",
    () => {
      writeHelper(
        path.join("prebuilds", `${PLATFORM}-${ARCH}`, "spawn-helper"),
        0o755,
      );
      const releaseHelper = writeHelper(
        path.join("build", "Release", "spawn-helper"),
        0o644,
      );

      const result = ensureNodePtySpawnHelperExecutable({
        platform: PLATFORM,
        arch: ARCH,
        nodePtyRoots: [root],
      });

      expect(result).toEqual({ helperPath: releaseHelper, repaired: true });
      expect(fs.statSync(releaseHelper).mode & 0o777).toBe(0o755);
    },
  );

  it("skips Windows", () => {
    const helperPath = writeHelper(
      path.join("prebuilds", "win32-x64", "spawn-helper"),
      0o644,
    );

    const result = ensureNodePtySpawnHelperExecutable({
      platform: "win32",
      arch: "x64",
      nodePtyRoots: [root],
    });

    expect(result).toEqual({ repaired: false });
    // Windows reports 0o666 for writable files; the POSIX mode assertion
    // only makes sense on Unix hosts.
    if (process.platform !== "win32") {
      expect(fs.statSync(helperPath).mode & 0o777).toBe(0o644);
    }
  });

  it("returns no repair when no helper exists", () => {
    const result = ensureNodePtySpawnHelperExecutable({
      platform: PLATFORM,
      arch: ARCH,
      nodePtyRoots: [root],
    });

    expect(result).toEqual({ repaired: false });
  });
});
