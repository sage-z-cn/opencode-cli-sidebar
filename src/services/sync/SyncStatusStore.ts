import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  WebDavConflictEntry,
  WebDavSyncErrorKind,
  WebDavSyncLastError,
  WebDavSyncTrigger,
} from "../../types";
import { syncStorageDir } from "./SyncManifest";

/**
 * Machine-shared UI status persisted at <globalStorage>/sync/status.json.
 * Every window writes its latest conflict list and sync state here and
 * adopts the file's contents when a sibling window changes it, so the
 * status shown in each window stays consistent.
 */

const STATUS_STATES = new Set(["idle", "syncing", "error", "needsAuth"]);
const CONFLICT_KINDS = new Set(["content", "localDeleted", "remoteDeleted"]);
const ERROR_KINDS = new Set<WebDavSyncErrorKind>(["unreachable", "failed"]);

export interface SyncStatusData {
  /** Change counter; written by whichever window saves. */
  revision: number;
  /** Unique per write. Two windows can save the same revision concurrently,
   *  so the token — not the revision — identifies the newest content. */
  writeId: string;
  /** Epoch ms of the write. */
  updatedAt: number;
  state: "idle" | "syncing" | "error" | "needsAuth";
  /** Why the state is "error"; absent otherwise. */
  errorKind?: WebDavSyncErrorKind;
  /** When the error state was entered; ages out a reachability claim. */
  errorAt?: number;
  /** Last failed pass on this machine; explains an inherited error state. */
  lastError?: WebDavSyncLastError;
  conflicts: WebDavConflictEntry[];
  lastSyncAt: number | null;
  pendingCount: number;
  autoSyncPaused: boolean;
}

function isConflictEntry(value: unknown): value is WebDavConflictEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.path === "string" &&
    typeof entry.kind === "string" &&
    CONFLICT_KINDS.has(entry.kind)
  );
}

/** Shape-check the shared last-error record; a malformed one reads as absent. */
function parseLastError(value: unknown): WebDavSyncLastError | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.message !== "string" ||
    typeof raw.at !== "number" ||
    typeof raw.trigger !== "string" ||
    typeof raw.kind !== "string" ||
    !ERROR_KINDS.has(raw.kind as WebDavSyncErrorKind)
  ) {
    return undefined;
  }
  return {
    message: raw.message,
    trigger: raw.trigger as WebDavSyncTrigger,
    at: raw.at,
    kind: raw.kind as WebDavSyncErrorKind,
  };
}

/** Shape-check raw parsed JSON; anything malformed reads back as absent. */
function parseStatusData(value: unknown): SyncStatusData | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const lastSyncAt = raw.lastSyncAt;
  const lastSyncAtValid =
    lastSyncAt === null || typeof lastSyncAt === "number";
  if (
    typeof raw.revision !== "number" ||
    typeof raw.writeId !== "string" ||
    raw.writeId.length === 0 ||
    typeof raw.updatedAt !== "number" ||
    typeof raw.state !== "string" ||
    !STATUS_STATES.has(raw.state) ||
    !Array.isArray(raw.conflicts) ||
    !lastSyncAtValid ||
    typeof raw.pendingCount !== "number" ||
    typeof raw.autoSyncPaused !== "boolean"
  ) {
    return undefined;
  }
  return {
    revision: raw.revision,
    writeId: raw.writeId,
    updatedAt: raw.updatedAt,
    state: raw.state as SyncStatusData["state"],
    ...(typeof raw.errorKind === "string" &&
    ERROR_KINDS.has(raw.errorKind as WebDavSyncErrorKind)
      ? { errorKind: raw.errorKind as WebDavSyncErrorKind }
      : {}),
    ...(typeof raw.errorAt === "number" ? { errorAt: raw.errorAt } : {}),
    ...(() => {
      const lastError = parseLastError(raw.lastError);
      return lastError ? { lastError } : {};
    })(),
    conflicts: raw.conflicts.filter(isConflictEntry),
    lastSyncAt,
    pendingCount: raw.pendingCount,
    autoSyncPaused: raw.autoSyncPaused,
  };
}

export class SyncStatusStore {
  public readonly filePath: string;

  public constructor(globalStoragePath: string) {
    this.filePath = path.join(syncStorageDir(globalStoragePath), "status.json");
  }

  /** Current shared status; undefined when missing, unreadable or invalid. */
  public async load(): Promise<SyncStatusData | undefined> {
    try {
      const raw = await fs.promises.readFile(this.filePath, "utf8");
      return parseStatusData(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }

  public async save(data: SyncStatusData): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    // Write-then-rename so a crash mid-write leaves the previous status
    // intact instead of a truncated file that reads back as invalid.
    const tempPath = `${this.filePath}.${process.pid}.${crypto
      .randomBytes(4)
      .toString("hex")}.tmp`;
    try {
      await fs.promises.writeFile(tempPath, JSON.stringify(data, null, 2), "utf8");
      await fs.promises.rename(tempPath, this.filePath);
    } catch (error) {
      await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
