import * as vscode from "vscode";
import { l10n } from "../../i18n";
import type { TerminalProvider } from "../../providers/TerminalProvider";
import { toAbsoluteReference } from "../../providers/relativeReference";
import type { ContextSharingService } from "../../services/ContextSharingService";
import type { OpenCodeUpdateService } from "../../services/OpenCodeUpdateService";
import type { OutputChannelService } from "../../services/OutputChannelService";
import type { TerminalManager } from "../../terminals/TerminalManager";

/**
 * Argument shape VS Code passes to commands contributed to
 * `editor/title/context` (the editor tab right-click menu). Only `groupId`
 * is guaranteed; the rest is best-effort. VS Code's internal editor group
 * IDs are not exposed via the extension API, so we fall back to the active
 * text editor's document when we cannot resolve the exact tab.
 */
interface EditorCommandsContext {
  readonly groupId?: unknown;
  readonly editorIndex?: unknown;
}

function isEditorCommandsContext(value: unknown): value is EditorCommandsContext {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as EditorCommandsContext).groupId === "number"
  );
}

/**
 * Resolves file URIs from the heterogeneous argument shapes VS Code passes
 * to `opencode-cli-sidebar.sendToOpencode` and
 * `opencode-cli-sidebar.sendAbsoluteToOpencode` across their menu
 * locations:
 *
 * - `explorer/context`: `("ignored", [uri1, uri2])` — selected resources.
 * - Command palette / API: `(uri)` — a single URI passed directly.
 * - `editor/title/context`: `({ groupId, editorIndex })` — tab context. The
 *   internal groupId cannot be mapped to a `vscode.window.tabGroups` entry,
 *   so we resolve the active text editor's document as the best available
 *   target.
 *
 * The `editor/context` menu does not use this command (it invokes
 * `sendAtMention`, which carries selection line numbers); when this command
 * is invoked with no recognisable args it returns an empty array.
 *
 * Returns an empty array when no URI can be derived, which lets the caller
 * short-circuit cleanly.
 */
function extractUrisFromSendArgs(args: unknown[]): vscode.Uri[] {
  if (args.length > 0 && Array.isArray(args[args.length - 1])) {
    const last = args[args.length - 1] as unknown[];
    if (last.length > 0 && last.every((u) => u instanceof vscode.Uri)) {
      return last as vscode.Uri[];
    }
  }

  if (args.length > 0 && args[0] instanceof vscode.Uri) {
    return [args[0]];
  }

  if (args.length > 0 && isEditorCommandsContext(args[0])) {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    return activeUri ? [activeUri] : [];
  }

  return [];
}

export interface TerminalCommandDependencies {
  provider: TerminalProvider | undefined;
  terminalManager: TerminalManager | undefined;
  contextSharingService: ContextSharingService | undefined;
  outputChannel: OutputChannelService | undefined;
  opencodeUpdateService: OpenCodeUpdateService | undefined;
  getActiveTerminalId: () => string;
  sendTerminalCwd: () => void;
  sendPrompt: (prompt: string) => Promise<void>;
}

function focusSidebarIfConfigured(
  provider: TerminalProvider | undefined,
): void {
  const config = vscode.workspace.getConfiguration("opencode-cli-sidebar");
  if (config.get<boolean>("autoFocusOnSend", true)) {
    vscode.commands.executeCommand("opencode-cli-sidebar.focus");
    setTimeout(() => {
      provider?.focus();
    }, 100);
  }
}

type FileSendScheduler = (
  deps: TerminalCommandDependencies,
  uris: vscode.Uri[],
) => void;

/**
 * Creates a scheduler that batches file-reference sends: URIs from a
 * multi-select invocation are accumulated and deduplicated by fsPath, then
 * flushed through `deps.sendPrompt` after a 100ms debounce. Each scheduler
 * keeps its own accumulator so commands with different reference formats
 * never mix batches.
 */
function createFileSendScheduler(
  diagLabel: string,
  formatReference: (provider: TerminalProvider, uri: vscode.Uri) => string,
): FileSendScheduler {
  let accumulator: vscode.Uri[] = [];
  let timeout: NodeJS.Timeout | undefined;

  return (deps, uris) => {
    accumulator.push(...uris);

    if (timeout) {
      clearTimeout(timeout);
    }

    timeout = setTimeout(() => {
      if (accumulator.length === 0) {
        return;
      }

      const provider = deps.provider;
      if (!provider) {
        accumulator = [];
        return;
      }

      const uniqueUris = [
        ...new Map(
          accumulator.map((u: vscode.Uri) => [u.fsPath, u]),
        ).values(),
      ];

      const fileRefs = uniqueUris.map((u: vscode.Uri) =>
        formatReference(provider, u),
      );
      const allRefs = fileRefs.join(" ");

      const terminalId = deps.getActiveTerminalId();
      deps.outputChannel?.info(
        `[DIAG:${diagLabel}] terminalId="${terminalId}" fileCount=${uniqueUris.length} refs="${allRefs}"`,
      );
      void deps.sendPrompt(allRefs + " ");

      focusSidebarIfConfigured(deps.provider);
      accumulator = [];
    }, 100);
  };
}

const scheduleRelativeReferenceSend = createFileSendScheduler(
  "sendToOpencode",
  (provider, uri) => provider.formatUriReference(uri),
);

const scheduleAbsoluteReferenceSend = createFileSendScheduler(
  "sendAbsoluteToOpencode",
  (provider, uri) =>
    provider.formatFileReference({ path: toAbsoluteReference(uri) }),
);

const LEGACY_EXTENSION_ID = "sagez.ai-sidebar-terminal";

/**
 * The pre-rebrand extension still registers every legacy command ID when it
 * is installed. Registering the aliases as well makes one of the two
 * extensions fail activation with "command already exists", so leave the
 * IDs to the legacy extension and only alias them when it is absent.
 */
function isLegacyExtensionInstalled(): boolean {
  return vscode.extensions.getExtension(LEGACY_EXTENSION_ID) !== undefined;
}

/**
 * Command IDs of the pre-rebrand `ai-sidebar-terminal` extension, mapped to
 * their current equivalents. VS Code persists customized user keybindings by
 * literal command ID, so entries pointing at the old IDs survive uninstalling
 * the old extension and then surface as "command 'ai-sidebar-terminal.x' not
 * found" while shadowing the new default keybindings. Registering the legacy
 * IDs as aliases keeps those stale keybindings functional; because the IDs
 * are not declared in `contributes.commands`, they never appear in the
 * Command Palette.
 */
const LEGACY_COMMAND_ALIASES: Readonly<Record<string, string>> = {
  "ai-sidebar-terminal.start": "opencode-cli-sidebar.start",
  "ai-sidebar-terminal.focus": "opencode-cli-sidebar.focus",
  "ai-sidebar-terminal.sendToTerminal": "opencode-cli-sidebar.sendToTerminal",
  "ai-sidebar-terminal.sendAtMention": "opencode-cli-sidebar.sendAtMention",
  "ai-sidebar-terminal.sendAllOpenFiles":
    "opencode-cli-sidebar.sendAllOpenFiles",
  "ai-sidebar-terminal.sendToAiTerminal": "opencode-cli-sidebar.sendToOpencode",
  "ai-sidebar-terminal.sendAbsoluteToAiTerminal":
    "opencode-cli-sidebar.sendAbsoluteToOpencode",
  "ai-sidebar-terminal.paste": "opencode-cli-sidebar.paste",
  "ai-sidebar-terminal.checkOpenCodeUpdates":
    "opencode-cli-sidebar.checkOpenCodeUpdates",
};

export function registerTerminalCommands(
  deps: TerminalCommandDependencies,
): vscode.Disposable[] {
  const startCommand = vscode.commands.registerCommand(
    "opencode-cli-sidebar.start",
    () => {
      deps.provider?.startOpenCode();
    },
  );

  const sendToTerminalCommand = vscode.commands.registerCommand(
    "opencode-cli-sidebar.sendToTerminal",
    () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        return;
      }

      const selectedText = editor.document.getText(editor.selection);
      const terminalId = deps.getActiveTerminalId();
      deps.outputChannel?.info(
        `[DIAG:sendToTerminal] terminalId="${terminalId}" textLength=${selectedText.length}`,
      );
      void deps.sendPrompt(selectedText + "\n");
      focusSidebarIfConfigured(deps.provider);
    },
  );

  const sendAtMentionCommand = vscode.commands.registerCommand(
    "opencode-cli-sidebar.sendAtMention",
    () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        deps.outputChannel?.warn("[DIAG:sendAtMention] skipped — editor missing");
        deps.sendTerminalCwd();
        return;
      }

      const fileRef = deps.provider?.formatEditorReference(editor);
      if (!fileRef) {
        deps.outputChannel?.warn(
          `[DIAG:sendAtMention] skipped — provider=${!!deps.provider}`,
        );
        deps.sendTerminalCwd();
        return;
      }

      const terminalId = deps.getActiveTerminalId();
      deps.outputChannel?.info(
        `[DIAG:sendAtMention] terminalId="${terminalId}" fileRef="${fileRef}"`,
      );
      void deps.sendPrompt(fileRef + " ");
      focusSidebarIfConfigured(deps.provider);
    },
  );

  const sendAllOpenFilesCommand = vscode.commands.registerCommand(
    "opencode-cli-sidebar.sendAllOpenFiles",
    () => {
      const fileRefs: string[] = [];

      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (tab.input instanceof vscode.TabInputText) {
            const uri = tab.input.uri;
            if (!uri.scheme.startsWith("untitled") && deps.provider) {
              fileRefs.push(deps.provider.formatUriReference(uri));
            }
          }
        }
      }

      const openFiles = fileRefs.join(" ");
      if (openFiles) {
        const terminalId = deps.getActiveTerminalId();
        deps.outputChannel?.info(
          `[DIAG:sendAllOpenFiles] terminalId="${terminalId}" fileCount=${fileRefs.length} refs="${openFiles}"`,
        );
        void deps.sendPrompt(openFiles + " ");
        focusSidebarIfConfigured(deps.provider);
      }
    },
  );

  const sendToOpencodeCommand = vscode.commands.registerCommand(
    "opencode-cli-sidebar.sendToOpencode",
    (...args: unknown[]) => {
      if (!deps.contextSharingService) {
        return;
      }

      const uris = extractUrisFromSendArgs(args);
      if (uris.length === 0) {
        return;
      }

      scheduleRelativeReferenceSend(deps, uris);
    },
  );

  // Explorer companion to `sendToOpencode` that sends absolute-path
  // references instead of workspace-relative ones. Shares the argument
  // extraction and the 100ms multi-select batching behaviour.
  const sendAbsoluteToOpencodeCommand = vscode.commands.registerCommand(
    "opencode-cli-sidebar.sendAbsoluteToOpencode",
    (...args: unknown[]) => {
      if (!deps.contextSharingService) {
        return;
      }

      const uris = extractUrisFromSendArgs(args);
      if (uris.length === 0) {
        return;
      }

      scheduleAbsoluteReferenceSend(deps, uris);
    },
  );

  const pasteCommand = vscode.commands.registerCommand(
    "opencode-cli-sidebar.paste",
    async () => {
      try {
        if (deps.provider) {
          deps.provider.requestPaste();
        }
      } catch (error) {
        deps.outputChannel?.error(
          `[TerminalProvider] Failed to paste: ${error instanceof Error ? error.message : String(error)}`,
        );
        vscode.window.showErrorMessage(l10n.t("Failed to paste from clipboard"));
      }
    },
  );

  const focusCommand = vscode.commands.registerCommand(
    "opencode-cli-sidebar.focus",
    () => {
      return vscode.commands.executeCommand(
        "workbench.view.focus",
        "opencode-cli-sidebar-view",
      );
    },
  );

  const checkOpenCodeUpdatesCommand = vscode.commands.registerCommand(
    "opencode-cli-sidebar.checkOpenCodeUpdates",
    async () => {
      const updateService = deps.opencodeUpdateService;
      if (!updateService) {
        return;
      }
      try {
        const result = await updateService.checkForUpdates({ manual: true });
        if (!result.ok) {
          if (result.error?.includes("in progress")) {
            vscode.window.showInformationMessage(
              l10n.t('An OpenCode install is already in progress.'),
            );
          } else {
            vscode.window.showWarningMessage(
              l10n.t('Could not check for updates. Check your network connection and try again.'),
            );
          }
          return;
        }
        if (result.state === "available") {
          vscode.window.showInformationMessage(
            l10n.t('New OpenCode version {latest} is available (current {current})', {
              latest: result.latest ?? "",
              current: result.current ?? "",
            }),
          );
          return;
        }
        if (result.state === "upToDate") {
          vscode.window.showInformationMessage(
            l10n.t('Already up to date: {0}', result.latest ?? ""),
          );
          return;
        }
        if (result.state === "disabled") {
          vscode.window.showInformationMessage(
            l10n.t('Updates require OpenCode v2'),
          );
        }
      } catch (error) {
        deps.outputChannel?.error(
          `[OpenCodeUpdateService] check command failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        vscode.window.showWarningMessage(
          l10n.t('Could not check for updates. Check your network connection and try again.'),
        );
      }
    },
  );

  const legacyExtensionInstalled = isLegacyExtensionInstalled();
  if (legacyExtensionInstalled) {
    deps.outputChannel?.warn(
      `[TerminalCommands] ${LEGACY_EXTENSION_ID} is installed; skipping legacy command aliases to avoid duplicate registration. Uninstall it to route old keybindings to this extension.`,
    );
  }
  const legacyAliasCommands = legacyExtensionInstalled
    ? []
    : Object.entries(LEGACY_COMMAND_ALIASES).map(
        ([legacyId, currentId]) =>
          vscode.commands.registerCommand(legacyId, (...args: unknown[]) =>
            vscode.commands.executeCommand(currentId, ...args),
          ),
      );

  return [
    startCommand,
    sendToTerminalCommand,
    sendAtMentionCommand,
    sendAllOpenFilesCommand,
    sendToOpencodeCommand,
    sendAbsoluteToOpencodeCommand,
    pasteCommand,
    focusCommand,
    checkOpenCodeUpdatesCommand,
    ...legacyAliasCommands,
  ];
}

