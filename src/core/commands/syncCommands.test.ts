import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscodeTypes from "vscode";
import { registerSyncCommands } from "./syncCommands";
import type { ConfigSyncService } from "../../services/sync/ConfigSyncService";

const vscode = await vi.importActual<typeof import("../../test/mocks/vscode")>(
  "../../test/mocks/vscode",
);

describe("registerSyncCommands", () => {
  let registered: Map<string, (...args: unknown[]) => unknown>;
  let syncNow: ReturnType<typeof vi.fn>;
  let forcePullFromServer: ReturnType<typeof vi.fn>;
  let forcePushToServer: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    registered = new Map();
    vi.mocked(vscode.commands.registerCommand).mockImplementation(((
      id: string,
      callback: (...args: unknown[]) => unknown,
    ) => {
      registered.set(id, callback);
      return { dispose: vi.fn() };
    }) as never);
    syncNow = vi.fn(async () => undefined);
    forcePullFromServer = vi.fn(async () => undefined);
    forcePushToServer = vi.fn(async () => undefined);
  });

  it("registers the sync-now command and forwards to the service", async () => {
    const service = { syncNow } as unknown as ConfigSyncService;
    const disposables = registerSyncCommands({ configSyncService: service });

    expect(disposables).toHaveLength(4);
    expect(registered.has("opencode-cli-sidebar.webdavSyncNow")).toBe(true);

    await registered.get("opencode-cli-sidebar.webdavSyncNow")?.();
    expect(syncNow).toHaveBeenCalledTimes(1);
  });

  it("registers the one-way operations and forwards to the service", async () => {
    const service = {
      syncNow,
      forcePullFromServer,
      forcePushToServer,
    } as unknown as ConfigSyncService;
    registerSyncCommands({ configSyncService: service });

    await registered.get("opencode-cli-sidebar.webdavForcePull")?.();
    await registered.get("opencode-cli-sidebar.webdavForcePush")?.();

    expect(forcePullFromServer).toHaveBeenCalledTimes(1);
    expect(forcePushToServer).toHaveBeenCalledTimes(1);
  });

  it("forwards the pre-start skip to the injected gate", () => {
    const skipPreStartSync = vi.fn(() => true);
    registerSyncCommands({ configSyncService: undefined, skipPreStartSync });

    registered.get("opencode-cli-sidebar.skipPreStartSync")?.();
    expect(skipPreStartSync).toHaveBeenCalledTimes(1);
  });

  it("tolerates a missing service without throwing", async () => {
    const disposables = registerSyncCommands({ configSyncService: undefined });
    expect(disposables).toHaveLength(4);
    const invoke = registered.get("opencode-cli-sidebar.webdavSyncNow");
    await expect(Promise.resolve(invoke?.())).resolves.toBeUndefined();
    await expect(
      Promise.resolve(registered.get("opencode-cli-sidebar.webdavForcePull")?.()),
    ).resolves.toBeUndefined();
    await expect(
      Promise.resolve(registered.get("opencode-cli-sidebar.webdavForcePush")?.()),
    ).resolves.toBeUndefined();
  });

  it("is wired into the shared command registration", async () => {
    const { registerCommands } = await import("./index");
    const context =
      new vscode.ExtensionContext() as unknown as vscodeTypes.ExtensionContext;
    registerCommands(context, {
      provider: undefined,
      terminalManager: undefined,
      contextSharingService: undefined,
      outputChannel: undefined,
      opencodeUpdateService: undefined,
      contextManager: undefined,
      configSyncService: { syncNow } as unknown as ConfigSyncService,
      getActiveTerminalId: () => "terminal-1",
      sendTerminalCwd: () => undefined,
      sendPrompt: async () => undefined,
    });

    expect(registered.has("opencode-cli-sidebar.webdavSyncNow")).toBe(true);
  });
});
