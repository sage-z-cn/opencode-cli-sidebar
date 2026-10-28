import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenCodeCliSettingsService } from "./OpenCodeCliSettingsService";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe("OpenCodeCliSettingsService", () => {
  let dir: string;
  let configPath: string;
  let cacheRoot: string;
  let service: OpenCodeCliSettingsService;
  let prevConfigDir: string | undefined;
  let prevCacheHome: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-settings-"));
    configPath = path.join(dir, "cli.json");
    // Keep the plugin cache lookup inside the temp dir instead of the real one.
    cacheRoot = path.join(dir, "cache", "opencode", "npm");
    prevConfigDir = process.env.OPENCODE_CONFIG_DIR;
    prevCacheHome = process.env.XDG_CACHE_HOME;
    process.env.OPENCODE_CONFIG_DIR = dir;
    process.env.XDG_CACHE_HOME = path.join(dir, "cache");
    service = new OpenCodeCliSettingsService(logger);
  });

  afterEach(() => {
    if (prevConfigDir === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR;
    } else {
      process.env.OPENCODE_CONFIG_DIR = prevConfigDir;
    }
    if (prevCacheHome === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = prevCacheHome;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Lay out one cached plugin generation the way OpenCode installs it. */
  function writeCachedPlugin(
    cacheKey: string,
    generation: string,
    name: string,
    version: string,
  ): void {
    const pluginDir = path.join(cacheRoot, cacheKey, generation, "node_modules", name);
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({ name, version }),
      "utf8",
    );
  }

  it("returns defaults when file is missing", async () => {
    const payload = await service.load();
    expect(payload.configPath).toBe(configPath);
    expect(payload.values["session.thinking"]).toBe("show");
    expect(payload.overrides["session.thinking"]).toBeUndefined();
    expect(payload.themeOptions.some((t) => t.value === "nord")).toBe(true);
    expect(payload.plugins).toEqual([]);
  });

  it("loads nested overrides and flags them", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        theme: { name: "nord", mode: "dark" },
        session: { thinking: "hide" },
        animations: false,
      }),
      "utf8",
    );
    const payload = await service.load();
    expect(payload.values["theme.name"]).toBe("nord");
    expect(payload.values["theme.mode"]).toBe("dark");
    expect(payload.values["session.thinking"]).toBe("hide");
    expect(payload.values.animations).toBe(false);
    expect(payload.overrides["theme.name"]).toBe(true);
    expect(payload.overrides["session.thinking"]).toBe(true);
    expect(payload.overrides.animations).toBe(true);
    expect(payload.overrides["cursor.style"]).toBeUndefined();
  });

  it("excludes readonly entries from values and overrides", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        attention: { sounds: { "agent-done": "/tmp/a.wav" } },
        experimental: { jsroutes: true },
      }),
      "utf8",
    );
    const payload = await service.load();
    expect(payload.values["attention.sounds"]).toBeUndefined();
    expect(payload.values.experimental).toBeUndefined();
    expect(payload.overrides["attention.sounds"]).toBeUndefined();
    expect(payload.overrides.experimental).toBeUndefined();
  });

  it("rejects save and reset for readonly entries without changing the file", async () => {
    const original = JSON.stringify({
      attention: { sounds: { "agent-done": "/tmp/a.wav" } },
      animations: true,
    });
    fs.writeFileSync(configPath, original, "utf8");
    await expect(
      service.save("attention.sounds", { "agent-done": "/tmp/b.wav" }),
    ).rejects.toThrow(/Readonly/);
    await expect(service.reset("attention.sounds")).rejects.toThrow(
      /Readonly/,
    );
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
  });

  it("includes the current unknown theme in options", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ theme: { name: "my-odd-theme" } }),
      "utf8",
    );
    const payload = await service.load();
    expect(payload.themeOptions.some((t) => t.value === "my-odd-theme")).toBe(
      true,
    );
  });

  it("discovers custom themes from the themes directory", async () => {
    const themesDir = path.join(dir, "themes");
    fs.mkdirSync(themesDir, { recursive: true });
    fs.writeFileSync(path.join(themesDir, "my-theme.json"), "{}", "utf8");
    const payload = await service.load();
    expect(payload.themeOptions.some((t) => t.value === "my-theme")).toBe(true);
  });

  it("preserves unrelated keys when saving", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        $schema: "https://opencode.ai/v2/cli.json",
        keybinds: { "session.new": "alt+n" },
        theme: { name: "nord" },
      }),
      "utf8",
    );
    await service.save("session.thinking", "hide");
    const doc = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(doc.$schema).toBe("https://opencode.ai/v2/cli.json");
    expect((doc.keybinds as Record<string, string>)["session.new"]).toBe(
      "alt+n",
    );
    expect((doc.theme as { name: string }).name).toBe("nord");
    expect((doc.session as { thinking: string }).thinking).toBe("hide");
  });

  it("aborts save on unreadable JSON without wiping the file", async () => {
    const original = "{not json";
    fs.writeFileSync(configPath, original, "utf8");
    await expect(service.save("session.thinking", "hide")).rejects.toThrow(
      /not valid JSON/,
    );
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
  });

  it("rejects load when cli.json is not valid JSON and names the file", async () => {
    const original = '{"plugins": ["foo"]';
    fs.writeFileSync(configPath, original, "utf8");
    const error: unknown = await service.load().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(configPath);
    expect(message).toContain("Fix the JSON syntax");
    // The parser detail stays in the log and never reaches the user text.
    expect(message).not.toMatch(/Unexpected|end of JSON input/i);
    expect(logger.error).toHaveBeenCalled();
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
  });

  it("rejects load when the top-level JSON value is not an object", async () => {
    fs.writeFileSync(configPath, JSON.stringify(["plugins"]), "utf8");
    const error: unknown = await service.load().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(configPath);
    expect((error as Error).message).toContain("JSON object");
  });

  it("rejects every write on a broken config without touching the file", async () => {
    fs.writeFileSync(configPath, '{"plugins": ["foo@1.0.0"]', "utf8");
    const originalBytes = fs.readFileSync(configPath);
    await expect(service.addPlugin("bar")).rejects.toThrow(/not valid JSON/);
    await expect(service.removePlugin(0)).rejects.toThrow(/not valid JSON/);
    await expect(service.updatePluginVersion(0, "2.0.0")).rejects.toThrow(
      /plugin version because the OpenCode CLI config file cannot be read/,
    );
    await expect(service.setPluginOptions(0, { a: 1 })).rejects.toThrow(
      /not valid JSON/,
    );
    await expect(service.save("session.thinking", "hide")).rejects.toThrow(
      /not valid JSON/,
    );
    await expect(service.reset("session.thinking")).rejects.toThrow(
      /not valid JSON/,
    );
    expect(fs.readFileSync(configPath).equals(originalBytes)).toBe(true);
  });

  it("checkPluginUpdates rejects on a broken config instead of reporting none", async () => {
    fs.writeFileSync(configPath, "{not json", "utf8");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    try {
      const error: unknown = await service
        .checkPluginUpdates()
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(configPath);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("reset removes nested keys and prunes empty parents", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ theme: { name: "nord" }, animations: true }),
      "utf8",
    );
    await service.reset("theme.name");
    const doc = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(doc.theme).toBeUndefined();
    expect(doc.animations).toBe(true);
  });

  it("discovers project themes via explicit projectDir", async () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "oc-settings-proj-"));
    try {
      const themesDir = path.join(proj, ".opencode", "themes");
      fs.mkdirSync(themesDir, { recursive: true });
      fs.writeFileSync(path.join(themesDir, "proj-theme.json"), "{}", "utf8");
      const payload = await service.load(proj);
      expect(
        payload.themeOptions.some((t) => t.value === "proj-theme"),
      ).toBe(true);
      const plain = await service.load();
      expect(plain.themeOptions.some((t) => t.value === "proj-theme")).toBe(
        false,
      );
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });

  it("does not scan process.cwd() for themes", async () => {
    const prevCwd = process.cwd();
    const cwdThemes = path.join(dir, ".opencode", "themes");
    fs.mkdirSync(cwdThemes, { recursive: true });
    fs.writeFileSync(path.join(cwdThemes, "cwd-theme.json"), "{}", "utf8");
    process.chdir(dir);
    try {
      const payload = await service.load();
      expect(
        payload.themeOptions.some((t) => t.value === "cwd-theme"),
      ).toBe(false);
    } finally {
      process.chdir(prevCwd);
    }
    const restored = await service.load();
    expect(restored.themeOptions.some((t) => t.value === "cwd-theme")).toBe(
      false,
    );
  });

  it("addPlugin appends to plugins and preserves existing entries", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ plugins: ["@scope/one"], animations: true }),
      "utf8",
    );
    await service.addPlugin("@scope/two@1.0.0");
    const doc = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      plugins: unknown[];
      animations: boolean;
    };
    expect(doc.plugins).toEqual(["@scope/one", "@scope/two@1.0.0"]);
    expect(doc.animations).toBe(true);
  });

  it("addPlugin rejects empty package name", async () => {
    await expect(service.addPlugin("  ")).rejects.toThrow(/required/);
  });

  it("addPlugin starts a plugins array when missing", async () => {
    await service.addPlugin("pkg");
    const doc = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      plugins: unknown[];
    };
    expect(doc.plugins).toEqual(["pkg"]);
  });

  it("addPlugin rejects the same package with a different version", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ plugins: ["foo@1.0.0"] }),
      "utf8",
    );
    await expect(service.addPlugin("foo@2.0.0")).rejects.toThrow(
      /already added/,
    );
  });

  it("addPlugin rejects a versioned spec when the bare package exists", async () => {
    fs.writeFileSync(configPath, JSON.stringify({ plugins: ["foo"] }), "utf8");
    await expect(service.addPlugin("foo@1.0.0")).rejects.toThrow(
      /already added/,
    );
  });

  it("addPlugin treats scoped names as the same package across versions", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ plugins: ["@scope/name@1.0.0"] }),
      "utf8",
    );
    await expect(service.addPlugin("@scope/name")).rejects.toThrow(
      /already added/,
    );
  });

  it("addPlugin allows distinct scoped packages sharing a prefix", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ plugins: ["@scope/name"] }),
      "utf8",
    );
    await service.addPlugin("@scope/name-extra");
    const doc = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      plugins: unknown[];
    };
    expect(doc.plugins).toEqual(["@scope/name", "@scope/name-extra"]);
  });

  it("addPlugin compares against object-form entries", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ plugins: [{ package: "foo@1.0.0", options: { a: 1 } }] }),
      "utf8",
    );
    await expect(service.addPlugin("foo")).rejects.toThrow(/already added/);
  });

  it("addPlugin leaves cli.json untouched when it rejects a duplicate", async () => {
    const original = JSON.stringify({ plugins: ["foo@1.0.0"], animations: true });
    fs.writeFileSync(configPath, original, "utf8");
    await expect(service.addPlugin("foo")).rejects.toThrow(/already added/);
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
  });

  it("removePlugin deletes by index", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ plugins: ["a", "b", "c"] }),
      "utf8",
    );
    await service.removePlugin(1);
    const doc = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      plugins: unknown[];
    };
    expect(doc.plugins).toEqual(["a", "c"]);
  });

  it("removePlugin rejects out-of-range index", async () => {
    fs.writeFileSync(configPath, JSON.stringify({ plugins: ["a"] }), "utf8");
    await expect(service.removePlugin(5)).rejects.toThrow(/out of range/);
    const doc = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      plugins: unknown[];
    };
    expect(doc.plugins).toEqual(["a"]);
  });

  it("checkPluginUpdates reports latest versions from npm", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        plugins: ["demo-pkg@1.0.0", { package: "other-pkg@2.0.0" }],
      }),
      "utf8",
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url: unknown) => {
        const u = String(url);
        if (u.includes("demo-pkg")) {
          return {
            ok: true,
            json: async () => ({ version: "1.2.0" }),
          } as Response;
        }
        if (u.includes("other-pkg")) {
          return {
            ok: true,
            json: async () => ({ version: "2.0.0" }),
          } as Response;
        }
        return { ok: false, status: 404 } as Response;
      });
    try {
      const results = await service.checkPluginUpdates();
      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({
        name: "demo-pkg",
        current: "1.0.0",
        latest: "1.2.0",
        hasUpdate: true,
      });
      expect(results[1]).toMatchObject({
        name: "other-pkg",
        current: "2.0.0",
        latest: "2.0.0",
        hasUpdate: false,
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("checkPluginUpdates marks errors without failing the batch", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ plugins: ["missing-pkg@1.0.0"] }),
      "utf8",
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: false, status: 404 } as Response);
    try {
      const results = await service.checkPluginUpdates();
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        name: "missing-pkg",
        current: "1.0.0",
        latest: null,
        hasUpdate: false,
      });
      expect(results[0]?.error).toBeTruthy();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("checkPluginUpdates ignores a legacy object version field", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        plugins: [{ package: "legacy-pkg@1.0.0", version: "9.9.9" }],
      }),
      "utf8",
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () => ({ ok: true, json: async () => ({ version: "1.0.0" }) }) as Response,
      );
    try {
      const results = await service.checkPluginUpdates();
      expect(results[0]).toMatchObject({
        name: "legacy-pkg",
        current: "1.0.0",
        latest: "1.0.0",
        hasUpdate: false,
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("checkPluginUpdates skips a bare package name", async () => {
    fs.writeFileSync(configPath, JSON.stringify({ plugins: ["foo"] }), "utf8");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    try {
      await expect(service.checkPluginUpdates()).resolves.toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("checkPluginUpdates skips range and dist-tag versions", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        plugins: ["foo@^1.2.0", "bar@~2.0.0", "baz@latest"],
      }),
      "utf8",
    );
    const fetchMock = vi.spyOn(globalThis, "fetch");
    try {
      await expect(service.checkPluginUpdates()).resolves.toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("checkPluginUpdates checks an exact version", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ plugins: ["foo@1.2.3"] }),
      "utf8",
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () => ({ ok: true, json: async () => ({ version: "1.3.0" }) }) as Response,
      );
    try {
      const results = await service.checkPluginUpdates();
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        name: "foo",
        current: "1.2.3",
        latest: "1.3.0",
        hasUpdate: true,
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("checkPluginUpdates keeps the pinned entries in config order", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        plugins: [
          "aa",
          "bb@1.0.0",
          { package: "cc@^2.0.0", options: {} },
          { package: "dd@2.0.0" },
          "ee@latest",
        ],
      }),
      "utf8",
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url: unknown) => {
        const version = String(url).includes("bb") ? "1.1.0" : "2.0.1";
        return { ok: true, json: async () => ({ version }) } as Response;
      });
    try {
      const results = await service.checkPluginUpdates();
      expect(results.map((result) => result.name)).toEqual(["bb", "dd"]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("checkPluginUpdates still reports malformed entries", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ plugins: [{ options: {} }] }),
      "utf8",
    );
    const fetchMock = vi.spyOn(globalThis, "fetch");
    try {
      const results = await service.checkPluginUpdates();
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        current: null,
        latest: null,
        hasUpdate: false,
        error: "Unrecognized plugin entry",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("checkPluginUpdates applies the skip rule to object entries", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        plugins: [
          { package: "foo", options: { a: 1 } },
          { package: "bar", version: "9.9.9" },
          { package: "foo@1.2.3", options: { a: 1 } },
        ],
      }),
      "utf8",
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () => ({ ok: true, json: async () => ({ version: "1.2.3" }) }) as Response,
      );
    try {
      const results = await service.checkPluginUpdates();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        name: "foo",
        current: "1.2.3",
        hasUpdate: false,
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("updatePluginVersion rewrites a string package spec", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ plugins: ["demo-pkg@1.0.0", "other"] }),
      "utf8",
    );
    await service.updatePluginVersion(0, "1.2.0");
    const doc = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      plugins: unknown[];
    };
    expect(doc.plugins[0]).toBe("demo-pkg@1.2.0");
    expect(doc.plugins[1]).toBe("other");
  });

  it("updatePluginVersion writes the version into package for pinned object entries", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        plugins: [{ package: "foo@1.0.0", options: { a: 1 } }],
      }),
      "utf8",
    );
    await service.updatePluginVersion(0, "2.0.0");
    const doc = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      plugins: Array<Record<string, unknown>>;
    };
    expect(doc.plugins[0]).toEqual({
      package: "foo@2.0.0",
      options: { a: 1 },
    });
    expect(doc.plugins[0]).not.toHaveProperty("version");
  });

  it("updatePluginVersion drops a legacy object version field", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        plugins: [{ package: "foo@1.0.0", version: "1.0.0", options: {} }],
      }),
      "utf8",
    );
    await service.updatePluginVersion(0, "2.0.0");
    const doc = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      plugins: Array<Record<string, unknown>>;
    };
    expect(doc.plugins[0]).toEqual({ package: "foo@2.0.0", options: {} });
    expect(doc.plugins[0]).not.toHaveProperty("version");
  });

  it("updatePluginVersion keeps extra fields on object entries", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        plugins: [{ package: "obj-pkg@0.9.0", enabled: true }],
      }),
      "utf8",
    );
    await service.updatePluginVersion(0, "2.0.0");
    const doc = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      plugins: Array<Record<string, unknown>>;
    };
    expect(doc.plugins[0]).toEqual({ package: "obj-pkg@2.0.0", enabled: true });
  });

  it("updatePluginVersion targets the package name when the list shifts before the write", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ plugins: ["demo-pkg@1.0.0", "other-pkg@1.0.0"] }),
      "utf8",
    );
    // Rewrite cli.json after the index -> name read but before the write, so
    // the index points at another plugin by the time the mutation runs.
    class DriftingService extends OpenCodeCliSettingsService {
      private calls = 0;

      public override resolveConfigPath(): string {
        this.calls += 1;
        if (this.calls === 2) {
          fs.writeFileSync(
            configPath,
            JSON.stringify({ plugins: ["other-pkg@1.0.0", "demo-pkg@1.0.0"] }),
            "utf8",
          );
        }
        return super.resolveConfigPath();
      }
    }
    const drifting = new DriftingService(logger);
    await drifting.updatePluginVersion(1, "2.0.0");
    const doc = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      plugins: unknown[];
    };
    expect(doc.plugins).toEqual(["other-pkg@2.0.0", "demo-pkg@1.0.0"]);
  });

  it("updatePluginVersion leaves follow-latest entries unpinned", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        plugins: [
          "demo-pkg",
          "range-pkg@^1.0.0",
          { package: "obj-pkg", options: { a: 1 } },
        ],
      }),
      "utf8",
    );
    await service.updatePluginVersion(0, "1.2.0");
    await service.updatePluginVersion(1, "1.2.0");
    await service.updatePluginVersion(2, "1.2.0");
    const doc = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      plugins: unknown[];
    };
    expect(doc.plugins[0]).toBe("demo-pkg");
    expect(doc.plugins[1]).toBe("range-pkg");
    expect(doc.plugins[2]).toEqual({ package: "obj-pkg", options: { a: 1 } });
  });

  it("setPluginOptions promotes a string entry and keeps its version", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ plugins: ["foo@1.2.3"] }),
      "utf8",
    );
    await service.setPluginOptions(0, { a: 1, b: "x" });
    const doc = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      plugins: Array<Record<string, unknown>>;
    };
    expect(doc.plugins[0]).toEqual({
      package: "foo@1.2.3",
      options: { a: 1, b: "x" },
    });
  });

  it("setPluginOptions removes the field for an empty options object", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        plugins: [{ package: "foo@1.2.3", options: { a: 1 } }],
      }),
      "utf8",
    );
    await service.setPluginOptions(0, {});
    const doc = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      plugins: Array<Record<string, unknown>>;
    };
    expect(doc.plugins[0]).toEqual({ package: "foo@1.2.3" });
    expect(doc.plugins[0]).not.toHaveProperty("options");
  });

  it("setPluginOptions replaces only the options of an object entry", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        plugins: [{ package: "foo@1.2.3", options: { a: 1 }, extra: true }],
      }),
      "utf8",
    );
    await service.setPluginOptions(0, { b: 2 });
    const doc = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      plugins: Array<Record<string, unknown>>;
    };
    expect(doc.plugins[0]).toEqual({
      package: "foo@1.2.3",
      options: { b: 2 },
      extra: true,
    });
  });

  it("setPluginOptions rejects out-of-range indices", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ plugins: ["foo"] }),
      "utf8",
    );
    await expect(service.setPluginOptions(5, { a: 1 })).rejects.toThrow(
      /out of range/,
    );
    await expect(service.setPluginOptions(-1, { a: 1 })).rejects.toThrow(
      /Invalid plugin index/,
    );
    const doc = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      plugins: unknown[];
    };
    expect(doc.plugins).toEqual(["foo"]);
  });

  it("updatePluginVersion rejects empty version and bad index", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ plugins: ["demo-pkg@1.0.0"] }),
      "utf8",
    );
    await expect(service.updatePluginVersion(0, "  ")).rejects.toThrow(
      /version is required/,
    );
    await expect(service.updatePluginVersion(3, "1.0.0")).rejects.toThrow(
      /out of range/,
    );
    const doc = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      plugins: unknown[];
    };
    expect(doc.plugins[0]).toBe("demo-pkg@1.0.0");
  });

  it("loadInstalledPluginVersions returns nothing when the cache is missing", async () => {
    expect(await service.loadInstalledPluginVersions(["foo", "bar@1.0.0"])).toEqual({});
  });

  it("loadInstalledPluginVersions reads the cached manifest version", async () => {
    writeCachedPlugin("foo@latest", "1700000000000", "foo", "1.4.2");
    expect(await service.loadInstalledPluginVersions(["foo"])).toEqual({
      foo: "1.4.2",
    });
  });

  it("loadInstalledPluginVersions skips entries without a usable manifest", async () => {
    // Generation exists but the plugin folder was never installed.
    fs.mkdirSync(
      path.join(cacheRoot, "foo@latest", "1700000000000", "node_modules"),
      { recursive: true },
    );
    // Manifest exists but is not valid JSON.
    const brokenDir = path.join(
      cacheRoot,
      "bar@latest",
      "1700000000000",
      "node_modules",
      "bar",
    );
    fs.mkdirSync(brokenDir, { recursive: true });
    fs.writeFileSync(path.join(brokenDir, "package.json"), "{oops", "utf8");
    expect(await service.loadInstalledPluginVersions(["foo", "bar"])).toEqual({});
  });

  it("loadInstalledPluginVersions picks the highest generation numerically", async () => {
    writeCachedPlugin("foo@latest", "9", "foo", "0.9.0");
    writeCachedPlugin("foo@latest", "10", "foo", "1.0.0");
    // 10 must win: generations sort by number, not as text.
    expect(await service.loadInstalledPluginVersions(["foo"])).toEqual({
      foo: "1.0.0",
    });
  });

  it("loadInstalledPluginVersions uses the @latest cache for a bare name", async () => {
    writeCachedPlugin("foo@latest", "1700000000000", "foo", "2.0.0");
    writeCachedPlugin("foo@1.2.3", "1700000000000", "foo", "1.2.3");
    expect(await service.loadInstalledPluginVersions(["foo"])).toEqual({
      foo: "2.0.0",
    });
  });

  it("loadInstalledPluginVersions uses the pinned spec cache for an exact version", async () => {
    writeCachedPlugin("foo@latest", "1700000000000", "foo", "2.0.0");
    writeCachedPlugin("foo@1.2.3", "1700000000000", "foo", "1.2.3");
    expect(await service.loadInstalledPluginVersions(["foo@1.2.3"])).toEqual({
      foo: "1.2.3",
    });
  });

  it("loadInstalledPluginVersions uses the range cache key", async () => {
    writeCachedPlugin("foo@^1.2.0", "1700000000000", "foo", "1.9.9");
    writeCachedPlugin("foo@latest", "1700000000000", "foo", "2.0.0");
    expect(await service.loadInstalledPluginVersions(["foo@^1.2.0"])).toEqual({
      foo: "1.9.9",
    });
  });

  it("loadInstalledPluginVersions falls back to the @latest cache", async () => {
    writeCachedPlugin("foo@latest", "1700000000000", "foo", "2.0.0");
    expect(await service.loadInstalledPluginVersions(["foo@1.2.3"])).toEqual({
      foo: "2.0.0",
    });
  });

  it("loadInstalledPluginVersions reads scoped and object entries", async () => {
    writeCachedPlugin("@scope/name@latest", "1700000000000", "@scope/name", "0.2.0");
    expect(
      await service.loadInstalledPluginVersions([
        "@scope/name",
        { package: "@scope/name@latest", options: {} },
        { options: {} },
      ]),
    ).toEqual({ "@scope/name": "0.2.0" });
  });

  it.runIf(process.platform === "win32")(
    "loadInstalledPluginVersions mirrors OpenCode's cache-key sanitizing",
    async () => {
      // OpenCode replaces <>:"|?* with `_` on Windows, so `>=1.2.0` becomes `_=1.2.0`.
      writeCachedPlugin("foo@_=1.2.0", "1700000000000", "foo", "1.5.0");
      expect(await service.loadInstalledPluginVersions(["foo@>=1.2.0"])).toEqual({
        foo: "1.5.0",
      });
    },
  );

  it("load() includes installed plugin versions", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ plugins: ["foo", "bar@1.0.0"] }),
      "utf8",
    );
    writeCachedPlugin("foo@latest", "1700000000000", "foo", "1.4.2");
    // load() now also asks npm for follow-latest entries; keep it offline.
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () =>
          ({ ok: true, json: async () => ({ version: "2.0.0" }) }) as Response,
      );
    try {
      const payload = await service.load();
      expect(payload.installedPluginVersions).toEqual({ foo: "1.4.2" });
      expect(payload.pluginLatestVersions).toEqual({ foo: "2.0.0" });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("loadPluginLatestVersions queries only follow-latest entries", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () =>
          ({ ok: true, json: async () => ({ version: "3.0.6" }) }) as Response,
      );
    try {
      const versions = await service.loadPluginLatestVersions([
        "bare-pkg",
        "range-pkg@^1.0.0",
        "pinned-pkg@1.0.0",
        { package: "obj-pkg", options: {} },
        { options: {} },
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(versions).toEqual({
        "bare-pkg": "3.0.6",
        "range-pkg": "3.0.6",
        "obj-pkg": "3.0.6",
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("loadPluginLatestVersions keeps other results when one lookup fails", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url: unknown) => {
        if (String(url).includes("missing-pkg")) {
          return { ok: false, status: 404 } as Response;
        }
        return {
          ok: true,
          json: async () => ({ version: "3.0.6" }),
        } as Response;
      });
    try {
      const versions = await service.loadPluginLatestVersions([
        "missing-pkg",
        "good-pkg",
      ]);
      expect(versions).toEqual({ "good-pkg": "3.0.6" });
      expect(logger.debug).toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("reuses a registry answer within the TTL and refreshes it after", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () =>
          ({ ok: true, json: async () => ({ version: "1.0.0" }) }) as Response,
      );
    try {
      await service.loadPluginLatestVersions(["foo"]);
      await service.loadPluginLatestVersions(["foo"]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // A publish right after the cached answer must show up once the TTL ends.
      now.mockReturnValue(1_000_000 + 61_000);
      await service.loadPluginLatestVersions(["foo"]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      fetchMock.mockRestore();
      now.mockRestore();
    }
  });

  it("does not cache a failed latest lookup", async () => {
    let attempt = 0;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        attempt += 1;
        if (attempt === 1) {
          return { ok: false, status: 500 } as Response;
        }
        return {
          ok: true,
          json: async () => ({ version: "3.0.6" }),
        } as Response;
      });
    try {
      expect(await service.loadPluginLatestVersions(["foo"])).toEqual({});
      expect(await service.loadPluginLatestVersions(["foo"])).toEqual({
        foo: "3.0.6",
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("clearPluginCache deletes the @latest directory", async () => {
    writeCachedPlugin("foo@latest", "1700000000000", "foo", "2.2.24");
    await service.clearPluginCache("foo");
    expect(fs.existsSync(path.join(cacheRoot, "foo@latest"))).toBe(false);
  });

  it("clearPluginCache is a no-op when the cache is already gone", async () => {
    await expect(service.clearPluginCache("absent-pkg")).resolves.toBeUndefined();
  });

  it("clearPluginCache leaves pinned version directories alone", async () => {
    writeCachedPlugin("foo@1.2.3", "1700000000000", "foo", "1.2.3");
    writeCachedPlugin("foo@latest", "1700000000000", "foo", "2.2.24");
    await service.clearPluginCache("foo");
    expect(fs.existsSync(path.join(cacheRoot, "foo@latest"))).toBe(false);
    expect(fs.existsSync(path.join(cacheRoot, "foo@1.2.3"))).toBe(true);
  });

  it("clearPluginCache handles a scoped package name", async () => {
    writeCachedPlugin("@scope/name@latest", "1700000000000", "@scope/name", "0.2.0");
    await service.clearPluginCache("@scope/name");
    expect(fs.existsSync(path.join(cacheRoot, "@scope/name@latest"))).toBe(false);
  });

  it("clearPluginCache refuses a name that escapes the cache root", async () => {
    const outside = path.join(dir, "cache", "outside", "victim@latest");
    fs.mkdirSync(outside, { recursive: true });
    await expect(
      service.clearPluginCache("../../outside/victim"),
    ).rejects.toThrow(/cannot be refreshed/);
    expect(fs.existsSync(outside)).toBe(true);
  });

  it("clearPluginCache rejects an empty name", async () => {
    await expect(service.clearPluginCache("   ")).rejects.toThrow(/required/);
  });
});
