# Mini-Term MCP Setup

See [docs/MCP.md](/D:/code/JavaScript/mini-term/docs/MCP.md) for the full reference.
This file keeps only the fast setup, verification, and troubleshooting path.

## Quick Start

If you are already inside the Mini-Term desktop app, open `Settings -> MCP` and use the one-click injection buttons first:

- `Inject into Codex`
  - writes `mini-term` into `~/.codex/config.toml`
- `Inject into Claude`
  - writes `mini-term` into `~/.claude.json`
  - also syncs `~/.claude/mcp-configs/mcp-servers.json` when the Claude directory exists

After injection, reopen the client and verify `ping`, `server_info`, and `list_tools`.

From the repo root:

```powershell
npm run mcp
npm run mcp:http
```

Meaning:

- `npm run mcp`
  - starts `mini-term-mcp`
  - transport: `stdio`
- `npm run mcp:http`
  - starts `mini-term-mcp-http`
  - default endpoint: `http://127.0.0.1:8765/mcp`

## Windows Recommendation

If the local Windows `stdio` MCP bridge is unstable, prefer HTTP:

```toml
[mcp_servers.mini-term]
url = "http://127.0.0.1:8765/mcp"
```

Equivalent `.mcp.json`:

```json
{
  "mcpServers": {
    "mini-term": {
      "type": "http",
      "url": "http://127.0.0.1:8765/mcp"
    }
  }
}
```

Non-Windows or embedded bridge users can keep using `stdio`.

## Quick Verification

Recommended minimum check order:

1. `ping`
2. `server_info`
3. `list_tools`
4. `list_workspaces`
5. `get_workspace_context`

If you want host-backed tools, also verify:

1. `server_info.hostConnection.status == "connected"`
2. `server_info.hostConnection.hostControl` is present

## Host-Backed Tools

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

If `list_tools` reports `requiresHostConnection=true`, do not call that tool while the host is unavailable.

## Approval Flow

These operations may first return an approval request:

- `kill_pty`
- `close_tab`
- `close_task`
- `write_file`
- `run_workspace_command`

Normal flow:

1. Call the tool once
2. Receive `approvalRequired=true`
3. Use `list_approval_requests` / `decide_approval_request`
4. Retry the original call with `approvalRequestId`

## Regression Commands

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib --bin mini-term-mcp --bin mini-term-mcp-http
cmd /c npm run test:mcp
cmd /c npm run test:mcp:http
cmd /c npm run build
```

## Troubleshooting

If you see `host connection unavailable`, check:

- no runtime snapshot was written
- heartbeat is stale
- host control info is missing
- host control endpoint is unreachable
- host control returned non-200

If Windows task startup fails with `0xC0000142` or `-1073741502`, that is usually a transient PTY child-process startup issue, not proof that MCP transport is broken.
Check `ping`, `server_info`, and `list_tools` first.
