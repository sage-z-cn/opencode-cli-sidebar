import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import type * as vscodeTypes from "../../test/mocks/vscode";
import { registerTerminalCommands } from "./terminalCommands";
import type { TerminalCommandDependencies } from "./terminalCommands";
import type { TerminalProvider } from "../../providers/TerminalProvider";
import type { OpenCodeUpdateService } from "../../services/OpenCodeUpdateService";
import type { OutputChannelService } from "../../services/OutputChannelService";
import type { OpenCodeFileReference } from "../../services/aiTools/OpenCodeToolOperator";

const vscode = await vi.importActual<typeof vscodeTypes>(
  "../../test/mocks/vscode",
);

vi.mock("vscode", async () => {
  const actual = await vi.importActual("../../test/mocks/vscode");
  return actual;
});

vi.mock("fs", () => ({
  statSync: vi.fn(),
}));

type CommandCallback = (...args: unknown[]) => unknown;

type ProviderMock = Pick<
  TerminalProvider,
  | "startOpenCode"
  | "focus"
  | "formatEditorReference"
  | "formatUriReference"
  | "formatFileReference"
  | "requestPaste"
  | "pasteText"
>;

type OutputChannelMock = Pick<OutputChannelService, "info" | "warn" | "error">;

function createProviderMock(): ProviderMock {
  return {
    startOpenCode: vi.fn(),
    focus: vi.fn(),
    formatEditorReference: vi.fn(),
    formatUriReference: vi.fn((uri) => `@${uri.fsPath}`),
    formatFileReference: vi.fn(
      (reference: OpenCodeFileReference) => `@${reference.path}`,
    ),
    requestPaste: vi.fn(),
    pasteText: vi.fn(),
  };
}

function createOutputChannelMock(): OutputChannelMock {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function mockAutoFocusOnSend(enabled: boolean): void {
  const configuration = {
    get: vi.fn((key: string, defaultValue?: unknown) => {
      if (key === "autoFocusOnSend") {
        return enabled;
      }
      return defaultValue;
    }),
    inspect: vi.fn(() => undefined),
    update: vi.fn(),
  };

  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(configuration);
}

function createDependencies(
  overrides: Partial<TerminalCommandDependencies> = {},
): TerminalCommandDependencies {
  const provider = createProviderMock();
  const outputChannel = createOutputChannelMock();

  return {
    provider: provider as unknown as TerminalProvider,
    terminalManager: undefined,
    contextSharingService:
      {} as TerminalCommandDependencies["contextSharingService"],
    outputChannel: outputChannel as unknown as OutputChannelService,
    opencodeUpdateService: undefined,
    getActiveTerminalId: vi.fn(() => "terminal-1"),
    sendTerminalCwd: vi.fn(),
    sendPrompt: vi.fn(async () => undefined),
    ...overrides,
  };
}

function registerAndGetCommands(
  deps: TerminalCommandDependencies,
): Map<string, CommandCallback> {
  registerTerminalCommands(deps);

  return new Map(
    vi
      .mocked(vscode.commands.registerCommand)
      .mock.calls.map(([id, callback]) => [id, callback as CommandCallback]),
  );
}

function getCommand(
  commands: Map<string, CommandCallback>,
  id: string,
): CommandCallback {
  const command = commands.get(id);

  if (!command) {
    throw new Error(`Missing registered command: ${id}`);
  }

  return command;
}

describe("registerTerminalCommands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockAutoFocusOnSend(true);
    vscode.window.activeTextEditor = undefined;
    vscode.window.tabGroups.all = [];
    // toAbsoluteReference stats real paths; force ENOENT so every reference
    // is treated as a plain file regardless of the host filesystem.
    vi.mocked(fs.statSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("registers all 9 terminal commands", () => {
    const commands = registerAndGetCommands(createDependencies());

    expect(Array.from(commands.keys())).toEqual(
      expect.arrayContaining([
        "opencode-cli-sidebar.start",
        "opencode-cli-sidebar.sendToTerminal",
        "opencode-cli-sidebar.sendAtMention",
        "opencode-cli-sidebar.sendAllOpenFiles",
        "opencode-cli-sidebar.sendToOpencode",
        "opencode-cli-sidebar.sendAbsoluteToOpencode",
        "opencode-cli-sidebar.paste",
        "opencode-cli-sidebar.focus",
        "opencode-cli-sidebar.checkOpenCodeUpdates",
      ]),
    );
    expect(commands.size).toBe(18);
  });

  it("skips legacy aliases while the pre-rebrand extension is installed", () => {
    vi.mocked(vscode.extensions.getExtension).mockReturnValue({} as never);
    const outputChannel = createOutputChannelMock();
    const commands = registerAndGetCommands(
      createDependencies({
        outputChannel: outputChannel as unknown as OutputChannelService,
      }),
    );

    expect(commands.has("ai-sidebar-terminal.start")).toBe(false);
    expect(commands.size).toBe(9);
    expect(outputChannel.warn).toHaveBeenCalledWith(
      expect.stringContaining("sagez.ai-sidebar-terminal"),
    );
  });

  it("registers legacy ai-sidebar-terminal aliases for all old command IDs", () => {
    const commands = registerAndGetCommands(createDependencies());

    expect(Array.from(commands.keys())).toEqual(
      expect.arrayContaining([
        "ai-sidebar-terminal.start",
        "ai-sidebar-terminal.focus",
        "ai-sidebar-terminal.sendToTerminal",
        "ai-sidebar-terminal.sendAtMention",
        "ai-sidebar-terminal.sendAllOpenFiles",
        "ai-sidebar-terminal.sendToAiTerminal",
        "ai-sidebar-terminal.sendAbsoluteToAiTerminal",
        "ai-sidebar-terminal.paste",
        "ai-sidebar-terminal.checkOpenCodeUpdates",
      ]),
    );
  });

  it("forwards legacy alias invocations to the current command", () => {
    const deps = createDependencies();
    const commands = registerAndGetCommands(deps);
    vi.mocked(vscode.commands.executeCommand).mockClear();

    getCommand(commands, "ai-sidebar-terminal.sendAtMention")();

    expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(1);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "opencode-cli-sidebar.sendAtMention",
    );

    getCommand(commands, "ai-sidebar-terminal.sendToAiTerminal")(
      "uri-or-context-arg",
    );

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "opencode-cli-sidebar.sendToOpencode",
      "uri-or-context-arg",
    );
  });

  it("starts OpenCode from the start command", () => {
    const deps = createDependencies();
    const commands = registerAndGetCommands(deps);

    getCommand(commands, "opencode-cli-sidebar.start")();

    expect(deps.provider?.startOpenCode).toHaveBeenCalledTimes(1);
  });

  it("sends selected editor text to the terminal and focuses when enabled", () => {
    const deps = createDependencies();
    const document = new vscode.TextDocument(
      vscode.Uri.file("/workspace/file.ts"),
      "selected text",
    );
    const selection = new vscode.Selection(0, 0, 0, 4);
    const editor = new vscode.TextEditor(document, selection);
    vscode.window.activeTextEditor = editor;

    const commands = registerAndGetCommands(deps);
    getCommand(commands, "opencode-cli-sidebar.sendToTerminal")();

    expect(document.getText).toHaveBeenCalledWith(selection);
    expect(deps.getActiveTerminalId).toHaveBeenCalledTimes(1);
    expect(deps.outputChannel?.info).toHaveBeenCalledWith(
      '[DIAG:sendToTerminal] terminalId="terminal-1" textLength=13',
    );
    expect(deps.sendPrompt).toHaveBeenCalledWith("selected text\n");
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "opencode-cli-sidebar.focus",
    );

    vi.advanceTimersByTime(100);

    expect(deps.provider?.focus).toHaveBeenCalledTimes(1);
  });

  it("does not send selected text when there is no editor or selection", () => {
    const noEditorDeps = createDependencies();
    const noEditorCommands = registerAndGetCommands(noEditorDeps);

    getCommand(noEditorCommands, "opencode-cli-sidebar.sendToTerminal")();

    expect(noEditorDeps.sendPrompt).not.toHaveBeenCalled();
    expect(noEditorDeps.outputChannel?.info).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockAutoFocusOnSend(true);

    const emptySelectionDeps = createDependencies();
    const document = new vscode.TextDocument(
      vscode.Uri.file("/workspace/file.ts"),
      "ignored",
    );
    const emptySelection = new vscode.Selection(0, 0, 0, 0);
    vscode.window.activeTextEditor = new vscode.TextEditor(
      document,
      emptySelection,
    );

    const emptySelectionCommands = registerAndGetCommands(emptySelectionDeps);
    getCommand(emptySelectionCommands, "opencode-cli-sidebar.sendToTerminal")();

    expect(emptySelectionDeps.sendPrompt).not.toHaveBeenCalled();
    expect(emptySelectionDeps.outputChannel?.info).not.toHaveBeenCalled();
  });

  it("skips focus after sending selected text when autoFocusOnSend is disabled", () => {
    mockAutoFocusOnSend(false);

    const deps = createDependencies();
    const document = new vscode.TextDocument(
      vscode.Uri.file("/workspace/file.ts"),
      "text",
    );
    const selection = new vscode.Selection(0, 0, 0, 2);
    vscode.window.activeTextEditor = new vscode.TextEditor(document, selection);

    const commands = registerAndGetCommands(deps);
    getCommand(commands, "opencode-cli-sidebar.sendToTerminal")();

    expect(deps.sendPrompt).toHaveBeenCalledWith("text\n");
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
      "opencode-cli-sidebar.focus",
    );

    vi.runAllTimers();

    expect(deps.provider?.focus).not.toHaveBeenCalled();
  });

  it("sends editor references and falls back to cwd when @mention cannot be created", () => {
    const document = new vscode.TextDocument(
      vscode.Uri.file("/workspace/file.ts"),
      "content",
    );
    const selection = new vscode.Selection(0, 0, 0, 1);
    const editor = new vscode.TextEditor(document, selection);

    const successDeps = createDependencies();
    vi.mocked(successDeps.provider!.formatEditorReference).mockReturnValue(
      "@src/file.ts#L1",
    );
    vscode.window.activeTextEditor = editor;

    const successCommands = registerAndGetCommands(successDeps);
    getCommand(successCommands, "opencode-cli-sidebar.sendAtMention")();

    expect(successDeps.outputChannel?.info).toHaveBeenCalledWith(
      '[DIAG:sendAtMention] terminalId="terminal-1" fileRef="@src/file.ts#L1"',
    );
    expect(successDeps.sendPrompt).toHaveBeenCalledWith("@src/file.ts#L1 ");

    vi.advanceTimersByTime(100);

    expect(successDeps.provider?.focus).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    mockAutoFocusOnSend(true);

    const noProviderDeps = createDependencies({ provider: undefined });
    vscode.window.activeTextEditor = editor;
    const noProviderCommands = registerAndGetCommands(noProviderDeps);

    getCommand(noProviderCommands, "opencode-cli-sidebar.sendAtMention")();

    expect(noProviderDeps.outputChannel?.warn).toHaveBeenCalledWith(
      "[DIAG:sendAtMention] skipped — provider=false",
    );
    expect(noProviderDeps.sendTerminalCwd).toHaveBeenCalledTimes(1);
    expect(noProviderDeps.sendPrompt).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockAutoFocusOnSend(true);

    const noEditorDeps = createDependencies();
    vscode.window.activeTextEditor = undefined;
    const noEditorCommands = registerAndGetCommands(noEditorDeps);

    getCommand(noEditorCommands, "opencode-cli-sidebar.sendAtMention")();

    expect(noEditorDeps.outputChannel?.warn).toHaveBeenCalledWith(
      "[DIAG:sendAtMention] skipped — editor missing",
    );
    expect(noEditorDeps.sendTerminalCwd).toHaveBeenCalledTimes(1);
    expect(noEditorDeps.sendPrompt).not.toHaveBeenCalled();
  });

  it("sends all open file references while filtering unsupported tabs", () => {
    const deps = createDependencies();
    const fileUri = vscode.Uri.parse("file:///workspace/a.ts");
    const untitledUri = vscode.Uri.parse("untitled:///scratch.ts");
    const secondFileUri = vscode.Uri.parse("file:///workspace/b.ts");

    vi.mocked(deps.provider!.formatUriReference)
      .mockReturnValueOnce("@workspace/a.ts")
      .mockReturnValueOnce("@workspace/b.ts");

    vscode.window.tabGroups.all = [
      {
        tabs: [
          { input: new vscode.TabInputText(fileUri) },
          { input: new vscode.TabInputText(untitledUri) },
          { input: { uri: secondFileUri } },
        ],
      },
      {
        tabs: [{ input: new vscode.TabInputText(secondFileUri) }],
      },
    ];

    const commands = registerAndGetCommands(deps);
    getCommand(commands, "opencode-cli-sidebar.sendAllOpenFiles")();

    expect(deps.provider?.formatUriReference).toHaveBeenCalledTimes(2);
    expect(deps.outputChannel?.info).toHaveBeenCalledWith(
      '[DIAG:sendAllOpenFiles] terminalId="terminal-1" fileCount=2 refs="@workspace/a.ts @workspace/b.ts"',
    );
    expect(deps.sendPrompt).toHaveBeenCalledWith(
      "@workspace/a.ts @workspace/b.ts ",
    );

    vi.advanceTimersByTime(100);

    expect(deps.provider?.focus).toHaveBeenCalledTimes(1);
  });

  it("does not send all open files when no supported file refs exist", () => {
    const deps = createDependencies();
    vscode.window.tabGroups.all = [
      {
        tabs: [
          { input: new vscode.TabInputText(vscode.Uri.parse("untitled:///scratch.ts")) },
          { input: { uri: vscode.Uri.file("/workspace/not-tab-input.ts") } },
        ],
      },
    ];

    const commands = registerAndGetCommands(deps);
    getCommand(commands, "opencode-cli-sidebar.sendAllOpenFiles")();

    expect(deps.sendPrompt).not.toHaveBeenCalled();
    expect(deps.getActiveTerminalId).not.toHaveBeenCalled();
  });

  it("deduplicates queued file references and debounces prompt sending", () => {
    const deps = createDependencies();
    const firstUri = vscode.Uri.file("/workspace/a.ts");
    const duplicateUri = vscode.Uri.file("/workspace/a.ts");
    const secondUri = vscode.Uri.file("/workspace/b.ts");

    vi.mocked(deps.provider!.formatUriReference)
      .mockReturnValueOnce("@workspace/a.ts")
      .mockReturnValueOnce("@workspace/b.ts");

    const commands = registerAndGetCommands(deps);
    const sendToOpencode = getCommand(
      commands,
      "opencode-cli-sidebar.sendToOpencode",
    );

    sendToOpencode("ignored", [firstUri]);
    sendToOpencode("ignored", [duplicateUri, secondUri]);

    expect(deps.sendPrompt).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);

    expect(deps.provider?.formatUriReference).toHaveBeenCalledTimes(2);
    expect(deps.outputChannel?.info).toHaveBeenCalledWith(
      '[DIAG:sendToOpencode] terminalId="terminal-1" fileCount=2 refs="@workspace/a.ts @workspace/b.ts"',
    );
    expect(deps.sendPrompt).toHaveBeenCalledTimes(1);
    expect(deps.sendPrompt).toHaveBeenCalledWith(
      "@workspace/a.ts @workspace/b.ts ",
    );

    vi.advanceTimersByTime(100);

    expect(deps.provider?.focus).toHaveBeenCalledTimes(1);
  });

  it("ignores file sends without context sharing or usable uri arguments", () => {
    const noContextDeps = createDependencies({ contextSharingService: undefined });
    const noContextCommands = registerAndGetCommands(noContextDeps);
    getCommand(noContextCommands, "opencode-cli-sidebar.sendToOpencode")(
      vscode.Uri.file("/workspace/a.ts"),
    );
    vi.advanceTimersByTime(100);

    expect(noContextDeps.sendPrompt).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockAutoFocusOnSend(true);

    const invalidArgsDeps = createDependencies();
    const invalidArgsCommands = registerAndGetCommands(invalidArgsDeps);
    getCommand(invalidArgsCommands, "opencode-cli-sidebar.sendToOpencode")("ignored");
    getCommand(invalidArgsCommands, "opencode-cli-sidebar.sendToOpencode")();
    vi.advanceTimersByTime(100);

    expect(invalidArgsDeps.sendPrompt).not.toHaveBeenCalled();
  });

  it("accepts a direct uri argument for file sends", () => {
    const deps = createDependencies();
    vi.mocked(deps.provider!.formatUriReference).mockReturnValueOnce(
      "@workspace/direct.ts",
    );
    const commands = registerAndGetCommands(deps);

    getCommand(commands, "opencode-cli-sidebar.sendToOpencode")(
      vscode.Uri.file("/workspace/direct.ts"),
    );
    vi.advanceTimersByTime(100);

    expect(deps.provider?.formatUriReference).toHaveBeenCalledTimes(1);
    expect(deps.sendPrompt).toHaveBeenCalledWith("@workspace/direct.ts ");
  });

  it("ignores empty file send batches after the debounce fires", () => {
    const deps = createDependencies();
    const commands = registerAndGetCommands(deps);

    getCommand(commands, "opencode-cli-sidebar.sendToOpencode")([]);
    vi.advanceTimersByTime(100);

    expect(deps.provider?.formatUriReference).not.toHaveBeenCalled();
    expect(deps.sendPrompt).not.toHaveBeenCalled();
  });

  it("falls back to the active editor uri for editor/title/context tab args", () => {
    const deps = createDependencies();
    const document = new vscode.TextDocument(
      vscode.Uri.file("/workspace/from-tab.ts"),
      "",
    );
    const editor = new vscode.TextEditor(
      document,
      new vscode.Selection(0, 0, 0, 0),
    );
    vscode.window.activeTextEditor = editor;
    vi.mocked(deps.provider!.formatUriReference).mockReturnValueOnce(
      "@workspace/from-tab.ts",
    );

    const commands = registerAndGetCommands(deps);
    // VS Code passes an IEditorCommandsContext ({ groupId, editorIndex })
    // when the command is invoked from editor/title/context.
    getCommand(commands, "opencode-cli-sidebar.sendToOpencode")({
      groupId: 3,
      editorIndex: 1,
    });
    vi.advanceTimersByTime(100);

    expect(deps.provider?.formatUriReference).toHaveBeenCalledTimes(1);
    expect(deps.provider?.formatUriReference).toHaveBeenCalledWith(
      vscode.Uri.file("/workspace/from-tab.ts"),
    );
    expect(deps.sendPrompt).toHaveBeenCalledWith("@workspace/from-tab.ts ");
  });

  it("skips editor/title/context sends when no active editor is available", () => {
    const deps = createDependencies();
    vscode.window.activeTextEditor = undefined;
    const commands = registerAndGetCommands(deps);

    getCommand(commands, "opencode-cli-sidebar.sendToOpencode")({
      groupId: 1,
      editorIndex: 0,
    });
    vi.advanceTimersByTime(100);

    expect(deps.provider?.formatUriReference).not.toHaveBeenCalled();
    expect(deps.sendPrompt).not.toHaveBeenCalled();
  });

  it("drops queued file references when provider is unavailable", () => {
    const deps = createDependencies({ provider: undefined });
    const commands = registerAndGetCommands(deps);
    const sendToOpencode = getCommand(
      commands,
      "opencode-cli-sidebar.sendToOpencode",
    );

    sendToOpencode("ignored", [vscode.Uri.file("/workspace/a.ts")]);
    vi.advanceTimersByTime(100);

    expect(deps.sendPrompt).not.toHaveBeenCalled();

    sendToOpencode("ignored", [vscode.Uri.file("/workspace/b.ts")]);
    vi.advanceTimersByTime(100);

    expect(deps.sendPrompt).not.toHaveBeenCalled();
    expect(deps.outputChannel?.info).not.toHaveBeenCalled();
  });

  it("sends absolute path references from explorer selections", () => {
    const deps = createDependencies();
    vi.mocked(deps.provider!.formatFileReference).mockImplementation(
      (reference: OpenCodeFileReference) => `@${reference.path}`,
    );
    const commands = registerAndGetCommands(deps);
    const sendAbsolute = getCommand(
      commands,
      "opencode-cli-sidebar.sendAbsoluteToOpencode",
    );

    sendAbsolute("ignored", [
      vscode.Uri.file("D:\\ws\\src\\file.ts"),
      vscode.Uri.file("D:\\ws\\src\\file.ts"),
    ]);

    expect(deps.sendPrompt).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);

    expect(deps.provider?.formatFileReference).toHaveBeenCalledTimes(1);
    expect(deps.provider?.formatFileReference).toHaveBeenCalledWith({
      path: "D:/ws/src/file.ts",
    });
    expect(deps.outputChannel?.info).toHaveBeenCalledWith(
      '[DIAG:sendAbsoluteToOpencode] terminalId="terminal-1" fileCount=1 refs="@D:/ws/src/file.ts"',
    );
    expect(deps.sendPrompt).toHaveBeenCalledTimes(1);
    expect(deps.sendPrompt).toHaveBeenCalledWith("@D:/ws/src/file.ts ");

    vi.advanceTimersByTime(100);

    expect(deps.provider?.focus).toHaveBeenCalledTimes(1);
  });

  it("keeps absolute sends independent from relative file send batches", () => {
    const deps = createDependencies();
    vi.mocked(deps.provider!.formatUriReference).mockReturnValueOnce(
      "@rel/a.ts",
    );
    vi.mocked(deps.provider!.formatFileReference).mockImplementationOnce(
      (reference: OpenCodeFileReference) => `@${reference.path}`,
    );
    const commands = registerAndGetCommands(deps);
    const sendToOpencode = getCommand(
      commands,
      "opencode-cli-sidebar.sendToOpencode",
    );
    const sendAbsolute = getCommand(
      commands,
      "opencode-cli-sidebar.sendAbsoluteToOpencode",
    );

    sendToOpencode("ignored", [vscode.Uri.file("D:\\ws\\a.ts")]);
    sendAbsolute("ignored", [vscode.Uri.file("D:\\ws\\b.ts")]);
    vi.advanceTimersByTime(100);

    expect(deps.provider?.formatUriReference).toHaveBeenCalledTimes(1);
    expect(deps.provider?.formatFileReference).toHaveBeenCalledTimes(1);
    expect(deps.sendPrompt).toHaveBeenCalledTimes(2);
    expect(deps.sendPrompt).toHaveBeenNthCalledWith(1, "@rel/a.ts ");
    expect(deps.sendPrompt).toHaveBeenNthCalledWith(2, "@D:/ws/b.ts ");
  });

  it("requests webview paste handling and reports provider failures", async () => {
    const successDeps = createDependencies();

    const successCommands = registerAndGetCommands(successDeps);
    await getCommand(successCommands, "opencode-cli-sidebar.paste")();

    expect(successDeps.provider?.requestPaste).toHaveBeenCalledTimes(1);
    expect(successDeps.outputChannel?.error).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockAutoFocusOnSend(true);

    const errorDeps = createDependencies();
    vi.mocked(errorDeps.provider!.requestPaste).mockImplementationOnce(() => {
      throw new Error("webview unavailable");
    });

    const errorCommands = registerAndGetCommands(errorDeps);
    await getCommand(errorCommands, "opencode-cli-sidebar.paste")();

    expect(errorDeps.outputChannel?.error).toHaveBeenCalledWith(
      "[TerminalProvider] Failed to paste: webview unavailable",
    );
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "Failed to paste from clipboard",
    );

    vi.clearAllMocks();
    mockAutoFocusOnSend(true);

    const noProviderDeps = createDependencies({ provider: undefined });
    const noProviderCommands = registerAndGetCommands(noProviderDeps);
    await getCommand(noProviderCommands, "opencode-cli-sidebar.paste")();

    expect(noProviderDeps.outputChannel?.error).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockAutoFocusOnSend(true);

    const stringErrorDeps = createDependencies();
    vi.mocked(stringErrorDeps.provider!.requestPaste).mockImplementationOnce(
      () => {
        throw "paste failed";
      },
    );

    const stringErrorCommands = registerAndGetCommands(stringErrorDeps);
    await getCommand(stringErrorCommands, "opencode-cli-sidebar.paste")();

    expect(stringErrorDeps.outputChannel?.error).toHaveBeenCalledWith(
      "[TerminalProvider] Failed to paste: paste failed",
    );
  });

  it("returns the executeCommand promise from opencode-cli-sidebar.focus", () => {
    const deps = createDependencies();
    const commands = registerAndGetCommands(deps);
    const focusCommand = getCommand(commands, "opencode-cli-sidebar.focus");

    vi.mocked(vscode.commands.executeCommand).mockResolvedValueOnce(true);

    const result = focusCommand();

    expect(result).toBeDefined();
    expect(result).toBe(vi.mocked(vscode.commands.executeCommand).mock.results[0]?.value);
    expect(result).toHaveProperty("then");
  });

  describe("checkOpenCodeUpdates command", () => {
    function createUpdateServiceMock(
      checkResult: unknown,
    ): OpenCodeUpdateService {
      return {
        checkForUpdates: vi.fn().mockResolvedValue(checkResult),
      } as unknown as OpenCodeUpdateService;
    }

    it("announces an available update with current and latest versions", async () => {
      const deps = createDependencies({
        opencodeUpdateService: createUpdateServiceMock({
          ok: true,
          state: "available",
          current: "2.0.6",
          latest: "2.0.7",
        }),
      });
      const commands = registerAndGetCommands(deps);

      await getCommand(commands, "opencode-cli-sidebar.checkOpenCodeUpdates")();

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        "New OpenCode version 2.0.7 is available (current 2.0.6)",
      );
    });

    it("announces up-to-date and disabled states as info", async () => {
      const upToDateDeps = createDependencies({
        opencodeUpdateService: createUpdateServiceMock({
          ok: true,
          state: "upToDate",
          current: "2.0.6",
          latest: "2.0.6",
        }),
      });
      await getCommand(
        registerAndGetCommands(upToDateDeps),
        "opencode-cli-sidebar.checkOpenCodeUpdates",
      )();
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        "Already up to date: 2.0.6",
      );

      vi.clearAllMocks();
      mockAutoFocusOnSend(true);

      const disabledDeps = createDependencies({
        opencodeUpdateService: createUpdateServiceMock({
          ok: true,
          state: "disabled",
        }),
      });
      await getCommand(
        registerAndGetCommands(disabledDeps),
        "opencode-cli-sidebar.checkOpenCodeUpdates",
      )();
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        "Updates require OpenCode v2",
      );
    });

    it("warns generically when the check fails or throws", async () => {
      const failedDeps = createDependencies({
        opencodeUpdateService: createUpdateServiceMock({
          ok: false,
          state: "idle",
          error: "github releases returned 404",
        }),
      });
      await getCommand(
        registerAndGetCommands(failedDeps),
        "opencode-cli-sidebar.checkOpenCodeUpdates",
      )();
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        "Could not check for updates. Check your network connection and try again.",
      );

      vi.clearAllMocks();
      mockAutoFocusOnSend(true);

      const throwingService = {
        checkForUpdates: vi.fn().mockRejectedValue(new Error("boom")),
      } as unknown as OpenCodeUpdateService;
      const throwingDeps = createDependencies({
        opencodeUpdateService: throwingService,
        outputChannel: createOutputChannelMock() as unknown as OutputChannelService,
      });
      await getCommand(
        registerAndGetCommands(throwingDeps),
        "opencode-cli-sidebar.checkOpenCodeUpdates",
      )();
      expect(throwingDeps.outputChannel?.error).toHaveBeenCalledWith(
        "[OpenCodeUpdateService] check command failed: boom",
      );
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        "Could not check for updates. Check your network connection and try again.",
      );
    });

    it("shows an info message when an install is already in progress", async () => {
      const deps = createDependencies({
        opencodeUpdateService: createUpdateServiceMock({
          ok: false,
          state: "updating",
          error: "update in progress",
        }),
      });
      await getCommand(
        registerAndGetCommands(deps),
        "opencode-cli-sidebar.checkOpenCodeUpdates",
      )();

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        "An OpenCode install is already in progress.",
      );
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it("is a no-op without the update service", async () => {
      const deps = createDependencies({ opencodeUpdateService: undefined });
      await getCommand(
        registerAndGetCommands(deps),
        "opencode-cli-sidebar.checkOpenCodeUpdates",
      )();

      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });
  });
});

