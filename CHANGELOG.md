# Changelog

All notable changes to the "OpenCode CLI Sidebar" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

#### Unreleased
**Bug Fixes**
- **Sync**: Keep conflict and status state consistent across all VS Code windows.

**Improvements**
- **Sync**: Carry the sync status on the config sync toolbar button instead of a separate status icon.
- **UI**: Replace hand-drawn toolbar and panel icons with Lucide icons.
- **UI**: Merge the font increase, decrease, and reset actions into one toolbar dropdown.
- **UI**: Use cloud icons for sync conflict and credential states; drop count badges from the toolbar status.

#### 5.6.0
**New Features**
- **Sync**: Add cross-window process lock for auto-sync leadership.
- **Links**: Stitch hard-wrapped file paths across rows with a shared hover underline.

**Bug Fixes**
- **Sync**: Stop auto-opening the conflict panel on new conflicts.

#### 5.5.1
**New Features**
- **Sync**: Add bulk conflict resolution and credential error states.

#### 5.5.0
**New Features**
- **Sync**: Add WebDAV config sync.
- **Sync**: Add ETag-guarded conflict resolution and per-direction history counts.
- **Keymap**: Prompt before overwriting conflicting shortcut bindings.

#### 5.4.0
**New Features**
- **OpenCode**: Sync OpenCode updates across windows via SecretStorage.

**Bug Fixes**
- **Update**: Harden OpenCode version sync against probe cache races.

#### 5.3.1
**New Features**
- **Update**: Trust the OpenCode module under nvm after upgrades.

**Improvements**
- **l10n**: Add zh-cn translations for keybind catalog entries.

#### 5.3.0
**New Features**
- **OpenCode**: Add readonly settings and keybind catalog sync.
- **OpenCode**: Add a changelog viewer in the webview.

**Improvements**
- **Catalog**: Sync OpenCode catalogs with v2.0.28.

#### 5.2.0
**New Features**
- **Update**: Show the target version in the update popover and start checking for updates immediately on activation.
- **Update**: Replace the progress card with a toolbar progress line for a cleaner update indicator.

**Bug Fixes**
- **Update**: Keep the missing-CLI install prompt armed against the racing activation check.
- **Webview**: Fully suppress the xterm legacy viewport scrollbar arrows.

**Improvements**
- **OpenCode**: Share a single `--version` probe across consumers.
- **Update**: Race latest-version endpoints in parallel instead of checking them sequentially.

#### 5.1.0
**New Features**
- **Keymap**: Search key chords by recording them directly.
- **Terminal**: Register legacy `ai-sidebar-terminal` command aliases for compatibility.

#### 5.0.0
**New Features**
- **Install**: Detect a missing OpenCode CLI and install it directly from the webview.
- **Settings**: Migrate `ai-sidebar-terminal` settings automatically on activation.

**Bug Fixes**
- **CLI Install**: Replace the "don't ask again" dismissal with a retry probe flow.
- **Webview**: Redesign the service-restart confirmation dialog, clarify its copy, and fix the warning button hover state.

**Improvements**
- Rebrand the extension to OpenCode CLI Sidebar.
- Remove multi-AI-tool support so the extension runs OpenCode only.

#### 4.7.0
**New Features**
- **Terminal**: Prompt to restart the OpenCode service when the terminal is restarted.
- **Webview**: Notify the webview when the OpenCode session restarts so plugin update pins are cleared.

#### 4.6.1
**Improvements**
- **Update**: Probe the local OpenCode version at startup so the update pill fills instantly instead of waiting.

#### 4.6.0
**New Features**
- **Update**: Auto-open the method popover when a manual update check is triggered.

**Bug Fixes**
- **Update**: Skip the update flow and report up-to-date when the version on disk is already current.

**Improvements**
- **Webview**: Render the entry pill dot using a flex pseudo-element for cleaner styling.

#### 4.5.0
**New Features**
- **Update**: Add OpenCode CLI self-update flow.
- **Webview**: Add a clickable restart button for pending plugin updates.

**Bug Fixes**
- **Providers**: Restart the OpenCode v2 background service before relaunching a session.
- **Keymap**: Offset the scroll target by the sticky header height so items are not hidden underneath it.

#### 4.4.0
**New Features**
- **OpenCode CLI Settings**: Add plugin management to the OpenCode CLI settings.
- **Terminal**: Sync the webview background with the TUI theme via background-sync.

**Bug Fixes**
- **Terminal**: Reclaim the 14px scrollbar width previously reserved by FitAddon in the webview.

#### 4.3.0
**New Features**
- **CLI Settings**: Add reload buttons to keymap and CLI settings modals.

#### 4.2.1
**Improvements**
- **OpenCode**: Rename OpenCode settings to OpenCode CLI settings and add config file actions.

#### 4.2.0
**New Features**
- **OpenCode**: Add a settings panel for editing TUI options in cli.json.

**Bug Fixes**
- **OpenCode**: Never pass `--port` when the CLI major version is unknown.
- **Keymap**: Recover the v2 flag when detection only succeeds after launch.

#### 4.1.2
**Bug Fixes**
- **OpenCode**: Improve CLI version detection and keymap flag resolution.

#### 4.1.1
**Bug Fixes**
- **Keymap**: Fix keymap visibility handling by deriving it from the pill's live selection and ensuring reliable visibility plus active session delivery.
- **Keymap**: Fix hidden toolbar buttons by adding the missing `.toolbar-btn.hidden` CSS rule.

#### 4.1.0
**New Features**
- **Keymap**: Add an OpenCode v2 keymap viewer and editor, allowing you to browse and customize keybindings from within the extension.

#### 4.0.0
**New Features**
- **OpenCode**: Add support for the OpenCode v2 background service.

#### 3.6.1
README improvements: added screenshots and standardized the zh-cn readme filename. However, per the rules, docs-only changes are skipped and no category has qualifying entries, so there is no changelog content for this release.

#### 3.6.0
**New Features**
- **Terminal**: Add a configurable focus indicator with a new `bottomBorder` default mode that highlights the focused terminal.
- **Context**: Seed the IDE context server with an active editor snapshot and filter out non-file schemes so the AI tool receives only relevant file context.

**Bug Fixes**
- **Open File**: Log open failures via the logger instead of showing error popups.

#### 3.5.0
**New Features**
- **Explorer context menu**: Add "Send Absolute Path to AI Terminal" command below the existing send command, for files and folders. Sends an absolute-path reference (uppercase drive letter, forward slashes, trailing `/` for directories) into the AI tool prompt input.

**Bug Fixes**
- **Build**: Silence optional `ws` native peer warnings in the webpack bundle.

**Improvements**
- **OpenCode**: Emit bare line numbers in file references (`@src/app.ts#42`, `@src/app.ts#37-42`) instead of the `#L`-prefixed form, and append a trailing slash to directory references (`@src/`) for both drag-drop and explorer/editor menu entry points. Terminal file-link detection accepts the new bare-number suffixes.

## [3.4.0] - 2026-07-20

### Added

- **Terminal links**: Add support for Windows backslash relative paths in file-link detection, matching bare relative paths that use `\` separators alongside the existing forward-slash form.

### Changed

- **Terminal**: Remove the automatic paste behavior triggered on the editor context menu. Sending to the AI Terminal now only forwards the `@file` reference without auto-pasting into the terminal input.

## [3.3.1] - 2026-07-02

### Fixed

- **Terminal links**: Correct file-link detection in terminal output around CJK and punctuation. Compute the link range in terminal cell coordinates so CJK/fullwidth characters no longer shift the underline position; treat CJK/fullwidth punctuation and ASCII `",;!?` as token boundaries to stop paths from gluing to surrounding localized text; strip trailing prose punctuation from link candidates; and restrict bare relative paths to an ASCII path-character whitelist, rejecting false positives like `once/repeat/workday`.

## [3.3.0] - 2026-07-01

### Changed

- **Context**: Repurpose `autoShareContext` to gate the editor-context WebSocket server at AI tool session start, replacing the previous one-shot HTTP `appendPrompt` auto-context injection. The setting now controls live editor context sharing via WebSocket instead of injecting a file reference into the prompt, and takes effect when the AI tool session is (re)started.

## [3.2.0] - 2026-06-29

### Added

- **IDE Context**: Add editor context WebSocket server for OpenCode TUI integration, enabling real-time editor context sharing with the OpenCode TUI.

### Fixed

- **OpenCode**: Align HTTP API client and spawn behavior with OpenCode >=1.x.

## [3.1.0] - 2026-06-25

### Added

- **Editor tab context menu**: Bind `sendToAiTerminal` to the editor tab right-click menu (`editor/title/context`), filtered to file-scheme resources via `when: resourceScheme == file`. The active editor's `@file` reference is sent when invoked from a tab, since VS Code's internal editor group ID is not exposed to extensions.

### Changed

- **Context menu labels**: Rename `sendAtMention` command title from "Send File Reference (@file)" to "Send to AI Terminal" so the Explorer, Editor, and Editor Tab menus all share the same label. The `Alt+A` shortcut and the Editor menu still preserve selection line numbers (`@file#L10-L20`) via the unchanged `sendAtMention` handler.
- **Context menu grouping**: Move Explorer and Editor entries into a dedicated `0_ai_sidebar_terminal` group (right after `navigation`), and place the new Tab entry in `1_cm_ai_sidebar_terminal` so it lands between the Close and Copy Path groups as an independent section.

## [3.0.1] - 2026-06-16

### Fixed

- **Toolbar**: Keep the toolbar visible by default instead of relying on an `activeSession` message that could be dropped before the webview JS registers its listener, which caused the toolbar to occasionally disappear. Removed the now-dead initial `hidden` class and the related `.toolbar.hidden` CSS rule and `classList.remove("hidden")` call.

## [3.0.0] - 2026-06-13

### Changed

- **Architecture**: Remove multi-pane layout, tmux/zellij/dashboard backends, and backend-selector UI. Simplify to a single-terminal native-only model.
- **Toolbar**: Remove rerender button and add dynamic editor attachment icon.

### Fixed

- **Paste**: Enable image paste when clipboard has no text.
- **Paths**: Normalize host-specific path separators for cross-platform consistency.

## [2.6.0] - 2026-06-11

### Added

- **Mimo Code**: Add built-in support for Xiaomi Mimo Code (`mimo` command). Supports HTTP API and auto-context sharing via the OpenCode-compatible operator.
- **Tool resolution**: Merge user-configured `aiTools` with built-in defaults so newly added tools automatically appear in the toolbar selector. Users can hide built-in tools with `"enabled": false`.

## [2.5.2] - 2026-06-04

### Fixed

- **Webview**: Fix incorrect link underline position caused by off-by-one error in buffer line access (`getLine(bufferLineNumber)` → `getLine(bufferLineNumber - 1)`). Also update `Link` interface and `activate` callback to match xterm.js 6.0 API, and move link provider registration after the WebGL addon initialization.
- **Webview**: Reduce link detection false positives by rejecting tokens starting with CJK characters (e.g. `因为src/file.ts`), rejecting `label:path` patterns like `Error:`, `Warning:`, `git:` that are not drive letters or `file://` URLs, and adding `SINGLE_FILE_RE` to match standalone filenames like `package.json`, `.eslintrc.json`, `README.md`.

## [2.5.1] - 2026-06-04

### Fixed

- **Webview**: Route paste shortcuts through extension host to prevent paste events being swallowed when `sendKeybindingsToShell` is enabled.
- **Webview**: Refactor terminal file link handling — extract file opening logic into dedicated `openFile.ts` module with improved validation, add `endLine` support for range selection, and rewrite link parser to correctly handle `file://` URIs, colon-delimited positions, and path traversal rejection.

## [2.5.0] - 2026-06-04

### Added

- **Toolbar**: Add keyboard shortcuts access via merged settings dropdown for quick configuration.
- **Native terminal**: Auto-restore native terminal without prompting for a smoother switching experience.

### Fixed

- **Toolbar**: Fix terminal refresh by constraining body dimensions to prevent rendering issues.

## [2.4.3] - 2026-06-02

### Changed

- **Build**: Add compile step to `package` script and `build-and-install` workflow for reliable packaging. Exclude `scripts/` from VSIX package while keeping `CHANGELOG.md`.
- **Rebrand**: Replace remaining "Open Sidebar TUI" references with "AI Sidebar Terminal" in log messages, comments, and `OutputChannelService` channel name.
- **Default backend**: Set `native` as the default terminal backend instead of `tmux` for better cross-platform compatibility.

## [2.4.0] - 2026-06-02

### Added

- **Pill dropdown toolbar**: Quick switching between AI tools (OpenCode, Claude, Codex, etc.) and terminal backends (tmux, native, zellij) via unified pill-style dropdowns.

### Changed

- **Rebrand**: Rename internal identifiers from `ost` to `ai-sidebar-terminal` for consistency.

### Fixed

- Remove global mouse tracking initialization in webview to prevent unintended event interference.

## [2.3.0] - 2026-06-01

### Added

- **l10n translation injection mechanism**: Inject extension host translation strings into webview via `window.__TOOLBAR_L10N__`, solving the issue that webview cannot directly call `vscode.l10n`.
- **l10n build integration**: webpack CopyPlugin automatically copies `l10n/` to `dist/`, supporting translation loading in F5 development mode.
- **l10n coverage audit tool**: Added `scripts/check-l10n.js` to detect missing or extra translation keys in the bundle.
- **Standalone build-and-install script**: Added `scripts/build-and-install.js`, output VSIX filename uses `{name}-{version}.vsix` format.

### Fixed

- Fix 16 missing translation keys in `bundle.l10n.zh-cn.json` (toolbar button titles and dynamic status tooltips).
- Fix 3 quote nesting issues in `bundle.l10n.zh-cn.json` (inner double quotes changed to single quotes).
- Fix hardcoded English strings in `toolbar/index.ts` overriding translated titles.
- Fix missing `l10n` field in `package.json` preventing `vscode.l10n` API from loading translation bundles.
- Fix smart quotes in `package.nls.zh-cn.json` causing display issues.

## [2.2.1] - 2026-05-31

### Changed

- Unified WebView color scheme to dark background.

## [2.2.0] - 2026-05-31

### Added

- Added settings button (⚙) to toolbar, clicking directly opens extension settings panel (filtered by `ai-sidebar-terminal.` prefix).

### Fixed

- Fix backend switch button tooltip from "Switch to Native Shell" to "Cycle terminal backend".
- Fix session tab centering issue, switched to absolute positioning to ensure tabs stay centered.

## [2.1.1] - 2026-05-31

### Fixed

- Fix re-render button not working — switch from `fitAddon.fit()`/`terminal.refresh()` to `maxHeight` DOM trick to reliably trigger xterm.js re-render via ResizeObserver.

## [2.1.0] - 2026-05-31

### Added

- Add l10n (localization) support with `vscode.l10n` translation bundle and `i18n` module.
- Localize extension host modules (commands, providers, services) via `l10n.t()`.
- Add `package.nls.json` for extension manifest localization.
- Add terminal re-render button (▣) that performs fit+refresh without restarting the process.
- Localize all toolbar button titles via `vscode.l10n`.

## [2.0.0] - 2026-05-30

### Changed

- Fork from [islee23520/opencode-sidebar-tui](https://github.com/islee23520/opencode-sidebar-tui) as independent extension `sagez.opencode-sidebar-tui-sage`.
- Rename all command and configuration IDs from `opencodeTui`/`opencode` prefix to `ost` to avoid conflicts with the original extension.
- Rename display name to "Opencode Sidebar TUI".

### Fixed

- Fix Shift+Enter sending CRLF instead of LF in the sidebar terminal.
- Fix CopyPlugin glob mismatch on Windows preventing dashboard/terminal assets from being copied to `dist/`.
- Fix sidebar xterm height stuck at 360px after packaging due to missing CSS files.

## [1.8.0] - 2026-05-18

### Added

- Add multi-backend terminal support with `native`, `tmux`, and `zellij` backend selection.
- Add native terminal backend support with ask-first AI tool selection.
- Add `ai-sidebar-terminal.terminalBackend` setting for choosing the terminal backend.
- Add `ai-sidebar-terminal.sendKeybindingsToShell` so terminal-focused Ctrl/Cmd shortcuts can be passed through to the TUI.

### Changed

- Change `ai-sidebar-terminal.autoStartOnOpen` default to `false` so users can choose which AI tool to launch when opening the sidebar.
- Rename dashboard command labels to `Open Terminal Managers` for clearer VS Code command palette and menu wording.
- Improve Windows compatibility and terminal UX around shell handling, paths, clipboard behavior, and terminal focus.
- Expand automated test coverage across core commands, providers, services, terminals, webview keyboard handling, and VS Code mocks.

### Fixed

- Fix Shift+Enter newline handling in the sidebar terminal.
- Fix editor title actions so `Open Terminal in Editor` and `Open Terminal Managers` only appear after the extension is fully active.
- Fix package repository URL metadata by removing the leading whitespace.

### Security

- Update dependency lockfile entries for `postcss`, `fast-uri`, `brace-expansion`, `ajv`, and `serialize-javascript`.
- Add a `serialize-javascript` override to force `^7.0.5`.

## [1.4.1] - 2026-03-03

### Fixed

- Fix all "Send to OpenCode" commands broken after 1.4.0 multi-instance patch
  - Root cause: `OpenCodeTuiProvider.startOpenCode()` did not write `terminalKey` into the InstanceStore, causing `getActiveTerminalId()` to resolve to a non-existent terminal ID
  - On fresh installs (empty store), `getActive()` threw → fallback to `"opencode-main"`, while the actual terminal was created with ID `"default"` → silent mismatch
  - Fixed by ensuring the instance store record is created/updated with the correct `terminalKey` after terminal creation
- Fix `sendFileToTerminal` (Send File Reference) not working from editor and explorer context menus
- Fix `sendAtMention` (Send @file) not working
- Fix `sendAllOpenFiles` (Send All Open Files) not working
- Fix `sendToTerminal` (Send Selected Text) not working

### Improved

- Support multi-file selection in Explorer context menu — selecting multiple files and using "Send to OpenCode" now sends all selected files as `@file1 @file2 @file3`
- Replace notification popups (`showInformationMessage`) with transient status bar messages (`setStatusBarMessage`) when sending files — less intrusive UX

## [1.3.2] - 2026-02-20

### Fixed

- Support multi-file selection in Explorer context menu - multiple files are now sent together as `@file1 @file2 @file3`
- Improve drag-and-drop handling for VS Code editor tabs - files dragged from editor tabs are now properly captured
- Remove duplicate "Send to OpenCode Terminal" from editor context menu - only "Send File Reference (@file)" remains
- Fix multi-file drag-and-drop from Explorer - all selected files are now processed instead of just the first one

## [1.1.0] - 2025-02-06

### Added

- **HTTP API Integration**: Bidirectional communication with OpenCode CLI via HTTP API
  - Auto-discovery of OpenCode CLI HTTP server on ephemeral ports (16384-65535)
  - Health check endpoint (`/health`) for availability validation
  - Prompt append endpoint (`/tui/append-prompt`) for sending commands
  - Exponential backoff retry logic for reliable communication
  - Configurable timeout (default: 5000ms)

- **Auto-Context Sharing**: Automatically shares editor context when terminal opens
  - Shares all open files on terminal startup
  - Includes line numbers for active selections
  - Format: `@path/to/file#L10-L20`
  - Configurable via `ai-sidebar-terminal.autoShareContext` setting

- **Port Management Service**: Ephemeral port allocation for HTTP communication
  - Port range: 16384-65535 (standard ephemeral range)
  - Collision detection and prevention
  - Per-terminal port tracking
  - Automatic cleanup on terminal closure

- **Context Sharing Service**: Editor context detection and formatting
  - Detects current file and selection
  - Formats file references with line numbers
  - Supports `@file`, `@file#L10`, `@file#L10-L20` formats

- **New Configuration Options**:
  - `ai-sidebar-terminal.enableHttpApi`: Enable/disable HTTP API (default: `true`)
  - `ai-sidebar-terminal.httpTimeout`: HTTP request timeout in milliseconds (default: `5000`, range: 1000-30000)
  - `ai-sidebar-terminal.autoShareContext`: Auto-share editor context on terminal open (default: `true`)

### Changed

- **Architecture Documentation**: Clarified sidebar-only architecture
  - Added explicit note that this is a sidebar-only extension (not native VS Code: terminal)
  - Documented HTTP API vs WebView messaging architecture
  - Updated feature list to highlight HTTP API capabilities

- **Communication Method**: Migrated from terminal I/O to HTTP API for reliable bidirectional communication
  - More reliable than terminal stdin/stdout parsing
  - Better error handling and retry capabilities
  - Cleaner separation of concerns

### Technical

- Added `OpenCodeApiClient` for HTTP communication with retry logic
- Added `PortManager` for ephemeral port allocation
- Added `ContextSharingService` for editor context detection
- Added `TerminalDiscoveryService` for terminal integration
- Added `OutputCaptureManager` for output handling
- Comprehensive test coverage for all new services

## [1.0.4] - 2025-01-XX

### Added

- Initial release with core functionality
- Auto-launch OpenCode when sidebar is activated
- Full TUI support with xterm.js and WebGL rendering
- File references with line numbers (`@filename#L10-L20`)
- Keyboard shortcuts (`Cmd+Alt+L`, `Cmd+Alt+A`)
- Drag & drop support for files
- Context menu integration
- Configurable terminal settings

### Features

- **Terminal Management**: node-pty backend with xterm.js frontend
- **File References**: Send current file or selection to OpenCode
- **Keyboard Shortcuts**: Quick access commands
- **Context Menus**: Right-click integration in Explorer and Editor
- **Drag & Drop**: Shift-drag files to send as references
- **Configuration**: Customizable command, font, and terminal settings

[2.0.0]: https://github.com/sage-z-cn/ai-sidebar-terminal/compare/v1.8.0...v2.0.0
[1.8.0]: https://github.com/sage-z-cn/ai-sidebar-terminal/compare/v1.3.2...v1.8.0
[1.1.0]: https://github.com/sage-z-cn/ai-sidebar-terminal/compare/v1.0.4...v1.1.0
[1.0.4]: https://github.com/sage-z-cn/ai-sidebar-terminal/releases/tag/v1.0.4

