---
name: mini-term-codex
description: Use when Codex should work through Mini-Term MCP for workspace truth, runtime observation, host-backed PTY or UI control, tracked task execution, approvals, and Git review handoff.
---

# Mini-Term For Codex

Use Mini-Term as Codex's runtime control plane, not as a generic file helper.

## Startup check

1. Call `ping`.
2. Call `server_info`.
3. Call `list_tools`.
4. If you need PTY or UI control, verify `server_info.hostConnection.status == "connected"` before using host-backed tools.

## Default tool order

1. `list_workspaces`
2. `get_workspace_context`
3. `list_ptys` or `get_recent_events` when runtime state matters
4. `get_pty_detail` or `get_process_tree` only when PTY summary is insufficient
5. `start_task` / `get_task_status` / `send_task_input` for tracked execution
6. `get_git_summary` / `get_diff_for_review` for review
7. `read_file` / `search_files` only when implementation detail is still missing

Mini-Term's value is runtime observation, PTY or UI control, and tracked tasks first. Legacy compat tools are fallback, not the main path.

## Host-backed rules

These tools require the desktop host to be online:

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

If `requiresHostConnection=true` and the host is unavailable, do not keep retrying blindly. Fall back to snapshot-only observation or tell the user what is blocked.

## Mini-Term-specific semantics

- `list_ptys` is a summary view; use `get_pty_detail` for retained output tail.
- Closing the last pane closes the whole terminal tab.
- Closing a terminal tab also closes its session chain.
- Dragging a file into a terminal writes the path text only; it does not upload the file.

## Approval and review

- Approval-gated tools may first return `approvalRequired=true`.
- Wait for Mini-Term approval and retry with `approvalRequestId`.
- If a tracked task changed files, inspect `get_git_summary` or `get_diff_for_review` before concluding.

## Codex setup note

- Preferred path: Mini-Term desktop `Settings -> MCP -> Inject into Codex`.
- If local Windows stdio startup is unstable, switch Codex to Mini-Term HTTP MCP manually at `http://127.0.0.1:8765/mcp`.
