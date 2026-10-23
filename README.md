# OpenCode CLI Sidebar

[![Visual Studio Marketplace](https://vsmarketplacebadges.dev/version-short/sagez.opencode-cli-sidebar.svg)](https://marketplace.visualstudio.com/items?itemName=sagez.opencode-cli-sidebar)

[中文文档](https://github.com/sage-z-cn/opencode-cli-sidebar/blob/main/README.zh-cn.md)

Embed the OpenCode AI coding agent in the VS Code sidebar with full terminal management.

Unofficial third-party extension, not affiliated with the OpenCode team.

![OpenCode CLI Sidebar screenshot](screenshot/screenshot.webp)

## Features

- **Auto-launch OpenCode**: Automatically start OpenCode when the sidebar is activated
- **Full TUI Support**: Complete terminal emulation with xterm.js and WebGL rendering
- **Single-Terminal**: Focused single-terminal experience with session/instance switching
- **Pill Toolbar**: Static OpenCode badge in the sidebar toolbar
- **OpenCode v2 Keymap**: View and edit OpenCode TUI shortcuts from the sidebar toolbar (OpenCode v2 only)
- **HTTP API Integration**: Bidirectional communication with OpenCode CLI via HTTP API (OpenCode v1 and v2 supported)
- **Auto-Context Sharing**: Automatically shares editor context when terminal opens
- **File References with Line Numbers**: Send file references with `@filename#L10-L20` syntax
- **Code Actions**: Diagnostic-triggered code actions for errors and warnings
- **Keyboard Shortcuts**: `Alt+A` to send file reference, `Cmd+Alt+A` to send all open files
- **Image Paste Support**: Paste images from clipboard directly into the terminal
- **Drag & Drop Support**: Hold Shift and drag files/folders to send as references
- **Context Menu Integration**: Right-click files in Explorer, text in Editor, or editor tabs to send to Opencode
- **Secondary Sidebar**: Dock the terminal in the secondary sidebar for split-screen workflows
- **Configurable**: Customize the OpenCode command, font, terminal settings, and HTTP API behavior

## Architecture

This extension provides a **sidebar-only** terminal experience. OpenCode runs embedded in the VS Code sidebar Activity Bar, not in the native VS Code terminal panel.

### Communication Architecture

The extension uses a hybrid communication approach:

1. **HTTP API**: Primary communication channel with OpenCode CLI
   - OpenCode v1 and v2 supported (detected automatically via `opencode --version`)
   - v1: ephemeral port range 16384-65535, launched with `--port=N`
   - v2: connects to the OpenCode background service (discovered from its service state file) with Basic authentication

2. **WebView Messaging**: Terminal I/O between extension host and sidebar WebView
   - xterm.js for terminal rendering
   - Bidirectional message passing for input/output

## Usage

1. Click the OpenCode CLI Sidebar icon in the Activity Bar (sidebar)
2. The terminal automatically starts when the view is activated
3. Interact with OpenCode directly in the sidebar

## Commands

### Basic Commands

- **OpenCode CLI Sidebar: Start OpenCode** - Manually start OpenCode
- **OpenCode CLI Sidebar: Paste** - Paste text into the terminal
- **OpenCode CLI Sidebar: Focus Terminal** - Focus the sidebar terminal

### File Reference Commands

- **Send File Reference (@file)** (`Alt+A`) - Send current file with line numbers
  - No selection: `@filename`
  - Single line: `@filename#L10`
  - Multiple lines: `@filename#L10-L20`
- **Send All Open File References** (`Cmd+Alt+A` / `Ctrl+Alt+A`) - Send all open file references
- **Send to Opencode** - Send selected text or file from context menu to the OpenCode terminal
- **Send to Active Terminal** - Send selected text to the active terminal

### Keyboard Shortcuts

| Shortcut                   | Command             | Context                        |
| -------------------------- | ------------------- | ------------------------------ |
| `Alt+A`                    | Send File Reference | Editor or Terminal             |
| `Cmd+Alt+A` / `Ctrl+Alt+A` | Send All Open Files | Editor or Terminal             |
| `Cmd+V` / `Ctrl+V`         | Paste               | Terminal focused               |
| `Ctrl+P`                   | Pass through        | Terminal focused (passthrough) |

### Context Menu Options

- **Explorer**: Right-click any file or folder → "Send to Opencode"
- **Editor**: Right-click anywhere → "Send to Opencode" (still sends `@file` with selection line numbers via the `sendAtMention` command, identical to `Alt+A`)
- **Editor Tab**: Right-click any editor tab → "Send to Opencode" (sends the active editor's `@file` reference)

> All three menus appear at the top of their respective context menus with the same label. The Editor menu and `Alt+A` shortcut preserve selection line numbers (`@file#L10-L20`); the Explorer and Tab menus send plain `@file` references.

### Drag & Drop

- Hold **Shift** and drag files/folders to the terminal to send as `@file` references

## OpenCode v2 Keymap

When the running CLI is **OpenCode v2** (major version ≥ 2), a keymap icon appears in the sidebar toolbar (between font size and settings).

- Lists all OpenCode TUI shortcuts with search, status filter (bound / modified / unbound), and category navigation
- Shows custom bindings from `~/.config/opencode/cli.json` (`keybinds`); modified entries display the default value
- Click a key chip (or double-click a row) to open the editor and record a new binding
- A command can have **multiple shortcuts**; add, replace, or delete individual bindings
- Leader sequences (for example `Ctrl+X` then `N`) are recorded by pressing Leader then the follow-up key
- Saves back to `cli.json` immediately; empty bindings write `none`, and restoring defaults removes the override key
- Reset requires confirmation

> The Keymap button is hidden for OpenCode v1.

## OpenCode Updates

Under OpenCode v2, the extension can update the OpenCode CLI from the sidebar.

- **Auto check**: checks the official npm registry (falling back to the npmmirror and Tencent npm mirrors) in the background shortly after activation and then every `update.checkIntervalHours` hours; silent unless an update is found
- **Manual check**: run the `OpenCode CLI Sidebar: Check for OpenCode Updates` command from the Command Palette, or use the check item in the settings menu
- **Version badge**: when an update is available, the toolbar version pill becomes the update entry; clicking it opens a method popover (curl/npm/pnpm/bun/yarn/vp/brew, detected and last-used methods are marked)
- **Progress and restart**: updates run without stopping your session; after success the card offers restarting the terminal onto the new version
- **nvm handling**: on nvm-windows the required `reshim` runs automatically, and nvm firewall blocks are trusted and retried automatically; if the automatic fix fails, the commands to run manually are shown
- **Settings**: `update.autoCheck` (default `true`) enables the background check; `update.checkIntervalHours` (default `24`, minimum `1`) sets the interval

> The update feature requires OpenCode v2 or newer; the version pill is hidden for OpenCode v1.

## OpenCode CLI Settings

Also under OpenCode v2, an **OpenCode CLI Settings** button appears next to the keymap button (between keymap and extension settings) for editing TUI options in `cli.json`.

- Grouped views: appearance, input & scroll, session, tabs, diff, terminal, notifications & sound, Mini mode, debug & experimental, plugins
- The side nav only jumps to a group; the content area stacks all settings
- Theme name is a dropdown with built-in themes plus `themes/*.json` custom themes
- Toggles/dropdowns save immediately; text and number fields save on blur; sliders save on release
- The Keybindings group is a jump link that opens the Keymap modal
- Writes preserve other `cli.json` fields; restoring a default removes that key

### Theme behavior

The sidebar terminal follows VS Code's terminal theme: background, foreground, cursor/selection colors, and the 16 ANSI colors come from the active workbench theme, and they update immediately when the theme changes. OpenCode's default `opencode` theme only provides light/dark variants, so switching between themes of the same kind may not change its colors. By default, `opencode-cli-sidebar.followVsCodeTheme` is enabled: the extension sets OpenCode's **Theme name** and **Theme mode** to `system`, so the TUI re-reads the terminal palette and follows each workbench theme. This overrides a locally chosen OpenCode theme. Changing **Theme name** or **Theme mode** in OpenCode CLI Settings turns the setting off so the explicit choice sticks; re-enable it to follow VS Code again.

> Like the keymap button, this button is shown only for OpenCode v2.

## HTTP API Integration

The extension communicates with OpenCode CLI via an HTTP API for reliable bidirectional communication:

### Features

- **Version Detection**: Detects OpenCode v1/v2 automatically via `opencode --version` (major version >= 2 is treated as v2)
- **Auto-Discovery**: Discovers the HTTP server for v1 (ephemeral ports) and the background service for v2 (service state file, or `opencode service status` as fallback)
- **Health Checks**: `GET /global/health` (v1) or `GET /api/info` (v2) validates availability before sending commands
- **Retry Logic**: Exponential backoff for reliable communication
- **Context Sharing**: Automatically shares editor context on terminal open

### How It Works

**OpenCode v1:**

1. The extension launches OpenCode with `--port=N`, where N is an ephemeral port (16384-65535)
2. File references and context are sent via HTTP POST to `/tui/append-prompt` (routed per workspace via the `x-opencode-directory` header)
3. Health checks use `GET /global/health`

**OpenCode v2:**

1. The v2 TUI no longer accepts `--port`; it attaches to the OpenCode background service
2. The extension reads the service URL and credentials from the service state file (`~/.local/state/opencode/service.json`; on Windows `AppData\Local\opencode\service.json` or `AppData\Roaming\opencode\service.json`), falling back to `opencode service status`
3. All requests use HTTP Basic auth (user `opencode`, password from the service state file)
4. Health checks use `GET /api/info`; workspace directories are resolved via `GET /api/location`
5. `/tui/append-prompt` was removed in v2, so file references and context are typed directly into the terminal instead

### Configuration

```json
{
  "opencode-cli-sidebar.enableHttpApi": true,
  "opencode-cli-sidebar.httpTimeout": 5000,
  "opencode-cli-sidebar.autoShareContext": true
}
```

## Auto-Context Sharing

When enabled, the extension automatically shares editor context with OpenCode when the terminal opens:

- **Open Files**: Lists all currently open files
- **Active Selection**: Includes line numbers for selected text
- **Format**: `@path/to/file#L10-L20`

This feature eliminates the need to manually share context when starting a new session.

> **Note on line numbers**: The extension shares 1-based line numbers (matching VS Code's displayed line numbers). However, OpenCode internally uses 0-based line numbers, so auto-context references like `#L52` may appear as `#51` inside OpenCode's context display. This is expected behavior, not a bug.

## Configuration

Available settings in VS Code settings (`Cmd+,` / `Ctrl+,`):

### Terminal Settings

| Setting                              | Type    | Default           | Description                                          |
| ------------------------------------ | ------- | ----------------- | ---------------------------------------------------- |
| `opencode-cli-sidebar.fontSize`       | number  | `12`              | Terminal font size in pixels (6-25)                  |
| `opencode-cli-sidebar.fontFamily`     | string  | Nerd Font stack\* | Terminal font family                                 |
| `opencode-cli-sidebar.cursorBlink`    | boolean | `true`            | Enable cursor blinking                               |
| `opencode-cli-sidebar.cursorStyle`    | string  | `"block"`         | Cursor style: `block`, `underline`, or `bar`         |
| `opencode-cli-sidebar.scrollback`     | number  | `10000`           | Maximum lines in scrollback buffer (0-100000)        |
| `opencode-cli-sidebar.autoFocusOnSend` | boolean | `true`            | Auto-focus sidebar after sending file references     |
| `opencode-cli-sidebar.autoStartOnOpen` | boolean | `true`            | Automatically start OpenCode when sidebar is opened     |
| `opencode-cli-sidebar.shellPath`      | string  | `""`              | Custom shell path (empty = VS Code default)          |
| `opencode-cli-sidebar.shellArgs`      | array   | `[]`              | Custom shell arguments                               |
| `opencode-cli-sidebar.sendKeybindingsToShell` | boolean | `true` | Send Ctrl/Cmd shortcuts to terminal |
| `opencode-cli-sidebar.followVsCodeTheme` | boolean | `true` | Follow VS Code's terminal theme by setting OpenCode theme name/mode to `system` |
| `opencode-cli-sidebar.focusIndicatorMode` | string | `"bottomBorder"` | Focus indicator when the sidebar has keyboard focus: `off`, `bottomBorder`, or `fullBorder` |
| `opencode-cli-sidebar.focusIndicatorBorderWidth` | number | `2` | Focus indicator border width in pixels (1-8) |

\* Default: `'JetBrainsMono Nerd Font', 'FiraCode Nerd Font', 'CascadiaCode NF', Menlo, monospace`

### HTTP API Settings

| Setting                                  | Type    | Default | Description                                      |
| ---------------------------------------- | ------- | ------- | ------------------------------------------------ |
| `opencode-cli-sidebar.enableHttpApi`      | boolean | `true`  | Enable HTTP API for OpenCode communication       |
| `opencode-cli-sidebar.httpTimeout`        | number  | `5000`  | HTTP API request timeout in ms (1000-30000)      |
| `opencode-cli-sidebar.autoShareContext`   | boolean | `true`  | Auto-share editor context with OpenCode           |
| `opencode-cli-sidebar.contextDebounceMs`  | number  | `500`   | Debounce delay for context updates (100-5000 ms) |

### OpenCode Settings

| Setting                                       | Type    | Default      | Description                                            |
| --------------------------------------------- | ------- | ------------ | ------------------------------------------------------ |
| `opencode-cli-sidebar.opencode.commandPath`    | string  | `"opencode"` | Command or executable path used to launch the OpenCode CLI |
| `opencode-cli-sidebar.opencode.args`           | array   | `[]`         | Extra arguments passed to the OpenCode CLI             |
| `opencode-cli-sidebar.opencode.continueLastSession` | boolean | `true`   | Continue the last OpenCode session when the terminal starts |
| `opencode-cli-sidebar.enableAutoSpawn`         | boolean | `true`       | Auto-spawn OpenCode if it is not running               |

### Advanced Settings

| Setting                                       | Type   | Default                 | Description                                      |
| --------------------------------------------- | ------ | ----------------------- | ------------------------------------------------ |
| `opencode-cli-sidebar.logLevel`                | string | `"info"`                | Log level: `debug`, `info`, `warn`, `error`      |
| `opencode-cli-sidebar.maxDiagnosticLength`     | number | `500`                   | Maximum length of diagnostic messages (100-2000) |
| `opencode-cli-sidebar.codeActionSeverities`    | array  | `["error", "warning"]`  | Diagnostic severities that trigger code actions  |

### Example Configuration

```json
{
  "opencode-cli-sidebar.fontSize": 12,
  "opencode-cli-sidebar.fontFamily": "'JetBrainsMono Nerd Font', monospace",
  "opencode-cli-sidebar.cursorBlink": true,
  "opencode-cli-sidebar.cursorStyle": "block",
  "opencode-cli-sidebar.scrollback": 10000,
  "opencode-cli-sidebar.enableHttpApi": true,
  "opencode-cli-sidebar.httpTimeout": 5000,
  "opencode-cli-sidebar.autoShareContext": true,
  "opencode-cli-sidebar.opencode.commandPath": "opencode"
}
```

## Installation

### From Source

1. Clone the repository:

```bash
git clone https://github.com/sage-z-cn/opencode-cli-sidebar.git
cd opencode-cli-sidebar
```

2. Install dependencies:

```bash
npm install
```

3. Build the extension:

```bash
npm run compile
```

4. Package the extension:

```bash
npx @vscode/vsce package
```

5. Install in VS Code:

- Open VS Code
- Go to Extensions (`Cmd+Shift+X` / `Ctrl+Shift+X`)
- Click "..." menu → "Install from VSIX"
- Select the generated `.vsix` file

### Upgrading from ai-sidebar-terminal

If the pre-rebrand `sagez.ai-sidebar-terminal` extension is still installed, uninstall it from the Extensions view. Both extensions register the `ai-sidebar-terminal.*` command IDs; the current extension detects the old one, skips the legacy aliases, and logs a warning so activation does not fail. Uninstalling the old extension lets the current extension own those legacy IDs and route old keybindings here.

## License

MIT — see [LICENSE](LICENSE) for details.
