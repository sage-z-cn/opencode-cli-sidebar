import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUILTIN_SYNC_ITEMS,
  PRE_START_SYNC_PATHS,
  SERVICE_OWNED_PRE_START_PATHS,
  classifyEntry,
  collectItemFiles,
  compileFullMatchRegex,
  deriveSyncItems,
  visibleSyncItems,
  isPathExcluded,
  isPathUnderItems,
  normalizeExcludes,
  validateCustomItemPath,
  validateExcludePath,
} from "./syncItems";

describe("syncItems", () => {
  let configDir: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-syncitems-"));
    previousConfigDir = process.env.OPENCODE_CONFIG_DIR;
    process.env.OPENCODE_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR;
    } else {
      process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
    }
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it("hides built-in items that do not exist locally", () => {
    fs.writeFileSync(path.join(configDir, "opencode.json"), "{}");
    fs.writeFileSync(path.join(configDir, "cli.json"), "{}");
    fs.writeFileSync(path.join(configDir, "AGENTS.md"), "#");
    const paths = visibleSyncItems([], [], configDir).map((item) => item.path);
    expect(paths).toContain("opencode.json");
    expect(paths).toContain("cli.json");
    expect(paths).toContain("AGENTS.md");
    expect(paths).not.toContain("skills");
    expect(paths).not.toContain("oh-my-opencode-slim.json");
    expect(paths).not.toContain("opencode.jsonc");
    expect(paths).not.toContain("oh-my-opencode-slim.jsonc");
  });

  it("shows opencode.jsonc when only that variant exists", () => {
    fs.writeFileSync(path.join(configDir, "opencode.jsonc"), "{}", "utf8");
    const paths = visibleSyncItems([], [], configDir).map((item) => item.path);
    expect(paths).toContain("opencode.jsonc");
    expect(paths).not.toContain("opencode.json");
  });

  it("shows oh-my-opencode-slim.jsonc when only that variant exists", () => {
    fs.writeFileSync(
      path.join(configDir, "oh-my-opencode-slim.jsonc"),
      "{}",
      "utf8",
    );
    const paths = visibleSyncItems([], [], configDir).map((item) => item.path);
    expect(paths).toContain("oh-my-opencode-slim.jsonc");
    expect(paths).not.toContain("oh-my-opencode-slim.json");
  });

  it("keeps the fixed built-in item order", () => {
    expect(BUILTIN_SYNC_ITEMS.map((item) => item.path)).toEqual([
      "opencode.json",
      "opencode.jsonc",
      "cli.json",
      "AGENTS.md",
      "skills",
      "oh-my-opencode-slim.json",
      "oh-my-opencode-slim.jsonc",
    ]);
    expect(BUILTIN_SYNC_ITEMS.every((item) => item.kind === "file" || item.kind === "dir")).toBe(true);
  });

  it("marks the launch-scoped built-ins", () => {
    // AGENTS.md and skills/ stay out of the launch pass on purpose: they are
    // large and the launch only needs what OpenCode reads while booting.
    expect(
      BUILTIN_SYNC_ITEMS.filter((item) => item.preStart).map((item) => item.path),
    ).toEqual([
      "opencode.json",
      "opencode.jsonc",
      "cli.json",
      "oh-my-opencode-slim.json",
      "oh-my-opencode-slim.jsonc",
    ]);
    expect(PRE_START_SYNC_PATHS).toEqual(
      BUILTIN_SYNC_ITEMS.filter((item) => item.preStart).map((item) => item.path),
    );
    // Only cli.json is read per TUI process without a watcher.
    expect(SERVICE_OWNED_PRE_START_PATHS).not.toContain("cli.json");
  });

  it("does not invent a cli.jsonc variant", () => {
    // OpenCode only reads cli.json; a jsonc entry would be a dead item.
    expect(BUILTIN_SYNC_ITEMS.map((item) => item.path)).not.toContain(
      "cli.jsonc",
    );
  });

  it("rejects absolute paths, escapes and credential-shaped paths", () => {
    expect(validateCustomItemPath("/etc/passwd")).toMatchObject({
      ok: false,
      reason: "absolute",
    });
    expect(validateCustomItemPath("C:\\secrets.txt")).toMatchObject({
      ok: false,
      reason: "absolute",
    });
    expect(validateCustomItemPath("../outside.txt")).toMatchObject({
      ok: false,
      reason: "escape",
    });
    expect(validateCustomItemPath("skills/../auth.json")).toMatchObject({
      ok: false,
      reason: "escape",
    });

    for (const blacklisted of [
      "auth.json",
      "backup/data.db",
      "credentials.json",
      "my.token",
      "secret-keys.md",
      "dir/SECRET.pem",
      "state.db",
      "service.json",
      "service-local.json",
    ]) {
      expect(validateCustomItemPath(blacklisted)).toMatchObject({
        ok: false,
        reason: "blacklisted",
      });
    }

    const ok = validateCustomItemPath("themes\\dark.json");
    expect(ok).toEqual({ ok: true, normalized: "themes/dark.json" });
    expect(validateCustomItemPath("   ")).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("derives enabled/disabled items from settings", () => {
    const items = deriveSyncItems(["themes", "auth.json", "/abs"], [
      "AGENTS.md",
      "themes",
    ]);
    expect(items.map((item) => item.id)).toEqual([
      "opencode.json",
      "opencode.jsonc",
      "cli.json",
      "AGENTS.md",
      "skills",
      "oh-my-opencode-slim.json",
      "oh-my-opencode-slim.jsonc",
      "themes",
    ]);
    const agents = items.find((item) => item.path === "AGENTS.md");
    const themes = items.find((item) => item.path === "themes");
    expect(agents?.enabled).toBe(false);
    expect(themes?.enabled).toBe(false);
    expect(items.find((item) => item.path === "cli.json")?.enabled).toBe(true);
    // Contract shape: no display-name field on item rows.
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual([
        "builtin",
        "enabled",
        "id",
        "kind",
        "path",
      ]);
    }
  });

  it("matches paths under dir items", () => {
    const items = deriveSyncItems([], []);
    expect(isPathUnderItems("skills/a.md", items)).toBe(true);
    expect(isPathUnderItems("cli.json", items)).toBe(true);
    expect(isPathUnderItems("other/a.md", items)).toBe(false);
  });

  it("expands enabled dir items into files and skips disabled ones", async () => {
    fs.mkdirSync(path.join(configDir, "skills", "sub"), { recursive: true });
    fs.writeFileSync(path.join(configDir, "skills", "top.md"), "top", "utf8");
    fs.writeFileSync(
      path.join(configDir, "skills", "sub", "deep.md"),
      "deep",
      "utf8",
    );
    fs.writeFileSync(path.join(configDir, "skills", "auth.json"), "{}", "utf8");
    fs.writeFileSync(path.join(configDir, "cli.json"), "{}", "utf8");
    fs.mkdirSync(path.join(configDir, "unused"), { recursive: true });
    fs.writeFileSync(path.join(configDir, "unused", "x.md"), "x", "utf8");

    const items = deriveSyncItems([], ["cli.json"]);
    const files = await collectItemFiles(items);
    expect(files).toEqual(["skills/sub/deep.md", "skills/top.md"]);
  });

  it("includes enabled file items that exist and custom dir items", async () => {
    fs.writeFileSync(path.join(configDir, "cli.json"), "{}", "utf8");
    fs.mkdirSync(path.join(configDir, "themes"), { recursive: true });
    fs.writeFileSync(path.join(configDir, "themes", "dark.json"), "{}", "utf8");
    fs.writeFileSync(path.join(configDir, "AGENTS.md"), "hi", "utf8");

    const items = deriveSyncItems(["themes"], ["AGENTS.md"]);
    const files = await collectItemFiles(items);
    expect(files).toEqual(["cli.json", "themes/dark.json"]);
  });

  it("collects existing jsonc built-in files without custom items", async () => {
    fs.writeFileSync(path.join(configDir, "opencode.jsonc"), "{}", "utf8");
    fs.writeFileSync(
      path.join(configDir, "oh-my-opencode-slim.jsonc"),
      "{}",
      "utf8",
    );
    const items = deriveSyncItems([], []);
    const files = await collectItemFiles(items, configDir);
    expect(files).toContain("opencode.jsonc");
    expect(files).toContain("oh-my-opencode-slim.jsonc");
    expect(files).not.toContain("opencode.json");
    expect(files).not.toContain("oh-my-opencode-slim.json");
  });

  it("validates exclude paths like item paths", () => {
    expect(validateExcludePath("../outside")).toEqual({
      kind: "invalid",
      reason: "escape",
    });
    expect(validateExcludePath("/abs/path")).toEqual({
      kind: "invalid",
      reason: "absolute",
    });
    expect(validateExcludePath("skills\\drafts/")).toEqual({
      kind: "path",
      value: "skills/drafts",
    });
  });

  it("normalizes exclude lists and drops invalid entries", () => {
    expect(
      normalizeExcludes([
        "skills/drafts",
        "skills\\drafts\\",
        "cli.json",
        "../escape",
        "",
      ]),
    ).toEqual(["skills/drafts", "cli.json"]);
  });

  it("matches excluded files, excluded directory prefixes and edge spelling", () => {
    const excludes = ["skills/drafts", "cli.json"];
    // Exact file hit.
    expect(isPathExcluded("cli.json", excludes)).toBe(true);
    // Files below an excluded directory.
    expect(isPathExcluded("skills/drafts/a.md", excludes)).toBe(true);
    expect(isPathExcluded("skills/drafts/sub/b.md", excludes)).toBe(true);
    // Outside the excluded set.
    expect(isPathExcluded("skills/top.md", excludes)).toBe(false);
    expect(isPathExcluded("AGENTS.md", excludes)).toBe(false);
    // Trailing slash and backslash spellings still match.
    expect(isPathExcluded("skills/drafts/", excludes)).toBe(true);
    expect(isPathExcluded("skills\\drafts\\x.md", excludes)).toBe(true);
    // Directory names only match as whole segments, never by prefix.
    expect(isPathExcluded("skills/drafts-extra/x.md", excludes)).toBe(false);
    // Windows path comparisons are case-insensitive.
    if (process.platform === "win32") {
      expect(isPathExcluded("Skills/Drafts/a.md", excludes)).toBe(true);
      expect(isPathExcluded("CLI.JSON", excludes)).toBe(true);
    }
  });

  it("filters excluded paths out of collected files", async () => {
    fs.mkdirSync(path.join(configDir, "skills", "drafts", "sub"), {
      recursive: true,
    });
    fs.writeFileSync(path.join(configDir, "skills", "top.md"), "top", "utf8");
    fs.writeFileSync(
      path.join(configDir, "skills", "drafts", "a.md"),
      "a",
      "utf8",
    );
    fs.writeFileSync(
      path.join(configDir, "skills", "drafts", "sub", "b.md"),
      "b",
      "utf8",
    );
    fs.writeFileSync(path.join(configDir, "cli.json"), "{}", "utf8");
    fs.writeFileSync(path.join(configDir, "AGENTS.md"), "hi", "utf8");

    const items = deriveSyncItems([], []);
    // Excluded directory prunes everything below it; exact file hit skips
    // the file item entirely.
    const files = await collectItemFiles(items, configDir, [
      "skills/drafts",
      "cli.json",
    ]);
    expect(files).toEqual(["AGENTS.md", "skills/top.md"]);
  });

  /* ===================== Regex entries ===================== */

  it("classifies re: entries and rejects invalid patterns", () => {
    expect(classifyEntry("re:notes/.*\\.md")).toEqual({
      kind: "regex",
      value: "notes/.*\\.md",
    });
    expect(classifyEntry("RE:notes")).toEqual({ kind: "regex", value: "notes" });
    expect(classifyEntry("skills\\drafts")).toEqual({
      kind: "path",
      value: "skills/drafts",
    });
    // Empty pattern and non-compiling pattern are distinct rejections.
    expect(classifyEntry("re:")).toEqual({
      kind: "invalid",
      reason: "emptyPattern",
    });
    expect(classifyEntry("re:   ")).toEqual({
      kind: "invalid",
      reason: "emptyPattern",
    });
    expect(classifyEntry("re:([unclosed")).toEqual({
      kind: "invalid",
      reason: "badRegex",
    });
    // Non-regex entries keep the literal validation reasons.
    expect(classifyEntry("../escape")).toEqual({
      kind: "invalid",
      reason: "escape",
    });
  });

  it("reuses compiled re: patterns across calls", () => {
    expect(compileFullMatchRegex("notes/.*\\.md")).toBe(
      compileFullMatchRegex("notes/.*\\.md"),
    );
    expect(compileFullMatchRegex("a")).not.toBe(compileFullMatchRegex("b"));
  });

  it("derives re: custom items as pattern rows kept verbatim", () => {
    const items = deriveSyncItems(["re:notes/.*\\.md", "themes"], []);
    const pattern = items.find((item) => item.kind === "pattern");
    expect(pattern).toEqual({
      id: "re:notes/.*\\.md",
      path: "re:notes/.*\\.md",
      kind: "pattern",
      enabled: true,
      builtin: false,
    });
    expect(items.find((item) => item.path === "themes")?.kind).toBe("dir");
  });

  it("expands pattern items across subdirectories with POSIX paths", async () => {
    fs.mkdirSync(path.join(configDir, "notes", "sub", "deep"), {
      recursive: true,
    });
    fs.writeFileSync(path.join(configDir, "notes", "a.md"), "a", "utf8");
    fs.writeFileSync(path.join(configDir, "notes", "sub", "b.md"), "b", "utf8");
    fs.writeFileSync(
      path.join(configDir, "notes", "sub", "deep", "c.md"),
      "c",
      "utf8",
    );
    fs.writeFileSync(path.join(configDir, "notes", "ignore.txt"), "x", "utf8");
    fs.mkdirSync(path.join(configDir, "other"), { recursive: true });
    fs.writeFileSync(path.join(configDir, "other", "d.md"), "d", "utf8");

    const items = deriveSyncItems(["re:notes/.*\\.md"], []);
    const files = await collectItemFiles(items, configDir);
    expect(files.sort()).toEqual([
      "notes/a.md",
      "notes/sub/b.md",
      "notes/sub/deep/c.md",
    ]);
  });

  it("matches pattern items through isPathUnderItems", () => {
    const items = deriveSyncItems(["re:notes/.*\\.md"], []);
    expect(isPathUnderItems("notes/a.md", items)).toBe(true);
    expect(isPathUnderItems("notes/sub/deep/b.md", items)).toBe(true);
    // Whole-line anchoring: similar-prefix paths stay out.
    expect(isPathUnderItems("notes/a.md.bak", items)).toBe(false);
    expect(isPathUnderItems("other/notes/a.md", items)).toBe(false);
  });

  it("excludes via whole-line regex without catching similar prefixes", () => {
    const excludes = ["re:.*\\.tmp", "re:cache/.*"];
    expect(isPathExcluded("a.tmp", excludes)).toBe(true);
    expect(isPathExcluded("cache/x.log", excludes)).toBe(true);
    // Anchored: partial-suffix and similar-name paths are not excluded.
    expect(isPathExcluded("a.tmpx", excludes)).toBe(false);
    expect(isPathExcluded("cache-old/x.log", excludes)).toBe(false);
    expect(isPathExcluded("notmp", excludes)).toBe(false);
  });

  it("never syncs deny-listed files even when a pattern hits them", async () => {
    fs.mkdirSync(path.join(configDir, "backup"), { recursive: true });
    fs.writeFileSync(path.join(configDir, "auth.json"), "{}", "utf8");
    fs.writeFileSync(path.join(configDir, "backup", "state.db"), "x", "utf8");
    fs.writeFileSync(path.join(configDir, "secret-keys.md"), "y", "utf8");
    fs.writeFileSync(path.join(configDir, "cli.json"), "{}", "utf8");

    // A greedy pattern that would match everything.
    const items = deriveSyncItems(["re:.*"], []);
    const files = await collectItemFiles(items, configDir);
    expect(files).toEqual(["cli.json"]);
  });

  it("mixes literal and re: entries in one scope", async () => {
    fs.mkdirSync(path.join(configDir, "themes"), { recursive: true });
    fs.mkdirSync(path.join(configDir, "notes"), { recursive: true });
    fs.writeFileSync(path.join(configDir, "themes", "dark.css"), "d", "utf8");
    fs.writeFileSync(path.join(configDir, "notes", "a.md"), "a", "utf8");
    fs.writeFileSync(path.join(configDir, "notes", "draft.md"), "x", "utf8");
    fs.writeFileSync(path.join(configDir, "cli.json"), "{}", "utf8");

    const items = deriveSyncItems(["themes", "re:notes/.*\\.md"], []);
    const files = await collectItemFiles(items, configDir, [
      "re:notes/draft\\.md",
    ]);
    expect(files).toEqual(["cli.json", "notes/a.md", "themes/dark.css"]);
  });

  it("keeps re: exclude entries verbatim in normalized lists", () => {
    expect(
      normalizeExcludes([
        "re:.*\\.tmp",
        " re:.*\\.tmp ",
        "skills/drafts",
        "skills\\drafts\\",
        "re:([bad",
        "../escape",
      ]),
    ).toEqual(["re:.*\\.tmp", "skills/drafts"]);
  });

  it("validates exclude entries through the regex-aware path", () => {
    expect(validateExcludePath("re:notes/.*\\.md")).toEqual({
      kind: "regex",
      value: "notes/.*\\.md",
    });
    expect(validateExcludePath("re:+")).toEqual({
      kind: "invalid",
      reason: "badRegex",
    });
    expect(validateExcludePath("/abs")).toEqual({
      kind: "invalid",
      reason: "absolute",
    });
  });
});
