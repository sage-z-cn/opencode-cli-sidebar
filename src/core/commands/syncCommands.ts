import * as vscode from "vscode";
import type { ConfigSyncService } from "../../services/sync/ConfigSyncService";

export interface SyncCommandDependencies {
  configSyncService: ConfigSyncService | undefined;
  /** Aborts the pre-launch config sync; true when one was actually running. */
  skipPreStartSync?: () => boolean;
}

/** Registers the WebDAV config sync commands. */
export function registerSyncCommands(
  deps: SyncCommandDependencies,
): vscode.Disposable[] {
  const syncNowCommand = vscode.commands.registerCommand(
    "opencode-cli-sidebar.webdavSyncNow",
    () => {
      void deps.configSyncService?.syncNow();
    },
  );
  const skipPreStartSyncCommand = vscode.commands.registerCommand(
    "opencode-cli-sidebar.skipPreStartSync",
    () => {
      deps.skipPreStartSync?.();
    },
  );
  return [syncNowCommand, skipPreStartSyncCommand];
}
