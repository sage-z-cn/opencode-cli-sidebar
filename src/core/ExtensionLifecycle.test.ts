import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { ExtensionLifecycle } from "./ExtensionLifecycle";
import { OpenCodeCliSettingsService } from "../services/OpenCodeCliSettingsService";
import { OutputCaptureManager } from "../services/OutputCaptureManager";
import { OutputChannelService } from "../services/OutputChannelService";
import { InstanceRegistry } from "../services/InstanceRegistry";
import { InstanceStore } from "../services/InstanceStore";
import { OpenCodeApiClient } from "../services/OpenCodeApiClient";
import { OpenCodeUpdateService } from "../services/OpenCodeUpdateService";
import {
  SETTINGS_MIGRATED_FLAG_KEY,
  SettingsMigrationService,
} from "../services/SettingsMigrationService";
import { TerminalProvider } from "../providers/TerminalProvider";
import type * as vscodeTypes from "../test/mocks/vscode";

const vscode = await vi.importActual<typeof vscodeTypes>(
  "../test/mocks/vscode",
);

vi.mock("vscode", async () => {
  const actual = await vi.importActual("../test/mocks/vscode");
  return actual;
});

vi.mock("node-pty", async () => {
  const actual = await vi.importActual("../test/mocks/node-pty");
  return actual;
});

describe("ExtensionLifecycle", () => {
  let lifecycle: ExtensionLifecycle;
  let mockContext: any;

  const getRegisteredCommandHandler = <T extends Function>(
    commandId: string,
  ): T => {
    const commandCall = vi
      .mocked(vscode.commands.registerCommand)
      .mock.calls.find((call) => call[0] === commandId);

    expect(commandCall).toBeDefined();
    return commandCall?.[1] as T;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.spyOn(
      OpenCodeCliSettingsService.prototype,
      "applyVsCodeTheme",
    ).mockResolvedValue(false);
    OutputChannelService.resetInstance();
    lifecycle = new ExtensionLifecycle();
    mockContext = new vscode.ExtensionContext();
  });

  // The activation check runs with zero delay, so every test that activated
  // a lifecycle must clear its timer before later tests' event-loop turns
  // fire the leaked callback on the shared prototype.
  afterEach(async () => {
    try {
      await lifecycle.deactivate();
    } catch {
      // best-effort cleanup between tests
    }
  });

  describe("activate", () => {
    it("should initialize terminal manager", async () => {
      await lifecycle.activate(mockContext);

      expect(mockContext.subscriptions.length).toBeGreaterThan(0);
    });

    it("applies the VS Code theme by default", async () => {
      const applyVsCodeTheme = vi.mocked(
        OpenCodeCliSettingsService.prototype.applyVsCodeTheme,
      );
      applyVsCodeTheme.mockResolvedValue(true);

      await lifecycle.activate(mockContext);

      expect(applyVsCodeTheme).toHaveBeenCalledTimes(1);
    });

    it("leaves OpenCode's theme alone when followVsCodeTheme is disabled", async () => {
      vi.mocked(vscode.workspace.getConfiguration).mockImplementation(
        (section: string) => {
          if (section === "opencode-cli-sidebar") {
            return {
              get: vi.fn((key: string, def: any) =>
                key === "followVsCodeTheme" ? false : def,
              ),
              inspect: vi.fn(() => undefined),
              update: vi.fn(),
            } as any;
          }
          return {
            get: vi.fn((_key: string, def: any) => def),
            inspect: vi.fn(() => undefined),
            update: vi.fn(),
          } as any;
        },
      );
      const applyVsCodeTheme = vi.mocked(
        OpenCodeCliSettingsService.prototype.applyVsCodeTheme,
      );

      await lifecycle.activate(mockContext);

      expect(applyVsCodeTheme).not.toHaveBeenCalled();
    });

    it("re-applies the VS Code theme when followVsCodeTheme is re-enabled", async () => {
      let followVsCodeTheme = false;
      const configuration = {
        get: vi.fn((key: string, def: any) =>
          key === "followVsCodeTheme" ? followVsCodeTheme : def,
        ),
        inspect: vi.fn(() => undefined),
        update: vi.fn(),
      };
      vi.mocked(vscode.workspace.getConfiguration).mockImplementation(
        (section: string) =>
          (section === "opencode-cli-sidebar"
            ? configuration
            : {
                get: vi.fn((_key: string, def: any) => def),
                inspect: vi.fn(() => undefined),
                update: vi.fn(),
              }) as any,
      );
      const applyVsCodeTheme = vi.mocked(
        OpenCodeCliSettingsService.prototype.applyVsCodeTheme,
      );

      await lifecycle.activate(mockContext);
      applyVsCodeTheme.mockClear();

      const listener = vi.mocked(vscode.workspace.onDidChangeConfiguration)
        .mock.calls[0]?.[0] as
        | ((event: {
            affectsConfiguration: (section: string) => boolean;
          }) => void)
        | undefined;
      expect(listener).toBeTypeOf("function");

      const event = {
        affectsConfiguration: (section: string) =>
          section === "opencode-cli-sidebar.followVsCodeTheme",
      };

      listener?.(event);
      await Promise.resolve();
      expect(applyVsCodeTheme).not.toHaveBeenCalled();

      followVsCodeTheme = true;
      listener?.(event);
      await vi.waitFor(() => {
        expect(applyVsCodeTheme).toHaveBeenCalledTimes(1);
      });
    });

    it("should register webview provider", async () => {
      await lifecycle.activate(mockContext);

      expect(vscode.window.registerWebviewViewProvider).toHaveBeenCalledWith(
        "opencode-cli-sidebar-view",
        expect.any(Object),
        expect.objectContaining({
          webviewOptions: { retainContextWhenHidden: true },
        }),
      );
    });

    it("should swallow duplicate webview provider registration races", async () => {
      vi.mocked(vscode.window.registerWebviewViewProvider).mockImplementation(
        () => {
          throw new Error("provider already registered for opencode-cli-sidebar-view");
        },
      );

      await lifecycle.activate(mockContext);

      const outputChannel = vi.mocked(vscode.window.createOutputChannel).mock
        .results[0].value;
      expect(outputChannel.warn).toHaveBeenCalledWith(
        expect.stringContaining("provider already registered"),
      );
      expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    });

    it("should register commands", async () => {
      await lifecycle.activate(mockContext);

      expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
        "opencode-cli-sidebar.start",
        expect.any(Function),
      );
    });

    it("should skip duplicate activation attempts", async () => {
      await lifecycle.activate(mockContext);
      const registrationCount = vi.mocked(vscode.window.registerWebviewViewProvider)
        .mock.calls.length;

      await lifecycle.activate(mockContext);

      const outputChannel = vi.mocked(vscode.window.createOutputChannel).mock
        .results[0].value;
      expect(outputChannel.warn).toHaveBeenCalledWith(
        expect.stringContaining("activate() called while already active"),
      );
      expect(vscode.window.registerWebviewViewProvider).toHaveBeenCalledTimes(
        registrationCount,
      );
    });

    it("should initialize core services without creating a status bar item", async () => {
      await lifecycle.activate(mockContext);

      expect(vscode.window.createOutputChannel).toHaveBeenCalledWith(
        "OpenCode CLI Sidebar",
        { log: true },
      );
    });

    it("should initialize ContextManager with OutputChannelService", async () => {
      await lifecycle.activate(mockContext);

      const outputChannel = vi.mocked(vscode.window.createOutputChannel).mock
        .results[0].value;
      expect(outputChannel.info).toHaveBeenCalledWith(
        expect.stringContaining("ContextManager initialized"),
      );
    });

    it("should register code actions provider for all languages", async () => {
      await lifecycle.activate(mockContext);

      expect(vscode.languages.registerCodeActionsProvider).toHaveBeenCalledWith(
        "*",
        expect.any(Object),
        expect.objectContaining({
          providedCodeActionKinds: expect.any(Array),
        }),
      );
    });

    it("should route Explain and Fix diagnostics through the lifecycle prompt callback", async () => {
      const sendPrompt = vi.fn().mockResolvedValue(undefined);
      Reflect.set(lifecycle, "sendPromptToOpenCode", sendPrompt);

      await lifecycle.activate(mockContext);

      const explainAndFix = getRegisteredCommandHandler<
        (args: { diagnostic: unknown; documentUri: string }) => Promise<void>
      >("opencode-cli-sidebar.explainAndFix");

      await explainAndFix({
        diagnostic: {
          message: "Broken",
          severity: vscode.DiagnosticSeverity.Error,
          range: vscode.Range(0, 0, 0, 6),
          source: "ts",
        },
        documentUri: "file:///workspace/file.ts",
      });

      expect(sendPrompt).toHaveBeenCalled();
    });

    it("should hydrate the instance registry and wire terminal close cleanup", async () => {
      const hydrateSpy = vi.spyOn(InstanceRegistry.prototype, "hydrate");
      const cleanupSpy = vi.spyOn(OutputCaptureManager.prototype, "cleanup");

      await lifecycle.activate(mockContext);

      expect(hydrateSpy).toHaveBeenCalledTimes(1);
      expect(hydrateSpy.mock.calls[0]?.[0]).toBeInstanceOf(InstanceStore);

      const closeListener = vi.mocked(vscode.window.onDidCloseTerminal).mock
        .calls[0]?.[0] as (terminal: unknown) => void;
      const terminal = { name: "closed-terminal" };

      closeListener(terminal);

      expect(cleanupSpy).toHaveBeenCalledWith(terminal);
    });

    it("should probe the local OpenCode version once during activation", async () => {
      const probeSpy = vi
        .spyOn(TerminalProvider.prototype, "refreshOpenCodeLocalVersion")
        .mockResolvedValue(undefined);

      try {
        await lifecycle.activate(mockContext);

        expect(probeSpy).toHaveBeenCalledTimes(1);
      } finally {
        probeSpy.mockRestore();
      }
    });

    it("should handle activation errors", async () => {
      vi.mocked(vscode.window.registerWebviewViewProvider).mockImplementation(
        () => {
          throw new Error("Registration failed");
        },
      );

      await lifecycle.activate(mockContext);

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("Failed to activate"),
      );
    });

    it("should stringify non-error activation failures", async () => {
      vi.mocked(vscode.window.registerWebviewViewProvider).mockImplementation(
        () => {
          throw "Registration failed as string";
        },
      );

      await lifecycle.activate(mockContext);

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("Registration failed as string"),
      );
    });
  });

  describe("legacy settings migration", () => {
    it("runs the one-time settings migration during activation", async () => {
      const migrateSpy = vi
        .spyOn(SettingsMigrationService.prototype, "migrate")
        .mockResolvedValue({ migratedKeys: [], skippedCount: 0, failedKeys: [] });

      try {
        await lifecycle.activate(mockContext);

        expect(migrateSpy).toHaveBeenCalledTimes(1);
      } finally {
        migrateSpy.mockRestore();
      }
    });

    it("swallows migration failures without blocking activation", async () => {
      const migrateSpy = vi
        .spyOn(SettingsMigrationService.prototype, "migrate")
        .mockRejectedValue(new Error("migration boom"));

      try {
        await lifecycle.activate(mockContext);

        const outputChannel = vi.mocked(vscode.window.createOutputChannel).mock
          .results[0].value;
        expect(outputChannel.warn).toHaveBeenCalledWith(
          expect.stringContaining("Legacy settings migration failed"),
        );
        expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
          "opencode-cli-sidebar.start",
          expect.any(Function),
        );
        expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
      } finally {
        migrateSpy.mockRestore();
      }
    });

    it("migrates legacy values before auto-enable reads configuration", async () => {
      const state = new Map<string, unknown>([
        ["ai-sidebar-terminal.sendKeybindingsToShell", false],
      ]);
      const normalizeKey = (key: string): string =>
        key.startsWith("ai-sidebar-terminal.") ||
        key.startsWith("opencode-cli-sidebar.")
          ? key
          : `opencode-cli-sidebar.${key}`;
      const updateMock = vi.fn(
        async (key: string, value: unknown, _target: unknown) => {
          state.set(normalizeKey(key), value);
        },
      );
      vi.mocked(vscode.workspace.getConfiguration).mockImplementation(
        () =>
          ({
            get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
            inspect: vi.fn((key: string) => {
              const value = state.get(normalizeKey(key));
              return value === undefined ? undefined : { globalValue: value };
            }),
            update: updateMock,
          }) as never,
      );

      await lifecycle.activate(mockContext);

      expect(updateMock).toHaveBeenCalledWith(
        "opencode-cli-sidebar.sendKeybindingsToShell",
        false,
        vscode.ConfigurationTarget.Global,
      );
      expect(mockContext.globalState.update).toHaveBeenCalledWith(
        SETTINGS_MIGRATED_FLAG_KEY,
        true,
      );
      // Auto-enable must see the migrated explicit value and leave it alone.
      expect(updateMock).not.toHaveBeenCalledWith(
        "sendKeybindingsToShell",
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe("deactivate", () => {
    it("should safely no-op when services were never initialized", async () => {
      await expect(lifecycle.deactivate()).resolves.toBeUndefined();
    });

    it("should dispose providers", async () => {
      await lifecycle.activate(mockContext);
      await lifecycle.deactivate();

      expect(mockContext.subscriptions).toBeDefined();
    });

    it("should dispose wave services", async () => {
      await lifecycle.activate(mockContext);
      await lifecycle.deactivate();

      const outputChannel = vi.mocked(vscode.window.createOutputChannel).mock
        .results[0].value;

      expect(outputChannel.dispose).toHaveBeenCalled();
    });

    it("should dispose all initialized collaborators and clear references", async () => {
      const logger = { info: vi.fn(), dispose: vi.fn() };
      const tuiProvider = { dispose: vi.fn() };
      const terminalManager = { dispose: vi.fn() };
      const contextManager = { dispose: vi.fn() };
      const instanceDiscoveryService = { dispose: vi.fn() };
      const instanceRegistry = { dispose: vi.fn() };
      const tuiProviderRegistration = { dispose: vi.fn() };

      Reflect.set(lifecycle, "outputChannelService", logger);
      Reflect.set(lifecycle, "tuiProvider", tuiProvider);
      Reflect.set(lifecycle, "terminalManager", terminalManager);
      Reflect.set(lifecycle, "contextManager", contextManager);
      Reflect.set(
        lifecycle,
        "instanceDiscoveryService",
        instanceDiscoveryService,
      );
      Reflect.set(lifecycle, "instanceRegistry", instanceRegistry);
      Reflect.set(lifecycle, "instanceStore", new InstanceStore());
      Reflect.set(lifecycle, "tuiProviderRegistration", tuiProviderRegistration);

      await lifecycle.deactivate();

      expect(tuiProvider.dispose).toHaveBeenCalledTimes(1);
      expect(terminalManager.dispose).toHaveBeenCalledTimes(1);
      expect(logger.dispose).toHaveBeenCalledTimes(1);
      expect(contextManager.dispose).toHaveBeenCalledTimes(1);
      expect(instanceDiscoveryService.dispose).toHaveBeenCalledTimes(1);
      expect(instanceRegistry.dispose).toHaveBeenCalledTimes(1);
      expect(tuiProviderRegistration.dispose).toHaveBeenCalledTimes(1);
      expect(Reflect.get(lifecycle, "tuiProvider")).toBeUndefined();
      expect(Reflect.get(lifecycle, "terminalManager")).toBeUndefined();
      expect(Reflect.get(lifecycle, "outputChannelService")).toBeUndefined();
      expect(Reflect.get(lifecycle, "contextManager")).toBeUndefined();
      expect(
        Reflect.get(lifecycle, "instanceDiscoveryService"),
      ).toBeUndefined();
      expect(Reflect.get(lifecycle, "instanceRegistry")).toBeUndefined();
      expect(Reflect.get(lifecycle, "instanceStore")).toBeUndefined();
      expect(Reflect.get(lifecycle, "tuiProviderRegistration")).toBeUndefined();
      expect(logger.info).toHaveBeenLastCalledWith(
        "OpenCode CLI Sidebar deactivated",
      );
    });
  });

  describe("private helpers", () => {
    it("should expose live command dependencies and helper closures", async () => {
      const provider = { sendPrompt: vi.fn().mockResolvedValue(undefined) };
      const terminalManager = { kind: "terminal" };
      const contextSharingService = { kind: "share" };
      const contextManager = { kind: "context" };
      const instanceStore = new InstanceStore();
      const instanceController = { kind: "controller" };
      const instanceQuickPick = { kind: "picker" };
      const outputChannelService = { kind: "logger" };
      const getActiveTerminalIdSpy = vi
        .spyOn(lifecycle as any, "getActiveTerminalId")
        .mockReturnValue("terminal-42");
      const sendTerminalCwdSpy = vi
        .spyOn(lifecycle as any, "sendTerminalCwd")
        .mockImplementation(() => undefined);

      Reflect.set(lifecycle, "tuiProvider", provider);
      Reflect.set(lifecycle, "terminalManager", terminalManager);
      Reflect.set(lifecycle, "contextSharingService", contextSharingService);
      Reflect.set(lifecycle, "contextManager", contextManager);
      Reflect.set(lifecycle, "instanceStore", instanceStore);
      Reflect.set(lifecycle, "instanceController", instanceController);
      Reflect.set(lifecycle, "instanceQuickPick", instanceQuickPick);
      Reflect.set(lifecycle, "outputChannelService", outputChannelService);

      const deps = (lifecycle as any).getCommandDependencies();

      expect(deps.provider).toBe(provider);
      expect(deps.terminalManager).toBe(terminalManager);
      expect(deps.contextSharingService).toBe(contextSharingService);
      expect(deps.contextManager).toBe(contextManager);
      expect(deps.outputChannel).toBe(outputChannelService);
      expect(deps.getActiveTerminalId()).toBe("terminal-42");
      deps.sendTerminalCwd();
      await deps.sendPrompt("hello");
      Reflect.set(lifecycle, "tuiProvider", undefined);
      await expect(deps.sendPrompt("without provider")).resolves.toBeUndefined();

      expect(getActiveTerminalIdSpy).toHaveBeenCalledTimes(1);
      expect(sendTerminalCwdSpy).toHaveBeenCalledTimes(1);
      expect(provider.sendPrompt).toHaveBeenCalledWith("hello");
    });

    it("should resolve the active terminal id from runtime terminal key", () => {
      const instanceStore = {
        getActive: vi.fn(() => ({
          config: { id: "instance-1" },
          runtime: { terminalKey: "terminal-1" },
        })),
      };

      Reflect.set(lifecycle, "instanceStore", instanceStore);

      expect((lifecycle as any).getActiveTerminalId()).toBe("terminal-1");
    });

    it("should fall back to config id when runtime terminal key is missing", () => {
      const warn = vi.fn();
      Reflect.set(lifecycle, "outputChannelService", { warn });
      Reflect.set(lifecycle, "instanceStore", {
        getActive: vi.fn(() => ({ config: { id: "instance-2" }, runtime: {} })),
      });

      expect((lifecycle as any).getActiveTerminalId()).toBe("instance-2");
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("NO terminalKey"),
      );
    });

    it("should fall back to the static terminal id when no instance is active", () => {
      const warn = vi.fn();
      Reflect.set(lifecycle, "outputChannelService", { warn });
      Reflect.set(lifecycle, "instanceStore", {
        getActive: vi.fn(() => undefined),
      });

      expect((lifecycle as any).getActiveTerminalId()).toBe("opencode-cli-sidebar-main");
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("NO active instance"),
      );
    });

    it("should handle active terminal id resolution errors", () => {
      const error = vi.fn();
      Reflect.set(lifecycle, "outputChannelService", { error });
      Reflect.set(lifecycle, "instanceStore", {
        getActive: vi.fn(() => {
          throw new Error("boom");
        }),
      });

      expect((lifecycle as any).getActiveTerminalId()).toBe("opencode-cli-sidebar-main");
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("ERROR: boom"),
      );
    });

    it("should stringify non-error active terminal id resolution failures", () => {
      const error = vi.fn();
      Reflect.set(lifecycle, "outputChannelService", { error });
      Reflect.set(lifecycle, "instanceStore", {
        getActive: vi.fn(() => {
          throw "string boom";
        }),
      });

      expect((lifecycle as any).getActiveTerminalId()).toBe("opencode-cli-sidebar-main");
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("ERROR: string boom"),
      );
    });

    it("should return false when no discovery service is available", async () => {
      await expect(
        (lifecycle as any).trySendPromptViaDiscoveredInstance("hello"),
      ).resolves.toBe(false);
    });

    it("should return false when discovery finds no instances", async () => {
      Reflect.set(lifecycle, "instanceDiscoveryService", {
        discoverInstances: vi.fn().mockResolvedValue([]),
      });

      await expect(
        (lifecycle as any).trySendPromptViaDiscoveredInstance("hello"),
      ).resolves.toBe(false);
    });

    it("should send prompts via discovered instances when available", async () => {
      const info = vi.fn();
      const appendPromptSpy = vi
        .spyOn(OpenCodeApiClient.prototype, "appendPrompt")
        .mockResolvedValue(undefined);
      Reflect.set(lifecycle, "outputChannelService", { info });
      Reflect.set(lifecycle, "instanceDiscoveryService", {
        discoverInstances: vi.fn().mockResolvedValue([{ port: 4317 }]),
      });

      await expect(
        (lifecycle as any).trySendPromptViaDiscoveredInstance("hello"),
      ).resolves.toBe(true);

      expect(appendPromptSpy).toHaveBeenCalledWith("hello");
      expect(info).toHaveBeenCalledWith(expect.stringContaining("port 4317"));
    });

    it("should warn and return false when discovered instance forwarding fails", async () => {
      const warn = vi.fn();
      vi.spyOn(OpenCodeApiClient.prototype, "appendPrompt").mockRejectedValue(
        new Error("offline"),
      );
      Reflect.set(lifecycle, "outputChannelService", { warn });
      Reflect.set(lifecycle, "instanceDiscoveryService", {
        discoverInstances: vi.fn().mockResolvedValue([{ port: 9999 }]),
      });

      await expect(
        (lifecycle as any).trySendPromptViaDiscoveredInstance("hello"),
      ).resolves.toBe(false);

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "Failed to send prompt via discovered instance",
        ),
      );
    });

    it("should stringify non-error discovered instance forwarding failures", async () => {
      const warn = vi.fn();
      vi.spyOn(OpenCodeApiClient.prototype, "appendPrompt").mockRejectedValue(
        "offline string",
      );
      Reflect.set(lifecycle, "outputChannelService", { warn });
      Reflect.set(lifecycle, "instanceDiscoveryService", {
        discoverInstances: vi.fn().mockResolvedValue([{ port: 9998 }]),
      });

      await expect(
        (lifecycle as any).trySendPromptViaDiscoveredInstance("hello"),
      ).resolves.toBe(false);

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("offline string"),
      );
    });
  });

  describe("prompt routing", () => {
    it("should throw if sendPromptToOpenCode is called before initialization", async () => {
      await expect(
        (lifecycle as any).sendPromptToOpenCode("hello"),
      ).rejects.toThrow("OpenCode provider is not initialized");
    });

    it("should start OpenCode and send the prompt through HTTP when needed", async () => {
      vi.useFakeTimers();

      const appendPrompt = vi.fn().mockResolvedValue(undefined);
      const focus = vi.fn();
      const startOpenCode = vi.fn().mockResolvedValue(undefined);
      const provider = {
        startOpenCode,
        getApiClient: vi.fn(() => ({ appendPrompt })),
        isHttpAvailable: vi.fn(() => true),
        focus,
      };
      const terminalManager = {
        getTerminal: vi.fn(() => undefined),
        writeToTerminal: vi.fn(),
      };
      Reflect.set(lifecycle, "tuiProvider", provider);
      Reflect.set(lifecycle, "terminalManager", terminalManager);
      Reflect.set(lifecycle, "instanceDiscoveryService", {
        discoverInstances: vi.fn().mockResolvedValue([]),
      });

      const sendPromise = (lifecycle as any).sendPromptToOpenCode("ship it");
      await sendPromise;
      await vi.runAllTimersAsync();

      expect(startOpenCode).toHaveBeenCalledTimes(1);
      expect(appendPrompt).toHaveBeenCalledWith("ship it");
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        "opencode-cli-sidebar.focus",
      );
      expect(focus).toHaveBeenCalledTimes(1);
      expect(terminalManager.writeToTerminal).not.toHaveBeenCalled();
    });

    it("should prefer discovered instances before starting OpenCode", async () => {
      const appendPromptSpy = vi
        .spyOn(OpenCodeApiClient.prototype, "appendPrompt")
        .mockResolvedValue(undefined);
      const provider = {
        startOpenCode: vi.fn().mockResolvedValue(undefined),
        getApiClient: vi.fn(),
        isHttpAvailable: vi.fn(() => false),
      };
      const terminalManager = {
        getTerminal: vi.fn(() => undefined),
        writeToTerminal: vi.fn(),
      };

      Reflect.set(lifecycle, "tuiProvider", provider);
      Reflect.set(lifecycle, "terminalManager", terminalManager);
      Reflect.set(lifecycle, "instanceDiscoveryService", {
        discoverInstances: vi.fn().mockResolvedValue([{ port: 7777 }]),
      });

      await (lifecycle as any).sendPromptToOpenCode("hello");

      expect(appendPromptSpy).toHaveBeenCalledWith("hello");
      expect(provider.startOpenCode).not.toHaveBeenCalled();
      expect(provider.getApiClient).not.toHaveBeenCalled();
    });

    it("should fall back to terminal input when the HTTP API append fails", async () => {
      const warn = vi.fn();
      const provider = {
        getApiClient: vi.fn(() => ({
          appendPrompt: vi.fn().mockRejectedValue(new Error("http down")),
        })),
        isHttpAvailable: vi.fn(() => true),
      };
      const terminalManager = {
        getTerminal: vi.fn(() => ({ id: "terminal" })),
        writeToTerminal: vi.fn(),
      };

      Reflect.set(lifecycle, "tuiProvider", provider);
      Reflect.set(lifecycle, "terminalManager", terminalManager);
      Reflect.set(lifecycle, "outputChannelService", { warn });

      await (lifecycle as any).sendPromptToOpenCode("hello");

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("falling back to terminal input"),
      );
      expect(terminalManager.writeToTerminal).toHaveBeenCalledWith(
        "opencode-cli-sidebar-main",
        "hello\n",
      );
    });

    it("should stringify non-error HTTP append failures and skip non-callable focus", async () => {
      vi.useFakeTimers();

      const warn = vi.fn();
      const provider = {
        getApiClient: vi.fn(() => ({
          appendPrompt: vi.fn().mockRejectedValue("http string down"),
        })),
        isHttpAvailable: vi.fn(() => true),
        focus: "not callable",
      };
      const terminalManager = {
        getTerminal: vi.fn(() => ({ id: "terminal" })),
        writeToTerminal: vi.fn(),
      };

      Reflect.set(lifecycle, "tuiProvider", provider);
      Reflect.set(lifecycle, "terminalManager", terminalManager);
      Reflect.set(lifecycle, "outputChannelService", { warn });

      await (lifecycle as any).sendPromptToOpenCode("hello");
      await vi.runAllTimersAsync();

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("http string down"),
      );
      expect(terminalManager.writeToTerminal).toHaveBeenCalledWith(
        "opencode-cli-sidebar-main",
        "hello\n",
      );
    });

    it("should write directly to the terminal when HTTP is unavailable", async () => {
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: vi.fn(() => false),
        inspect: vi.fn(() => undefined),
        update: vi.fn(),
      } as never);

      const provider = {
        getApiClient: vi.fn(() => undefined),
        isHttpAvailable: vi.fn(() => false),
        focus: vi.fn(),
      };
      const terminalManager = {
        getTerminal: vi.fn(() => ({ id: "terminal" })),
        writeToTerminal: vi.fn(),
      };

      Reflect.set(lifecycle, "tuiProvider", provider);
      Reflect.set(lifecycle, "terminalManager", terminalManager);

      await (lifecycle as any).sendPromptToOpenCode("fallback");

      expect(terminalManager.writeToTerminal).toHaveBeenCalledWith(
        "opencode-cli-sidebar-main",
        "fallback\n",
      );
      expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
        "opencode-cli-sidebar.focus",
      );
    });
  });

  describe("terminal cwd forwarding", () => {
    it("should warn when there is no active terminal", () => {
      vscode.window.activeTerminal = undefined;

      (lifecycle as any).sendTerminalCwd();

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        "No active terminal",
      );
    });

    it("should warn when shell integration does not expose a cwd", () => {
      vscode.window.activeTerminal = { shellIntegration: {} };

      (lifecycle as any).sendTerminalCwd();

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining(
          "Could not determine terminal working directory",
        ),
      );
    });

    it("should send a relative cwd reference when a workspace is open", async () => {
      vi.useFakeTimers();

      const focus = vi.fn();
      const terminalManager = { writeToTerminal: vi.fn() };
      vscode.window.activeTerminal = {
        shellIntegration: { cwd: { fsPath: "/repo/packages/core" } },
      };
      vscode.workspace.workspaceFolders = [
        { uri: { fsPath: "/repo" } },
      ] as never;
      vi.mocked(vscode.workspace.asRelativePath).mockReturnValue(
        "packages/core",
      );
      Reflect.set(lifecycle, "terminalManager", terminalManager);
      Reflect.set(lifecycle, "tuiProvider", { focus });

      (lifecycle as any).sendTerminalCwd();
      await vi.runAllTimersAsync();

      expect(terminalManager.writeToTerminal).toHaveBeenCalledWith(
        "opencode-cli-sidebar-main",
        "@packages/core ",
      );
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        "opencode-cli-sidebar.focus",
      );
      expect(focus).toHaveBeenCalledTimes(1);
    });

    it("should send an absolute cwd reference when no workspace is open", () => {
      const terminalManager = { writeToTerminal: vi.fn() };
      vscode.window.activeTerminal = {
        shellIntegration: { cwd: { fsPath: "/tmp/project" } },
      };
      vscode.workspace.workspaceFolders = undefined;
      Reflect.set(lifecycle, "terminalManager", terminalManager);

      (lifecycle as any).sendTerminalCwd();

      expect(terminalManager.writeToTerminal).toHaveBeenCalledWith(
        "opencode-cli-sidebar-main",
        "@/tmp/project ",
      );
    });

    it("should not focus a provider without a callable focus method", async () => {
      vi.useFakeTimers();

      const terminalManager = { writeToTerminal: vi.fn() };
      vscode.window.activeTerminal = {
        shellIntegration: { cwd: { fsPath: "/tmp/project" } },
      };
      vscode.workspace.workspaceFolders = undefined;
      Reflect.set(lifecycle, "terminalManager", terminalManager);
      Reflect.set(lifecycle, "tuiProvider", {});

      (lifecycle as any).sendTerminalCwd();
      await vi.runAllTimersAsync();

      expect(terminalManager.writeToTerminal).toHaveBeenCalledWith(
        "opencode-cli-sidebar-main",
        "@/tmp/project ",
      );
    });
  });

  describe("commands", () => {
    beforeEach(async () => {
      await lifecycle.activate(mockContext);
    });

    it("should register start command", () => {
      const calls = vi.mocked(vscode.commands.registerCommand).mock.calls;
      const startCall = calls.find((call) => call[0] === "opencode-cli-sidebar.start");

      expect(startCall).toBeDefined();
    });

    it("should register sendToTerminal command", () => {
      const calls = vi.mocked(vscode.commands.registerCommand).mock.calls;
      const sendCall = calls.find(
        (call) => call[0] === "opencode-cli-sidebar.sendToTerminal",
      );

      expect(sendCall).toBeDefined();
    });

    it("should register sendAtMention command", () => {
      const calls = vi.mocked(vscode.commands.registerCommand).mock.calls;
      const mentionCall = calls.find(
        (call) => call[0] === "opencode-cli-sidebar.sendAtMention",
      );

      expect(mentionCall).toBeDefined();
    });

    it("should register sendAllOpenFiles command", () => {
      const calls = vi.mocked(vscode.commands.registerCommand).mock.calls;
      const allFilesCall = calls.find(
        (call) => call[0] === "opencode-cli-sidebar.sendAllOpenFiles",
      );

      expect(allFilesCall).toBeDefined();
    });

    it("should register sendToOpencode command", () => {
      const calls = vi.mocked(vscode.commands.registerCommand).mock.calls;
      const fileCall = calls.find(
        (call) => call[0] === "opencode-cli-sidebar.sendToOpencode",
      );

      expect(fileCall).toBeDefined();
    });
  });

  describe("OpenCode update auto-check scheduling", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(async () => {
      try {
        await lifecycle.deactivate();
      } catch {
        // deactivation is best-effort cleanup for these tests
      }
      vi.useRealTimers();
    });

    function spySilentCheck() {
      return vi
        .spyOn(OpenCodeUpdateService.prototype, "checkForUpdates")
        .mockResolvedValue({ ok: true, state: "upToDate" } as never);
    }

    it("checks immediately on activation and repeats at the interval", async () => {
      const checkSpy = spySilentCheck();

      await lifecycle.activate(mockContext);
      expect(checkSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(0);
      expect(checkSpy).toHaveBeenCalledTimes(1);
      expect(checkSpy).toHaveBeenCalledWith({ manual: false });

      await vi.advanceTimersByTimeAsync(24 * 3_600_000);
      expect(checkSpy).toHaveBeenCalledTimes(2);
      expect(checkSpy).toHaveBeenLastCalledWith({ manual: false });
    });

    it("runs the activation check even when one ran recently, then skips periodic ticks", async () => {
      const checkSpy = spySilentCheck();
      vi.mocked(mockContext.globalState.get).mockImplementation(
        (key: string) =>
          key === "opencodeUpdate.lastCheckAt" ? Date.now() : undefined,
      );

      await lifecycle.activate(mockContext);
      await vi.advanceTimersByTimeAsync(0);
      expect(checkSpy).toHaveBeenCalledTimes(1);

      // The periodic tick within the interval window is skipped.
      await vi.advanceTimersByTimeAsync(24 * 3_600_000);
      expect(checkSpy).toHaveBeenCalledTimes(1);
    });

    it("does not schedule checks when autoCheck is disabled", async () => {
      const checkSpy = spySilentCheck();
      vi.mocked(vscode.workspace.getConfiguration).mockImplementation(
        () =>
          ({
            get: vi.fn((key: string, defaultValue?: unknown) =>
              key === "update.autoCheck" ? false : defaultValue,
            ),
            inspect: vi.fn(() => undefined),
            update: vi.fn(),
          }) as any,
      );

      await lifecycle.activate(mockContext);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(checkSpy).not.toHaveBeenCalled();
    });

    it("clears the schedule on deactivate", async () => {
      const checkSpy = spySilentCheck();

      await lifecycle.activate(mockContext);
      await lifecycle.deactivate();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(checkSpy).not.toHaveBeenCalled();
    });

    it("does not reschedule when a check is in flight at deactivate", async () => {
      let resolveCheck: ((value: unknown) => void) | undefined;
      const checkSpy = vi
        .spyOn(OpenCodeUpdateService.prototype, "checkForUpdates")
        .mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveCheck = resolve;
            }) as never,
        );

      await lifecycle.activate(mockContext);
      // Timer fires; the silent check is now in flight.
      await vi.advanceTimersByTimeAsync(0);
      expect(checkSpy).toHaveBeenCalledTimes(1);

      await lifecycle.deactivate();
      resolveCheck?.({ ok: true, state: "upToDate" });
      await Promise.resolve();
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(24 * 3_600_000);
      expect(checkSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("OpenCode CLI install prompt", () => {
    afterEach(async () => {
      try {
        await lifecycle.deactivate();
      } catch {
        // deactivation is best-effort cleanup for these tests
      }
    });

    function spyProbe(available: boolean) {
      return vi
        .spyOn(OpenCodeUpdateService.prototype, "probeCliAvailable")
        .mockResolvedValue(available);
    }

    it("marks the CLI missing with a pending prompt and reveals the sidebar view", async () => {
      spyProbe(false);
      const markSpy = vi.spyOn(
        OpenCodeUpdateService.prototype,
        "markCliMissing",
      );
      const revealSpy = vi
        .spyOn(TerminalProvider.prototype, "revealSidebarView")
        .mockResolvedValue(undefined);

      await lifecycle.activate(mockContext);

      await vi.waitFor(() => {
        expect(markSpy).toHaveBeenCalledTimes(1);
      });
      expect(markSpy).toHaveBeenLastCalledWith(true);
      await vi.waitFor(() => {
        expect(revealSpy).toHaveBeenCalledTimes(1);
      });
      // The confirmation itself happens in the webview dialog.
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });

    it("does not prompt when the CLI is available", async () => {
      spyProbe(true);
      const markSpy = vi.spyOn(
        OpenCodeUpdateService.prototype,
        "markCliMissing",
      );
      const revealSpy = vi
        .spyOn(TerminalProvider.prototype, "revealSidebarView")
        .mockResolvedValue(undefined);

      await lifecycle.activate(mockContext);
      await Promise.resolve();
      await Promise.resolve();

      expect(markSpy).not.toHaveBeenCalled();
      expect(revealSpy).not.toHaveBeenCalled();
      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });

    it("does not prompt while an update flow is busy", async () => {
      let resolveProbe: ((available: boolean) => void) | undefined;
      vi.spyOn(
        OpenCodeUpdateService.prototype,
        "probeCliAvailable",
      ).mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            resolveProbe = resolve;
          }),
      );

      await lifecycle.activate(mockContext);
      const service = (
        lifecycle as unknown as {
          opencodeUpdateService: OpenCodeUpdateService;
        }
      ).opencodeUpdateService;
      // Simulate an update flow that started while the probe was pending.
      (service as unknown as { currentState: string }).currentState =
        "updating";

      resolveProbe?.(false);
      await Promise.resolve();
      await Promise.resolve();

      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    });
  });

  describe("cross-window OpenCode update sync", () => {
    const SYNC_KEY = "opencode-cli-sidebar.updateSync";

    it("stores a timestamped sync signal when an update succeeds in this window", async () => {
      vi.mocked(mockContext.secrets.store).mockResolvedValue(undefined);
      await lifecycle.activate(mockContext);

      const service = (
        lifecycle as unknown as {
          opencodeUpdateService: OpenCodeUpdateService;
        }
      ).opencodeUpdateService;
      (
        service as unknown as {
          _onDidChangeStatus: { fire: (event: unknown) => void };
        }
      )._onDidChangeStatus.fire({
        state: "updateSucceeded",
        installedVersion: "2.0.39",
      });

      expect(mockContext.secrets.store).toHaveBeenCalledTimes(1);
      const [key, raw] = vi.mocked(mockContext.secrets.store).mock.calls[0];
      expect(key).toBe(SYNC_KEY);
      const payload = JSON.parse(raw as string) as {
        version: string;
        at: number;
      };
      expect(payload.version).toBe("2.0.39");
      expect(payload.at).toBeGreaterThan(0);
    });

    it("re-syncs the provider version when another window signals an update", async () => {
      const syncSpy = vi
        .spyOn(
          TerminalProvider.prototype,
          "syncOpenCodeVersionFromOtherWindow",
        )
        .mockResolvedValue(undefined);
      await lifecycle.activate(mockContext);

      const emitSignal = (at: number) => {
        vi.mocked(mockContext.secrets.get).mockResolvedValue(
          JSON.stringify({ version: "2.0.39", at }),
        );
        mockContext.secrets.__emitSecretChange(SYNC_KEY);
      };
      emitSignal(1_000);
      await vi.waitFor(() => {
        expect(syncSpy).toHaveBeenCalledTimes(1);
      });
      expect(syncSpy).toHaveBeenCalledWith("2.0.39");

      // Other secret keys are ignored entirely.
      mockContext.secrets.__emitSecretChange("some-other-secret");
      await Promise.resolve();
      await Promise.resolve();
      expect(syncSpy).toHaveBeenCalledTimes(1);

      // Replaying the same timestamp is deduplicated.
      emitSignal(1_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(syncSpy).toHaveBeenCalledTimes(1);
    });

    it("ignores malformed payloads without advancing the dedupe watermark", async () => {
      const syncSpy = vi
        .spyOn(
          TerminalProvider.prototype,
          "syncOpenCodeVersionFromOtherWindow",
        )
        .mockResolvedValue(undefined);
      await lifecycle.activate(mockContext);

      const emitRaw = (raw: string) => {
        vi.mocked(mockContext.secrets.get).mockResolvedValue(raw);
        mockContext.secrets.__emitSecretChange(SYNC_KEY);
      };

      // Valid timestamp but no version: ignored, watermark untouched.
      emitRaw(JSON.stringify({ at: 5_000 }));
      // Valid JSON but not a payload object: ignored without throwing.
      emitRaw("null");
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // A later valid signal with a smaller timestamp still applies.
      emitRaw(JSON.stringify({ version: "2.0.39", at: 4_000 }));
      await vi.waitFor(() => {
        expect(syncSpy).toHaveBeenCalledTimes(1);
      });
      expect(syncSpy).toHaveBeenCalledWith("2.0.39");
    });
  });

  describe("sendKeybindingsToShell auto-enable (ensureSendKeybindingsToShellDefault)", () => {
    it("should respect explicit user config (globalValue) and skip auto-enable", async () => {
      const inspectMock = vi.fn(() => ({ globalValue: false }));
      const updateMock = vi.fn();
      vi.mocked(vscode.workspace.getConfiguration).mockImplementation((section) => {
        if (section === "opencode-cli-sidebar") {
          return {
            inspect: inspectMock,
            update: updateMock,
            get: vi.fn(),
          } as any;
        }
        return { get: vi.fn(), update: vi.fn(), inspect: vi.fn() } as any;
      });

      await lifecycle.activate(mockContext);

      expect(inspectMock).toHaveBeenCalledWith("sendKeybindingsToShell");
      expect(updateMock).not.toHaveBeenCalledWith(
        "sendKeybindingsToShell",
        true,
        vscode.ConfigurationTarget.Global,
      );
    });

    it("should respect explicit user config (workspaceValue) and skip auto-enable", async () => {
      const inspectMock = vi.fn(() => ({ workspaceValue: true }));
      const updateMock = vi.fn();
      vi.mocked(vscode.workspace.getConfiguration).mockImplementation((section) => {
        if (section === "opencode-cli-sidebar") {
          return {
            inspect: inspectMock,
            update: updateMock,
            get: vi.fn(),
          } as any;
        }
        return { get: vi.fn(), update: vi.fn(), inspect: vi.fn() } as any;
      });

      await lifecycle.activate(mockContext);

      expect(inspectMock).toHaveBeenCalledWith("sendKeybindingsToShell");
      expect(updateMock).not.toHaveBeenCalledWith(
        "sendKeybindingsToShell",
        expect.anything(),
        expect.anything(),
      );
    });

    it("should respect explicit user config (workspaceFolderValue) and skip auto-enable", async () => {
      const inspectMock = vi.fn(() => ({ workspaceFolderValue: false }));
      const updateMock = vi.fn();
      vi.mocked(vscode.workspace.getConfiguration).mockImplementation((section) => {
        if (section === "opencode-cli-sidebar") {
          return {
            inspect: inspectMock,
            update: updateMock,
            get: vi.fn(),
          } as any;
        }
        return { get: vi.fn(), update: vi.fn(), inspect: vi.fn() } as any;
      });

      await lifecycle.activate(mockContext);

      expect(inspectMock).toHaveBeenCalledWith("sendKeybindingsToShell");
      expect(updateMock).not.toHaveBeenCalledWith(
        "sendKeybindingsToShell",
        true,
        vscode.ConfigurationTarget.Global,
      );
    });

    it("should skip auto-enable when alreadyAutoEnabled flag is true in globalState", async () => {
      vi.mocked(mockContext.globalState.get).mockImplementation((key: string, def: any) => {
        if (key === "opencode-cli-sidebar.hasAutoEnabledKeybindings") return true;
        return def;
      });

      await lifecycle.activate(mockContext);

      expect(mockContext.globalState.get).toHaveBeenCalledWith(
        "opencode-cli-sidebar.hasAutoEnabledKeybindings",
        false,
      );
      expect(mockContext.globalState.update).not.toHaveBeenCalledWith(
        "opencode-cli-sidebar.hasAutoEnabledKeybindings",
        true,
      );
    });

    it("should catch and swallow errors from config.update (error path)", async () => {
      const failingUpdate = vi.fn().mockRejectedValue(new Error("update failed for test"));
      const warnSpy = vi.fn();
      Reflect.set(lifecycle, "outputChannelService", { warn: warnSpy });

      vi.mocked(vscode.workspace.getConfiguration).mockImplementation((section) => {
        if (section === "opencode-cli-sidebar") {
          return {
            inspect: vi.fn(() => undefined),
            update: failingUpdate,
            get: vi.fn(),
          } as any;
        }
        return { get: vi.fn(), update: vi.fn(), inspect: vi.fn() } as any;
      });

      await expect(lifecycle.activate(mockContext)).resolves.not.toThrow();
      expect(failingUpdate).toHaveBeenCalledWith(
        "sendKeybindingsToShell",
        true,
        vscode.ConfigurationTarget.Global,
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to auto-enable sendKeybindingsToShell"),
      );
    });

    it("should no-op early when context is falsy (line 549 guard)", async () => {
      Reflect.set(lifecycle, "context", undefined);
      await expect(
        (lifecycle as any).ensureSendKeybindingsToShellDefault(),
      ).resolves.toBeUndefined();
    });

    it("should stringify non-Error rejection in catch (covers ternary false branch at 588)", async () => {
      const failingUpdate = vi.fn().mockRejectedValue("string failure for coverage");
      const warnSpy = vi.fn();
      Reflect.set(lifecycle, "outputChannelService", { warn: warnSpy });

      vi.mocked(vscode.workspace.getConfiguration).mockImplementation((section) => {
        if (section === "opencode-cli-sidebar") {
          return {
            inspect: vi.fn(() => undefined),
            update: failingUpdate,
            get: vi.fn(),
          } as any;
        }
        return { get: vi.fn(), update: vi.fn(), inspect: vi.fn() } as any;
      });

      await expect(lifecycle.activate(mockContext)).resolves.not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("string failure for coverage"),
      );
    });

    it("should auto-enable when no explicit user value exists and not already enabled", async () => {
      const updateMock = vi.fn().mockResolvedValue(undefined);
      const globalStateUpdateMock = vi.fn().mockResolvedValue(undefined);
      const infoSpy = vi.fn();

      Reflect.set(lifecycle, "outputChannelService", { info: infoSpy });
      vi.mocked(mockContext.globalState.get).mockImplementation((key: string, def: any) => {
        if (key === "opencode-cli-sidebar.hasAutoEnabledKeybindings") return false;
        return def;
      });
      vi.mocked(mockContext.globalState.update).mockImplementation(globalStateUpdateMock);
      vi.mocked(vscode.workspace.getConfiguration).mockImplementation((section) => {
        if (section === "opencode-cli-sidebar") {
          return {
            inspect: vi.fn(() => ({})),
            update: updateMock,
            get: vi.fn(),
          } as any;
        }
        return { get: vi.fn(), update: vi.fn(), inspect: vi.fn() } as any;
      });

      await lifecycle.activate(mockContext);

      expect(updateMock).toHaveBeenCalledWith(
        "sendKeybindingsToShell",
        true,
        vscode.ConfigurationTarget.Global,
      );
      expect(globalStateUpdateMock).toHaveBeenCalledWith(
        "opencode-cli-sidebar.hasAutoEnabledKeybindings",
        true,
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining("Automatically enabled 'sendKeybindingsToShell: true'"),
      );
    });
  });
});
