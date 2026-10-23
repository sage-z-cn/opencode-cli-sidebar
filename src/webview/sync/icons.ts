/**
 * Lucide icons for the WebDAV sync UI.
 *
 * Sized for the compact sync panel and toolbar; the same set is reused by
 * the status line so every sync state maps to one icon.
 */
import { ICONS, icon } from "../shared/icons";

export const SYNC_ICONS = {
  /** Idle / configured marker for the status line; the toolbar button shows its plain entry glyph when idle. */
  cloudCheck: icon(ICONS.cloudCheck, 13),
  /** Syncing: cloud with sync arrows; blinks while a sync runs. */
  cloudSync: icon(ICONS.cloudSync, 13),
  /** Pending uploads: cloud upload arrow. */
  pending: icon(ICONS.cloudUpload, 13),
  /** Conflict: cloud with an alert mark. */
  conflict: icon(ICONS.cloudAlert, 13),
  /** Error / paused: severed cloud. */
  off: icon(ICONS.cloudOff, 13),
  /** Credentials missing or rejected: cloud configuration needed. */
  auth: icon(ICONS.cloudCog, 13),
  /** Sync-now action button icon. */
  refresh: icon(ICONS.refresh, 12),
  /** Busy spinner while a sync pass is already running. */
  spinner: icon(ICONS.loader, 12),
  /** Chevron for the collapsible trigger-source group. */
  chevron: icon(ICONS.chevronDown, 13, "dav-chev"),
  /** Row remove ("x") for sync item / exclusion rows. */
  close: icon(ICONS.x, 12),
  /** Header close button. */
  panelClose: icon(ICONS.x, 14),
  /** Clear-history action. */
  trash: icon(ICONS.trash, 13),
};
