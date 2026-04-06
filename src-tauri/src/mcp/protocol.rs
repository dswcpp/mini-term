use super::meta::{
    build_server_info_payload, host_mode, timestamp_ms, PROTOCOL_VERSION, SERVER_NAME,
};
use super::registry::{find_tool, tool_definitions};
use serde_json::{json, Value};
use std::io::{self, Read, Write};

fn response(id: Value, result: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    })
}

fn error_response(id: Value, code: i32, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message,
        }
    })
}

fn tool_meta(tool_name: &str, cursor: Option<String>) -> Value {
    json!({
        "toolName": tool_name,
        "timestamp": timestamp_ms(),
        "serverVersion": env!("CARGO_PKG_VERSION"),
        "protocolVersion": PROTOCOL_VERSION,
        "appVersion": build_server_info_payload()["appVersion"].clone(),
        "hostMode": host_mode(),
        "cursor": cursor,
    })
}

fn tool_success_envelope(tool_name: &str, data: Value) -> Value {
    let cursor = data
        .get("nextCursor")
        .and_then(Value::as_str)
        .map(str::to_string);
    json!({
        "ok": true,
        "data": data,
        "error": Value::Null,
        "meta": tool_meta(tool_name, cursor),
    })
}

fn tool_confirmation_envelope(tool_name: &str, result: Value) -> Value {
    let confirmation = result
        .get("approval")
        .and_then(|value| value.get("request"))
        .cloned()
        .or_else(|| result.get("request").cloned())
        .unwrap_or(Value::Null);

    json!({
        "ok": false,
        "status": result
            .get("status")
            .cloned()
            .unwrap_or_else(|| json!("approval-pending")),
        "data": Value::Null,
        "error": Value::Null,
        "meta": tool_meta(tool_name, None),
        "requiresConfirmation": true,
        "confirmation": confirmation.clone(),
        "approval": result.get("approval").cloned().unwrap_or_else(|| json!({
            "required": true,
            "request": confirmation,
        })),
        "action": result.get("action").cloned().unwrap_or(Value::Null),
        "blockingReason": result.get("blockingReason").cloned().unwrap_or(Value::Null),
        "retry": result.get("retry").cloned().unwrap_or(Value::Null),
    })
}

fn classify_tool_error(tool_name: &str, message: &str) -> (&'static str, bool) {
    let lower = message.to_ascii_lowercase();
    if lower.contains("workspace not found") {
        ("WORKSPACE_NOT_FOUND", false)
    } else if lower.contains("host connection unavailable")
        || lower.contains("host ui bridge timed out")
        || lower.contains("host control")
    {
        ("HOST_UNAVAILABLE", false)
    } else if lower.contains("pty not found") {
        ("PTY_NOT_FOUND", false)
    } else if lower.contains("pty root process is unavailable") {
        ("TASK_NOT_RUNNING", false)
    } else if lower.contains("task not found") {
        ("TASK_NOT_FOUND", false)
    } else if lower.contains("tab not found") {
        ("TAB_NOT_FOUND", false)
    } else if lower.contains("pane not found") {
        ("PANE_NOT_FOUND", false)
    } else if lower.contains("approval request not found") {
        ("APPROVAL_NOT_FOUND", false)
    } else if lower.contains("task is not running")
        || lower.contains("task is not interactive")
        || lower.contains("no longer running")
    {
        ("TASK_NOT_RUNNING", false)
    } else if lower.contains("patch is invalid")
        || lower.contains("patch must include")
        || lower.contains("defaultshell must match")
        || lower.contains("must be between")
        || lower.contains("must contain positive")
        || lower.contains("shell name must")
        || lower.contains("shell command must")
        || lower.contains("shell names must be unique")
    {
        ("CONFIG_VALIDATION_FAILED", false)
    } else if lower.contains("outside configured roots")
        || lower.contains("must stay inside the selected workspace")
        || lower.contains("must not escape the project path")
        || lower.contains("must be inside project path")
    {
        ("WORKSPACE_BOUNDARY_VIOLATION", false)
    } else if lower.contains("cursor not found") {
        if tool_name == "get_recent_events" {
            ("EVENT_CURSOR_INVALID", false)
        } else {
            ("INVALID_INPUT", false)
        }
    } else if lower.contains("shell not found") {
        ("INVALID_INPUT", false)
    } else if lower.contains("required")
        || lower.contains("invalid")
        || lower.contains("decision must be approved or rejected")
    {
        ("INVALID_INPUT", false)
    } else if lower.contains("approval") {
        ("CONFIRMATION_REQUIRED", false)
    } else if tool_name == "get_recent_events" {
        ("EVENT_CURSOR_INVALID", false)
    } else {
        ("INTERNAL_ERROR", true)
    }
}

fn tool_error_envelope(tool_name: &str, message: &str) -> Value {
    let (code, retryable) = classify_tool_error(tool_name, message);
    json!({
        "ok": false,
        "data": Value::Null,
        "error": {
            "code": code,
            "message": message,
            "retryable": retryable,
        },
        "meta": tool_meta(tool_name, None),
    })
}

fn tool_result(value: Value, is_error: bool) -> Value {
    json!({
        "content": [
            {
                "type": "text",
                "text": serde_json::to_string(&value).unwrap_or_else(|_| value.to_string()),
            }
        ],
        "structuredContent": value,
        "isError": is_error,
    })
}

/// Detect transport format from the first byte on stdin.
/// Returns `true` for NDJSON (Claude Code 2025-11-25+), `false` for Content-Length framing.
fn detect_ndjson<R: Read>(reader: &mut R, first_buf: &mut Vec<u8>) -> io::Result<bool> {
    let mut byte = [0u8; 1];
    if reader.read(&mut byte)? == 0 {
        return Ok(false);
    }
    first_buf.push(byte[0]);
    Ok(byte[0] == b'{')
}

fn read_message_ndjson<R: Read + ?Sized>(
    reader: &mut R,
    leftover: &mut Vec<u8>,
) -> io::Result<Option<Value>> {
    // Read until newline, carrying over any already-read bytes
    let mut line = std::mem::take(leftover);
    let mut byte = [0u8; 1];
    loop {
        if reader.read(&mut byte)? == 0 {
            if line.is_empty() {
                return Ok(None);
            }
            break;
        }
        if byte[0] == b'\n' {
            break;
        }
        line.push(byte[0]);
    }
    let trimmed = line.trim_ascii_end(); // strip trailing \r if any
    if trimmed.is_empty() {
        return Ok(None);
    }
    let value = serde_json::from_slice(trimmed)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
    Ok(Some(value))
}

fn read_message_framed<R: Read + ?Sized>(
    reader: &mut R,
    leftover: &mut Vec<u8>,
) -> io::Result<Option<Value>> {
    let mut header = std::mem::take(leftover);
    let mut byte = [0u8; 1];
    let mut content_length: Option<usize> = None;
    loop {
        if reader.read(&mut byte)? == 0 {
            return Ok(None);
        }
        header.push(byte[0]);
        if header.ends_with(b"\r\n\r\n") || header.ends_with(b"\n\n") {
            let header_text = String::from_utf8_lossy(&header);
            for line in header_text.lines() {
                let lower = line.to_ascii_lowercase();
                if let Some(value) = lower.strip_prefix("content-length:") {
                    content_length = value.trim().parse::<usize>().ok();
                }
            }
            break;
        }
    }
    let Some(content_length) = content_length else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "missing content-length",
        ));
    };
    let mut body = vec![0u8; content_length];
    reader.read_exact(&mut body)?;
    let value = serde_json::from_slice(&body)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
    Ok(Some(value))
}

fn write_message_ndjson<W: Write + ?Sized>(writer: &mut W, value: &Value) -> io::Result<()> {
    let mut body = serde_json::to_vec(value)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
    body.push(b'\n');
    writer.write_all(&body)?;
    writer.flush()
}

fn write_message_framed<W: Write + ?Sized>(writer: &mut W, value: &Value) -> io::Result<()> {
    let body = serde_json::to_vec(value)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
    write!(writer, "Content-Length: {}\r\n\r\n", body.len())?;
    writer.write_all(&body)?;
    writer.flush()
}

// Keep these aliases for the existing unit tests.
#[cfg(test)]
fn read_message<R: Read>(reader: &mut R) -> io::Result<Option<Value>> {
    read_message_framed(reader, &mut Vec::new())
}

#[cfg(test)]
fn write_message<W: Write>(writer: &mut W, value: &Value) -> io::Result<()> {
    write_message_framed(writer, value)
}

pub(crate) fn handle_json_rpc_request(message: Value) -> Value {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    match message.get("method").and_then(Value::as_str) {
        Some("initialize") => {
            // Echo back the client's requested protocol version if it's newer than ours,
            // otherwise use our own version.
            let client_version = message
                .get("params")
                .and_then(|p| p.get("protocolVersion"))
                .and_then(Value::as_str)
                .unwrap_or(PROTOCOL_VERSION);
            let negotiated = if client_version > PROTOCOL_VERSION {
                client_version
            } else {
                PROTOCOL_VERSION
            };
            response(
                id,
                json!({
                    "protocolVersion": negotiated,
                    "capabilities": {
                        "tools": {
                            "listChanged": false
                        }
                    },
                    "serverInfo": {
                        "name": SERVER_NAME,
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }),
            )
        }
        Some("notifications/initialized") => json!({}),
        Some("tools/list") => response(id, json!({ "tools": tool_definitions() })),
        Some("tools/call") => {
            let Some(params) = message.get("params") else {
                return error_response(id, -32602, "missing params");
            };
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return error_response(id, -32602, "missing tool name");
            };
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            match find_tool(name) {
                Some(tool) => match (tool.handler)(arguments) {
                    Ok(result) => {
                        let confirmation = result
                            .get("approvalRequired")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        let envelope = if confirmation {
                            tool_confirmation_envelope(tool.name, result)
                        } else {
                            tool_success_envelope(tool.name, result)
                        };
                        response(id, tool_result(envelope, false))
                    }
                    Err(message) => response(
                        id,
                        tool_result(tool_error_envelope(tool.name, &message), true),
                    ),
                },
                None => error_response(id, -32601, "unknown tool"),
            }
        }
        Some(_) => error_response(id, -32601, "method not supported"),
        None => error_response(id, -32600, "invalid request"),
    }
}

pub fn run_stdio_server() -> Result<(), String> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = stdin.lock();
    let mut writer = stdout.lock();

    // Auto-detect transport: peek first byte.
    // NDJSON (2025-11-25+) starts with '{'; Content-Length framing starts with 'C'.
    let mut leftover: Vec<u8> = Vec::new();
    let ndjson = detect_ndjson(&mut reader, &mut leftover).map_err(|e| e.to_string())?;

    let read_msg = |r: &mut dyn Read, buf: &mut Vec<u8>| -> io::Result<Option<Value>> {
        if ndjson {
            read_message_ndjson(r, buf)
        } else {
            read_message_framed(r, buf)
        }
    };
    let write_msg = |w: &mut dyn Write, v: &Value| -> io::Result<()> {
        if ndjson {
            write_message_ndjson(w, v)
        } else {
            write_message_framed(w, v)
        }
    };

    loop {
        let message =
            read_msg(&mut reader as &mut dyn Read, &mut leftover).map_err(|e| e.to_string())?;
        let Some(message) = message else {
            break;
        };

        if message.get("method").and_then(Value::as_str) == Some("notifications/initialized")
            && message.get("id").is_none()
        {
            continue;
        }

        let response = handle_json_rpc_request(message);
        if response != json!({}) {
            write_msg(&mut writer as &mut dyn Write, &response).map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::handle_json_rpc_request;
    use super::{classify_tool_error, read_message, write_message};
    use crate::mcp::tools::test_support::TestHarness;
    use serde_json::json;
    use std::io;

    #[test]
    fn initialize_returns_server_info() {
        let response = handle_json_rpc_request(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {}
        }));

        assert_eq!(response["result"]["serverInfo"]["name"], "mini-term-mcp");
        assert_eq!(
            response["result"]["protocolVersion"],
            super::PROTOCOL_VERSION
        );
    }

    #[test]
    fn tools_list_returns_stable_tool_count() {
        let response = handle_json_rpc_request(json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list"
        }));

        let count = response["result"]["tools"]
            .as_array()
            .map(|items| items.len())
            .unwrap_or(0);
        assert_eq!(count, 38, "expected exactly 38 tools, got {count}");
        let names = response["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|item| item.get("name").and_then(|value| value.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(
            names[..8],
            [
                "ping",
                "server_info",
                "list_tools",
                "list_workspaces",
                "get_workspace_context",
                "get_config",
                "list_ptys",
                "get_pty_detail",
            ]
        );
        assert!(response["result"]["tools"][0]["whenToUse"].is_string());
        let search_files = response["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["name"] == "search_files")
            .expect("search_files tool should be listed");
        assert_eq!(search_files["supportsPagination"], false);
        assert!(response["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["name"] == "get_pty_detail"));
        let get_pty_detail = response["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["name"] == "get_pty_detail")
            .expect("get_pty_detail tool should be listed");
        assert_eq!(get_pty_detail["requiresHostConnection"], true);
        assert_eq!(get_pty_detail["authorityScope"], "host-control");
        assert_eq!(get_pty_detail["degradationMode"], "snapshot-fallback");
        let set_config_fields = response["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["name"] == "set_config_fields")
            .expect("set_config_fields tool should be listed");
        assert_eq!(set_config_fields["group"], "ui-control");
        assert_eq!(set_config_fields["requiresHostConnection"], false);
        assert_eq!(set_config_fields["executionKind"], "mutate");
    }

    #[test]
    fn unknown_tool_returns_error() {
        let response = handle_json_rpc_request(json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "missing_tool",
                "arguments": {}
            }
        }));

        assert_eq!(response["error"]["message"], "unknown tool");
    }

    #[test]
    fn tool_call_without_params_returns_error() {
        let response = handle_json_rpc_request(json!({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call"
        }));

        assert_eq!(response["error"]["message"], "missing params");
    }

    #[test]
    fn ping_returns_wrapped_envelope() {
        let response = handle_json_rpc_request(json!({
            "jsonrpc": "2.0",
            "id": 5,
            "method": "tools/call",
            "params": {
                "name": "ping",
                "arguments": {}
            }
        }));

        assert_eq!(response["result"]["structuredContent"]["ok"], true);
        assert_eq!(
            response["result"]["structuredContent"]["data"]["status"],
            "ok"
        );
        assert_eq!(response["result"]["isError"], false);
    }

    #[test]
    fn confirmation_envelope_keeps_control_plane_action_fields() {
        let harness = TestHarness::new("protocol-confirmation-envelope");
        let response = handle_json_rpc_request(json!({
            "jsonrpc": "2.0",
            "id": 5,
            "method": "tools/call",
            "params": {
                "name": "write_file",
                "arguments": {
                    "path": format!("{}/notes.txt", harness.workspace_path()),
                    "content": "hello"
                }
            }
        }));

        assert_eq!(response["result"]["structuredContent"]["ok"], false);
        assert_eq!(
            response["result"]["structuredContent"]["status"],
            "approval-pending"
        );
        assert_eq!(
            response["result"]["structuredContent"]["requiresConfirmation"],
            true
        );
        assert_eq!(
            response["result"]["structuredContent"]["approval"]["required"],
            true
        );
        assert_eq!(
            response["result"]["structuredContent"]["action"]["toolName"],
            "write_file"
        );
        assert_eq!(
            response["result"]["structuredContent"]["action"]["degradationMode"],
            "approval-required"
        );
        assert_eq!(
            response["result"]["structuredContent"]["retry"]["allowed"],
            true
        );
    }

    #[test]
    fn git_diff_boundary_errors_are_not_internal() {
        let harness = TestHarness::new("protocol-git-diff-boundary");
        let response = handle_json_rpc_request(json!({
            "jsonrpc": "2.0",
            "id": 6,
            "method": "tools/call",
            "params": {
                "name": "get_diff_for_review",
                "arguments": {
                    "projectPath": harness.workspace_path(),
                    "filePath": "../secret.txt"
                }
            }
        }));

        assert_eq!(
            response["result"]["structuredContent"]["error"]["code"],
            "WORKSPACE_BOUNDARY_VIOLATION"
        );
        assert_eq!(
            response["result"]["structuredContent"]["error"]["retryable"],
            false
        );
        assert_eq!(response["result"]["isError"], true);
    }

    #[test]
    fn close_task_missing_is_classified_as_task_not_running() {
        let _harness = TestHarness::new("protocol-close-task-missing");
        let response = handle_json_rpc_request(json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "tools/call",
            "params": {
                "name": "close_task",
                "arguments": {
                    "taskId": "missing-task"
                }
            }
        }));
        assert_eq!(
            response["result"]["structuredContent"]["error"]["code"],
            "TASK_NOT_RUNNING"
        );
        assert_eq!(
            response["result"]["structuredContent"]["error"]["retryable"],
            false
        );
    }

    #[test]
    fn recent_events_bad_cursor_is_classified_as_event_cursor_invalid() {
        let _harness = TestHarness::new("protocol-events-bad-cursor");
        let response = handle_json_rpc_request(json!({
            "jsonrpc": "2.0",
            "id": 8,
            "method": "tools/call",
            "params": {
                "name": "get_recent_events",
                "arguments": {
                    "cursor": "missing-cursor"
                }
            }
        }));
        assert_eq!(
            response["result"]["structuredContent"]["error"]["code"],
            "EVENT_CURSOR_INVALID"
        );
        assert_eq!(response["result"]["isError"], true);
    }

    #[test]
    fn ai_sessions_bad_cursor_is_classified_as_invalid_input() {
        let _harness = TestHarness::new("protocol-ai-sessions-bad-cursor");
        let response = handle_json_rpc_request(json!({
            "jsonrpc": "2.0",
            "id": 9,
            "method": "tools/call",
            "params": {
                "name": "get_ai_sessions",
                "arguments": {
                    "cursor": "missing-cursor"
                }
            }
        }));
        assert_eq!(
            response["result"]["structuredContent"]["error"]["code"],
            "INVALID_INPUT"
        );
        assert_eq!(response["result"]["isError"], true);
    }

    // ── I/O framing ───────────────────────────────────────────────────────────

    #[test]
    fn read_message_parses_content_length_frame() {
        let body = b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}";
        let mut buf = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
        buf.extend_from_slice(body);
        let result = read_message(&mut buf.as_slice()).unwrap();
        assert_eq!(result.unwrap()["method"], "ping");
    }

    #[test]
    fn read_message_returns_error_on_missing_content_length() {
        let mut input = b"X-Custom: foo\r\n\r\n{}" as &[u8];
        let err = read_message(&mut input).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert!(err.to_string().contains("missing content-length"));
    }

    #[test]
    fn read_message_returns_none_on_eof() {
        let mut input: &[u8] = &[];
        assert!(read_message(&mut input).unwrap().is_none());
    }

    #[test]
    fn write_then_read_roundtrip_preserves_message() {
        let msg = json!({"jsonrpc": "2.0", "id": 1, "result": {"ok": true}});
        let mut buf = Vec::new();
        write_message(&mut buf, &msg).unwrap();
        let recovered = read_message(&mut buf.as_slice()).unwrap().unwrap();
        assert_eq!(recovered, msg);
    }

    #[test]
    fn read_message_handles_mixed_case_content_length_header() {
        let body = b"{}";
        let mut buf = format!("CONTENT-LENGTH: {}\r\n\r\n", body.len()).into_bytes();
        buf.extend_from_slice(body);
        let result = read_message(&mut buf.as_slice()).unwrap();
        assert!(result.is_some());
    }

    #[test]
    fn read_message_accepts_lf_only_header_separator() {
        let body = b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}";
        let mut buf = format!("Content-Length: {}\n\n", body.len()).into_bytes();
        buf.extend_from_slice(body);
        let result = read_message(&mut buf.as_slice()).unwrap();
        assert_eq!(result.unwrap()["method"], "initialize");
    }

    // ── Protocol edge cases ───────────────────────────────────────────────────

    #[test]
    fn unsupported_method_returns_minus_32601() {
        let response = handle_json_rpc_request(json!({
            "jsonrpc": "2.0",
            "id": 10,
            "method": "resources/list"
        }));
        assert_eq!(response["error"]["code"], -32601);
    }

    #[test]
    fn request_without_method_returns_invalid_request() {
        let response = handle_json_rpc_request(json!({ "jsonrpc": "2.0", "id": 11 }));
        assert_eq!(response["error"]["code"], -32600);
    }

    #[test]
    fn tool_call_missing_tool_name_returns_error() {
        let response = handle_json_rpc_request(json!({
            "jsonrpc": "2.0",
            "id": 12,
            "method": "tools/call",
            "params": { "arguments": {} }
        }));
        assert_eq!(response["error"]["message"], "missing tool name");
    }

    #[test]
    fn notification_without_id_is_silently_dropped() {
        // notifications/initialized with no id should return {} (skipped)
        let response = handle_json_rpc_request(json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        }));
        assert_eq!(response, json!({}));
    }

    // ── Error code classification (all branches) ──────────────────────────────

    #[test]
    fn error_classification_workspace_not_found() {
        let (code, retryable) = classify_tool_error("list_workspaces", "workspace not found: abc");
        assert_eq!(code, "WORKSPACE_NOT_FOUND");
        assert!(!retryable);
    }

    #[test]
    fn error_classification_pty_not_found() {
        let (code, retryable) = classify_tool_error("list_ptys", "pty not found: xyz");
        assert_eq!(code, "PTY_NOT_FOUND");
        assert!(!retryable);
    }

    #[test]
    fn error_classification_task_not_found() {
        let (code, retryable) = classify_tool_error("get_task_status", "task not found: task-99");
        assert_eq!(code, "TASK_NOT_FOUND");
        assert!(!retryable);
    }

    #[test]
    fn error_classification_approval_not_found() {
        let (code, retryable) =
            classify_tool_error("decide_approval_request", "approval request not found: r-1");
        assert_eq!(code, "APPROVAL_NOT_FOUND");
        assert!(!retryable);
    }

    #[test]
    fn error_classification_host_unavailable() {
        let (code, retryable) =
            classify_tool_error("get_pty_detail", "host connection unavailable");
        assert_eq!(code, "HOST_UNAVAILABLE");
        assert!(!retryable);
    }

    #[test]
    fn error_classification_task_not_running() {
        let (code, retryable) =
            classify_tool_error("send_task_input", "task is not interactive: task-1");
        assert_eq!(code, "TASK_NOT_RUNNING");
        assert!(!retryable);
    }

    #[test]
    fn error_classification_config_validation_failed() {
        let (code, retryable) =
            classify_tool_error("set_config_fields", "shell names must be unique");
        assert_eq!(code, "CONFIG_VALIDATION_FAILED");
        assert!(!retryable);
    }

    #[test]
    fn error_classification_internal_error_is_retryable() {
        // Any message that doesn't match a known pattern falls through to INTERNAL_ERROR.
        // This is the only branch where retryable == true.
        let (code, retryable) =
            classify_tool_error("start_task", "unexpected thread panic in runtime");
        assert_eq!(code, "INTERNAL_ERROR");
        assert!(
            retryable,
            "INTERNAL_ERROR must be the only retryable error code"
        );
    }

    // ── Envelope structure completeness ───────────────────────────────────────

    #[test]
    fn tool_success_envelope_contains_required_meta_fields() {
        let response = handle_json_rpc_request(json!({
            "jsonrpc": "2.0",
            "id": 20,
            "method": "tools/call",
            "params": { "name": "ping", "arguments": {} }
        }));
        let meta = &response["result"]["structuredContent"]["meta"];
        assert!(meta["toolName"].is_string(), "meta.toolName missing");
        assert!(meta["timestamp"].is_number(), "meta.timestamp missing");
        assert!(
            meta["serverVersion"].is_string(),
            "meta.serverVersion missing"
        );
        assert!(
            meta["protocolVersion"].is_string(),
            "meta.protocolVersion missing"
        );
        assert!(!meta["hostMode"].is_null(), "meta.hostMode missing");
    }

    #[test]
    fn tool_error_envelope_has_consistent_shape() {
        let _harness = TestHarness::new("protocol-error-shape");
        let response = handle_json_rpc_request(json!({
            "jsonrpc": "2.0",
            "id": 21,
            "method": "tools/call",
            "params": {
                "name": "close_task",
                "arguments": { "taskId": "no-such-task" }
            }
        }));
        let content = &response["result"]["structuredContent"];
        assert_eq!(content["ok"], false);
        assert!(content["data"].is_null());
        assert!(content["error"]["code"].is_string());
        assert!(content["error"]["retryable"].is_boolean());
        assert_eq!(response["result"]["isError"], true);
    }
}
