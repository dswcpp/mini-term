---
name: mini-term-cursor
description: Use when Cursor should rely on Mini-Term MCP for workspace truth, runtime observation, tracked tasks, host-backed PTY or UI control, approvals, and review-aware local operations.
---

# Mini-Term For Cursor

Use Mini-Term when Cursor can see Mini-Term MCP tools and local runtime truth matters.

## Operating bias

- Prefer Mini-Term for current workspace, PTY, task, and review state.
- Treat editor buffers as helpful context, not proof of runtime truth.
- Prefer Mini-Term observation and task tools before generic filesystem access.

## Default tool order

1. `ping`, `server_info`, `list_tools`
2. `list_workspaces`
3. `get_workspace_context`
4. `list_ptys` / `get_recent_events`
5. host-backed PTY or UI tools only if host connection is online
6. `start_task` / `get_task_status` / `send_task_input`
7. `get_git_summary` / `get_diff_for_review`
8. `read_file` / `search_files` only when still needed

## Host-backed rules

Before calling any tool with `requiresHostConnection=true`, verify the desktop host is connected.

Typical host-backed tools:

- PTY detail and control
- workspace focus
- tab or pane creation and close
- UI notifications

If the host is unavailable, fall back to runtime snapshot tools and tell the user what action is blocked.

## Approval and review

- Approval-gated actions must wait for Mini-Term Inbox approval.
- Retry only after approval resolves.
- If changes exist, explain them from Mini-Term Git data, not from editor-local assumptions.

## Cursor setup note

- Use the Mini-Term exported MCP bundle or equivalent MCP client config.
- Prefer the same runtime sequence as Codex or Claude: observation first, control second, review before conclusion.
