# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**mini-term** — 一个基于 Tauri v2 的桌面终端工作台，支持多项目、多标签、分屏布局、AI 进程（Claude/Codex）状态感知，并通过 cc-connect/MCP 逐步扩展为外部代理控制面。

- **前端**: React 19 + TypeScript + Tailwind CSS v4 + Vite
- **后端**: Rust (Tauri v2)，使用 `portable-pty` 管理 PTY
- **终端渲染**: xterm.js v6（WebGL addon，自动降级为 Canvas）
- **状态管理**: Zustand（全局单一 store）
- **布局分割**: Allotment（三栏主布局）+ 递归 SplitNode 树（分屏终端）

## 开发命令

```bash
# 启动完整 Tauri 开发环境（前端 + 后端一起）
npm run tauri dev

# 仅启动 Vite 前端（无后端，Tauri API 不可用）
npm run dev

# 构建发布包（自动按 release profile staging sidecar）
npm run tauri build

# 仅 staging sidecar（调试构建链时使用）
npm run build-sidecars

# 仅构建前端
npm run build

# Rust 单元测试（在 src-tauri/ 目录下运行）
cd src-tauri && cargo test
```

## 架构说明

### Rust 后端 (`src-tauri/src/`)

| 文件 | 职责 |
|------|------|
| `lib.rs` | Tauri app 初始化，注册所有 command、plugin、运行时监控 |
| `pty.rs` | PTY 生命周期管理（create/write/resize/kill）；16ms 批量缓冲后通过 `pty-output` 事件推送数据 |
| `process_monitor.rs` | 后台线程每 500ms 轮询子进程名，识别 idle/running/ai-working 状态，通过 `pty-status-change` 事件通知前端 |
| `config.rs` | `AppConfig` 持久化到 `{app_data_dir}/config.json`；提供跨平台预置 shell 列表 |
| `fs.rs` | 目录列表（过滤 `.gitignore`）+ `notify` 文件监听，通过 `fs-change` 事件通知前端 |
| `ai_sessions.rs` | 读取 Claude/Codex 历史会话记录 |
| `cc_connect.rs` | cc-connect Management API、进程启停、项目导入/移除 |
| `runtime_mcp.rs` | 持久化运行时快照，供独立 MCP 进程读取 |
| `mcp/*` | MCP protocol、registry、tool handlers |

**Tauri Commands**: `load_config`, `save_config`, `create_pty`, `write_pty`, `resize_pty`, `kill_pty`, `list_directory`, `watch_directory`, `unwatch_directory`, `get_ai_sessions`，以及 `cc_connect_*` 系列命令。

**Tauri Events（后端→前端）**: `pty-output`, `pty-exit`, `pty-status-change`, `fs-change`

### 前端 (`src/`)

**数据流**：
- `store.ts` 是唯一全局状态，用 `Map<projectId, ProjectState>` 存储每个项目的 tabs
- 每个 Tab 的终端区域是一棵 `SplitNode` 树（leaf = 单个 pane，split = 横/纵分屏）
- `PaneStatus` 优先级：`error > ai-working > ai-idle > idle`，从叶节点聚合到 Tab 级别
- `workspaceOverview` 是运行时派生快照，由 `useWorkspaceOverview` 后台 60s 刷新、总览打开即时刷新、手动按钮刷新；不要持久化快照本身

**关键组件**：

| 组件 | 职责 |
|------|------|
| `App.tsx` | 三栏 Allotment 主布局（ProjectList \| FileTree \| TerminalArea + AIHistoryPanel） |
| `OverviewPanel.tsx` | 工作区总览，聚合项目健康、终端/AI 活动、Git 变更、cc-connect 状态和最近通知 |
| `TerminalArea.tsx` | Tab 管理 + 分屏逻辑（`insertSplit`/`removePane` 操作 SplitNode 树） |
| `SplitLayout.tsx` | 递归渲染 SplitNode 树，使用 Allotment 实现可拖拽分屏 |
| `TerminalInstance.tsx` | xterm.js 终端实例，WebGL 渲染，ResizeObserver 自适应，文件拖拽插入路径 |
| `TerminalConfigModal.tsx` | 终端配置 modal（shell 列表管理） |
| `CcConnectModal.tsx` | cc-connect 进程管理、项目导入和 Dashboard 入口 |

**类型系统** (`src/types.ts`): 前端所有类型定义，与后端 Rust 结构通过 `serde(rename_all = "camelCase")` 对齐。

**cc-connect 前端边界**：组件和 hooks 不直接调用 `cc_connect_*` Tauri command；统一走 `src/utils/ccConnectApi.ts`。默认配置、默认可执行文件和 `config.ccConnect` 保存回滚统一在 `src/utils/ccConnectConfig.ts`。

### PTY 数据流

```
用户键入 → xterm.onData → invoke('write_pty') → Rust writer
Rust reader → 16ms 批量缓冲 → emit('pty-output') → term.write()
进程退出 → emit('pty-exit') → store.updatePaneStatusByPty('error')
进程监控 → emit('pty-status-change') → store.updatePaneStatusByPty(status)
```

## 注意事项

- 文件拖拽到终端会将文件路径作为文本写入 PTY（不是上传文件）
- `WebkitAppRegion: 'drag'` 用于自定义标题栏拖拽，菜单项需设置 `no-drag` 区域
- 分屏关闭最后一个 pane 时会关闭整个 tab（`removePane` 返回 `null` 时触发）
- AI 进程识别通过检测子进程名包含 `claude` 或 `codex` 实现（`process_monitor.rs`）
- cc-connect 可执行文件路径留空时，后端优先使用随包内置的 Windows `cc-connect.exe` sidecar，再回退 PATH。
- `npm run tauri dev/build` 通过 `scripts/tauri.mjs` 自动 staging sidecar；CI release 仍直接调用 `scripts/stage-sidecars.mjs --release --target ...`。
