use crate::agent_backend_runtime::{start_sidecar_session, SidecarStartRequest};
use crate::agent_backends::{
    classify_backend_runtime_error, find_agent_backend,
    list_agent_backends as list_registered_agent_backends, mark_backend_error, mark_backend_ready,
    mark_backend_starting, AgentBackendKind, AgentBackendRuntimeStatus,
};
use crate::agent_core::{
    approval::{list_approvals, set_approval_status},
    models::{
        AgentActionResult, ApprovalDecision, ApprovalRequest, SpawnWorkerInput, StartTaskInput,
        TaskContextPreset,
    },
    task_runtime::{
        get_task_status, list_attention_tasks, list_task_runtime_events, request_task_close,
        resume_session, save_task_plan, send_task_input, spawn_worker_task_with_retry,
        start_task_with_retry,
    },
    task_store::list_visible_task_details,
    workspace_context::{get_workspace_context, list_workspaces},
};
use crate::agent_ext::mcp_interop::{
    list_external_mcp_servers, sync_external_mcp_servers, ExternalMcpSyncRequest,
};
use crate::agent_policy::{
    build_task_injection_preview, export_policy_bundle, get_default_policy_profile,
    get_effective_policy_for_task, get_policy_profile, install_mcp_client_config,
    list_policy_profiles, reset_policy_profile, save_policy_profile, AgentClientType,
    AgentPolicyProfile,
};
use crate::mcp_host::{call_embedded_mcp_tool, get_embedded_mcp_launch, list_embedded_mcp_tools};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBackendConnectionTestResult {
    pub backend_id: String,
    pub ok: bool,
    pub status: AgentBackendRuntimeStatus,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_handshake_at: Option<u64>,
}

fn now_timestamp_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
pub fn list_agent_workspaces() -> Result<serde_json::Value, String> {
    serde_json::to_value(list_workspaces()).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn list_agent_backends() -> Result<serde_json::Value, String> {
    serde_json::to_value(list_registered_agent_backends()).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn test_agent_backend_connection(backend_id: String) -> Result<serde_json::Value, String> {
    let backend = find_agent_backend(&backend_id)
        .ok_or_else(|| format!("unknown agent backend: {backend_id}"))?;

    let result = if backend.kind != AgentBackendKind::Sidecar {
        AgentBackendConnectionTestResult {
            backend_id: backend.backend_id.clone(),
            ok: true,
            status: AgentBackendRuntimeStatus::Ready,
            message: "Built-in backend is managed directly by Mini-Term.".to_string(),
            last_handshake_at: backend.last_handshake_at,
        }
    } else if !backend.configured {
        AgentBackendConnectionTestResult {
            backend_id: backend.backend_id.clone(),
            ok: false,
            status: backend.status,
            message: backend
                .status_message
                .clone()
                .unwrap_or_else(|| "Sidecar backend is not configured.".to_string()),
            last_handshake_at: backend.last_handshake_at,
        }
    } else {
        mark_backend_starting(
            &backend.backend_id,
            format!(
                "Testing backend {} launch and handshake.",
                backend.display_name
            ),
        );

        let current_dir = std::env::current_dir()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".to_string());
        let task_id = format!("backend-test-{}", uuid::Uuid::now_v7());
        let session_id = format!("backend-test-session-{}", uuid::Uuid::now_v7());

        match start_sidecar_session(SidecarStartRequest {
            backend: &backend,
            task_id: &task_id,
            session_id: &session_id,
            prompt: "Mini-Term backend launch test. No task execution is required.",
            cwd: &current_dir,
            title: &format!("{} Test Launch", backend.display_name),
        }) {
            Ok(started) => {
                let last_handshake_at = now_timestamp_ms();
                mark_backend_ready(
                    &backend.backend_id,
                    format!(
                        "Handshake verified with {} {}.",
                        started.handshake.agent_name, started.handshake.agent_version
                    ),
                    last_handshake_at,
                    Some(started.handshake.capabilities.clone()),
                );
                let _ = started.controller.close();
                AgentBackendConnectionTestResult {
                    backend_id: backend.backend_id.clone(),
                    ok: true,
                    status: AgentBackendRuntimeStatus::Ready,
                    message: format!(
                        "Launch and handshake succeeded with {} {}.",
                        started.handshake.agent_name, started.handshake.agent_version
                    ),
                    last_handshake_at: Some(last_handshake_at),
                }
            }
            Err(error) => {
                let (status, sanitized_error) =
                    classify_backend_runtime_error(&backend.backend_id, &error);
                mark_backend_error(&backend.backend_id, error.clone());
                AgentBackendConnectionTestResult {
                    backend_id: backend.backend_id.clone(),
                    ok: false,
                    status,
                    message: sanitized_error,
                    last_handshake_at: None,
                }
            }
        }
    };

    serde_json::to_value(result).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn get_agent_workspace_context(
    workspace_id: String,
    preset: Option<String>,
) -> Result<serde_json::Value, String> {
    let preset = match preset.as_deref() {
        Some("review") => TaskContextPreset::Review,
        Some("standard") => TaskContextPreset::Standard,
        _ => TaskContextPreset::Light,
    };
    serde_json::to_value(get_workspace_context(&workspace_id, preset)?)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn list_agent_tasks() -> Result<serde_json::Value, String> {
    serde_json::to_value(list_visible_task_details()).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn get_agent_task_status(task_id: String) -> Result<serde_json::Value, String> {
    serde_json::to_value(get_task_status(&task_id)?).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn list_attention_task_summaries() -> Result<serde_json::Value, String> {
    serde_json::to_value(list_attention_tasks()).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn list_approval_requests() -> Result<serde_json::Value, String> {
    serde_json::to_value(list_approvals()).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn resolve_approval_request(
    request_id: String,
    approved: bool,
) -> Result<serde_json::Value, String> {
    let status = if approved {
        ApprovalDecision::Approved
    } else {
        ApprovalDecision::Rejected
    };
    let result: ApprovalRequest = set_approval_status(&request_id, status)?;
    serde_json::to_value(result).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn start_agent_task(input: StartTaskInput) -> Result<serde_json::Value, String> {
    serde_json::to_value(start_task_with_retry(input)?).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn spawn_worker_agent_task(input: SpawnWorkerInput) -> Result<serde_json::Value, String> {
    serde_json::to_value(spawn_worker_task_with_retry(input)?).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn send_agent_task_input(task_id: String, input: String) -> Result<serde_json::Value, String> {
    serde_json::to_value(send_task_input(&task_id, &input)?).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn close_agent_task(
    task_id: String,
    approval_request_id: Option<String>,
    cascade_children: Option<bool>,
) -> Result<serde_json::Value, String> {
    let result: AgentActionResult<_> = request_task_close(
        &task_id,
        approval_request_id.as_deref(),
        cascade_children.unwrap_or(false),
    )?;
    serde_json::to_value(result).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn resume_agent_task(task_id: String) -> Result<serde_json::Value, String> {
    serde_json::to_value(resume_session(&task_id)?).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn list_agent_task_events(
    task_id: String,
    limit: Option<usize>,
    include_related: Option<bool>,
) -> Result<serde_json::Value, String> {
    serde_json::to_value(list_task_runtime_events(
        &task_id,
        limit,
        include_related.unwrap_or(false),
    )?)
    .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn save_agent_task_plan(
    task_id: String,
    markdown: String,
    title: Option<String>,
    file_name: Option<String>,
) -> Result<serde_json::Value, String> {
    serde_json::to_value(save_task_plan(
        &task_id,
        &markdown,
        title.as_deref(),
        file_name.as_deref(),
    )?)
    .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn list_agent_policy_profiles() -> Result<serde_json::Value, String> {
    serde_json::to_value(list_policy_profiles()).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn get_agent_policy_profile(profile_id: String) -> Result<serde_json::Value, String> {
    serde_json::to_value(get_policy_profile(&profile_id)?).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn get_default_agent_policy_profile(profile_id: String) -> Result<serde_json::Value, String> {
    serde_json::to_value(get_default_policy_profile(&profile_id)?).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn save_agent_policy_profile(profile: AgentPolicyProfile) -> Result<serde_json::Value, String> {
    serde_json::to_value(save_policy_profile(profile)?).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn reset_agent_policy_profile(profile_id: String) -> Result<serde_json::Value, String> {
    serde_json::to_value(reset_policy_profile(&profile_id)?).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn export_agent_policy_bundle(
    client_type: AgentClientType,
    workspace_id: Option<String>,
) -> Result<serde_json::Value, String> {
    serde_json::to_value(export_policy_bundle(client_type, workspace_id)?)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn install_mcp_client_config_command(
    client_type: AgentClientType,
) -> Result<serde_json::Value, String> {
    serde_json::to_value(install_mcp_client_config(client_type)?).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn get_task_injection_preview(
    target: crate::agent_core::models::TaskTarget,
    workspace_id: String,
    preset: TaskContextPreset,
    prompt: String,
) -> Result<serde_json::Value, String> {
    serde_json::to_value(build_task_injection_preview(
        &workspace_id,
        target,
        preset,
        &prompt,
    )?)
    .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn get_task_effective_policy(task_id: String) -> Result<serde_json::Value, String> {
    serde_json::to_value(get_effective_policy_for_task(&task_id)?).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn get_embedded_mcp_launch_info() -> Result<serde_json::Value, String> {
    serde_json::to_value(get_embedded_mcp_launch()).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn list_embedded_mcp_tools_command() -> Result<serde_json::Value, String> {
    list_embedded_mcp_tools()
}

#[tauri::command]
pub fn call_embedded_mcp_tool_command(
    name: String,
    arguments: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    call_embedded_mcp_tool(&name, arguments.unwrap_or_else(|| serde_json::json!({})))
}

#[tauri::command]
pub fn list_external_mcp_servers_command() -> Result<serde_json::Value, String> {
    serde_json::to_value(list_external_mcp_servers()?).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn sync_external_mcp_servers_command(
    request: ExternalMcpSyncRequest,
) -> Result<serde_json::Value, String> {
    serde_json::to_value(sync_external_mcp_servers(request)?).map_err(|err| err.to_string())
}
