import { describe, it, expect, beforeEach, vi } from "vitest";
import * as vscode from "vscode";
import {
  SETTINGS_MIGRATED_FLAG_KEY,
  SettingsMigrationService,
} from "./SettingsMigrationService";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

interface LayeredValue {
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
  languageValue?: unknown;
}

interface RecordedUpdate {
  key: string;
  value: unknown;
  target: unknown;
}

function createMemento(initial?: Record<string, unknown>) {
  const data = new Map<string, unknown>(Object.entries(initial ?? {}));
  return {
    get: vi.fn(
      <T>(key: string): T | undefined => data.get(key) as T | undefined,
    ),
    update: vi.fn(async (key: string, value: unknown): Promise<void> => {
      data.set(key, value);
    }),
    data,
  };
}

/**
 * Installs a getConfiguration mock that answers inspect calls from two
 * suffix-keyed tables and records every update.
 */
function setupConfiguration(setup: {
  current?: Record<string, LayeredValue>;
  legacy?: Record<string, LayeredValue>;
  rejectKeys?: Set<string>;
}): RecordedUpdate[] {
  const current = setup.current ?? {};
  const legacy = setup.legacy ?? {};
  const updates: RecordedUpdate[] = [];

  vi.mocked(vscode.workspace.getConfiguration).mockImplementation(
    (() => ({
      get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
      inspect: vi.fn((key: string) => {
        if (key.startsWith("ai-sidebar-terminal.")) {
          return legacy[key.slice("ai-sidebar-terminal.".length)];
        }
        if (key.startsWith("opencode-cli-sidebar.")) {
          return current[key.slice("opencode-cli-sidebar.".length)];
        }
        return undefined;
      }),
      update: vi.fn(async (key: string, value: unknown, target: unknown) => {
        if (setup.rejectKeys?.has(key)) {
          throw new Error(`write rejected for ${key}`);
        }
        updates.push({ key, value, target });
      }),
    })) as never,
  );

  return updates;
}

describe("SettingsMigrationService", () => {
  let memento: ReturnType<typeof createMemento>;

  beforeEach(() => {
    memento = createMemento();
  });

  it("migrates a legacy global value to the new key with the Global target", async () => {
    const updates = setupConfiguration({
      legacy: { fontSize: { globalValue: 20 } },
    });

    const result = await new SettingsMigrationService(memento, {
      logger,
    }).migrate();

    expect(updates).toEqual([
      {
        key: "opencode-cli-sidebar.fontSize",
        value: 20,
        target: vscode.ConfigurationTarget.Global,
      },
    ]);
    expect(result.migratedKeys).toEqual(["opencode-cli-sidebar.fontSize"]);
    expect(result.skippedCount).toBe(23);
    expect(result.failedKeys).toEqual([]);
  });

  it("migrates a legacy workspace value to the new key with the Workspace target", async () => {
    const updates = setupConfiguration({
      legacy: { shellPath: { workspaceValue: "/bin/zsh" } },
    });

    await new SettingsMigrationService(memento, { logger }).migrate();

    expect(updates).toEqual([
      {
        key: "opencode-cli-sidebar.shellPath",
        value: "/bin/zsh",
        target: vscode.ConfigurationTarget.Workspace,
      },
    ]);
  });

  it("prefers the legacy global value when both legacy layers are set", async () => {
    const updates = setupConfiguration({
      legacy: { logLevel: { globalValue: "debug", workspaceValue: "error" } },
    });

    await new SettingsMigrationService(memento, { logger }).migrate();

    expect(updates).toEqual([
      {
        key: "opencode-cli-sidebar.logLevel",
        value: "debug",
        target: vscode.ConfigurationTarget.Global,
      },
    ]);
  });

  it("does not overwrite a new key that already has a global or workspace value", async () => {
    const updates = setupConfiguration({
      current: {
        fontSize: { globalValue: 14 },
        shellPath: { workspaceValue: "/bin/bash" },
      },
      legacy: {
        fontSize: { globalValue: 20 },
        shellPath: { globalValue: "/bin/zsh" },
      },
    });

    const result = await new SettingsMigrationService(memento, {
      logger,
    }).migrate();

    expect(updates).toEqual([]);
    expect(result.migratedKeys).toEqual([]);
    expect(result.skippedCount).toBe(24);
    expect(memento.get(SETTINGS_MIGRATED_FLAG_KEY)).toBe(true);
  });

  it("ignores deeper inspect layers such as workspace folder and language values", async () => {
    const updates = setupConfiguration({
      legacy: {
        fontSize: { workspaceFolderValue: 12, languageValue: 13 },
      },
    });

    const result = await new SettingsMigrationService(memento, {
      logger,
    }).migrate();

    expect(updates).toEqual([]);
    expect(result.skippedCount).toBe(24);
  });

  it("performs no configuration work when the migration flag already exists", async () => {
    memento = createMemento({ [SETTINGS_MIGRATED_FLAG_KEY]: true });
    const updates = setupConfiguration({
      legacy: { fontSize: { globalValue: 20 } },
    });

    const result = await new SettingsMigrationService(memento, {
      logger,
    }).migrate();

    expect(updates).toEqual([]);
    expect(vscode.workspace.getConfiguration).not.toHaveBeenCalled();
    expect(memento.update).not.toHaveBeenCalled();
    expect(result.migratedKeys).toEqual([]);
    expect(result.skippedCount).toBe(0);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("already migrated"),
    );
  });

  it("continues migrating remaining keys when an individual update fails", async () => {
    const updates = setupConfiguration({
      legacy: {
        fontSize: { globalValue: 20 },
        logLevel: { globalValue: "debug" },
      },
      rejectKeys: new Set(["opencode-cli-sidebar.fontSize"]),
    });

    const result = await new SettingsMigrationService(memento, {
      logger,
    }).migrate();

    expect(updates).toEqual([
      {
        key: "opencode-cli-sidebar.logLevel",
        value: "debug",
        target: vscode.ConfigurationTarget.Global,
      },
    ]);
    expect(result.failedKeys).toEqual(["opencode-cli-sidebar.fontSize"]);
    expect(result.migratedKeys).toEqual(["opencode-cli-sidebar.logLevel"]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("ai-sidebar-terminal.fontSize"),
    );
    expect(memento.get(SETTINGS_MIGRATED_FLAG_KEY)).toBe(true);
  });

  it("writes the migration flag even when nothing was migrated", async () => {
    const updates = setupConfiguration({});

    const result = await new SettingsMigrationService(memento, {
      logger,
    }).migrate();

    expect(updates).toEqual([]);
    expect(result.skippedCount).toBe(24);
    expect(memento.get(SETTINGS_MIGRATED_FLAG_KEY)).toBe(true);
  });

  it("logs the migrated key list and the skipped count", async () => {
    setupConfiguration({ legacy: { fontSize: { globalValue: 20 } } });

    await new SettingsMigrationService(memento, { logger }).migrate();

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Migrated 1 setting(s): opencode-cli-sidebar.fontSize"),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("skipped 23"),
    );
  });

  it("does not throw when persisting the migration flag fails", async () => {
    setupConfiguration({ legacy: { fontSize: { globalValue: 20 } } });
    memento.update.mockRejectedValueOnce(new Error("state locked"));

    await expect(
      new SettingsMigrationService(memento, { logger }).migrate(),
    ).resolves.toBeDefined();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("migration flag"),
    );
  });
});
