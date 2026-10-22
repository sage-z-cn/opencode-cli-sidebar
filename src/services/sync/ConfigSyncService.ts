import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { l10n } from "../../i18n";
import type {
  HostMessage,
  WebDavConflictEntry,
  WebDavConflictKind,
  WebDavConnectionDraft,
  WebDavHistoryEntry,
  WebDavServerConfig,
  WebDavSyncOptions,
  WebDavSyncSettings,
  WebDavSyncItemUi,
  WebDavSyncSnapshot,
  WebDavSyncState,
  WebDavSyncStatusDelta,
  WebDavSyncTrigger,
} from "../../types";
import { OutputChannelService } from "../OutputChannelService";
import { resolveOpenCodeConfigDir } from "../openCodeConfigPath";
import {
  SyncManifest,
  hashContent,
  syncStorageDir,
} from "./SyncManifest";
import {
  PreconditionFailedError,
  WebDavClient,
  WebDavFatalError,
  WebDavRateLimitedError,
  WebDavTransientError,
  type WebDavClientOptions,
  type WebDavDeleteConditions,
  type WebDavPutConditions,
  type WebDavStat,
} from "./WebDavClient";
import {
  classifyEntry,
  collectItemFiles,
  deriveSyncItems,
  visibleSyncItems,
  isPathBlacklisted,
  isPathExcluded,
  isPathUnderItems,
  normalizeExcludes,
  validateExcludePath,
  type EntryRejection,
} from "./syncItems";

const CONFIG_SECTION = "opencode-cli-sidebar";
const HISTORY_KEY = "webdavSync.history";
const HISTORY_LIMIT = 20;
const LOG_LIMIT = 200;
const BACKUP_KEEP = 5;
const LOCAL_CHANGE_DEBOUNCE_MS = 30_000;
const MIN_POLL_MINUTES = 1;
const FIRST_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 16 * 60_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const REQUEST_TIMEOUT_MS = 15_000;
const DIFF_CLEANUP_DELAY_MS = 60_000;
const MIN_RATE_LIMIT_RESUME_MS = 30_000;
const MAX_RATE_LIMIT_RESUME_MS = 35 * 60_000;
const DEFAULT_RATE_LIMIT_WINDOW_MINUTES = 30;
const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 600;

/** What can start a sync pass; mirrors the persisted history trigger values. */
export type SyncTrigger = WebDavSyncTrigger;

export type SyncConflictPolicy = "prompt" | "preferLocal" | "preferRemote";
export type SyncDeletionPolicy = "prompt" | "ignore";

export interface SyncEngineConfig {
  enabled: boolean;
  url: string;
  username: string;
  basePath: string;
  allowInsecureHttp: boolean;
  acceptSelfSigned: boolean;
  autoSyncEnabled: boolean;
  autoSyncOnStartup: boolean;
  autoSyncOnLocalChange: boolean;
  autoSyncRemotePoll: boolean;
  pollIntervalMinutes: number;
  showStatusIcon: boolean;
  customItems: string[];
  disabledItems: string[];
  excludedPaths: string[];
  onConflict: SyncConflictPolicy;
  deletions: SyncDeletionPolicy;
  /** Max WebDAV requests per sliding window; 0 = unlimited. */
  rateLimitMaxRequests: number;
  /** Sliding window length in minutes; used for pacing and cooldowns. */
  rateLimitWindowMinutes: number;
}

/** Read the full sync configuration from user settings. */
export function readSyncConfig(): SyncEngineConfig {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  // Pacing only engages when both halves of the window are usable.
  const rawMaxRequests = Math.floor(
    config.get<number>(
      "sync.rateLimitMaxRequests",
      DEFAULT_RATE_LIMIT_MAX_REQUESTS,
    ) || 0,
  );
  const rawWindowMinutes = Math.floor(
    config.get<number>(
      "sync.rateLimitWindowMinutes",
      DEFAULT_RATE_LIMIT_WINDOW_MINUTES,
    ) || 0,
  );
  return {
    enabled: config.get<boolean>("sync.enabled", false),
    url: (config.get<string>("sync.url", "") ?? "").trim(),
    username: config.get<string>("sync.username", "") ?? "",
    basePath:
      config.get<string>("sync.basePath", "/opencode-config/") ||
      "/opencode-config/",
    allowInsecureHttp: config.get<boolean>("sync.allowInsecureHttp", false),
    acceptSelfSigned: config.get<boolean>("sync.acceptSelfSigned", false),
    autoSyncEnabled: config.get<boolean>("sync.autoSyncEnabled", false),
    autoSyncOnStartup: config.get<boolean>("sync.autoSyncOnStartup", true),
    autoSyncOnLocalChange: config.get<boolean>(
      "sync.autoSyncOnLocalChange",
      true,
    ),
    autoSyncRemotePoll: config.get<boolean>("sync.autoSyncRemotePoll", true),
    pollIntervalMinutes: Math.max(
      MIN_POLL_MINUTES,
      Math.floor(config.get<number>("sync.pollIntervalMinutes", 30) || 30),
    ),
    showStatusIcon: config.get<boolean>("sync.showStatusIcon", true),
    customItems: config.get<string[]>("sync.customItems", []) ?? [],
    disabledItems: config.get<string[]>("sync.disabledItems", []) ?? [],
    excludedPaths: config.get<string[]>("sync.excludedPaths", []) ?? [],
    onConflict:
      config.get<SyncConflictPolicy>("sync.onConflict", "prompt") ?? "prompt",
    deletions:
      config.get<SyncDeletionPolicy>("sync.deletions", "prompt") ?? "prompt",
    rateLimitMaxRequests:
      rawMaxRequests >= 1 && rawWindowMinutes >= 1 ? rawMaxRequests : 0,
    rateLimitWindowMinutes:
      rawWindowMinutes >= 1 ? rawWindowMinutes : DEFAULT_RATE_LIMIT_WINDOW_MINUTES,
  };
}

/** SecretStorage key for one server identity. */
export function webdavSecretKey(url: string, username: string): string {
  const digest = crypto
    .createHash("sha256")
    .update(`${url}${username}`, "utf8")
    .digest("hex");
  return `webdav.password.${digest.slice(0, 12)}`;
}

/** Inputs that decide which stored secret applies and whether sync is on. */
function needsAuthConfigKey(config: SyncEngineConfig): string {
  return JSON.stringify([config.enabled, config.url, config.username]);
}

export type SyncActionType =
  | "none"
  | "agree"
  | "upload"
  | "download"
  | "conflict"
  | "skip"
  | "forget";

export interface SyncAction {
  type: SyncActionType;
  kind?: WebDavConflictKind;
  /** Machine-readable cause hint when type is a conflict. */
  reason?: string;
}

export interface SyncDecisionInput {
  /** Current local content hash; null when the local file is missing. */
  localHash: string | null;
  /** Current remote content hash; null when the remote file is missing. */
  remoteHash: string | null;
  /** Baseline hash both sides agreed on at the last sync; null = never synced. */
  baselineHash: string | null;
  onConflict: SyncConflictPolicy;
  deletions: SyncDeletionPolicy;
}

/**
 * Pure three-way decision: local and remote state versus the manifest
 * baseline. Never deletes anything silently; deletions on either side
 * surface as conflicts unless the deletion policy says otherwise.
 */
export function decideSyncAction(input: SyncDecisionInput): SyncAction {
  const localExists = input.localHash !== null;
  const remoteExists = input.remoteHash !== null;
  const hasBaseline = input.baselineHash !== null;

  if (!localExists && !remoteExists) {
    return hasBaseline ? { type: "forget" } : { type: "none" };
  }

  if (localExists && remoteExists) {
    if (input.localHash === input.remoteHash) {
      return { type: "agree" };
    }
    if (!hasBaseline) {
      // First sync with two unknown histories: a non-prompt policy must
      // not pick a winner and silently discard the other side.
      return { type: "conflict", kind: "content", reason: "noBaseline" };
    }
    const localChanged = input.localHash !== input.baselineHash;
    const remoteChanged = input.remoteHash !== input.baselineHash;
    if (localChanged && remoteChanged) {
      if (input.onConflict === "preferLocal") {
        return { type: "upload" };
      }
      if (input.onConflict === "preferRemote") {
        return { type: "download" };
      }
      return { type: "conflict", kind: "content" };
    }
    if (localChanged) {
      return { type: "upload" };
    }
    return { type: "download" };
  }

  if (localExists) {
    if (!hasBaseline) {
      return { type: "upload" };
    }
    if (input.localHash !== input.baselineHash) {
      // Local edits made after the remote deletion must not be frozen out
      // by the ignore policy.
      return { type: "conflict", kind: "remoteDeleted" };
    }
    return input.deletions === "prompt"
      ? { type: "conflict", kind: "remoteDeleted" }
      : { type: "skip" };
  }

  if (!hasBaseline) {
    return { type: "download" };
  }
  return input.deletions === "prompt"
    ? { type: "conflict", kind: "localDeleted" }
    : { type: "skip" };
}

/** Minimal client surface the engine depends on (mockable in tests). */
export interface WebDavClientLike {
  propfind(path: string, depth: 0 | 1): Promise<WebDavStat[]>;
  get(path: string): Promise<Buffer>;
  put(
    path: string,
    content: Buffer,
    conditions?: WebDavPutConditions,
  ): Promise<void>;
  mkcol(path: string): Promise<void>;
  del(path: string, conditions?: WebDavDeleteConditions): Promise<void>;
  /** Create the base path plus missing ancestor collections. */
  ensureBasePath?(): Promise<void>;
}

export interface ConfigSyncServiceDeps {
  logger: OutputChannelService;
  /** Pushes full replies (snapshot/log/test/save) straight to the webview. */
  postWebviewMessage: (message: HostMessage) => void;
  /** Native-notification fallback gate; defaults to "visible". */
  isWebviewVisible?: () => boolean;
  /** Overridable client factory for tests. */
  clientFactory?: (options: WebDavClientOptions) => WebDavClientLike;
  /** Overridable config dir for tests. */
  configDirProvider?: () => string;
}

interface RemoteTree {
  files: Map<string, WebDavStat>;
  dirs: Set<string>;
  baseMissing: boolean;
}

/**
 * ConfigSyncService orchestrates WebDAV config sync: three-way merge of
 * local files against a remote tree with a persisted baseline manifest,
 * conflict surfacing/resolution, backups, and a circuit breaker around all
 * automatic trigger sources (startup sync, file watching, remote polling).
 */
export class ConfigSyncService implements vscode.Disposable {
  private readonly context: vscode.ExtensionContext;
  private readonly logger: OutputChannelService;
  private readonly postWebviewMessage: (message: HostMessage) => void;
  private readonly isWebviewVisible: () => boolean;
  private readonly clientFactory: (
    options: WebDavClientOptions,
  ) => WebDavClientLike;
  private readonly configDirProvider: () => string;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly _onDidChange = new vscode.EventEmitter<WebDavSyncStatusDelta>();
  public readonly onDidChange = this._onDidChange.event;

  private state: WebDavSyncState = "unconfigured";
  /** Connection inputs captured when the credentials state was entered, so
   *  a later settings edit can tell whether the verdict is still relevant. */
  private needsAuthConfigKey: string | undefined;
  private autoSyncPaused = false;
  private pendingCount = 0;
  /** Remote deletions completed by an exclude purge, reported by the next pass. */
  private pendingExcludeDeletes = 0;
  private lastSyncAt: number | undefined;
  private syncing = false;
  private conflicts = new Map<string, WebDavConflictEntry>();
  private history: WebDavHistoryEntry[] = [];
  /** Last history persistence write; awaited before re-reading the store
   * so a pending update of our own is never read back as stale. */
  private historyWrite: PromiseLike<void> = Promise.resolve();
  private logLines: string[] = [];

  private failureStreak = 0;
  private nextBackoffMs = FIRST_BACKOFF_MS;

  /** Reused across passes so the sliding-window request pacing persists. */
  private cachedClient:
    | { key: string; client: WebDavClientLike }
    | undefined;

  /** Serializes the sync transfer phase against conflict resolution. */
  private exclusiveQueue: Promise<void> = Promise.resolve();

  private watcher: vscode.FileSystemWatcher | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** One-shot resume after a server rate limit; replaces cleanly. */
  private rateLimitResumeTimer: ReturnType<typeof setTimeout> | undefined;
  private localChangeDebounce: ReturnType<typeof setTimeout> | undefined;

  public constructor(
    context: vscode.ExtensionContext,
    deps: ConfigSyncServiceDeps,
  ) {
    this.context = context;
    this.logger = deps.logger;
    this.postWebviewMessage = deps.postWebviewMessage;
    this.isWebviewVisible = deps.isWebviewVisible ?? (() => true);
    this.clientFactory =
      deps.clientFactory ?? ((options) => new WebDavClient(options));
    this.configDirProvider =
      deps.configDirProvider ?? (() => resolveOpenCodeConfigDir());

    this.history = this.loadHistory();

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration(`${CONFIG_SECTION}.sync`)) {
          return;
        }
        this.logger.debug(
          "[WebDavSync] sync settings changed; re-arming triggers",
        );
        this.clearNeedsAuthIfConfigChanged();
        this.armTriggers();
      }),
    );
    this.disposables.push(this._onDidChange);
  }

  /** Called once after activation: arms triggers and runs startup sync. */
  public initialize(): void {
    this.armTriggers();
    const config = readSyncConfig();
    if (
      config.enabled &&
      config.url &&
      config.autoSyncEnabled &&
      config.autoSyncOnStartup
    ) {
      void this.triggerAuto("startup");
    }
  }

  public dispose(): void {
    this.stopAutoTimers();
    this.cachedClient = undefined;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  // ── Snapshot & push channel ──

  public async getSnapshot(): Promise<WebDavSyncSnapshot> {
    // Cross-window freshness: other windows append to or clear the shared
    // store. Await our own pending write first so it is never read back
    // as stale, then re-read the merged persisted truth.
    await this.historyWrite;
    this.history = this.loadHistory();
    const config = readSyncConfig();
    const configured = config.enabled && !!config.url;
    let passwordSet = false;
    if (config.url) {
      try {
        passwordSet =
          (await this.context.secrets.get(
            webdavSecretKey(config.url, config.username),
          )) != null;
      } catch {
        passwordSet = false;
      }
    }
    return {
      state: configured ? this.state : "unconfigured",
      pendingCount: this.pendingCount,
      conflictCount: this.conflicts.size,
      lastSyncAt: this.lastSyncAt,
      lastSyncLabel: this.lastSyncAt
        ? relativeTimeLabel(this.lastSyncAt)
        : undefined,
      autoSyncPaused: this.autoSyncPaused,
      settings: {
        url: config.url,
        username: config.username,
        basePath: config.basePath,
        allowInsecureHttp: config.allowInsecureHttp,
        acceptSelfSigned: config.acceptSelfSigned,
        rateLimitMaxRequests: config.rateLimitMaxRequests,
        rateLimitWindowMinutes: config.rateLimitWindowMinutes,
        autoSync: {
          enabled: config.autoSyncEnabled,
          onStartup: config.autoSyncOnStartup,
          onLocalChange: config.autoSyncOnLocalChange,
          remotePoll: config.autoSyncRemotePoll,
        },
        pollIntervalMinutes: config.pollIntervalMinutes,
        showStatusIcon: config.showStatusIcon,
        passwordSet,
      },
      items: visibleSyncItems(config.customItems, config.disabledItems),
      excludes: normalizeExcludes(config.excludedPaths),
      conflicts: [...this.conflicts.values()],
      history: [...this.history].reverse(),
    };
  }

  private pushDelta(delta: WebDavSyncStatusDelta): void {
    this._onDidChange.fire(delta);
  }

  // ── Webview message entry points ──

  public async requestSyncData(): Promise<void> {
    this.postWebviewMessage({
      type: "webdavSyncData",
      snapshot: await this.getSnapshot(),
    });
  }

  public async requestLog(): Promise<void> {
    this.postWebviewMessage({ type: "webdavLog", lines: [...this.logLines] });
  }

  /** Wipe the persisted sync history; the open panel refreshes immediately. */
  public async clearHistory(): Promise<void> {
    this.history = [];
    this.historyWrite = this.context.globalState
      .update(HISTORY_KEY, [])
      .then(undefined, () => undefined);
    await this.historyWrite;
    this.log("info", "sync history cleared");
    await this.requestSyncData();
  }

  /**
   * Explicit server-card save: persists the connection fields and, when a
   * password was typed, the SecretStorage credential. Saving re-arms the
   * circuit breaker and kicks off one sync pass with the fresh credentials.
   */
  public async saveServerConfig(
    config: WebDavServerConfig,
    password?: string,
  ): Promise<void> {
    try {
      const previous = readSyncConfig();
      const nextUrl = config.url.trim();
      const nextUsername = config.username ?? "";
      const identityChanged =
        previous.url !== nextUrl || previous.username !== nextUsername;
      const nextKey = webdavSecretKey(nextUrl, nextUsername);
      const rateLimitMax = config.rateLimitMaxRequests;
      const rateLimitWindow = config.rateLimitWindowMinutes;
      const rateLimitInvalid =
        (rateLimitMax !== undefined &&
          (!Number.isInteger(rateLimitMax) || rateLimitMax < 0)) ||
        (rateLimitWindow !== undefined &&
          (!Number.isInteger(rateLimitWindow) || rateLimitWindow < 1));
      if (rateLimitInvalid) {
        this.postWebviewMessage({
          type: "webdavSaveResult",
          ok: false,
          error: l10n.t("The rate limit values are not valid."),
        });
        return;
      }
      const target = vscode.workspace.getConfiguration(CONFIG_SECTION);
      const global = vscode.ConfigurationTarget.Global;
      await target.update("sync.url", nextUrl, global);
      await target.update("sync.enabled", true, global);
      await target.update("sync.username", nextUsername, global);
      await target.update("sync.basePath", config.basePath ?? "", global);
      await target.update(
        "sync.allowInsecureHttp",
        !!config.allowInsecureHttp,
        global,
      );
      await target.update(
        "sync.acceptSelfSigned",
        !!config.acceptSelfSigned,
        global,
      );
      if (rateLimitMax !== undefined) {
        await target.update("sync.rateLimitMaxRequests", rateLimitMax, global);
      }
      if (rateLimitWindow !== undefined) {
        await target.update(
          "sync.rateLimitWindowMinutes",
          rateLimitWindow,
          global,
        );
      }
      if (password !== undefined) {
        if (password === "") {
          await this.context.secrets.delete(nextKey);
        } else {
          await this.context.secrets.store(nextKey, password);
        }
      }
      if (identityChanged && webdavSecretKey(previous.url, previous.username) !== nextKey) {
        // A changed server identity orphans the old derived secret key;
        // removing it is best-effort and never fails the save.
        try {
          await this.context.secrets.delete(
            webdavSecretKey(previous.url, previous.username),
          );
        } catch (error) {
          this.logger.warn(
            `[WebDavSync] failed to remove the stale stored password: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      this.postWebviewMessage({ type: "webdavSaveResult", ok: true });
      this.log("info", "server config saved; re-arming auto sync");
      this.rearm();
      void this.runSync("configSave").catch(() => undefined);
    } catch (error) {
      this.logger.error(
        `[WebDavSync] failed to save server config: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.postWebviewMessage({
        type: "webdavSaveResult",
        ok: false,
        error: l10n.t("Could not save the sync settings."),
      });
    }
  }

  /**
   * Immediate apply for behavior options: persists the auto-sync toggles,
   * poll interval and status-icon preference, then reconfigures the watcher
   * and poller right away. Never touches credentials and never re-arms the
   * circuit breaker.
   */
  public async applySyncOptions(options: WebDavSyncOptions): Promise<void> {
    try {
      const target = vscode.workspace.getConfiguration(CONFIG_SECTION);
      const global = vscode.ConfigurationTarget.Global;
      await target.update(
        "sync.autoSyncEnabled",
        !!options.autoSync?.enabled,
        global,
      );
      await target.update(
        "sync.autoSyncOnStartup",
        !!options.autoSync?.onStartup,
        global,
      );
      await target.update(
        "sync.autoSyncOnLocalChange",
        !!options.autoSync?.onLocalChange,
        global,
      );
      await target.update(
        "sync.autoSyncRemotePoll",
        !!options.autoSync?.remotePoll,
        global,
      );
      await target.update(
        "sync.pollIntervalMinutes",
        Math.max(MIN_POLL_MINUTES, Math.floor(options.pollIntervalMinutes || 30)),
        global,
      );
      await target.update(
        "sync.showStatusIcon",
        !!options.showStatusIcon,
        global,
      );
      // Reuse the settings-change path so watcher and poller honor the new
      // options immediately instead of waiting for the next event.
      this.armTriggers();
      this.postWebviewMessage({ type: "webdavSaveResult", ok: true });
      this.log("info", "sync options applied; triggers reconfigured");
      this.pushDelta({ state: this.state, autoSyncPaused: this.autoSyncPaused });
    } catch (error) {
      this.logger.error(
        `[WebDavSync] failed to apply sync options: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.postWebviewMessage({
        type: "webdavSaveResult",
        ok: false,
        error: l10n.t("Could not save the sync settings."),
      });
    }
  }

  public async testConnection(draft: WebDavConnectionDraft): Promise<void> {
    const started = Date.now();
    try {
      const password = await this.resolvePassword(
        draft.url.trim(),
        draft.username ?? "",
        draft.password,
      );
      const client = this.clientFactory({
        url: draft.url,
        username: draft.username,
        password,
        basePath: draft.basePath,
        allowInsecureHttp: draft.allowInsecureHttp,
        acceptSelfSigned: draft.acceptSelfSigned,
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      await client.propfind("", 1);
      this.postWebviewMessage({
        type: "webdavTestResult",
        ok: true,
        latencyMs: Date.now() - started,
      });
    } catch (error) {
      if (
        error instanceof WebDavTransientError &&
        error.status === 404
      ) {
        // basePath 尚不存在：服务器可达且凭据已验证，目录将在首次同步时自动创建。
        this.postWebviewMessage({
          type: "webdavTestResult",
          ok: true,
          latencyMs: Date.now() - started,
        });
        return;
      }
      this.postWebviewMessage({
        type: "webdavTestResult",
        ok: false,
        latencyMs: Date.now() - started,
        message: describeConnectionError(error),
      });
    }
  }

  public async setItemEnabled(id: string, enabled: boolean): Promise<void> {
    const config = readSyncConfig();
    const items = deriveSyncItems(config.customItems, config.disabledItems);
    const item = items.find((candidate) => candidate.id === id);
    if (!item) {
      return;
    }
    const disabled = new Set(config.disabledItems);
    if (enabled) {
      disabled.delete(item.path);
    } else {
      disabled.add(item.path);
    }
    await vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .update(
        "sync.disabledItems",
        [...disabled],
        vscode.ConfigurationTarget.Global,
      );
    this.armWatcher();
    await this.requestSyncData();
  }

  public async addItem(rawPath: string): Promise<void> {
    const classification = classifyEntry(rawPath);
    if (classification.kind === "invalid") {
      this.postWebviewMessage({
        type: "webdavSaveResult",
        ok: false,
        error: describeItemRejection(classification.reason),
      });
      return;
    }
    // Regex entries persist verbatim including the `re:` prefix; literal
    // entries persist their normalized POSIX path.
    const stored =
      classification.kind === "regex" ? rawPath.trim() : classification.value;
    const config = readSyncConfig();
    const shadowsBuiltin =
      classification.kind === "path" &&
      deriveSyncItems([], []).some((item) => item.path === stored);
    if (shadowsBuiltin || config.customItems.includes(stored)) {
      await this.requestSyncData();
      return;
    }
    await vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .update(
        "sync.customItems",
        [...config.customItems, stored],
        vscode.ConfigurationTarget.Global,
      );
    this.armWatcher();
    await this.requestSyncData();
  }

  public async removeItem(id: string): Promise<void> {
    const config = readSyncConfig();
    const items = deriveSyncItems(config.customItems, config.disabledItems);
    const item = items.find((candidate) => candidate.id === id);
    if (!item || item.builtin) {
      return;
    }
    await vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .update(
        "sync.customItems",
        config.customItems.filter((path) => path !== item.path),
        vscode.ConfigurationTarget.Global,
      );
    if (config.disabledItems.includes(item.path)) {
      await vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .update(
          "sync.disabledItems",
          config.disabledItems.filter((path) => path !== item.path),
          vscode.ConfigurationTarget.Global,
        );
    }
    this.armWatcher();
    await this.requestSyncData();
  }

  /**
   * Adds one exclude path: persisted to sync.excludedPaths after
   * validation, then one reconciliation pass runs so files that just left
   * or re-entered the sync scope are picked up.
   */
  public async addExclude(rawPath: string): Promise<void> {
    await this.updateExclude(rawPath, "add");
  }

  /** Removes one exclude path and reconciles the changed scope. */
  public async removeExclude(rawPath: string): Promise<void> {
    await this.updateExclude(rawPath, "remove");
  }

  private async updateExclude(
    rawPath: string,
    action: "add" | "remove",
  ): Promise<void> {
    const classification = validateExcludePath(rawPath);
    if (classification.kind === "invalid") {
      this.postWebviewMessage({
        type: "webdavSaveResult",
        ok: false,
        error: describeItemRejection(classification.reason),
      });
      return;
    }
    // Regex entries persist verbatim including the `re:` prefix; literal
    // entries persist their normalized POSIX path.
    const stored =
      classification.kind === "regex" ? rawPath.trim() : classification.value;
    const config = readSyncConfig();
    const existing = normalizeExcludes(config.excludedPaths);
    // Patterns compare by exact text; literal paths follow platform casing.
    const keyOf = (value: string) =>
      classification.kind === "regex"
        ? value
        : process.platform === "win32"
          ? value.toLowerCase()
          : value;
    let next: string[];
    if (action === "add") {
      if (existing.some((entry) => keyOf(entry) === keyOf(stored))) {
        await this.requestSyncData();
        return;
      }
      next = [...existing, stored];
    } else {
      next = existing.filter((entry) => keyOf(entry) !== keyOf(stored));
      if (next.length === existing.length) {
        await this.requestSyncData();
        return;
      }
    }
    try {
      await vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .update(
          "sync.excludedPaths",
          next,
          vscode.ConfigurationTarget.Global,
        );
      this.armWatcher();
      this.postWebviewMessage({ type: "webdavSaveResult", ok: true });
      this.log("info", `exclude ${action === "add" ? "added" : "removed"}: ${stored}`);
      this.pushDelta({ conflictCount: this.conflicts.size });
      if (action === "add") {
        // Newly excluded files leave the server right away, then one
        // reconcile pass observes the cleaned scope.
        void this.purgeRemoteForExclude(stored)
          .then(() => this.triggerAuto("excludeChange"))
          .catch(() => undefined);
      } else {
        // Scope changed: reconcile once like other sync-item changes.
        void this.triggerAuto("excludeChange");
      }
      await this.requestSyncData();
    } catch (error) {
      this.logger.error(
        `[WebDavSync] failed to update excludes: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.postWebviewMessage({
        type: "webdavSaveResult",
        ok: false,
        error: l10n.t("Could not save the sync settings."),
      });
    }
  }

  public async syncNow(): Promise<void> {
    const config = readSyncConfig();
    if (!config.enabled || !config.url) {
      await this.requestSyncData();
      return;
    }
    await this.runSync("manual");
  }

  // ── Conflict resolution & diff ──

  public async resolveConflict(
    id: string,
    resolution: "local" | "remote",
  ): Promise<void> {
    await this.resolveConflicts([id], resolution);
  }

  /** Batch variant: one exclusive pass and one snapshot refresh for the
   *  whole selection, so resolving a long conflict list does not queue a
   *  pass per file. Unknown or already-resolved ids are skipped. */
  public async resolveConflicts(
    ids: string[],
    resolution: "local" | "remote",
  ): Promise<void> {
    const config = readSyncConfig();
    if (!config.enabled || !config.url) {
      return;
    }
    const targets = [...new Set(ids)];
    if (targets.length === 0) {
      return;
    }
    // Resolution and the sync transfer phase share one manifest; their
    // read-modify-write cycles must never interleave.
    await this.enqueueExclusive(async () => {
      let failed = 0;
      for (const id of targets) {
        const current = this.conflicts.get(id);
        if (!current) {
          continue;
        }
        const rel = current.path;
        try {
          const reconflicted = await this.resolveConflictEntry(
            config,
            current,
            resolution,
          );
          if (reconflicted) {
            this.log(
              "warn",
              `conflict resolution incomplete; conflict kept for ${rel}`,
            );
          } else {
            this.conflicts.delete(id);
            this.log(
              "info",
              `conflict resolved (${current.kind}/${resolution}): ${rel}`,
            );
          }
        } catch (error) {
          failed += 1;
          this.logger.error(
            `[WebDavSync] failed to resolve conflict ${id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      this.pushDelta({ conflictCount: this.conflicts.size });
      await this.requestSyncData();
      if (failed > 0) {
        void vscode.window.showErrorMessage(
          failed === 1
            ? l10n.t("Could not resolve the sync conflict.")
            : l10n.t("Could not resolve {0} sync conflicts.", failed),
        );
      }
    });
  }

  private async resolveConflictEntry(
    config: SyncEngineConfig,
    current: WebDavConflictEntry,
    resolution: "local" | "remote",
  ): Promise<boolean> {
    let reconflicted = false;
    const recordConflict = (entry: WebDavConflictEntry): void => {
      for (const key of [...this.conflicts.keys()]) {
        if (this.conflicts.get(key)?.path === entry.path) {
          this.conflicts.delete(key);
        }
      }
      this.conflicts.set(entry.id, entry);
      reconflicted = true;
    };
    const client = await this.createClientFromSettings(config);
    const rel = current.path;
    const abs = this.toAbsoluteLocalPath(rel);
    let localStat: fs.Stats | undefined;
    try {
      localStat = await fs.promises.stat(abs);
    } catch {
      localStat = undefined;
    }
    const manifest = new SyncManifest(this.globalStoragePath());
    await manifest.load();
    switch (current.kind) {
      case "content":
        if (resolution === "local") {
          // Overwrite only the version the user reviewed. A change
          // landing since the conflict was detected surfaces as a
          // fresh conflict instead of being silently destroyed.
          const remoteStat = await this.statRemoteFile(client, rel);
          if (
            remoteStat &&
            !this.remoteStateMatchesConflict(current, remoteStat)
          ) {
            recordConflict(
              this.conflictEntry(
                rel,
                "content",
                localStat,
                remoteStat,
                "remoteChanged",
              ),
            );
            this.log(
              "warn",
              `conflict kept; the server copy changed since it was detected: ${rel}`,
            );
            break;
          }
          await this.uploadFile(
            client,
            rel,
            abs,
            manifest,
            new Set(),
            true,
            {
              exists: remoteStat !== null,
              etag: remoteStat?.etag ?? null,
            },
            recordConflict,
          );
        } else {
          await this.downloadFile(
            client,
            rel,
            abs,
            manifest,
            null,
            null,
            null,
            recordConflict,
          );
        }
        break;
      case "localDeleted":
        if (resolution === "local") {
          const remoteStat = await this.statRemoteFile(client, rel);
          if (!remoteStat) {
            manifest.remove(rel);
          } else if (
            !this.remoteStateMatchesConflict(current, remoteStat)
          ) {
            // Never delete a server copy the user has not seen.
            recordConflict(
              this.conflictEntry(
                rel,
                "localDeleted",
                localStat,
                remoteStat,
                "remoteChanged",
              ),
            );
            this.log(
              "warn",
              `conflict kept; the server copy changed since it was detected: ${rel}`,
            );
          } else {
            try {
              await client.del(
                rel,
                remoteStat.etag ? { ifMatch: remoteStat.etag } : undefined,
              );
              manifest.remove(rel);
            } catch (error) {
              if (error instanceof PreconditionFailedError) {
                const latest = await this.statRemoteFile(client, rel).catch(
                  () => undefined,
                );
                if (latest === null) {
                  manifest.remove(rel);
                } else {
                  recordConflict(
                    this.conflictEntry(
                      rel,
                      "localDeleted",
                      localStat,
                      latest ?? remoteStat,
                      "preconditionFailed",
                    ),
                  );
                  this.log(
                    "warn",
                    `conflict kept; the server copy changed during resolution: ${rel}`,
                  );
                }
              } else {
                throw error;
              }
            }
          }
        } else {
          await this.downloadFile(
            client,
            rel,
            abs,
            manifest,
            null,
            null,
            null,
            recordConflict,
          );
        }
        break;
      case "remoteDeleted":
        if (resolution === "local") {
          // A recreated remote is a version the user never reviewed;
          // do not clobber it just because they picked "keep local"
          // over the old deletion.
          const remoteStat = await this.statRemoteFile(client, rel);
          if (remoteStat) {
            recordConflict(
              this.conflictEntry(
                rel,
                "content",
                localStat,
                remoteStat,
                "remoteChanged",
              ),
            );
            this.log(
              "warn",
              `conflict kept; the server copy was recreated since it was detected: ${rel}`,
            );
            break;
          }
          await this.uploadFile(
            client,
            rel,
            abs,
            manifest,
            new Set(),
            true,
            { exists: false, etag: null },
            recordConflict,
          );
        } else {
          const backedUp = await this.backupLocalFile(abs, rel);
          if (!backedUp) {
            // Never delete the local copy without a backup.
            recordConflict(
              this.conflictEntry(
                rel,
                "remoteDeleted",
                undefined,
                undefined,
                "backupFailed",
              ),
            );
            this.log(
              "warn",
              `conflict kept; backup failed before deleting the local file: ${rel}`,
            );
          } else {
            await fs.promises.rm(abs, { force: true });
            manifest.remove(rel);
          }
        }
        break;
    }
    await manifest.save();
    return reconflicted;
  }

  public async openDiff(id: string): Promise<void> {
    const conflict = this.conflicts.get(id);
    if (!conflict) {
      return;
    }
    const config = readSyncConfig();
    if (!config.enabled || !config.url) {
      return;
    }
    const rel = conflict.path;
    const abs = this.toAbsoluteLocalPath(rel);
    const tempDir = path.join(
      os.tmpdir(),
      `opencode-webdav-diff-${Date.now()}`,
    );
    try {
      let remoteContent: Buffer | null = null;
      if (conflict.kind !== "remoteDeleted") {
        const client = await this.createClientFromSettings(config);
        remoteContent = await client.get(rel);
      }
      await fs.promises.mkdir(tempDir, { recursive: true });
      const baseName = path.basename(rel);
      const remoteTemp = path.join(tempDir, `${baseName}.remote`);
      await fs.promises.writeFile(remoteTemp, remoteContent ?? Buffer.alloc(0));
      let localPath = abs;
      if (!fs.existsSync(abs)) {
        localPath = path.join(tempDir, `${baseName}.local`);
        await fs.promises.writeFile(localPath, Buffer.alloc(0));
      }
      await vscode.commands.executeCommand(
        "vscode.diff",
        vscode.Uri.file(localPath),
        vscode.Uri.file(remoteTemp),
        l10n.t("Sync conflict: {path}", { path: baseName }),
      );
      // The diff editor needs the temp files for a while; clean them up
      // once the viewer has surely read them.
      const cleanupTimer = setTimeout(() => {
        void fs.promises
          .rm(tempDir, { recursive: true, force: true })
          .catch(() => undefined);
      }, DIFF_CLEANUP_DELAY_MS);
      cleanupTimer.unref();
    } catch (error) {
      this.logger.error(
        `[WebDavSync] failed to open diff for ${rel}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      void vscode.window.showErrorMessage(
        l10n.t("Could not open the comparison view."),
      );
      try {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }

  // ── Trigger sources ──

  private armTriggers(): void {
    this.armWatcher();
    this.armPoller();
  }

  private armWatcher(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
    const config = readSyncConfig();
    if (
      !config.enabled ||
      !config.url ||
      !config.autoSyncEnabled ||
      !config.autoSyncOnLocalChange
    ) {
      return;
    }
    try {
      const pattern = new vscode.RelativePattern(
        vscode.Uri.file(this.configDirProvider()),
        "**/*",
      );
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      const onEvent = (uri: vscode.Uri) => this.onLocalFileEvent(uri);
      watcher.onDidChange(onEvent);
      watcher.onDidCreate(onEvent);
      watcher.onDidDelete(onEvent);
      this.watcher = watcher;
    } catch (error) {
      this.logger.warn(
        `[WebDavSync] failed to create file watcher: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private onLocalFileEvent(uri: vscode.Uri): void {
    const config = readSyncConfig();
    if (
      !config.enabled ||
      !config.url ||
      !config.autoSyncEnabled ||
      !config.autoSyncOnLocalChange ||
      this.autoSyncPaused
    ) {
      return;
    }
    const rel = this.toRelativeLocalPath(uri.fsPath);
    if (!rel) {
      return;
    }
    const enabledItems = deriveSyncItems(
      config.customItems,
      config.disabledItems,
    ).filter((item) => item.enabled);
    if (!isPathUnderItems(rel, enabledItems)) {
      return;
    }
    // Events inside excluded paths never count as local changes.
    if (isPathExcluded(rel, normalizeExcludes(config.excludedPaths))) {
      return;
    }
    if (this.localChangeDebounce) {
      clearTimeout(this.localChangeDebounce);
    }
    this.localChangeDebounce = setTimeout(() => {
      this.localChangeDebounce = undefined;
      void this.triggerAuto("localChange");
    }, LOCAL_CHANGE_DEBOUNCE_MS);
  }

  private armPoller(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    const config = readSyncConfig();
    if (
      !config.enabled ||
      !config.url ||
      !config.autoSyncEnabled ||
      !config.autoSyncRemotePoll
    ) {
      return;
    }
    this.pollTimer = setInterval(() => {
      void this.triggerAuto("poll");
    }, config.pollIntervalMinutes * 60_000);
  }

  private async triggerAuto(trigger: SyncTrigger): Promise<void> {
    if (this.autoSyncPaused) {
      return;
    }
    // Credentials are missing or rejected: no automatic trigger can fix
    // that, and retrying would only hammer the server. Saving the server
    // card (rearm) or a manual sync retries the pass.
    if (this.state === "needsAuth") {
      return;
    }
    // During a rate-limit cooldown the scheduled resume owns the next
    // pass; other automatic triggers would only burn quota.
    if (this.rateLimitResumeTimer) {
      return;
    }
    const config = readSyncConfig();
    if (!config.enabled || !config.url) {
      return;
    }
    await this.runSync(trigger);
  }

  // ── Circuit breaker ──

  private pauseAutoSync(reason: string): void {
    const wasPaused = this.autoSyncPaused;
    this.autoSyncPaused = true;
    this.state = "error";
    this.stopAutoTimers();
    this.log("warn", `automatic sync paused: ${reason}`);
    if (!wasPaused) {
      this.pushDelta({ state: "error", autoSyncPaused: true });
    }
  }

  private rearm(): void {
    this.autoSyncPaused = false;
    this.failureStreak = 0;
    this.nextBackoffMs = FIRST_BACKOFF_MS;
    this.needsAuthConfigKey = undefined;
    this.clearRateLimitResume();
    const config = readSyncConfig();
    this.state = config.enabled && config.url ? "idle" : "unconfigured";
    this.armTriggers();
    this.pushDelta({ state: this.state, autoSyncPaused: false });
  }

  /** Enter the credentials state and remember which connection inputs it was
   *  based on, so unrelated option edits do not resurrect a stale verdict. */
  private enterNeedsAuth(): void {
    this.state = "needsAuth";
    this.needsAuthConfigKey = needsAuthConfigKey(readSyncConfig());
  }

  /**
   * The password is not a setting, but the URL and username decide which
   * stored secret applies and whether sync is enabled at all. Changing them
   * makes the previous "credentials rejected" verdict obsolete, so drop the
   * latch and let the next automatic trigger run again. Deliberately does
   * not start a pass: saving the server card already re-arms and syncs, and
   * triggering here could race that save before its secret is stored.
   */
  private clearNeedsAuthIfConfigChanged(): void {
    if (this.state !== "needsAuth") {
      return;
    }
    const config = readSyncConfig();
    if (this.needsAuthConfigKey === needsAuthConfigKey(config)) {
      return;
    }
    this.needsAuthConfigKey = undefined;
    this.state = config.enabled && config.url ? "idle" : "unconfigured";
    this.log("info", "sync settings changed; credentials state cleared");
    this.pushDelta({ state: this.state });
  }

  private stopAutoTimers(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.clearRateLimitResume();
    if (this.localChangeDebounce) {
      clearTimeout(this.localChangeDebounce);
      this.localChangeDebounce = undefined;
    }
  }

  /** Cancel a pending rate-limit resume; safe when none is scheduled. */
  private clearRateLimitResume(): void {
    if (this.rateLimitResumeTimer) {
      clearTimeout(this.rateLimitResumeTimer);
      this.rateLimitResumeTimer = undefined;
    }
  }

  // ── Sync engine ──

  private async runSync(trigger: SyncTrigger): Promise<void> {
    // Single-flight: triggers arriving mid-run are merged into the pass
    // that is already scanning both sides.
    if (this.syncing) {
      this.log("debug", `sync already running; ${trigger} merged and skipped`);
      if (trigger === "manual") {
        this.pushDelta({
          notice: l10n.t(
            "A sync is already in progress. Try again when it finishes.",
          ),
        });
      }
      return;
    }
    this.syncing = true;
    try {
      await this.enqueueExclusive(() => this.executeSync(trigger));
    } finally {
      this.syncing = false;
      // The open panel refreshes its lists only from full snapshots, so
      // every completed run — success or failure — pushes one with the
      // final state, including any history entry just recorded. The
      // merged-skip path above returns before this point and never pushes.
      await this.requestSyncData();
    }
  }

  /**
   * Run one operation at a time on the promise chain so the sync transfer
   * phase and conflict resolution never interleave. Operations must not
   * wait on each other's results or the chain deadlocks.
   */
  private enqueueExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.exclusiveQueue.then(operation, operation);
    this.exclusiveQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async executeSync(trigger: SyncTrigger): Promise<void> {
    const config = readSyncConfig();
    if (!config.enabled || !config.url) {
      this.state = "unconfigured";
      this.pushDelta({ state: "unconfigured" });
      return;
    }
    const password = await this.resolvePassword(
      config.url,
      config.username,
      undefined,
    );
    // SecretStorage is per-device while VS Code Settings Sync carries the
    // server config: after setup on a second machine the username often
    // arrives without its password. Skip the network pass and surface a
    // credentials state instead of a server error or a paused breaker.
    if (config.username !== "" && password === undefined) {
      const wasNeedsAuth = this.state === "needsAuth";
      this.enterNeedsAuth();
      if (!wasNeedsAuth) {
        this.log(
          "info",
          "sync skipped: no WebDAV password is stored on this device",
        );
        this.pushDelta({ state: "needsAuth" });
      }
      return;
    }
    this.state = "syncing";
    this.pushDelta({ state: "syncing" });
    // Visible to the catch blocks so an aborted pass can checkpoint.
    let applyAgreesAndForgets: (() => Promise<void>) | undefined;
    let completedUploads = 0;
    let completedDownloads = 0;
    try {
      const client = await this.createClientFromSettings(config, password);
      const remote = await this.walkRemote(client);
      const items = deriveSyncItems(
        config.customItems,
        config.disabledItems,
      ).filter((item) => item.enabled);
      const excludes = normalizeExcludes(config.excludedPaths);
      const configDir = this.configDirProvider();
      const localFiles = new Set(
        await collectItemFiles(items, configDir, excludes),
      );
      const manifest = new SyncManifest(this.globalStoragePath());
      await manifest.load();

      const uploads: string[] = [];
      const downloads: string[] = [];
      const agrees: Array<{ rel: string; etag: string | null; hash: string }> =
        [];
      const forgets: string[] = [];
      const nextConflicts = new Map<string, WebDavConflictEntry>();
      const remoteContentCache = new Map<string, Buffer>();
      // Local state snapshot the decisions are based on; the write phase
      // re-checks it so edits landing mid-sync are never overwritten.
      const capturedStats = new Map<string, { size: number; mtimeMs: number }>();
      let fileErrors = 0;
      // Recompute from scratch: a previous aborted pass may have counted
      // files that this scan will count again.
      this.pendingCount = 0;

      const allPaths = new Set<string>([
        ...remote.files.keys(),
        ...localFiles,
        ...manifest.paths(),
      ]);

      for (const rel of allPaths) {
        // The credential deny-list outranks every item and pattern match.
        if (
          !isPathUnderItems(rel, items) ||
          isPathExcluded(rel, excludes) ||
          isPathBlacklisted(rel)
        ) {
          continue;
        }
        const entry = manifest.get(rel);
        const baselineHash = entry?.baselineHash ?? null;
        let localHash: string | null = null;
        let localStat: fs.Stats | undefined;
        const localAbs = this.toAbsoluteLocalPath(rel);
        if (localFiles.has(rel)) {
          try {
            const [content, stat] = await Promise.all([
              fs.promises.readFile(localAbs),
              fs.promises.stat(localAbs),
            ]);
            localHash = hashContent(content);
            localStat = stat;
            capturedStats.set(rel, { size: stat.size, mtimeMs: stat.mtimeMs });
          } catch {
            localHash = null;
          }
        }
        if (localHash !== null && localHash !== baselineHash) {
          this.pendingCount++;
        }
        const stat = remote.files.get(rel);
        let remoteHash: string | null = null;
        if (stat) {
          const etagUnchanged =
            entry &&
            entry.remoteEtag !== null &&
            stat.etag === entry.remoteEtag;
          if (etagUnchanged) {
            remoteHash = entry.remoteHash ?? baselineHash;
          } else {
            try {
              const content = await client.get(rel);
              remoteContentCache.set(rel, content);
              remoteHash = hashContent(content);
            } catch (error) {
              if (
                error instanceof WebDavTransientError &&
                error.status === 404
              ) {
                remoteHash = null;
              } else {
                throw error;
              }
            }
          }
        }
        const action = decideSyncAction({
          localHash,
          remoteHash,
          baselineHash,
          onConflict: config.onConflict,
          deletions: config.deletions,
        });
        switch (action.type) {
          case "upload":
            uploads.push(rel);
            break;
          case "download":
            downloads.push(rel);
            break;
          case "agree":
            agrees.push({
              rel,
              etag: stat?.etag ?? null,
              hash: localHash ?? remoteHash ?? "",
            });
            break;
          case "forget":
            forgets.push(rel);
            break;
          case "conflict":
            nextConflicts.set(
              `${action.kind}:${rel}`,
              this.conflictEntry(
                rel,
                action.kind ?? "content",
                localStat,
                stat,
                action.reason,
              ),
            );
            break;
          default:
            break;
        }
        if (action.type !== "download") {
          // Only a pending download still needs the fetched bytes.
          remoteContentCache.delete(rel);
        }
      }

      // Baseline checkpoint for files that already agree; the rate-limit
      // abort path reuses it so a resume run skips unchanged files.
      applyAgreesAndForgets = async (): Promise<void> => {
        const checkpointAt = Date.now();
        for (const agree of agrees) {
          const previous = manifest.get(agree.rel);
          manifest.set(agree.rel, {
            localHash: agree.hash,
            remoteEtag: agree.etag,
            remoteHash: agree.hash,
            baselineHash: agree.hash,
            lastSyncAt: previous?.lastSyncAt ?? checkpointAt,
          });
        }
        for (const rel of forgets) {
          manifest.remove(rel);
        }
        await manifest.save();
      };

      // Execute transfers; per-file failures degrade to a partial result.
      for (const rel of uploads) {
        try {
          const remoteStat = remote.files.get(rel);
          const uploaded = await this.uploadFile(
            client,
            rel,
            this.toAbsoluteLocalPath(rel),
            manifest,
            remote.dirs,
            remote.baseMissing,
            { exists: remoteStat !== undefined, etag: remoteStat?.etag ?? null },
            (entry) => nextConflicts.set(entry.id, entry),
          );
          remote.baseMissing = false;
          if (uploaded) {
            // Checkpoint so an aborted pass resumes without redoing files.
            await manifest.save();
            completedUploads++;
          }
        } catch (error) {
          if (
            error instanceof WebDavFatalError ||
            error instanceof WebDavRateLimitedError
          ) {
            throw error;
          }
          fileErrors++;
          this.log(
            "warn",
            `upload failed for ${rel}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      for (const rel of downloads) {
        try {
          const downloaded = await this.downloadFile(
            client,
            rel,
            this.toAbsoluteLocalPath(rel),
            manifest,
            remote.files.get(rel) ?? null,
            remoteContentCache.get(rel) ?? null,
            capturedStats.get(rel) ?? null,
            (entry) => nextConflicts.set(entry.id, entry),
          );
          if (downloaded) {
            await manifest.save();
            completedDownloads++;
          }
        } catch (error) {
          if (
            error instanceof WebDavFatalError ||
            error instanceof WebDavRateLimitedError
          ) {
            throw error;
          }
          fileErrors++;
          this.log(
            "warn",
            `download failed for ${rel}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        } finally {
          remoteContentCache.delete(rel);
        }
      }
      await applyAgreesAndForgets();
      const now = Date.now();

      const previousConflictIds = new Set(this.conflicts.keys());
      this.conflicts = nextConflicts;
      const newConflictIds = [...nextConflicts.keys()].filter(
        (id) => !previousConflictIds.has(id),
      );

      this.state = "idle";
      this.lastSyncAt = now;
      this.pendingCount = 0;
      this.failureStreak = 0;
      this.nextBackoffMs = FIRST_BACKOFF_MS;
      // A completed pass makes any pending rate-limit resume obsolete.
      this.clearRateLimitResume();
      if (this.autoSyncPaused) {
        this.autoSyncPaused = false;
        this.armTriggers();
      }
      const direction =
        completedUploads > 0 && completedDownloads > 0
          ? "both"
          : completedUploads > 0
            ? "up"
            : completedDownloads > 0
              ? "down"
              : "none";
      const result: "success" | "partial" | "failed" =
        fileErrors > 0 || nextConflicts.size > 0 ? "partial" : "success";
      this.appendHistory({
        time: now,
        direction,
        files: completedUploads + completedDownloads,
        uploads: completedUploads,
        downloads: completedDownloads,
        deletes: this.takeExcludeDeletes(trigger),
        result,
        trigger,
      });
      this.log(
        "info",
        `sync finished (${trigger}): ${completedUploads} up, ${completedDownloads} down, ${nextConflicts.size} conflict(s), ${fileErrors} error(s)`,
      );

      const delta: WebDavSyncStatusDelta = {
        state: "idle",
        pendingCount: 0,
        conflictCount: nextConflicts.size,
        lastSyncAt: now,
        lastSyncLabel: relativeTimeLabel(now),
        autoSyncPaused: false,
      };
      if (completedDownloads > 0) {
        delta.notice = l10n.t(
          "Downloaded {count} updated file(s) from the sync server.",
          { count: completedDownloads },
        );
      }
      this.pushDelta(delta);
      if (newConflictIds.length > 0) {
        // Notify without stealing focus: the panel stays closed and the
        // user opens it from the toolbar when ready.
        const notice = l10n.t(
          "Sync conflict detected in {count} file(s). Open the sync panel to resolve.",
          { count: newConflictIds.length },
        );
        this.pushDelta({ notice });
        if (!this.isWebviewVisible()) {
          void vscode.window.showInformationMessage(notice);
        }
      }
    } catch (error) {
      if (error instanceof WebDavRateLimitedError) {
        // A server rate limit is a cooldown, not a failure: checkpoint
        // what already finished, record a partial pass and resume once
        // the window reopens.
        try {
          await applyAgreesAndForgets?.();
        } catch {
          // The checkpoint is best-effort; per-file saves already landed.
        }
        this.handleRateLimited(error, trigger, completedUploads, completedDownloads);
        return;
      }
      if (error instanceof WebDavFatalError) {
        if (error.status === 401) {
          this.handleAuthFailure(trigger, error);
          return;
        }
        this.appendHistory({
          time: Date.now(),
          direction: "none",
          files: 0,
          uploads: 0,
          downloads: 0,
          deletes: this.takeExcludeDeletes(trigger),
          result: "failed",
          // A 403 is a permission problem (read-only share, path ACL,
          // proxy), not a wrong password. Say so instead of echoing the
          // client's "rejected the credentials" wording.
          message:
            error.status === 403
              ? l10n.t(
                  "The server refused the operation. Check the account permissions.",
                )
              : error.message,
          trigger,
        });
        this.log("warn", `sync aborted (fatal): ${error.message}`);
        this.pauseAutoSync(error.message);
        return;
      }
      const transient =
        error instanceof WebDavTransientError
          ? error
          : new WebDavTransientError(
              error instanceof Error ? error.message : String(error),
            );
      this.handleTransientFailure(trigger, transient);
    }
  }

  /**
   * A 401 means the credentials themselves are wrong, not that the server
   * is unreachable. Keep the breaker closed and point the user at the
   * Server section instead of reporting "auto sync paused". A 403 is a
   * permission problem and keeps the fatal/pause path.
   */
  private handleAuthFailure(
    trigger: SyncTrigger,
    error: WebDavFatalError,
  ): void {
    this.enterNeedsAuth();
    this.appendHistory({
      time: Date.now(),
      direction: "none",
      files: 0,
      uploads: 0,
      downloads: 0,
      deletes: this.takeExcludeDeletes(trigger),
      result: "failed",
      message: l10n.t("The server rejected the sign-in details."),
      trigger,
    });
    this.log("warn", `sync aborted (auth): ${error.message}`);
    this.pushDelta({ state: "needsAuth" });
  }

  private handleTransientFailure(
    trigger: SyncTrigger,
    error: WebDavTransientError,
  ): void {
    this.failureStreak++;
    this.state = "error";
    this.appendHistory({
      time: Date.now(),
      direction: "none",
      files: 0,
      uploads: 0,
      downloads: 0,
      deletes: this.takeExcludeDeletes(trigger),
      result: "failed",
      message: error.message,
      trigger,
    });
    this.log("warn", `sync failed (transient, streak ${this.failureStreak}): ${error.message}`);
    if (this.failureStreak >= MAX_CONSECUTIVE_FAILURES) {
      this.pauseAutoSync("repeated transient sync failures");
      return;
    }
    if (trigger !== "manual") {
      const delay = this.nextBackoffMs;
      this.nextBackoffMs = Math.min(this.nextBackoffMs * 2, MAX_BACKOFF_MS);
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
      }
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        void this.triggerAuto("retry");
      }, delay);
    }
    this.pushDelta({ state: "error" });
  }

  /**
   * Server rate limit: no failure streak, no breaker pause, no backoff
   * growth. The pass is recorded as partial and one automatic resume is
   * scheduled after the cooldown, replacing any pending resume cleanly.
   */
  private handleRateLimited(
    error: WebDavRateLimitedError,
    trigger: SyncTrigger,
    completedUploads: number,
    completedDownloads: number,
  ): void {
    const config = readSyncConfig();
    const windowMs =
      config.rateLimitMaxRequests > 0
        ? config.rateLimitWindowMinutes * 60_000
        : 0;
    let delayMs = error.retryAfterMs ?? windowMs;
    if (!Number.isFinite(delayMs) || delayMs <= 0) {
      delayMs = MIN_RATE_LIMIT_RESUME_MS;
    }
    delayMs = Math.min(
      Math.max(delayMs, MIN_RATE_LIMIT_RESUME_MS),
      MAX_RATE_LIMIT_RESUME_MS,
    );
    const cooldownSource =
      error.retryAfterMs !== undefined
        ? "Retry-After header"
        : "request window";
    const seconds = Math.round(delayMs / 1000);
    const direction =
      completedUploads > 0 && completedDownloads > 0
        ? "both"
        : completedUploads > 0
          ? "up"
          : completedDownloads > 0
            ? "down"
            : "none";
    this.state = "error";
    this.appendHistory({
      time: Date.now(),
      direction,
      files: completedUploads + completedDownloads,
      uploads: completedUploads,
      downloads: completedDownloads,
      deletes: this.takeExcludeDeletes(trigger),
      result: "partial",
      message: `rate limited by server; resuming in ${seconds}s`,
      trigger,
    });
    this.log(
      "warn",
      `rate limited by server (${cooldownSource}); resuming in ${seconds}s`,
    );
    this.pushDelta({ state: "error" });
    this.clearRateLimitResume();
    this.rateLimitResumeTimer = setTimeout(() => {
      this.rateLimitResumeTimer = undefined;
      void this.triggerAuto("retry");
    }, delayMs);
  }

  private async walkRemote(client: WebDavClientLike): Promise<RemoteTree> {
    const files = new Map<string, WebDavStat>();
    const dirs = new Set<string>();
    let baseMissing = false;
    const queue: string[] = [""];
    while (queue.length > 0) {
      const dir = queue.shift() as string;
      let entries: WebDavStat[];
      try {
        entries = await client.propfind(dir, 1);
      } catch (error) {
        if (
          dir === "" &&
          error instanceof WebDavTransientError &&
          error.status === 404
        ) {
          baseMissing = true;
          return { files, dirs, baseMissing };
        }
        throw error;
      }
      for (const entry of entries) {
        // Depth:1 responses echo the queried collection itself; skip the
        // self entry for every directory, not just the base, or nested
        // directories re-enqueue themselves forever.
        if (entry.path === "" || entry.path === dir) {
          continue;
        }
        if (entry.isDir) {
          dirs.add(entry.path);
          queue.push(entry.path);
        } else {
          files.set(entry.path, entry);
        }
      }
    }
    return { files, dirs, baseMissing };
  }

  /**
   * Delete the files a newly added exclusion just removed from this
   * machine's sync scope from the server, then forget their manifest
   * entries. Runs inside the exclusive queue so it never races a sync
   * pass or a conflict resolution; every failure is logged and leaves
   * the already-persisted setting untouched.
   */
  private async purgeRemoteForExclude(newExclude: string): Promise<void> {
    const config = readSyncConfig();
    if (!config.enabled || !config.url || this.autoSyncPaused) {
      return;
    }
    const newExcludes = normalizeExcludes(config.excludedPaths);
    const oldExcludes = newExcludes.filter((entry) => entry !== newExclude);
    const items = deriveSyncItems(
      config.customItems,
      config.disabledItems,
    ).filter((item) => item.enabled);
    await this.enqueueExclusive(async () => {
      let deletedCount = 0;
      let failedCount = 0;
      try {
        const client = await this.createClientFromSettings(config);
        const remote = await this.walkRemote(client);
        const manifest = new SyncManifest(this.globalStoragePath());
        await manifest.load();
        const targets: string[] = [];
        for (const rel of remote.files.keys()) {
          // Only files this machine previously synced may be purged;
          // anything else may belong to another device.
          if (!manifest.get(rel)) {
            continue;
          }
          if (!isPathUnderItems(rel, items)) {
            continue;
          }
          if (isPathExcluded(rel, oldExcludes)) {
            continue;
          }
          if (!isPathExcluded(rel, newExcludes)) {
            continue;
          }
          targets.push(rel);
        }
        let forgotAny = false;
        for (const rel of targets) {
          try {
            await client.del(rel);
            manifest.remove(rel);
            forgotAny = true;
            deletedCount++;
            this.log("info", `excluded from sync; deleted remotely: ${rel}`);
          } catch (error) {
            failedCount++;
            this.log(
              "warn",
              `remote delete failed for excluded ${rel}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
        if (forgotAny) {
          await manifest.save();
        }
        if (deletedCount > 0) {
          this.pendingExcludeDeletes += deletedCount;
        }
        if (targets.length > 0) {
          this.log(
            "info",
            `exclude purge finished: ${deletedCount} deleted, ${failedCount} failed`,
          );
        }
      } catch (error) {
        this.log(
          "warn",
          `exclude purge failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    });
  }

  private async uploadFile(
    client: WebDavClientLike,
    rel: string,
    abs: string,
    manifest: SyncManifest,
    knownDirs: Set<string>,
    ensureBase: boolean,
    remote: { exists: boolean; etag: string | null },
    recordConflict?: (entry: WebDavConflictEntry) => void,
  ): Promise<boolean> {
    const content = await fs.promises.readFile(abs);
    const localHash = hashContent(content);
    await this.ensureRemoteDirs(client, rel, knownDirs, ensureBase);
    // Compare-and-swap write against the state this decision was based on:
    // an unchanged remote keeps its ETag guard, a missing remote must be
    // created, not blindly clobbered. Manifest baselines can be stale.
    let conditions: WebDavPutConditions | undefined;
    if (remote.exists) {
      if (remote.etag) {
        conditions = { ifMatch: remote.etag };
      }
    } else {
      conditions = { ifNoneMatchStar: true };
    }
    try {
      await client.put(rel, content, conditions);
    } catch (error) {
      if (error instanceof PreconditionFailedError) {
        let localStat: fs.Stats | undefined;
        try {
          localStat = await fs.promises.stat(abs);
        } catch {
          localStat = undefined;
        }
        // Observe the winning remote version so the conflict entry
        // carries a resolvable snapshot instead of an empty one.
        const currentRemote = await this.statRemoteFile(client, rel).catch(
          () => undefined,
        );
        recordConflict?.(
          this.conflictEntry(
            rel,
            "content",
            localStat,
            currentRemote ?? undefined,
            "preconditionFailed",
          ),
        );
        this.log(
          "warn",
          `upload skipped; the server copy changed since the sync started: ${rel}`,
        );
        return false;
      }
      if (
        conditions &&
        error instanceof WebDavTransientError &&
        (error.status === 400 || error.status === 501)
      ) {
        // Weak servers reject conditional headers outright: fall back to
        // one unconditional PUT so sync keeps working.
        this.log(
          "warn",
          `conditional upload not supported by the server; retrying without conditions: ${rel}`,
        );
        await client.put(rel, content);
      } else {
        throw error;
      }
    }
    let etag: string | null = null;
    try {
      const stats = await client.propfind(rel, 0);
      etag = stats.find((stat) => stat.path === rel)?.etag ?? null;
    } catch {
      etag = null;
    }
    const now = Date.now();
    manifest.set(rel, {
      localHash,
      remoteEtag: etag,
      remoteHash: localHash,
      baselineHash: localHash,
      lastSyncAt: now,
    });
    this.log("info", `uploaded ${rel}`);
    return true;
  }

  /** Current stat of one remote file; null when it no longer exists. */
  private async statRemoteFile(
    client: WebDavClientLike,
    rel: string,
  ): Promise<WebDavStat | null> {
    try {
      const stats = await client.propfind(rel, 0);
      return stats.find((stat) => stat.path === rel) ?? null;
    } catch (error) {
      if (error instanceof WebDavTransientError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  private async downloadFile(
    client: WebDavClientLike,
    rel: string,
    abs: string,
    manifest: SyncManifest,
    stat: WebDavStat | null,
    cachedContent: Buffer | null,
    captured: { size: number; mtimeMs: number } | null = null,
    recordConflict?: (entry: WebDavConflictEntry) => void,
  ): Promise<boolean> {
    // Observe the ETag before reading the bytes. Reading first and
    // stat-ing afterwards could pair stale content with a fresh ETag and
    // make the next pass believe an outdated local copy is current.
    const remoteStat = stat ?? (await this.statRemoteFile(client, rel));
    const content = cachedContent ?? (await client.get(rel));
    if (captured) {
      // The scan snapshot is stale the moment anything touched the local
      // file since; overwriting would silently discard those edits.
      let current: fs.Stats | undefined;
      try {
        current = await fs.promises.stat(abs);
      } catch {
        current = undefined;
      }
      if (
        !current ||
        !current.isFile() ||
        current.size !== captured.size ||
        current.mtimeMs !== captured.mtimeMs
      ) {
        recordConflict?.(
          this.conflictEntry(
            rel,
            "content",
            current,
            remoteStat,
            "localModifiedDuringSync",
          ),
        );
        this.log(
          "warn",
          `download skipped; the local file changed during the sync: ${rel}`,
        );
        return false;
      }
    }
    const etag = remoteStat?.etag ?? null;
    if (fs.existsSync(abs)) {
      const backedUp = await this.backupLocalFile(abs, rel);
      if (!backedUp) {
        // Refuse to destroy the local copy without a safety backup.
        recordConflict?.(
          this.conflictEntry(
            rel,
            "content",
            undefined,
            remoteStat,
            "backupFailed",
          ),
        );
        this.log("warn", `download skipped; local backup failed: ${rel}`);
        return false;
      }
    }
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    // Raw remote bytes hit the disk untouched; hash normalization only
    // affects comparisons.
    await fs.promises.writeFile(abs, content);
    const hash = hashContent(content);
    const now = Date.now();
    manifest.set(rel, {
      localHash: hash,
      remoteEtag: etag,
      remoteHash: hash,
      baselineHash: hash,
      lastSyncAt: now,
    });
    this.log("info", `downloaded ${rel}`);
    return true;
  }

  private async ensureRemoteDirs(
    client: WebDavClientLike,
    rel: string,
    knownDirs: Set<string>,
    ensureBase: boolean,
  ): Promise<void> {
    const targets: string[] = [];
    if (ensureBase && !knownDirs.has("")) {
      if (typeof client.ensureBasePath === "function") {
        // Multi-segment base paths need every ancestor created in order.
        await client.ensureBasePath();
        knownDirs.add("");
      } else {
        targets.push("");
      }
    }
    const segments = rel.split("/").slice(0, -1);
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      targets.push(current);
    }
    for (const dir of targets) {
      if (knownDirs.has(dir)) {
        continue;
      }
      try {
        await client.mkcol(dir);
        knownDirs.add(dir);
      } catch (error) {
        if (error instanceof WebDavFatalError) {
          throw error;
        }
        // 405 (exists) or races: the PUT will surface real problems.
        knownDirs.add(dir);
      }
    }
  }

  private async backupLocalFile(abs: string, rel: string): Promise<boolean> {
    try {
      const stat = await fs.promises.stat(abs);
      if (!stat.isFile()) {
        return false;
      }
      const relDir = path.posix.dirname(rel);
      const destDir =
        relDir === "."
          ? path.join(this.backupsRoot())
          : path.join(this.backupsRoot(), ...relDir.split("/"));
      await fs.promises.mkdir(destDir, { recursive: true });
      const name = `${Date.now()}-${path.posix.basename(rel)}`;
      await fs.promises.copyFile(abs, path.join(destDir, name));
      // The backup copy exists; pruning old generations is best-effort.
      try {
        const entries = await fs.promises.readdir(destDir);
        const stamped = entries
          .map((entry) => ({
            entry,
            at: Number.parseInt(entry.split("-")[0] ?? "0", 10) || 0,
          }))
          .sort((a, b) => b.at - a.at);
        for (const { entry } of stamped.slice(BACKUP_KEEP)) {
          await fs.promises.rm(path.join(destDir, entry), { force: true });
        }
      } catch (error) {
        this.logger.warn(
          `[WebDavSync] backup pruning failed for ${rel}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return true;
    } catch (error) {
      this.logger.warn(
        `[WebDavSync] backup failed for ${rel}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  /**
   * Whether the remote state still matches the snapshot a conflict
   * presented. Unknown snapshots never match, so resolution re-conflicts
   * with current data instead of overwriting an unreviewed version.
   */
  private remoteStateMatchesConflict(
    conflict: WebDavConflictEntry,
    stat: WebDavStat,
  ): boolean {
    if (conflict.remoteEtag !== undefined) {
      return stat.etag === conflict.remoteEtag;
    }
    if (
      conflict.remoteMtime === undefined &&
      conflict.remoteSize === undefined
    ) {
      return false;
    }
    return (
      (conflict.remoteMtime === undefined ||
        stat.lastModified === conflict.remoteMtime) &&
      (conflict.remoteSize === undefined || stat.size === conflict.remoteSize)
    );
  }

  /** Uniform conflict entry shape for all conflict sources. */
  private conflictEntry(
    rel: string,
    kind: WebDavConflictKind,
    localStat: fs.Stats | undefined,
    remoteStat: WebDavStat | null | undefined,
    reason?: string,
  ): WebDavConflictEntry {
    const entry: WebDavConflictEntry = {
      id: `${kind}:${rel}`,
      path: rel,
      kind,
      localMtime: localStat?.mtimeMs,
      localSize: localStat?.size,
      remoteMtime: remoteStat?.lastModified ?? undefined,
      remoteSize: remoteStat?.size,
      remoteEtag: remoteStat ? remoteStat.etag : undefined,
    };
    if (reason) {
      entry.reason = reason;
    }
    return entry;
  }

  // ── Helpers ──

  private async createClientFromSettings(
    config: SyncEngineConfig,
    storedPassword?: string,
  ): Promise<WebDavClientLike> {
    const password =
      storedPassword ??
      (await this.resolvePassword(config.url, config.username, undefined));
    // Reuse the client while its inputs are unchanged so the pacing
    // window carries across passes instead of resetting every operation.
    const passwordFingerprint = crypto
      .createHash("sha256")
      .update(password ?? "", "utf8")
      .digest("hex");
    const key = JSON.stringify([
      config.url,
      config.username,
      passwordFingerprint,
      config.basePath,
      config.allowInsecureHttp,
      config.acceptSelfSigned,
      config.rateLimitMaxRequests,
      config.rateLimitWindowMinutes,
    ]);
    if (this.cachedClient?.key === key) {
      return this.cachedClient.client;
    }
    const client = this.clientFactory({
      url: config.url,
      username: config.username,
      password,
      basePath: config.basePath,
      allowInsecureHttp: config.allowInsecureHttp,
      acceptSelfSigned: config.acceptSelfSigned,
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxRequests: config.rateLimitMaxRequests,
      windowMs:
        config.rateLimitMaxRequests > 0
          ? config.rateLimitWindowMinutes * 60_000
          : 0,
      onRateLimitWait: (waitedMs) => {
        this.log(
          "info",
          `rate limit: waiting ${Math.max(1, Math.round(waitedMs / 1000))}s for request window`,
        );
      },
    });
    this.cachedClient = { key, client };
    return client;
  }

  private async resolvePassword(
    url: string,
    username: string,
    explicit: string | undefined,
  ): Promise<string | undefined> {
    if (explicit !== undefined) {
      return explicit;
    }
    if (!url) {
      return undefined;
    }
    try {
      return (await this.context.secrets.get(
        webdavSecretKey(url, username),
      )) ?? undefined;
    } catch {
      return undefined;
    }
  }

  private globalStoragePath(): string {
    return this.context.globalStorageUri.fsPath;
  }

  private backupsRoot(): string {
    return path.join(syncStorageDir(this.globalStoragePath()), "backups");
  }

  private toAbsoluteLocalPath(rel: string): string {
    const configDir = this.configDirProvider();
    return path.join(configDir, ...rel.split("/"));
  }

  private toRelativeLocalPath(absPath: string): string | null {
    const rel = path.relative(this.configDirProvider(), absPath);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      return null;
    }
    return rel.split(path.sep).join("/");
  }

  private log(level: "debug" | "info" | "warn", message: string): void {
    const line = `[${new Date().toISOString()}] [${level}] ${message}`;
    this.logLines.push(line);
    if (this.logLines.length > LOG_LIMIT) {
      this.logLines.splice(0, this.logLines.length - LOG_LIMIT);
    }
    if (level === "warn") {
      this.logger.warn(`[WebDavSync] ${message}`);
    } else if (level === "debug") {
      this.logger.debug(`[WebDavSync] ${message}`);
    } else {
      this.logger.info(`[WebDavSync] ${message}`);
    }
  }

  private loadHistory(): WebDavHistoryEntry[] {
    const raw = this.context.globalState.get<unknown>(HISTORY_KEY);
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.filter(
      (entry): entry is WebDavHistoryEntry =>
        !!entry &&
        typeof entry === "object" &&
        typeof (entry as WebDavHistoryEntry).time === "number" &&
        typeof (entry as WebDavHistoryEntry).direction === "string" &&
        typeof (entry as WebDavHistoryEntry).result === "string",
    );
  }

  /** Claim purge deletions for the journal entry of the reconcile pass. */
  private takeExcludeDeletes(trigger: SyncTrigger): number {
    if (trigger !== "excludeChange") {
      return 0;
    }
    const deletes = this.pendingExcludeDeletes;
    this.pendingExcludeDeletes = 0;
    return deletes;
  }

  private appendHistory(entry: WebDavHistoryEntry): void {
    // Every VS Code window shares one globalState store; re-read the
    // persisted truth before appending so this window's stale in-memory
    // copy can never clobber entries another window just wrote.
    const persisted = this.loadHistory();
    const last = persisted[persisted.length - 1];
    if (
      last &&
      last.time === entry.time &&
      last.direction === entry.direction &&
      last.files === entry.files &&
      last.uploads === entry.uploads &&
      last.downloads === entry.downloads &&
      last.deletes === entry.deletes &&
      last.result === entry.result &&
      last.trigger === entry.trigger &&
      last.message === entry.message
    ) {
      // The same event is already the latest persisted entry; skip.
      this.history = persisted;
      return;
    }
    const next = [...persisted, entry];
    if (next.length > HISTORY_LIMIT) {
      next.splice(0, next.length - HISTORY_LIMIT);
    }
    this.history = next;
    this.historyWrite = this.context.globalState
      .update(HISTORY_KEY, next)
      .then(undefined, () => undefined);
  }
}

/** Host-localized relative-time label for the last sync. */
export function relativeTimeLabel(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) {
    return l10n.t("just now");
  }
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) {
    return l10n.t("{count} minutes ago", { count: minutes });
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return l10n.t("{count} hours ago", { count: hours });
  }
  return new Date(timestamp).toLocaleString();
}

/** User-facing connection-test failure text without technical detail. */
function describeConnectionError(error: unknown): string {
  if (error instanceof WebDavFatalError) {
    if (error.status === 401 || error.status === 403) {
      return l10n.t("The server rejected the sign-in details.");
    }
    return l10n.t("The server address or security settings are not valid.");
  }
  return l10n.t("Could not reach the server. Check the address and network.");
}

/** User-facing rejection reason for a custom item / exclude entry. */
function describeItemRejection(reason: EntryRejection): string {
  if (reason === "blacklisted") {
    return l10n.t("Files that look like credentials cannot be synced.");
  }
  if (reason === "emptyPattern" || reason === "badRegex") {
    return l10n.t("This regular expression is not valid.");
  }
  return l10n.t("Enter a file or folder path inside the OpenCode config folder.");
}
