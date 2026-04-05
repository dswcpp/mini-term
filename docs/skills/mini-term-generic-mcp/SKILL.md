---
name: mini-term-generic-mcp
description: Use when a generic MCP client needs a conservative Mini-Term guide that prioritizes runtime observation, host-backed tool checks, tracked tasks, approvals, and review over IDE-specific assumptions.
---

# Mini-Term For Generic MCP

Use Mini-Term as a portable MCP control plane for local runtime truth.

## First calls

1. `ping`
2. `server_info`
3. `list_tools`
4. `list_workspaces`
5. `get_workspace_context`

Do not jump straight to file reads unless runtime observation is clearly irrelevant.

## Preferred sequence

1. Core runtime tools
2. Runtime observation tools
3. Host-backed PTY or UI tools only when host connection is confirmed
4. Task-management tools
5. Legacy compat tools as fallback

This matches Mini-Term's actual value: runtime observation, PTY or UI control, and tracked task orchestration.

## Host-backed rules

If `list_tools` says `requiresHostConnection=true`, verify the desktop host is connected before calling that tool.

Main host-backed areas:

- PTY detail and PTY control
- workspace, tab, and pane UI control
- user notifications

If the host is offline, return a clear blocked-state explanation.

## Approval and review

- Stop on `approvalRequired`.
- Resolve approval in Mini-Term, then retry with `approvalRequestId`.
- If tracked work changed files, use `get_git_summary` and `get_diff_for_review` before reporting outcomes.

## Setup note

- If the user is inside the Mini-Term desktop app, prefer its settings-page one-click injection flow when available.
- Otherwise use the exported MCP bundle or the documented stdio or HTTP config.
