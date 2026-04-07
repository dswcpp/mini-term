# Mini-Term MCP

Mini-Term exposes two local MCP server entrypoints:

- `mini-term-mcp`
  - Transport: `stdio`
  - Recommended for embedded bridge use and local smoke tests
- `mini-term-mcp-http`
  - Transport: HTTP on `http://127.0.0.1:8765/mcp`
  - Recommended for Codex on Windows when the local stdio MCP host times out

## Why The HTTP Wrapper Exists

`mini-term-mcp` itself is healthy on Windows, but Codex's local Windows `stdio` MCP bridge can stall during startup even when the server answers correctly over manual stdio checks.

The workaround is to:

1. Start Mini-Term's HTTP wrapper locally
2. Point Codex at `http://127.0.0.1:8765/mcp`

This keeps Mini-Term's tool surface unchanged while avoiding the failing local stdio bridge path.

## Start Commands

From the repository root:

```powershell
npm run mcp
npm run mcp:http
```

Direct Cargo equivalents:

```powershell
cargo run --manifest-path src-tauri/Cargo.toml --bin mini-term-mcp
cargo run --manifest-path src-tauri/Cargo.toml --bin mini-term-mcp-http
```

Environment overrides for the HTTP wrapper:

```powershell
$env:MINI_TERM_MCP_HTTP_HOST = "127.0.0.1"
$env:MINI_TERM_MCP_HTTP_PORT = "8765"
```

## Codex Config

Recommended Windows config:

```toml
[mcp_servers.mini-term]
url = "http://127.0.0.1:8765/mcp"
```

Equivalent `.mcp.json` shape:

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

Non-Windows clients can still use `stdio` directly:

```json
{
  "mcpServers": {
    "mini-term": {
      "type": "stdio",
      "command": "cargo",
      "args": [
        "run",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "--bin",
        "mini-term-mcp"
      ]
    }
  }
}
```

## Protocol Surface

The HTTP wrapper reuses the same JSON-RPC tool handler as the stdio server.

- `POST /mcp`
  - Accepts MCP JSON-RPC requests
  - Returns JSON-RPC responses
  - Echoes or assigns `Mcp-Session-Id`
- `GET /health`
  - Returns a simple health JSON payload
- `GET /mcp` with `Accept: text/event-stream`
  - Returns an SSE keepalive stream placeholder

## Tool Groups

Mini-Term now exposes 39 tools across 6 fixed groups:

- `core-runtime` (3)
- `runtime-observation` (9)
- `pty-control` (4)
- `ui-control` (6)
- `task-management` (10)
- `legacy-compat` (7)

`list_tools` includes control-plane capability metadata so clients can distinguish the source of truth, operational risk, and failure mode of each tool before calling it.

Current metadata fields include:

- `requiresHostConnection`
- `authorityScope`
  - `control-plane`
  - `snapshot`
  - `host-control`
  - `task-runtime`
  - `filesystem-compat`
- `riskLevel`
  - `low`
  - `medium`
  - `high`
- `idempotency`
  - `idempotent`
  - `replay-unsafe`
- `executionKind`
  - `observe`
  - `mutate`
  - `control`
  - `start-long-running`
- `degradationMode`
  - `fail`
  - `snapshot-fallback`
  - `approval-required`
- `stateDependencies`
  - describes which runtime subsystem a tool depends on, such as `runtime-snapshot`, `host`, `task-runtime`, `approval-store`, or `workspace-files`

Host-backed tools are:

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

These tools require all of the following:

1. Mini-Term desktop host has written a fresh runtime snapshot
2. `server_info.hostConnection.status == "connected"`
3. `server_info.hostConnection.controlStatus == "ready"`
4. `server_info.hostConnection.hostControl` is present

If those conditions are not met, host-backed tools should be treated as unavailable and clients should fall back to snapshot-only observation.

## Runtime Authority Model

`server_info` now exposes both connection health and runtime authority summary:

- `hostConnection.status`
  - `connected`
  - `stale`
  - `unavailable`
- `hostConnection.controlStatus`
  - `ready`
  - `snapshot-only`
  - `unavailable`
- `runtime.stateOwner`
  - currently `desktop-host`
- `runtime.authorityModel`
  - currently `desktop-host-authoritative`
- `runtime.degradationMode`
  - `full-control`
  - `snapshot-only`
  - `stale-snapshot-only`
  - `unavailable`
- `runtime.summary`
  - PTY count
  - watcher count
  - recent event count
  - approval counts

External clients should treat `server_info` as the first authority handshake, not only as a version endpoint.

## Preferred Tool Sequence

For external agents, prioritize:

1. `ping`
2. `server_info`
3. `list_tools`
4. `list_workspaces`
5. `get_workspace_context`
6. `list_ptys`
7. `get_recent_events`
8. `get_config`
9. Host-backed PTY or UI tools only when `requiresHostConnection=true` and `server_info.hostConnection.controlStatus == "ready"`

Compatibility tools still exist, but they are not the default value proposition of Mini-Term MCP:

- `read_file`
- `search_files`
- `write_file`
- `run_workspace_command`

Mini-Term MCP is primarily for runtime observation, PTY/UI control, and task orchestration, not for reimplementing generic filesystem access an agent already has locally.

## Validation Coverage

Current repository validation now covers:

- Protocol layer
  - `initialize`
  - `tools/list`
  - framed stdio
  - HTTP JSON-RPC
- Runtime snapshot tools
  - `ping`
  - `server_info`
  - `list_tools`
  - `list_ptys`
  - `list_fs_watches`
  - `get_recent_events`
  - `get_ai_sessions`
  - `get_config`
  - `set_config_fields`
- Host-backed tools
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
- Task / approval tools
  - `start_task`
  - `spawn_worker`
  - `get_task_status`
  - `save_task_plan`
    - stores a Markdown plan document for a tracked task
  - `list_attention_tasks`
  - `resume_session`
  - `send_task_input`
  - `close_task`
  - `list_approval_requests`
  - `decide_approval_request`
- Compatibility tools
  - `read_file`
  - `search_files`
  - `get_git_summary`
  - `get_diff_for_review`
  - `write_file`
  - `run_workspace_command`
  - `list_ai_sessions`

Repository validation for this surface should include:

- Rust test suite:
  - `cargo test --manifest-path src-tauri/Cargo.toml`
- stdio smoke:
  - `cmd /c npm run test:mcp`
- HTTP smoke:
  - `cmd /c npm run test:mcp:http`

## Failure Semantics

Expected operational failure modes:

- `host connection unavailable`
  - no runtime snapshot
  - stale heartbeat
  - missing host control info
  - host control returned non-200
- host-backed business errors such as `tab not found`
  - returned from host control with HTTP 200 and surfaced to the tool caller
- approval-gated tools
  - first call may return `requiresConfirmation=true`
  - confirmation payload also includes `approval`, `action`, `blockingReason`, and `retry`
  - handler-level pending payloads still originate from `approvalRequired=true`
  - caller must retry with `approvalRequestId` after approval

## Windows Notes

Recommendations on Windows:

1. For Codex external MCP config, prefer HTTP:
   - `url = "http://127.0.0.1:8765/mcp"`
2. Keep embedded desktop bridge on stdio:
   - Mini-Term internal bridge still uses the stdio path
3. Treat task startup as slightly noisy:
   - Windows PTY child startup can occasionally fail before first output with `0xC0000142`
   - repository smoke tests already include bounded retry logic for this transient platform failure

This transient startup issue is distinct from MCP transport health. If `ping`, `server_info`, and host-backed observation tools succeed, the MCP server itself is healthy even if one task launch attempt fails and is retried.

## Validation

Rust tests:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib --bin mini-term-mcp
cargo test --manifest-path src-tauri/Cargo.toml --lib --bin mini-term-mcp-http
```

Black-box smoke tests:

```powershell
cmd /c npm run test:mcp
cmd /c npm run test:mcp:http
```

Frontend tests:

```powershell
cmd /c npm test
cmd /c npm run build
```
