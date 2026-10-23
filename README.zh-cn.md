# OpenCode CLI Sidebar

[![Visual Studio Marketplace](https://vsmarketplacebadges.dev/version-short/sagez.opencode-cli-sidebar.svg)](https://marketplace.visualstudio.com/items?itemName=sagez.opencode-cli-sidebar)

[English](https://github.com/sage-z-cn/opencode-cli-sidebar/blob/main/README.md)

在 VS Code 侧边栏中嵌入 OpenCode AI 编程助手，提供完整终端管理。

非官方第三方扩展，与 OpenCode 团队无关。

![OpenCode CLI Sidebar 截图](screenshot/screenshot.webp)

## 功能特性

- **自动启动 OpenCode**: 侧边栏激活时自动启动 OpenCode
- **完整 TUI 支持**: xterm.js + WebGL 渲染的终端模拟
- **单终端模式**: 专注的单终端体验，支持会话/实例切换
- **Pill 工具栏**: 侧边栏工具栏中的静态 OpenCode 标识
- **OpenCode v2 快捷键**: 在侧边栏工具栏查看并修改 OpenCode TUI 快捷键（仅 OpenCode v2）
- **HTTP API 集成**: 通过 HTTP API 与 OpenCode CLI 双向通信（兼容 OpenCode v1 与 v2）
- **自动上下文共享**: 终端打开时自动共享编辑器上下文
- **带行号的文件引用**: 以 `@filename#L10-L20` 语法发送文件引用
- **代码操作**: 对错误和警告触发诊断代码操作
- **键盘快捷键**: `Alt+A` 发送文件引用，`Cmd+Alt+A` 发送所有打开文件
- **图片粘贴支持**: 从剪贴板直接粘贴图片到终端
- **拖放支持**: 按住 Shift 拖放文件/文件夹发送引用
- **右键菜单集成**: 在资源管理器、编辑器内容区或编辑器选项卡中右键发送到 Opencode
- **辅助侧边栏**: 将终端停靠在辅助侧边栏实现分屏工作流
- **高度可配置**: 自定义 OpenCode 命令、字体、终端设置和 HTTP API 行为

## 架构

本扩展提供**仅侧边栏**的终端体验。OpenCode 内嵌在 VS Code 侧边栏活动栏中运行，而非原生 VS Code 终端面板。

### 通信架构

扩展采用混合通信方式：

1. **HTTP API**: 与 OpenCode CLI 的主要通信通道
   - 兼容 OpenCode v1 与 v2（通过 `opencode --version` 自动探测）
   - v1：临时端口范围 16384-65535，启动时追加 `--port=N`
   - v2：连接 OpenCode 后台服务（从服务状态文件自动发现），使用 Basic 认证

2. **WebView 消息**: 扩展宿主与侧边栏 WebView 之间的终端 I/O
   - xterm.js 终端渲染
   - 双向消息传递用于输入/输出

## 使用方法

1. 点击活动栏中的 OpenCode CLI Sidebar 图标
2. 终端视图激活时自动启动
3. 直接在侧边栏中与 OpenCode 交互

## 命令

### 基础命令

- **OpenCode CLI Sidebar: Start OpenCode** - 手动启动 OpenCode
- **OpenCode CLI Sidebar: Paste** - 粘贴文本到终端
- **OpenCode CLI Sidebar: Focus Terminal** - 聚焦侧边栏终端

### 文件引用命令

- **Send File Reference (@file)** (`Alt+A`) - 发送当前文件及行号
  - 无选中：`@filename`
  - 单行：`@filename#L10`
  - 多行：`@filename#L10-L20`
- **Send All Open File References** (`Cmd+Alt+A` / `Ctrl+Alt+A`) - 发送所有打开的文件引用
- **Send to Opencode** - 通过右键菜单发送选中文本或文件
- **Send to Active Terminal** - 发送选中文本到活动终端

### 键盘快捷键

| 快捷键                    | 功能             | 适用场景                  |
| ------------------------- | ---------------- | ------------------------- |
| `Alt+A`                    | 发送文件引用     | 编辑器或终端              |
| `Cmd+Alt+A` / `Ctrl+Alt+A` | 发送所有打开文件 | 编辑器或终端              |
| `Cmd+V` / `Ctrl+V`         | 粘贴             | 终端聚焦时                |
| `Ctrl+P`                   | 透传             | 终端聚焦时（透传）        |

### 右键菜单

- **资源管理器**: 右键任意文件或文件夹 → "Send to Opencode"
- **编辑器**: 右键任意位置 → "Send to Opencode"（仍走 `sendAtMention` 命令，带选区行号 `@file#L10-L20`，与 `Alt+A` 一致）
- **编辑器选项卡**: 右键任意编辑器选项卡 → "Send to Opencode"（发送当前活动编辑器的 `@file` 引用）

> 三处菜单均位于各自右键菜单的顶部，显示文字一致。编辑器菜单和 `Alt+A` 快捷键保留选区行号；资源管理器和选项卡菜单发送纯 `@file` 引用。

### 拖放

- 按住 **Shift** 拖动文件/文件夹到终端，以 `@file` 引用方式发送

## OpenCode v2 快捷键

当运行的是 **OpenCode v2**（CLI 主版本 ≥ 2）时，侧边栏工具栏会出现快捷键图标（在字体大小与设置之间）。

- 列出全部 OpenCode TUI 快捷键，支持搜索、状态筛选（已绑定 / 已修改 / 未绑定）和分类导航
- 读取 `~/.config/opencode/cli.json` 中的自定义绑定（`keybinds`）；已修改项会显示默认值
- 点击快捷键 chip（或双击行）打开编辑弹窗并录制新绑定
- 一个命令可绑定**多个快捷键**，可对单个绑定进行添加、替换、删除
- Leader 序列（如先按 `Ctrl+X` 再按 `N`）通过先按 Leader 再按后续键录入
- 立即写回 `cli.json`：清空绑定写入 `none`，恢复默认则删除对应覆盖项
- 重置前会二次确认

> OpenCode v1 下不显示快捷键按钮。

## OpenCode 更新

在 OpenCode v2 下，扩展可以直接在侧边栏内更新 OpenCode CLI。

- **自动检查**：激活后不久在后台检查一次（npm 官方源优先，失败时回退 npmmirror 与腾讯云 npm 镜像），之后按 `update.checkIntervalHours` 小时的间隔定期检查；未发现更新时保持安静
- **手动检查**：在命令面板运行 `OpenCode CLI Sidebar: Check for OpenCode Updates` 命令，或使用设置菜单中的检查入口
- **版本角标**：发现新版本后，工具栏的版本号即更新入口；点击弹出更新方式气泡（curl/npm/pnpm/bun/yarn/vp/brew，自动标记检测到的与上次使用的安装方式）
- **进度与重启**：更新过程不会中断当前会话；完成后卡片提供“立即重启”，将终端切换到新版本
- **nvm 自动处理**：在 nvm-windows 上自动执行所需的 `reshim`，遇到 nvm 防火墙拦截时自动信任并重试；自动处理失败时展示需要手动执行的命令
- **设置项**：`update.autoCheck`（默认 `true`）开关后台检查；`update.checkIntervalHours`（默认 `24`，最小 `1`）设置检查间隔

> 更新功能需要 OpenCode v2 及以上版本；OpenCode v1 下不显示版本入口。

## OpenCode CLI 设置

同样在 OpenCode v2 下，快捷键按钮旁会出现 **OpenCode CLI 设置** 按钮（在快捷键与扩展设置之间），用于编辑 `cli.json` 中的 TUI 配置。

- 按分组展示：外观、输入与滚动、会话展示、标签、差异视图、终端、通知与声音、Mini 模式、调试与实验、插件
- 侧栏只用于定位到对应分组；内容区一次铺开全部设置
- 主题名称为下拉，选项含内置主题与 `themes/*.json` 自定义主题
- 开关/下拉即时保存；文本与数字失焦保存；滑杆松手保存
- 「快捷键绑定」分组为跳转链接，打开上方的 Keymap 弹窗
- 写回 `cli.json` 时保留其它字段；改回默认值会删除对应键

### 主题行为

侧边栏终端会继承 VS Code 的终端主题：背景、前景、光标/选区以及 16 色 ANSI 调色板都取自当前工作区主题，并在切换主题时立即更新。OpenCode 默认的 `opencode` 主题只提供 light/dark 两套变体，因此在同类主题之间切换时颜色可能不变。默认启用 `opencode-cli-sidebar.followVsCodeTheme`：扩展会把 OpenCode 的 **主题名称** 和 **主题模式** 设为 `system`，让 TUI 重新读取终端调色板并跟随每个工作区主题。这会覆盖本地选择的 OpenCode 主题。在 OpenCode CLI 设置中修改 **主题名称** 或 **主题模式** 会自动关闭该设置，以保留你的显式选择；重新启用即可再次跟随 VS Code。

> 该按钮与快捷键按钮同样仅在 OpenCode v2 下显示。

## HTTP API 集成

扩展通过 HTTP API 与 OpenCode CLI 通信，实现可靠的双向通信：

### 功能

- **版本探测**：通过 `opencode --version` 自动探测 v1/v2（主版本号 >= 2 视为 v2）
- **自动发现**：v1 自动发现 HTTP 服务器端口（临时端口），v2 从服务状态文件发现后台服务（失败时回退 `opencode service status`）
- **健康检查**：v1 使用 `GET /global/health`，v2 使用 `GET /api/info`，发送命令前验证可用性
- **重试逻辑**：指数退避确保可靠通信
- **上下文共享**：终端打开时自动共享编辑器上下文

### 工作方式

**OpenCode v1：**

1. 扩展以 `--port=N` 启动 OpenCode，N 为临时端口（16384-65535）
2. 文件引用和上下文通过 HTTP POST 发送到 `/tui/append-prompt`（通过 `x-opencode-directory` 请求头按工作区路由）
3. 健康检查使用 `GET /global/health`

**OpenCode v2：**

1. v2 的 TUI 不再接受 `--port` 参数，而是连接 OpenCode 后台服务
2. 扩展从服务状态文件读取服务地址与凭据（`~/.local/state/opencode/service.json`；Windows 下为 `AppData\Local\opencode\service.json` 或 `AppData\Roaming\opencode\service.json`），失败时回退到 `opencode service status`
3. 所有请求使用 HTTP Basic 认证（用户名 `opencode`，密码来自服务状态文件）
4. 健康检查使用 `GET /api/info`，工作区目录通过 `GET /api/location` 解析
5. v2 移除了 `/tui/append-prompt`，文件引用和上下文改为直接写入终端输入

## 自动上下文共享

启用后，终端打开时自动共享编辑器上下文：

- **打开的文件**: 列出所有当前打开的文件
- **活动选中内容**: 包含选中文本的行号
- **格式**: `@path/to/file#L10-L20`

此功能消除了手动共享上下文的需要。

> **关于行号的说明**：扩展共享的是 1-based 行号（与 VS Code 显示的行号一致）。但 OpenCode 内部使用 0-based 行号，因此自动上下文中的 `#L52` 在 OpenCode 的上下文显示中可能表现为 `#51`。这是预期行为，并非 Bug。

## 配置

在 VS Code 设置中可用（`Cmd+,` / `Ctrl+,`）：

### 终端设置

| 设置                                   | 类型    | 默认值            | 描述                                      |
| -------------------------------------- | ------- | ----------------- | ----------------------------------------- |
| `opencode-cli-sidebar.fontSize`         | number  | `12`              | 终端字号（像素，6-25）                    |
| `opencode-cli-sidebar.fontFamily`       | string  | Nerd Font 字体栈* | 终端字体族                                |
| `opencode-cli-sidebar.cursorBlink`      | boolean | `true`            | 启用光标闪烁                              |
| `opencode-cli-sidebar.cursorStyle`      | string  | `"block"`         | 光标样式：`block`、`underline`、`bar`     |
| `opencode-cli-sidebar.scrollback`       | number  | `10000`           | 回滚缓冲区最大行数（0-100000）            |
| `opencode-cli-sidebar.autoFocusOnSend`  | boolean | `true`            | 发送文件引用后自动聚焦侧边栏              |
| `opencode-cli-sidebar.autoStartOnOpen`  | boolean | `true`            | 侧边栏打开时自动启动 OpenCode               |
| `opencode-cli-sidebar.shellPath`        | string  | `""`              | 自定义 Shell 路径（空 = VS Code 默认）    |
| `opencode-cli-sidebar.shellArgs`        | array   | `[]`              | 自定义 Shell 参数                         |
| `opencode-cli-sidebar.sendKeybindingsToShell` | boolean | `true`       | 将 Ctrl/Cmd 快捷键发送到终端              |
| `opencode-cli-sidebar.followVsCodeTheme` | boolean | `true` | 跟随 VS Code 终端主题：把 OpenCode 主题名称/模式设为 `system` |
| `opencode-cli-sidebar.focusIndicatorMode` | string | `"bottomBorder"` | 侧边栏获得键盘焦点时的指示样式：`off`、`bottomBorder` 或 `fullBorder` |
| `opencode-cli-sidebar.focusIndicatorBorderWidth` | number | `2` | 焦点指示器边框宽度（像素，1-8） |

\* 默认：`'JetBrainsMono Nerd Font', 'FiraCode Nerd Font', 'CascadiaCode NF', Menlo, monospace`

### HTTP API 设置

| 设置                                   | 类型    | 默认值  | 描述                                        |
| -------------------------------------- | ------- | ------- | ------------------------------------------- |
| `opencode-cli-sidebar.enableHttpApi`    | boolean | `true`  | 启用 HTTP API 通信                          |
| `opencode-cli-sidebar.httpTimeout`      | number  | `5000`  | HTTP API 请求超时（毫秒，1000-30000）        |
| `opencode-cli-sidebar.autoShareContext` | boolean | `true`  | 自动共享编辑器上下文给 OpenCode           |
| `opencode-cli-sidebar.contextDebounceMs` | number  | `500`   | 上下文更新防抖延迟（毫秒，100-5000）        |

### OpenCode 设置

| 设置                                        | 类型    | 默认值       | 描述                                       |
| ------------------------------------------- | ------- | ------------ | ------------------------------------------ |
| `opencode-cli-sidebar.opencode.commandPath`  | string  | `"opencode"` | 启动 OpenCode CLI 的命令或可执行文件路径    |
| `opencode-cli-sidebar.opencode.args`         | array   | `[]`         | 传给 OpenCode CLI 的额外参数                |
| `opencode-cli-sidebar.opencode.continueLastSession` | boolean | `true` | 终端启动时续接上一次 OpenCode 会话   |
| `opencode-cli-sidebar.enableAutoSpawn`       | boolean | `true`       | OpenCode 未运行时自动拉起                  |

### 高级设置

| 设置                                            | 类型   | 默认值                 | 描述                                     |
| ----------------------------------------------- | ------ | ---------------------- | ---------------------------------------- |
| `opencode-cli-sidebar.logLevel`                  | string | `"info"`               | 日志级别：`debug`、`info`、`warn`、`error` |
| `opencode-cli-sidebar.maxDiagnosticLength`       | number | `500`                  | 诊断消息最大长度（100-2000）              |
| `opencode-cli-sidebar.codeActionSeverities`      | array  | `["error", "warning"]` | 触发代码操作的诊断严重级别                |

### 示例配置

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

## 安装

### 从源码构建

1. 克隆仓库：

```bash
git clone https://github.com/sage-z-cn/opencode-cli-sidebar.git
cd opencode-cli-sidebar
```

2. 安装依赖：

```bash
npm install
```

3. 构建扩展：

```bash
npm run install-ext
```

4. 打包扩展：

```bash
npx @vscode/vsce package
```

5. 在 VS Code 中安装：

- 打开 VS Code
- 打开扩展面板（`Cmd+Shift+X` / `Ctrl+Shift+X`）
- 点击"..."菜单 → "从 VSIX 安装"
- 选择生成的 `.vsix` 文件

### 从 ai-sidebar-terminal 升级

如果仍安装着改名前旧扩展 `sagez.ai-sidebar-terminal`，请在扩展面板中卸载它。两个扩展都会注册 `ai-sidebar-terminal.*` 命令 ID；当前扩展检测到旧扩展后会跳过 legacy 别名并输出警告，以避免激活失败。卸载旧扩展后，当前扩展会接管这些旧命令 ID，旧快捷键也会继续生效。

## 许可证

MIT — 详见 [LICENSE](LICENSE)。
