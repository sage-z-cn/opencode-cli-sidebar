import { describe, expect, it } from "vitest";
import { pluginLabel, pluginNameOf, splitPluginLabel } from "./index";

describe("pluginLabel", () => {
  it("uses the package string of an object entry as the label", () => {
    const label = pluginLabel({
      package: "opencode-tps-meter@0.4.2",
      options: { showCacheHit: false, showElapsed: false },
    });
    expect(label).toBe("opencode-tps-meter@0.4.2");
    expect(splitPluginLabel(label)).toEqual({
      name: "opencode-tps-meter",
      version: "@0.4.2",
    });
  });

  it("keeps scoped package strings splittable", () => {
    const label = pluginLabel({ package: "@scope/name@1.2.3" });
    expect(label).toBe("@scope/name@1.2.3");
    expect(splitPluginLabel(label)).toEqual({
      name: "@scope/name",
      version: "@1.2.3",
    });
  });

  it("ignores a legacy object version field", () => {
    // OpenCode v2 drops this field entirely, so the package string wins.
    const label = pluginLabel({ package: "foo@1.0.0", version: "2.0.0" });
    expect(label).toBe("foo@1.0.0");
    expect(splitPluginLabel(label)).toEqual({
      name: "foo",
      version: "@1.0.0",
    });
  });

  it("returns the bare package when it carries no version", () => {
    expect(pluginLabel({ package: "foo" })).toBe("foo");
    expect(pluginLabel({ package: "  foo  " })).toBe("foo");
    expect(splitPluginLabel(pluginLabel({ package: "foo" }))).toEqual({
      name: "foo",
      version: "",
    });
  });

  it("passes string entries through unchanged", () => {
    expect(pluginLabel("opencode-visual-cache@1.7.5")).toBe(
      "opencode-visual-cache@1.7.5",
    );
    expect(pluginLabel("@scope/name@1.2.3")).toBe("@scope/name@1.2.3");
  });
});

describe("pluginNameOf", () => {
  it("returns a version-free name for every entry shape", () => {
    expect(pluginNameOf("opencode-visual-cache@1.7.5")).toBe(
      "opencode-visual-cache",
    );
    expect(pluginNameOf("oh-my-opencode-slim")).toBe("oh-my-opencode-slim");
    expect(pluginNameOf("@scope/name@1.2.3")).toBe("@scope/name");
    expect(
      pluginNameOf({
        package: "opencode-tps-meter@0.4.2",
        options: { showCacheHit: false },
      }),
    ).toBe("opencode-tps-meter");
    expect(pluginNameOf({ package: "@scope/name@1.2.3" })).toBe("@scope/name");
    expect(pluginNameOf({ package: "@scope/name" })).toBe("@scope/name");
    // A dangling legacy version field must not leak into the name.
    expect(pluginNameOf({ package: "foo@1.0.0", version: "2.0.0" })).toBe(
      "foo",
    );
    expect(pluginNameOf({ package: "foo" })).toBe("foo");
  });
});
