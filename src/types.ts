
export interface DroppedBlobFile {
  name: string;
  data: string;
}

export type TerminalBackendType = "native";

/**
 * User's answer to the in-webview prompt shown when restarting an OpenCode v2
 * terminal that attaches to the shared background service.
 * - "restartService": restart the terminal and the shared service.
 * - "terminalOnly": restart the terminal, keep the shared service running.
 * - "cancel": abort the restart entirely, keep the current session running.
 */
export type ServiceRestartPromptAction =
  | "restartService"
  | "terminalOnly"
  | "cancel";

/** User's answer to the in-webview missing-CLI install confirmation dialog. */
export type CliInstallPromptAction = "install" | "notNow";

/** Settings layer targeted by the in-webview extension settings dialog. */
export type ExtensionSettingsScope = "user" | "workspace";

/**
 * Snapshot of the extension's own settings for the in-webview dialog.
 * Keys are setting suffixes without the `opencode-cli-sidebar.` prefix.
 */
export interface ExtensionSettingsSnapshot {
  /** Effective value after every scope is merged. */
  values: Record<string, unknown>;
  /** Values authored at user scope; a missing key means the layer is unset. */
  userValues: Record<string, unknown>;
  /** Values authored at workspace scope; a missing key means the layer is unset. */
  workspaceValues: Record<string, unknown>;
  /** Resolved default per known key, driving placeholders and reset state. */
  defaults: Record<string, unknown>;
  /** True when a workspace folder is open, which enables the workspace scope. */
  hasWorkspace: boolean;
}

export type WebviewMessage =
  | { type: "terminalInput"; data: string }
  | { type: "terminalResize"; cols: number; rows: number }
  | { type: "listTerminals" }
  | {
      type: "openFile";
      path: string;
      line?: number;
      endLine?: number;
      column?: number;
    }
  | { type: "openUrl"; url: string }
  | { type: "ready"; cols: number; rows: number }
  | {
      type: "filesDropped";
      files: string[];
      shiftKey: boolean;
      dropCell?: { col: number; row: number };
      blobFiles?: DroppedBlobFile[];
    }
  | { type: "setClipboard"; text: string }
  | { type: "triggerPaste" }
  | { type: "imagePasted"; data: string }
  | { type: "requestRestart" }
  /** Answer to the in-webview service-restart prompt shown by the host. */
  | { type: "serviceRestartPromptAnswer"; action: ServiceRestartPromptAction }
  /** Answer to the in-webview confirmation for a one-way sync operation. */
  | { type: "webdavConfirmAnswer"; requestId: string; confirmed: boolean }
  | { type: "toggleEditorAttachment" }
  | { type: "openSettings" }
  | { type: "openKeyboardShortcuts" }
  | {
      type: "openOpenCodeGlobalFile";
      target: "agentsMd" | "opencodeJson" | "cliJson" | "ohMyOpenCodeSlim";
    }
  | { type: "updateFontSize"; fontSize: number }
  | { type: "saveKeybind"; id: string; chords: string[] }
  | { type: "resetKeybind"; id: string }
  | { type: "requestKeymapData" }
  | { type: "requestOpenCodeCliSettingsData" }
  | { type: "saveOpenCodeCliSetting"; path: string; value: unknown }
  | { type: "resetOpenCodeCliSetting"; path: string }
  | { type: "addOpenCodeCliPlugin"; packageName: string }
  | { type: "removeOpenCodeCliPlugin"; index: number }
  | { type: "checkOpenCodeCliPluginUpdates" }
  | { type: "updateOpenCodeCliPlugin"; index: number; version: string }
  /** Replace a plugin entry's whole `options` object. */
  | {
      type: "setOpenCodeCliPluginOptions";
      index: number;
      options: Record<string, unknown>;
    }
  /** Delete a stale plugin cache directory so OpenCode reinstalls it on restart. */
  | { type: "clearOpenCodeCliPluginCache"; name: string }
  /** Webview boot: ask the host for the current OpenCode self-update status. */
  | { type: "requestOpenCodeUpdateStatus" }
  /** Method dialog confirmation; while blocked on nvm it means "fix and continue". */
  | { type: "startOpenCodeUpdate"; method: string }
  /** Settings dropdown item: manual update check. */
  | { type: "checkOpenCodeUpdates" }
  /** Abandon button on the blocked / auto-fix cards. */
  | { type: "abandonOpenCodeUpdate" }
  /** Success card primary button; host restarts the OpenCode session. */
  | { type: "restartAfterUpdate" }
  /** Success card secondary button; host clears the success state. */
  | { type: "dismissOpenCodeUpdate" }
  /** Install confirmation "Re-detect" button; host re-probes the CLI. */
  | { type: "retryCliProbe" }
  /** Missing-CLI install confirmation dialog answer. */
  | { type: "answerCliInstallPrompt"; action: CliInstallPromptAction }
  /**
   * Release notes for the update dialog. `version` names the release to
   * show; omitted falls back to the flow's target or installed version.
   * `mode` marks an upcoming release, whose dialog offers the update
   * action, versus an installed one, which only offers a re-check.
   */
  | {
      type: "requestOpenCodeChangelog";
      version?: string;
      mode?: "upcoming" | "installed";
    }
  | { type: "sendChangelogToOpenCode"; text: string }
  /** Asks the host to translate extracted changelog text blocks. */
  | {
      type: "translateOpenCodeChangelog";
      requestId: string;
      version: string;
      htmlHash: string;
      targetLanguage: string;
      blocks: ChangelogTextBlock[];
    }
  /** Cancels an in-flight translation when the dialog closes or re-renders. */
  | { type: "cancelOpenCodeChangelogTranslation"; requestId: string }
  /* ===================== WebDAV config sync ===================== */
  /** Webview boot / sync panel open: request the full sync snapshot. */
  | { type: "requestWebdavSyncData" }
  /** Save button in the server card; persists connection fields only. */
  | { type: "saveWebdavServerConfig"; config: WebDavServerConfig; password?: string }
  /** Immediate apply for auto sync, poll interval and status icon options. */
  | { type: "applyWebdavSyncOptions"; options: WebDavSyncOptions }
  /** Test the form draft against the server; the host persists nothing. */
  | { type: "testWebdavConnection"; draft: WebDavConnectionDraft }
  | { type: "setWebdavItemEnabled"; id: string; enabled: boolean }
  | { type: "addWebdavItem"; path: string }
  | { type: "removeWebdavItem"; id: string }
  /** Exclusions filter files out of directory items; paths relative to the config directory. */
  | { type: "addWebdavExclude"; path: string }
  | { type: "removeWebdavExclude"; path: string }
  /** Manual "Sync now": popover button, panel footer and command all funnel here. */
  | { type: "syncWebdavNow" }
  /** Replace the local synced files with the server tree (manual, always confirmed). */
  | { type: "forcePullWebdav" }
  /** Replace the server tree with the local synced files (manual, always confirmed). */
  | { type: "forcePushWebdav" }
  /** Lazy-load the sync log tail when the log section becomes visible. */
  | { type: "requestWebdavLog" }
  /** Wipe the persisted sync history from the history pane toolbar. */
  | { type: "clearWebdavHistory" }
  | { type: "resolveWebdavConflict"; id: string; resolution: "local" | "remote" }
  /** Resolve a multi-selected set of conflicts under one exclusive pass. */
  | { type: "resolveWebdavConflicts"; ids: string[]; resolution: "local" | "remote" }
  /** Open a VS Code diff editor for one side of a conflict. */
  | { type: "openWebdavDiff"; id: string }
  /** Open the OpenCode config directory in the OS file manager. */
  | { type: "openOpenCodeConfigDir" }
  /** Abort the pre-start config sync from the sidebar overlay or status bar. */
  | { type: "skipPreStartSync" }
  /* ===================== Extension settings dialog ===================== */
  /** Dialog open or scope switch: request every setting value and layer. */
  | { type: "requestExtensionSettingsData" }
  /** Immediate apply for one control; the host validates and persists it. */
  | {
      type: "updateExtensionSetting";
      key: string;
      value: unknown;
      scope: ExtensionSettingsScope;
    }
  /** Drop one layer's value so the setting falls back to the next layer. */
  | { type: "resetExtensionSetting"; key: string; scope: ExtensionSettingsScope };

export const ALLOWED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];
export const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

export type FocusIndicatorMode = "off" | "bottomBorder" | "fullBorder";

/** OpenCode TUI keybind catalog group. */
export type KeymapGroup =
  | "general"
  | "session"
  | "nav"
  | "model"
  | "input"
  | "dialog"
  | "diff"
  | "whichkey";

/** Built-in keybind entry (defaults come from OpenCode v2 Definitions/CommandMap). */
export interface KeymapItem {
  id: string;
  group: KeymapGroup;
  title: string;
  desc: string;
  /** Default binding: comma-separated chords, or "none". */
  def: string;
}

export type OpenCodeCliSettingType =
  | "boolean"
  | "enum"
  | "string"
  | "number"
  | "range"
  | "readonly";

export type OpenCodeCliSettingsGroupId =
  | "appearance"
  | "input"
  | "session"
  | "tabs"
  | "diff"
  | "terminal"
  | "attention"
  | "mini"
  | "debug"
  | "plugins"
  | "keybinds";

export interface OpenCodeThemeSwatch {
  bg?: string;
  panel?: string;
  primary?: string;
  accent?: string;
  text?: string;
}

export interface OpenCodeCliSettingOption {
  value: string;
  label: string;
  /** Theme preview colors when this option is a theme. */
  swatch?: OpenCodeThemeSwatch;
}

export interface OpenCodeCliSettingItem {
  id: string;
  group: OpenCodeCliSettingsGroupId;
  title: string;
  desc: string;
  type: OpenCodeCliSettingType;
  def: unknown;
  options?: readonly OpenCodeCliSettingOption[];
  min?: number;
  max?: number;
  step?: number;
}

export interface OpenCodeCliSettingsGroupMeta {
  id: OpenCodeCliSettingsGroupId;
  title: string;
}

export type HostMessage =
  | { type: "requestPaste" }
  | { type: "clipboardContent"; text: string }
  | { type: "terminalList"; terminals: Array<{ name: string; cwd: string }> }
  | { type: "terminalOutput"; data: string }
  | { type: "terminalExited" }
  | { type: "clearTerminal" }
  | { type: "focusTerminal" }
  | { type: "webviewVisible" }
  /**
   * Startup gate progress. `starting` means the shared OpenCode background
   * service is not up yet, `preStartSync` means the pre-launch config sync is
   * running, `idle` hides the in-sidebar indicator.
   */
  | {
      type: "startupPhase";
      phase: StartupPhase;
      /** Transfer progress; only present while `phase` is `preStartSync`. */
      progress?: PreStartSyncProgress;
    }
  /**
   * Settled pre-launch sync verdict. A separate message from `startupPhase`
   * so it can be shown without re-showing the full-screen overlay, which
   * would cover the terminal OpenCode is starting in.
   */
  | { type: "preStartSyncResult"; result: PreStartSyncResult }
  | {
      type: "platformInfo";
      platform: string;
      activeBackend?: TerminalBackendType;
    }
  | {
      type: "terminalConfig";
      fontSize: number;
      fontFamily: string;
      cursorBlink: boolean;
      cursorStyle: "block" | "underline" | "bar";
      scrollback: number;
      sendKeybindingsToShell?: boolean;
      isEditorTab?: boolean;
      focusIndicatorMode?: FocusIndicatorMode;
      focusIndicatorBorderWidth?: number;
    }
  | {
      type: "activeSession";
      backend?: TerminalBackendType;
      /** True when tool is OpenCode and the resolved CLI major >= 2. */
      openCodeV2?: boolean;
      /** True when OpenCode carries the oh-my-opencode-slim plugin. */
      hasOhMyOpenCodeSlim?: boolean;
    }
  /** Ask the webview to show the service-restart prompt for an upcoming terminal restart. */
  | { type: "showServiceRestartPrompt" }
  /** Ask the webview to confirm a destructive one-way sync operation. */
  | {
      type: "showWebdavConfirm";
      requestId: string;
      title: string;
      body: string;
      confirmLabel: string;
      cancelLabel: string;
    }
  | {
      type: "keymapData";
      items: KeymapItem[];
      /** User overrides keyed by dotted command id. */
      overrides: Record<string, string>;
      configPath: string;
    }
  | { type: "keymapSaveResult"; ok: boolean; id?: string; error?: string }
  | { type: "keymapError"; error: string }
  | {
      type: "openCodeCliSettingsData";
      items: OpenCodeCliSettingItem[];
      groups: OpenCodeCliSettingsGroupMeta[];
      values: Record<string, unknown>;
      overrides: Record<string, boolean>;
      configPath: string;
      themeOptions: OpenCodeCliSettingOption[];
      plugins: unknown[];
      /** Installed plugin versions from OpenCode's npm cache, keyed by package name. */
      installedPluginVersions?: Record<string, string>;
      /** npm latest version for plugins that follow latest, keyed by package name. */
      pluginLatestVersions?: Record<string, string>;
    }
  | {
      type: "openCodeCliSettingsSaveResult";
      ok: boolean;
      path?: string;
      error?: string;
    }
  | {
      type: "openCodeCliPluginUpdateCheckResult";
      ok: boolean;
      results?: OpenCodeCliPluginUpdateInfo[];
      error?: string;
    }
  | { type: "openCodeCliSettingsError"; error: string }
  /** Full settings snapshot for the extension settings dialog. */
  | { type: "extensionSettingsData"; settings: ExtensionSettingsSnapshot }
  /** Per-control write feedback; failures carry a short reason. */
  | { type: "extensionSettingsSaveResult"; ok: boolean; key?: string; error?: string }
  /** OpenCode session (re)started; cli.json plugin version pins are now active. */
  | { type: "openCodeSessionStarted" }
  /** Single push channel driving the OpenCode self-update UI. */
  | { type: "openCodeUpdateStatus"; status: OpenCodeUpdateUiStatus }
  | { type: "openCodeChangelog"; payload: OpenCodeChangelogPayload }
  /** Translation result for one request; failures carry a short reason. */
  | {
      type: "openCodeChangelogTranslation";
      requestId: string;
      ok: boolean;
      translations?: Record<string, string>;
      /** Host-localized failure reason shown next to the failure label. */
      error?: string;
    }
  /** Batched upgrade/install output lines for the progress dialog log pane. */
  | { type: "openCodeUpdateOutput"; lines: string[] }
  /* ===================== WebDAV config sync ===================== */
  /** Full snapshot reply to requestWebdavSyncData. */
  | { type: "webdavSyncData"; snapshot: WebDavSyncSnapshot }
  /** Partial merge push driving the status icon, popover and panel footer. */
  | { type: "webdavSyncStatus"; delta: WebDavSyncStatusDelta }
  | { type: "webdavTestResult"; ok: boolean; latencyMs?: number; message?: string }
  | { type: "webdavSaveResult"; ok: boolean; error?: string }
  | { type: "webdavLog"; lines: string[] };

/* ===================== WebDAV config sync payload types ===================== */

/** Phases the in-sidebar startup indicator can render. */
export type StartupPhase = "starting" | "preStartSync" | "idle";

/**
 * How the pre-launch config sync ended, as far as the user can tell.
 * `synced` and `cooldown` mean the files are current; `failed` and `timeout`
 * mean the launch proceeded without a completed sync. A user-initiated skip
 * has no verdict: the user just made that decision, so nothing is shown.
 */
export type PreStartSyncResult = "synced" | "cooldown" | "failed" | "timeout";

/**
 * One progress tick of the pre-launch config sync.
 *
 * `scan` walks the remote tree, whose size is unknown up front, so it carries
 * no counts. `transfer` moves files and reports `current`/`total`/`path`.
 */
export interface PreStartSyncProgress {
  phase: "scan" | "transfer";
  current: number;
  total: number;
  path?: string;
}

/** Granular auto-sync trigger toggles: master switch plus per-trigger items. */
export interface WebDavAutoSyncConfig {
  enabled: boolean;
  onStartup: boolean;
  onLocalChange: boolean;
  remotePoll: boolean;
}

/** Server connection fields edited in the server card; persisted by the explicit save button. */
export interface WebDavServerConfig {
  url: string;
  username: string;
  basePath: string;
  allowInsecureHttp: boolean;
  acceptSelfSigned: boolean;
  /** Max WebDAV requests per sliding window; 0 = unlimited. */
  rateLimitMaxRequests?: number;
  /** Sliding window length in minutes. */
  rateLimitWindowMinutes?: number;
}

/** How a deletion on one side is handled. */
export type WebDavDeletionPolicy = "prompt" | "ignore" | "propagate";

/**
 * Sync direction for this machine. `followServer` applies the server tree and
 * never uploads; `bidirectional` keeps the three-way merge.
 */
export type WebDavSyncMode = "bidirectional" | "followServer";

/** Behavior options that apply immediately when changed in the panel. */
export interface WebDavSyncOptions {
  autoSync: WebDavAutoSyncConfig;
  pollIntervalMinutes: number;
  showStatusIcon: boolean;
  /** Omitted by callers that do not change the sync mode. */
  mode?: WebDavSyncMode;
  /** Omitted by callers that do not change the deletion policy. */
  deletions?: WebDavDeletionPolicy;
  /** Sync the key config files before OpenCode starts. */
  preStartSync?: boolean;
  /** Cooldown window in minutes; 0 syncs on every launch. */
  preStartSyncCooldownMinutes?: number;
}

/** Sync settings snapshot for the panel; server card plus immediate options. */
export interface WebDavSyncSettings extends WebDavServerConfig, WebDavSyncOptions {
  /** Always present in the snapshot; the webview renders the mode selector. */
  mode: WebDavSyncMode;
  /** True when a password is stored in SecretStorage for this server. */
  passwordSet: boolean;
}

/** One sync item row (built-in defaults plus user-added custom paths). */
export interface WebDavSyncItemUi {
  id: string;
  path: string;
  /** "pattern" items are regex entries (stored with an "re:" prefix) expanded by the host. */
  kind: "file" | "dir" | "pattern";
  enabled: boolean;
  builtin: boolean;
}

/** Deletion decisions surface as conflicts with a dedicated kind. */
export type WebDavConflictKind = "content" | "localDeleted" | "remoteDeleted";

export interface WebDavConflictEntry {
  id: string;
  path: string;
  kind: WebDavConflictKind;
  localMtime?: number;
  localSize?: number;
  remoteMtime?: number;
  remoteSize?: number;
  /** ETag observed when the conflict was detected, used to detect drift. */
  remoteEtag?: string | null;
  /** Machine-readable cause hint, e.g. first sync without a baseline. */
  reason?: string;
}

export type WebDavSyncState =
  | "unconfigured"
  | "idle"
  | "syncing"
  | "error"
  /** Password missing on this device or rejected by the server. */
  | "needsAuth";

export type WebDavHistoryDirection = "up" | "down" | "both" | "none";

/** What started a sync pass; recorded on each history entry. */
export type WebDavSyncTrigger =
  | "startup"
  | "preStart"
  | "localChange"
  | "poll"
  | "retry"
  | "configSave"
  | "excludeChange"
  | "manual"
  | "modeChange"
  /** Forced one-way passes from the panel or the command palette. */
  | "forcePull"
  | "forcePush";

export interface WebDavHistoryEntry {
  time: number;
  /** Legacy direction of the pass; kept for entries persisted by older versions. */
  direction: WebDavHistoryDirection;
  /** Trigger source of the pass; missing on entries persisted before the field existed. */
  trigger?: WebDavSyncTrigger;
  /** Legacy total transfer count; kept for entries persisted by older versions. */
  files: number;
  /** Per-action counts; absent on entries persisted by older versions. */
  uploads?: number;
  downloads?: number;
  /** Remote files removed as part of the pass (e.g. by an exclude purge). */
  deletes?: number;
  /**
   * Relative paths moved by the pass, shallowest first so top-level files
   * lead the sample. Capped on persist; the action counts remain the
   * authoritative total. Absent on entries persisted by older versions.
   */
  paths?: string[];
  result: "success" | "partial" | "failed";
  message?: string;
}

/** Complete state of the sync feature, sent on requestWebdavSyncData. */
export interface WebDavSyncSnapshot {
  state: WebDavSyncState;
  pendingCount: number;
  conflictCount: number;
  lastSyncAt?: number;
  /** Host-localized relative label, e.g. "3 分钟前". */
  lastSyncLabel?: string;
  /** Circuit breaker: auto triggers paused after fatal or repeated errors. */
  autoSyncPaused: boolean;
  /** True when this window is the leader that runs the auto-sync channels. */
  leader: boolean;
  /** Connection, trigger and visibility settings edited in the general section. */
  settings: WebDavSyncSettings;
  items: WebDavSyncItemUi[];
  /** User-defined paths excluded from syncing, relative to the config directory. */
  excludes: string[];
  conflicts: WebDavConflictEntry[];
  history: WebDavHistoryEntry[];
}

/** Partial status push; unset fields keep their previous webview values. */
export interface WebDavSyncStatusDelta {
  state?: WebDavSyncState;
  pendingCount?: number;
  conflictCount?: number;
  lastSyncAt?: number;
  lastSyncLabel?: string;
  autoSyncPaused?: boolean;
  /** Leadership changed: this window now owns (or lost) the auto-sync channels. */
  leader?: boolean;
  /** Transient toast text (host-localized); shown once, then dismissed. */
  notice?: string;
}

/** Connection-test draft taken from the form; never persisted by the host. */
export interface WebDavConnectionDraft {
  url: string;
  username: string;
  /** Present only when the user typed a new password in the form. */
  password?: string;
  basePath: string;
  allowInsecureHttp: boolean;
  acceptSelfSigned: boolean;
}

/** One translatable text block extracted from changelog HTML by the webview. */
export interface ChangelogTextBlock {
  id: string;
  /** Text with `⟦n⟧` placeholders for inline code and version-like tokens. */
  text: string;
}

/** Release-notes payload for the in-webview update dialog. */
export interface OpenCodeChangelogPayload {
  version: string;
  ok: boolean;
  date?: string;
  html?: string;
  /** Stable hash of `html`, used as part of the translation cache key. */
  htmlHash?: string;
  fallbackUrl: string;
  /** Echo of the request: upcoming notes carry the update action. */
  mode?: "upcoming" | "installed";
}

/** Step ids used by the OpenCode self-update pipeline (aligned with OpenCodeUpdateService). */
export type OpenCodeUpdateStep =
  | ""
  | "prepare-target"
  | "prepare-local"
  | "execute"
  | "reshim"
  | "verify"
  | "remediate-trust"
  | "remediate-reshim"
  | "installing";

/**
 * OpenCode self-update UI status pushed via `openCodeUpdateStatus`.
 *
 * All fields except `state` and `step` are optional so the host can push
 * partial updates; the webview merges each push over the previous status.
 * Push `{ state: "idle", step: "" }` with no versions to hide the feature.
 */
export interface OpenCodeUpdateUiStatus {
  /**
   * Flow state; `available` shows the clickable badge pill, `failed`
   * returns to it, `installable` turns the pill into the install entry
   * for a missing CLI.
   */
  state:
    | "idle"
    | "installable"
    | "available"
    | "updating"
    | "success"
    | "failed";
  /** Currently executing step id; empty when no step is running. */
  step: OpenCodeUpdateStep;
  /** Command or short description of the current step, shown dimmed in mono. */
  detail?: string;
  /** Version the update installs. */
  targetVersion?: string;
  /** Version on disk after the update; pill renders this while present. */
  installedVersion?: string;
  /** Running version for the availability tooltip; falls back to installedVersion. */
  currentVersion?: string;
  /** Latest released version; falls back to targetVersion in tooltips. */
  latestVersion?: string;
  /**
   * One-shot marker on the push that resolves a check: `upToDate` when
   * the CLI is already current (the UI state is `idle` there). Lets the
   * changelog dialog distinguish "already current" from a failed check
   * without matching localized notice text.
   */
  checkOutcome?: "upToDate";
  /** Method choices parsed from CLI help; omitted uses the built-in list. */
  methods?: string[];
  /** Host-computed default method for popover preselection. */
  defaultMethod?: string;
  /** Auto-detected install method; rendered as the merged detection mark. */
  detectedMethod?: string;
  /** Last successfully used method; takes preselection priority. */
  lastUsedMethod?: string;
  /** Version the terminal session is still running, if it differs. */
  runningVersion?: string;
  /** Completed/attempted steps for the progress card and log drawer. */
  history?: Array<{ step: string; ok: boolean; label: string }>;
  /** Recovery commands for the nvm auto-fix flow; used as the manual fallback list. */
  remediationCommands?: string[];
  /** Manual fallback commands when the auto-fix itself failed. */
  manualCommands?: string[];
  /**
   * Transient flag on a manual-check "available" push: the webview opens
   * the update dialog at the given step instead of waiting for a pill
   * click. Automatic checks leave it unset so only the pill is marked.
   * `notes` starts at the release notes, `method` skips straight to the
   * method list used by the missing-CLI install flow.
   */
  openUpdateDialog?: "notes" | "method";
  /**
   * Transient flag on an "installable" push: the CLI was just detected as
   * missing, so the webview shows the install confirmation dialog once
   * per page. Other states never carry it.
   */
  installPromptPending?: boolean;
  /**
   * Transient flag on a "success" push for the missing-CLI install flow:
   * the host already booted the session automatically, so the card shows
   * an informational line instead of the restart actions.
   */
  sessionAutoStarted?: boolean;
  /**
   * Pre-translated transient message (manual check result, abandon notice)
   * shown in the card slot for about 4.5 s.
   */
  notice?: string;
}

/** npm version check result for one configured OpenCode plugin. */
export interface OpenCodeCliPluginUpdateInfo {
  /** Package name extracted from the plugin entry (without version). */
  name: string;
  /** Version pinned in config, if any. */
  current: string | null;
  /** Latest version on npm, if lookup succeeded. */
  latest: string | null;
  hasUpdate: boolean;
  error?: string;
}
export type LogLevel = "debug" | "info" | "warn" | "error";
export type DiagnosticSeverity = "error" | "warning" | "information" | "hint";

export interface ExtensionConfig {
  autoStart: boolean;
  command: string;
  fontSize: number;
  fontFamily: string;
  cursorBlink: boolean;
  cursorStyle: "block" | "underline" | "bar";
  scrollback: number;
  autoFocusOnSend: boolean;
  autoStartOnOpen: boolean;
  shellPath: string;
  shellArgs: string[];
  autoShareContext: boolean;
  httpTimeout: number;
  logLevel: LogLevel;
  contextDebounceMs: number;
  maxDiagnosticLength: number;
  enableAutoSpawn: boolean;
  codeActionSeverities: DiagnosticSeverity[];
}
