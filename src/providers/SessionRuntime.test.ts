import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscodeApi from "vscode";
import type * as nodePtyTypes from "../test/mocks/node-pty";
import type * as vscodeTypes from "../test/mocks/vscode";
import { OutputCaptureManager } from "../services/OutputCaptureManager";
import { InstanceStore } from "../services/InstanceStore";
import { OutputChannelService } from "../services/OutputChannelService";
import { PortManager } from "../services/PortManager";
import { TerminalManager } from "../terminals/TerminalManager";
import { ContextSharingService } from "../services/ContextSharingService";
import { OpenCodeToolOperator } from "../services/aiTools/OpenCodeToolOperator";
import { NativeTerminalManager } from "../services/NativeTerminalManager";
import { TerminalBackendRegistry } from "../services/terminalBackends";
import type { IdeContextServer } from "../services/ideContext/IdeContextServer";
import { SessionRuntime } from "./SessionRuntime";

const vscode = await vi.importActual<typeof vscodeTypes>(
  "../test/mocks/vscode",
);
await vi.importActual<typeof nodePtyTypes>("../test/mocks/node-pty");

vi.mock("vscode", async () => {
  const actual = await vi.importActual("../test/mocks/vscode");
  return actual;
});

vi.mock("node-pty", async () => {
  const actual = await vi.importActual("../test/mocks/node-pty");
  return actual;
});

vi.mock("../services/OpenCodeCliCompat", async () => {
  const actual = await vi.importActual<
    typeof import("../services/OpenCodeCliCompat")
  >("../services/OpenCodeCliCompat");
  return {
    ...actual,
    detectOpenCodeMajorVersion: vi.fn().mockResolvedValue(1),
    detectOpenCodeApiProtocol: vi.fn().mockResolvedValue("v1"),
    resolveOpenCodeV2Service: vi.fn().mockResolvedValue(undefined),
    // extractCliBinary stays the real implementation (pure/deterministic).
    runOpenCodeCliCommand: vi
      .fn()
      .mockResolvedValue("http://127.0.0.1:49374"),
  };
});

describe("SessionRuntime (native-only)", () => {
  let terminalManager: TerminalManager;
  let captureManager: OutputCaptureManager;
  let portManager: PortManager;
  let instanceStore: InstanceStore;
  let logger: OutputChannelService;
  let contextSharingService: ContextSharingService;
  let opencodeOperator: OpenCodeToolOperator;
  let backendRegistry: TerminalBackendRegistry;
  let nativeTerminalManager: NativeTerminalManager;
  let mockPostMessage: ReturnType<typeof vi.fn>;
  let mockOnActiveInstanceChanged: ReturnType<typeof vi.fn>;
  let mockRequestStartOpenCode: ReturnType<typeof vi.fn>;
  let sessionRuntime: SessionRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
    OutputChannelService.resetInstance();
    PortManager.resetInstance();

    terminalManager = new TerminalManager();
    captureManager = new OutputCaptureManager();
    instanceStore = new InstanceStore();
    logger = OutputChannelService.getInstance();
    contextSharingService = new ContextSharingService();
    opencodeOperator = new OpenCodeToolOperator();
    backendRegistry = new TerminalBackendRegistry();
    nativeTerminalManager = new NativeTerminalManager(logger);
    portManager = PortManager.getInstance(instanceStore);

    mockPostMessage = vi.fn((_msg: unknown) => {});
    mockOnActiveInstanceChanged = vi.fn((_id: string) => {});
    mockRequestStartOpenCode = vi.fn(async (): Promise<void> => {});

    const configuration = {
      get: vi.fn((key: string, defaultValue?: unknown) => {
        if (key === "logLevel") return "error";
        if (key === "httpTimeout") return 5000;
        return defaultValue;
      }),
      update: vi.fn(),
    };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(configuration as any);

    vscode.workspace.workspaceFolders = undefined;
  });

  afterEach(() => {
    sessionRuntime?.dispose?.();
    terminalManager.dispose();
    OutputChannelService.resetInstance();
    PortManager.resetInstance();
  });

  function createSessionRuntime(overrides?: {
    instanceStore?: InstanceStore;
    ideContextServer?: IdeContextServer;
    /** Leave the real readiness poll loop in place. */
    stubHttpPolling?: boolean;
  }): SessionRuntime {
    const runtime = new SessionRuntime(
      terminalManager,
      captureManager,
      undefined,
      portManager,
      backendRegistry,
      overrides?.instanceStore ?? instanceStore,
      logger,
      contextSharingService,
      opencodeOperator,
      {
        postMessage: mockPostMessage as (message: unknown) => void,
        onActiveInstanceChanged: mockOnActiveInstanceChanged as (instanceId: string) => void,
        requestStartOpenCode: mockRequestStartOpenCode as () => Promise<void>,
      },
      nativeTerminalManager,
      overrides?.ideContextServer,
    );
    // The HTTP API has no opt-out setting, so every start enters the
    // readiness path. Nothing listens on the assigned port in unit tests;
    // stub the poll loop instead of waiting out its real backoff.
    if (overrides?.stubHttpPolling !== false) {
      vi.spyOn(runtime, "pollForHttpReadiness").mockResolvedValue(undefined);
    }
    return runtime;
  }

  it("constructs and returns default active instance id", () => {
    instanceStore.upsert({
      config: { id: "default" },
      runtime: { terminalKey: "default" },
      state: "disconnected",
    });

    sessionRuntime = createSessionRuntime();

    expect(sessionRuntime.getActiveInstanceId()).toBe("default");
  });

  it("returns native as active backend", () => {
    instanceStore.upsert({
      config: { id: "default" },
      runtime: { terminalKey: "default" },
      state: "disconnected",
    });

    sessionRuntime = createSessionRuntime();

    expect(sessionRuntime.getActiveBackend()).toBe("native");
  });

  it("starts a native session via startOpenCode", async () => {
    instanceStore.upsert({
      config: { id: "default" },
      runtime: { terminalKey: "default" },
      state: "disconnected",
    });

    sessionRuntime = createSessionRuntime();
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, defaultValue?: unknown) => {
        return defaultValue;
      }),
      update: vi.fn(),
    } as any);

    await sessionRuntime.startOpenCode();

    expect(sessionRuntime.isStartedFlag()).toBe(true);
  });

  it("notifies the webview when an OpenCode session starts", async () => {
    instanceStore.upsert({
      config: { id: "default" },
      runtime: { terminalKey: "default" },
      state: "disconnected",
    });

    sessionRuntime = createSessionRuntime();

    await sessionRuntime.startOpenCode();

    expect(mockPostMessage).toHaveBeenCalledWith({
      type: "openCodeSessionStarted",
    });
  });

  it("getActiveSession returns session after creation", () => {
    instanceStore.upsert({
      config: { id: "default" },
      runtime: { terminalKey: "default" },
      state: "disconnected",
    });

    sessionRuntime = createSessionRuntime();

    const session = sessionRuntime.getActiveSession();
    expect(session).toBeUndefined(); // Not started yet
  });

  it("switches to another instance and clears previous state", async () => {
    instanceStore.upsert({
      config: { id: "instance-a" },
      runtime: { terminalKey: "instance-a" },
      state: "disconnected",
    });
    instanceStore.upsert({
      config: { id: "instance-b" },
      runtime: { terminalKey: "instance-b" },
      state: "disconnected",
    });

    sessionRuntime = createSessionRuntime();
    instanceStore.setActive("instance-a");

    expect(sessionRuntime.getActiveInstanceId()).toBe("instance-a");

    await sessionRuntime.switchToInstance("instance-b");

    expect(sessionRuntime.getActiveInstanceId()).toBe("instance-b");
  });

  it("no-ops switching to the already-active instance", async () => {
    instanceStore.upsert({
      config: { id: "default" },
      runtime: { terminalKey: "default" },
      state: "disconnected",
    });

    sessionRuntime = createSessionRuntime();
    const initialId = sessionRuntime.getActiveInstanceId();

    await sessionRuntime.switchToInstance(initialId);

    expect(sessionRuntime.getActiveInstanceId()).toBe(initialId);
  });

  it("restarts the active instance state", () => {
    instanceStore.upsert({
      config: { id: "default" },
      runtime: { terminalKey: "default" },
      state: "disconnected",
    });

    sessionRuntime = createSessionRuntime();

    sessionRuntime.restart();

    expect(mockRequestStartOpenCode).toHaveBeenCalled();
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "clearTerminal" }),
    );
  });

  async function startToolSession(
    cliMajor: number,
    launchArgs?: string[],
  ): Promise<void> {
    instanceStore.upsert({
      config: { id: "default" },
      runtime: { terminalKey: "default" },
      state: "disconnected",
    });

    sessionRuntime = createSessionRuntime();
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, defaultValue?: unknown) => {
        if (key === "opencode.args") return launchArgs ?? [];
        if (key === "httpTimeout") return 5000;
        return defaultValue;
      }),
      update: vi.fn(),
    } as any);

    const { detectOpenCodeMajorVersion } = await import(
      "../services/OpenCodeCliCompat"
    );
    vi.mocked(detectOpenCodeMajorVersion).mockResolvedValue(cliMajor);
    await sessionRuntime.startOpenCode();
  }

  it("prompts in the webview and restarts the service on confirm", async () => {
    await startToolSession(2);

    const { runOpenCodeCliCommand } = await import("../services/OpenCodeCliCompat");
    vi.mocked(runOpenCodeCliCommand).mockResolvedValue(
      "http://127.0.0.1:49374",
    );

    sessionRuntime.restart();

    // The prompt reaches the webview before any teardown happens.
    expect(mockPostMessage).toHaveBeenCalledWith({
      type: "showServiceRestartPrompt",
    });

    sessionRuntime.answerServiceRestartPrompt("restartService");

    await vi.waitFor(() => {
      expect(mockRequestStartOpenCode).toHaveBeenCalled();
    });
    expect(runOpenCodeCliCommand).toHaveBeenCalledWith(
      "opencode",
      ["service", "restart"],
      15000,
    );
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "clearTerminal" }),
    );
  });

  it("skips the background service restart when the user declines the prompt", async () => {
    await startToolSession(2);

    sessionRuntime.restart();
    expect(mockPostMessage).toHaveBeenCalledWith({
      type: "showServiceRestartPrompt",
    });

    sessionRuntime.answerServiceRestartPrompt("terminalOnly");

    await vi.waitFor(() => {
      expect(mockRequestStartOpenCode).toHaveBeenCalled();
    });
    const { runOpenCodeCliCommand } = await import("../services/OpenCodeCliCompat");
    expect(runOpenCodeCliCommand).not.toHaveBeenCalled();
  });

  it("aborts the restart when the prompt is cancelled", async () => {
    await startToolSession(2);

    sessionRuntime.restart();
    expect(mockPostMessage).toHaveBeenCalledWith({
      type: "showServiceRestartPrompt",
    });

    sessionRuntime.answerServiceRestartPrompt("cancel");

    // Let the cancelled restart settle, then assert nothing was torn down.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockRequestStartOpenCode).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "clearTerminal" }),
    );
  });

  it("does not prompt for OpenCode v2 standalone TUIs", async () => {
    await startToolSession(2, ["--standalone"]);

    sessionRuntime.restart();

    await vi.waitFor(() => {
      expect(mockRequestStartOpenCode).toHaveBeenCalled();
    });
    const { runOpenCodeCliCommand } = await import("../services/OpenCodeCliCompat");
    expect(mockPostMessage).not.toHaveBeenCalledWith({
      type: "showServiceRestartPrompt",
    });
    expect(runOpenCodeCliCommand).not.toHaveBeenCalled();
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "clearTerminal" }),
    );
  });

  it("does not prompt for OpenCode v2 TUIs with an explicit --server", async () => {
    await startToolSession(2, [
      "--server",
      "http://127.0.0.1:4096",
    ]);

    sessionRuntime.restart();

    await vi.waitFor(() => {
      expect(mockRequestStartOpenCode).toHaveBeenCalled();
    });
    const { runOpenCodeCliCommand } = await import("../services/OpenCodeCliCompat");
    expect(mockPostMessage).not.toHaveBeenCalledWith({
      type: "showServiceRestartPrompt",
    });
    expect(runOpenCodeCliCommand).not.toHaveBeenCalled();
  });

  it("restarts the background service without prompting under the always policy", async () => {
    await startToolSession(2);

    const { runOpenCodeCliCommand } = await import("../services/OpenCodeCliCompat");
    vi.mocked(runOpenCodeCliCommand).mockResolvedValue(
      "http://127.0.0.1:49374",
    );

    sessionRuntime.restart("always");

    await vi.waitFor(() => {
      expect(mockRequestStartOpenCode).toHaveBeenCalled();
    });
    expect(mockPostMessage).not.toHaveBeenCalledWith({
      type: "showServiceRestartPrompt",
    });
    expect(runOpenCodeCliCommand).toHaveBeenCalledWith(
      "opencode",
      ["service", "restart"],
      15000,
    );
  });

  it("does not restart the background service for OpenCode v1", async () => {
    await startToolSession(1);

    sessionRuntime.restart();

    await vi.waitFor(() => {
      expect(mockRequestStartOpenCode).toHaveBeenCalled();
    });
    const { runOpenCodeCliCommand } = await import("../services/OpenCodeCliCompat");
    expect(mockPostMessage).not.toHaveBeenCalledWith({
      type: "showServiceRestartPrompt",
    });
    expect(runOpenCodeCliCommand).not.toHaveBeenCalled();
  });

  it("judges service restarts by the launch-time command after settings changes", async () => {
    instanceStore.upsert({
      config: { id: "default" },
      runtime: { terminalKey: "default" },
      state: "disconnected",
    });

    sessionRuntime = createSessionRuntime();
    let opencodeArgs: string[] = [];
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, defaultValue?: unknown) => {
        if (key === "opencode.args") return opencodeArgs;
        if (key === "httpTimeout") return 5000;
        return defaultValue;
      }),
      update: vi.fn(),
    } as any);

    const { detectOpenCodeMajorVersion, runOpenCodeCliCommand } =
      await import("../services/OpenCodeCliCompat");
    vi.mocked(detectOpenCodeMajorVersion).mockResolvedValue(2);

    // Session starts bare v2: the TUI attaches to the shared background
    // service, so a restart must offer the service-restart prompt.
    await sessionRuntime.startOpenCode();

    // The user adds --standalone to opencode.args AFTER launch; the
    // restart decision must still follow the launch-time command snapshot
    // instead of the edited settings.
    opencodeArgs = ["--standalone"];
    sessionRuntime.restart();

    expect(mockPostMessage).toHaveBeenCalledWith({
      type: "showServiceRestartPrompt",
    });
    sessionRuntime.answerServiceRestartPrompt("terminalOnly");

    await vi.waitFor(() => {
      expect(mockRequestStartOpenCode).toHaveBeenCalled();
    });
    expect(runOpenCodeCliCommand).not.toHaveBeenCalled();
  });

  it("still relaunches the terminal when the background service restart fails", async () => {
    await startToolSession(2);

    const { runOpenCodeCliCommand } = await import("../services/OpenCodeCliCompat");
    vi.mocked(runOpenCodeCliCommand).mockRejectedValue(
      new Error("service restart failed"),
    );

    expect(() => sessionRuntime.restart()).not.toThrow();
    sessionRuntime.answerServiceRestartPrompt("restartService");

    await vi.waitFor(() => {
      expect(mockRequestStartOpenCode).toHaveBeenCalled();
    });
    expect(runOpenCodeCliCommand).toHaveBeenCalledWith(
      "opencode",
      ["service", "restart"],
      15000,
    );
  });

  it("resolves instance id from session id mappings", () => {
    instanceStore.upsert({
      config: { id: "mapped-instance" },
      runtime: { terminalKey: "tk-mapped" },
      state: "disconnected",
    });

    sessionRuntime = createSessionRuntime();

    const id = sessionRuntime.resolveInstanceIdFromSessionId("mapped-instance");
    expect(id).toBe("mapped-instance");
  });

  it("returns undefined for unknown session id resolution (no fallback when multiple instances)", () => {
    const runtime = new SessionRuntime(
      terminalManager,
      captureManager,
      undefined,
      portManager,
      backendRegistry,
      undefined,
      logger,
      contextSharingService,
      opencodeOperator,
      {
        postMessage: mockPostMessage as (message: unknown) => void,
        onActiveInstanceChanged: mockOnActiveInstanceChanged as (instanceId: string) => void,
        requestStartOpenCode: mockRequestStartOpenCode as () => Promise<void>,
      },
      nativeTerminalManager,
    );

    const id = runtime.resolveInstanceIdFromSessionId("nonexistent");
    expect(id).toBe("ai-sidebar-terminal-main");
  });

  it("reports started state after startDefaultSession", async () => {
    instanceStore.upsert({
      config: { id: "default" },
      runtime: { terminalKey: "default" },
      state: "disconnected",
    });

    sessionRuntime = createSessionRuntime();

    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, defaultValue?: unknown) => {
        return defaultValue;
      }),
      update: vi.fn(),
    } as any);

    await sessionRuntime.startOpenCode();

    expect(sessionRuntime.isStartedFlag()).toBe(true);
  });

  it("gets and sets last known terminal size", () => {
    instanceStore.upsert({
      config: { id: "default" },
      runtime: { terminalKey: "default" },
      state: "disconnected",
    });

    sessionRuntime = createSessionRuntime();

    sessionRuntime.setLastKnownTerminalSize(120, 40);

    const size = sessionRuntime.getLastKnownTerminalSize();
    expect(size.cols).toBe(120);
    expect(size.rows).toBe(40);
  });

  it("disconnects and cleans up on dispose", () => {
    instanceStore.upsert({
      config: { id: "default" },
      runtime: { terminalKey: "default" },
      state: "disconnected",
    });

    sessionRuntime = createSessionRuntime();

    sessionRuntime.dispose();

    expect(sessionRuntime.getActiveSession()).toBeUndefined();
  });

  it("hasLiveTerminalProcess returns false when not started", () => {
    instanceStore.upsert({
      config: { id: "default" },
      runtime: { terminalKey: "default" },
      state: "disconnected",
    });

    sessionRuntime = createSessionRuntime();

    expect(sessionRuntime.hasLiveTerminalProcess()).toBe(false);
  });

  it("getApiClient returns undefined when HTTP is not enabled", () => {
    instanceStore.upsert({
      config: { id: "default" },
      runtime: { terminalKey: "default" },
      state: "disconnected",
    });

    sessionRuntime = createSessionRuntime();

    expect(sessionRuntime.getApiClient()).toBeUndefined();
  });

  it("isHttpAvailable returns false by default", () => {
    instanceStore.upsert({
      config: { id: "default" },
      runtime: { terminalKey: "default" },
      state: "disconnected",
    });

    sessionRuntime = createSessionRuntime();

    expect(sessionRuntime.isHttpAvailable()).toBe(false);
  });

  describe("pollForHttpReadiness", () => {
    function attachMockApiClient(runtime: SessionRuntime, behavior: {
      once?: ReturnType<typeof vi.fn>;
    }): { once: ReturnType<typeof vi.fn> } {
      const once = behavior.once ?? vi.fn().mockResolvedValue(true);
      // private field is intentionally bypassed for white-box testing of
      // the readiness loop; the apiClient contract here is just healthCheckOnce.
      (runtime as unknown as { apiClient: unknown }).apiClient = {
        healthCheckOnce: once,
      };
      return { once };
    }

    function stubSleep(runtime: SessionRuntime): void {
      // Avoid real 500 ms delays between the 30 retry attempts.
      vi.spyOn(runtime, "sleep").mockResolvedValue(undefined);
    }

    beforeEach(() => {
      instanceStore.upsert({
        config: { id: "default" },
        runtime: { terminalKey: "default" },
        state: "disconnected",
      });
      sessionRuntime = createSessionRuntime({ stubHttpPolling: false });
      stubSleep(sessionRuntime);
    });

    it("marks HTTP available when healthCheckOnce succeeds", async () => {
      const { once } = attachMockApiClient(sessionRuntime, {
        once: vi.fn().mockResolvedValue(true),
      });

      await sessionRuntime.pollForHttpReadiness();

      expect(once).toHaveBeenCalledTimes(1);
      expect(sessionRuntime.isHttpAvailable()).toBe(true);
    });

    it("retries until healthCheckOnce eventually returns true", async () => {
      const { once } = attachMockApiClient(sessionRuntime, {
        once: vi
          .fn()
          .mockResolvedValueOnce(false)
          .mockResolvedValueOnce(false)
          .mockResolvedValueOnce(true),
      });

      await sessionRuntime.pollForHttpReadiness();

      expect(once).toHaveBeenCalledTimes(3);
      expect(sessionRuntime.isHttpAvailable()).toBe(true);
    });

    it("logs each unhealthy attempt (returns false) instead of staying silent", async () => {
      const infoSpy = vi
        .spyOn(logger, "info")
        .mockImplementation(() => undefined);
      const { once } = attachMockApiClient(sessionRuntime, {
        once: vi.fn().mockResolvedValue(false),
      });

      await sessionRuntime.pollForHttpReadiness();

      // The outer loop now runs 30 attempts.
      expect(once).toHaveBeenCalledTimes(30);
      expect(sessionRuntime.isHttpAvailable()).toBe(false);
      // Every unhealthy attempt is surfaced — regression guard for the
      // previous silent-failure where healthCheck() swallowed the false.
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining("returned unhealthy"),
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining("attempt 1/30 returned unhealthy"),
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining("HTTP API not available after retries"),
      );
    });

    it("logs each thrown attempt with the underlying error message", async () => {
      const infoSpy = vi
        .spyOn(logger, "info")
        .mockImplementation(() => undefined);
      const { once } = attachMockApiClient(sessionRuntime, {
        once: vi.fn().mockRejectedValue(new Error("Connection refused")),
      });

      await sessionRuntime.pollForHttpReadiness();

      expect(once).toHaveBeenCalledTimes(30);
      expect(sessionRuntime.isHttpAvailable()).toBe(false);
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining("attempt 1/30 failed: Connection refused"),
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining("HTTP API not available after retries"),
      );
    });

    it("does not call healthCheck (which would re-trigger inner exponential backoff)", async () => {
      const once = vi.fn().mockResolvedValue(true);
      const fullClient = {
        healthCheckOnce: once,
        healthCheck: vi.fn().mockResolvedValue(true),
        appendPrompt: vi.fn().mockResolvedValue(undefined),
      };
      (sessionRuntime as unknown as { apiClient: unknown }).apiClient =
        fullClient;

      await sessionRuntime.pollForHttpReadiness();

      expect(once).toHaveBeenCalledTimes(1);
      expect(fullClient.healthCheck).not.toHaveBeenCalled();
    });

    it("no-ops when apiClient is absent", async () => {
      (sessionRuntime as unknown as { apiClient: unknown }).apiClient =
        undefined;

      await expect(
        sessionRuntime.pollForHttpReadiness(),
      ).resolves.toBeUndefined();
      expect(sessionRuntime.isHttpAvailable()).toBe(false);
    });
  });

  it("reports openCodeV2 across CLI versions, restarts, and fallbacks", async () => {
    instanceStore.upsert({
      config: { id: "default" },
      runtime: { terminalKey: "default" },
      state: "disconnected",
    });

    sessionRuntime = createSessionRuntime();
    // Route the provider callback back into the runtime so a forced
    // restart actually relaunches the session, mirroring
    // TerminalProvider.switchToInstance().
    mockRequestStartOpenCode.mockImplementation(async () => {
      await sessionRuntime.startOpenCode();
    });
    // The v1 branch assigns a port and polls readiness with real sleeps;
    // stub the poll loop — it is orthogonal to the openCodeV2 flag.
    vi.spyOn(sessionRuntime, "pollForHttpReadiness").mockResolvedValue(
      undefined,
    );

    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((key: string, defaultValue?: unknown) => {
        if (key === "httpTimeout") return 5000;
        return defaultValue;
      }),
      update: vi.fn(),
    } as any);

    const { detectOpenCodeMajorVersion, resolveOpenCodeV2Service } =
      await import("../services/OpenCodeCliCompat");
    const lastActiveSession = (): { openCodeV2?: boolean } | undefined => {
      const sessions = mockPostMessage.mock.calls
        .map((c) => c[0] as { type?: string; openCodeV2?: boolean })
        .filter((m) => m?.type === "activeSession");
      return sessions[sessions.length - 1];
    };
    const restartSession = async (): Promise<void> => {
      await sessionRuntime.switchToInstance("default", {
        forceRestart: true,
      });
    };

    // OpenCode v2 (major from --version): keymap flag on.
    vi.mocked(detectOpenCodeMajorVersion).mockResolvedValue(2);
    vi.mocked(resolveOpenCodeV2Service).mockResolvedValue(undefined);
    await sessionRuntime.startOpenCode();
    expect(lastActiveSession()?.openCodeV2).toBe(true);

    // Restart on OpenCode v1: flag must turn off.
    vi.mocked(detectOpenCodeMajorVersion).mockResolvedValue(1);
    await restartSession();
    expect(lastActiveSession()?.openCodeV2).toBe(false);

    // Version unparseable: the keymap flag stays off (no service-file fallback).
    vi.mocked(detectOpenCodeMajorVersion).mockResolvedValue(undefined);
    vi.mocked(resolveOpenCodeV2Service).mockResolvedValue({
      url: "http://127.0.0.1:4096",
      port: 4096,
      auth: "opencode:secret",
    } as any);
    await restartSession();
    expect(lastActiveSession()?.openCodeV2).toBe(false);
  });

  it("recovers the keymap flag when the v2 service appears after launch", async () => {
    vi.useFakeTimers();
    try {
      instanceStore.upsert({
        config: { id: "default" },
        runtime: { terminalKey: "default" },
        state: "disconnected",
      });

      sessionRuntime = createSessionRuntime();
      mockRequestStartOpenCode.mockImplementation(async () => {
        await sessionRuntime.startOpenCode();
      });
      vi.spyOn(sessionRuntime, "pollForHttpReadiness").mockResolvedValue(
        undefined,
      );
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: vi.fn((key: string, defaultValue?: unknown) => {
          if (key === "httpTimeout") return 5000;
          return defaultValue;
        }),
        update: vi.fn(),
      } as any);

      const {
        detectOpenCodeMajorVersion,
        detectOpenCodeApiProtocol,
        resolveOpenCodeV2Service,
      } = await import("../services/OpenCodeCliCompat");
      const sessions = () =>
        mockPostMessage.mock.calls
          .map((c) => c[0] as { type?: string; openCodeV2?: boolean })
          .filter((m) => m?.type === "activeSession");

      // Both probes fail before launch (fresh machine: CLI not on the
      // extension host PATH, no service file yet). The delayed retry then
      // sees the started TUI report v2. The start path probes the major
      // twice, so both pre-launch calls stay undefined.
      vi.mocked(detectOpenCodeMajorVersion)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(2);
      vi.mocked(detectOpenCodeApiProtocol).mockResolvedValue("v1");
      vi.mocked(resolveOpenCodeV2Service).mockResolvedValue(undefined);
      await sessionRuntime.startOpenCode();
      expect(sessions().at(-1)?.openCodeV2).toBe(false);

      // The TUI starts its background service after launch.
      vi.mocked(resolveOpenCodeV2Service).mockResolvedValue({
        url: "http://127.0.0.1:4096",
        port: 4096,
        auth: "opencode:secret",
      } as any);

      await vi.advanceTimersByTimeAsync(3100);

      // The retry resolved major=2 and re-notified the webview.
      expect(sessions().at(-1)?.openCodeV2).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

});
