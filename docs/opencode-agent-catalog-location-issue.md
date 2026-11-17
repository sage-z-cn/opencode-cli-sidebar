# OpenCode TUI Agent 目录丢失 orchestrator 问题跟踪

> 状态：**上游未修复，持续跟踪中**
> 最后更新：2026-11-17

## 摘要

OMO-Slim 插件注册的 `orchestrator` / `oracle` / `fixer` 等 agent，在 OpenCode TUI 的 **Select agent** 弹窗里偶尔完全消失，只剩内置的 `build` / `plan`；而同一实例的侧栏（OMO-Slim Sidebar）显示完全正常。

根因不在插件：**延迟注册路径发出的 `agent.updated` 事件缺少 `location`，OpenCode 客户端把它直接丢弃，且此后不再有事件触发刷新，导致 TUI 永久停在旧目录。**

| 项 | 结论 |
|---|---|
| 归属 | OpenCode 上游（host + client），插件侧无法自修 |
| 触发条件 | 插件 agent 注册被 MCP 快照拖慢，走 deferred 路径 |
| 表现 | TUI agent 列表卡在 `build` / `plan`，重启该 TUI 可恢复 |
| 上游 issue | `anomalyco/opencode#63435`（OPEN） |
| 对症 PR | `anomalyco/opencode#57186`（Draft，已冲突，停更） |

## 环境

| 项 | 值 |
|---|---|
| OpenCode | 2.3.0（`channel=latest`） |
| 插件 | `oh-my-opencode-slim@3.0.7`（buildTime `2026-11-04T19:10:20Z`） |
| OS | Windows（`win32`） |
| 工作区 | `D:\Workspace\vscode-develop\opencode-cli-sidebar` |
| Preset | `auto-ds-flash` |
| 模型 provider | `magpie` |

## 现象

`Ctrl+X` → `A` 打开 Select agent，只列出：

```
● build   The default agent. Executes tools based on con...
  plan    Read-only agent for exploring the codebase and...
```

同期侧栏显示正常（`OMO-Slim v3.0.7` / `Preset auto-ds-flash`，列出 orchestrator、explorer、oracle、designer、fixer、observer）。

**关键差异**：侧栏与 TUI 下拉读的是两个不同的数据源，所以会一个正常一个异常。

## 根因链路

```
插件 agent pass 被 MCP 快照阻塞
        ↓
deferred 路径：在 MCP 回调里、从微任务调用 ctx.agent.reload()
        ↓
reload 实现为 state.ts 的 `() => changed`，notify 在「调用者 fiber」中执行
        ↓
插件跑在 fromPromise 上，该上下文不含 Location.Service（被 Plugin.load 用 Effect.updateContext 剥离）
        ↓
bus.publish(Agent.Event.Updated, {}) 发出的 event 无 location
        ↓
客户端 data.ts：`if (!event.location) return` 直接丢弃
        ↓
agent 缓存保持旧值，且列表内容不再变化 → State.changes 不再发布事件
        ↓
TUI 永久停留在 build / plan
```

### 代码位置

| 环节 | 位置 |
|---|---|
| reload 不携带作用域 | `packages/core/src/state.ts` — `reload: () => changed` |
| 变更检测只比列表内容 | `packages/core/src/state.ts:134` — `State.changes(project, notify)` |
| 插件上下文被剥离 Location | `packages/core/src/plugin.ts` — `Plugin.load` 的 `Effect.updateContext` |
| 客户端丢弃无 location 事件 | `packages/client/src/solid/data.ts:1349` — `if (!event.location) return` |
| TUI 过滤 subagent | `packages/tui/src/context/local.tsx:60` — 过滤 `mode === "subagent"` |

注意最后一行：`oracle` / `fixer` 等本就是 subagent，**永远不会出现在主 agent 下拉**。下拉里 OMO 只贡献 `orchestrator` 一个。所以「只剩 build/plan」等价于「orchestrator 丢了」。

## 日志证据（2026-11-17 本次复现）

插件侧注册完全成功（`~/.local/share/opencode/log/oh-my-opencode-slim.20261117T023418-33460.log`）：

```
02:34:27.605  [plugin] instance scope {"directory":"D:\\Workspace\\vscode-develop\\opencode-cli-sidebar"}
02:34:27.691  [plugin] health check passed {"agents":6,"tools":10,"mcps":2}
02:34:34.621  [v2] agents registered {"count":6}      ← 6 个 agent 全部写入
02:34:34.677  [v2] agents registered {"count":6}
02:35:40.360  [plugin] runtime profiles refreshed from disk {"agents":9}
```

OpenCode 侧事件缺 location（`~/.local/share/opencode/log/opencode.log`）：

```
02:34:34.633  provider.updated  location.directory="D:\\Workspace\\...\\opencode-cli-sidebar"
02:34:34.638  model.updated     location.directory="D:\\Workspace\\...\\opencode-cli-sidebar"
02:34:34.678  agent.updated     event.data={}        ← 唯独这条没有 location
02:34:34.909  command.updated   location.directory="D:\\Workspace\\...\\opencode-cli-sidebar"
```

同一毫秒级批次里，`provider` / `model` / `command` 都带目录，只有 `agent.updated` 不带 —— 这是定位根因的决定性证据。

### 为什么是「偶发」

对照同一天另一个工作区（`D:\Apexsoft\LivePush`）成功的一次：

```
02:39:13.850  agent.updated  location.directory="D:\\Apexsoft\\LivePush"   ← 带 location
02:39:13.878  agent.updated  （无 location）
```

只要有一轮走的是**内联路径**（`agent.transform` 回调内完成、由 Location 作用域内的 transform 发布），事件就带 location，客户端刷新成功，目录自愈。纯 deferred 的批次则永久卡住。

判定方法：插件日志中 `setup invoked` 到 `agents registered` 的时间差。本次为 **约 7 秒**（27.605 → 34.621），说明 agent pass 被 MCP 快照卡住，走的是 deferred 路径。

### 为什么侧栏正常

| 数据源 | 内容 | 是否受本 bug 影响 |
|---|---|---|
| 侧栏 | `runtime profiles refreshed {"agents":9}` 的 profile map + `recordTuiAgentDisplayNames` 写入的显示名 | 否 |
| TUI 下拉 | `data.location.agent.list()` 的缓存 | **是** |

`{"agents":9}` 与 `{"count":6}` 不是矛盾：前者是 profile map 的键总数（含历史键与 marketplace 别名键），后者是本次实际写入的 agent 数。

## 已排除项

| 猜测 | 结论 |
|---|---|
| 项目 `.opencode/node_modules/zod@4.1.8` 版本冲突 | 否。插件从 `~/.cache/opencode/npm/oh-my-opencode-slim@3.0.7/<hash>/node_modules` 加载，依赖自带 |
| preset `auto-ds-flash` 配置错误 | 否。插件日志明确注册了 6 个 agent |
| 多实例互相干扰 | 否。4 个窗口各自独立 location scope |
| 插件版本 bug | 否。3.0.6 / 3.0.7 均有，与版本无关 |

## 上游跟踪

### `anomalyco/opencode#63435` — 主 issue

`tui: agent catalog never recovers when the completing agent.updated has no location`

| 项 | 值 |
|---|---|
| 状态 | **OPEN** |
| 创建 | 2026-11-12 |
| 最后活动 | 2026-11-14（bot 已复现，打 `status/repro-simulated`） |
| 标签 | `type/bug`、`status/repro-simulated`、`area/tui`、`version/v2`、`platform/windows` |
| assignee / milestone | **均无**（未排期） |

评论时间线：

| 时间 | 作者 | 内容 |
|---|---|---|
| 11-12 02:42 | `opencodejr`(bot) | 用最小本地插件（4s 后注册 orchestrator）复现成功，最新 `dev`(f5ca39a) 仍有 |
| 11-12 04:15 | `dhairyajangir` | 指向 PR #57186，询问是否还需客户端兜底 |
| 11-14 02:52 | `mhenke`(slim 维护者) | 给出完整代码链，提出两个修法，确认插件侧无法自修 |

### `alvinunreal/oh-my-opencode-slim#1866` — 已关闭（NOT_PLANNED）

维护者 2026-11-14 关闭并转上游：

> The plugin-side path is confirmed as the trigger, but the fix sits in the host and client. … Closing this here so the work is tracked upstream.

**关闭原因是「转移到上游跟踪」，不是否决。** 若上游修好后仍复现，可 reopen。

### 相关修复 PR

| PR | 标题 | 状态 | 是否对症 |
|---|---|---|---|
| **#57186** | `fix(plugin-host-location-scope)` | **Draft**，`CONFLICTING/DIRTY`，0 review，最后提交 10-19 | **是**。改 `plugin/host.ts` 补 `Location.Service`，并给 `agent/command/integration/reference/skill/websearch` 六个 `State.create` notify 打 location |
| #56346 | `fix(core): scope plugin events to their location` | OPEN，非 Draft，停更 10-21 | 否。只修 `event.subscribe` 作用域，不覆盖 catalog notify |
| #56265 | `fix(server): wait for plugin activation before reading agents` | OPEN，非 Draft，停更 10-16 | 否。修的是「读 agent 太早返回部分列表」，属相邻竞态 |

`#57186` 是最对症的修复，但已与 `dev` 冲突且停更约 4 周，需要有人 rebase 并转正。

### 同源相邻 issue

`anomalyco/opencode#63192` — `tui: --prompt sessions start with build instead of default_agent when agents are still loading (2.2.7)`
OPEN + `reproduced`，最后更新 2026-11-11。同一个「冷 Location 时序」问题。

## 临时自救

按可靠性排序：

1. **切一次模型**（或新建会话）—— 会触发带 location 的 catalog 事件，目录自愈。
2. **在同一目录重开一个 TUI** —— 新实例冷启动路径正常。
3. **重启该 TUI 实例**。

注意：单纯等待不会恢复，因为 agent 列表内容不再变化后 `State.changes` 不再发布事件。

## 跟踪清单

- [ ] `#63435` 是否被 assign / 排入 milestone
- [ ] `#57186` 是否 rebase 并转为 Ready for review
- [ ] `#63435` 是否出现 linked PR
- [ ] `#63192` 是否与 `#63435` 合并处理
- [ ] 新版本（>2.3.0）发布后验证：`agent.updated` 是否稳定携带 `location.directory`
- [ ] 若上游修复落地但症状仍在，reopen `oh-my-opencode-slim#1866`

## 验证方法（下次复现时）

1. 记录插件日志中 `setup invoked` 与 `agents registered` 的时间差（>1s 即可能是 deferred 路径）。
2. 在 `opencode.log` 中搜索该时间窗内的 `agent.updated`，检查是否缺 `event.location.directory`。
3. 对比同一时间窗内 `provider.updated` / `model.updated` / `command.updated` 是否带目录。
4. 用同目录 API 交叉验证服务端目录是否完整：
   ```
   opencode api get '/api/agent?location[directory]=<URL 编码后的目录>'
   ```
   若返回含 `orchestrator`，说明服务端正常、问题在客户端缓存。

## 变更记录

| 日期 | 内容 |
|---|---|
| 2026-11-17 | 初版。记录本次 Windows 复现证据、根因链路、上游 issue/PR 状态与自救方案 |
