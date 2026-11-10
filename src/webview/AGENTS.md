# Webview Agent Notes

## Scope

- `src/webview` is browser-sandbox code: xterm.js rendering, React shell, toolbar, clipboard, drag/drop, links, and host messaging.
- Webpack has one webview entry: `src/webview/main.tsx`, emitted as `dist/webview.js`.
- There is only one webview entry/bundle. Do not re-add a second webview entry without adding a webpack entry and code.
- Toolchain: React 19 + esbuild-loader (`jsx: automatic`). No preact, no `jsxImportSource` override.

## Architecture

- `main.tsx` boots in a fixed order: `initI18n()` → React render → feature controller init → host message listener.
  The i18n bundle must arrive before the first paint, and `ready` is posted by the terminal bootstrap, not here.
- **Not wrapped in `StrictMode`** on purpose. StrictMode double-invokes effects, which would mount xterm, post `ready` (starting the PTY), then dispose it — losing the screen buffer.
- `terminal/TerminalApp.tsx` renders two things: `<Toolbar>` and an empty `<div id="terminal-container">`. xterm is imperative and owns everything inside that div.
- `terminal/useTerminal.ts` mounts xterm exactly once in a `useEffect` with an empty dependency array. Do not add dependencies: re-running disposes the terminal and loses scrollback.
- Terminal config lives on `#root` (written by `src/providers/webviewHtml.ts`) and is mirrored onto `#terminal-container` by `copyConfigDataset`, because downstream modules re-read `dataset` from the container.
- `shared/components/DialogHost.tsx` renders the static dialog shells (keymap, OpenCode CLI settings, sync, extension settings) in the React tree via `dangerouslySetInnerHTML`. Their imperative controllers look elements up by id and toggle classes, so React must not reconcile their internals. The wrapper carries `display: contents`.

## Bridge

- `shared/bridge/` implements `request<T>(command, params)` / `onEvent` over the flat message channel.
- The host side is `src/providers/WebviewRequestRouter.ts`; `TerminalProvider.handleMessage` routes request envelopes there and everything else to `MessageRouter`.
- **Terminal hot path bypasses the bridge.** `terminalInput`, `terminalResize`, and terminal output keep the flat `WebviewMessage` / `HostMessage` unions — wrapping per-keystroke traffic in promises adds overhead for no benefit.

## i18n

- `shared/i18n/core.ts` holds the dictionary; `initI18n()` fills it from a `getL10nBundle` request.
- **The bundle is keyed by English source text.** `t(key, ...args)` looks up its argument; `has(key)` tests it.
- Call sites come in two shapes. `t("English source")` passes the key directly. `t("shortId", "English source")` passes a short identifier first, and the helper looks up the **second** argument — the identifier only names the call site. Getting this backwards compiles fine and silently yields English.
- Use `{0}`-style placeholders. `sync/strings.ts` uses `syncT(id, fallback)` for the same reason.
- **Never evaluate translations at module top level.** Modules are imported before `initI18n()` resolves, so a top-level object literal freezes English. Use a function (`buildXLabels()`) or a `Proxy` (see `sync/strings.ts`).
- Run `npm run check:l10n` after touching translation call sites; `npm run compile` runs it too.
- The `window.__*_L10N__` globals are gone; do not reintroduce them.

## Constraints

- Browser APIs only: no `fs`, `path`, `os`, child processes, or VS Code extension-host APIs.
- Host communication must use `WebviewMessage` / `HostMessage` from `src/types.ts`.
- Keep data shaping in providers/services; webview code should route UI events and render current state.
- Preserve xterm timing: fit after fonts are ready and after terminal becomes visible; avoid fitting hidden DOM nodes.
- `terminal.css` is loaded via `<link>` from `dist/terminal.css` (CopyPlugin). Do not also `import "./terminal.css"` — that would inject a second copy through style-loader.

## Where To Look

- Terminal bootstrap: `terminal/index.ts`; mount/teardown: `terminal/useTerminal.ts`.
- Toolbar markup: `terminal/toolbar.html` (template) rendered by `toolbar/Toolbar.tsx`.
- Host message handling: `messages/host-handlers.ts`.
- Toolbar/pill UI: `toolbar/` (the AI tool pill is a static OpenCode badge; no selector or dropdown).
- Startup indicator: `startup-status/` (rendered over the empty terminal while the shared service boots).
- Clipboard: `clipboard/`.

## Verification

- Webview unit tests were removed during the React migration; `src/webview/**` remains excluded from coverage thresholds.
- Verify UI changes manually in a running extension: terminal fit on show/resize, toolbar dropdowns, dialog open/close, and localization under `zh-cn`.
