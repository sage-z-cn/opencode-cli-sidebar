# Services Agent Notes

## Scope

- `src/services` is the stateful backend: instance store/persistence/discovery/control, HTTP client, ports, native terminal backend plans, throttling, OpenCode operator helpers, context/file references, config sync, logging, and output capture.
- The only backend type is `"native"`. There are no external multiplexer managers, pane sync services, or dashboard services in the current tree.

## Instance Layer

- `InstanceStore` is the in-memory source of truth for instance records and the active instance. It emits `change`, `setActive`, `add`, and `remove`.
- `InstanceRegistry` hydrates/persists `InstanceStore` from VS Code global/workspace state and preserves `terminalBackend` and `backendState` when present. Legacy `selectedAiTool` JSON fields in old state files are ignored without migration.
- `InstanceDiscoveryService` discovers running OpenCode-compatible HTTP instances and syncs discovered process state.
- `InstanceController` spawns/connects/disconnects/kills/resolves stored instances; it uses `PortManager` and `TerminalManager` and optionally `ConnectionResolver`. It is dormant code — not wired by `ExtensionLifecycle` — and its hardcoded default command `"opencode"` must be changed to read the `opencode.commandPath` setting if it is ever wired up.
- `ConnectionResolver` is the stored/discovered/spawn resolution path for HTTP ports; do not duplicate that fallback chain elsewhere.
- `InstanceQuickPick` is the user-facing session switcher: selecting an item calls `InstanceStore.setActive()`, which drives provider/session switching.

## Single-Terminal State

- Active instance switching is store-driven; do not keep a separate active instance cache outside `InstanceStore`/`SessionRuntime`.
- `SessionRuntime` manages a single terminal session with one terminal key.
- `DataThrottleService` batches terminal output for smooth rendering.
- `NativeTerminalManager.create()` returns a `BackendLaunchPlan` for persisted restore metadata, but backend availability currently resolves to `native` in `terminalBackends.ts`.

## Ports And Logging

- Use `PortManager.getInstance(...)` or the module-level `portManager`; no ad hoc port allocation.
- OpenCode v1 HTTP ports are assigned in the ephemeral range `16384-65535` and passed via `_EXTENSION_OPENCODE_PORT` plus `OPENCODE_CALLER=vscode`.
- OpenCode v2 rejects `--port` on the TUI and uses a background service (`~/.local/state/opencode/service.json`, Basic auth user `opencode`). `OpenCodeCliCompat` detects the CLI major version and resolves the v2 endpoint; do not append `--port` for v2.
- Use `OutputChannelService.getInstance()` for logging. Tests may reset the singleton; never call `new OutputChannelService()` directly.

## OpenCode Operator

- OpenCode-specific behavior lives in `src/services/aiTools/OpenCodeToolOperator`; the extension runs OpenCode only, so there is no registry or per-tool dispatch.
- Formatting file refs, dropped files, pasted images, and the launch command built from the `opencode.commandPath` / `opencode.args` settings belongs there rather than in command/provider conditionals.

## Startup Coordination

- `OpenCodeReadiness` reports the machine-wide background-service state (`down` / `starting` / `ready` / `failed`) by combining the registration file with `GET /api/info`; every window shares one daemon, so this state is global, not per-session.
- `StartupCoordinator` serializes the first start across windows through a lease file under `globalStorage/startup`. The lease owner starts the service through its own TUI; the others wait for readiness instead of spawning a contender. Call it only for v2 launches that do not pass `--standalone` / `--server`.
- The gate must never block a launch indefinitely: every wait is bounded and falls through to a direct start. Do not add an unbounded loop to `acquire()`; the lease delete can fail on Windows while another handle is open.

## Config Sync

- WebDAV config sync lives in `src/services/sync`: `ConfigSyncService` owns the sync state machine, `WebDavClient` the HTTP layer, `syncItems` item/path/exclusion rules, `SyncManifest` the remote baseline manifest.
- Data safety first: ambiguous states resolve to conflicts, never silent overwrites. Local destruction paths require a successful backup first. The exception is deliberate scope exit: adding an exclusion purges the corresponding remote files without a prompt.
- `sync.deletions` is the only path that removes a file without a prompt: `propagate` mirrors a deletion to the other side, and only while that side still matches the manifest baseline; any newer version on the survivor keeps surfacing as a conflict.
- `sync.mode` is machine-scoped in `package.json` (`scope: machine`), so VS Code Settings Sync never carries it; each device chooses its direction independently. `followServer` never uploads or deletes remotely: it downloads any differing server file, mirrors server deletions locally only when a baseline exists, and leaves never-synced local-only files untouched. A scoped launch pass still never deletes locally, even in follow mode. A missing server folder refuses the follow pass instead of deleting the whole local scope.
- Forced passes (`forcePull` / `forcePush`) ignore `sync.mode`, `onConflict` and `deletions`, take the pass lock, and suspend this window's auto channels for their duration. Both require an in-webview confirmation (the command path reveals the view first); an empty source scope aborts instead of erasing the other side. Forced push backs remote-only files up under `sync/backups-remote` before deleting them and skips deletions when an upload failed; forced pull backs up local files under `sync/backups` before overwriting or removing them.
- `ConfigSyncService` resolves through `syncServiceRegistry`; commands and the message router never instantiate it directly.
- Sync passwords go to VS Code SecretStorage; never log credentials or write them to settings/state.
- Machine-wide UI status (conflicts, state, lastSyncAt, pendingCount, autoSyncPaused) lives in `sync/status.json` under globalStorage; every window watches the file and converges through it. `leader` stays per-window. Writes are serialized per window and carry a unique `writeId` (revision numbers can collide across windows). State-only writes preserve the file's conflict list; only a full pass scan replaces it and conflict resolution removes resolved entries, so a stale window cannot resurrect resolved conflicts.

### Pass Lock

- `SyncManifest.save()` rewrites the whole file from an in-memory snapshot, so exactly one pass may read it per machine. `sync/pass.lock` (`SyncProcessLock`, 8s staleness) is taken in `executeSync` before the manifest is loaded; `runSync` and `resolveConflicts` both go through it. Without it, two windows each write their own baseline and every file degrades to a `noBaseline` conflict.
- The pass lock and the auto-sync leadership lock are different files with different jobs: leadership elects who runs watcher/poller, the pass lock protects the manifest. Never merge them.
- A pass that cannot take the lock returns `"busy"` instead of running. Callers decide: auto passes skip silently, manual sync tells the user, the launch gate waits on the completion stamp.

### Scoped Launch Pass

- `runScopedPass({ scopePaths, signal, onProgress })` is the pre-launch entry point. `runSync` returns `SyncPassResult` (`done | aborted | failed | busy`) so callers can tell a skipped pass from a failed one.
- A scoped pass locks its own decisions: `onConflict: "prompt"` and `deletions: "ignore"` regardless of settings. It runs before the user has seen any UI, so it must never resolve a difference on its own.
- A scoped pass merges its conflicts into the shared list and leaves `pendingCount` alone; replacing them would erase conflicts another pass found in files this one never scanned.
- Aborts surface as `SyncAbortError` and are handled before the rate-limit/fatal/transient branches: state returns to `idle`, the breaker and `failureStreak` stay untouched, and per-file manifest checkpoints already landed.
- `WebDavClient` takes an optional `signal`; `paceRequest` sleeps in 250ms slices so an abort lands during a rate-limit wait instead of after the full window.

### Pre-Start Gate

- `PreStartSyncGate` (`src/services/sync/PreStartSyncGate.ts`) runs the scoped pass before OpenCode starts. `LaunchGate` (`src/services/LaunchGate.ts`) bundles it with `StartupCoordinator` so `SessionRuntime` carries one gate instead of two.
- `sync.preStartSync` is independent of `sync.autoSyncOnStartup` and off by default: the launch waits for it, so it must be switchable alone. The startup toggle stays a separate switch for the full reconcile.
- Only the first launch of a window runs it. Restart and instance switching reuse `startDefaultSession`, and rewriting `cli.json` under a running TUI races that process's own write.
- Scope comes from `SyncItemDefinition.preStart`, not a parallel list. `AGENTS.md` and `skills/` stay out: the launch only needs what OpenCode reads while booting. A successful launch pass then calls `reconcileAfterLaunch()` so those files still sync on startup without delaying it.
- When a v2 service already answers, the pass covers `cli.json` only. The service watches and hot reloads `opencode.json*` and the plugin config; `cli.json` is read per TUI process with no watcher.
- Dedupe is a completion stamp (`sync/prestart.json`, atomic write) plus the pass lock. The stamp records the server identity, so changing servers invalidates it. Skips and failures write a stamp too: without one, every sibling window waits out its own full budget.
- The cooldown is `sync.preStartSyncCooldownMinutes`, default 5 minutes, `0` for every launch. The launch pass is cheap when nothing changed (a scoped pass only stats its own files), so a short window costs little while still collapsing a burst of window reloads.
- The budget is enforced from outside with `Promise.race` and aborts the pass. An internal deadline would not hold, because the client can sit in a rate-limit wait for minutes.
- Failures are log-only with a two-minute negative cache. One opportunistic launch attempt must not pause the machine-wide auto sync.
- `initialize()` skips its own startup pass when `preStartSync` is on: the launch pass plus its reconcile already cover the same tree.


## Verification

- Service tests are colocated as `*.test.ts`, with some older grouped tests under `src/services/__tests__`.
- Tests touching singleton or global service state must reset using the existing reset helpers/patterns.
