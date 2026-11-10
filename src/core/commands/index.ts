import * as vscode from "vscode";
import type { ContextManager } from "../../services/ContextManager";
import type { ConfigSyncService } from "../../services/sync/ConfigSyncService";
import {
  registerTerminalCommands,
  type TerminalCommandDependencies,
} from "./terminalCommands";
import { registerSyncCommands } from "./syncCommands";

export type RegisterCommandDependencies = TerminalCommandDependencies & {
  contextManager: ContextManager | undefined;
  configSyncService: ConfigSyncService | undefined;
  skipPreStartSync?: () => boolean;
};

export function registerCommands(
  context: vscode.ExtensionContext,
  deps: RegisterCommandDependencies,
): void {
  const disposables: vscode.Disposable[] = [
    ...registerTerminalCommands(deps),
    ...registerSyncCommands(deps),
  ];

  context.subscriptions.push(...disposables);
}
