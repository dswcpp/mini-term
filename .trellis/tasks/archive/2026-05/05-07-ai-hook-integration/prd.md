# feat: 接入 Claude Code / Codex Hook 事件系统

## Goal

将 Claude Code 和 Codex CLI 的官方 hook 事件系统接入 mini-term，替代当前纯进程轮询的 AI 状态检测方式，实现接近零延迟的精确 AI 状态感知。保留现有 process_monitor 作为 fallback。

## What I already know

* 当前 `process_monitor.rs` 每 500ms 轮询进程名 + 3s 输出超时判断 AI 状态，只有 idle / ai-working / ai-idle 三种状态
* Claude Code 支持 14+ hook 事件（command + http 两种类型），配置在 `~/.claude/settings.json`
* Codex CLI 支持 6 个 hook 事件（仅 command 类型），配置在 `~/.codex/hooks.json` + `~/.codex/config.toml` feature flag
* clawd-on-desk 项目已验证该方案可行，使用 Node.js hook 脚本 + 本地 HTTP 服务器
* mini-term 的 PTY 创建时可注入自定义环境变量用于关联

## Requirements

### R1: Rust HTTP 服务器
* Tauri 启动时在 Rust 端起一个轻量 HTTP 服务器监听 `127.0.0.1`
* 默认端口固定值，冲突时自动递增（最多尝试 5 个端口）
* 启动后将实际端口写入 `{app_data_dir}/hook-server.json`
* 提供 `POST /hook` 端点接收 hook 事件上报

### R2: Rust CLI 小工具（miniterm-hook）
* 独立二进制 `src-tauri/src/bin/miniterm-hook.rs`，Cargo `[[bin]]` 随 Tauri 一起编译
* 功能：读 stdin JSON payload → 读环境变量 `MINITERM_PTY_ID` → 读 `hook-server.json` 拿端口 → POST 到 HTTP 服务器
* 依赖最小化（serde_json + 标准库 TcpStream 或 ureq）
* 体积尽量小，冷启动快

### R3: PTY 环境变量注入
* `create_pty` 时注入 `MINITERM_PTY_ID={pty_id}` 到 PTY 进程环境
* 需实测验证 Claude Code / Codex 的 hook 子进程是否继承该环境变量
* 如不继承，fallback 到 payload 中的 `cwd` 字段匹配 project path

### R4: Hook 注册（设置界面）
* 设置 UI 提供"一键注册 Hook"/"卸载 Hook"按钮
* Claude Code: 读取 `~/.claude/settings.json`，合并 hook 条目，写回
* Codex: 读取 `~/.codex/hooks.json`，合并 hook 条目，写回；确保 `~/.codex/config.toml` 中 `[features] codex_hooks = true`
* 同时展示生成的配置片段，供高级用户手动粘贴
* 注册的 hook 命令指向 `miniterm-hook.exe` 的绝对路径

### R5: Hook 事件接入（11 个事件）
* Claude Code: SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SubagentStart, SubagentStop, PreCompact, PostCompact, PermissionRequest, Notification, Elicitation
* Codex: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, PermissionRequest

### R6: 状态映射
* UI 仅显示两种 AI 状态：
  - **ai-working**: UserPromptSubmit, PreToolUse, PostToolUse, SubagentStart, PreCompact, PostCompact
  - **ai-idle**: SessionStart, SessionEnd, Stop, PermissionRequest, Notification, Elicitation, SubagentStop
* Rust 端保留完整事件信息（event name, tool_name, session_id 等），供未来 UI 细化

### R7: 信号合并（Hook 优先 + 轮询降级）
* 当某个 PTY 在最近 30s 内收到过 hook 事件，以 hook 状态为准，忽略 process_monitor
* 超过 30s 无 hook 事件，降级回 process_monitor 轮询逻辑
* 未配置 hook 的用户体验不变

## Acceptance Criteria

* [ ] Tauri 启动后 HTTP 服务器正常监听，端口写入 hook-server.json
* [ ] miniterm-hook.exe 能正确读取 stdin、环境变量、端口文件并 POST
* [ ] 在 PTY 中运行 Claude Code，hook 事件能实时反映到 pane 状态
* [ ] 在 PTY 中运行 Codex CLI，hook 事件能实时反映到 pane 状态
* [ ] 设置界面可一键注册/卸载 hook，配置片段可复制
* [ ] 未配置 hook 时，process_monitor 轮询行为不变
* [ ] hook 活跃时状态更新接近零延迟（< 100ms）
* [ ] hook 超时 30s 后自动降级回轮询

## Definition of Done

* 编译通过（Rust + 前端）
* 手动验证 Claude Code + Codex hook 事件流程
* 现有 process_monitor 功能无回归

## Out of Scope

* Codex JSONL 日志轮询
* 其他 AI 工具（Gemini CLI、Copilot CLI 等）的 hook 支持
* 权限审批弹窗（仅标记 ai-idle 状态，不拦截/转发权限决策）
* settings.json 文件变化监控与自动修复
* UI 层展示细粒度状态（thinking / working / sweeping 等）

## Decision (ADR-lite)

**Context**: mini-term 当前通过 500ms 进程名轮询检测 AI 状态，延迟高、粒度粗。Claude Code 和 Codex 均提供官方 hook API，clawd-on-desk 项目已验证可行。

**Decision**: 接入 Claude Code + Codex 的 official command hooks，通过 Rust CLI 小工具 + 本地 HTTP 服务器实现事件上报。保留 process_monitor 作为 30s 超时降级。

**Consequences**:
* (+) 状态检测延迟从秒级降至接近零
* (+) 获得丰富的事件上下文（tool_name, session_id 等），为未来 UI 细化留空间
* (+) 进程轮询作为 fallback 保证向后兼容
* (-) 需要用户手动注册 hook（一键按钮降低门槛）
* (-) 依赖 Claude Code / Codex 的 hook API 稳定性
* (-) 新增独立二进制增加构建复杂度

## Technical Notes

* Claude Code hook 配置格式: `{ type: "command", command: "path/to/miniterm-hook.exe EventName" }`
* Codex hook 配置格式: `{ hooks: [{ type: "command", command: "...", timeout: 30 }] }`（多一层嵌套）
* Codex 需要 `config.toml` 中 `[features] codex_hooks = true`
* Codex PermissionRequest timeout 需设为 600s
* 参考实现: https://github.com/rullerzhou-afk/clawd-on-desk
* 研究文件: `.trellis/tasks/research-clawd-on-desk/research/`

## Research References

* [`research-clawd-on-desk/research/clawd-on-desk-architecture.md`](../research-clawd-on-desk/research/clawd-on-desk-architecture.md) — 项目整体架构与 AI 状态检测机制对比
* [`research-clawd-on-desk/research/codex-hook-registration.md`](../research-clawd-on-desk/research/codex-hook-registration.md) — Codex hooks 注册流程与 hooks.json 格式
* [`research-clawd-on-desk/research/codex-hook-processing.md`](../research-clawd-on-desk/research/codex-hook-processing.md) — codex-hook.js 处理逻辑与权限决策 stdout 格式
* [`research-clawd-on-desk/research/codex-agent-config.md`](../research-clawd-on-desk/research/codex-agent-config.md) — Codex agent 配置与双通道事件源设计
