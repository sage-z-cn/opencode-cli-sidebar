import * as vscode from "vscode";
import type {
  ExtensionSettingsScope,
  ExtensionSettingsSnapshot,
} from "../types";

/** Configuration section owning every setting exposed by this service. */
const SETTINGS_SECTION = "opencode-cli-sidebar";

export type ExtensionSettingSpec =
  | { type: "string"; default: string }
  | { type: "boolean"; default: boolean }
  | { type: "number"; default: number; min?: number; max?: number }
  | { type: "enum"; default: string; values: readonly string[] }
  | {
      type: "stringArray";
      default: readonly string[];
      values?: readonly string[];
    };

/**
 * Settings the in-webview extension settings dialog may read and write,
 * keyed by the suffix without the `opencode-cli-sidebar.` prefix.
 *
 * `fontSize` stays on the toolbar control and every `sync.*` setting lives
 * in the config-sync dialog, so neither is part of this catalog.
 */
export const EXTENSION_SETTINGS_CATALOG: Readonly<
  Record<string, ExtensionSettingSpec>
> = {
  fontFamily: {
    type: "string",
    default:
      "'JetBrainsMono Nerd Font', 'FiraCode Nerd Font', 'CascadiaCode NF', Menlo, monospace",
  },
  focusIndicatorMode: {
    type: "enum",
    default: "bottomBorder",
    values: ["off", "bottomBorder", "fullBorder"],
  },
  focusIndicatorBorderWidth: {
    type: "number",
    default: 2,
    min: 1,
    max: 8,
  },
  sendKeybindingsToShell: { type: "boolean", default: true },
  autoFocusOnSend: { type: "boolean", default: true },
  fileSendMode: {
    type: "enum",
    default: "attachment",
    values: ["attachment", "path"],
  },
  autoShareContext: { type: "boolean", default: true },
  "startup.coordinate": { type: "boolean", default: true },
  "opencode.continueLastSession": { type: "boolean", default: true },
  "opencode.commandPath": { type: "string", default: "opencode" },
  "opencode.args": { type: "stringArray", default: [] },
  shellPath: { type: "string", default: "" },
  shellArgs: { type: "stringArray", default: [] },
  contextDebounceMs: { type: "number", default: 500, min: 100, max: 5000 },
  maxDiagnosticLength: {
    type: "number",
    default: 500,
    min: 100,
    max: 2000,
  },
  codeActionSeverities: {
    type: "stringArray",
    default: ["error", "warning"],
    values: ["error", "warning", "information", "hint"],
  },
  logLevel: {
    type: "enum",
    default: "info",
    values: ["debug", "info", "warn", "error"],
  },
  httpTimeout: { type: "number", default: 5000, min: 1000, max: 30000 },
  "update.autoCheck": { type: "boolean", default: true },
  "update.checkIntervalHours": { type: "number", default: 24, min: 1 },
};

function invalidValueError(): Error {
  return new Error("This value cannot be saved.");
}

function requireSpec(key: string): ExtensionSettingSpec {
  const spec = EXTENSION_SETTINGS_CATALOG[key];
  if (!spec) {
    // Wording avoids echoing the raw key: the message may reach the dialog.
    throw new Error("This setting cannot be changed here.");
  }
  return spec;
}

function resolveTarget(scope: ExtensionSettingsScope): vscode.ConfigurationTarget {
  if (scope === "user") {
    return vscode.ConfigurationTarget.Global;
  }
  if (scope === "workspace") {
    if (!vscode.workspace.workspaceFolders?.length) {
      throw new Error(
        "Open a folder to save this setting at workspace scope.",
      );
    }
    return vscode.ConfigurationTarget.Workspace;
  }
  throw new Error("This setting cannot be changed here.");
}

/**
 * Validates one incoming value against its catalog entry and returns the
 * normalized form: numbers are rounded and clamped, arrays are rebuilt with
 * string-only entries, enums must be on the whitelist.
 */
export function normalizeExtensionSettingValue(
  spec: ExtensionSettingSpec,
  value: unknown,
): string | boolean | number | string[] {
  switch (spec.type) {
    case "string":
      if (typeof value !== "string") {
        throw invalidValueError();
      }
      return value;
    case "boolean":
      if (typeof value !== "boolean") {
        throw invalidValueError();
      }
      return value;
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw invalidValueError();
      }
      const rounded = Math.round(value);
      const min = spec.min ?? Number.NEGATIVE_INFINITY;
      const max = spec.max ?? Number.POSITIVE_INFINITY;
      return Math.min(max, Math.max(min, rounded));
    }
    case "enum":
      if (typeof value !== "string" || !spec.values.includes(value)) {
        throw invalidValueError();
      }
      return value;
    case "stringArray": {
      if (!Array.isArray(value)) {
        throw invalidValueError();
      }
      const entries: string[] = [];
      for (const entry of value) {
        if (typeof entry !== "string") {
          throw invalidValueError();
        }
        if (spec.values && !spec.values.includes(entry)) {
          throw invalidValueError();
        }
        entries.push(entry);
      }
      return entries;
    }
  }
}

/**
 * Reads and writes the extension's own settings for the in-webview
 * extension settings dialog.
 *
 * Reads expose every layer so the dialog can show effective values,
 * per-scope values, and defaults; writes target exactly one layer.
 */
export class ExtensionSettingsService {
  /** Snapshot of effective values, authored layers and defaults. */
  public readSnapshot(): ExtensionSettingsSnapshot {
    const config = vscode.workspace.getConfiguration(SETTINGS_SECTION);
    const values: Record<string, unknown> = {};
    const userValues: Record<string, unknown> = {};
    const workspaceValues: Record<string, unknown> = {};
    const defaults: Record<string, unknown> = {};

    for (const [key, spec] of Object.entries(EXTENSION_SETTINGS_CATALOG)) {
      const inspected = config.inspect(key);
      values[key] = config.get(key);
      if (inspected?.globalValue !== undefined) {
        userValues[key] = inspected.globalValue;
      }
      if (inspected?.workspaceValue !== undefined) {
        workspaceValues[key] = inspected.workspaceValue;
      }
      defaults[key] =
        inspected?.defaultValue !== undefined
          ? inspected.defaultValue
          : spec.default;
    }

    return {
      values,
      userValues,
      workspaceValues,
      defaults,
      hasWorkspace: Boolean(vscode.workspace.workspaceFolders?.length),
    };
  }

  /** Writes one validated value at the requested scope. */
  public async update(
    key: string,
    value: unknown,
    scope: ExtensionSettingsScope,
  ): Promise<void> {
    const spec = requireSpec(key);
    const normalized = normalizeExtensionSettingValue(spec, value);
    const target = resolveTarget(scope);
    await vscode.workspace
      .getConfiguration(SETTINGS_SECTION)
      .update(key, normalized, target);
  }

  /** Clears one layer's value so the setting falls back to the next layer. */
  public async reset(
    key: string,
    scope: ExtensionSettingsScope,
  ): Promise<void> {
    requireSpec(key);
    const target = resolveTarget(scope);
    await vscode.workspace
      .getConfiguration(SETTINGS_SECTION)
      .update(key, undefined, target);
  }
}
