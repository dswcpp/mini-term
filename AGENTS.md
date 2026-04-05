# AGENTS.md

This file provides guidance to Codex when working with code in this repository.

## Project Overview

**mini-term** 是一个基于 Tauri v2 的桌面终端工作台，支持多工作区、多标签、分屏布局，并逐步演进为面向外部代理宿主的 MCP 控制面。

- 前端: React 19 + TypeScript + Tailwind CSS v4 + Vite
- 后端: Rust + Tauri v2
- 终端渲染: xterm.js v6
- 状态管理: Zustand
- 分屏布局: Allotment + 递归 SplitNode

## 开发命令

```bash
# 启动完整 Tauri 开发环境
npm run tauri dev

# 仅启动前端
npm run dev

# 启动 MCP server
npm run mcp

# 前端测试
npm test

# MCP 黑盒回归
npm run test:mcp

# 构建前端
npm run build

# 构建桌面应用
npm run tauri build

# Rust 测试
cargo test --manifest-path src-tauri/Cargo.toml
```

## 架构说明

### Rust 后端 (`src-tauri/src/`)

| 文件 | 职责 |
|---|---|
| `lib.rs` | Tauri app 初始化，注册 commands、plugins、运行时监控 |
| `pty.rs` | PTY 生命周期、输入输出跟踪、终端会话事件 |
| `process_monitor.rs` | AI 进程识别与 PTY 状态轮询 |
| `fs.rs` | 文件树读取、文件监听、fs-change 事件 |
| `config.rs` | `AppConfig` 持久化与兼容迁移 |
| `ai_sessions.rs` | Claude / Codex 历史会话读取 |
| `agent_core/*` | workspace context、task runtime、approval、task store |
| `mcp/*` | MCP protocol、registry、tool handlers |
| `runtime_mcp.rs` | 运行时快照持久化，供独立 MCP 进程读取 |

### 前端 (`src/`)

- `store.ts` 是唯一全局状态源，持有 workspace/tab/pane/layout 等运行时状态
- `TerminalArea.tsx` 负责 tab 与分屏终端宿主
- `SplitLayout.tsx` 负责递归渲染 pane tree
- `AgentInbox.tsx` 和任务面板负责 Agent task / approval UI

## PTY 数据流

```text
用户键入 -> xterm.onData -> invoke('write_pty') -> Rust writer
Rust reader -> emit('pty-output') -> term.write()
进程退出 -> emit('pty-exit') -> store 更新状态
进程监控 -> emit('pty-status-change') -> store 更新状态
运行时快照 -> 写入 app data -> mini-term-mcp 读取
```

## MCP 指南

- 本仓库可用的 MCP server 名称是 `mini-term-mcp`
- 标准启动方式是 `npm run mcp`
- 当前推荐代理优先使用这些 tools:
  - `ping`
  - `server_info`
  - `list_tools`
  - `list_ptys`
  - `list_fs_watches`
  - `get_recent_events`
  - `get_ai_sessions`
  - `get_config`
  - `set_config_fields`
- 这些工具属于兼容面，除非确实需要，不应作为默认优先路径:
  - `read_file`
  - `search_files`
  - `write_file`
  - `run_workspace_command`
- 不要通过 MCP 做这些事情:
  - 纯源码静态阅读
  - 代理自己已经具备的通用本地 shell 操作
  - 通用文件编辑，除非明确需要 Mini-Term 的审批/跟踪语义
- 对外部代理来说，Mini-Term 的 MCP 价值重点是运行时观测和高层控制，而不是重复文件系统能力

## 注意事项

- 文件拖拽到终端只会把路径文本写入 PTY，不会上传文件
- 自定义标题栏拖拽依赖 `WebkitAppRegion: 'drag'`，交互按钮需要 `no-drag`
- 关闭最后一个 pane 时会关闭整个 tab
- AI 进程识别通过检测子进程名中的 `codex` / `claude`
