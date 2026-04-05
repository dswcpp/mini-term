---
name: mini-term-maintainer
description: "Use when modifying Mini-Term itself: Tauri app wiring, React workspace or terminal UI, PTY lifecycle, host control bridge, MCP registry or handlers, task runtime, prompt policy, or related tests and docs."
---

# Mini-Term Maintainer

Use this skill when the task is about building, fixing, reviewing, or extending the Mini-Term codebase itself.

## First reads

1. `AGENTS.md`
2. `README.md`
3. Read only the most relevant deep doc:
   - `docs/MCP.md` for MCP surface, host-backed tools, and transport behavior
   - `docs/MCP_SETUP.md` for client injection and setup behavior
   - `docs/AGENT_POLICY_PROMPTS.md` for prompt or skill policy changes

## Code map

- Frontend workspace and terminal state:
  - `src/store.ts`
  - `src/components/TerminalArea.tsx`
  - `src/components/SplitLayout.tsx`
- Agent and settings UI:
  - `src/components/AgentInbox.tsx`
  - `src/components/AgentTaskPanelTabHost.tsx`
  - `src/components/settings/AgentSettings.tsx`
- Tauri runtime and PTY:
  - `src-tauri/src/lib.rs`
  - `src-tauri/src/pty.rs`
  - `src-tauri/src/process_monitor.rs`
- MCP and host control:
  - `src-tauri/src/mcp/*`
  - `src-tauri/src/runtime_mcp.rs`
  - `src-tauri/src/host_control.rs`
  - `src-tauri/src/mcp_host.rs`
- Agent task and approval runtime:
  - `src-tauri/src/agent_core/*`
  - `src-tauri/src/agent_api.rs`
  - `src-tauri/src/agent_policy.rs`

## Project-specific rules

- `store.ts` is the single frontend source of truth for workspace, tab, pane, and layout state.
- Do not rebuild tab or pane business logic inside MCP handlers; host-backed UI control should reuse desktop-host state transitions.
- `list_ptys` is summary-only. PTY detail belongs in `get_pty_detail` and `get_process_tree`.
- Closing the last pane closes the tab. Closing a terminal tab cascades through its session cleanup.
- Mini-Term MCP is mainly for runtime observation, PTY or UI control, and tracked tasks. Generic file operations are secondary.

## Working sequence

1. Identify whether the change is frontend, Rust runtime, MCP surface, or cross-layer.
2. Read the smallest set of files that owns that behavior.
3. Preserve existing state ownership boundaries instead of introducing duplicate caches or parallel logic.
4. When changing MCP behavior, check whether the same behavior also affects:
   - host control
   - runtime snapshot persistence
   - settings-page docs or injection UX
   - black-box MCP smoke tests

## Validation matrix

- Frontend-only UI change:
  - relevant `npm test -- <file>`
  - `npm run build`
- Rust or MCP handler change:
  - `cargo test --manifest-path src-tauri/Cargo.toml`
  - `npm run test:mcp`
  - `npm run test:mcp:http` if transport or server wiring changed
- PTY, task, or host control change:
  - targeted Rust tests first
  - then full Rust test or smoke path if behavior crosses process boundaries
- Docs-only or skill-only change:
  - no mandatory test, but keep paths and commands consistent with current code

## Windows-specific notes

- Codex on Windows may prefer Mini-Term HTTP MCP over local stdio when startup is flaky.
- PTY child startup can fail transiently on Windows before first output; do not confuse that with MCP transport failure.
- Host-backed tools require the desktop host to be online. If host control is unavailable, return a clear host-unavailable path instead of hiding the failure.
