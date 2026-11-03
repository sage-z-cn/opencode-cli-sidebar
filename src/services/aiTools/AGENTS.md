# OpenCode Tools Agent Notes

## Scope

- `src/services/aiTools/` is the OpenCode-specific module. `OpenCodeToolOperator.ts` provides the launch command shape, HTTP API port argument, and `@file` reference / dropped-file / pasted-image formatting used by `SessionRuntime`.
- The operator is a stateless helper. There are no `start()`/`stop()`/`dispose()` lifecycle hooks; process lifecycle is owned by `SessionRuntime` + `TerminalManager`.
- The remaining files in this directory are the OpenCode keybind catalog, CLI settings catalog, and theme discovery/swatches consumed by the settings UI.

## Operator Contract

`OpenCodeToolOperator` implements:

- `getLaunchCommand({ commandPath, args })` — builds the shell command string from the `opencode.commandPath` / `opencode.args` settings; command = `commandPath` + `args`.
- `supportsHttpApi()` / `supportsAutoContext()` — constant `true`; `SessionRuntime` still honours the `autoShareContext` setting around them. The HTTP API has no opt-out setting, so `supportsHttpApi()` only documents intent.
- `buildPortArg(port, options?)` — v1 emits `--port=N`; v2 (`options.cliMajorVersion >= 2`) returns `undefined` because the TUI rejects `--port`.
- `formatFileReference(OpenCodeFileReference)` — `@path` / `@path#42` / `@path#37-42` syntax with bare line numbers.
- `formatDroppedFiles(paths, { useAtSyntax })`
- `formatPastedImage(tempPath)` — passes the temp path through unchanged.

## Gotchas

- Operators never reference `PortManager` directly — `SessionRuntime` calls `buildPortArg` and does port work itself.
- The operator is instantiated in `TerminalProvider` and passed into `SessionRuntime`; there is no registry or per-tool dispatch.

## Verification

- Operator tests: `OpenCodeToolOperator.test.ts` (colocated).
