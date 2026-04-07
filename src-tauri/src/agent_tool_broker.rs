use crate::agent_core::task_store::get_task_detail;
use crate::mcp::{find_tool, invoke_tool_structured};
use crate::runtime_mcp::record_runtime_event;
use serde_json::{json, Value};

pub const SIDECAR_RESERVED_TOOL_NAMES: &[&str] = &[
    "start_task",
    "spawn_worker",
    "resume_session",
    "send_task_input",
    "close_task",
    "decide_approval_request",
];
pub const SIDECAR_TOOL_CALL_AUTHORITY: &str = "mini-term";
pub const SIDECAR_TOOL_CALL_NOTES: &str =
    "Sidecar tool calls are brokered through Mini-Term. Observation tools and approval-gated compat tools stay available, but Mini-Term-owned task lifecycle tools are reserved.";
pub const SIDECAR_APPROVAL_FLOW_NOTES: &str =
    "Approval requests remain in Mini-Term Inbox. The sidecar only receives the final tool result after Mini-Term approves or rejects the action.";

fn tool_denied_envelope(tool_name: &str, reason: &str) -> Value {
    json!({
        "ok": false,
        "data": Value::Null,
        "error": {
            "code": "TOOL_DENIED",
            "message": reason,
            "retryable": false,
        },
        "meta": {
            "toolName": tool_name,
            "brokeredBy": "mini-term",
            "brokerKind": "sidecar",
        }
    })
}

fn annotate_broker_metadata(mut value: Value) -> Value {
    if let Some(object) = value.as_object_mut() {
        let approval_required = object
            .get("approvalRequired")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || object
                .get("requiresConfirmation")
                .and_then(Value::as_bool)
                .unwrap_or(false);
        object.insert(
            "approvalRequired".to_string(),
            Value::Bool(approval_required),
        );
        object.insert(
            "broker".to_string(),
            json!({
                "authority": "mini-term",
                "kind": "sidecar",
            }),
        );
    }
    value
}

fn is_tool_allowed_for_sidecar(tool_name: &str) -> Result<(), String> {
    if SIDECAR_RESERVED_TOOL_NAMES.contains(&tool_name) {
        Err(format!(
            "tool {tool_name} is reserved for Mini-Term task control and cannot be called from a sidecar backend"
        ))
    } else {
        Ok(())
    }
}

pub fn execute_sidecar_tool_call(task_id: &str, tool_name: &str, arguments: Value) -> Value {
    let _ = record_runtime_event(
        "task-tool-call-requested",
        format!("Task {task_id} requested brokered tool {tool_name}."),
        Some(json!({
            "taskId": task_id,
            "toolName": tool_name,
        })),
    );

    let Some(tool) = find_tool(tool_name) else {
        return tool_denied_envelope(tool_name, "unknown tool");
    };

    if let Err(reason) = is_tool_allowed_for_sidecar(tool.name) {
        let _ = record_runtime_event(
            "task-tool-call-denied",
            format!("Task {task_id} was denied brokered tool {tool_name}."),
            Some(json!({
                "taskId": task_id,
                "toolName": tool_name,
                "reason": reason,
            })),
        );
        return tool_denied_envelope(tool_name, &reason);
    }

    let mut result = match invoke_tool_structured(tool.name, arguments) {
        Ok((envelope, _is_error)) => envelope,
        Err(message) => tool_denied_envelope(tool_name, &message),
    };

    let approval_required = result
        .get("approvalRequired")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || result
            .get("requiresConfirmation")
            .and_then(Value::as_bool)
            .unwrap_or(false);

    let workspace_id = get_task_detail(task_id).map(|detail| detail.summary.workspace_id);
    let _ = record_runtime_event(
        if approval_required {
            "task-tool-call-approval-pending"
        } else {
            "task-tool-call-completed"
        },
        if approval_required {
            format!("Task {task_id} brokered tool {tool_name} requires approval before execution.")
        } else {
            format!("Task {task_id} brokered tool {tool_name} completed.")
        },
        Some(json!({
            "taskId": task_id,
            "workspaceId": workspace_id,
            "toolName": tool_name,
            "approvalRequired": approval_required,
            "ok": result.get("ok").cloned().unwrap_or(Value::Bool(false)),
        })),
    );

    result = annotate_broker_metadata(result);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::tools::test_support::TestHarness;

    #[test]
    fn sidecar_broker_allows_ping() {
        let _harness = TestHarness::new("sidecar-broker-ping");
        let value = execute_sidecar_tool_call("task-broker", "ping", json!({}));
        assert_eq!(value["ok"], true);
        assert_eq!(value["data"]["status"], "ok");
        assert_eq!(value["broker"]["kind"], "sidecar");
    }

    #[test]
    fn sidecar_broker_denies_recursive_task_control_tools() {
        let _harness = TestHarness::new("sidecar-broker-denied");
        let value = execute_sidecar_tool_call("task-broker", "start_task", json!({}));
        assert_eq!(value["ok"], false);
        assert_eq!(value["error"]["code"], "TOOL_DENIED");
    }

    #[test]
    fn sidecar_broker_preserves_approval_envelopes() {
        let harness = TestHarness::new("sidecar-broker-approval");
        let value = execute_sidecar_tool_call(
            "task-broker",
            "write_file",
            json!({
                "path": format!("{}/notes.txt", harness.workspace_path()),
                "content": "hello"
            }),
        );

        assert_eq!(value["ok"], false);
        assert_eq!(value["approvalRequired"], true);
        assert_eq!(value["status"], "approval-pending");
    }
}
