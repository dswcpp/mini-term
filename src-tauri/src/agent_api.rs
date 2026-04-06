use crate::agent_backends::list_agent_backends as list_registered_agent_backends;
use crate::agent_core::{
    approval::{list_approvals, set_approval_status},
    models::{
        AgentActionResult, ApprovalDecision, ApprovalRequest, StartTaskInput, TaskContextPreset,
    },
    task_runtime::{
        get_task_status, list_attention_tasks, request_task_close, resume_session, save_task_plan,
        send_task_input, start_task,
    },
    task_store::list_task_details,
    workspace_context::{get_workspace_context, list_workspaces},
};
use crate::agent_policy::{
    build_task_injection_preview, export_policy_bundle, get_default_policy_profile,
    get_effective_policy_for_task, get_policy_profile, install_mcp_client_config,
    list_policy_profiles, reset_policy_profile, save_policy_profile, AgentClientType,
    AgentPolicyProfile,
};
use crate::mcp_host::{call_embedded_mcp_tool, get_embedded_mcp_launch, list_embedded_mcp_tools};

#[tauri::command]
pub fn list_agent_workspaces() -> Result<serde_json::Value, String> {
    serde_json::to_value(list_workspaces()).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn list_agent_backends() -> Result<serde_json::Value, String> {
    serde_json::to_value(list_registered_agent_backends()).map_err(|err| err.to_string())
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
    serde_json::to_value(list_task_details()).map_err(|err| err.to_string())
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
    serde_json::to_value(start_task(input)?).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn send_agent_task_input(task_id: String, input: String) -> Result<serde_json::Value, String> {
    serde_json::to_value(send_task_input(&task_id, &input)?).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn close_agent_task(
    task_id: String,
    approval_request_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let result: AgentActionResult<_> =
        request_task_close(&task_id, approval_request_id.as_deref())?;
    serde_json::to_value(result).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn resume_agent_task(task_id: String) -> Result<serde_json::Value, String> {
    serde_json::to_value(resume_session(&task_id)?).map_err(|err| err.to_string())
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
