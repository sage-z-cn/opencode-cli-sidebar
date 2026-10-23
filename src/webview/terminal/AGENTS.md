# Webview Terminal Agent Notes

## Scope

- `src/webview/terminal/` owns the xterm.js lifecycle: instance creation, config parsing, keyboard routing, fit/resize/visibility, and HTML generation.
- Sibling webview modules (`messages/`, `dragdrop/`, `clipboard/`, `links/`, `toolbar/`, `shared/`) are documented in `src/webview/AGENTS.md`; this file covers the terminal subdir only.

## Files

| File | Role |
|---|---|
| `index.ts` | `initTerminal()` — primary xterm bootstrap; returns `{ terminal, fitAddon, dispose }` |
| `config.ts` | Parses `TerminalConfig` from `#terminal-container` `data-*` attributes |
| `theme.ts` | Resolves the xterm palette from VS Code webview variables (`--vscode-terminal-*`) and watches for theme changes |
| `terminal-container.ts` | Emits the `<div id="terminal-container" data-*>` fragment |
| `keyboard.ts` | `attachCustomKeyEventHandler` wiring; `ALWAYS_TERMINAL_CONTROL` set |
| `resize.ts` | `ResizeObserver` + `IntersectionObserver` + initial-fit phases |
| `fit.ts` / `fit.test.ts` | Full-width fit helpers — `fitFullWidth()` replaces every `fitAddon.fit()` call, reclaiming the 14px scrollbar reserve FitAddon subtracts when `scrollback > 0` |
| `html.ts` | Full-page HTML composition (CSP, nonce, CSS/JS URIs, toolbar) |
| `toolbar.ts` / `toolbar.html` | Toolbar render from `?raw` HTML, l10n-localized; the AI tool pill is a static OpenCode label |
| `html-asset.d.ts` | Type decl for `*.html?raw` webpack loader |
| `terminal.css` (in parent `src/webview/`) | All webview styles |

## initTerminal() Sequence (order-sensitive)

1. Read config from `container.dataset.*`
2. Create `Terminal` (cursorBlink/style, fontSize, fontFamily, theme from `theme.ts`, scrollback)
3. `attachCustomKeyEventHandler(handler)`
4. Load `FitAddon`
5. Load `WebLinksAddon`
6. `terminal.open(container)`
7. Load `WebglAddon` (try/catch — silent fallback to canvas renderer, no addon swap)
8. `registerLinkProvider(...)` — **after** renderer init so link underline layer sets up correctly
9. Install wheel/contextmenu/drag/focus events
10. `setupVisibilityHandling()` (IntersectionObserver, threshold 0.1)
11. `setupResizeHandling()` (ResizeObserver + window.resize, 50ms debounce)
12. `performInitialFit()` — three-phase (see below)

## Fit Timing

Initial fit runs in three scheduled phases — all three fire, do not collapse them:

- `requestAnimationFrame` → `fit()` + post `ready` (with cols/rows)
- `setTimeout(100ms)` → `fit()` + `refresh()` + post `terminalResize`
- `setTimeout(500ms)` → `fit()` + `refresh()`

Other fit triggers: window resize (50ms debounce), container resize (rAF + 50ms debounce via ResizeObserver), `webviewVisible` host message (50ms timeout), `terminalConfig` update (immediate), post-`clearTerminal` (immediate).

All fits route through `fitFullWidth()` in `fit.ts` instead of raw `fitAddon.fit()`. It combines FitAddon's proposed rows with full-width cols and performs at most one `terminal.resize()` per call, so a steady-state fit is a no-op and emits no `terminalResize` messages.

`scheduleRefresh()` (in `../shared/utils.ts`) rAF-debounces `terminal.refresh()` so overlapping fits do not stack screen updates.

## Keyboard Routing (`keyboard.ts`)

- `ALWAYS_TERMINAL_CONTROL` — shell/TUI control chords (Ctrl+C, Ctrl+D, etc.) are **always** routed to the terminal; never suppress for IDE shortcuts.
- Paste (`Cmd/Ctrl+V`) and copy are intercepted and routed through the host via `setClipboard` / `triggerPaste` messages.
- `Shift+Enter` → emits `\n`.
- `sendKeybindingsToShell` setting toggles whether Ctrl/Cmd+letter/number chords pass through to the terminal.

## Dual xterm Creation Paths

- `initTerminal()` (here) creates the primary instance.
- `TerminalManager` (in parent `src/webview/terminal-manager.ts`) has its own `.create()`. `main.ts` calls `initTerminal()` first, then `terminalManager.register(result)`. If `register()` is called with no instance, it falls back to `this.create()`.
- Know which path owns the current instance before recreating or disposing.

## Drag/Drop Layers

Drag/drop handlers exist at three levels; window-level fires first:
1. `index.ts` window-level (captures OS/Finder drag overlays)
2. `terminal-manager.ts` container-level (own file-path extraction)
3. `dragdrop/index.ts` shared `handleDrop()` (called by #1)

All three share the same extraction logic but #2 has a duplicated copy. When changing drop behavior, audit all three.

## Constraints

- `*.html?raw` imports are inlined as source strings via webpack `asset/source` loader — the `.d.ts` declares the module shape.
- CSP requires nonce on all inline scripts; `cspSource` comes from the host webview object.
- WebGL fallback is silent — there is no explicit CanvasAddon swap.
- The xterm palette mirrors the integrated terminal via `--vscode-terminal-*`; `background-sync` may override `--terminal-background` afterward to match a TUI's painted background. On a workbench theme change xterm drops OSC overrides, so `background-sync` resets its mirrored OSC state and force-repaints every layer.
- After applying a workbench theme change, the webview sends `CSI ? 997 ; 1 n` / `; 2 n` through `terminalInput`, but only while the alternate screen is active. OpenCode's TUI treats it as a color-scheme notification and re-queries OSC 10/11, so its own theme updates without a restart; normal-screen shell prompts never receive it.

## Verification

- Tests use `// @vitest-environment jsdom` and mock `../shared/vscode-api`.
- `src/webview/**` is excluded from coverage thresholds; webview tests run but do not count.
