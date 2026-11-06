import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
  EXTENSION_SETTINGS_CATALOG,
  ExtensionSettingsService,
} from "./ExtensionSettingsService";

interface ConfigurationSetup {
  /** Effective values returned by get(); missing keys fall back to catalog defaults. */
  effective?: Record<string, unknown>;
  global?: Record<string, unknown>;
  workspace?: Record<string, unknown>;
}

function setupConfiguration(setup: ConfigurationSetup = {}) {
  const update = vi.fn(async () => undefined);
  const inspect = vi.fn((key: string) => ({
    key,
    defaultValue: EXTENSION_SETTINGS_CATALOG[key]?.default,
    globalValue: setup.global?.[key],
    workspaceValue: setup.workspace?.[key],
  }));
  const effective = setup.effective ?? {};
  const get = vi.fn((key: string) =>
    Object.prototype.hasOwnProperty.call(effective, key)
      ? effective[key]
      : EXTENSION_SETTINGS_CATALOG[key]?.default,
  );

  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
    get,
    inspect,
    update,
  } as never);

  return { update, inspect, get };
}

describe("ExtensionSettingsService", () => {
  let service: ExtensionSettingsService;

  beforeEach(() => {
    service = new ExtensionSettingsService();
    vscode.workspace.workspaceFolders = [
      {
        uri: vscode.Uri.file("/workspace"),
        name: "workspace",
        index: 0,
      },
    ] as never;
  });

  it("reads every catalog key with effective values, authored layers and defaults", () => {
    const { get } = setupConfiguration({
      effective: { fontFamily: "Fira Code", httpTimeout: 12000 },
      global: { fontFamily: "Fira Code", httpTimeout: 9000 },
      workspace: { httpTimeout: 12000 },
    });

    const snapshot = service.readSnapshot();

    expect(Object.keys(snapshot.values)).toHaveLength(
      Object.keys(EXTENSION_SETTINGS_CATALOG).length,
    );
    expect(get).toHaveBeenCalledWith("fontFamily");
    expect(snapshot.values.fontFamily).toBe("Fira Code");
    expect(snapshot.values.httpTimeout).toBe(12000);
    expect(snapshot.userValues).toEqual({
      fontFamily: "Fira Code",
      httpTimeout: 9000,
    });
    expect(snapshot.workspaceValues).toEqual({ httpTimeout: 12000 });
    expect(snapshot.defaults.focusIndicatorMode).toBe("bottomBorder");
    expect(snapshot.defaults.codeActionSeverities).toEqual([
      "error",
      "warning",
    ]);
    expect(snapshot.hasWorkspace).toBe(true);
  });

  it("omits authored layers for keys that are unset", () => {
    setupConfiguration({
      effective: {},
      global: {},
      workspace: {},
    });

    const snapshot = service.readSnapshot();

    expect(snapshot.userValues).toEqual({});
    expect(snapshot.workspaceValues).toEqual({});
    expect(snapshot.values.shellPath).toBe("");
  });

  it("reports no workspace when no folder is open", () => {
    setupConfiguration();
    vscode.workspace.workspaceFolders = undefined;

    expect(service.readSnapshot().hasWorkspace).toBe(false);
  });

  it("rounds numbers and clamps them to the catalog bounds", async () => {
    const { update } = setupConfiguration();

    await service.update("focusIndicatorBorderWidth", 99.6, "user");
    await service.update("focusIndicatorBorderWidth", 0, "workspace");
    await service.update("contextDebounceMs", 100.4, "user");
    await service.update("update.checkIntervalHours", 0.4, "user");
    await service.update("httpTimeout", 2500.5, "user");

    expect(update).toHaveBeenNthCalledWith(
      1,
      "focusIndicatorBorderWidth",
      8,
      vscode.ConfigurationTarget.Global,
    );
    expect(update).toHaveBeenNthCalledWith(
      2,
      "focusIndicatorBorderWidth",
      1,
      vscode.ConfigurationTarget.Workspace,
    );
    expect(update).toHaveBeenNthCalledWith(
      3,
      "contextDebounceMs",
      100,
      vscode.ConfigurationTarget.Global,
    );
    expect(update).toHaveBeenNthCalledWith(
      4,
      "update.checkIntervalHours",
      1,
      vscode.ConfigurationTarget.Global,
    );
    expect(update).toHaveBeenNthCalledWith(
      5,
      "httpTimeout",
      2501,
      vscode.ConfigurationTarget.Global,
    );
  });

  it("accepts enum values on the whitelist and rejects the rest", async () => {
    const { update } = setupConfiguration();

    await service.update("logLevel", "warn", "user");
    await service.update("fileSendMode", "path", "workspace");

    expect(update).toHaveBeenNthCalledWith(
      1,
      "logLevel",
      "warn",
      vscode.ConfigurationTarget.Global,
    );
    expect(update).toHaveBeenNthCalledWith(
      2,
      "fileSendMode",
      "path",
      vscode.ConfigurationTarget.Workspace,
    );

    await expect(
      service.update("focusIndicatorMode", "leftBorder", "user"),
    ).rejects.toThrow("This value cannot be saved.");
    await expect(service.update("logLevel", 2, "user")).rejects.toThrow(
      "This value cannot be saved.",
    );
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("validates string and boolean types", async () => {
    const { update } = setupConfiguration();

    await service.update("shellPath", "/bin/zsh", "user");
    await service.update("autoShareContext", false, "user");

    expect(update).toHaveBeenCalledTimes(2);
    await expect(service.update("shellPath", 42, "user")).rejects.toThrow(
      "This value cannot be saved.",
    );
    await expect(
      service.update("autoShareContext", "false", "user"),
    ).rejects.toThrow("This value cannot be saved.");
  });

  it("validates array entries, including whitelisted enum arrays", async () => {
    const { update } = setupConfiguration();

    await service.update("opencode.args", ["--flag", "value"], "user");
    await service.update(
      "codeActionSeverities",
      ["error", "hint"],
      "workspace",
    );

    expect(update).toHaveBeenNthCalledWith(
      1,
      "opencode.args",
      ["--flag", "value"],
      vscode.ConfigurationTarget.Global,
    );
    expect(update).toHaveBeenNthCalledWith(
      2,
      "codeActionSeverities",
      ["error", "hint"],
      vscode.ConfigurationTarget.Workspace,
    );

    await expect(
      service.update("opencode.args", ["--flag", 3], "user"),
    ).rejects.toThrow("This value cannot be saved.");
    await expect(
      service.update("opencode.args", "--flag", "user"),
    ).rejects.toThrow("This value cannot be saved.");
    await expect(
      service.update("codeActionSeverities", ["error", "fatal"], "user"),
    ).rejects.toThrow("This value cannot be saved.");
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("rejects unknown keys for both update and reset", async () => {
    const { update } = setupConfiguration();

    await expect(
      service.update("fontSize", 20, "user"),
    ).rejects.toThrow("This setting cannot be changed here.");
    await expect(
      service.update("sync.enabled", true, "user"),
    ).rejects.toThrow("This setting cannot be changed here.");
    await expect(service.reset("unknown.key", "user")).rejects.toThrow(
      "This setting cannot be changed here.",
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects workspace writes when no folder is open", async () => {
    const { update } = setupConfiguration();
    vscode.workspace.workspaceFolders = undefined;

    await expect(
      service.update("shellPath", "/bin/zsh", "workspace"),
    ).rejects.toThrow("Open a folder to save this setting at workspace scope.");
    await expect(
      service.reset("shellPath", "workspace"),
    ).rejects.toThrow("Open a folder to save this setting at workspace scope.");
    expect(update).not.toHaveBeenCalled();
  });

  it("clears a layer by writing undefined to the matching target", async () => {
    const { update } = setupConfiguration();

    await service.reset("httpTimeout", "user");
    await service.reset("httpTimeout", "workspace");

    expect(update).toHaveBeenNthCalledWith(
      1,
      "httpTimeout",
      undefined,
      vscode.ConfigurationTarget.Global,
    );
    expect(update).toHaveBeenNthCalledWith(
      2,
      "httpTimeout",
      undefined,
      vscode.ConfigurationTarget.Workspace,
    );
  });
});
