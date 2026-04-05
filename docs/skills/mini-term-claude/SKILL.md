---
name: mini-term-claude
description: Use when Claude should work through Mini-Term MCP for workspace truth, runtime observation, tracked task control, approvals, host-backed PTY or UI operations, and review-oriented Git inspection.
---

# Mini-Term For Claude

Use Mini-Term as the authoritative control plane around local workspace state and tracked execution.

## Startup check

1. `ping`
2. `server_info`
3. `list_tools`
4. If PTY or UI actions are needed, verify host connection first

Keep explanations grounded in Mini-Term tool output, not editor assumptions.

## Default tool order

1. `list_workspaces`
2. `get_workspace_context` with the smallest useful preset
3. `list_ptys` / `get_recent_events` for runtime state
4. `get_pty_detail` / `get_process_tree` only when detail is required
5. `start_task`, then continue with `get_task_status`, `resume_session`, or `send_task_input`
6. `get_git_summary` / `get_diff_for_review` for evidence-backed review
7. `read_file` / `search_files` only when runtime data is not enough

## Host-backed rules

Treat these as desktop-host-only tools:

- `get_pty_detail`
- `get_process_tree`
- `create_pty`
- `write_pty`
- `resize_pty`
- `kill_pty`
- `focus_workspace`
- `create_tab`
- `close_tab`
- `split_pane`
- `notify_user`

If the host is offline, report that directly instead of collapsing the failure into a generic internal error story.

## Mini-Term-specific semantics

- `list_ptys` is intentionally lightweight.
- `get_pty_detail.outputTail` is retained history, not infinite replay.
- Use task tools when work should stay visible and resumable inside Mini-Term.
- Prefer continuing an existing tracked task over creating a duplicate.

## Approval and review

- Respect `approvalRequired` as a hard stop.
- Approval usually applies to `kill_pty`, `close_tab`, `close_task`, `write_file`, and `run_workspace_command`.
- If a task exits with changes, review is mandatory before summarizing.

## Claude setup note

- Preferred path: Mini-Term desktop `Settings -> MCP -> Inject into Claude`.
- This updates `~/.claude.json` and, when present, syncs `~/.claude/mcp-configs/mcp-servers.json`.
