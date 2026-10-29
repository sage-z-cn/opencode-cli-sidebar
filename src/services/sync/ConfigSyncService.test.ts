import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscodeTypes from "vscode";
import type {
  HostMessage,
  WebDavConflictEntry,
  WebDavHistoryEntry,
  WebDavServerConfig,
  WebDavSyncSnapshot,
  WebDavSyncStatusDelta,
} from "../../types";
import {
  ConfigSyncService,
  decideSyncAction,
  webdavSecretKey,
  type WebDavClientLike,
} from "./ConfigSyncService";
import { OutputChannelService } from "../OutputChannelService";
import {
  PreconditionFailedError,
  WebDavFatalError,
  WebDavRateLimitedError,
  WebDavTransientError,
  type WebDavPutConditions,
  type WebDavStat,
} from "./WebDavClient";
import { hashContent, SyncManifest, syncStorageDir } from "./SyncManifest";
import { LOCK_STALE_MS, SyncProcessLock } from "./SyncProcessLock";
import { SyncStatusStore, type SyncStatusData } from "./SyncStatusStore";

const vscode = await vi.importActual<typeof import("../../test/mocks/vscode")>(
  "../../test/mocks/vscode",
);

/** Programmable in-memory WebDAV server used by the engine tests. */
class FakeClient implements WebDavClientLike {
  public readonly files = new Map<string, { etag: string | null; content: Buffer }>();
  public readonly dirs = new Set<string>([""]);
  public failure: "fatal" | "auth" | "forbidden" | "transient" | undefined;
  /** Scripted per-attempt PUT failures, consumed in order. */
  public readonly putFailures: Array<"precondition" | "unsupported"> = [];
  /** Fired just before a scripted precondition failure, simulating a
   * competing window whose upload landed between scan and PUT. */
  public beforePreconditionFailure?: (rel: string) => void;
  /** Fired inside GET before the bytes are returned; lets a test mutate
   * the remote (etag) between the stats that bracket a verification. */
  public onGet?: (rel: string) => void;
  /** Rel paths whose remote DELETE fails with a transient error. */
  public readonly delFailures = new Set<string>();
  /** When above 0, every PUT from this call index on throws a rate-limit error. */
  public rateLimitAtPutCall = 0;
  public rateLimitRetryAfterMs: number | undefined;
  /** One record per PUT attempt with the conditions that were sent. */
  public readonly putConditions: Array<{
    rel: string;
    ifMatch?: string;
    ifNoneMatchStar?: boolean;
  }> = [];
  /** One record per DELETE attempt with the conditions that were sent. */
  public readonly delConditions: Array<{
    rel: string;
    ifMatch?: string;
  }> = [];
  public ensureBasePathCalls = 0;
  public readonly calls = {
    propfind: [] as string[],
    get: [] as string[],
    put: [] as string[],
    mkcol: [] as string[],
    del: [] as string[],
  };
  private etagCounter = 0;

  public addFile(rel: string, content: string): void {
    this.etagCounter += 1;
    this.files.set(rel, {
      etag: `"v${this.etagCounter}"`,
      content: Buffer.from(content, "utf8"),
    });
  }

  public async propfind(target: string, _depth: 0 | 1): Promise<WebDavStat[]> {
    this.calls.propfind.push(target);
    this.maybeFail();
    const entries: WebDavStat[] = [];
    const selfStat = (rel: string, isDir: boolean): WebDavStat => {
      const file = this.files.get(rel);
      return {
        path: rel,
        etag: file?.etag ?? null,
        size: file?.content.length ?? 0,
        lastModified: 1_000,
        isDir,
      };
    };
    if (this.dirs.has(target)) {
      entries.push(selfStat(target, true));
      for (const dir of this.dirs) {
        if (parentOf(dir) === target && dir !== target) {
          entries.push(selfStat(dir, true));
        }
      }
      for (const rel of this.files.keys()) {
        if (parentOf(rel) === target) {
          entries.push(selfStat(rel, false));
        }
      }
    } else if (this.files.has(target)) {
      entries.push(selfStat(target, false));
    } else {
      throw new WebDavTransientError("not found", 404);
    }
    return entries;
  }

  public async get(rel: string): Promise<Buffer> {
    this.calls.get.push(rel);
    this.maybeFail();
    this.onGet?.(rel);
    const file = this.files.get(rel);
    if (!file) {
      throw new WebDavTransientError("not found", 404);
    }
    return Buffer.from(file.content);
  }

  public async put(
    rel: string,
    content: Buffer,
    conditions?: WebDavPutConditions,
  ): Promise<void> {
    this.calls.put.push(rel);
    this.putConditions.push({
      rel,
      ifMatch: conditions?.ifMatch,
      ifNoneMatchStar: conditions?.ifNoneMatchStar,
    });
    this.maybeFail();
    if (
      this.rateLimitAtPutCall > 0 &&
      this.calls.put.length >= this.rateLimitAtPutCall
    ) {
      throw new WebDavRateLimitedError(
        "too many requests",
        503,
        this.rateLimitRetryAfterMs,
      );
    }
    const failure = this.putFailures.shift();
    if (failure === "precondition") {
      this.beforePreconditionFailure?.(rel);
      throw new PreconditionFailedError("precondition failed", 412);
    }
    if (failure === "unsupported") {
      throw new WebDavTransientError("conditional not supported", 400);
    }
    if (conditions?.ifMatch !== undefined) {
      const current = this.files.get(rel);
      if (!current || current.etag !== conditions.ifMatch) {
        throw new PreconditionFailedError("precondition failed", 412);
      }
    }
    if (conditions?.ifNoneMatchStar && this.files.has(rel)) {
      throw new PreconditionFailedError("precondition failed", 412);
    }
    this.etagCounter += 1;
    this.files.set(rel, { etag: `"v${this.etagCounter}"`, content });
  }

  public async mkcol(rel: string): Promise<void> {
    this.calls.mkcol.push(rel);
    this.maybeFail();
    if (this.dirs.has(rel)) {
      throw new WebDavTransientError("already exists", 405);
    }
    this.dirs.add(rel);
  }

  public async del(
    rel: string,
    conditions?: { ifMatch?: string },
  ): Promise<void> {
    this.calls.del.push(rel);
    this.delConditions.push({ rel, ifMatch: conditions?.ifMatch });
    this.maybeFail();
    if (this.delFailures.has(rel)) {
      throw new WebDavTransientError("delete blocked", 502);
    }
    if (conditions?.ifMatch !== undefined) {
      const current = this.files.get(rel);
      if (!current || current.etag !== conditions.ifMatch) {
        throw new PreconditionFailedError("precondition failed", 412);
      }
    }
    this.files.delete(rel);
    this.dirs.delete(rel);
  }

  public async ensureBasePath(): Promise<void> {
    this.ensureBasePathCalls += 1;
    this.dirs.add("");
  }

  private maybeFail(): void {
    if (this.failure === "fatal") {
      throw new WebDavFatalError("boom");
    }
    if (this.failure === "auth") {
      throw new WebDavFatalError(
        "WebDAV server rejected the credentials with status 401",
        401,
      );
    }
    if (this.failure === "forbidden") {
      throw new WebDavFatalError(
        "WebDAV server rejected the credentials with status 403",
        403,
      );
    }
    if (this.failure === "transient") {
      throw new WebDavTransientError("network down", 502);
    }
  }
}

function parentOf(rel: string): string {
  const index = rel.lastIndexOf("/");
  return index === -1 ? "" : rel.slice(0, index);
}

function makeContext(storageDir: string): vscodeTypes.ExtensionContext {
  const context = new vscode.ExtensionContext();
  context.globalStorageUri = {
    fsPath: storageDir,
    path: storageDir,
  } as unknown as vscodeTypes.Uri;
  const state = new Map<string, unknown>();
  context.globalState.get = vi.fn(((key: string) =>
    state.get(key)) as never);
  context.globalState.update = vi.fn(
    (async (key: string, value: unknown) => {
      state.set(key, value);
    }) as never,
  );
  context.secrets.get = vi.fn(async () => "stored-password");
  return context;
}

/** Watcher creations targeting the config directory (the recursive glob
 * pattern "**" plus "/*"). Other watchers, e.g. the shared status file,
 * do not count. */
function configDirWatcherCalls(): number {
  const calls = vi.mocked(vscode.workspace.createFileSystemWatcher).mock
    .calls as unknown as Array<[unknown]>;
  return calls.filter(
    ([pattern]) =>
      (pattern as { pattern?: string } | undefined)?.pattern === "**/*",
  ).length;
}

describe("ConfigSyncService decision matrix", () => {
  const H = (name: string) => `hash-${name}`;

  it("returns none when nothing exists and no baseline", () => {
    expect(
      decideSyncAction({
        localHash: null,
        remoteHash: null,
        baselineHash: null,
        onConflict: "prompt",
        deletions: "prompt",
      }),
    ).toEqual({ type: "none" });
  });

  it("forgets entries deleted on both sides", () => {
    expect(
      decideSyncAction({
        localHash: null,
        remoteHash: null,
        baselineHash: H("base"),
        onConflict: "prompt",
        deletions: "prompt",
      }),
    ).toEqual({ type: "forget" });
  });

  it("treats equal content as agreed", () => {
    expect(
      decideSyncAction({
        localHash: H("same"),
        remoteHash: H("same"),
        baselineHash: H("other"),
        onConflict: "prompt",
        deletions: "prompt",
      }),
    ).toEqual({ type: "agree" });
  });

  it("uploads when only the local side changed", () => {
    expect(
      decideSyncAction({
        localHash: H("newLocal"),
        remoteHash: H("base"),
        baselineHash: H("base"),
        onConflict: "prompt",
        deletions: "prompt",
      }),
    ).toEqual({ type: "upload" });
  });

  it("downloads when only the remote side changed", () => {
    expect(
      decideSyncAction({
        localHash: H("base"),
        remoteHash: H("newRemote"),
        baselineHash: H("base"),
        onConflict: "prompt",
        deletions: "prompt",
      }),
    ).toEqual({ type: "download" });
  });

  it("surfaces a content conflict when both sides changed", () => {
    expect(
      decideSyncAction({
        localHash: H("local"),
        remoteHash: H("remote"),
        baselineHash: H("base"),
        onConflict: "prompt",
        deletions: "prompt",
      }),
    ).toEqual({ type: "conflict", kind: "content" });
    expect(
      decideSyncAction({
        localHash: H("local"),
        remoteHash: H("remote"),
        baselineHash: H("base"),
        onConflict: "preferLocal",
        deletions: "prompt",
      }),
    ).toEqual({ type: "upload" });
    expect(
      decideSyncAction({
        localHash: H("local"),
        remoteHash: H("remote"),
        baselineHash: H("base"),
        onConflict: "preferRemote",
        deletions: "prompt",
      }),
    ).toEqual({ type: "download" });
  });

  it("conflicts on new files that differ on both sides", () => {
    expect(
      decideSyncAction({
        localHash: H("local"),
        remoteHash: H("remote"),
        baselineHash: null,
        onConflict: "prompt",
        deletions: "prompt",
      }),
    ).toEqual({ type: "conflict", kind: "content", reason: "noBaseline" });
  });

  it("conflicts on first-sync differences even with a non-prompt policy", () => {
    for (const onConflict of ["preferLocal", "preferRemote"] as const) {
      expect(
        decideSyncAction({
          localHash: H("local"),
          remoteHash: H("remote"),
          baselineHash: null,
          onConflict,
          deletions: "prompt",
        }),
      ).toEqual({ type: "conflict", kind: "content", reason: "noBaseline" });
    }
  });

  it("conflicts as remoteDeleted when the remote copy vanished", () => {
    const input = {
      localHash: H("local"),
      remoteHash: null,
      baselineHash: H("base"),
      onConflict: "prompt",
      deletions: "prompt",
    } as const;
    expect(decideSyncAction({ ...input, deletions: "prompt" })).toEqual({
      type: "conflict",
      kind: "remoteDeleted",
    });
    // Only an unchanged local copy may be frozen out by the ignore
    // policy; edits always surface the deletion.
    expect(
      decideSyncAction({
        ...input,
        localHash: H("base"),
        deletions: "ignore",
      }),
    ).toEqual({ type: "skip" });
  });

  it("still conflicts on remote deletion with local edits under the ignore policy", () => {
    expect(
      decideSyncAction({
        localHash: H("edited"),
        remoteHash: null,
        baselineHash: H("base"),
        onConflict: "prompt",
        deletions: "ignore",
      }),
    ).toEqual({ type: "conflict", kind: "remoteDeleted" });
    expect(
      decideSyncAction({
        localHash: H("base"),
        remoteHash: null,
        baselineHash: H("base"),
        onConflict: "prompt",
        deletions: "ignore",
      }),
    ).toEqual({ type: "skip" });
  });

  it("conflicts as localDeleted when the local copy vanished", () => {
    const input = {
      localHash: null,
      remoteHash: H("remote"),
      baselineHash: H("base"),
      onConflict: "prompt",
      deletions: "prompt",
    } as const;
    expect(decideSyncAction({ ...input, deletions: "prompt" })).toEqual({
      type: "conflict",
      kind: "localDeleted",
    });
    expect(decideSyncAction({ ...input, deletions: "ignore" })).toEqual({
      type: "skip",
    });
  });

  it("propagates a deletion to the unchanged survivor under the propagate policy", () => {
    expect(
      decideSyncAction({
        localHash: null,
        remoteHash: H("base"),
        baselineHash: H("base"),
        onConflict: "prompt",
        deletions: "propagate",
      }),
    ).toEqual({ type: "deleteRemote" });
    expect(
      decideSyncAction({
        localHash: H("base"),
        remoteHash: null,
        baselineHash: H("base"),
        onConflict: "prompt",
        deletions: "propagate",
      }),
    ).toEqual({ type: "deleteLocal" });
  });

  it("keeps a conflict when the survivor moved after the deletion", () => {
    expect(
      decideSyncAction({
        localHash: null,
        remoteHash: H("newer"),
        baselineHash: H("base"),
        onConflict: "prompt",
        deletions: "propagate",
      }),
    ).toEqual({
      type: "conflict",
      kind: "localDeleted",
      reason: "remoteChanged",
    });
    expect(
      decideSyncAction({
        localHash: H("edited"),
        remoteHash: null,
        baselineHash: H("base"),
        onConflict: "prompt",
        deletions: "propagate",
      }),
    ).toEqual({ type: "conflict", kind: "remoteDeleted" });
  });

  it("never propagates a deletion without a baseline", () => {
    expect(
      decideSyncAction({
        localHash: null,
        remoteHash: H("remote"),
        baselineHash: null,
        onConflict: "prompt",
        deletions: "propagate",
      }),
    ).toEqual({ type: "download" });
    expect(
      decideSyncAction({
        localHash: H("local"),
        remoteHash: null,
        baselineHash: null,
        onConflict: "prompt",
        deletions: "propagate",
      }),
    ).toEqual({ type: "upload" });
  });

  it("uploads brand-new local files and downloads brand-new remote files", () => {
    expect(
      decideSyncAction({
        localHash: H("local"),
        remoteHash: null,
        baselineHash: null,
        onConflict: "prompt",
        deletions: "prompt",
      }),
    ).toEqual({ type: "upload" });
    expect(
      decideSyncAction({
        localHash: null,
        remoteHash: H("remote"),
        baselineHash: null,
        onConflict: "prompt",
        deletions: "prompt",
      }),
    ).toEqual({ type: "download" });
  });
});

describe("ConfigSyncService engine", () => {
  let storageDir: string;
  let configDir: string;
  let previousConfigDir: string | undefined;
  let settings: Record<string, unknown>;
  let client: FakeClient;
  let service: ConfigSyncService;
  let posted: HostMessage[];
  let deltas: WebDavSyncStatusDelta[];
  let logger: OutputChannelService;
  let clientFactoryCalls: number;

  function writeLocal(rel: string, content: string): void {
    const abs = path.join(configDir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }

  function readLocal(rel: string): string {
    return fs.readFileSync(path.join(configDir, ...rel.split("/")), "utf8");
  }

  function backupCount(rel: string): number {
    const dir = path.join(syncStorageDir(storageDir), "backups", ...parentOf(rel) ? parentOf(rel).split("/") : []);
    if (!fs.existsSync(dir)) {
      return 0;
    }
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(path.basename(rel))).length;
  }

  beforeEach(() => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-syncstore-"));
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-syncconf-"));
    previousConfigDir = process.env.OPENCODE_CONFIG_DIR;
    process.env.OPENCODE_CONFIG_DIR = configDir;

    settings = {
      "sync.enabled": true,
      "sync.url": "https://dav.test",
      "sync.username": "user",
      "sync.basePath": "/opencode-config/",
      "sync.autoSyncEnabled": false,
      "sync.autoSyncOnStartup": false,
      "sync.autoSyncOnLocalChange": false,
      "sync.autoSyncRemotePoll": false,
      "sync.pollIntervalMinutes": 30,
      "sync.customItems": [],
      "sync.disabledItems": [],
      "sync.onConflict": "prompt",
      "sync.deletions": "prompt",
    };
    vi.mocked(vscode.workspace.getConfiguration).mockImplementation(((
      _section?: string,
    ) => ({
      get: (key: string, defaultValue?: unknown) =>
        key in settings ? settings[key] : defaultValue,
      inspect: () => undefined,
      update: async (key: string, value: unknown) => {
        settings[key] = value;
      },
    })) as never);

    client = new FakeClient();
    posted = [];
    deltas = [];
    clientFactoryCalls = 0;
    logger = OutputChannelService.getInstance();
    service = new ConfigSyncService(makeContext(storageDir), {
      logger,
      postWebviewMessage: (message) => {
        posted.push(message);
      },
      isWebviewVisible: () => true,
      clientFactory: () => {
        clientFactoryCalls += 1;
        return client;
      },
    });
    service.onDidChange((delta) => {
      deltas.push(delta);
    });
  });

  afterEach(async () => {
    // Drain any fire-and-forget reconciliation pass before the temp dirs
    // vanish: a mid-flight pass reloads an emptied manifest, re-downloads
    // "remote-only" files and would resolve paths against the NEXT test's
    // config dir.
    const internal = service as unknown as { syncing: boolean };
    const drainDeadline = Date.now() + 5000;
    while (internal.syncing && Date.now() < drainDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    service.dispose();
    OutputChannelService.resetInstance();
    if (previousConfigDir === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR;
    } else {
      process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
    }
    fs.rmSync(storageDir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it("uploads new and changed local files and refreshes the etag baseline", async () => {
    writeLocal("cli.json", "one");
    await service.syncNow();

    expect(client.calls.put).toEqual(["cli.json"]);
    expect(client.files.get("cli.json")?.content.toString()).toBe("one");
    const manifestPath = path.join(syncStorageDir(storageDir), "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(manifest.files["cli.json"].baselineHash).toBe(
      hashContent(Buffer.from("one", "utf8")),
    );
    expect(manifest.files["cli.json"].remoteEtag).toBe(
      client.files.get("cli.json")?.etag,
    );

    // Second pass with no changes: no transfers.
    client.calls.put.length = 0;
    await service.syncNow();
    expect(client.calls.put).toEqual([]);
  });

  it("records no-op passes for every trigger including polls", async () => {
    // Deterministic clock so the second run's lastSyncAt is provably new.
    let clock = 1_700_000_000_000;
    const nowSpy = vi
      .spyOn(Date, "now")
      .mockImplementation(() => (clock += 1_000));
    const internal = service as unknown as {
      triggerAuto: (trigger: string) => Promise<void>;
      isLeader: boolean;
    };
    // Automatic passes require leadership; this test targets pass
    // recording, not the election.
    internal.isLeader = true;
    try {
      writeLocal("cli.json", "one");
      await service.syncNow();
      let snapshot = await service.getSnapshot();
      expect(snapshot.history).toHaveLength(1);
      expect(snapshot.history[0]).toMatchObject({
        direction: "up",
        files: 1,
        uploads: 1,
        downloads: 0,
        deletes: 0,
        result: "success",
        trigger: "manual",
      });
      const firstSyncAt = snapshot.lastSyncAt;

      // Manual no-op: no uploads, downloads, conflicts, or errors, but the
      // run is still recorded so the user sees the sync happened.
      client.calls.put.length = 0;
      await service.syncNow();
      expect(client.calls.put).toEqual([]);
      snapshot = await service.getSnapshot();
      expect(snapshot.history).toHaveLength(2);
      expect(snapshot.history[0]).toMatchObject({
        direction: "none",
        files: 0,
        uploads: 0,
        downloads: 0,
        deletes: 0,
        result: "success",
        trigger: "manual",
      });
      // The idle delta still refreshes the "last sync" timestamp/label.
      expect(snapshot.lastSyncAt).toBeGreaterThan(firstSyncAt ?? 0);
      expect(snapshot.lastSyncLabel).toBeTruthy();
      const idleDelta = [...deltas]
        .reverse()
        .find((delta) => delta.lastSyncAt === snapshot.lastSyncAt);
      expect(idleDelta?.lastSyncLabel).toBeTruthy();

      // Poll-triggered no-op: recorded like every other completed run.
      await internal.triggerAuto("poll");
      expect(client.calls.put).toEqual([]);
      snapshot = await service.getSnapshot();
      expect(snapshot.history).toHaveLength(3);
      expect(snapshot.history[0]).toMatchObject({
        direction: "none",
        files: 0,
        uploads: 0,
        downloads: 0,
        deletes: 0,
        result: "success",
        trigger: "poll",
      });

      // A poll-triggered pass with activity records its trigger.
      writeLocal("AGENTS.md", "two");
      await internal.triggerAuto("poll");
      snapshot = await service.getSnapshot();
      expect(snapshot.history).toHaveLength(4);
      expect(snapshot.history[0]).toMatchObject({
        direction: "up",
        files: 1,
        uploads: 1,
        downloads: 0,
        deletes: 0,
        result: "success",
        trigger: "poll",
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("pushes one full snapshot per completed run so history updates reach the panel", async () => {
    const syncData = () =>
      posted.filter(
        (m): m is Extract<HostMessage, { type: "webdavSyncData" }> =>
          m.type === "webdavSyncData",
      );

    writeLocal("cli.json", "one");
    await service.syncNow();
    let messages = syncData();
    expect(messages).toHaveLength(1);
    expect(messages[0].snapshot.history[0]).toMatchObject({
      direction: "up",
      files: 1,
      result: "success",
      trigger: "manual",
    });

    // Manual no-op run: exactly one more snapshot carrying the freshly
    // recorded no-op entry and the refreshed last-sync timestamp.
    const previous = messages[0].snapshot;
    const previousSyncAt = previous.lastSyncAt;
    await service.syncNow();
    messages = syncData();
    expect(messages).toHaveLength(2);
    expect(messages[1].snapshot.history).toHaveLength(
      previous.history.length + 1,
    );
    expect(messages[1].snapshot.history[0]).toMatchObject({
      direction: "none",
      files: 0,
      result: "success",
      trigger: "manual",
    });
    expect(messages[1].snapshot.lastSyncAt ?? 0).toBeGreaterThan(
      previousSyncAt ?? 0,
    );
  });

  it("pushes a full snapshot after a failed run too", async () => {
    writeLocal("cli.json", "v1");
    client.failure = "transient";
    await service.syncNow();
    const messages = posted.filter((m) => m.type === "webdavSyncData");
    expect(messages).toHaveLength(1);
    const { snapshot } = messages[0] as {
      snapshot: WebDavSyncSnapshot;
    };
    expect(snapshot.state).toBe("error");
    expect(snapshot.history[0]).toMatchObject({
      result: "failed",
      trigger: "manual",
    });
  });

  it("clears the persisted history and pushes an empty snapshot", async () => {
    writeLocal("cli.json", "one");
    await service.syncNow();
    writeLocal("AGENTS.md", "two");
    await service.syncNow();
    let snapshot = await service.getSnapshot();
    expect(snapshot.history.length).toBeGreaterThanOrEqual(2);

    await service.clearHistory();

    snapshot = await service.getSnapshot();
    expect(snapshot.history).toEqual([]);
    // The persisted list was emptied, not just the in-memory mirror.
    const internal = service as unknown as {
      context: { globalState: { get: (key: string) => unknown } };
    };
    expect(internal.context.globalState.get("webdavSync.history")).toEqual([]);
    // The panel refresh push carries the emptied list.
    const pushed = posted
      .filter((m) => m.type === "webdavSyncData")
      .pop() as { snapshot: WebDavSyncSnapshot };
    expect(pushed.snapshot.history).toEqual([]);
    await service.requestLog();
    const logMessage = posted
      .filter((m) => m.type === "webdavLog")
      .pop() as { lines: string[] };
    expect(
      logMessage.lines.some((line) => line.includes("sync history cleared")),
    ).toBe(true);
  });

  it("downloads remote changes over unchanged locals and backs the local file up", async () => {
    writeLocal("cli.json", "v1");
    client.addFile("cli.json", "v1");
    await service.syncNow(); // establishes the baseline

    client.addFile("cli.json", "v2");
    await service.syncNow();

    expect(readLocal("cli.json")).toBe("v2");
    expect(backupCount("cli.json")).toBe(1);
    const noticeDelta = deltas.find((delta) => delta.notice);
    expect(noticeDelta?.notice).toBeTruthy();
  });

  it("keeps only the five most recent backups per file", async () => {
    writeLocal("cli.json", "v0");
    client.addFile("cli.json", "v0");
    await service.syncNow();
    for (let round = 1; round <= 7; round += 1) {
      client.addFile("cli.json", `v${round}`);
      await service.syncNow();
    }
    expect(readLocal("cli.json")).toBe("v7");
    expect(backupCount("cli.json")).toBe(5);
  });

  it("records all three conflict kinds without touching either side", async () => {
    writeLocal("cli.json", "base");
    client.addFile("cli.json", "base");
    writeLocal("AGENTS.md", "base");
    client.addFile("AGENTS.md", "base");
    writeLocal("opencode.json", "base");
    client.addFile("opencode.json", "base");
    await service.syncNow();

    // content conflict: both sides changed
    writeLocal("cli.json", "local-new");
    client.addFile("cli.json", "remote-new");
    // remoteDeleted: remote copy removed
    client.files.delete("AGENTS.md");
    // localDeleted: local copy removed
    fs.rmSync(path.join(configDir, "opencode.json"));

    client.calls.put.length = 0;
    client.calls.del.length = 0;
    await service.syncNow();

    expect(client.calls.put).toEqual([]);
    expect(client.calls.del).toEqual([]);
    const snapshot = await service.getSnapshot();
    const kinds = snapshot.conflicts
      .map((conflict) => `${conflict.kind}:${conflict.path}`)
      .sort();
    expect(kinds).toEqual([
      "content:cli.json",
      "localDeleted:opencode.json",
      "remoteDeleted:AGENTS.md",
    ]);
    expect(readLocal("cli.json")).toBe("local-new");
    expect(snapshot.conflictCount).toBe(3);
  });

  it("resolves a content conflict in favor of the remote side with a backup", async () => {
    writeLocal("cli.json", "base");
    client.addFile("cli.json", "base");
    await service.syncNow();
    writeLocal("cli.json", "local-new");
    client.addFile("cli.json", "remote-new");
    await service.syncNow();

    const [conflict] = (await service.getSnapshot()).conflicts;
    expect(conflict?.kind).toBe("content");
    await service.resolveConflict(conflict.id, "remote");

    expect(readLocal("cli.json")).toBe("remote-new");
    expect(backupCount("cli.json")).toBe(1);
    expect((await service.getSnapshot()).conflicts).toEqual([]);
    await service.syncNow();
    const snapshot = await service.getSnapshot();
    expect(snapshot.conflicts).toEqual([]);
  });

  it("resolves a batch of conflicts with one snapshot refresh", async () => {
    writeLocal("cli.json", "base");
    client.addFile("cli.json", "base");
    writeLocal("AGENTS.md", "base");
    client.addFile("AGENTS.md", "base");
    await service.syncNow();

    writeLocal("cli.json", "local-cli");
    client.addFile("cli.json", "remote-cli");
    writeLocal("AGENTS.md", "local-agents");
    client.addFile("AGENTS.md", "remote-agents");
    await service.syncNow();

    const conflicts = (await service.getSnapshot()).conflicts;
    expect(conflicts).toHaveLength(2);
    posted.length = 0;
    deltas.length = 0;

    await service.resolveConflicts(
      [...conflicts.map((conflict) => conflict.id), "missing:id"],
      "remote",
    );

    expect(readLocal("cli.json")).toBe("remote-cli");
    expect(readLocal("AGENTS.md")).toBe("remote-agents");
    expect(backupCount("cli.json")).toBe(1);
    expect(backupCount("AGENTS.md")).toBe(1);
    expect((await service.getSnapshot()).conflicts).toEqual([]);
    // One refresh for the whole selection, not one per file.
    expect(
      posted.filter((message) => message.type === "webdavSyncData"),
    ).toHaveLength(1);
    expect(
      deltas.filter((delta) => delta.conflictCount !== undefined),
    ).toEqual([{ conflictCount: 0 }]);
  });

  it("resolves a remoteDeleted conflict by deleting the local copy", async () => {
    writeLocal("cli.json", "base");
    client.addFile("cli.json", "base");
    await service.syncNow();
    client.files.delete("cli.json");
    await service.syncNow();

    const [conflict] = (await service.getSnapshot()).conflicts;
    expect(conflict?.kind).toBe("remoteDeleted");

    await service.resolveConflict(conflict.id, "remote");
    expect(fs.existsSync(path.join(configDir, "cli.json"))).toBe(false);
    // The backup keeps a copy instead of silently destroying data.
    expect(backupCount("cli.json")).toBe(1);
  });

  it("resolves a localDeleted conflict by restoring the remote copy", async () => {
    writeLocal("cli.json", "base");
    client.addFile("cli.json", "base");
    await service.syncNow();
    fs.rmSync(path.join(configDir, "cli.json"));
    await service.syncNow();

    const [conflict] = (await service.getSnapshot()).conflicts;
    expect(conflict?.kind).toBe("localDeleted");

    await service.resolveConflict(conflict.id, "remote");
    expect(readLocal("cli.json")).toBe("base");
  });

  it("keeps local on a content conflict using the ETag the user reviewed", async () => {
    writeLocal("cli.json", "base");
    client.addFile("cli.json", "base");
    await service.syncNow();
    writeLocal("cli.json", "local-new");
    client.addFile("cli.json", "remote-new");
    await service.syncNow();

    const [conflict] = (await service.getSnapshot()).conflicts;
    expect(conflict?.kind).toBe("content");
    client.putConditions.length = 0;

    await service.resolveConflict(conflict.id, "local");

    expect(client.putConditions).toEqual([
      {
        rel: "cli.json",
        ifMatch: conflict.remoteEtag,
        ifNoneMatchStar: undefined,
      },
    ]);
    expect(client.files.get("cli.json")?.content.toString()).toBe("local-new");
    expect((await service.getSnapshot()).conflicts).toEqual([]);
  });

  it("re-conflicts instead of overwriting a remote changed after detection", async () => {
    writeLocal("cli.json", "base");
    client.addFile("cli.json", "base");
    await service.syncNow();
    writeLocal("cli.json", "local-new");
    client.addFile("cli.json", "remote-new");
    await service.syncNow();

    const [conflict] = (await service.getSnapshot()).conflicts;
    client.addFile("cli.json", "remote-newer");
    client.putConditions.length = 0;

    await service.resolveConflict(conflict.id, "local");

    expect(client.putConditions).toEqual([]);
    expect(client.files.get("cli.json")?.content.toString()).toBe(
      "remote-newer",
    );
    const snapshot = await service.getSnapshot();
    expect(snapshot.conflicts).toHaveLength(1);
    expect(snapshot.conflicts[0]).toMatchObject({
      kind: "content",
      reason: "remoteChanged",
    });
  });

  it("resolves a localDeleted conflict with a guarded remote delete", async () => {
    writeLocal("cli.json", "base");
    client.addFile("cli.json", "base");
    await service.syncNow();
    fs.rmSync(path.join(configDir, "cli.json"));
    await service.syncNow();

    const [conflict] = (await service.getSnapshot()).conflicts;
    expect(conflict?.kind).toBe("localDeleted");
    client.delConditions.length = 0;

    await service.resolveConflict(conflict.id, "local");

    expect(client.delConditions).toEqual([
      { rel: "cli.json", ifMatch: conflict.remoteEtag },
    ]);
    expect(client.files.has("cli.json")).toBe(false);
    expect((await service.getSnapshot()).conflicts).toEqual([]);
  });

  it("keeps a localDeleted conflict when the remote changed before resolution", async () => {
    writeLocal("cli.json", "base");
    client.addFile("cli.json", "base");
    await service.syncNow();
    fs.rmSync(path.join(configDir, "cli.json"));
    await service.syncNow();

    const [conflict] = (await service.getSnapshot()).conflicts;
    client.addFile("cli.json", "remote-newer");
    client.calls.del.length = 0;

    await service.resolveConflict(conflict.id, "local");

    expect(client.calls.del).toEqual([]);
    expect(client.files.get("cli.json")?.content.toString()).toBe(
      "remote-newer",
    );
    const snapshot = await service.getSnapshot();
    expect(snapshot.conflicts[0]).toMatchObject({
      kind: "localDeleted",
      reason: "remoteChanged",
    });
  });

  it("keeps a remoteDeleted conflict when another device recreated the file", async () => {
    writeLocal("cli.json", "base");
    client.addFile("cli.json", "base");
    await service.syncNow();
    client.files.delete("cli.json");
    await service.syncNow();

    const [conflict] = (await service.getSnapshot()).conflicts;
    expect(conflict?.kind).toBe("remoteDeleted");
    client.addFile("cli.json", "recreated");
    client.putConditions.length = 0;

    await service.resolveConflict(conflict.id, "local");

    expect(client.putConditions).toEqual([]);
    expect(client.files.get("cli.json")?.content.toString()).toBe("recreated");
    const snapshot = await service.getSnapshot();
    expect(snapshot.conflicts[0]).toMatchObject({
      kind: "content",
      reason: "remoteChanged",
    });
  });

  it("records the pre-read ETag so a remote edit during download is re-fetched", async () => {    writeLocal("cli.json", "base");
    client.addFile("cli.json", "base");
    await service.syncNow();
    writeLocal("cli.json", "local-new");
    client.addFile("cli.json", "remote-new");
    await service.syncNow();

    const [conflict] = (await service.getSnapshot()).conflicts;
    const originalGet = client.get.bind(client);
    let mutated = false;
    client.get = async (rel: string) => {
      const content = await originalGet(rel);
      if (!mutated && rel === "cli.json") {
        mutated = true;
        client.addFile("cli.json", "remote-newer");
      }
      return content;
    };

    await service.resolveConflict(conflict.id, "remote");
    expect(readLocal("cli.json")).toBe("remote-new");

    await service.syncNow();
    expect(readLocal("cli.json")).toBe("remote-newer");
  });

  it("skips deletion handling entirely under the ignore policy", async () => {
    writeLocal("cli.json", "base");
    client.addFile("cli.json", "base");
    await service.syncNow();
    settings["sync.deletions"] = "ignore";
    client.files.delete("cli.json");

    await service.syncNow();
    const snapshot = await service.getSnapshot();
    expect(snapshot.conflicts).toEqual([]);
    expect(readLocal("cli.json")).toBe("base");
  });

  it("propagates a local deletion to the server under the propagate policy", async () => {
    writeLocal("cli.json", "base");
    client.addFile("cli.json", "base");
    await service.syncNow();
    settings["sync.deletions"] = "propagate";
    fs.rmSync(path.join(configDir, "cli.json"));

    await service.syncNow();

    expect(client.calls.del).toEqual(["cli.json"]);
    expect(client.files.has("cli.json")).toBe(false);
    const snapshot = await service.getSnapshot();
    expect(snapshot.conflicts).toEqual([]);
    expect(snapshot.history[0]).toMatchObject({ deletes: 1, result: "success" });
    const manifest = JSON.parse(
      fs.readFileSync(path.join(syncStorageDir(storageDir), "manifest.json"), "utf8"),
    );
    expect(manifest.files["cli.json"]).toBeUndefined();
  });

  it("keeps the server copy when it changed after the local deletion", async () => {
    writeLocal("cli.json", "base");
    client.addFile("cli.json", "base");
    await service.syncNow();
    settings["sync.deletions"] = "propagate";
    fs.rmSync(path.join(configDir, "cli.json"));
    client.addFile("cli.json", "remote-newer");

    await service.syncNow();

    expect(client.calls.del).toEqual([]);
    expect(client.files.get("cli.json")?.content.toString()).toBe(
      "remote-newer",
    );
    const snapshot = await service.getSnapshot();
    expect(snapshot.conflicts[0]).toMatchObject({
      kind: "localDeleted",
      reason: "remoteChanged",
    });
  });

  it("propagates a remote deletion locally only after a backup", async () => {
    writeLocal("cli.json", "base");
    client.addFile("cli.json", "base");
    await service.syncNow();
    settings["sync.deletions"] = "propagate";
    client.files.delete("cli.json");

    await service.syncNow();

    expect(fs.existsSync(path.join(configDir, "cli.json"))).toBe(false);
    expect(backupCount("cli.json")).toBe(1);
    const snapshot = await service.getSnapshot();
    expect(snapshot.conflicts).toEqual([]);
    expect(snapshot.history[0]).toMatchObject({ deletes: 1 });
  });

  it("auto-resolves both-changed files according to the conflict policy", async () => {
    writeLocal("cli.json", "base");
    client.addFile("cli.json", "base");
    await service.syncNow();
    writeLocal("cli.json", "local-new");
    client.addFile("cli.json", "remote-new");

    settings["sync.onConflict"] = "preferLocal";
    await service.syncNow();
    expect(client.files.get("cli.json")?.content.toString()).toBe("local-new");

    writeLocal("cli.json", "local2");
    client.addFile("cli.json", "remote2");
    settings["sync.onConflict"] = "preferRemote";
    await service.syncNow();
    expect(readLocal("cli.json")).toBe("remote2");
  });

  it("records a conflict instead of auto-winning a first sync without baseline", async () => {
    settings["sync.onConflict"] = "preferLocal";
    writeLocal("cli.json", "local-new");
    client.addFile("cli.json", "remote-old");

    await service.syncNow();

    expect(client.calls.put).toEqual([]);
    expect(readLocal("cli.json")).toBe("local-new");
    expect(client.files.get("cli.json")?.content.toString()).toBe("remote-old");
    const snapshot = await service.getSnapshot();
    expect(snapshot.conflicts[0]).toMatchObject({
      kind: "content",
      reason: "noBaseline",
    });
  });

  it("refuses to overwrite a local file when the backup fails", async () => {
    writeLocal("cli.json", "v1");
    client.addFile("cli.json", "v1");
    await service.syncNow();

    // Break the backup destination: a file where the backup directory
    // belongs makes every copy attempt fail.
    fs.mkdirSync(syncStorageDir(storageDir), { recursive: true });
    fs.writeFileSync(path.join(syncStorageDir(storageDir), "backups"), "x");
    client.addFile("cli.json", "v2");

    await service.syncNow();

    expect(readLocal("cli.json")).toBe("v1");
    expect(client.files.get("cli.json")?.content.toString()).toBe("v2");
    const snapshot = await service.getSnapshot();
    expect(snapshot.conflicts[0]).toMatchObject({
      kind: "content",
      reason: "backupFailed",
    });
  });

  it("keeps a remoteDeleted conflict when the pre-delete backup fails", async () => {
    writeLocal("cli.json", "base");
    client.addFile("cli.json", "base");
    await service.syncNow();
    client.files.delete("cli.json");
    await service.syncNow();

    fs.mkdirSync(syncStorageDir(storageDir), { recursive: true });
    fs.writeFileSync(path.join(syncStorageDir(storageDir), "backups"), "x");
    const [conflict] = (await service.getSnapshot()).conflicts;
    expect(conflict?.kind).toBe("remoteDeleted");

    await service.resolveConflict(conflict.id, "remote");
    expect(fs.existsSync(path.join(configDir, "cli.json"))).toBe(true);
    expect(readLocal("cli.json")).toBe("base");
    const snapshot = await service.getSnapshot();
    expect(snapshot.conflicts.map((entry) => entry.reason)).toEqual([
      "backupFailed",
    ]);
  });

  it("serializes conflict resolution against a running sync pass", async () => {
    writeLocal("cli.json", "base");
    client.addFile("cli.json", "base");
    await service.syncNow();
    fs.rmSync(path.join(configDir, "cli.json"));
    await service.syncNow();
    const [conflict] = (await service.getSnapshot()).conflicts;
    expect(conflict?.kind).toBe("localDeleted");

    let releaseDel: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseDel = resolve;
    });
    let delEntered = false;
    const originalDel = client.del.bind(client);
    client.del = async (rel: string) => {
      delEntered = true;
      await blocked;
      return originalDel(rel);
    };

    const resolving = service.resolveConflict(conflict.id, "local");
    await vi.waitFor(() => {
      if (!delEntered) {
        throw new Error("conflict resolution has not started yet");
      }
    });
    client.calls.propfind.length = 0;
    const syncing = service.syncNow();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    // The sync pass is queued behind the in-flight resolution and has
    // not touched the remote tree yet.
    expect(client.calls.propfind.filter((p) => p === "")).toHaveLength(0);

    releaseDel?.();
    await Promise.all([resolving, syncing]);
    expect(client.calls.propfind.filter((p) => p === "")).toHaveLength(1);
  });

  it("notifies the webview when a manual sync is skipped mid-run", async () => {
    writeLocal("cli.json", "v1");
    let releasePropfind: (() => void) | undefined;
    const originalPropfind = client.propfind.bind(client);
    client.propfind = ((target: string, depth: 0 | 1) => {
      if (target === "") {
        const blocked = new Promise<void>((resolve) => {
          releasePropfind = resolve;
        });
        return blocked.then(() => originalPropfind(target, depth));
      }
      return originalPropfind(target, depth);
    }) as typeof client.propfind;

    const first = service.syncNow();
    await new Promise((resolve) => setImmediate(resolve));
    deltas.length = 0;
    const syncDataCount = () =>
      posted.filter((m) => m.type === "webdavSyncData").length;
    const countBeforeSkip = syncDataCount();
    await service.syncNow();
    expect(deltas.some((delta) => delta.notice)).toBe(true);
    // The merged-skip path posts no snapshot of its own; the panel waits
    // for the in-flight run's single final push.
    expect(syncDataCount()).toBe(countBeforeSkip);

    releasePropfind?.();
    await first;
    expect(syncDataCount()).toBe(countBeforeSkip + 1);
  });

  it("records a conflict when a conditional upload loses the race", async () => {
    writeLocal("cli.json", "base");
    client.addFile("cli.json", "base");
    await service.syncNow();
    writeLocal("cli.json", "local-new");
    client.addFile("cli.json", "remote-new");
    settings["sync.onConflict"] = "preferLocal";

    client.putFailures.push("precondition");
    await service.syncNow();

    expect(client.putConditions).toEqual([
      { rel: "cli.json", ifMatch: '"v2"', ifNoneMatchStar: undefined },
    ]);
    expect(readLocal("cli.json")).toBe("local-new");
    expect(client.files.get("cli.json")?.content.toString()).toBe("remote-new");
    const snapshot = await service.getSnapshot();
    expect(snapshot.conflicts[0]).toMatchObject({
      kind: "content",
      reason: "preconditionFailed",
    });
    // A refused write is not a completed transfer in the history.
    expect(snapshot.history[0]).toMatchObject({
      direction: "none",
      files: 0,
      result: "partial",
    });
  });

  it("resets the pending counter before every pass", async () => {
    writeLocal("cli.json", "v1");
    client.put = async () => {
      throw new WebDavFatalError("boom", 401);
    };

    await service.syncNow();
    expect((await service.getSnapshot()).pendingCount).toBe(1);

    await service.syncNow();
    expect((await service.getSnapshot()).pendingCount).toBe(1);
  });

  it("reuses one client across passes so pacing state persists", async () => {
    writeLocal("cli.json", "v1");
    await service.syncNow();
    writeLocal("cli.json", "v2");
    await service.syncNow();

    expect(clientFactoryCalls).toBe(1);
  });

  it("retries once without conditions when the server rejects conditional PUTs", async () => {
    writeLocal("cli.json", "fresh");
    client.putFailures.push("unsupported");

    await service.syncNow();

    expect(client.putConditions).toEqual([
      { rel: "cli.json", ifMatch: undefined, ifNoneMatchStar: true },
      { rel: "cli.json", ifMatch: undefined, ifNoneMatchStar: undefined },
    ]);
    expect(client.files.get("cli.json")?.content.toString()).toBe("fresh");
    expect((await service.getSnapshot()).conflicts).toEqual([]);
  });

  it("records a conflict when a local file changes during the sync pass", async () => {
    writeLocal("cli.json", "v1");
    client.addFile("cli.json", "v1");
    await service.syncNow();
    client.addFile("cli.json", "v2");

    // Simulate an edit landing between the scan and the write phase.
    const originalGet = client.get.bind(client);
    let injected = false;
    client.get = async (rel: string) => {
      const content = await originalGet(rel);
      if (!injected && rel === "cli.json") {
        injected = true;
        writeLocal("cli.json", "edited-mid-sync");
      }
      return content;
    };

    await service.syncNow();

    expect(readLocal("cli.json")).toBe("edited-mid-sync");
    const snapshot = await service.getSnapshot();
    expect(snapshot.conflicts[0]).toMatchObject({
      kind: "content",
      reason: "localModifiedDuringSync",
    });
  });

  it("surfaces remote-deletion conflicts under the ignore policy when local changed", async () => {
    writeLocal("cli.json", "base");
    client.addFile("cli.json", "base");
    await service.syncNow();
    settings["sync.deletions"] = "ignore";
    client.files.delete("cli.json");
    writeLocal("cli.json", "local-edit");

    client.calls.put.length = 0;
    await service.syncNow();

    expect(client.calls.put).toEqual([]);
    expect(readLocal("cli.json")).toBe("local-edit");
    const snapshot = await service.getSnapshot();
    expect(snapshot.conflicts.map((entry) => entry.kind)).toEqual([
      "remoteDeleted",
    ]);
  });

  it("creates missing base-path ancestors through the client", async () => {
    settings["sync.basePath"] = "/nested/base/";
    client.dirs.clear();
    writeLocal("cli.json", "v1");

    await service.syncNow();

    expect(client.ensureBasePathCalls).toBe(1);
    expect(client.calls.put).toEqual(["cli.json"]);
  });

  it("creates remote parent collections for nested uploads", async () => {
    writeLocal("skills/sub/deep.md", "deep");
    await service.syncNow();
    expect([...client.dirs].sort()).toEqual(["", "skills", "skills/sub"]);
    expect(client.files.get("skills/sub/deep.md")?.content.toString()).toBe(
      "deep",
    );
  });

  it("merges overlapping sync runs into a single pass", async () => {
    writeLocal("cli.json", "v1");
    let releasePropfind: (() => void) | undefined;
    const originalPropfind = client.propfind.bind(client);
    client.propfind = ((target: string, depth: 0 | 1) => {
      if (target === "") {
        const blocked = new Promise<void>((resolve) => {
          releasePropfind = resolve;
        });
        return blocked.then(() => originalPropfind(target, depth));
      }
      return originalPropfind(target, depth);
    }) as typeof client.propfind;

    const first = service.syncNow();
    // Let executeSync reach the blocked base PROPFIND.
    await new Promise((resolve) => setImmediate(resolve));
    expect(releasePropfind).toBeTruthy();
    const second = service.syncNow();
    releasePropfind?.();
    await Promise.all([first, second]);

    // One walk of the base collection even though two syncs were requested.
    expect(client.calls.propfind.filter((p) => p === "")).toHaveLength(1);
    expect(client.calls.put).toEqual(["cli.json"]);
  });

  it("pauses all automatic triggers on the first fatal error", async () => {
    const internal = service as unknown as {
      autoSyncPaused: boolean;
      triggerAuto: (trigger: string) => Promise<void>;
    };
    writeLocal("cli.json", "v1");
    client.failure = "fatal";
    await service.syncNow();

    expect(internal.autoSyncPaused).toBe(true);
    const snapshot = await service.getSnapshot();
    expect(snapshot.state).toBe("error");
    expect(snapshot.autoSyncPaused).toBe(true);

    // Automatic triggers are skipped while paused, manual sync still runs.
    client.failure = undefined;
    client.calls.propfind.length = 0;
    await internal.triggerAuto("poll");
    expect(client.calls.propfind).toEqual([]);

    await service.syncNow();
    expect(client.calls.put).toEqual(["cli.json"]);
    expect(internal.autoSyncPaused).toBe(false);
    expect((await service.getSnapshot()).autoSyncPaused).toBe(false);
  });

  it("asks for credentials instead of failing when settings synced without the secret", async () => {
    const context = (
      service as unknown as { context: vscodeTypes.ExtensionContext }
    ).context;
    vi.mocked(context.secrets.get).mockResolvedValue(undefined);
    settings["sync.autoSyncEnabled"] = true;
    settings["sync.autoSyncOnStartup"] = true;
    writeLocal("cli.json", "v1");

    service.initialize();

    await vi.waitFor(async () => {
      if ((await service.getSnapshot()).state !== "needsAuth") {
        throw new Error("waiting for the startup preflight");
      }
    });
    // The pass never hit the network: a missing secret is not a 401.
    expect(clientFactoryCalls).toBe(0);
    expect(client.calls.propfind).toEqual([]);
    const snapshot = await service.getSnapshot();
    expect(snapshot.autoSyncPaused).toBe(false);
    expect(snapshot.settings.passwordSet).toBe(false);
    expect(snapshot.history).toEqual([]);
    // The leadership delta may land before or after this one.
    expect(deltas.some((delta) => delta.state === "needsAuth")).toBe(true);
  });

  it("recovers from the credentials state once the password is saved", async () => {
    const context = (
      service as unknown as { context: vscodeTypes.ExtensionContext }
    ).context;
    vi.mocked(context.secrets.get).mockResolvedValue(undefined);
    writeLocal("cli.json", "v1");
    await service.syncNow();
    expect((await service.getSnapshot()).state).toBe("needsAuth");
    expect(client.calls.propfind).toEqual([]);

    vi.mocked(context.secrets.get).mockResolvedValue("typed-password");
    await service.saveServerConfig(
      {
        url: "https://dav.test",
        username: "user",
        basePath: "/opencode-config/",
        allowInsecureHttp: false,
        acceptSelfSigned: false,
      },
      "typed-password",
    );
    await vi.waitFor(() => {
      const internal = service as unknown as { syncing: boolean };
      if (client.calls.put.length === 0 || internal.syncing) {
        throw new Error("sync pass still running");
      }
    });
    const snapshot = await service.getSnapshot();
    expect(snapshot.state).toBe("idle");
    expect(snapshot.settings.passwordSet).toBe(true);
    expect(snapshot.autoSyncPaused).toBe(false);
  });

  it("clears the credentials state when the server identity changes", async () => {
    const context = (
      service as unknown as { context: vscodeTypes.ExtensionContext }
    ).context;
    vi.mocked(context.secrets.get).mockResolvedValue(undefined);
    writeLocal("cli.json", "v1");
    await service.syncNow();
    expect((await service.getSnapshot()).state).toBe("needsAuth");

    const internal = service as unknown as {
      clearNeedsAuthIfConfigChanged: () => void;
    };
    // Unrelated option edits keep the verdict.
    settings["sync.showStatusIcon"] = false;
    internal.clearNeedsAuthIfConfigChanged();
    expect((await service.getSnapshot()).state).toBe("needsAuth");

    // A different username resolves a different stored secret, so the old
    // verdict is obsolete and automatic triggers may run again.
    settings["sync.username"] = "other-user";
    internal.clearNeedsAuthIfConfigChanged();
    expect((await service.getSnapshot()).state).toBe("idle");
  });

  it("treats rejected credentials as a sign-in state, not an auto-sync pause", async () => {
    const internal = service as unknown as {
      autoSyncPaused: boolean;
      triggerAuto: (trigger: string) => Promise<void>;
      isLeader: boolean;
    };
    internal.isLeader = true;
    writeLocal("cli.json", "v1");
    client.failure = "auth";
    await internal.triggerAuto("poll");

    const snapshot = await service.getSnapshot();
    expect(snapshot.state).toBe("needsAuth");
    expect(snapshot.autoSyncPaused).toBe(false);
    expect(internal.autoSyncPaused).toBe(false);
    expect(snapshot.history[0]).toMatchObject({
      result: "failed",
      trigger: "poll",
      message: "The server rejected the sign-in details.",
    });

    // Automatic triggers stop hitting a server that rejects the secret.
    client.calls.propfind.length = 0;
    await internal.triggerAuto("poll");
    expect(client.calls.propfind).toEqual([]);

    // A manual sync after fixing the credentials clears the state.
    client.failure = undefined;
    await service.syncNow();
    expect((await service.getSnapshot()).state).toBe("idle");
  });

  it("treats a 403 as a permission failure, not a credentials state", async () => {
    const internal = service as unknown as {
      autoSyncPaused: boolean;
      triggerAuto: (trigger: string) => Promise<void>;
      isLeader: boolean;
    };
    internal.isLeader = true;
    writeLocal("cli.json", "v1");
    client.failure = "forbidden";
    await internal.triggerAuto("poll");

    const snapshot = await service.getSnapshot();
    expect(snapshot.state).toBe("error");
    expect(snapshot.autoSyncPaused).toBe(true);
    expect(internal.autoSyncPaused).toBe(true);
    expect(snapshot.history[0]).toMatchObject({
      result: "failed",
      trigger: "poll",
      message:
        "The server refused the operation. Check the account permissions.",
    });
  });

  it("keeps anonymous servers working without a stored secret", async () => {
    const context = (
      service as unknown as { context: vscodeTypes.ExtensionContext }
    ).context;
    settings["sync.username"] = "";
    vi.mocked(context.secrets.get).mockResolvedValue(undefined);
    writeLocal("cli.json", "v1");

    await service.syncNow();

    expect(client.calls.put).toEqual(["cli.json"]);
    expect((await service.getSnapshot()).state).toBe("idle");
  });

  it("pauses after five consecutive transient failures and backs off between", async () => {
    vi.useFakeTimers();
    try {
      const internal = service as unknown as {
        autoSyncPaused: boolean;
        triggerAuto: (trigger: string) => Promise<void>;
        isLeader: boolean;
      };
      internal.isLeader = true;
      writeLocal("cli.json", "v1");
      client.failure = "transient";

      for (let round = 1; round <= 4; round += 1) {
        await internal.triggerAuto("poll");
        expect(internal.autoSyncPaused).toBe(false);
      }
      await internal.triggerAuto("poll");
      expect(internal.autoSyncPaused).toBe(true);

      client.failure = undefined;
      // A successful manual sync re-arms the breaker.
      await service.syncNow();
      expect(internal.autoSyncPaused).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("schedules exponentially backed-off retries for transient failures", async () => {
    vi.useFakeTimers();
    try {
      const internal = service as unknown as {
        triggerAuto: (trigger: string) => Promise<void>;
        autoSyncPaused: boolean;
        isLeader: boolean;
      };
      internal.isLeader = true;
      writeLocal("cli.json", "v1");
      client.failure = "transient";
      await internal.triggerAuto("poll");

      // The retry fires after one minute; the sync pass it starts needs
      // real event-loop turns for its file IO, so switch back to real
      // timers once the timer callback has fired.
      client.failure = undefined;
      await vi.advanceTimersByTimeAsync(60_000);
      vi.useRealTimers();
      await vi.waitFor(() => {
        if (client.calls.put.length === 0) {
          throw new Error("retry sync still running");
        }
      });
      expect(client.calls.put).toEqual(["cli.json"]);
      expect(internal.autoSyncPaused).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a mid-run rate limit as a partial pass with a scheduled resume", async () => {
    writeLocal("AGENTS.md", "v1");
    writeLocal("cli.json", "v1");
    writeLocal("opencode.json", "v1");
    client.rateLimitAtPutCall = 2;
    client.rateLimitRetryAfterMs = 120_000;
    const manifestPath = path.join(syncStorageDir(storageDir), "manifest.json");
    const internal = service as unknown as {
      autoSyncPaused: boolean;
      failureStreak: number;
      rateLimitResumeTimer: unknown;
      triggerAuto: (trigger: string) => Promise<void>;
    };
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await service.syncNow();

    // The first file landed before the pass aborted at the second; the
    // manifest checkpoint already baselines it.
    expect(client.calls.put).toEqual(["AGENTS.md", "cli.json"]);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(manifest.files["AGENTS.md"]).toBeDefined();
    expect(manifest.files["cli.json"]).toBeUndefined();

    // Partial, not failed; the breaker and failure streak stay untouched.
    const snapshot = await service.getSnapshot();
    expect(snapshot.state).toBe("error");
    expect(snapshot.autoSyncPaused).toBe(false);
    expect(internal.autoSyncPaused).toBe(false);
    expect(internal.failureStreak).toBe(0);
    expect(snapshot.history[0]).toMatchObject({
      result: "partial",
      message: "rate limited by server; resuming in 120s",
    });
    // The cooldown comes from the Retry-After hint.
    expect(
      setTimeoutSpy.mock.calls.some(
        ([fn, ms]) => typeof fn === "function" && ms === 120_000,
      ),
    ).toBe(true);
    setTimeoutSpy.mockRestore();
    expect(internal.rateLimitResumeTimer).toBeTruthy();

    // Automatic triggers wait for the scheduled resume instead of
    // burning requests against the limited server.
    client.calls.propfind.length = 0;
    await internal.triggerAuto("poll");
    expect(client.calls.propfind).toEqual([]);

    // The resume continues where the pass stopped: no re-transfer of the
    // already-checkpointed file.
    client.rateLimitAtPutCall = 0;
    client.calls.put.length = 0;
    await service.syncNow();
    expect(client.calls.put.sort()).toEqual(["cli.json", "opencode.json"]);
  });

  it("falls back to the pacing window when the server sends no Retry-After", async () => {
    settings["sync.rateLimitMaxRequests"] = 600;
    settings["sync.rateLimitWindowMinutes"] = 5;
    writeLocal("cli.json", "v1");
    client.rateLimitAtPutCall = 1;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await service.syncNow();
    // Capture before restore: vitest 4 clears call history on restore.
    const scheduledDelays = setTimeoutSpy.mock.calls
      .filter(([fn]) => typeof fn === "function")
      .map(([, ms]) => ms);
    setTimeoutSpy.mockRestore();

    // No Retry-After: the configured window drives the cooldown.
    expect(scheduledDelays).toContain(300_000);
    const snapshot = await service.getSnapshot();
    expect(snapshot.history[0]).toMatchObject({
      result: "partial",
      message: "rate limited by server; resuming in 300s",
    });
    await service.requestLog();
    const logMessage = posted
      .filter((m) => m.type === "webdavLog")
      .pop() as { lines: string[] };
    expect(
      logMessage.lines.some((line) => line.includes("request window")),
    ).toBe(true);
  });

  it("re-arms and syncs once when the server config is saved", async () => {
    const internal = service as unknown as { autoSyncPaused: boolean };
    const context = service as unknown as {
      context: { secrets: { store: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> } };
    };
    writeLocal("cli.json", "v1");
    client.failure = "fatal";
    await service.syncNow();
    expect(internal.autoSyncPaused).toBe(true);

    client.failure = undefined;
    await service.saveServerConfig(
      {
        url: "https://dav.test",
        username: "user",
        basePath: "/opencode-config/",
        allowInsecureHttp: false,
        acceptSelfSigned: false,
      },
      "new-password",
    );

    expect(internal.autoSyncPaused).toBe(false);
    // The config-save trigger fires a sync pass asynchronously; wait for
    // the engine to finish its IO chain before asserting the upload.
    await vi.waitFor(() => {
      if (client.calls.put.length === 0) {
        throw new Error("sync pass still running");
      }
    });
    expect(client.calls.put).toEqual(["cli.json"]);
    expect(posted.some((m) => m.type === "webdavSaveResult" && m.ok)).toBe(true);
    expect(settings["sync.url"]).toBe("https://dav.test");
    // Saving the server card turns the feature on; there is no separate UI switch.
    expect(settings["sync.enabled"]).toBe(true);
    expect(settings["sync.basePath"]).toBe("/opencode-config/");
    // Server save persists connection fields only; behavior options keep
    // their previous values.
    expect(settings["sync.autoSyncRemotePoll"]).toBe(false);
    expect(context.context.secrets.store).toHaveBeenCalledWith(
      webdavSecretKey("https://dav.test", "user"),
      "new-password",
    );
  });

  it("writes, keeps and clears the stored password depending on the password field", async () => {
    const internals = service as unknown as {
      context: { secrets: { store: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> } };
    };
    const connection = {
      url: "https://dav.test",
      username: "user",
      basePath: "/opencode-config/",
      allowInsecureHttp: false,
      acceptSelfSigned: false,
    };

    // No password field: the stored credential is left untouched.
    await service.saveServerConfig(connection);
    expect(internals.context.secrets.store).not.toHaveBeenCalled();
    expect(internals.context.secrets.delete).not.toHaveBeenCalled();

    await service.saveServerConfig(connection, "pw");
    expect(internals.context.secrets.store).toHaveBeenCalledTimes(1);

    // Empty password clears the stored credential.
    await service.saveServerConfig(connection, "");
    expect(internals.context.secrets.delete).toHaveBeenCalledWith(
      webdavSecretKey("https://dav.test", "user"),
    );
  });

  it("removes the stale stored password when the server identity changes", async () => {
    const internals = service as unknown as {
      context: { secrets: { store: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> } };
    };
    await service.saveServerConfig(
      {
        url: "https://other-dav.test",
        username: "someone-else",
        basePath: "/opencode-config/",
        allowInsecureHttp: false,
        acceptSelfSigned: false,
      },
      "pw2",
    );

    expect(internals.context.secrets.store).toHaveBeenCalledWith(
      webdavSecretKey("https://other-dav.test", "someone-else"),
      "pw2",
    );
    // The secret derived from the previous identity is gone for good.
    expect(internals.context.secrets.delete).toHaveBeenCalledWith(
      webdavSecretKey("https://dav.test", "user"),
    );
  });

  it("persists and snapshots rate limit settings from the server card", async () => {
    await service.saveServerConfig({
      url: "https://dav.test",
      username: "user",
      basePath: "/opencode-config/",
      allowInsecureHttp: false,
      acceptSelfSigned: false,
      rateLimitMaxRequests: 600,
      rateLimitWindowMinutes: 30,
    });
    expect(settings["sync.rateLimitMaxRequests"]).toBe(600);
    expect(settings["sync.rateLimitWindowMinutes"]).toBe(30);
    expect(posted.some((m) => m.type === "webdavSaveResult" && m.ok)).toBe(true);

    const snapshot = await service.getSnapshot();
    expect(snapshot.settings.rateLimitMaxRequests).toBe(600);
    expect(snapshot.settings.rateLimitWindowMinutes).toBe(30);
  });

  it("rejects invalid rate limit values without touching settings", async () => {
    const before = { ...settings };
    const invalidValues: Partial<WebDavServerConfig>[] = [
      { rateLimitMaxRequests: -1 },
      { rateLimitMaxRequests: 2.5 },
      { rateLimitWindowMinutes: 0 },
      { rateLimitWindowMinutes: 1.5 },
    ];
    for (const invalid of invalidValues) {
      await service.saveServerConfig({
        url: "https://dav.test",
        username: "user",
        basePath: "/opencode-config/",
        allowInsecureHttp: false,
        acceptSelfSigned: false,
        ...invalid,
      });
    }
    expect(settings).toEqual(before);
    const failures = posted.filter(
      (message) => message.type === "webdavSaveResult" && !message.ok,
    );
    expect(failures).toHaveLength(invalidValues.length);
  });

  it("applies sync options immediately without credentials or breaker changes", async () => {
    vi.mocked(vscode.workspace.createFileSystemWatcher).mockImplementation(((
      () => ({
        onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
        onDidCreate: vi.fn(() => ({ dispose: vi.fn() })),
        onDidDelete: vi.fn(() => ({ dispose: vi.fn() })),
        dispose: vi.fn(),
      })
    ) as never));
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const internals = service as unknown as {
      autoSyncPaused: boolean;
      context: { secrets: { store: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> } };
    };

    // Open the circuit breaker first; applying options must not close it.
    client.failure = "fatal";
    await service.syncNow();
    expect(internals.autoSyncPaused).toBe(true);
    client.failure = undefined;

    await service.applySyncOptions({
      autoSync: {
        enabled: true,
        onStartup: true,
        onLocalChange: true,
        remotePoll: true,
      },
      pollIntervalMinutes: 0.5,
      showStatusIcon: false,
    });
    // Leadership election is asynchronous; wait for the armed branch.
    await vi.waitFor(() => {
      if (!(service as unknown as { isLeader: boolean }).isLeader) {
        throw new Error("waiting for leadership");
      }
    });

    // Options persisted, with the poll interval clamped to the minimum.
    expect(settings["sync.autoSyncEnabled"]).toBe(true);
    expect(settings["sync.autoSyncOnLocalChange"]).toBe(true);
    expect(settings["sync.autoSyncRemotePoll"]).toBe(true);
    expect(settings["sync.pollIntervalMinutes"]).toBe(1);
    expect(settings["sync.showStatusIcon"]).toBe(false);
    // Watcher and poller were reconfigured on the spot.
    expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalled();
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
    // No breaker re-arm, no credential writes, no sync pass.
    expect(internals.autoSyncPaused).toBe(true);
    expect(internals.context.secrets.store).not.toHaveBeenCalled();
    expect(internals.context.secrets.delete).not.toHaveBeenCalled();
    expect(client.calls.put).toEqual([]);
    expect(posted.some((m) => m.type === "webdavSaveResult" && m.ok)).toBe(true);
  });

  it("arms watcher and poller only in the leader window", async () => {
    settings["sync.autoSyncEnabled"] = true;
    settings["sync.autoSyncOnLocalChange"] = true;
    settings["sync.autoSyncRemotePoll"] = true;
    settings["sync.pollIntervalMinutes"] = 1;

    // A foreign window already holds a fresh lock on the shared storage.
    const lockPath = path.join(syncStorageDir(storageDir), "lock.json");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        lockId: "other-window",
        pid: -1,
        hostname: "elsewhere",
        acquiredAt: Date.now(),
        renewedAt: Date.now(),
      }),
      "utf8",
    );
    const watcherCallsBefore = configDirWatcherCalls();

    service.initialize();
    const internals = service as unknown as {
      isLeader: boolean;
      lockAcquireInFlight?: Promise<void>;
      watcher?: unknown;
      pollTimer?: unknown;
      lockRetryTimer?: unknown;
    };
    // The acquire retries against the held lock and times out (~2s).
    await vi.waitFor(
      () => {
        if (internals.lockAcquireInFlight) {
          throw new Error("waiting for the lock attempt to settle");
        }
      },
      { timeout: 5_000 },
    );
    expect(internals.isLeader).toBe(false);
    expect(internals.watcher).toBeUndefined();
    expect(internals.pollTimer).toBeUndefined();
    // The follower created no config-directory watcher; only the shared
    // status-file watcher exists from construction.
    expect(configDirWatcherCalls()).toBe(watcherCallsBefore);
    expect((await service.getSnapshot()).leader).toBe(false);
    expect(deltas.some((delta) => delta.leader === false)).toBe(false);
    // Losing is not final: a retry is scheduled to reclaim leadership.
    expect(internals.lockRetryTimer).toBeDefined();

    // The lock frees up: a direct re-arm elects this window and arms the
    // automatic channels.
    fs.rmSync(lockPath);
    (service as unknown as { armTriggers: () => void }).armTriggers();
    await vi.waitFor(
      () => {
        if (!internals.isLeader) {
          throw new Error("waiting for leadership");
        }
      },
      { timeout: 5_000 },
    );
    expect(configDirWatcherCalls()).toBeGreaterThan(watcherCallsBefore);
    expect(internals.pollTimer).toBeDefined();
    expect(deltas.some((delta) => delta.leader === true)).toBe(true);
    expect((await service.getSnapshot()).leader).toBe(true);
  });

  it("disarms the auto channels when leadership is lost", async () => {
    settings["sync.autoSyncEnabled"] = true;
    settings["sync.autoSyncOnLocalChange"] = true;
    settings["sync.autoSyncRemotePoll"] = true;
    settings["sync.pollIntervalMinutes"] = 1;
    const internals = service as unknown as {
      isLeader: boolean;
      watcher?: { dispose: ReturnType<typeof vi.fn> } | undefined;
      pollTimer?: unknown;
      lockHeartbeatTimer?: unknown;
      lockRetryTimer?: unknown;
      heartbeatTick: () => Promise<void>;
    };
    service.initialize();
    await vi.waitFor(
      () => {
        if (!internals.isLeader) {
          throw new Error("waiting for leadership");
        }
      },
      { timeout: 5_000 },
    );
    const armedWatcher = internals.watcher;
    expect(armedWatcher).toBeDefined();
    expect(internals.pollTimer).toBeDefined();

    // Another window takes over the lock with fresh heartbeats.
    const lockPath = path.join(syncStorageDir(storageDir), "lock.json");
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        lockId: "usurper",
        pid: -1,
        hostname: "elsewhere",
        acquiredAt: Date.now(),
        renewedAt: Date.now(),
      }),
      "utf8",
    );

    await internals.heartbeatTick();
    expect(internals.isLeader).toBe(false);
    expect(armedWatcher?.dispose).toHaveBeenCalled();
    expect(internals.watcher).toBeUndefined();
    expect(internals.pollTimer).toBeUndefined();
    expect(internals.lockHeartbeatTimer).toBeUndefined();
    expect(internals.lockRetryTimer).toBeDefined();
    expect(deltas.some((delta) => delta.leader === false)).toBe(true);
    expect((await service.getSnapshot()).leader).toBe(false);
  });

  it("skips the startup pass in a follower window", async () => {
    settings["sync.autoSyncEnabled"] = true;
    settings["sync.autoSyncOnStartup"] = true;
    writeLocal("cli.json", "one");
    // A foreign window already holds a fresh lock on the shared storage.
    const lockPath = path.join(syncStorageDir(storageDir), "lock.json");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        lockId: "other-window",
        pid: -1,
        hostname: "elsewhere",
        acquiredAt: Date.now(),
        renewedAt: Date.now(),
      }),
      "utf8",
    );

    service.initialize();
    const internals = service as unknown as {
      isLeader: boolean;
      lockAcquireInFlight?: Promise<void>;
    };
    await vi.waitFor(
      () => {
        if (internals.lockAcquireInFlight) {
          throw new Error("waiting for the lock attempt to settle");
        }
      },
      { timeout: 5_000 },
    );
    expect(internals.isLeader).toBe(false);
    // Give the post-settle startup branch a chance to misfire.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.calls.propfind).toEqual([]);
    expect(clientFactoryCalls).toBe(0);
    const snapshot = await service.getSnapshot();
    expect(snapshot.history).toEqual([]);
    expect(snapshot.leader).toBe(false);
  });

  it("runs the startup pass only after leadership is decided", async () => {
    settings["sync.autoSyncEnabled"] = true;
    settings["sync.autoSyncOnStartup"] = true;
    writeLocal("cli.json", "one");

    service.initialize();
    // Uncontended lock: this window becomes leader and the startup pass
    // runs after the election settles.
    await vi.waitFor(() => {
      if (client.calls.put.length === 0) {
        throw new Error("waiting for the startup pass");
      }
    }, 5_000);
    const snapshot = await service.getSnapshot();
    expect(snapshot.leader).toBe(true);
    expect(snapshot.history[0]).toMatchObject({
      result: "success",
      trigger: "startup",
    });
  });

  it("releases the lock when the circuit breaker pauses auto sync", async () => {
    settings["sync.autoSyncEnabled"] = true;
    writeLocal("cli.json", "v1");
    service.initialize();
    await vi.waitFor(
      () => {
        if (!(service as unknown as { isLeader: boolean }).isLeader) {
          throw new Error("waiting for leadership");
        }
      },
      { timeout: 5_000 },
    );
    const lockPath = path.join(syncStorageDir(storageDir), "lock.json");
    expect(fs.existsSync(lockPath)).toBe(true);

    // A fatal failure on any pass opens the breaker.
    client.failure = "fatal";
    await service.syncNow();
    expect(
      (service as unknown as { autoSyncPaused: boolean }).autoSyncPaused,
    ).toBe(true);

    // The paused leader gave up the lock: a healthy window takes over.
    await vi.waitFor(() => {
      if (fs.existsSync(lockPath)) {
        throw new Error("waiting for the lock release");
      }
    });
    const other = new SyncProcessLock(lockPath);
    await expect(other.acquire(1_000)).resolves.toBe(true);
    expect(deltas.some((delta) => delta.leader === false)).toBe(true);
  });

  it("releases the lock when sync is disabled while acquisition is in flight", async () => {
    settings["sync.autoSyncEnabled"] = true;
    // A lock that goes stale a moment later keeps the acquisition busy
    // (fresh on the first read, stale after a retry round) so sync can be
    // disabled before the takeover lands.
    const lockPath = path.join(syncStorageDir(storageDir), "lock.json");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        lockId: "other-window",
        pid: -1,
        hostname: "elsewhere",
        acquiredAt: Date.now(),
        renewedAt: Date.now() - (LOCK_STALE_MS - 500),
      }),
      "utf8",
    );

    service.initialize();
    // The user disables sync while the election is still in flight.
    settings["sync.enabled"] = false;
    const internals = service as unknown as {
      isLeader: boolean;
      lockAcquireInFlight?: Promise<void>;
    };
    await vi.waitFor(
      () => {
        if (internals.lockAcquireInFlight) {
          throw new Error("waiting for the lock attempt to settle");
        }
      },
      { timeout: 5_000 },
    );

    // The takeover succeeded but was refused: no leadership, no channels,
    // and the lock file is gone so another window can win it immediately.
    expect(internals.isLeader).toBe(false);
    await vi.waitFor(() => {
      if (fs.existsSync(lockPath)) {
        throw new Error("waiting for the lock release");
      }
    });
    expect(deltas.some((delta) => delta.leader === true)).toBe(false);
    // No config-directory watcher was created; only the constructor's
    // shared status-file watcher ever existed.
    expect(configDirWatcherCalls()).toBe(0);
    const other = new SyncProcessLock(lockPath);
    await expect(other.acquire(1_000)).resolves.toBe(true);
  });

  it("skips the disk write when the downloaded content already matches", async () => {
    writeLocal("cli.json", "same");
    const abs = path.join(configDir, "cli.json");
    const mtimeBefore = fs.statSync(abs).mtimeMs;
    const manifest = new SyncManifest(storageDir);
    await manifest.load();
    client.addFile("cli.json", "same");
    const stat: WebDavStat = {
      path: "cli.json",
      etag: client.files.get("cli.json")?.etag ?? null,
      size: 4,
      lastModified: 1_000,
      isDir: false,
    };
    const downloadFile = (
      service as unknown as {
        downloadFile: (
          client: WebDavClientLike,
          rel: string,
          abs: string,
          manifest: SyncManifest,
          stat: WebDavStat | null,
          cachedContent: Buffer | null,
          captured: { size: number; mtimeMs: number } | null,
          recordConflict?: (entry: WebDavConflictEntry) => void,
        ) => Promise<boolean>;
      }
    ).downloadFile.bind(service);
    const conflicts: WebDavConflictEntry[] = [];

    const downloaded = await downloadFile(
      client,
      "cli.json",
      abs,
      manifest,
      stat,
      Buffer.from("same", "utf8"),
      null,
      (entry) => conflicts.push(entry),
    );

    expect(downloaded).toBe(true);
    expect(conflicts).toEqual([]);
    // No rewrite: mtime untouched, no backup generation created.
    expect(fs.statSync(abs).mtimeMs).toBe(mtimeBefore);
    expect(backupCount("cli.json")).toBe(0);
    // The manifest still checkpoints to the agreed hash.
    expect(manifest.get("cli.json")?.baselineHash).toBe(
      hashContent(Buffer.from("same", "utf8")),
    );
  });

  it("agrees when a sibling window rewrote the local file with the same bytes mid-pass", async () => {
    // Scan-time snapshot of the old bytes...
    writeLocal("cli.json", "old");
    const abs = path.join(configDir, "cli.json");
    const captured = fs.statSync(abs);
    // ...then a sibling window lands the identical remote content before
    // our write phase, tripping the capturedStats guard.
    writeLocal("cli.json", "same");
    const manifest = new SyncManifest(storageDir);
    await manifest.load();
    client.addFile("cli.json", "same");
    const stat: WebDavStat = {
      path: "cli.json",
      etag: client.files.get("cli.json")?.etag ?? null,
      size: 4,
      lastModified: 1_000,
      isDir: false,
    };
    const downloadFile = (
      service as unknown as {
        downloadFile: (
          client: WebDavClientLike,
          rel: string,
          abs: string,
          manifest: SyncManifest,
          stat: WebDavStat | null,
          cachedContent: Buffer | null,
          captured: { size: number; mtimeMs: number } | null,
          recordConflict?: (entry: WebDavConflictEntry) => void,
        ) => Promise<boolean>;
      }
    ).downloadFile.bind(service);
    const conflicts: WebDavConflictEntry[] = [];

    const downloaded = await downloadFile(
      client,
      "cli.json",
      abs,
      manifest,
      stat,
      Buffer.from("same", "utf8"),
      { size: captured.size, mtimeMs: captured.mtimeMs },
      (entry) => conflicts.push(entry),
    );

    // Identical bytes are an agree: baseline checkpoint, no conflict, no
    // rewrite and no backup.
    expect(downloaded).toBe(true);
    expect(conflicts).toEqual([]);
    expect(readLocal("cli.json")).toBe("same");
    expect(backupCount("cli.json")).toBe(0);
    expect(manifest.get("cli.json")?.baselineHash).toBe(
      hashContent(Buffer.from("same", "utf8")),
    );
  });

  it("treats a 412 on first upload as an agree when the remote bytes match", async () => {
    writeLocal("cli.json", "one");
    // A competing window's identical upload lands between our scan and
    // our CAS PUT, so the PUT fails with 412.
    client.putFailures.push("precondition");
    client.beforePreconditionFailure = (rel) => {
      client.addFile(rel, "one");
    };

    await service.syncNow();

    const snapshot = await service.getSnapshot();
    expect(snapshot.conflictCount).toBe(0);
    expect(client.calls.get).toContain("cli.json");
    expect(snapshot.history[0]).toMatchObject({
      result: "success",
      trigger: "manual",
    });
    const manifestPath = path.join(syncStorageDir(storageDir), "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(manifest.files["cli.json"].baselineHash).toBe(
      hashContent(Buffer.from("one", "utf8")),
    );
    // The baseline now agrees: a second pass is a pure no-op.
    client.calls.put.length = 0;
    client.calls.get.length = 0;
    await service.syncNow();
    expect(client.calls.put).toEqual([]);
  });

  it("keeps the conflict path when a 412 hides differing content", async () => {
    writeLocal("cli.json", "one");
    client.putFailures.push("precondition");
    client.beforePreconditionFailure = (rel) => {
      client.addFile(rel, "different");
    };

    await service.syncNow();

    const snapshot = await service.getSnapshot();
    expect(snapshot.conflictCount).toBe(1);
    expect(snapshot.conflicts[0]).toMatchObject({
      kind: "content",
      reason: "preconditionFailed",
    });
  });

  it("falls back to the conflict path when the etag changes during a 412 agree check", async () => {
    writeLocal("cli.json", "one");
    client.putFailures.push("precondition");
    client.beforePreconditionFailure = (rel) => {
      client.addFile(rel, "one");
    };
    // The competing window rewrites the remote between our stat-get-stat
    // bracket, so the verified bytes and the observed etags no longer
    // pair: accepting the agree would let the next pass trust a stale
    // hash through the etag-unchanged shortcut.
    client.onGet = (rel) => {
      const file = client.files.get(rel);
      if (file) {
        file.etag = '"rewritten"';
      }
    };

    await service.syncNow();

    const snapshot = await service.getSnapshot();
    expect(snapshot.conflictCount).toBe(1);
    expect(snapshot.conflicts[0]).toMatchObject({
      kind: "content",
      reason: "preconditionFailed",
    });
    // No baseline was checkpointed for the unverified etag-byte pair.
    const manifestPath = path.join(syncStorageDir(storageDir), "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(manifest.files["cli.json"]).toBeUndefined();
  });

  it("answers snapshot, log and connection-test requests", async () => {
    await service.requestSyncData();
    expect(
      posted.some((message) => message.type === "webdavSyncData"),
    ).toBe(true);

    await service.requestLog();
    expect(posted.some((message) => message.type === "webdavLog")).toBe(true);

    await service.testConnection({
      url: "https://dav.test",
      username: "user",
      password: "pw",
      basePath: "/opencode-config/",
      allowInsecureHttp: false,
      acceptSelfSigned: false,
    });
    const testResult = posted.find((message) => message.type === "webdavTestResult");
    expect(testResult).toMatchObject({ type: "webdavTestResult", ok: true });

    client.failure = "transient";
    await service.testConnection({
      url: "https://dav.test",
      username: "user",
      basePath: "/opencode-config/",
      allowInsecureHttp: false,
      acceptSelfSigned: false,
    });
    const failed = posted
      .filter((message) => message.type === "webdavTestResult")
      .pop();
    expect(failed).toMatchObject({ type: "webdavTestResult", ok: false });
  });

  it("treats a missing sync folder as a successful connection test", async () => {
    client.failure = undefined;
    const savedFiles = [...client.files];
    const savedDirs = [...client.dirs];
    client.files.clear();
    client.dirs.clear();
    try {
      await service.testConnection({
        url: "https://dav.test",
        username: "user",
        password: "pw",
        basePath: "/opencode-config/",
        allowInsecureHttp: false,
        acceptSelfSigned: false,
      });
    } finally {
      for (const [key, value] of savedFiles) {
        client.files.set(key, value);
      }
      for (const dir of savedDirs) {
        client.dirs.add(dir);
      }
    }
    const result = posted
      .filter((message) => message.type === "webdavTestResult")
      .pop();
    expect(result).toMatchObject({ type: "webdavTestResult", ok: true });
    expect((result as { message?: string }).message).toBeUndefined();
  });

  it("derives the secret key from the server identity", () => {
    expect(webdavSecretKey("https://dav.test", "user")).toMatch(
      /^webdav\.password\.[0-9a-f]{12}$/,
    );
    expect(webdavSecretKey("https://dav.test", "user")).not.toBe(
      webdavSecretKey("https://dav.test", "other"),
    );
  });

  it("skips excluded paths during a sync pass", async () => {
    writeLocal("cli.json", "v1");
    writeLocal("AGENTS.md", "v1");
    settings["sync.excludedPaths"] = ["cli.json"];
    await service.syncNow();

    expect(client.calls.put).toEqual(["AGENTS.md"]);
    const snapshot = await service.getSnapshot();
    expect(snapshot.excludes).toEqual(["cli.json"]);
    // Snapshot item rows carry no display-name field.
    for (const item of snapshot.items) {
      expect("name" in item).toBe(false);
    }
  });

  it("persists exclude changes, reconciles and validates input", async () => {
    writeLocal("cli.json", "v1");
    writeLocal("AGENTS.md", "v1");
    await service.syncNow();
    expect(client.calls.put).toEqual(["AGENTS.md", "cli.json"]);

    // Adding an exclude persists the normalized path and runs one
    // reconciliation pass.
    const propfindBefore = client.calls.propfind.length;
    await service.addExclude("skills\\drafts/");
    expect(settings["sync.excludedPaths"]).toEqual(["skills/drafts"]);
    await vi.waitFor(() => {
      if (client.calls.propfind.length <= propfindBefore) {
        throw new Error("reconciliation pass still pending");
      }
    });
    expect(posted.some((m) => m.type === "webdavSaveResult" && m.ok)).toBe(true);
    let snapshot = await service.getSnapshot();
    expect(snapshot.excludes).toEqual(["skills/drafts"]);
    expect(posted.some((m) => m.type === "webdavSyncData")).toBe(true);

    // Duplicate adds are no-ops that keep the persisted list stable.
    await service.addExclude("skills/drafts");
    expect(settings["sync.excludedPaths"]).toEqual(["skills/drafts"]);

    // Removing the exclude re-opens the scope.
    await service.removeExclude("skills\\drafts");
    expect(settings["sync.excludedPaths"]).toEqual([]);
    snapshot = await service.getSnapshot();
    expect(snapshot.excludes).toEqual([]);

    // Invalid paths are rejected without touching the setting.
    const saveResultsBefore = posted.filter(
      (m) => m.type === "webdavSaveResult",
    ).length;
    await service.addExclude("../escape");
    expect(settings["sync.excludedPaths"]).toEqual([]);
    expect(
      posted
        .filter((m) => m.type === "webdavSaveResult")
        .slice(saveResultsBefore)
        .some((m) => m.type === "webdavSaveResult" && m.ok === false),
    ).toBe(true);
  });

  it("deletes exactly the newly excluded remote files and forgets their manifest entries", async () => {
    writeLocal("cli.json", "v1");
    writeLocal("AGENTS.md", "doc");
    await service.addItem("notes");
    writeLocal("notes/keep.md", "keep");
    writeLocal("notes/drop.md", "drop");
    await service.syncNow();
    // A remote file another device owns: outside this machine's items.
    client.addFile("outside/foreign.md", "foreign");
    const manifestPath = path.join(syncStorageDir(storageDir), "manifest.json");

    await service.addExclude("notes/drop.md");

    await vi.waitFor(() => {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if ("notes/drop.md" in manifest.files) {
        throw new Error("manifest entry still present");
      }
    });
    // Only the file that just left scope is gone; everything that stays
    // in scope, and files owned by other devices, are untouched.
    expect(client.calls.del).toEqual(["notes/drop.md"]);
    expect(client.files.has("notes/drop.md")).toBe(false);
    expect(client.files.has("notes/keep.md")).toBe(true);
    expect(client.files.has("cli.json")).toBe(true);
    expect(client.files.has("AGENTS.md")).toBe(true);
    expect(client.files.has("outside/foreign.md")).toBe(true);

    // The purge count lands on the reconcile pass that runs right after.
    await vi.waitFor(async () => {
      const [latest] = (await service.getSnapshot()).history;
      if (latest?.trigger !== "excludeChange" || latest.deletes !== 1) {
        throw new Error("excludeChange history entry not recorded yet");
      }
    });
  });

  it("never deletes remote files outside the machine's item scope", async () => {
    writeLocal("cli.json", "v1");
    writeLocal("AGENTS.md", "doc");
    await service.syncNow();
    client.addFile("outside/foreign.md", "foreign");

    await service.addExclude("re:.*\\.md");

    await vi.waitFor(() => {
      if (!client.calls.del.includes("AGENTS.md")) {
        throw new Error("purge still pending");
      }
    });
    expect(client.calls.del.sort()).toEqual(["AGENTS.md"]);
    // The pattern matches the foreign file too, but another device owns it.
    expect(client.files.has("outside/foreign.md")).toBe(true);
    expect(client.files.has("cli.json")).toBe(true);
  });

  it("never purges remote files this machine has not synced", async () => {
    writeLocal("opencode.json", "v1");
    await service.syncNow();
    // Inside a built-in item, but only another device ever uploaded it.
    client.addFile("skills/foreign.md", "foreign");
    const deltasBefore = deltas.length;

    await service.addExclude("skills");

    // Wait for the reconcile pass that follows the purge.
    await vi.waitFor(() => {
      if (deltas.length < deltasBefore + 2) {
        throw new Error("reconcile still pending");
      }
    });
    expect(client.calls.del).toEqual([]);
    expect(client.files.has("skills/foreign.md")).toBe(true);
  });

  it("skips the purge when the exclude entry already exists", async () => {
    writeLocal("cli.json", "v1");
    await service.syncNow();

    await service.addExclude("cli.json");
    await vi.waitFor(() => {
      if (!client.calls.del.includes("cli.json")) {
        throw new Error("purge still pending");
      }
    });
    // Let the follow-up reconcile settle before probing the no-op path.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const propfindSettled = client.calls.propfind.length;
    client.calls.del.length = 0;

    await service.addExclude("cli.json");

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(client.calls.del).toEqual([]);
    expect(client.calls.propfind.length).toBe(propfindSettled);
    expect(settings["sync.excludedPaths"]).toEqual(["cli.json"]);
  });

  it("continues the purge when a remote delete fails and still reconciles", async () => {
    writeLocal("AGENTS.md", "doc");
    await service.addItem("notes");
    writeLocal("notes/a.md", "a");
    writeLocal("notes/b.md", "b");
    await service.syncNow();
    client.delFailures.add("notes/a.md");
    const manifestPath = path.join(syncStorageDir(storageDir), "manifest.json");
    const internal = service as unknown as { autoSyncPaused: boolean };

    const deltasBefore = deltas.length;
    await service.addExclude("re:notes/.*\\.md");

    await vi.waitFor(() => {
      if (!client.calls.del.includes("notes/b.md")) {
        throw new Error("purge still pending");
      }
    });
    // conflictCount delta plus a completed reconcile pass.
    await vi.waitFor(() => {
      if (deltas.length < deltasBefore + 3) {
        throw new Error("reconcile still pending");
      }
    });
    expect(client.calls.del.sort()).toEqual(["notes/a.md", "notes/b.md"]);
    expect(client.files.has("notes/b.md")).toBe(false);
    expect(client.files.has("notes/a.md")).toBe(true);
    expect(client.files.has("AGENTS.md")).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(manifest.files["notes/b.md"]).toBeUndefined();
    // The failed file keeps its manifest entry for a later pass.
    expect(manifest.files["notes/a.md"]).toBeDefined();
    expect(internal.autoSyncPaused).toBe(false);
  });

  it("accepts and syncs re: pattern items with re: excludes and deny-list priority", async () => {
    // The exclude-add reconciliation is an automatic pass: lead first.
    (service as unknown as { isLeader: boolean }).isLeader = true;
    writeLocal("cli.json", "v1");
    writeLocal("notes/a.md", "a");
    writeLocal("notes/draft.md", "d");
    writeLocal("backup/state.db", "db");

    // Regex custom items persist verbatim and appear as pattern rows.
    await service.addItem("re:.*");
    expect(settings["sync.customItems"]).toEqual(["re:.*"]);
    let snapshot = await service.getSnapshot();
    expect(snapshot.items.find((item) => item.kind === "pattern")).toEqual({
      id: "re:.*",
      path: "re:.*",
      kind: "pattern",
      enabled: true,
      builtin: false,
    });

    // Regex excludes persist verbatim including the prefix.
    await service.addExclude("re:notes/draft\\.md");
    expect(settings["sync.excludedPaths"]).toEqual(["re:notes/draft\\.md"]);
    snapshot = await service.getSnapshot();
    expect(snapshot.excludes).toEqual(["re:notes/draft\\.md"]);

    // The exclude-add reconciliation uploads the pattern-matched files;
    // notes/draft.md is regex-excluded and the deny-listed state.db never
    // syncs although the greedy pattern matches it. The follow-up manual
    // pass must also terminate against the now-nested remote tree.
    const deadline = Date.now() + 5000;
    while (client.calls.put.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await service.syncNow();
    expect(client.calls.put.sort()).toEqual(["cli.json", "notes/a.md"]);
  });

  it("rejects invalid re: entries without touching settings", async () => {
    await service.addItem("re:([unclosed");
    expect(settings["sync.customItems"]).toEqual([]);

    await service.addItem("re:");
    expect(settings["sync.customItems"]).toEqual([]);

    await service.addExclude("re:*bad[syntax");
    expect(settings["sync.excludedPaths"] ?? []).toEqual([]);

    await service.addExclude("re:  ");
    expect(settings["sync.excludedPaths"] ?? []).toEqual([]);

    const rejections = posted
      .filter((m) => m.type === "webdavSaveResult" && m.ok === false)
      .map((m) => (m.type === "webdavSaveResult" && m.error) || "");
    // All four rejections carry the invalid-regex message.
    expect(rejections).toHaveLength(4);
    expect(new Set(rejections).size).toBe(1);
  });
});

describe("multi-window shared globalState", () => {
  const HISTORY_KEY = "webdavSync.history";
  let storageDir: string;
  let configDir: string;
  let previousConfigDir: string | undefined;
  let client: FakeClient;
  let context: vscodeTypes.ExtensionContext;
  let serviceA: ConfigSyncService;
  let serviceB: ConfigSyncService;

  function writeLocal(rel: string, content: string): void {
    const abs = path.join(configDir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }

  function persistedHistory(): WebDavHistoryEntry[] {
    return (context.globalState.get(HISTORY_KEY) ??
      []) as WebDavHistoryEntry[];
  }

  beforeEach(() => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-syncstore-"));
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-syncconf-"));
    previousConfigDir = process.env.OPENCODE_CONFIG_DIR;
    process.env.OPENCODE_CONFIG_DIR = configDir;

    const settings: Record<string, unknown> = {
      "sync.enabled": true,
      "sync.url": "https://dav.test",
      "sync.username": "user",
      "sync.basePath": "/opencode-config/",
      "sync.autoSyncEnabled": false,
      "sync.autoSyncOnStartup": false,
      "sync.autoSyncOnLocalChange": false,
      "sync.autoSyncRemotePoll": false,
      "sync.pollIntervalMinutes": 30,
      "sync.customItems": [],
      "sync.disabledItems": [],
      "sync.onConflict": "prompt",
      "sync.deletions": "prompt",
    };
    vi.mocked(vscode.workspace.getConfiguration).mockImplementation(((
      _section?: string,
    ) => ({
      get: (key: string, defaultValue?: unknown) =>
        key in settings ? settings[key] : defaultValue,
      inspect: () => undefined,
      update: async (key: string, value: unknown) => {
        settings[key] = value;
      },
    })) as never);

    client = new FakeClient();
    // Both windows share the context (and therefore globalState), the
    // manifest storage and the fake server, exactly like two VS Code
    // windows on one machine.
    context = makeContext(storageDir);
    const build = (): ConfigSyncService =>
      new ConfigSyncService(context, {
        logger: OutputChannelService.getInstance(),
        postWebviewMessage: () => undefined,
        isWebviewVisible: () => true,
        clientFactory: () => client,
      });
    serviceA = build();
    serviceB = build();
  });

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    serviceA.dispose();
    serviceB.dispose();
    OutputChannelService.resetInstance();
    if (previousConfigDir === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR;
    } else {
      process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
    }
    fs.rmSync(storageDir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it("merges appends from both windows instead of clobbering", async () => {
    writeLocal("cli.json", "one");
    await serviceA.syncNow();
    writeLocal("AGENTS.md", "two-a");
    writeLocal("opencode.json", "two-b");
    await serviceB.syncNow();

    // Both windows' entries survive in order; a whole-array write from B's
    // stale in-memory copy would have erased A's entry.
    const persisted = persistedHistory();
    expect(persisted).toHaveLength(2);
    expect(persisted[0]).toMatchObject({ files: 1, trigger: "manual" });
    expect(persisted[1]).toMatchObject({ files: 2, trigger: "manual" });
  });

  it("does not resurrect cleared entries from a stale in-memory copy", async () => {
    writeLocal("cli.json", "v1");
    await serviceA.syncNow();
    writeLocal("AGENTS.md", "v2");
    await serviceB.syncNow();

    await serviceA.clearHistory();

    // B still holds the pre-clear array in memory; its append must read
    // the cleared store instead of writing the stale copy back.
    writeLocal("opencode.json", "v3");
    await serviceB.syncNow();

    const persisted = persistedHistory();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ files: 1, trigger: "manual" });
  });

  it("serves cross-window entries from a fresh snapshot", async () => {
    writeLocal("cli.json", "one");
    await serviceA.syncNow();

    const snapshot = await serviceB.getSnapshot();
    expect(snapshot.history).toHaveLength(1);
    expect(snapshot.history[0]).toMatchObject({ trigger: "manual" });
  });

  it("persists an identical entry only once", async () => {
    const nowSpy = vi
      .spyOn(Date, "now")
      .mockImplementation(() => 1_700_000_000_000);
    try {
      await serviceA.syncNow();
      await serviceA.syncNow();
      const persisted = persistedHistory();
      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toMatchObject({
        direction: "none",
        files: 0,
        result: "success",
        trigger: "manual",
      });
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("cross-window status sharing", () => {
  let storageDir: string;
  let configDir: string;
  let previousConfigDir: string | undefined;
  let client: FakeClient;
  let context: vscodeTypes.ExtensionContext;
  let serviceA: ConfigSyncService;
  let extraServices: ConfigSyncService[];

  function writeLocal(rel: string, content: string): void {
    const abs = path.join(configDir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }

  function readLocal(rel: string): string {
    return fs.readFileSync(path.join(configDir, ...rel.split("/")), "utf8");
  }

  /** A sibling window: same storage, config dir and server as serviceA. */
  function buildWindow(posted: HostMessage[]): ConfigSyncService {
    const service = new ConfigSyncService(context, {
      logger: OutputChannelService.getInstance(),
      postWebviewMessage: (message) => {
        posted.push(message);
      },
      isWebviewVisible: () => true,
      clientFactory: () => client,
    });
    extraServices.push(service);
    return service;
  }

  /** Wait until the window's snapshot reports the given conflict count. */
  async function waitForConflicts(
    service: ConfigSyncService,
    conflictCount: number,
  ): Promise<WebDavSyncSnapshot> {
    return vi.waitFor(async () => {
      const snapshot = await service.getSnapshot();
      if (snapshot.conflictCount !== conflictCount) {
        throw new Error(`waiting for ${conflictCount} conflict(s)`);
      }
      return snapshot;
    });
  }

  beforeEach(() => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-syncstore-"));
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-syncconf-"));
    previousConfigDir = process.env.OPENCODE_CONFIG_DIR;
    process.env.OPENCODE_CONFIG_DIR = configDir;

    const settings: Record<string, unknown> = {
      "sync.enabled": true,
      "sync.url": "https://dav.test",
      "sync.username": "user",
      "sync.basePath": "/opencode-config/",
      "sync.autoSyncEnabled": false,
      "sync.autoSyncOnStartup": false,
      "sync.autoSyncOnLocalChange": false,
      "sync.autoSyncRemotePoll": false,
      "sync.pollIntervalMinutes": 30,
      "sync.customItems": [],
      "sync.disabledItems": [],
      "sync.onConflict": "prompt",
      "sync.deletions": "prompt",
    };
    vi.mocked(vscode.workspace.getConfiguration).mockImplementation(((
      _section?: string,
    ) => ({
      get: (key: string, defaultValue?: unknown) =>
        key in settings ? settings[key] : defaultValue,
      inspect: () => undefined,
      update: async (key: string, value: unknown) => {
        settings[key] = value;
      },
    })) as never);

    client = new FakeClient();
    // Both windows share the storage, config dir and fake server, exactly
    // like two VS Code windows on one machine.
    context = makeContext(storageDir);
    extraServices = [];
    serviceA = buildWindow([]);
  });

  afterEach(async () => {
    // Drain in-flight passes before the temp dirs vanish.
    for (const service of extraServices) {
      const internal = service as unknown as { syncing: boolean };
      const drainDeadline = Date.now() + 5000;
      while (internal.syncing && Date.now() < drainDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
      service.dispose();
    }
    OutputChannelService.resetInstance();
    if (previousConfigDir === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR;
    } else {
      process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
    }
    fs.rmSync(storageDir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it("shows conflicts detected in another window", async () => {
    // First-sync content difference without a baseline: one conflict.
    writeLocal("cli.json", "local-new");
    client.addFile("cli.json", "remote-new");
    await serviceA.syncNow();
    const snapshotA = await waitForConflicts(serviceA, 1);

    const serviceB = buildWindow([]);
    const snapshotB = await waitForConflicts(serviceB, 1);

    expect(snapshotB.conflicts.map((conflict) => conflict.id)).toEqual(
      snapshotA.conflicts.map((conflict) => conflict.id),
    );
    expect(snapshotB.state).toBe("idle");
    expect(snapshotB.lastSyncAt).toBe(snapshotA.lastSyncAt);
  });

  it("drops conflicts another window already resolved", async () => {
    writeLocal("cli.json", "local-new");
    client.addFile("cli.json", "remote-new");
    await serviceA.syncNow();
    const snapshotA = await waitForConflicts(serviceA, 1);
    const ids = snapshotA.conflicts.map((conflict) => conflict.id);

    const serviceB = buildWindow([]);
    // Window B saw the shared conflict list before the resolution.
    await waitForConflicts(serviceB, 1);

    await serviceA.resolveConflicts(ids, "local");
    expect(readLocal("cli.json")).toBe("local-new");

    const snapshotB = await serviceB.getSnapshot();
    expect(snapshotB.conflictCount).toBe(0);
    expect(snapshotB.conflicts).toEqual([]);
    expect(snapshotB.state).toBe("idle");
    expect(snapshotB.lastSyncAt).toBe(snapshotA.lastSyncAt);
  });

  it("propagates the missing-password state to other windows", async () => {
    // Settings arrived via VS Code Settings Sync but no password is
    // stored on this device: every pass ends in needsAuth without any
    // transfer, and the state must still reach sibling windows.
    context.secrets.get = vi.fn(async () => undefined);
    await serviceA.syncNow();
    const snapshotA = await serviceA.getSnapshot();
    expect(snapshotA.state).toBe("needsAuth");

    const serviceB = buildWindow([]);
    const snapshotB = await serviceB.getSnapshot();
    expect(snapshotB.state).toBe("needsAuth");
  });

  it("pushes a snapshot when another window rewrites the shared status", async () => {
    writeLocal("cli.json", "local-new");
    client.addFile("cli.json", "remote-new");
    await serviceA.syncNow();
    await waitForConflicts(serviceA, 1);

    // Capture the status-file watcher handlers of a freshly constructed
    // sibling window; only that window registers under this mock.
    const statusHandlers: Array<() => void> = [];
    vi.mocked(vscode.workspace.createFileSystemWatcher).mockImplementation(((
      (pattern: unknown) => {
        const isStatusWatcher =
          (pattern as { pattern?: string } | undefined)?.pattern ===
          "status.json";
        const register = (listener: () => void) => {
          if (isStatusWatcher) {
            statusHandlers.push(listener);
          }
          return { dispose: vi.fn() };
        };
        return {
          onDidChange: vi.fn(register),
          onDidCreate: vi.fn(register),
          onDidDelete: vi.fn(register),
          dispose: vi.fn(),
        };
      }
    ) as never));

    const postedB: HostMessage[] = [];
    buildWindow(postedB);
    expect(statusHandlers.length).toBe(3);

    const onStatusChange = statusHandlers[0];
    expect(onStatusChange).toBeDefined();
    onStatusChange?.();

    await vi.waitFor(() => {
      const messages = postedB.filter(
        (m): m is Extract<HostMessage, { type: "webdavSyncData" }> =>
          m.type === "webdavSyncData",
      );
      const last = messages[messages.length - 1];
      if (!last || last.snapshot.conflictCount !== 1) {
        throw new Error("waiting for the pushed shared snapshot");
      }
    });
  });

  it("serializes status writes so revisions are not computed concurrently", async () => {
    const serviceB = buildWindow([]);
    const internals = serviceB as unknown as {
      statusStore: SyncStatusStore;
      persistStatus: (options?: unknown) => Promise<void>;
    };
    const originalSave = internals.statusStore.save.bind(internals.statusStore);
    let inFlight = 0;
    let maxInFlight = 0;
    internals.statusStore.save = async (data: SyncStatusData) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await originalSave(data);
      inFlight -= 1;
    };

    await Promise.all([
      internals.persistStatus(),
      internals.persistStatus(),
    ]);

    expect(maxInFlight).toBe(1);
    expect((await internals.statusStore.load())?.revision).toBe(2);
  });

  it("does not resurrect conflicts another window already resolved", async () => {
    writeLocal("cli.json", "local-new");
    client.addFile("cli.json", "remote-new");
    await serviceA.syncNow();
    const snapshotA = await waitForConflicts(serviceA, 1);
    const ids = snapshotA.conflicts.map((conflict) => conflict.id);

    // Window B saw the shared conflict list, then window A resolved it.
    const serviceB = buildWindow([]);
    await waitForConflicts(serviceB, 1);
    await serviceA.resolveConflicts(ids, "local");
    expect((await serviceA.getSnapshot()).conflictCount).toBe(0);

    // B still holds the stale list in memory; a state-only write must keep
    // the file's (resolved) list instead of pushing the stale entries back.
    await (
      serviceB as unknown as { persistStatus: () => Promise<void> }
    ).persistStatus();

    expect((await new SyncStatusStore(storageDir).load())?.conflicts).toEqual(
      [],
    );
    expect((await serviceA.getSnapshot()).conflictCount).toBe(0);
  });

  it("keeps the machine lastSyncAt when a fresh window writes status", async () => {
    writeLocal("cli.json", "v1");
    await serviceA.syncNow();
    const snapshotA = await serviceA.getSnapshot();
    expect(snapshotA.lastSyncAt).toBeTypeOf("number");

    // B has not adopted the machine state yet and has no lastSyncAt of its
    // own; writing its status must not erase A's timestamp.
    const serviceB = buildWindow([]);
    await (
      serviceB as unknown as { persistStatus: () => Promise<void> }
    ).persistStatus();

    expect((await serviceA.getSnapshot()).lastSyncAt).toBe(
      snapshotA.lastSyncAt,
    );
  });

  it("adopts a sibling write that reuses the current revision", async () => {
    writeLocal("cli.json", "v1");
    await serviceA.syncNow();
    const store = new SyncStatusStore(storageDir);
    const current = await store.load();
    expect(current).toBeDefined();
    const foreignConflict = {
      id: "content:cli.json",
      path: "cli.json",
      kind: "content" as const,
    };
    await store.save({
      ...(current as SyncStatusData),
      writeId: "concurrent-sibling",
      conflicts: [foreignConflict],
    });

    const snapshot = await serviceA.getSnapshot();
    expect(snapshot.conflictCount).toBe(1);
    expect(snapshot.conflicts).toEqual([foreignConflict]);
  });
});
