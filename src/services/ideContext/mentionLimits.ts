import * as fs from "fs";

/**
 * Per-attachment size ceiling enforced by the OpenCode server when it
 * materializes an `at_mentioned` file URI into a prompt attachment
 * (`MAX_ATTACHMENT_BYTES` in `packages/core/src/session/prompt.ts`).
 *
 * Files above this size make the TUI surface
 * `Attachment exceeds the 20971520 byte limit`, so the extension must keep
 * them off the mention channel and use typed `@path` text instead.
 */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * True when `fsPath` resolves to a non-directory entry whose byte size exceeds
 * the OpenCode attachment ceiling.
 *
 * Directories report their listing instead of their bytes and are always
 * allowed. Paths that cannot be stat'ed are treated as allowed so remote or
 * transient files keep the previous mention behaviour; the server remains the
 * final authority in that case.
 */
export function isAttachmentOversize(fsPath: string): boolean {
  try {
    const stat = fs.statSync(fsPath);
    return !stat.isDirectory() && stat.size > MAX_ATTACHMENT_BYTES;
  } catch {
    return false;
  }
}
