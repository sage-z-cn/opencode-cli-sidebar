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
  let service: OpenCodeCliSettingsService;
  let prevConfigDir: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-settings-"));
    configPath = path.join(dir, "cli.json");
    prevConfigDir = process.env.OPENCODE_CONFIG_DIR;
    process.env.OPENCODE_CONFIG_DIR = dir;
    service = new OpenCodeCliSettingsService(logger);
  });

  afterEach(() => {
    if (prevConfigDir === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR;
    } else {
      process.env.OPENCODE_CONFIG_DIR = prevConfigDir;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

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
      JSON.stringify({ plugins: [{ package: "foo", version: "1.0.0" }] }),
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
        plugins: ["demo-pkg@1.0.0", { package: "other-pkg", version: "2.0.0" }],
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
      JSON.stringify({ plugins: ["missing-pkg"] }),
      "utf8",
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: false, status: 404 } as Response);
    try {
      const results = await service.checkPluginUpdates();
      expect(results[0]).toMatchObject({
        name: "missing-pkg",
        latest: null,
        hasUpdate: false,
      });
      expect(results[0]?.error).toBeTruthy();
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

  it("updatePluginVersion rewrites object entries and keeps extra fields", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        plugins: [{ package: "obj-pkg@0.9.0", version: "0.9.0", enabled: true }],
      }),
      "utf8",
    );
    await service.updatePluginVersion(0, "2.0.0");
    const doc = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      plugins: Array<Record<string, unknown>>;
    };
    expect(doc.plugins[0]).toMatchObject({
      package: "obj-pkg",
      version: "2.0.0",
      enabled: true,
    });
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
});
