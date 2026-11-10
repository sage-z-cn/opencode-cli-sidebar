# Webview Terminal Agent Notes

## Scope

- `src/webview/terminal/` owns the xterm.js lifecycle: instance creation, config parsing, keyboard routing, fit/resize/visibility, and the React mount wrapper.
- Sibling webview modules (`messages/`, `dragdrop/`, `clipboard/`, `links/`, `toolbar/`, `shared/`) are documented in `src/webview/AGENTS.md`; this file covers the terminal subdir only.

## Files

| File | Role |
|---|---|
| `TerminalApp.tsx` | React root: renders `<Toolbar>` + the empty `#terminal-container` div, wires focus ring and clipboard |
| `useTerminal.ts` | Mounts `initTerminal()` once in an effect; mirrors `#root` config onto the container |
| `index.ts` | `initTerminal()` — primary xterm bootstrap; returns `{ terminal, fitAddon, dispose }` |
| `config.ts` | Parses `TerminalConfig` from `data-*` attributes |
| `keyboard.ts` | `attachCustomKeyEventHandler` wiring; `ALWAYS_TERMINAL_CONTROL` set |
| `resize.ts` | `ResizeObserver` + `IntersectionObserver` + initial-fit phases; posts `ready` |
| `fit.ts` | Full-width fit helpers — `fitFullWidth()` replaces every `fitAddon.fit()` call, reclaiming the 14px scrollbar reserve FitAddon subtracts when `scrollback > 0` |
| `focus-indicator.ts` | Body-level focus ring overlay |
| `background-sync.ts` | Background color sync with the host |
| `toolbar.html` | Toolbar template with `{{t:key}}` / `{{icon:key}}` placeholders, rendered by `toolbar/Toolbar.tsx` |
| `html-asset.d.ts` | Type decl for `*.html?raw` webpack loader |

## initTerminal() Sequence (order-sensitive)

1. Read config from `container.dataset.*`
2. Create `Terminal` (cursorBlink/style, fontSize, fontFamily, theme, scrollback)
3. `attachCustomKeyEventHandler(handler)`
4. Load `FitAddon`
5. `terminal.open(container)`
6. Load `WebglAddon` (try/catch — silent fallback to canvas renderer, no addon swap)
7. `registerLinkProvider(...)` — **after** renderer init so link underline layer sets up correctly; this is the only link provider (file paths and http(s) URLs, URLs post `openUrl`)
8. Install wheel/contextmenu/drag/focus events
9. `setupVisibilityHandling()` (IntersectionObserver, threshold 0.1)
10. `setupResizeHandling()` (ResizeObserver + window.resize, 50ms debounce)
11. `performInitialFit()` — three-phase (see below)

## Fit Timing

Initial fit runs in three scheduled phases — all three fire, do not collapse them:

- `requestAnimationFrame` → `fit()` + post `ready` (with cols/rows)
- `setTimeout(100ms)` → `fit()` + `refresh()` + post `terminalResize`
- `setTimeout(500ms)` → `fit()` + `refresh()`

Other fit triggers: window resize (50ms debounce), container resize (rAF + 50ms debounce via ResizeObserver), `webviewVisible` host message (50ms timeout), `terminalConfig` update (immediate), post-`clearTerminal` (immediate).

All fits route through `fitFullWidth()` in `fit.ts` instead of raw `fitAddon.fit()`. It combines FitAddon's proposed rows with full-width cols and performs at most one `terminal.resize()` per call, so a steady-state fit is a no-op and emits no `terminalResize` messages.

`scheduleRefresh()` (in `../shared/utils.ts`) rAF-debounces `terminal.refresh()` so overlapping fits do not stack screen updates.

## React Mount Contract

- `useTerminal` runs `initTerminal` in an effect with `[]` deps. Never add dependencies: each re-run disposes the terminal.
- The webview is **not** wrapped in `StrictMode` — see `src/webview/AGENTS.md`.
- `ready` is posted from `performInitialFit`, so it only fires after xterm has measured itself. That message is what starts the PTY host-side; do not post it from React.

## Keyboard Routing (`keyboard.ts`)

- `ALWAYS_TERMINAL_CONTROL` — shell/TUI control chords (Ctrl+C, Ctrl+D, etc.) are **always** routed to the terminal; never suppress for IDE shortcuts.
- Paste (`Cmd/Ctrl+V`) and copy are intercepted and routed through the host via `setClipboard` / `triggerPaste` messages.
- `Shift+Enter` → emits `\n`.
- `sendKeybindingsToShell` setting toggles whether Ctrl/Cmd+letter/number chords pass through to the terminal.

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
- Terminal config attributes live on `#root`, mirrored to `#terminal-container` on mount. Do not move them.

## Verification

- Webview unit tests were removed during the React migration; `src/webview/**` is excluded from coverage thresholds.
- Verify manually: initial fit, resize, sidebar hide/show, font-size changes, and paste-copy round trips.
