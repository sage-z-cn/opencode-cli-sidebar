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

## Config Sync

- WebDAV config sync lives in `src/services/sync`: `ConfigSyncService` owns the sync state machine, `WebDavClient` the HTTP layer, `syncItems` item/path/exclusion rules, `SyncManifest` the remote baseline manifest.
- Data safety first: ambiguous states resolve to conflicts, never silent overwrites. Local destruction paths require a successful backup first. The exception is deliberate scope exit: adding an exclusion purges the corresponding remote files without a prompt.
- `sync.deletions` is the only path that removes a file without a prompt: `propagate` mirrors a deletion to the other side, and only while that side still matches the manifest baseline; any newer version on the survivor keeps surfacing as a conflict.
- `ConfigSyncService` resolves through `syncServiceRegistry`; commands and the message router never instantiate it directly.
- Sync passwords go to VS Code SecretStorage; never log credentials or write them to settings/state.
- Machine-wide UI status (conflicts, state, lastSyncAt, pendingCount, autoSyncPaused) lives in `sync/status.json` under globalStorage; every window watches the file and converges through it. `leader` stays per-window. Writes are serialized per window and carry a unique `writeId` (revision numbers can collide across windows). State-only writes preserve the file's conflict list; only a full pass scan replaces it and conflict resolution removes resolved entries, so a stale window cannot resurrect resolved conflicts.

## Verification

- Service tests are colocated as `*.test.ts`, with some older grouped tests under `src/services/__tests__`.
- Tests touching singleton or global service state must reset using the existing reset helpers/patterns.
