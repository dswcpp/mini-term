use crate::agent_core::data_dir::config_path;
use crate::agent_core::models::ApprovalRiskLevel;
use crate::agent_core::task_runtime::{mark_approval_executed, request_or_validate_approval};
use crate::agent_core::workspace_context::validate_task_working_directory;
use crate::config::{load_config_from_path, ShellConfig};
use crate::host_control::call_host_control;
use crate::mcp::tools::action_support::approval_pending_value;
use serde_json::{json, Value};

fn resolve_shell(
    shell_name: Option<&str>,
    config: &crate::config::AppConfig,
) -> Result<ShellConfig, String> {
    let selected = match shell_name {
        Some(name) => config
            .available_shells
            .iter()
            .find(|shell| shell.name == name)
            .cloned()
            .ok_or_else(|| format!("shell not found: {name}"))?,
        None => config
            .available_shells
            .iter()
            .find(|shell| shell.name == config.default_shell)
            .cloned()
            .or_else(|| config.available_shells.first().cloned())
            .ok_or_else(|| "no shells are configured".to_string())?,
    };
    Ok(selected)
}

pub fn get_pty_detail_tool(args: Value) -> Result<Value, String> {
    let object = args.as_object().cloned().unwrap_or_default();
    let pty_id = object
        .get("ptyId")
        .and_then(Value::as_u64)
        .ok_or("ptyId is required")? as u32;
    call_host_control("get_pty_detail", json!({ "ptyId": pty_id }))
}

pub fn get_process_tree_tool(args: Value) -> Result<Value, String> {
    let object = args.as_object().cloned().unwrap_or_default();
    let pty_id = object
        .get("ptyId")
        .and_then(Value::as_u64)
        .ok_or("ptyId is required")? as u32;
    call_host_control("get_process_tree", json!({ "ptyId": pty_id }))
}

pub fn create_pty_tool(args: Value) -> Result<Value, String> {
    let object = args.as_object().cloned().unwrap_or_default();
    let workspace_id = object
        .get("workspaceId")
        .and_then(Value::as_str)
        .ok_or("workspaceId is required")?;
    let cwd = object.get("cwd").and_then(Value::as_str);
    let shell_name = object.get("shellName").and_then(Value::as_str);
    let mode = object
        .get("mode")
        .and_then(Value::as_str)
        .map(str::to_string);
    if let Some(mode) = mode.as_deref() {
        if !matches!(mode, "human" | "agent" | "task") {
            return Err("mode is invalid".to_string());
        }
    }

    let cols = object
        .get("cols")
        .and_then(Value::as_u64)
        .map(|value| value as u16);
    let rows = object
        .get("rows")
        .and_then(Value::as_u64)
        .map(|value| value as u16);
    if cols == Some(0) || rows == Some(0) {
        return Err("cols and rows must be positive".to_string());
    }

    let validated = validate_task_working_directory(workspace_id, cwd)?;
    let config = load_config_from_path(&config_path());
    let shell = resolve_shell(shell_name, &config)?;

    let created = call_host_control(
        "create_pty",
        json!({
            "shell": shell.command,
            "args": shell.args.unwrap_or_default(),
            "cwd": validated.cwd,
            "mode": mode,
            "cols": cols,
            "rows": rows,
        }),
    )?;

    Ok(json!({
        "workspaceId": validated.workspace_id,
        "workspaceName": validated.workspace_name,
        "workspaceRootPath": validated.workspace_root_path,
        "shellName": shell.name,
        "session": created,
    }))
}

pub fn write_pty_tool(args: Value) -> Result<Value, String> {
    let object = args.as_object().cloned().unwrap_or_default();
    let pty_id = object
        .get("ptyId")
        .and_then(Value::as_u64)
        .ok_or("ptyId is required")? as u32;
    let data = object
        .get("data")
        .and_then(Value::as_str)
        .ok_or("data is required")?;
    call_host_control(
        "write_pty",
        json!({
            "ptyId": pty_id,
            "data": data,
        }),
    )
}

pub fn resize_pty_tool(args: Value) -> Result<Value, String> {
    let object = args.as_object().cloned().unwrap_or_default();
    let pty_id = object
        .get("ptyId")
        .and_then(Value::as_u64)
        .ok_or("ptyId is required")? as u32;
    let cols = object
        .get("cols")
        .and_then(Value::as_u64)
        .ok_or("cols is required")? as u16;
    let rows = object
        .get("rows")
        .and_then(Value::as_u64)
        .ok_or("rows is required")? as u16;
    if cols == 0 || rows == 0 {
        return Err("cols and rows must be positive".to_string());
    }
    call_host_control(
        "resize_pty",
        json!({
            "ptyId": pty_id,
            "cols": cols,
            "rows": rows,
        }),
    )
}

pub fn kill_pty_tool(args: Value) -> Result<Value, String> {
    let object = args.as_object().cloned().unwrap_or_default();
    let pty_id = object
        .get("ptyId")
        .and_then(Value::as_u64)
        .ok_or("ptyId is required")? as u32;
    let approval_request_id = object.get("approvalRequestId").and_then(Value::as_str);

    let approval = match request_or_validate_approval(
        approval_request_id,
        "kill_pty",
        "Killing a PTY stops the terminal process and discards in-flight work.",
        ApprovalRiskLevel::High,
        format!("PTY: {pty_id}"),
    ) {
        Ok(approval) => approval,
        Err(pending) => return Ok(approval_pending_value("kill_pty", pending)),
    };

    let result = call_host_control("kill_pty", json!({ "ptyId": pty_id }))?;
    mark_approval_executed(&approval.request_id);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
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
                    "get_pty_detail" => json!({
                        "ok": true,
                        "data": {
                            "ptyId": payload["ptyId"],
                            "rootPid": 5010,
                            "status": "running",
                        }
                    }),
                    "get_process_tree" => json!({
                        "ok": true,
                        "data": {
                            "root": {
                                "pid": 5010,
                                "parentPid": Value::Null,
                                "name": "powershell.exe",
                                "exe": "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
                                "commandLine": "powershell",
                                "alive": true,
                                "children": [{
                                    "pid": 5011,
                                    "parentPid": 5010,
                                    "name": "node.exe",
                                    "exe": "C:/Program Files/nodejs/node.exe",
                                    "commandLine": "node child.js",
                                    "alive": true,
                                    "children": [],
                                }],
                            }
                        }
                    }),
                    "create_pty" => json!({
                        "ok": true,
                        "data": {
                            "ptyId": 91,
                            "sessionId": "mock-pty-91",
                            "cwd": payload["cwd"],
                            "shell": payload["shell"],
                        }
                    }),
                    "write_pty" => json!({
                        "ok": true,
                        "data": {
                            "ok": true,
                            "ptyId": payload["ptyId"],
                            "echoed": payload["data"],
                        }
                    }),
                    "resize_pty" => json!({
                        "ok": true,
                        "data": {
                            "ok": true,
                            "ptyId": payload["ptyId"],
                            "cols": payload["cols"],
                            "rows": payload["rows"],
                        }
                    }),
                    "kill_pty" => json!({
                        "ok": true,
                        "data": {
                            "ok": true,
                            "ptyId": payload["ptyId"],
                            "status": "killed",
                        }
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
    fn pty_tools_call_mock_host_control_successfully() {
        let harness = TestHarness::new("pty-host-success");
        let (base_url, requests) = start_mock_host_server();
        runtime_mcp::set_host_control_info(
            base_url,
            "mock-host-token".to_string(),
            vec![
                "pty-control".to_string(),
                "runtime-observation-detail".to_string(),
            ],
        )
        .unwrap();

        let detail = get_pty_detail_tool(json!({ "ptyId": 5 })).unwrap();
        assert_eq!(detail["ptyId"], 5);
        assert_eq!(detail["rootPid"], 5010);

        let process_tree = get_process_tree_tool(json!({ "ptyId": 5 })).unwrap();
        assert_eq!(process_tree["root"]["pid"], 5010);
        assert_eq!(process_tree["root"]["children"][0]["pid"], 5011);

        let created = create_pty_tool(json!({
            "workspaceId": "workspace-1",
            "cwd": harness.workspace_path(),
            "shellName": "cmd",
            "mode": "agent",
            "cols": 100,
            "rows": 30
        }))
        .unwrap();
        assert_eq!(created["workspaceId"], "workspace-1");
        assert_eq!(created["shellName"], "cmd");
        assert_eq!(created["session"]["ptyId"], 91);

        let write_result = write_pty_tool(json!({
            "ptyId": 91,
            "data": "dir"
        }))
        .unwrap();
        assert_eq!(write_result["echoed"], "dir");

        let resize_result = resize_pty_tool(json!({
            "ptyId": 91,
            "cols": 140,
            "rows": 40
        }))
        .unwrap();
        assert_eq!(resize_result["cols"], 140);
        assert_eq!(resize_result["rows"], 40);

        let pending = kill_pty_tool(json!({ "ptyId": 91 })).unwrap();
        let request_id = pending["request"]["requestId"]
            .as_str()
            .unwrap()
            .to_string();
        let _ = crate::mcp::tools::tasks::decide_approval_request_tool(json!({
            "requestId": request_id,
            "decision": "approved"
        }))
        .unwrap();
        let killed = kill_pty_tool(json!({
            "ptyId": 91,
            "approvalRequestId": pending["request"]["requestId"]
        }))
        .unwrap();
        assert_eq!(killed["status"], "killed");

        let actions = requests
            .lock()
            .unwrap()
            .iter()
            .map(|(action, _)| action.clone())
            .collect::<Vec<_>>();
        assert_eq!(
            actions,
            vec![
                "get_pty_detail",
                "get_process_tree",
                "create_pty",
                "write_pty",
                "resize_pty",
                "kill_pty",
            ]
        );
    }

    #[test]
    fn get_pty_detail_reports_host_unavailable_without_snapshot() {
        let _harness = TestHarness::new("pty-host-unavailable");
        let error = get_pty_detail_tool(json!({ "ptyId": 5 })).unwrap_err();
        assert_eq!(error, "host connection unavailable");
    }
}
