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
  const forcePullCommand = vscode.commands.registerCommand(
    "opencode-cli-sidebar.webdavForcePull",
    async () => {
      // The confirmation lives in the webview, so make sure the view exists
      // before the service posts the prompt.
      await vscode.commands.executeCommand("opencode-cli-sidebar.focus");
      await deps.configSyncService?.forcePullFromServer();
    },
  );
  const forcePushCommand = vscode.commands.registerCommand(
    "opencode-cli-sidebar.webdavForcePush",
    async () => {
      await vscode.commands.executeCommand("opencode-cli-sidebar.focus");
      await deps.configSyncService?.forcePushToServer();
    },
  );
  return [
    syncNowCommand,
    skipPreStartSyncCommand,
    forcePullCommand,
    forcePushCommand,
  ];
}
