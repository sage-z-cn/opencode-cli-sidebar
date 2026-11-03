# Webview Agent Notes

## Scope

- `src/webview` is browser-sandbox code: xterm.js rendering, toolbar, clipboard, drag/drop, links, and host messaging through `acquireVsCodeApi()` wrappers.
- Webpack currently has one webview entry: `src/webview/main.ts`, emitted as `dist/webview.js`.
- There is only one webview entry/bundle. Do not re-add references to a second webview entry without adding a webpack entry and code.

## Single-Terminal Flow

- `main.ts` bootstraps a single xterm terminal via `initTerminal()`, then wires `TerminalManager` for drag/drop and terminal instance management.
- `TerminalManager` owns the single browser xterm instance; `show()` calls `fitFullWidth()` from `terminal/fit.ts` after the terminal is visible.
- Host communication uses `WebviewMessage` / `HostMessage` from `src/types.ts` directly via `messageHandler.handleEvent()`.

## Constraints

- Browser APIs only: no `fs`, `path`, `os`, child processes, or VS Code extension-host APIs.
- Host communication must use `WebviewMessage` / `HostMessage` from `src/types.ts`.
- Keep data shaping in providers/services; webview code should route UI events and render current state.
- Preserve xterm timing: fit after fonts are ready and after terminal becomes visible; avoid fitting hidden DOM nodes.

## Where To Look

- Terminal bootstrap: `main.ts` and `terminal/index.ts`.
- xterm instances and drag/drop handling: `terminal-manager.ts`.
- Toolbar/pill UI: `toolbar/` (the AI tool pill is a static OpenCode badge; no selector or dropdown).
- Host message handling: `messages/index.ts`.
- Startup indicator: `startup-status/` (rendered over the empty terminal while the shared service boots; `l10n.ts` is host-side).
- Clipboard: `clipboard/`.

## Verification

- Webview unit tests live under `src/webview/__tests__` and adjacent `*.test.ts` files, but `src/webview/**` is excluded from coverage thresholds.
