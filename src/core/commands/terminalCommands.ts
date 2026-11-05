import * as vscode from "vscode";
import { l10n } from "../../i18n";
import type { TerminalProvider } from "../../providers/TerminalProvider";
import { toAbsoluteReference } from "../../providers/relativeReference";
import type { EditorMentionPayload } from "../../services/ideContext/protocol";
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
 * to `opencode-cli-sidebar.sendToOpencode` across its menu locations:
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
  /**
   * Pushes `at_mentioned` payloads to connected OpenCode TUIs over the
   * editor-context WebSocket so the files land in the TUI composer as real
   * attachments instead of typed `@path` text. Delivers all payloads or
   * none; `false` means the channel is unavailable (server not running, no
   * connected TUI, or another extension owns the channel) and callers must
   * fall back to the terminal text path.
   */
  sendFileMentions?: (payloads: EditorMentionPayload[]) => boolean;
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
 * flushed through `flush` after a 100ms debounce. Each scheduler keeps its
 * own accumulator so commands with different flush behaviour never mix
 * batches.
 */
function createFileSendScheduler(
  flush: (deps: TerminalCommandDependencies, uris: vscode.Uri[]) => void,
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

      flush(deps, accumulator);
      accumulator = [];
    }, 100);
  };
}

/**
 * Whole-file / directory mention payload.
 *
 * `(0, 0)` is a "no line range" sentinel: the TUI renders a cosmetic `#0`
 * suffix, and the server's `positiveInt` validation drops `?start=0` from
 * the attachment URI, so the attachment is always the complete file (or,
 * for directories, the server-generated sorted listing).
 */
function wholeFileMention(uri: vscode.Uri): EditorMentionPayload {
  return { filePath: toAbsoluteReference(uri), lineStart: 0, lineEnd: 0 };
}

/**
 * Delivers file references to the OpenCode TUI composer as `at_mentioned`
 * attachments, falling back to typed `@path` text over the terminal
 * whenever the mention channel is unavailable. Files and directories ride
 * the same channel; whole-file and directory payloads carry the `(0, 0)`
 * no-range sentinel.
 */
function sendUrisToOpencode(
  deps: TerminalCommandDependencies,
  uris: vscode.Uri[],
): void {
  const provider = deps.provider;
  if (!provider) {
    return;
  }

  const uniqueUris = [
    ...new Map(uris.map((u: vscode.Uri) => [u.fsPath, u])).values(),
  ];

  const textRefs: string[] = [];
  let mentionsDelivered = false;
  if (deps.sendFileMentions) {
    const payloads = uniqueUris.map((u) => wholeFileMention(u));
    mentionsDelivered = deps.sendFileMentions(payloads);
    if (mentionsDelivered) {
      deps.outputChannel?.info(
        `[DIAG:sendToOpencode] mention fileCount=${payloads.length} ranges="${payloads
          .map((p) => `${p.filePath}#${p.lineStart}-${p.lineEnd}`)
          .join(" ")}"`,
      );
    } else {
      deps.outputChannel?.info(
        "[DIAG:sendToOpencode] mention channel unavailable, falling back to terminal text",
      );
    }
  }

  if (!mentionsDelivered) {
    textRefs.push(...uniqueUris.map((u) => provider.formatUriReference(u)));
  }

  if (textRefs.length > 0) {
    const allRefs = textRefs.join(" ");
    const terminalId = deps.getActiveTerminalId();
    deps.outputChannel?.info(
      `[DIAG:sendToOpencode] terminalId="${terminalId}" fileCount=${textRefs.length} refs="${allRefs}"`,
    );
    void deps.sendPrompt(allRefs + " ");
  }

  focusSidebarIfConfigured(provider);
}

const scheduleRelativeReferenceSend = createFileSendScheduler(
  sendUrisToOpencode,
);

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

      // Selection ranges ride the mention channel as exact line ranges.
      // A single-line selection collapses to an open range (line N through
      // EOF) in the TUI — the protocol's native behavior.
      const selection = editor.selection;
      const payload = selection.isEmpty
        ? wholeFileMention(editor.document.uri)
        : {
            filePath: toAbsoluteReference(editor.document.uri),
            lineStart: selection.start.line + 1,
            lineEnd: selection.end.line + 1,
          };

      if (deps.sendFileMentions?.([payload])) {
        deps.outputChannel?.info(
          `[DIAG:sendAtMention] mention file="${payload.filePath}#${payload.lineStart}-${payload.lineEnd}"`,
        );
        focusSidebarIfConfigured(deps.provider);
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
      const provider = deps.provider;
      if (!provider) {
        return;
      }

      const openUris: vscode.Uri[] = [];
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (
            tab.input instanceof vscode.TabInputText &&
            !tab.input.uri.scheme.startsWith("untitled")
          ) {
            openUris.push(tab.input.uri);
          }
        }
      }
      if (openUris.length === 0) {
        return;
      }

      if (deps.sendFileMentions?.(openUris.map((uri) => wholeFileMention(uri)))) {
        deps.outputChannel?.info(
          `[DIAG:sendAllOpenFiles] mention fileCount=${openUris.length}`,
        );
        focusSidebarIfConfigured(provider);
        return;
      }

      const openFiles = openUris
        .map((uri) => provider.formatUriReference(uri))
        .join(" ");
      const terminalId = deps.getActiveTerminalId();
      deps.outputChannel?.info(
        `[DIAG:sendAllOpenFiles] terminalId="${terminalId}" fileCount=${openUris.length} refs="${openFiles}"`,
      );
      void deps.sendPrompt(openFiles + " ");
      focusSidebarIfConfigured(provider);
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

  const legacyAliasCommands = Object.entries(LEGACY_COMMAND_ALIASES).map(
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
    pasteCommand,
    focusCommand,
    checkOpenCodeUpdatesCommand,
    ...legacyAliasCommands,
  ];
}

