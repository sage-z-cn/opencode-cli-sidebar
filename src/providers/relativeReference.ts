import * as fs from "fs";
import * as vscode from "vscode";

/**
 * Converts an absolute path or file URI into a workspace-relative reference
 * with forward slashes. Directories keep a trailing "/" (e.g. `src/`) so
 * tool operators can emit directory-style mentions (`@src/`). Paths that
 * cannot be stat'ed are treated as plain files.
 */
export function toRelativeReference(target: vscode.Uri | string): string {
  const fsPath = typeof target === "string" ? target : target.fsPath;
  const relative = vscode.workspace
    .asRelativePath(fsPath, false)
    .replace(/\\/g, "/");
  try {
    if (fs.statSync(fsPath).isDirectory() && !relative.endsWith("/")) {
      return `${relative}/`;
    }
  } catch {
    // Missing or unstattable path — treat as a plain file.
  }
  return relative;
}

/**
 * Converts an absolute path or file URI into an absolute reference with
 * forward slashes and an uppercase Windows drive letter (e.g.
 * `D:/Workspace/foo/src`). Directories keep a trailing "/" (e.g.
 * `D:/Workspace/foo/src/`) so tool operators can emit directory-style
 * mentions. Paths that cannot be stat'ed are treated as plain files. Unlike
 * `toRelativeReference`, no workspace-relative conversion is performed.
 */
export function toAbsoluteReference(target: vscode.Uri | string): string {
  const fsPath = typeof target === "string" ? target : target.fsPath;
  const absolute = fsPath
    .replace(/^[a-z](?=:)/, (drive) => drive.toUpperCase())
    .replace(/\\/g, "/");
  try {
    if (fs.statSync(fsPath).isDirectory() && !absolute.endsWith("/")) {
      return `${absolute}/`;
    }
  } catch {
    // Missing or unstattable path — treat as a plain file.
  }
  return absolute;
}

/**
 * Path style used for `@path` text references.
 *
 * `absolute` makes the reference independent of OpenCode's current working
 * directory, so a session that was moved into a subproject still resolves it
 * correctly. `relative` keeps references short but assumes the session
 * directory is the workspace root.
 */
export type ReferencePathStyle = "absolute" | "relative";

/**
 * Formats `target` for a text reference using the configured style.
 * Directories keep a trailing "/" in both styles.
 */
export function toReferencePath(
  target: vscode.Uri | string,
  style: ReferencePathStyle,
): string {
  return style === "relative"
    ? toRelativeReference(target)
    : toAbsoluteReference(target);
}
