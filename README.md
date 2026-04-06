<p align="center">
  <img src="src-tauri/icons/icon.png" width="128" height="128" alt="Mini-Term Logo">
</p>

<h1 align="center">Mini-Term</h1>

<p align="center">
  <strong>面向本地多工作区协作的桌面终端工作台 + MCP 控制面</strong><br>
  Tauri v2 · React 19 · Rust · Tracked Tasks · Approvals · Git Review
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.2.5-blue" alt="version">
  <img src="https://img.shields.io/badge/platform-Windows-lightgrey" alt="platform">
  <img src="https://img.shields.io/badge/Tauri-v2-orange" alt="tauri">
  <img src="https://img.shields.io/badge/React-19-61dafb" alt="react">
  <img src="https://img.shields.io/badge/Rust-2021-dea584" alt="rust">
</p>

---

## 项目定位

Mini-Term 不是单纯的桌面终端管理器，也不是一个孤立的 MCP server。

当前定位是：

- 本地多工作区桌面工作台
- 终端与 Git / 文件 / Workspace 上下文宿主
- Agent 任务工作台
- MCP 控制面
- 运行时 Prompt / Skill 策略注入中心

它一方面托管本地 `codex` / `claude` 任务，另一方面向外暴露稳定的 MCP 接口，供外部 Agent 或 MCP client 使用。

## 核心能力

### 桌面工作台

- 多工作区管理
- 多标签与递归分屏终端
- 文件树与 Git 状态感知
- AI session 历史读取
- Git diff / commit history 浏览

### Agent 任务工作台

- 启动并跟踪 `codex` / `claude` 任务
- 展示任务状态、attention、输出摘要、变更文件
- 支持补充输入、恢复会话、关闭任务
- 提供独立任务面板标签页
- 提供 `AgentInbox` 作为审批和高优先任务入口

### MCP Runtime

- 本地 stdio / HTTP MCP server
- 运行时观测、PTY 控制、UI 控制、任务管理、兼容层工具
- 工作区边界校验
- 审批门控
- 任务状态与 review attention 持久化

### Prompt / Skill 策略层

- `codex` / `claude` / `cursor` / `generic-mcp` 四类 profile
- 分层 Prompt 体系
- 任务启动时自动注入运行时策略
- 设置页可编辑、预览、导出、逐层重置

## MCP 工具分组

当前 MCP 工具固定为 6 个 group、37 个工具：

- `core-runtime` (3)
  - `ping`
  - `server_info`
  - `list_tools`
- `runtime-observation` (9)
  - `list_workspaces`
  - `get_workspace_context`
  - `get_config`
  - `list_ptys`
  - `get_pty_detail`
  - `get_process_tree`
  - `list_fs_watches`
  - `get_recent_events`
  - `get_ai_sessions`
- `pty-control` (4)
  - `create_pty`
  - `write_pty`
  - `resize_pty`
  - `kill_pty`
- `ui-control` (6)
  - `set_config_fields`
  - `focus_workspace`
  - `create_tab`
  - `close_tab`
  - `split_pane`
  - `notify_user`
- `task-management` (8)
  - `start_task`
  - `get_task_status`
  - `list_attention_tasks`
  - `resume_session`
  - `send_task_input`
  - `close_task`
  - `list_approval_requests`
  - `decide_approval_request`
- `legacy-compat` (7)
  - `read_file`
  - `search_files`
  - `get_git_summary`
  - `get_diff_for_review`
  - `write_file`
  - `run_workspace_command`
  - `list_ai_sessions`

`list_tools` 会额外暴露 `requiresHostConnection`，用来区分 snapshot-only 工具与依赖桌面宿主在线的 host-backed 工具。

## 推荐工作流

推荐工具顺序：

1. `list_workspaces`
2. `get_workspace_context`
3. `list_ptys` / `get_pty_detail` / `get_process_tree`
4. `read_file` / `search_files`
5. `get_git_summary` / `get_diff_for_review`
6. `start_task` / `get_task_status` / `send_task_input`

审批型动作默认流程：

1. 首次调用工具
2. 返回 `approvalRequired`
3. 在 Mini-Term Inbox 中审批
4. 通过后带 `approvalRequestId` 重试

## 界面概览

主要 UI 由四块组成：

- 工作区与文件侧边栏
- 终端与分屏标签区
- `AgentInbox` 摘要入口
- `Tasks` 独立任务工作台标签页

截图：

- ![主界面](docs/screenshots/main.png)
- ![设置页](docs/screenshots/settings.png)
- ![Git 集成](docs/screenshots/git.png)

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面宿主 | Tauri v2 |
| 前端 | React 19 + TypeScript + Tailwind CSS v4 + Vite 7 |
| 后端 | Rust 2021 |
| 终端 | xterm.js v6 |
| 状态管理 | Zustand |
| 分屏布局 | Allotment + 递归 SplitNode |
| PTY | portable-pty |
| Git | git2 |
| 文件监听 | notify + ignore |

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

## 文档

- [MCP 接入说明](docs/MCP_SETUP.md)
- [MCP 详细说明](docs/MCP.md)
- [Prompt 体系设计](docs/AGENT_POLICY_PROMPTS.md)
- [Codex Skill](docs/skills/mini-term-codex/SKILL.md)
- [Claude Skill](docs/skills/mini-term-claude/SKILL.md)
- [Cursor Skill](docs/skills/mini-term-cursor/SKILL.md)
- [Generic MCP Skill](docs/skills/mini-term-generic-mcp/SKILL.md)
- [Mini-Term Maintainer Skill](docs/skills/mini-term-maintainer/SKILL.md)
- [Mini-Term Troubleshooting Skill](docs/skills/mini-term-troubleshooting/SKILL.md)

## 架构概览

### Rust 后端

- `src-tauri/src/lib.rs`
  - Tauri app 初始化，注册 commands、plugins、运行时监控
- `src-tauri/src/pty.rs`
  - PTY 生命周期、输入输出跟踪、终端会话事件
- `src-tauri/src/process_monitor.rs`
  - AI 进程识别与 PTY 状态轮询
- `src-tauri/src/fs.rs`
  - 文件树读取、文件监听、fs-change 事件
- `src-tauri/src/config.rs`
  - `AppConfig` 持久化与兼容迁移
- `src-tauri/src/ai_sessions.rs`
  - Claude / Codex 历史会话读取
- `src-tauri/src/agent_core/*`
  - workspace context、task runtime、approval、task store
- `src-tauri/src/mcp/*`
  - MCP protocol、registry、tool handlers
- `src-tauri/src/runtime_mcp.rs`
  - 运行时快照持久化，供独立 MCP 进程读取
- `src-tauri/src/host_control.rs`
  - 宿主控制桥，支持 PTY 细节与 UI 控制转发

### 前端

- `src/store.ts`
  - 全局状态源
- `src/components/TerminalArea.tsx`
  - tab 与分屏终端宿主
- `src/components/SplitLayout.tsx`
  - 递归渲染 pane tree
- `src/components/AgentInbox.tsx`
  - 审批与 attention 摘要入口
- `src/components/AgentTaskPanelTabHost.tsx`
  - 完整任务工作台
- `src/components/settings/AgentSettings.tsx`
  - Prompt / Skill 策略设置页
- `src/hooks/useHostControlBridge.ts`
  - 宿主 UI 控制桥

## 设计原则

- Mini-Term 的 MCP / Agent 实现是仓库原生实现，不依赖额外外部宿主层
- MCP 工具暴露的是能力，不把提示词工程硬编码进工具 handler
- Prompt / Skill 采用分层治理，不依赖单一超大 system prompt
- Workspace override 只允许增强，不允许削弱审批、review、workspace context 规则

## 当前范围

当前已包含：

- MCP v1 工具集
- AgentInbox
- 任务工作台
- 审批流
- Prompt 分层设置与导出
- 宿主控制桥

当前明确不包含：

- 动态 skill marketplace
- memory / indexing / popup runtime
- 自动远程写入外部客户端配置
- 多 agent 编排和任务树

## 许可证

仓库当前未在本文件中单独声明许可证，请以项目实际发布信息为准。
