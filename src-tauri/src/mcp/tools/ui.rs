use crate::agent_core::data_dir::config_path;
use crate::agent_core::models::ApprovalRiskLevel;
use crate::agent_core::task_runtime::{mark_approval_executed, request_or_validate_approval};
use crate::agent_core::workspace_context::validate_task_working_directory;
use crate::config::load_config_from_path;
use crate::host_control::call_host_control;
use serde_json::{json, Value};

fn approval_pending_value(result: crate::agent_core::models::PendingApprovalResult) -> Value {
    json!({
        "approvalRequired": result.approval_required,
        "request": result.request,
    })
}

fn workspace_exists(workspace_id: &str) -> Result<(), String> {
    let config = load_config_from_path(&config_path());
    if config
        .workspaces
        .iter()
        .any(|workspace| workspace.id == workspace_id)
    {
        Ok(())
    } else {
        Err(format!("workspace not found: {workspace_id}"))
    }
}

fn shell_exists(shell_name: &str) -> Result<(), String> {
    let config = load_config_from_path(&config_path());
    if config
        .available_shells
        .iter()
        .any(|shell| shell.name == shell_name)
    {
        Ok(())
    } else {
        Err(format!("shell not found: {shell_name}"))
    }
}

pub fn focus_workspace_tool(args: Value) -> Result<Value, String> {
    let object = args.as_object().cloned().unwrap_or_default();
    let workspace_id = object
        .get("workspaceId")
        .and_then(Value::as_str)
        .ok_or("workspaceId is required")?;
    workspace_exists(workspace_id)?;
    call_host_control("focus_workspace", json!({ "workspaceId": workspace_id }))
}

pub fn create_tab_tool(args: Value) -> Result<Value, String> {
    let object = args.as_object().cloned().unwrap_or_default();
    let workspace_id = object
        .get("workspaceId")
        .and_then(Value::as_str)
        .ok_or("workspaceId is required")?;
    let cwd = object.get("cwd").and_then(Value::as_str);
    let shell_name = object.get("shellName").and_then(Value::as_str);
    let activate = object.get("activate").and_then(Value::as_bool);

    if let Some(shell_name) = shell_name {
        shell_exists(shell_name)?;
    }
    let validated = validate_task_working_directory(workspace_id, cwd)?;
    call_host_control(
        "create_tab",
        json!({
            "workspaceId": validated.workspace_id,
            "cwd": validated.cwd,
            "shellName": shell_name,
            "activate": activate,
        }),
    )
}

pub fn close_tab_tool(args: Value) -> Result<Value, String> {
    let object = args.as_object().cloned().unwrap_or_default();
    let workspace_id = object
        .get("workspaceId")
        .and_then(Value::as_str)
        .ok_or("workspaceId is required")?;
    let tab_id = object
        .get("tabId")
        .and_then(Value::as_str)
        .ok_or("tabId is required")?;
    workspace_exists(workspace_id)?;
    let approval_request_id = object.get("approvalRequestId").and_then(Value::as_str);

    let approval = match request_or_validate_approval(
        approval_request_id,
        "close_tab",
        "Closing a tab may terminate terminal sessions and discard transient UI state.",
        ApprovalRiskLevel::High,
        format!("Workspace: {workspace_id}\nTab: {tab_id}"),
    ) {
        Ok(approval) => approval,
        Err(pending) => return Ok(approval_pending_value(pending)),
    };

    let result = call_host_control(
        "close_tab",
        json!({
            "workspaceId": workspace_id,
            "tabId": tab_id,
        }),
    )?;
    mark_approval_executed(&approval.request_id);
    Ok(result)
}

pub fn split_pane_tool(args: Value) -> Result<Value, String> {
    let object = args.as_object().cloned().unwrap_or_default();
    let workspace_id = object
        .get("workspaceId")
        .and_then(Value::as_str)
        .ok_or("workspaceId is required")?;
    let tab_id = object
        .get("tabId")
        .and_then(Value::as_str)
        .ok_or("tabId is required")?;
    let pane_id = object
        .get("paneId")
        .and_then(Value::as_str)
        .ok_or("paneId is required")?;
    let direction = object
        .get("direction")
        .and_then(Value::as_str)
        .ok_or("direction is required")?;
    if !matches!(direction, "horizontal" | "vertical") {
        return Err("direction is invalid".to_string());
    }

    let cwd = object.get("cwd").and_then(Value::as_str);
    let shell_name = object.get("shellName").and_then(Value::as_str);
    let activate = object.get("activate").and_then(Value::as_bool);
    if let Some(shell_name) = shell_name {
        shell_exists(shell_name)?;
    }
    let validated = validate_task_working_directory(workspace_id, cwd)?;

    call_host_control(
        "split_pane",
        json!({
            "workspaceId": validated.workspace_id,
            "tabId": tab_id,
            "paneId": pane_id,
            "direction": direction,
            "cwd": validated.cwd,
            "shellName": shell_name,
            "activate": activate,
        }),
    )
}

pub fn notify_user_tool(args: Value) -> Result<Value, String> {
    let object = args.as_object().cloned().unwrap_or_default();
    let message = object
        .get("message")
        .and_then(Value::as_str)
        .ok_or("message is required")?;
    if message.trim().is_empty() {
        return Err("message is required".to_string());
    }
    let tone = object.get("tone").and_then(Value::as_str);
    if let Some(tone) = tone {
        if !matches!(tone, "info" | "success" | "error") {
            return Err("tone is invalid".to_string());
        }
    }
    let duration_ms = object.get("durationMs").and_then(Value::as_u64);
    call_host_control(
        "notify_user",
        json!({
            "message": message,
            "tone": tone,
            "durationMs": duration_ms,
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::tools::tasks::decide_approval_request_tool;
    use crate::mcp::tools::test_support::TestHarness;
    use crate::runtime_mcp;
    use serde_json::{json, Value};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};
    use std::thread;

    fn start_mock_host_server() -> (String, Arc<Mutex<Vec<(String, Value)>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::<(String, Value)>::new()));
        let recorded = Arc::clone(&requests);

        thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = match stream {
                    Ok(stream) => stream,
                    Err(_) => break,
                };
                let mut buffer = Vec::new();
                let mut temp = [0u8; 4096];
                let header_end = loop {
                    let read = stream.read(&mut temp).unwrap();
                    if read == 0 {
                        return;
                    }
                    buffer.extend_from_slice(&temp[..read]);
                    if let Some(index) = buffer.windows(4).position(|window| window == b"\r\n\r\n")
                    {
                        break index;
                    }
                };
                let header_text = String::from_utf8(buffer[..header_end].to_vec()).unwrap();
                let content_length = header_text
                    .lines()
                    .find_map(|line| {
                        line.split_once(':').and_then(|(name, value)| {
                            if name.eq_ignore_ascii_case("Content-Length") {
                                value.trim().parse::<usize>().ok()
                            } else {
                                None
                            }
                        })
                    })
                    .unwrap_or(0);
                let body_start = header_end + 4;
                while buffer.len() < body_start + content_length {
                    let read = stream.read(&mut temp).unwrap();
                    if read == 0 {
                        break;
                    }
                    buffer.extend_from_slice(&temp[..read]);
                }
                let body = &buffer[body_start..body_start + content_length];
                let envelope: Value = serde_json::from_slice(body).unwrap();
                let action = envelope["action"].as_str().unwrap().to_string();
                let payload = envelope["payload"].clone();
                recorded
                    .lock()
                    .unwrap()
                    .push((action.clone(), payload.clone()));

                let reply = match action.as_str() {
                    "focus_workspace" => json!({
                        "ok": true,
                        "data": { "ok": true, "workspaceId": payload["workspaceId"] }
                    }),
                    "create_tab" => json!({
                        "ok": true,
                        "data": { "ok": true, "tabId": "tab-1", "paneId": "pane-1", "cwd": payload["cwd"] }
                    }),
                    "split_pane" => json!({
                        "ok": true,
                        "data": { "ok": true, "tabId": payload["tabId"], "paneId": "pane-2", "direction": payload["direction"] }
                    }),
                    "notify_user" => json!({
                        "ok": true,
                        "data": { "ok": true, "message": payload["message"], "tone": payload["tone"] }
                    }),
                    "close_tab" => json!({
                        "ok": true,
                        "data": { "ok": true, "workspaceId": payload["workspaceId"], "tabId": payload["tabId"] }
                    }),
                    _ => json!({ "ok": false, "error": format!("unexpected action: {action}") }),
                };

                let response_body = serde_json::to_vec(&reply).unwrap();
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    response_body.len()
                )
                .unwrap();
                stream.write_all(&response_body).unwrap();
                stream.flush().unwrap();
            }
        });

        (
            format!("http://127.0.0.1:{}/host-control", addr.port()),
            requests,
        )
    }

    #[test]
    fn ui_tools_call_mock_host_control_successfully() {
        let harness = TestHarness::new("ui-host-success");
        let (base_url, requests) = start_mock_host_server();
        runtime_mcp::set_host_control_info(
            base_url,
            "mock-host-token".to_string(),
            vec!["ui-control".to_string()],
        )
        .unwrap();

        let focused = focus_workspace_tool(json!({ "workspaceId": "workspace-1" })).unwrap();
        assert_eq!(focused["workspaceId"], "workspace-1");

        let created_tab = create_tab_tool(json!({
            "workspaceId": "workspace-1",
            "cwd": harness.workspace_path(),
            "shellName": "powershell",
            "activate": true
        }))
        .unwrap();
        assert_eq!(created_tab["tabId"], "tab-1");
        assert_eq!(created_tab["paneId"], "pane-1");

        let split = split_pane_tool(json!({
            "workspaceId": "workspace-1",
            "tabId": "tab-1",
            "paneId": "pane-1",
            "direction": "vertical",
            "cwd": harness.workspace_path(),
            "shellName": "cmd",
            "activate": true
        }))
        .unwrap();
        assert_eq!(split["direction"], "vertical");

        let notification = notify_user_tool(json!({
            "message": "hello",
            "tone": "success",
            "durationMs": 1200
        }))
        .unwrap();
        assert_eq!(notification["tone"], "success");

        let pending = close_tab_tool(json!({
            "workspaceId": "workspace-1",
            "tabId": "tab-1"
        }))
        .unwrap();
        let request_id = pending["request"]["requestId"]
            .as_str()
            .unwrap()
            .to_string();
        let _ = decide_approval_request_tool(json!({
            "requestId": request_id,
            "decision": "approved"
        }))
        .unwrap();
        let closed = close_tab_tool(json!({
            "workspaceId": "workspace-1",
            "tabId": "tab-1",
            "approvalRequestId": pending["request"]["requestId"]
        }))
        .unwrap();
        assert_eq!(closed["tabId"], "tab-1");

        let actions = requests
            .lock()
            .unwrap()
            .iter()
            .map(|(action, _)| action.clone())
            .collect::<Vec<_>>();
        assert_eq!(
            actions,
            vec![
                "focus_workspace",
                "create_tab",
                "split_pane",
                "notify_user",
                "close_tab",
            ]
        );
    }

    #[test]
    fn focus_workspace_reports_host_unavailable_without_snapshot() {
        let _harness = TestHarness::new("ui-host-unavailable");
        let error = focus_workspace_tool(json!({ "workspaceId": "workspace-1" })).unwrap_err();
        assert_eq!(error, "host connection unavailable");
    }
}
