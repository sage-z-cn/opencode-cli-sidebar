import * as vscode from "vscode";
import type { ILogger } from "./ILogger";

/** Settings prefix of the legacy ai-sidebar-terminal extension. */
const LEGACY_SETTINGS_PREFIX = "ai-sidebar-terminal";

/** Settings prefix of the current opencode-cli-sidebar extension. */
const CURRENT_SETTINGS_PREFIX = "opencode-cli-sidebar";

/** globalState flag marking that the one-time settings migration ran. */
export const SETTINGS_MIGRATED_FLAG_KEY =
  "opencode-cli-sidebar.settingsMigrated";

/**
 * Key suffixes migrated from the legacy prefix to the current one.
 * Keep this list in sync with contributes.configuration.properties
 * in package.json.
 */
const CONFIG_KEY_SUFFIXES: readonly string[] = [
  "fontSize",
  "fontFamily",
  "focusIndicatorMode",
  "focusIndicatorBorderWidth",
  "autoFocusOnSend",
  "shellPath",
  "shellArgs",
  "sendKeybindingsToShell",
  "autoShareContext",
  "httpTimeout",
  "logLevel",
  "contextDebounceMs",
  "maxDiagnosticLength",
  "codeActionSeverities",
  "opencode.commandPath",
  "opencode.args",
  "opencode.continueLastSession",
  "update.autoCheck",
  "update.checkIntervalHours",
];

/** Outcome of a settings migration run. */
export interface SettingsMigrationResult {
  /** Current-prefix keys that received a migrated value. */
  migratedKeys: string[];
  /** Keys skipped because the legacy prefix had no value or the current key was already set. */
  skippedCount: number;
  /** Current-prefix keys whose update failed. */
  failedKeys: string[];
}

export interface SettingsMigrationOptions {
  /** Logger receiving the silent migration summary. Logs nowhere when omitted. */
  logger?: Pick<ILogger, "info" | "warn">;
}

const silentLogger = {
  info(): void {
    // intentionally silent
  },
  warn(): void {
    // intentionally silent
  },
};

/**
 * One-time migration of user settings from the legacy
 * ai-sidebar-terminal prefix to the current opencode-cli-sidebar prefix.
 * Fully silent: results are reported through the injected logger only,
 * never through dialogs or notifications.
 */
export class SettingsMigrationService {
  private readonly globalState: vscode.Memento;
  private readonly logger: Pick<ILogger, "info" | "warn">;

  constructor(
    globalState: vscode.Memento,
    options?: SettingsMigrationOptions,
  ) {
    this.globalState = globalState;
    this.logger = options?.logger ?? silentLogger;
  }

  /**
   * Copies legacy-prefixed settings onto the current prefix once.
   * Layer mapping: a legacy global value writes to the Global target;
   * otherwise a legacy workspace value writes to the Workspace target.
   * Deeper inspect layers such as language and workspace folder values
   * are intentionally ignored. A key is skipped whenever the current
   * prefix already has a global or workspace value, so existing user
   * choices are never overwritten. The completion flag is written even
   * when nothing was migrated or individual updates failed.
   */
  async migrate(): Promise<SettingsMigrationResult> {
    const result: SettingsMigrationResult = {
      migratedKeys: [],
      skippedCount: 0,
      failedKeys: [],
    };

    if (this.globalState.get<boolean>(SETTINGS_MIGRATED_FLAG_KEY) === true) {
      this.logger.info(
        "[SettingsMigration] Legacy settings already migrated; skipping.",
      );
      return result;
    }

    const config = vscode.workspace.getConfiguration();

    for (const suffix of CONFIG_KEY_SUFFIXES) {
      const newKey = `${CURRENT_SETTINGS_PREFIX}.${suffix}`;
      const legacyKey = `${LEGACY_SETTINGS_PREFIX}.${suffix}`;

      const newInspect = config.inspect(newKey);
      const legacyInspect = config.inspect(legacyKey);

      const newAlreadySet =
        newInspect?.globalValue !== undefined ||
        newInspect?.workspaceValue !== undefined;
      const legacyGlobal = legacyInspect?.globalValue;
      const legacyWorkspace = legacyInspect?.workspaceValue;
      const legacyHasValue =
        legacyGlobal !== undefined || legacyWorkspace !== undefined;

      if (newAlreadySet || !legacyHasValue) {
        result.skippedCount += 1;
        continue;
      }

      const useGlobal = legacyGlobal !== undefined;
      const value = useGlobal ? legacyGlobal : legacyWorkspace;

      try {
        await config.update(
          newKey,
          value,
          useGlobal
            ? vscode.ConfigurationTarget.Global
            : vscode.ConfigurationTarget.Workspace,
        );
        result.migratedKeys.push(newKey);
      } catch (error) {
        result.failedKeys.push(newKey);
        this.logger.warn(
          `[SettingsMigration] Failed to migrate ${legacyKey} to ${newKey}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    try {
      await this.globalState.update(SETTINGS_MIGRATED_FLAG_KEY, true);
    } catch (error) {
      this.logger.warn(
        `[SettingsMigration] Failed to persist the migration flag: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    this.logger.info(
      `[SettingsMigration] Migrated ${result.migratedKeys.length} setting(s): ${
        result.migratedKeys.join(", ") || "none"
      }; skipped ${result.skippedCount}; failed ${result.failedKeys.length}.`,
    );

    return result;
  }
}
