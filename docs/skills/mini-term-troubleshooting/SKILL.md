---
name: mini-term-troubleshooting
description: Use when troubleshooting Mini-Term itself or its MCP integration, especially host unavailable errors, PTY issues, MCP injection failures, transport startup problems, approval flow confusion, or mismatches between runtime summary and detail tools.
---

# Mini-Term Troubleshooting

Use this skill for diagnosis before changing code or telling the user to retry.

## Fast triage order

1. `ping`
2. `server_info`
3. `list_tools`
4. `get_recent_events`
5. `list_ptys`

Then branch by symptom.

## Symptom: host unavailable

Check these in order:

1. `server_info.hostConnection.status`
2. whether host-backed tools report `requiresHostConnection=true`
3. whether the desktop app is actually running
4. whether runtime snapshot and heartbeat look fresh

Interpretation:

- If core runtime tools work but host-backed tools fail, the MCP server is alive and the desktop host path is the broken part.
- Do not treat this as a generic MCP crash unless `ping` or `server_info` also fail.

## Symptom: PTY summary looks wrong or incomplete

- `list_ptys` is summary only.
- Use `get_pty_detail` for retained output tail and process metadata.
- Use `get_process_tree` when you need to know what child processes are actually running.

If the host is offline, explain that PTY detail is blocked because those tools are host-backed.

## Symptom: MCP injected but client still does not work

For Codex:

- inspect `~/.codex/config.toml`
- verify `mcp_servers.mini-term` exists
- if Windows stdio startup is flaky, switch to Mini-Term HTTP MCP manually

For Claude:

- inspect `~/.claude.json`
- also inspect `~/.claude/mcp-configs/mcp-servers.json` when present
- verify the injected `mini-term` entry matches the current local launch path

If setup is stale, prefer Mini-Term desktop `Settings -> MCP` injection again instead of hand-editing from memory.

## Symptom: approval flow is stuck

- Approval-gated tools may first return only `approvalRequired=true`.
- Use `list_approval_requests`.
- Resolve through `decide_approval_request`.
- Retry the original tool with `approvalRequestId`.

Do not assume the first call failed semantically when it may only be waiting for approval.

## Symptom: task or review state is confusing

- Use `list_attention_tasks` first.
- Then inspect `get_task_status`.
- If files changed, use `get_git_summary` and `get_diff_for_review` before summarizing.

Tracked task confusion is often a state-visibility issue, not a runtime failure.

## Windows notes

- Codex on Windows may prefer Mini-Term HTTP MCP when stdio startup is noisy.
- A PTY child startup failure such as `0xC0000142` can be transient and is not by itself proof that MCP transport is broken.
- Separate transport health from task-launch health.
