# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**mini-term** — 一个基于 Tauri v2 的桌面终端工作台，支持多项目、多标签、递归分屏、AI 进程（Claude/Codex）状态感知、SSH MCP 工具与自托管移动端中转。

- **前端**: React 19 + TypeScript + Tailwind CSS v4 + Vite
- **后端**: Rust (Tauri v2)，使用 `portable-pty` 管理 PTY
- **终端渲染**: xterm.js v6（WebGL addon，自动降级为 Canvas）
- **状态管理**: Zustand（全局单一 store）
- **布局分割**: Allotment（可折叠中间栏 + 终端主区）+ 递归 `SplitNode` 树（终端分屏）+ 浮动 `RightDrawer`

## 开发命令

```bash
# 启动完整 Tauri 开发环境（前端 + 后端一起）
npm run tauri dev

# 仅启动 Vite 前端（无后端，Tauri API 不可用）
npm run dev

# 构建发布包
npm run tauri build

# 单独构建并 staging sidecar（miniterm-hook / mt-ssh-mcp）
npm run build-sidecars

# 仅构建前端
npm run build

# Rust 单元测试（在 src-tauri/ 目录下运行）
cd src-tauri && cargo test
```

## 架构说明

### Rust 后端 (`src-tauri/`)

| 文件 | 职责 |
|------|------|
| `src/lib.rs` | Tauri app 初始化，注册 command、plugin 与运行时监控 |
| `src/pty.rs` | PTY 生命周期管理（create/write/resize/kill）；16ms 批量缓冲后通过 `pty-output` 事件推送数据 |
| `src/process_monitor.rs` | Hook 状态优先；未启用 Hook 时按 AI 子进程和输出活跃度降级判断 `idle` / `ai-idle` / `ai-working`，有 PTY 时每 500ms 轮询 |
| `src/config.rs` | `AppConfig` 持久化到 `{app_data_dir}/config.json`；提供跨平台预置 shell 列表 |
| `src/fs.rs` | 目录列表（过滤 `.gitignore`）+ `notify` 文件监听，通过 `fs-change` 事件通知前端 |
| `src/ai_sessions.rs` | 读取 Claude/Codex 历史会话记录 |
| `src/mobile_relay.rs` | 移动端中转体系：对中转服务器的出站 WSS 长连（带桌面端密钥握手、指数退避重连）、配对码/重置配对、项目快照与项目级增量、镜像订阅管理、移动端指令写穿 PTY、移动端发起会话的校验与派发、移动端改会话名的标题收敛 |
| `src/mobile_mirror.rs` | 对话镜像：pane → 项目最新会话 JSONL 的增量解析（半行拼接）、分页取数 |
| `mt-ssh/` | 主程序与 sidecar 共用的 SSH crate：持久会话池、命令执行与 SFTP 原语 |
| `mt-sidecars/` | 独立 sidecar crate：`miniterm-hook` 与 `mt-ssh-mcp` |

**Tauri Commands**: `load_config`, `save_config`, `create_pty`, `write_pty`, `resize_pty`, `kill_pty`, `list_directory`, `watch_directory`, `unwatch_directory`, `get_ai_sessions`, `mobile_relay_apply`, `mobile_relay_status`, `mobile_relay_request_pairing_code`, `mobile_relay_reset_pairing`, `mobile_relay_update_sessions`, `mobile_relay_launchers_changed`, `mobile_relay_start_session_result`, `mobile_relay_check_launcher_command`

**Tauri Events（后端→前端）**: `pty-output`, `pty-exit`, `pty-status-change`, `ai-user-submit`, `fs-change`, `search-results`, `search-complete`, `wsl-shell-override`, `mobile-relay-status`, `mobile-relay-pairing-code`, `mobile-start-session`, `mobile-rename-pane`

### 移动端中转体系（`relay-server/` + `mobile/`）

- `relay-server/protocol`：桌面端与中转共享的协议消息 crate（JSON over WebSocket，serde camelCase，带版本号握手校验，当前 v2）；PWA 侧 TypeScript 类型在 `mobile/src/protocol.ts` 手写镜像，两侧字段必须同步维护
- `relay-server/server`：axum 中转服务，只做转发不落盘；桌面端接入需携带 `MT_RELAY_DESKTOP_KEY`（未配置即拒绝一切桌面连接，fail-closed）；`cd relay-server && cargo test` 跑 Seam 1 协议边界测试
- `mobile/`：React + TS + Vite PWA（扫码配对、会话列表、对话镜像、移动端指令、发起新 AI 会话、会话重命名）；`cd mobile && npm run build` 构建，产物由中转托管；部署见 `docs/deploy-relay.zh-CN.md`（英文版 `docs/deploy-relay.md`）
- **AI 启动器**：桌面端配置的具名 `{名称, shell?, 命令}`，移动端只按 id 引用、看得到名字，命令文本从不经过移动端或中转（ADR 0002 的边界）

### 前端 (`src/`)

**数据流**：
- `store.ts` 是唯一全局状态，用 `Map<projectId, ProjectState>` 存储每个项目的 tabs
- 每个 Tab 的终端区域是一棵 `SplitNode` 树（leaf = 单个 pane，split = 横/纵分屏）
- `PaneStatus` 优先级：`error > ai-working > ai-idle > idle`，从叶节点聚合到 Tab 和项目级别

**关键组件**：

| 组件 | 职责 |
|------|------|
| `App.tsx` | ActivityBar + Allotment 主布局、全局事件注册、配置加载与项目终端保活 |
| `ActivityBar.tsx` | 中间栏、Sessions、Git、设置、SSH 与移动端入口 |
| `RightDrawer.tsx` | 浮在终端上的 Sessions / Git 互斥抽屉，宽度可拖拽并持久化 |
| `TerminalArea.tsx` | Tab 管理 + 分屏逻辑（`insertSplit`/`removePane` 操作 SplitNode 树） |
| `SplitLayout.tsx` | 递归渲染 SplitNode 树，使用 Allotment 实现可拖拽分屏 |
| `TerminalInstance.tsx` | xterm.js 终端实例，WebGL 渲染，ResizeObserver 自适应，文件拖拽插入路径 |
| `SettingsModal.tsx` | 分页设置面板（终端、外观、通知、Hook 等） |
| `MobileRelayModal.tsx` | 「移动端」面板：中转地址 + 桌面端密钥、连接状态、配对二维码、AI 启动器 |
| `AiLauncherSection.tsx` | AI 启动器增删改（名称 / shell / 命令 + 命令识别警告），嵌在「移动端」面板 |

**类型系统** (`src/types.ts`): 前端所有类型定义，与后端 Rust 结构通过 `serde(rename_all = "camelCase")` 对齐。

### PTY 数据流

```
用户键入 → xterm.onData → invoke('write_pty') → Rust writer
Rust reader → 16ms 批量缓冲 → emit('pty-output') → term.write()
进程退出 → emit('pty-exit') → store.updatePaneStatusByPty('error')
Hook / 进程监控 → emit('pty-status-change') → store.updatePaneStatusByPty(status)
```

## 注意事项

- 文件拖拽到终端会将文件路径作为文本写入 PTY（不是上传文件）
- `WebkitAppRegion: 'drag'` 用于自定义标题栏拖拽，菜单项需设置 `no-drag` 区域
- 分屏关闭最后一个 pane 时会关闭整个 tab（`removePane` 返回 `null` 时触发）
- AI 状态优先由 Claude/Codex Hook 上报；未启用 Hook 时才通过 AI 子进程和输出活跃度降级判断
- `miniterm-hook` 与 `mt-ssh-mcp` 位于独立 `mt-sidecars` crate；`npm run tauri ...` 的 `pretauri` hook 会先执行 `npm run build-sidecars`，release CI 则显式调用 `scripts/stage-sidecars.mjs --release --target ...`
