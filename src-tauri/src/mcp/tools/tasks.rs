use crate::agent_core::{
    approval::{list_approvals, set_approval_status},
    models::{ApprovalDecision, ApprovalRiskLevel, StartTaskInput, TaskStatusDetail, TaskSummary},
    task_runtime::{
        get_task_status, list_attention_tasks, mark_approval_executed,
        request_or_validate_approval, request_task_close, resume_session, send_task_input,
        start_task,
    },
    workspace_context::{resolve_workspace_path_for_write, validate_workspace_command_target},
};
use crate::fs::write_text_file;
use serde_json::{json, Value};
use std::process::Command;
use std::thread;
use std::time::Duration;

fn approval_pending_value(result: crate::agent_core::models::PendingApprovalResult) -> Value {
    json!({
        "approvalRequired": result.approval_required,
        "request": result.request,
    })
}

fn parse_approval_decision(value: &str) -> Option<ApprovalDecision> {
    match value {
        "pending" => Some(ApprovalDecision::Pending),
        "approved" => Some(ApprovalDecision::Approved),
        "rejected" => Some(ApprovalDecision::Rejected),
        "executed" => Some(ApprovalDecision::Executed),
        _ => None,
    }
}

fn run_workspace_command(workspace_path: &str, command: &str) -> Result<Value, String> {
    #[cfg(windows)]
    let output = Command::new("cmd")
        .args(["/C", command])
        .current_dir(workspace_path)
        .output()
        .map_err(|err| err.to_string())?;

    #[cfg(not(windows))]
    let output = Command::new("sh")
        .args(["-lc", command])
        .current_dir(workspace_path)
        .output()
        .map_err(|err| err.to_string())?;

    Ok(json!({
        "status": output.status.code(),
        "stdout": String::from_utf8_lossy(&output.stdout),
        "stderr": String::from_utf8_lossy(&output.stderr),
    }))
}

fn is_transient_task_startup_failure(detail: &TaskStatusDetail) -> bool {
    detail.summary.status == "error"
        && detail.summary.exit_code == Some(-1073741502)
        && (detail
            .recent_output_excerpt
            .contains("before producing terminal output")
            || detail.recent_output_excerpt.contains("Task startup failed:")
            || detail.recent_output_excerpt.contains("0xC0000142")
            || detail.recent_output_excerpt.contains("-1073741502"))
}

fn start_task_with_retry(input: StartTaskInput) -> Result<TaskSummary, String> {
    let max_attempts = if cfg!(windows) { 3 } else { 1 };
    let startup_poll_intervals = [
        Duration::from_millis(150),
        Duration::from_millis(250),
        Duration::from_millis(400),
    ];

    for attempt in 1..=max_attempts {
        let summary = start_task(input.clone())?;
        if attempt >= max_attempts {
            return Ok(summary);
        }

        let mut should_retry = false;
        for interval in startup_poll_intervals {
            thread::sleep(interval);
            let detail = get_task_status(&summary.task_id)?;
            if is_transient_task_startup_failure(&detail) {
                should_retry = true;
                break;
            }
            if detail.summary.status != "starting" {
                return Ok(summary);
            }
        }

        if !should_retry {
            return Ok(summary);
        }
    }

    Err("task retry attempts exhausted".to_string())
}

pub fn start_task_tool(args: Value) -> Result<Value, String> {
    let object = args.as_object().cloned().unwrap_or_default();
    let input = StartTaskInput {
        workspace_id: object
            .get("workspaceId")
            .and_then(Value::as_str)
            .ok_or("workspaceId is required")?
            .to_string(),
        target: serde_json::from_value(object.get("target").cloned().ok_or("target is required")?)
            .map_err(|_| "target is invalid".to_string())?,
        prompt: object
            .get("prompt")
            .and_then(Value::as_str)
            .ok_or("prompt is required")?
            .to_string(),
        context_preset: serde_json::from_value(
            object
                .get("contextPreset")
                .cloned()
                .ok_or("contextPreset is required")?,
        )
        .map_err(|_| "contextPreset is invalid".to_string())?,
        cwd: object
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::to_string),
        title: object
            .get("title")
            .and_then(Value::as_str)
            .map(str::to_string),
    };

    serde_json::to_value(start_task_with_retry(input)?).map_err(|err| err.to_string())
}

pub fn get_task_status_tool(args: Value) -> Result<Value, String> {
    let object = args.as_object().cloned().unwrap_or_default();
    let task_id = object
        .get("taskId")
        .and_then(Value::as_str)
        .ok_or("taskId is required")?;
    serde_json::to_value(get_task_status(task_id)?).map_err(|err| err.to_string())
}

pub fn list_attention_tasks_tool(_: Value) -> Result<Value, String> {
    Ok(json!(list_attention_tasks()))
}

pub fn list_approval_requests_tool(args: Value) -> Result<Value, String> {
    let object = args.as_object().cloned().unwrap_or_default();
    let status = match object.get("status").and_then(Value::as_str) {
        Some(value) => Some(parse_approval_decision(value).ok_or("status is invalid")?),
        None => None,
    };
    let tool_name = object.get("toolName").and_then(Value::as_str);

    let items = list_approvals()
        .into_iter()
        .filter(|request| {
            status
                .as_ref()
                .map(|expected| request.status == *expected)
                .unwrap_or(true)
        })
        .filter(|request| {
            tool_name
                .map(|expected| request.tool_name == expected)
                .unwrap_or(true)
        })
        .collect::<Vec<_>>();
    serde_json::to_value(items).map_err(|err| err.to_string())
}

pub fn decide_approval_request_tool(args: Value) -> Result<Value, String> {
    let object = args.as_object().cloned().unwrap_or_default();
    let request_id = object
        .get("requestId")
        .and_then(Value::as_str)
        .ok_or("requestId is required")?;
    let decision: ApprovalDecision = serde_json::from_value(
        object
            .get("decision")
            .cloned()
            .ok_or("decision is required")?,
    )
    .map_err(|_| "decision is invalid".to_string())?;

    match decision {
        ApprovalDecision::Approved | ApprovalDecision::Rejected => {
            serde_json::to_value(set_approval_status(request_id, decision)?)
                .map_err(|err| err.to_string())
        }
        _ => Err("decision must be approved or rejected".to_string()),
    }
}

pub fn resume_session_tool(args: Value) -> Result<Value, String> {
    let object = args.as_object().cloned().unwrap_or_default();
    let task_id = object
        .get("taskId")
        .and_then(Value::as_str)
        .ok_or("taskId is required")?;
    serde_json::to_value(resume_session(task_id)?).map_err(|err| err.to_string())
}

pub fn send_task_input_tool(args: Value) -> Result<Value, String> {
    let object = args.as_object().cloned().unwrap_or_default();
    let task_id = object
        .get("taskId")
        .and_then(Value::as_str)
        .ok_or("taskId is required")?;
    let submit_only = object
        .get("submitOnly")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let input = match object.get("input") {
        Some(value) => value.as_str().ok_or("input is invalid")?,
        None if submit_only => "",
        None => return Err("input is required".to_string()),
    };
    serde_json::to_value(send_task_input(task_id, input)?).map_err(|err| err.to_string())
}

pub fn write_file_tool(args: Value) -> Result<Value, String> {
    let object = args.as_object().cloned().unwrap_or_default();
    let path = object
        .get("path")
        .and_then(Value::as_str)
        .ok_or("path is required")?;
    let content = object
        .get("content")
        .and_then(Value::as_str)
        .ok_or("content is required")?;
    let approval_request_id = object.get("approvalRequestId").and_then(Value::as_str);
    let resolved_path = resolve_workspace_path_for_write(path)?;

    let approval = match request_or_validate_approval(
        approval_request_id,
        "write_file",
        "Writing a file changes repository state.",
        ApprovalRiskLevel::High,
        format!(
            "Path: {}\n\n{}",
            resolved_path.requested_path,
            content.chars().take(2_000).collect::<String>()
        ),
    ) {
        Ok(approval) => approval,
        Err(pending) => return Ok(approval_pending_value(pending)),
    };

    write_text_file(resolved_path.requested_path.clone(), content.to_string())?;
    mark_approval_executed(&approval.request_id);

    Ok(json!({
        "ok": true,
        "path": resolved_path.requested_path,
        "workspaceId": resolved_path.workspace_id,
    }))
}

pub fn close_task_tool(args: Value) -> Result<Value, String> {
    let object = args.as_object().cloned().unwrap_or_default();
    let task_id = object
        .get("taskId")
        .and_then(Value::as_str)
        .ok_or("taskId is required")?;
    let approval_request_id = object.get("approvalRequestId").and_then(Value::as_str);
    let result = request_task_close(task_id, approval_request_id)?;
    if result.ok {
        serde_json::to_value(result.data.expect("close_task success should carry data"))
            .map_err(|err| err.to_string())
    } else {
        Ok(approval_pending_value(
            crate::agent_core::models::PendingApprovalResult {
                approval_required: result.approval_required,
                request: result
                    .request
                    .expect("approval-required close_task should carry request"),
            },
        ))
    }
}

pub fn run_workspace_command_tool(args: Value) -> Result<Value, String> {
    let object = args.as_object().cloned().unwrap_or_default();
    let workspace_path = object
        .get("workspacePath")
        .and_then(Value::as_str)
        .ok_or("workspacePath is required")?;
    let command = object
        .get("command")
        .and_then(Value::as_str)
        .ok_or("command is required")?;
    let approval_request_id = object.get("approvalRequestId").and_then(Value::as_str);
    let validated = validate_workspace_command_target(workspace_path, command)?;

    let approval = match request_or_validate_approval(
        approval_request_id,
        "run_workspace_command",
        "Running arbitrary commands can modify files or execute side effects.",
        ApprovalRiskLevel::High,
        format!(
            "Workspace: {}\nCommand: {}",
            validated.workspace_path, validated.command
        ),
    ) {
        Ok(approval) => approval,
        Err(pending) => return Ok(approval_pending_value(pending)),
    };

    let result = run_workspace_command(&validated.workspace_path, &validated.command)?;
    mark_approval_executed(&approval.request_id);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_core::{
        models::{
            ApprovalDecision, TaskAttentionState, TaskContextPreset, TaskStatusDetail, TaskSummary,
            TaskTarget,
        },
        task_store::upsert_task_detail,
    };
    use crate::mcp::tools::test_support::TestHarness;
    use serde_json::json;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::thread;
    use std::time::{Duration, Instant};

    struct EnvVarGuard {
        key: &'static str,
        previous: Option<String>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, value: String) -> Self {
            let previous = std::env::var(key).ok();
            std::env::set_var(key, value);
            Self { key, previous }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            if let Some(previous) = &self.previous {
                std::env::set_var(self.key, previous);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }

    fn write_agent_shim(dir: &Path) -> PathBuf {
        #[cfg(windows)]
        let path = dir.join("agent-shim.ps1");
        #[cfg(not(windows))]
        let path = dir.join("agent-shim.sh");

        #[cfg(windows)]
        let script = r#"
param([string]$target)
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Write-Output ("READY:{0}" -f $target)
Write-Output 'TITLE:'
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) {
    break
  }
  if ($line -eq 'exit') {
    Write-Output 'BYE'
    exit 0
  }
  if ($line.Length -eq 0) {
    Write-Output 'ECHO:<ENTER>'
  } else {
    Write-Output ("ECHO:{0}" -f $line)
  }
}
"#;

        #[cfg(not(windows))]
        let script = r#"#!/bin/sh
target="$1"
cwd="$2"
title="$3"
prompt="$4"
printf 'READY:%s\n' "$target"
printf 'TITLE:%s\n' "$title"
while IFS= read -r line; do
  if [ "$line" = "exit" ]; then
    printf 'BYE\n'
    exit 0
  fi
  if [ -z "$line" ]; then
    printf 'ECHO:<ENTER>\n'
  else
    printf 'ECHO:%s\n' "$line"
  fi
done
"#;

        #[cfg(windows)]
        fs::write(&path, script.trim_start()).unwrap();

        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(&path).unwrap().permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&path, permissions).unwrap();
        }

        path
    }

    #[test]
    fn transient_task_startup_failure_detects_windows_loader_exit() {
        let detail = TaskStatusDetail {
            summary: TaskSummary {
                task_id: "task-1".into(),
                workspace_id: "workspace-1".into(),
                workspace_name: "mini-term".into(),
                workspace_root_path: "D:/code/mini-term".into(),
                target: TaskTarget::Codex,
                title: "task".into(),
                status: "error".into(),
                attention_state: TaskAttentionState::Failed,
                session_id: "task-1".into(),
                cwd: "D:/code/mini-term".into(),
                started_at: 1,
                updated_at: 1,
                completed_at: Some(2),
                exit_code: Some(-1073741502),
                context_preset: TaskContextPreset::Light,
                changed_files: Vec::new(),
                prompt_preview: "prompt".into(),
                last_output_excerpt: "Task process exited with code -1073741502 before producing terminal output".into(),
                injection_profile_id: None,
                injection_preset: None,
                policy_summary: None,
                termination_cause: None,
            },
            recent_output_excerpt:
                "Task process exited with code -1073741502 before producing terminal output"
                    .into(),
            diff_summary: Vec::new(),
            log_path: "D:/code/mini-term/task.log".into(),
        };
        assert!(is_transient_task_startup_failure(&detail));
    }

    fn wait_for_task_output(task_id: &str, needle: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let value = get_task_status_tool(json!({ "taskId": task_id })).unwrap();
            let excerpt_matches = value["recentOutputExcerpt"]
                .as_str()
                .is_some_and(|excerpt| excerpt.contains(needle));
            let log_matches = value["logPath"]
                .as_str()
                .and_then(|path| fs::read_to_string(path).ok())
                .is_some_and(|content| content.contains(needle));
            if excerpt_matches || log_matches {
                return value;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for task output containing {needle:?}; excerpt={:?}; log_path={:?}",
                value["recentOutputExcerpt"].as_str(),
                value["logPath"].as_str()
            );
            thread::sleep(Duration::from_millis(50));
        }
    }

    fn sample_task(task_id: &str, workspace_path: &str) -> TaskStatusDetail {
        TaskStatusDetail {
            summary: TaskSummary {
                task_id: task_id.to_string(),
                workspace_id: "workspace-1".into(),
                workspace_name: "mini-term".into(),
                workspace_root_path: workspace_path.to_string(),
                target: TaskTarget::Codex,
                title: "Sample task".into(),
                status: "running".into(),
                attention_state: TaskAttentionState::Running,
                session_id: task_id.to_string(),
                cwd: workspace_path.to_string(),
                started_at: 1,
                updated_at: 1,
                completed_at: None,
                exit_code: None,
                context_preset: TaskContextPreset::Review,
                changed_files: Vec::new(),
                prompt_preview: "prompt".into(),
                last_output_excerpt: "output".into(),
                injection_profile_id: None,
                injection_preset: None,
                policy_summary: None,
                termination_cause: None,
            },
            recent_output_excerpt: "output".into(),
            diff_summary: Vec::new(),
            log_path: "D:/logs/sample.log".into(),
        }
    }

    #[test]
    fn get_task_status_returns_seeded_task() {
        let harness = TestHarness::new("task-status-success");
        upsert_task_detail(sample_task("task-1", &harness.workspace_path())).unwrap();

        let value = get_task_status_tool(json!({ "taskId": "task-1" })).unwrap();
        assert_eq!(value["summary"]["taskId"], "task-1");
    }

    #[test]
    fn start_task_requires_workspace_id() {
        let _harness = TestHarness::new("start-task-missing-workspace");
        let error = start_task_tool(json!({
            "target": "codex",
            "prompt": "say hello",
            "contextPreset": "light"
        }))
        .unwrap_err();
        assert_eq!(error, "workspaceId is required");
    }

    #[test]
    fn start_task_rejects_invalid_target() {
        let _harness = TestHarness::new("start-task-invalid-target");
        let error = start_task_tool(json!({
            "workspaceId": "workspace-1",
            "target": "cursor",
            "prompt": "say hello",
            "contextPreset": "light"
        }))
        .unwrap_err();
        assert_eq!(error, "target is invalid");
    }

    #[test]
    fn resume_session_returns_seeded_task() {
        let harness = TestHarness::new("resume-session-success");
        upsert_task_detail(sample_task("task-1", &harness.workspace_path())).unwrap();

        let value = resume_session_tool(json!({ "taskId": "task-1" })).unwrap();
        assert_eq!(value["summary"]["taskId"], "task-1");
    }

    #[test]
    fn resume_session_requires_task_id() {
        let _harness = TestHarness::new("resume-session-missing-task-id");
        let error = resume_session_tool(json!({})).unwrap_err();
        assert_eq!(error, "taskId is required");
    }

    #[test]
    fn list_attention_tasks_returns_seeded_task() {
        let harness = TestHarness::new("attention-list-success");
        upsert_task_detail(sample_task("task-1", &harness.workspace_path())).unwrap();

        let value = list_attention_tasks_tool(json!({})).unwrap();
        assert_eq!(value.as_array().map(|items| items.len()), Some(1));
    }

    #[test]
    fn approval_tools_list_and_update_requests() {
        let harness = TestHarness::new("approval-tools");
        let file_path = harness.workspace_root.join("notes.txt");

        let pending = write_file_tool(json!({
            "path": file_path.to_string_lossy(),
            "content": "hello"
        }))
        .unwrap();
        let request_id = pending["request"]["requestId"]
            .as_str()
            .unwrap()
            .to_string();

        let listed = list_approval_requests_tool(json!({
            "toolName": "write_file",
            "status": "pending"
        }))
        .unwrap();
        assert_eq!(listed.as_array().map(|items| items.len()), Some(1));
        assert_eq!(listed[0]["requestId"], request_id);

        let approved = decide_approval_request_tool(json!({
            "requestId": request_id,
            "decision": "approved"
        }))
        .unwrap();
        assert_eq!(approved["status"], "approved");
    }

    #[test]
    fn decide_approval_request_rejects_invalid_decision() {
        let _harness = TestHarness::new("approval-decision-invalid");
        let error = decide_approval_request_tool(json!({
            "requestId": "approval-1",
            "decision": "executed"
        }))
        .unwrap_err();
        assert_eq!(error, "decision must be approved or rejected");
    }

    #[test]
    #[cfg_attr(
        windows,
        ignore = "flaky under cargo test PTY on Windows; covered by MCP end-to-end validation"
    )]
    fn task_tools_support_interactive_happy_path_with_test_shim() {
        let harness = TestHarness::new("task-tools-happy-path");
        let shim_dir = harness.workspace_root.join("test-bin");
        fs::create_dir_all(&shim_dir).unwrap();
        let shim = write_agent_shim(&shim_dir);
        let _shim_guard = EnvVarGuard::set(
            "MINI_TERM_TEST_AGENT_SHIM",
            shim.to_string_lossy().to_string(),
        );
        let _shim_override_guard =
            EnvVarGuard::set("MINI_TERM_AGENT_SHIM", shim.to_string_lossy().to_string());

        let started = start_task_tool(json!({
            "workspaceId": "workspace-1",
            "target": "codex",
            "prompt": "say hello",
            "contextPreset": "light",
            "title": "Shim task"
        }))
        .unwrap();
        let task_id = started["taskId"].as_str().unwrap().to_string();

        let running = wait_for_task_output(&task_id, "READY:codex");
        assert_eq!(running["summary"]["taskId"], task_id);
        assert_eq!(running["summary"]["status"], "running");

        let resumed = resume_session_tool(json!({ "taskId": task_id })).unwrap();
        assert_eq!(resumed["summary"]["taskId"], task_id);

        let sent = send_task_input_tool(json!({
            "taskId": task_id,
            "input": "hello shim"
        }))
        .unwrap();
        assert_eq!(sent["taskId"], task_id);

        let echoed = wait_for_task_output(&task_id, "ECHO:hello shim");
        assert!(echoed["recentOutputExcerpt"]
            .as_str()
            .is_some_and(|excerpt| excerpt.contains("ECHO:hello shim")));

        let submitted = send_task_input_tool(json!({
            "taskId": task_id,
            "input": ""
        }))
        .unwrap();
        assert_eq!(submitted["taskId"], task_id);

        let enter_echo = wait_for_task_output(&task_id, "ECHO:<ENTER>");
        assert!(enter_echo["recentOutputExcerpt"]
            .as_str()
            .is_some_and(|excerpt| excerpt.contains("ECHO:<ENTER>")));

        let pending = close_task_tool(json!({ "taskId": task_id })).unwrap();
        let request_id = pending["request"]["requestId"]
            .as_str()
            .unwrap()
            .to_string();
        set_approval_status(&request_id, ApprovalDecision::Approved).unwrap();

        let closed = close_task_tool(json!({
            "taskId": task_id,
            "approvalRequestId": request_id
        }))
        .unwrap();
        assert_eq!(closed["taskId"], task_id);
        assert_eq!(closed["terminationCause"], "manual-close");
    }

    #[test]
    fn send_task_input_allows_submit_only_without_input_field() {
        let _harness = TestHarness::new("send-input-empty");
        let error = send_task_input_tool(json!({
            "taskId": "task-1",
            "submitOnly": true
        }))
        .unwrap_err();
        assert_eq!(
            error,
            "task is not interactive or no longer running: task-1"
        );
    }

    #[test]
    fn send_task_input_requires_task_id() {
        let _harness = TestHarness::new("send-input-missing");
        let error = send_task_input_tool(json!({ "input": "continue" })).unwrap_err();
        assert_eq!(error, "taskId is required");
    }

    #[test]
    fn close_task_reports_missing_task() {
        let _harness = TestHarness::new("close-missing");
        let error = close_task_tool(json!({ "taskId": "missing" })).unwrap_err();
        assert_eq!(error, "task is not running: missing");
    }

    #[test]
    fn write_file_requires_approval_then_executes_after_approval() {
        let harness = TestHarness::new("write-file-approval");
        let file_path = harness.workspace_root.join("notes.txt");

        let pending = write_file_tool(json!({
            "path": file_path.to_string_lossy(),
            "content": "hello"
        }))
        .unwrap();
        assert_eq!(pending["approvalRequired"], true);
        let request_id = pending["request"]["requestId"]
            .as_str()
            .unwrap()
            .to_string();

        set_approval_status(&request_id, ApprovalDecision::Approved).unwrap();
        let result = write_file_tool(json!({
            "path": file_path.to_string_lossy(),
            "content": "hello",
            "approvalRequestId": request_id
        }))
        .unwrap();

        assert_eq!(result["ok"], true);
        assert_eq!(fs::read_to_string(file_path).unwrap(), "hello");
    }

    #[test]
    fn write_file_rejects_outside_workspace() {
        let _harness = TestHarness::new("write-file-outside");
        let outside = std::env::temp_dir().join("mini-term-outside-write.txt");
        let error = write_file_tool(json!({
            "path": outside.to_string_lossy(),
            "content": "hello"
        }))
        .unwrap_err();
        assert_eq!(error, "workspace path is outside configured roots");
    }

    #[test]
    fn write_file_reuses_existing_pending_approval() {
        let harness = TestHarness::new("write-file-dedupe");
        let file_path = harness.workspace_root.join("notes.txt");

        let first = write_file_tool(json!({
            "path": file_path.to_string_lossy(),
            "content": "hello"
        }))
        .unwrap();
        let second = write_file_tool(json!({
            "path": file_path.to_string_lossy(),
            "content": "hello"
        }))
        .unwrap();

        assert_eq!(
            first["request"]["requestId"],
            second["request"]["requestId"]
        );
        assert_eq!(second["request"]["status"], "pending");
    }

    #[test]
    fn write_file_does_not_execute_without_request_id_after_approval() {
        let harness = TestHarness::new("write-file-approved-without-id");
        let file_path = harness.workspace_root.join("notes.txt");

        let pending = write_file_tool(json!({
            "path": file_path.to_string_lossy(),
            "content": "hello"
        }))
        .unwrap();
        let request_id = pending["request"]["requestId"]
            .as_str()
            .unwrap()
            .to_string();
        set_approval_status(&request_id, ApprovalDecision::Approved).unwrap();

        let approved = write_file_tool(json!({
            "path": file_path.to_string_lossy(),
            "content": "hello"
        }))
        .unwrap();

        assert_eq!(approved["approvalRequired"], true);
        assert_eq!(approved["request"]["status"], "approved");
        assert!(!file_path.exists());
    }

    #[test]
    fn write_file_restarts_approval_when_request_id_targets_different_action() {
        let harness = TestHarness::new("write-file-mismatched-request-id");
        let file_path = harness.workspace_root.join("notes.txt");

        let old_pending = write_file_tool(json!({
            "path": file_path.to_string_lossy(),
            "content": "hello"
        }))
        .unwrap();
        let old_request_id = old_pending["request"]["requestId"]
            .as_str()
            .unwrap()
            .to_string();
        set_approval_status(&old_request_id, ApprovalDecision::Approved).unwrap();

        let other_path = harness.workspace_root.join("other.txt");
        let restarted = write_file_tool(json!({
            "path": other_path.to_string_lossy(),
            "content": "hello",
            "approvalRequestId": old_request_id
        }))
        .unwrap();

        assert_eq!(restarted["approvalRequired"], true);
        assert_ne!(
            restarted["request"]["requestId"].as_str().unwrap(),
            old_request_id
        );
        assert_eq!(restarted["request"]["status"], "pending");
        assert!(!other_path.exists());
    }

    #[test]
    fn run_workspace_command_requires_approval_and_honors_rejection() {
        let harness = TestHarness::new("run-command-reject");
        let pending = run_workspace_command_tool(json!({
            "workspacePath": harness.workspace_path(),
            "command": "echo hello"
        }))
        .unwrap();
        assert_eq!(pending["approvalRequired"], true);
        let request_id = pending["request"]["requestId"]
            .as_str()
            .unwrap()
            .to_string();

        set_approval_status(&request_id, ApprovalDecision::Rejected).unwrap();
        let rejected = run_workspace_command_tool(json!({
            "workspacePath": harness.workspace_path(),
            "command": "echo hello",
            "approvalRequestId": request_id
        }))
        .unwrap();

        assert_eq!(rejected["approvalRequired"], true);
        assert_eq!(rejected["request"]["status"], "rejected");
    }

    #[test]
    fn run_workspace_command_executes_after_approval() {
        let harness = TestHarness::new("run-command-approved");
        let pending = run_workspace_command_tool(json!({
            "workspacePath": harness.workspace_path(),
            "command": "echo hello"
        }))
        .unwrap();
        let request_id = pending["request"]["requestId"]
            .as_str()
            .unwrap()
            .to_string();

        set_approval_status(&request_id, ApprovalDecision::Approved).unwrap();
        let result = run_workspace_command_tool(json!({
            "workspacePath": harness.workspace_path(),
            "command": "echo hello",
            "approvalRequestId": request_id
        }))
        .unwrap();

        assert_eq!(result["status"], 0);
    }

    #[test]
    fn run_workspace_command_rejects_invalid_workspace_path() {
        let _harness = TestHarness::new("run-command-invalid-path");
        let error = run_workspace_command_tool(json!({
            "workspacePath": "D:/missing-workspace",
            "command": "echo hello"
        }))
        .unwrap_err();
        assert_eq!(error, "workspace path must be an existing directory");
    }

    #[test]
    fn run_workspace_command_requires_non_empty_command() {
        let harness = TestHarness::new("run-command-empty");
        let error = run_workspace_command_tool(json!({
            "workspacePath": harness.workspace_path(),
            "command": "   "
        }))
        .unwrap_err();
        assert_eq!(error, "command is required");
    }

    #[test]
    fn decide_approval_request_with_nonexistent_id_returns_error() {
        let _harness = TestHarness::new("approval-missing-id");
        let error = decide_approval_request_tool(json!({
            "requestId": "approval-does-not-exist-xyz",
            "decision": "approved"
        }))
        .unwrap_err();
        assert!(
            error.contains("approval request not found"),
            "expected 'approval request not found' in error, got: {error}"
        );
    }

    #[test]
    fn write_file_with_executed_approval_id_creates_new_approval() {
        // An already-executed approvalRequestId must not be replayed.
        // The tool should start a fresh pending approval rather than silently writing.
        let harness = TestHarness::new("write-file-executed-replay");
        let file_path = harness.workspace_root.join("replay.txt");

        // First call: create pending approval.
        let pending = write_file_tool(json!({
            "path": file_path.to_string_lossy(),
            "content": "original"
        }))
        .unwrap();
        let request_id = pending["request"]["requestId"]
            .as_str()
            .unwrap()
            .to_string();

        // Approve and execute.
        set_approval_status(&request_id, ApprovalDecision::Approved).unwrap();
        write_file_tool(json!({
            "path": file_path.to_string_lossy(),
            "content": "original",
            "approvalRequestId": request_id
        }))
        .unwrap();
        assert_eq!(fs::read_to_string(&file_path).unwrap(), "original");

        // Second call with the now-executed requestId and different content:
        // must NOT write immediately; must return a fresh pending approval.
        let result = write_file_tool(json!({
            "path": file_path.to_string_lossy(),
            "content": "overwrite",
            "approvalRequestId": request_id
        }))
        .unwrap();

        assert_eq!(
            result["approvalRequired"], true,
            "executed approval must not be reused for a new write"
        );
        // File content unchanged.
        assert_eq!(fs::read_to_string(&file_path).unwrap(), "original");
    }
}
