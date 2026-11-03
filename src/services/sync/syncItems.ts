import * as fs from "node:fs";
import * as path from "node:path";
import type { WebDavSyncItemUi } from "../../types";
import { resolveOpenCodeConfigDir } from "../openCodeConfigPath";

/**
 * Sync item catalog: built-in defaults with a fixed order plus validated
 * user-added custom paths, all relative to the OpenCode config directory.
 */

export interface SyncItemDefinition {
  id: string;
  /** Path relative to the OpenCode config dir, POSIX separators. */
  path: string;
  kind: "file" | "dir";
  builtin: boolean;
}

/** Built-in items in fixed display order. */
export const BUILTIN_SYNC_ITEMS: readonly SyncItemDefinition[] = [
  {
    id: "opencode.json",
    path: "opencode.json",
    kind: "file",
    builtin: true,
  },
  {
    id: "cli.json",
    path: "cli.json",
    kind: "file",
    builtin: true,
  },
  {
    id: "AGENTS.md",
    path: "AGENTS.md",
    kind: "file",
    builtin: true,
  },
  {
    id: "skills",
    path: "skills",
    kind: "dir",
    builtin: true,
  },
  {
    id: "oh-my-opencode-slim.json",
    path: "oh-my-opencode-slim.json",
    kind: "file",
    builtin: true,
  },
];

export type CustomItemRejection =
  | "empty"
  | "absolute"
  | "escape"
  | "blacklisted";

export type CustomItemValidation =
  | { ok: true; normalized: string }
  | { ok: false; reason: CustomItemRejection };

/**
 * Credential-shaped names that must never be synced. Matching is done on
 * every path segment, case-insensitively.
 */
const BLACKLIST_EXACT = new Set(["auth.json"]);
const BLACKLIST_SUFFIXES = [".db", ".token"];
const BLACKLIST_PREFIXES = ["credentials", "secret"];
/**
 * OpenCode's service configuration, including per-channel variants such as
 * `service-local.json`. It carries the background-service password and is
 * rewritten while the daemon runs, so syncing it would leak a credential and
 * race the writer.
 */
const SERVICE_CONFIG_NAME = /^service(?:-[a-z0-9._-]+)?\.json$/;

function isBlacklistedSegment(segment: string): boolean {
  const lowered = segment.toLowerCase();
  if (BLACKLIST_EXACT.has(lowered)) {
    return true;
  }
  if (SERVICE_CONFIG_NAME.test(lowered)) {
    return true;
  }
  if (BLACKLIST_SUFFIXES.some((suffix) => lowered.endsWith(suffix))) {
    return true;
  }
  if (BLACKLIST_PREFIXES.some((prefix) => lowered.startsWith(prefix))) {
    return true;
  }
  return false;
}

/**
 * Normalize and validate one custom item path. Accepts both "/" and "\"
 * separators; returns a POSIX-style relative path or a rejection reason.
 */
export function validateCustomItemPath(input: string): CustomItemValidation {
  const trimmed = (input ?? "").trim();
  if (!trimmed) {
    return { ok: false, reason: "empty" };
  }
  const unified = trimmed.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (unified.startsWith("/") || /^[a-zA-Z]:/.test(unified)) {
    return { ok: false, reason: "absolute" };
  }
  const segments = unified.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return { ok: false, reason: "escape" };
  }
  if (segments.some((segment) => isBlacklistedSegment(segment))) {
    return { ok: false, reason: "blacklisted" };
  }
  return { ok: true, normalized: segments.join("/") };
}

/** Whether any segment of an already-relative path looks credential-like. */
export function isPathBlacklisted(relPath: string): boolean {
  return relPath
    .split("/")
    .filter((segment) => segment.length > 0)
    .some((segment) => isBlacklistedSegment(segment));
}

/* ===================== Regex entries (`re:` prefix) ===================== */

/** Prefix marking a custom item / exclude entry as a regular expression. */
export const REGEX_ENTRY_PREFIX = "re:";

/** Rejection reasons shared by item and exclude entries. */
export type EntryRejection =
  | CustomItemRejection
  | "emptyPattern"
  | "badRegex";

export type EntryClassification =
  | { kind: "path"; value: string }
  | { kind: "regex"; value: string }
  | { kind: "invalid"; reason: EntryRejection };

/**
 * Classify one custom item / exclude entry. Entries starting with `re:`
 * are regular expressions matched against whole relative paths; the host
 * is the only parser. Everything else is a literal relative path.
 */
export function classifyEntry(input: string): EntryClassification {
  const trimmed = (input ?? "").trim();
  if (trimmed.toLowerCase().startsWith(REGEX_ENTRY_PREFIX)) {
    const pattern = trimmed.slice(REGEX_ENTRY_PREFIX.length).trim();
    if (!pattern) {
      return { kind: "invalid", reason: "emptyPattern" };
    }
    try {
      compileFullMatchRegex(pattern);
    } catch {
      return { kind: "invalid", reason: "badRegex" };
    }
    return { kind: "regex", value: pattern };
  }
  const validation = validateCustomItemPath(trimmed);
  if (!validation.ok) {
    return { kind: "invalid", reason: validation.reason };
  }
  return { kind: "path", value: validation.normalized };
}

/** Match-compiled patterns are reused across paths; bounded to stay small. */
const REGEX_CACHE_LIMIT = 100;
const regexCache = new Map<string, RegExp>();

/**
 * Compile one pattern for whole-line matching: relative paths use forward
 * slashes and the pattern is anchored on both ends.
 */
export function compileFullMatchRegex(pattern: string): RegExp {
  const cached = regexCache.get(pattern);
  if (cached) {
    return cached;
  }
  const compiled = new RegExp(`^(?:${pattern})$`);
  if (regexCache.size >= REGEX_CACHE_LIMIT) {
    const oldest = regexCache.keys().next().value;
    if (oldest !== undefined) {
      regexCache.delete(oldest);
    }
  }
  regexCache.set(pattern, compiled);
  return compiled;
}

/** Normalize one relative path to forward slashes for regex matching. */
function toPosixRelPath(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/** Path matching follows platform casing rules: case-insensitive on Windows. */
const CASE_INSENSITIVE_PATHS = process.platform === "win32";

/** Normalize one path for comparisons: POSIX separators, no trailing slash. */
function excludePathKey(relPath: string): string {
  const posix = relPath.replace(/\\/g, "/").replace(/\/+$/, "");
  return CASE_INSENSITIVE_PATHS ? posix.toLowerCase() : posix;
}

/**
 * Normalize the raw excluded-paths setting: literal entries become
 * POSIX-style deduplicated relative paths, `re:` entries are kept verbatim
 * (prefix included) and deduplicated by their exact text. Entries that
 * fail validation are dropped.
 */
export function normalizeExcludes(rawExcludes: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawExcludes) {
    const classification = classifyEntry(raw);
    if (classification.kind === "invalid") {
      continue;
    }
    if (classification.kind === "regex") {
      const stored = raw.trim();
      if (seen.has(stored)) {
        continue;
      }
      seen.add(stored);
      out.push(stored);
      continue;
    }
    const key = excludePathKey(classification.value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(classification.value);
  }
  return out;
}

/**
 * Validate one exclude entry: literal paths must be relative to the config
 * dir without `..` escapes; `re:` entries must compile.
 */
export function validateExcludePath(input: string): EntryClassification {
  return classifyEntry(input);
}

/**
 * True when `relPath` is itself excluded or lives below an excluded
 * directory (literal entries, trailing slashes and both separator styles
 * tolerated), or when any `re:` exclude whole-line matches the path.
 */
export function isPathExcluded(
  relPath: string,
  excludes: readonly string[],
): boolean {
  const target = excludePathKey(relPath);
  const posixRel = toPosixRelPath(relPath);
  for (const exclude of excludes) {
    const classification = classifyEntry(exclude);
    if (classification.kind === "invalid") {
      continue;
    }
    if (classification.kind === "regex") {
      try {
        if (compileFullMatchRegex(classification.value).test(posixRel)) {
          return true;
        }
      } catch {
        // Invalid patterns stored in settings never match.
      }
      continue;
    }
    const candidate = excludePathKey(classification.value);
    if (target === candidate || target.startsWith(candidate + "/")) {
      return true;
    }
  }
  return false;
}

/**
 * Derive the UI item list: built-ins first (fixed order), then validated
 * custom entries. Literal custom paths stay "dir" items; `re:` entries
 * become "pattern" items stored verbatim. `enabled` is derived from the
 * disabledItems setting keyed by item path.
 */
export function deriveSyncItems(
  customItems: readonly string[],
  disabledItems: readonly string[],
): WebDavSyncItemUi[] {
  const disabled = new Set(disabledItems);
  const items: WebDavSyncItemUi[] = BUILTIN_SYNC_ITEMS.map((item) => ({
    id: item.id,
    path: item.path,
    kind: item.kind,
    enabled: !disabled.has(item.path),
    builtin: item.builtin,
  }));
  const builtinPaths = new Set(BUILTIN_SYNC_ITEMS.map((item) => item.path));
  const seen = new Set(builtinPaths);
  for (const raw of customItems) {
    const classification = classifyEntry(raw);
    if (classification.kind === "invalid") {
      continue;
    }
    if (classification.kind === "regex") {
      const stored = raw.trim();
      if (seen.has(stored)) {
        continue;
      }
      seen.add(stored);
      items.push({
        id: stored,
        path: stored,
        kind: "pattern",
        enabled: !disabled.has(stored),
        builtin: false,
      });
      continue;
    }
    if (seen.has(classification.value)) {
      continue;
    }
    seen.add(classification.value);
    items.push({
      id: classification.value,
      path: classification.value,
      kind: "dir",
      enabled: !disabled.has(classification.value),
      builtin: false,
    });
  }
  return items;
}

/**
 * Snapshot item list: built-in entries stay hidden until they exist locally,
 * so optional files such as oh-my-opencode-slim.json only show up on machines
 * where that plugin is actually installed.
 */
export function visibleSyncItems(
  customItems: string[],
  disabledItems: string[],
  configDir: string = resolveOpenCodeConfigDir(),
): WebDavSyncItemUi[] {
  return deriveSyncItems(customItems, disabledItems).filter(
    (item) => !item.builtin || fs.existsSync(path.join(configDir, item.path)),
  );
}

/**
 * True when `relPath` is the item itself, lives below a dir item, or is
 * whole-line matched by a pattern item.
 */
export function isPathUnderItems(
  relPath: string,
  items: readonly WebDavSyncItemUi[],
): boolean {
  const posixRel = toPosixRelPath(relPath);
  for (const item of items) {
    if (item.kind === "pattern") {
      const classification = classifyEntry(item.path);
      if (classification.kind !== "regex") {
        continue;
      }
      try {
        if (compileFullMatchRegex(classification.value).test(posixRel)) {
          return true;
        }
      } catch {
        // Invalid patterns stored in settings never match.
      }
      continue;
    }
    if (item.path === relPath) {
      return true;
    }
    if (item.kind === "dir" && relPath.startsWith(item.path + "/")) {
      return true;
    }
  }
  return false;
}

/**
 * Expand enabled items into their file list: dir items recurse, file items
 * are included when they exist, and pattern items whole-line match every
 * file in the config directory. Excluded paths are filtered out and the
 * credential deny-list always wins over pattern matches. Returned paths
 * are POSIX-style relative paths.
 */
export async function collectItemFiles(
  items: readonly WebDavSyncItemUi[],
  configDir?: string,
  excludes: readonly string[] = [],
): Promise<string[]> {
  const root = configDir ?? resolveOpenCodeConfigDir();
  const files = new Set<string>();
  let allFilesCache: string[] | undefined;
  for (const item of items) {
    if (!item.enabled) {
      continue;
    }
    if (item.kind === "pattern") {
      const classification = classifyEntry(item.path);
      if (classification.kind !== "regex") {
        continue;
      }
      if (allFilesCache === undefined) {
        allFilesCache = await walkAllFiles(root);
      }
      for (const rel of allFilesCache) {
        // Deny-list first: credential-shaped files are never synced, no
        // matter how broad the pattern is.
        if (isPathBlacklisted(rel)) {
          continue;
        }
        if (isPathExcluded(rel, excludes)) {
          continue;
        }
        if (compileFullMatchRegex(classification.value).test(rel)) {
          files.add(rel);
        }
      }
      continue;
    }
    if (isPathBlacklisted(item.path)) {
      continue;
    }
    if (isPathExcluded(item.path, excludes)) {
      continue;
    }
    const abs = path.join(root, ...item.path.split("/"));
    let stat: fs.Stats | undefined;
    try {
      stat = await fs.promises.stat(abs);
    } catch {
      stat = undefined;
    }
    if (!stat) {
      continue;
    }
    if (stat.isFile()) {
      files.add(item.path);
    } else if (stat.isDirectory()) {
      await collectDirFiles(abs, item.path, files, excludes);
    }
  }
  return [...files].sort();
}

/** Walk the whole config directory and return every file as a POSIX rel path. */
async function walkAllFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  await walkDirInto(root, "", out);
  return out;
}

async function walkDirInto(
  absDir: string,
  relDir: string,
  out: string[],
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    const absEntry = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      await walkDirInto(absEntry, rel, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
}

async function collectDirFiles(
  absDir: string,
  relDir: string,
  out: Set<string>,
  excludes: readonly string[],
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const rel = `${relDir}/${entry.name}`;
    if (isPathBlacklisted(rel)) {
      continue;
    }
    if (isPathExcluded(rel, excludes)) {
      continue;
    }
    const absEntry = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      await collectDirFiles(absEntry, rel, out, excludes);
    } else if (entry.isFile()) {
      out.add(rel);
    }
  }
}
