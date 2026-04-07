use super::approval::{
    create_approval_request, get_approval, get_approval_by_key, set_approval_status,
};
use super::data_dir::{ensure_parent, logs_dir, task_artifacts_dir};
use super::git_context::get_git_summary;
use super::models::{
    AgentActionResult, ApprovalDecision, ApprovalRequest, ApprovalRiskLevel, PendingApprovalResult,
    SpawnWorkerInput, StartTaskInput, TaskArtifact, TaskArtifactKind, TaskAttentionState,
    TaskContextPreset, TaskRole, TaskStatusDetail, TaskSummary, TaskTerminationCause,
};
use super::task_store::{
    collect_descendant_task_ids, collect_related_task_ids, get_task_detail,
    list_visible_task_details, update_task, upsert_task_detail,
};
use super::workspace_context::{get_workspace_context, validate_task_working_directory};
use crate::agent_backend_runtime::{
    build_launch_command, start_sidecar_session, BackendLaunchRequest, BackendLaunchSpec,
    SidecarAttentionState, SidecarEvent, SidecarSessionController, SidecarStartRequest,
    StartedSidecarSession,
};
use crate::agent_backends::{
    classify_backend_runtime_error, default_backend_for_target, find_agent_backend,
    mark_backend_error, mark_backend_ready, mark_backend_starting, AgentBackendDescriptor,
    AgentBackendKind,
};
use crate::agent_policy::build_injected_prompt;
use crate::runtime_mcp::{load_runtime_state, record_runtime_event, RuntimeEvent};
use portable_pty::{native_pty_system, ChildKiller, PtySize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

trait TaskController: Send {
    fn send_input(&mut self, input: &str) -> Result<(), String>;
    fn close(&mut self) -> Result<(), String>;
    fn remove_after_close(&self) -> bool {
        false
    }
}

struct BuiltinCliTaskController {
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

impl TaskController for BuiltinCliTaskController {
    fn send_input(&mut self, input: &str) -> Result<(), String> {
        write_interactive_input(&mut *self.writer, input)
    }

    fn close(&mut self) -> Result<(), String> {
        if let Err(err) = self.killer.kill() {
            let message = err.to_string();
            if !message.contains("os error 0") {
                return Err(message);
            }
        }
        Ok(())
    }
}

struct SidecarTaskController {
    session: SidecarSessionController,
}

impl TaskController for SidecarTaskController {
    fn send_input(&mut self, input: &str) -> Result<(), String> {
        self.session.send_input(input)
    }

    fn close(&mut self) -> Result<(), String> {
        self.session.close()
    }

    fn remove_after_close(&self) -> bool {
        true
    }
}

struct RunningTaskHandle {
    controller: Box<dyn TaskController>,
    pending_initial_input: Option<String>,
    trust_prompt_handled: bool,
}

#[derive(Default)]
pub struct TaskRuntime {
    running: Mutex<HashMap<String, RunningTaskHandle>>,
}

static TASK_RUNTIME: OnceLock<TaskRuntime> = OnceLock::new();

fn runtime() -> &'static TaskRuntime {
    TASK_RUNTIME.get_or_init(TaskRuntime::default)
}

fn now_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn generate_id(prefix: &str) -> String {
    format!("{prefix}-{}", Uuid::now_v7())
}

#[cfg(test)]
fn bind_thread_data_dir(data_dir: &PathBuf) {
    crate::agent_core::data_dir::set_thread_data_dir(data_dir.clone());
}

#[cfg(not(test))]
fn bind_thread_data_dir(_: &PathBuf) {}

fn clamp_excerpt(text: &str, max_len: usize) -> String {
    let mut chars = text.chars().rev().take(max_len).collect::<Vec<_>>();
    chars.reverse();
    chars.into_iter().collect()
}

fn build_task_title(input: &StartTaskInput) -> String {
    input
        .title
        .clone()
        .filter(|title| !title.trim().is_empty())
        .unwrap_or_else(|| format!("{} task", input.target.as_str()))
}

fn resolve_task_backend(input: &StartTaskInput) -> Result<AgentBackendDescriptor, String> {
    let requested_backend_id = input
        .backend_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let backend = if let Some(backend_id) = requested_backend_id {
        find_agent_backend(backend_id)
            .ok_or_else(|| format!("unknown agent backend: {backend_id}"))?
    } else {
        default_backend_for_target(&input.target).ok_or_else(|| {
            format!(
                "no backend registered for target: {}",
                input.target.as_str()
            )
        })?
    };

    if backend.target != input.target.clone() {
        return Err(format!(
            "backend {} does not support target {}",
            backend.backend_id,
            input.target.as_str()
        ));
    }

    Ok(backend)
}

fn build_prompt_with_context(input: &StartTaskInput) -> Result<String, String> {
    let context = get_workspace_context(&input.workspace_id, input.context_preset.clone())?;
    let mut sections = vec![
        format!("Workspace: {}", context.workspace.name),
        format!(
            "Primary root: {}",
            context.workspace.primary_root_path.unwrap_or_default()
        ),
        format!("User request:\n{}", input.prompt.trim()),
    ];

    if !context.instructions.is_empty() {
        let joined = context
            .instructions
            .iter()
            .map(|doc| format!("## {}\nPath: {}\n{}", doc.label, doc.path, doc.content))
            .collect::<Vec<_>>()
            .join("\n\n");
        sections.push(format!("Workspace instructions:\n{joined}"));
    }

    if matches!(
        input.context_preset,
        TaskContextPreset::Standard | TaskContextPreset::Review
    ) && !context.git_summary.changed_files.is_empty()
    {
        let git_summary = context
            .git_summary
            .changed_files
            .iter()
            .take(30)
            .map(|item| format!("- [{}] {}", item.status_label, item.path))
            .collect::<Vec<_>>()
            .join("\n");
        sections.push(format!("Current git changes:\n{git_summary}"));
    }

    if !context.recent_sessions.is_empty() {
        let recent = context
            .recent_sessions
            .iter()
            .take(5)
            .map(|session| format!("- {} :: {}", session.session_type, session.title))
            .collect::<Vec<_>>()
            .join("\n");
        sections.push(format!("Recent AI sessions:\n{recent}"));
    }

    if matches!(input.context_preset, TaskContextPreset::Review)
        && !context.related_files.is_empty()
    {
        let related = context
            .related_files
            .iter()
            .map(|doc| format!("## {}\nPath: {}\n{}", doc.label, doc.path, doc.content))
            .collect::<Vec<_>>()
            .join("\n\n");
        sections.push(format!("Related files:\n{related}"));
    }

    let base_prompt = sections.join("\n\n");
    let preview = build_injected_prompt(
        &input.workspace_id,
        input.target.clone(),
        input.context_preset.clone(),
        &base_prompt,
    )?;
    Ok(preview.final_prompt)
}

fn log_path(task_id: &str) -> PathBuf {
    logs_dir().join(format!("{task_id}.log"))
}

fn task_plan_path(task_id: &str, file_name: &str) -> PathBuf {
    task_artifacts_dir(task_id).join(file_name)
}

fn sanitize_artifact_file_name(file_name: Option<&str>) -> String {
    let trimmed = file_name.unwrap_or("plan.md").trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains(['/', '\\', ':'])
        || trimmed
            .chars()
            .any(|ch| ch.is_control() || matches!(ch, '<' | '>' | '"' | '|' | '?' | '*'))
    {
        return "plan.md".to_string();
    }
    trimmed.to_string()
}

fn write_text_file_atomically(path: &Path, content: &str) -> Result<(), String> {
    ensure_parent(path)?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("artifact");
    let tmp_path = path.with_file_name(format!(".{file_name}.{}.tmp", Uuid::now_v7()));
    fs::write(&tmp_path, content).map_err(|err| err.to_string())?;
    if path.exists() {
        fs::remove_file(path).map_err(|err| err.to_string())?;
    }
    fs::rename(&tmp_path, path).map_err(|err| {
        let _ = fs::remove_file(&tmp_path);
        err.to_string()
    })
}

fn is_terminal_task(detail: &TaskStatusDetail) -> bool {
    detail.summary.termination_cause.is_some()
        || matches!(detail.summary.status.as_str(), "error" | "exited")
}

fn running_task_exists(task_id: &str) -> bool {
    runtime().running.lock().unwrap().contains_key(task_id)
}

fn collect_running_descendant_task_ids(task_id: &str) -> Vec<String> {
    collect_descendant_task_ids(task_id)
        .into_iter()
        .filter(|descendant_task_id| running_task_exists(descendant_task_id))
        .collect()
}

fn value_matches_task_ids(value: &Value, task_ids: &HashSet<String>) -> bool {
    match value {
        Value::String(task_id) => task_ids.contains(task_id),
        Value::Array(values) => values
            .iter()
            .any(|item| value_matches_task_ids(item, task_ids)),
        _ => false,
    }
}

fn event_matches_task_ids(event: &RuntimeEvent, task_ids: &HashSet<String>) -> bool {
    let Some(payload) = event.payload_preview.as_ref().and_then(Value::as_object) else {
        return false;
    };

    ["taskId", "parentTaskId", "taskIds", "descendantTaskIds"]
        .into_iter()
        .filter_map(|key| payload.get(key))
        .any(|value| value_matches_task_ids(value, task_ids))
}

fn initialize_task_record(
    input: &StartTaskInput,
    backend: &AgentBackendDescriptor,
    workspace_name: String,
    workspace_root_path: String,
    cwd: String,
    user_prompt_preview: &str,
) -> TaskStatusDetail {
    let now = now_timestamp_ms();
    let task_id = generate_id("task");
    let injection_preview = build_injected_prompt(
        &input.workspace_id,
        input.target.clone(),
        input.context_preset.clone(),
        &input.prompt,
    )
    .ok();
    let summary = TaskSummary {
        task_id: task_id.clone(),
        workspace_id: input.workspace_id.clone(),
        workspace_name,
        workspace_root_path,
        target: input.target.clone(),
        role: input.role.clone(),
        parent_task_id: input
            .parent_task_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        backend_id: Some(backend.backend_id.clone()),
        backend_display_name: Some(backend.display_name.clone()),
        title: build_task_title(input),
        status: "starting".to_string(),
        attention_state: TaskAttentionState::Running,
        session_id: task_id.clone(),
        cwd,
        started_at: now,
        updated_at: now,
        completed_at: None,
        exit_code: None,
        context_preset: input.context_preset.clone(),
        changed_files: Vec::new(),
        prompt_preview: clamp_excerpt(user_prompt_preview.trim(), 2_000),
        last_output_excerpt: String::new(),
        injection_profile_id: injection_preview.as_ref().and_then(|preview| {
            if preview.profile_id.trim().is_empty() {
                None
            } else {
                Some(preview.profile_id.clone())
            }
        }),
        injection_preset: injection_preview.as_ref().and_then(|preview| {
            if preview.profile_id.trim().is_empty() {
                None
            } else {
                Some(preview.preset.clone())
            }
        }),
        policy_summary: injection_preview.as_ref().and_then(|preview| {
            if preview.profile_id.trim().is_empty() {
                None
            } else {
                Some(preview.policy_summary.clone())
            }
        }),
        termination_cause: None,
        retry_superseded: false,
        superseded_by_task_id: None,
    };

    TaskStatusDetail {
        summary,
        recent_output_excerpt: String::new(),
        diff_summary: Vec::new(),
        log_path: log_path(&task_id).to_string_lossy().to_string(),
        artifacts: Vec::new(),
    }
}

fn append_output(task_id: &str, chunk: &str) {
    let path = log_path(task_id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).ok();
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(chunk.as_bytes());
    }
}

fn apply_output_update(detail: &mut TaskStatusDetail, chunk_excerpt: &str) {
    let merged = format!("{}{}", detail.recent_output_excerpt, chunk_excerpt);
    detail.recent_output_excerpt = clamp_excerpt(&merged, 4_000);
    detail.summary.last_output_excerpt = detail.recent_output_excerpt.clone();
    if !is_terminal_task(detail) {
        detail.summary.status = "running".to_string();
    }
}

fn is_workspace_trust_prompt(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("trust the contents of this directory")
        || lower.contains("trust this directory")
        || lower.contains("trust this folder")
        || lower.contains("press enter to continue")
}

fn write_interactive_input(writer: &mut (dyn Write + Send), input: &str) -> Result<(), String> {
    writer
        .write_all(format!("{input}\r").as_bytes())
        .map_err(|err| err.to_string())?;
    writer.flush().map_err(|err| err.to_string())
}

fn flush_pending_initial_input(task_id: &str) -> Result<bool, String> {
    let mut running = runtime().running.lock().unwrap();
    let Some(handle) = running.get_mut(task_id) else {
        return Ok(false);
    };
    let Some(input) = handle.pending_initial_input.take() else {
        return Ok(false);
    };
    handle.controller.send_input(&input)?;
    Ok(true)
}

fn submit_workspace_trust_continue(task_id: &str) -> Result<bool, String> {
    let mut running = runtime().running.lock().unwrap();
    let Some(handle) = running.get_mut(task_id) else {
        return Ok(false);
    };
    if handle.pending_initial_input.is_none() || handle.trust_prompt_handled {
        return Ok(false);
    }
    handle.trust_prompt_handled = true;
    handle.controller.send_input("").map(|_| true)
}

fn schedule_pending_initial_input(task_id: String, delay: Duration) {
    let data_dir = crate::agent_core::data_dir::app_data_dir();
    thread::spawn(move || {
        bind_thread_data_dir(&data_dir);
        thread::sleep(delay);
        let _ = flush_pending_initial_input(&task_id);
    });
}

fn schedule_workspace_trust_continue(task_id: String, delay: Duration) {
    let data_dir = crate::agent_core::data_dir::app_data_dir();
    thread::spawn(move || {
        bind_thread_data_dir(&data_dir);
        thread::sleep(delay);
        if submit_workspace_trust_continue(&task_id).unwrap_or(false) {
            schedule_pending_initial_input(task_id.clone(), Duration::from_millis(750));
        }
    });
}

fn start_pending_initial_input_watch(task_id: String) {
    let data_dir = crate::agent_core::data_dir::app_data_dir();
    thread::spawn(move || {
        bind_thread_data_dir(&data_dir);
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if Instant::now() >= deadline || !running_task_exists(&task_id) {
                break;
            }

            let Some(detail) = get_task_detail(&task_id) else {
                break;
            };
            if detail.summary.termination_cause.is_some() || detail.summary.status == "error" {
                break;
            }

            let excerpt = detail.recent_output_excerpt.trim();
            if !excerpt.is_empty() && !is_workspace_trust_prompt(excerpt) {
                let _ = flush_pending_initial_input(&task_id);
                break;
            }

            thread::sleep(Duration::from_millis(250));
        }
    });
}

fn fail_task_start(task_id: &str, error_message: String) -> String {
    let excerpt = clamp_excerpt(&format!("Task startup failed: {error_message}"), 4_000);
    append_output(task_id, &format!("{excerpt}\n"));
    let _ = update_task(task_id, |detail| {
        detail.recent_output_excerpt = excerpt.clone();
        detail.summary.last_output_excerpt = excerpt.clone();
        detail.summary.status = "error".to_string();
        detail.summary.attention_state = TaskAttentionState::Failed;
        detail.summary.completed_at = Some(now_timestamp_ms());
        detail.summary.termination_cause = Some(TaskTerminationCause::StartupFailed);
    });
    error_message
}

fn mark_task_retry_superseded(task_id: &str, successor_task_id: &str) -> Result<(), String> {
    let updated = update_task(task_id, |detail| {
        detail.summary.retry_superseded = true;
        detail.summary.superseded_by_task_id = Some(successor_task_id.to_string());
    })?;

    if let Some(summary) = updated.map(|detail| detail.summary) {
        let _ = record_runtime_event(
            "task-retry-superseded",
            format!(
                "Transient startup failure task {} was superseded by retry task {}.",
                summary.task_id, successor_task_id
            ),
            Some(json!({
                "taskId": summary.task_id,
                "supersededByTaskId": successor_task_id,
                "workspaceId": summary.workspace_id,
                "workspaceName": summary.workspace_name,
                "target": summary.target,
                "role": summary.role,
            })),
        );
    }

    Ok(())
}

fn approval_matches_action(request: &ApprovalRequest, tool_name: &str, approval_key: &str) -> bool {
    request.tool_name == tool_name && request.approval_key.as_deref() == Some(approval_key)
}

fn task_event_payload(summary: &TaskSummary) -> serde_json::Value {
    json!({
        "taskId": summary.task_id.clone(),
        "workspaceId": summary.workspace_id.clone(),
        "workspaceName": summary.workspace_name.clone(),
        "target": summary.target.clone(),
        "role": summary.role.clone(),
        "backendId": summary.backend_id.clone(),
        "backendDisplayName": summary.backend_display_name.clone(),
        "parentTaskId": summary.parent_task_id.clone(),
        "status": summary.status.clone(),
        "attentionState": summary.attention_state.clone(),
        "cwd": summary.cwd.clone(),
    })
}

fn approval_payload_for_close_task(
    task_id: &str,
    cascade_children: bool,
    descendant_count: usize,
) -> String {
    if cascade_children {
        format!("Task: {task_id}\nCascadeChildren: true\nDescendantCount: {descendant_count}")
    } else {
        format!("Task: {task_id}")
    }
}

pub(crate) fn is_transient_task_startup_failure(detail: &TaskStatusDetail) -> bool {
    detail.summary.status == "error"
        && detail.summary.exit_code == Some(-1073741502)
        && (detail
            .recent_output_excerpt
            .contains("before producing terminal output")
            || detail
                .recent_output_excerpt
                .contains("Task startup failed:")
            || detail.recent_output_excerpt.contains("0xC0000142")
            || detail.recent_output_excerpt.contains("-1073741502"))
}

fn start_summary_with_retry(
    mut launcher: impl FnMut() -> Result<TaskSummary, String>,
) -> Result<TaskSummary, String> {
    let max_attempts = if cfg!(windows) { 3 } else { 1 };
    let startup_poll_intervals = [
        Duration::from_millis(150),
        Duration::from_millis(250),
        Duration::from_millis(400),
    ];
    let mut pending_superseded_task_id: Option<String> = None;

    for attempt in 1..=max_attempts {
        let summary = launcher()?;
        if let Some(previous_task_id) = pending_superseded_task_id.take() {
            mark_task_retry_superseded(&previous_task_id, &summary.task_id)?;
        }
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

        pending_superseded_task_id = Some(summary.task_id.clone());
    }

    Err("task retry attempts exhausted".to_string())
}

fn record_task_started_event(summary: &TaskSummary, backend: &AgentBackendDescriptor) {
    let _ = record_runtime_event(
        "task-started",
        format!(
            "Task {} started with backend {}.",
            summary.task_id, backend.display_name
        ),
        Some(task_event_payload(summary)),
    );
}

fn sidecar_preflight_error(backend: &AgentBackendDescriptor) -> Option<String> {
    if !backend.requires_ready_preflight() || backend.available {
        return None;
    }

    Some(match backend.status {
        crate::agent_backends::AgentBackendRuntimeStatus::Unconfigured => backend
            .status_message
            .clone()
            .unwrap_or_else(|| format!("backend {} is not configured", backend.backend_id)),
        crate::agent_backends::AgentBackendRuntimeStatus::Configured => {
            backend.status_message.clone().unwrap_or_else(|| {
                format!(
                    "backend {} is configured but has not completed a successful launch handshake",
                    backend.backend_id
                )
            })
        }
        crate::agent_backends::AgentBackendRuntimeStatus::Starting => backend
            .status_message
            .clone()
            .unwrap_or_else(|| format!("backend {} is currently starting", backend.backend_id)),
        crate::agent_backends::AgentBackendRuntimeStatus::Degraded
        | crate::agent_backends::AgentBackendRuntimeStatus::Error => backend
            .last_error
            .clone()
            .or_else(|| backend.status_message.clone())
            .unwrap_or_else(|| format!("backend {} is not ready", backend.backend_id)),
        crate::agent_backends::AgentBackendRuntimeStatus::Ready => {
            format!(
                "backend {} unexpectedly reported unavailable",
                backend.backend_id
            )
        }
    })
}

fn apply_sidecar_attention_update(
    detail: &mut TaskStatusDetail,
    state: SidecarAttentionState,
    message: Option<&str>,
) {
    if let Some(message) = message {
        let excerpt = clamp_excerpt(message, 2_000);
        apply_output_update(detail, &excerpt);
    }
    match state {
        SidecarAttentionState::Running => {
            detail.summary.status = "running".to_string();
            detail.summary.attention_state = TaskAttentionState::Running;
        }
        SidecarAttentionState::WaitingInput => {
            detail.summary.status = "waiting-input".to_string();
            detail.summary.attention_state = TaskAttentionState::WaitingInput;
        }
        SidecarAttentionState::NeedsReview => {
            detail.summary.status = "running".to_string();
            detail.summary.attention_state = TaskAttentionState::NeedsReview;
        }
    }
}

fn apply_task_exit(
    detail: &mut TaskStatusDetail,
    exit_code: Option<i32>,
    git_summary: Option<&super::models::GitSummary>,
    synthesized_exit_message: Option<&str>,
) {
    let termination_cause = detail.summary.termination_cause.clone();
    detail.summary.exit_code = exit_code;
    detail.summary.completed_at = Some(now_timestamp_ms());
    if let Some(git_summary) = git_summary {
        detail.summary.changed_files = git_summary.changed_files.clone();
        detail.diff_summary = git_summary.changed_files.clone();
    }
    if let Some(cause) = termination_cause {
        match cause {
            TaskTerminationCause::ManualClose => {
                detail.summary.status = "exited".to_string();
                detail.summary.attention_state = TaskAttentionState::Completed;
                return;
            }
            TaskTerminationCause::StartupFailed => {
                detail.summary.status = "error".to_string();
                detail.summary.attention_state = TaskAttentionState::Failed;
                return;
            }
            TaskTerminationCause::ProcessExit => {}
        }
    }
    if detail.recent_output_excerpt.trim().is_empty() {
        if let Some(message) = synthesized_exit_message {
            detail.recent_output_excerpt = message.to_string();
            detail.summary.last_output_excerpt = message.to_string();
        }
    }
    detail.summary.termination_cause = Some(TaskTerminationCause::ProcessExit);
    detail.summary.status = if exit_code.unwrap_or_default() == 0 {
        "exited".to_string()
    } else {
        "error".to_string()
    };
    detail.summary.attention_state = if exit_code.unwrap_or_default() == 0 {
        TaskAttentionState::Completed
    } else {
        TaskAttentionState::Failed
    };
}

fn spawn_sidecar_event_loop(
    task_id: String,
    workspace_root_path: String,
    events: std::sync::mpsc::Receiver<SidecarEvent>,
    display: String,
) {
    let data_dir = crate::agent_core::data_dir::app_data_dir();
    thread::spawn(move || {
        bind_thread_data_dir(&data_dir);
        while let Ok(event) = events.recv() {
            match event {
                SidecarEvent::Handshake {
                    task_id: event_task_id,
                    handshake,
                } => {
                    let _ = (event_task_id, handshake);
                }
                SidecarEvent::Started {
                    session_id,
                    task_id: event_task_id,
                } => {
                    let _ = record_runtime_event(
                        "task-sidecar-started",
                        format!(
                            "Sidecar session {} started for task {}.",
                            session_id, event_task_id
                        ),
                        Some(json!({
                            "taskId": event_task_id,
                            "sessionId": session_id,
                        })),
                    );
                }
                SidecarEvent::Output {
                    task_id: event_task_id,
                    chunk,
                } => {
                    let _ = event_task_id;
                    append_output(&task_id, &chunk);
                    let chunk_excerpt = clamp_excerpt(&chunk, 2_000);
                    let _ = update_task(&task_id, |detail| {
                        apply_output_update(detail, &chunk_excerpt);
                    });
                }
                SidecarEvent::Attention {
                    task_id: event_task_id,
                    state,
                    message,
                } => {
                    let _ = event_task_id;
                    if let Some(message) = &message {
                        append_output(&task_id, &format!("{message}\n"));
                    }
                    let _ = update_task(&task_id, |detail| {
                        apply_sidecar_attention_update(detail, state.clone(), message.as_deref());
                    });
                }
                SidecarEvent::Exited {
                    task_id: event_task_id,
                    exit_code,
                } => {
                    let _ = event_task_id;
                    let git_summary = get_git_summary(&workspace_root_path).ok();
                    let synthesized_exit_message = if exit_code == 0 {
                        None
                    } else {
                        Some(format!(
                            "Sidecar task process exited with code {exit_code}. Launch: {}",
                            display
                        ))
                    };
                    if let Some(message) = &synthesized_exit_message {
                        append_output(&task_id, &format!("{message}\n"));
                    }
                    let _ = update_task(&task_id, |detail| {
                        apply_task_exit(
                            detail,
                            Some(exit_code),
                            git_summary.as_ref(),
                            synthesized_exit_message.as_deref(),
                        );
                    });
                    runtime().running.lock().unwrap().remove(&task_id);
                    break;
                }
            }
        }
        runtime().running.lock().unwrap().remove(&task_id);
    });
}

pub fn start_task(input: StartTaskInput) -> Result<TaskSummary, String> {
    let validated = validate_task_working_directory(&input.workspace_id, input.cwd.as_deref())?;
    let workspace_name = validated.workspace_name.clone();
    let workspace_root_path = validated.workspace_root_path.clone();
    let cwd = validated.cwd.clone();
    let backend = resolve_task_backend(&input)?;
    let prompt = build_prompt_with_context(&input)?;
    let initial_detail = initialize_task_record(
        &input,
        &backend,
        workspace_name,
        workspace_root_path.clone(),
        cwd.clone(),
        &input.prompt,
    );
    let task_id = initial_detail.summary.task_id.clone();
    upsert_task_detail(initial_detail.clone())?;

    if backend.kind == AgentBackendKind::Sidecar {
        if let Some(preflight_error) = sidecar_preflight_error(&backend) {
            return Err(fail_task_start(&task_id, preflight_error));
        }

        mark_backend_starting(
            &backend.backend_id,
            format!("Launching sidecar session for task {}.", task_id),
        );
        let started_session = start_sidecar_session(SidecarStartRequest {
            backend: &backend,
            task_id: &task_id,
            session_id: &initial_detail.summary.session_id,
            prompt: &prompt,
            cwd: &cwd,
            title: &initial_detail.summary.title,
        })
        .map_err(|err| {
            let (_status, sanitized_error) =
                classify_backend_runtime_error(&backend.backend_id, &err);
            mark_backend_error(&backend.backend_id, err.clone());
            let _ = record_runtime_event(
                "task-sidecar-handshake-failed",
                format!(
                    "Sidecar handshake failed for task {} using backend {}.",
                    task_id, backend.backend_id
                ),
                Some(json!({
                    "taskId": task_id,
                    "backendId": backend.backend_id,
                    "error": sanitized_error.clone(),
                })),
            );
            fail_task_start(&task_id, sanitized_error)
        })?;

        let StartedSidecarSession {
            controller,
            events,
            display,
            initial_input,
            handshake,
        } = started_session;
        let should_watch_initial_input = initial_input.is_some();
        let handshake_timestamp = now_timestamp_ms();
        mark_backend_ready(
            &backend.backend_id,
            format!(
                "Sidecar handshake completed with {} {}.",
                handshake.agent_name, handshake.agent_version
            ),
            handshake_timestamp,
            Some(handshake.capabilities.clone()),
        );
        let _ = record_runtime_event(
            "task-sidecar-handshake-succeeded",
            format!(
                "Sidecar handshake completed for task {} using backend {}.",
                task_id, backend.backend_id
            ),
            Some(json!({
                "taskId": task_id,
                "backendId": backend.backend_id,
                "protocolVersion": handshake.protocol_version,
                "agentName": handshake.agent_name,
                "agentVersion": handshake.agent_version,
                "lastHandshakeAt": handshake_timestamp,
            })),
        );

        runtime().running.lock().unwrap().insert(
            task_id.clone(),
            RunningTaskHandle {
                controller: Box::new(SidecarTaskController {
                    session: controller,
                }),
                pending_initial_input: initial_input,
                trust_prompt_handled: false,
            },
        );

        if let Err(err) = update_task(&task_id, |detail| {
            detail.summary.status = "running".to_string();
            detail.summary.attention_state = TaskAttentionState::Running;
        }) {
            if let Some(mut handle) = runtime().running.lock().unwrap().remove(&task_id) {
                let _ = handle.controller.close();
            }
            return Err(fail_task_start(&task_id, err));
        }

        if let Some(started_summary) = get_task_detail(&task_id).map(|detail| detail.summary) {
            record_task_started_event(&started_summary, &backend);
        }

        spawn_sidecar_event_loop(
            task_id.clone(),
            initial_detail.summary.workspace_root_path.clone(),
            events,
            display,
        );

        if should_watch_initial_input {
            start_pending_initial_input_watch(task_id.clone());
        }

        return Ok(get_task_detail(&task_id)
            .map(|detail| detail.summary)
            .unwrap_or(initial_detail.summary));
    }

    let BackendLaunchSpec {
        builder,
        display: launch_display,
        initial_input,
    } = build_launch_command(BackendLaunchRequest {
        backend: &backend,
        prompt: &prompt,
        cwd: &cwd,
        title: &initial_detail.summary.title,
    })
    .map_err(|err| fail_task_start(&task_id, err))?;

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 32,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| fail_task_start(&task_id, err.to_string()))?;
    let should_watch_initial_input = initial_input.is_some();
    let mut child = pair
        .slave
        .spawn_command(builder)
        .map_err(|err| fail_task_start(&task_id, format!("{err}; launch={launch_display}")))?;
    let mut killer = child.clone_killer();
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(err) => {
            let _ = killer.kill();
            return Err(fail_task_start(&task_id, err.to_string()));
        }
    };
    let mut reader = pair.master.try_clone_reader().map_err(|err| {
        let _ = killer.kill();
        fail_task_start(&task_id, err.to_string())
    })?;

    runtime().running.lock().unwrap().insert(
        task_id.clone(),
        RunningTaskHandle {
            controller: Box::new(BuiltinCliTaskController { writer, killer }),
            pending_initial_input: initial_input,
            trust_prompt_handled: false,
        },
    );

    if let Err(err) = update_task(&task_id, |detail| {
        detail.summary.status = "running".to_string();
        detail.summary.attention_state = TaskAttentionState::Running;
    }) {
        if let Some(mut handle) = runtime().running.lock().unwrap().remove(&task_id) {
            let _ = handle.controller.close();
        }
        return Err(fail_task_start(&task_id, err));
    }

    if let Some(started_summary) = get_task_detail(&task_id).map(|detail| detail.summary) {
        record_task_started_event(&started_summary, &backend);
    }

    let task_id_for_output = task_id.clone();
    let output_data_dir = crate::agent_core::data_dir::app_data_dir();
    thread::spawn(move || {
        bind_thread_data_dir(&output_data_dir);
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(read) => {
                    let chunk = String::from_utf8_lossy(&buf[..read]).into_owned();
                    append_output(&task_id_for_output, &chunk);
                    let chunk_excerpt = clamp_excerpt(&chunk, 2_000);
                    if is_workspace_trust_prompt(&chunk_excerpt) {
                        schedule_workspace_trust_continue(
                            task_id_for_output.clone(),
                            Duration::from_millis(300),
                        );
                    }
                    let _ = update_task(&task_id_for_output, |detail| {
                        apply_output_update(detail, &chunk_excerpt);
                    });
                }
                Err(_) => break,
            }
        }
    });

    if should_watch_initial_input {
        start_pending_initial_input_watch(task_id.clone());
    }

    let task_id_for_exit = task_id.clone();
    let workspace_root_for_exit = initial_detail.summary.workspace_root_path.clone();
    let launch_display_for_exit = launch_display.clone();
    let exit_data_dir = crate::agent_core::data_dir::app_data_dir();
    thread::spawn(move || {
        bind_thread_data_dir(&exit_data_dir);
        let exit_code = child.wait().ok().map(|status| status.exit_code() as i32);
        let git_summary = get_git_summary(&workspace_root_for_exit).ok();
        let synthesized_exit_message = exit_code.and_then(|code| {
            if code != 0 {
                Some(format!(
                    "Task process exited with code {code} before producing terminal output. Launch command: {launch_display_for_exit}"
                ))
            } else {
                None
            }
        });
        if let Some(message) = &synthesized_exit_message {
            append_output(&task_id_for_exit, &format!("{message}\n"));
        }

        let _ = update_task(&task_id_for_exit, |detail| {
            apply_task_exit(
                detail,
                exit_code,
                git_summary.as_ref(),
                synthesized_exit_message.as_deref(),
            );
        });
        runtime().running.lock().unwrap().remove(&task_id_for_exit);
    });

    Ok(get_task_detail(&task_id)
        .map(|detail| detail.summary)
        .unwrap_or(initial_detail.summary))
}

pub fn start_task_with_retry(input: StartTaskInput) -> Result<TaskSummary, String> {
    start_summary_with_retry(|| start_task(input.clone()))
}

fn build_worker_start_input(input: SpawnWorkerInput) -> Result<StartTaskInput, String> {
    let parent = get_task_detail(&input.parent_task_id)
        .ok_or_else(|| format!("task not found: {}", input.parent_task_id))?;
    let parent_summary = parent.summary;
    if parent_summary.role != TaskRole::Coordinator {
        return Err(format!(
            "only coordinator tasks can spawn workers: {}",
            parent_summary.task_id
        ));
    }

    let target = input
        .target
        .clone()
        .unwrap_or(parent_summary.target.clone());
    let backend_id = input
        .backend_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            if target == parent_summary.target {
                parent_summary.backend_id.clone()
            } else {
                None
            }
        });

    Ok(StartTaskInput {
        workspace_id: parent_summary.workspace_id.clone(),
        target,
        prompt: input.prompt,
        context_preset: input
            .context_preset
            .unwrap_or(parent_summary.context_preset.clone()),
        role: TaskRole::Worker,
        parent_task_id: Some(parent_summary.task_id.clone()),
        backend_id,
        cwd: input
            .cwd
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| Some(parent_summary.cwd.clone())),
        title: input
            .title
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
    })
}

pub fn spawn_worker_task(input: SpawnWorkerInput) -> Result<TaskSummary, String> {
    let parent_task_id = input.parent_task_id.clone();
    let start_input = build_worker_start_input(input)?;
    let summary = start_task(start_input)?;
    let _ = record_runtime_event(
        "worker-spawned",
        format!(
            "Worker task {} spawned from coordinator {}.",
            summary.task_id, parent_task_id
        ),
        Some(json!({
            "taskId": summary.task_id.clone(),
            "parentTaskId": parent_task_id,
            "workspaceId": summary.workspace_id.clone(),
            "workspaceName": summary.workspace_name.clone(),
            "target": summary.target.clone(),
            "role": summary.role.clone(),
            "backendId": summary.backend_id.clone(),
            "backendDisplayName": summary.backend_display_name.clone(),
            "status": summary.status.clone(),
            "attentionState": summary.attention_state.clone(),
            "cwd": summary.cwd.clone(),
        })),
    );
    Ok(summary)
}

pub fn spawn_worker_task_with_retry(input: SpawnWorkerInput) -> Result<TaskSummary, String> {
    start_summary_with_retry(|| spawn_worker_task(input.clone()))
}

pub fn send_task_input(task_id: &str, input: &str) -> Result<TaskSummary, String> {
    let should_release_initial_prompt = get_task_detail(task_id)
        .map(|detail| is_workspace_trust_prompt(&detail.recent_output_excerpt))
        .unwrap_or(false);
    let mut running = runtime().running.lock().unwrap();
    let handle = running
        .get_mut(task_id)
        .ok_or_else(|| format!("task is not interactive or no longer running: {task_id}"))?;
    if should_release_initial_prompt {
        handle.trust_prompt_handled = true;
    }
    handle.controller.send_input(input)?;
    drop(running);

    if should_release_initial_prompt {
        schedule_pending_initial_input(task_id.to_string(), Duration::from_millis(750));
    }

    let updated = update_task(task_id, |detail| {
        detail.summary.status = "running".to_string();
        detail.summary.attention_state = TaskAttentionState::Running;
    })?;
    let summary = updated
        .map(|detail| detail.summary)
        .ok_or_else(|| format!("task not found: {task_id}"))?;
    let _ = record_runtime_event(
        "task-input",
        format!("Operator input sent to task {}.", summary.task_id),
        Some(json!({
            "taskId": summary.task_id,
            "status": summary.status,
            "inputPreview": clamp_excerpt(input.trim_end(), 300),
        })),
    );
    Ok(summary)
}

pub fn close_task(task_id: &str) -> Result<TaskSummary, String> {
    let mut running = runtime().running.lock().unwrap();
    let remove_after_close = {
        let handle = running
            .get_mut(task_id)
            .ok_or_else(|| format!("task is not running: {task_id}"))?;
        let remove_after_close = handle.controller.remove_after_close();
        handle.controller.close()?;
        remove_after_close
    };
    if remove_after_close {
        running.remove(task_id);
    }
    drop(running);
    let updated = update_task(task_id, |detail| {
        detail.summary.status = "exited".to_string();
        detail.summary.exit_code = None;
        detail.summary.attention_state = TaskAttentionState::Completed;
        detail.summary.completed_at = Some(now_timestamp_ms());
        detail.summary.termination_cause = Some(TaskTerminationCause::ManualClose);
    })?;
    let summary = updated
        .map(|detail| detail.summary)
        .ok_or_else(|| format!("task not found: {task_id}"))?;
    let _ = record_runtime_event(
        "task-closed",
        format!("Task {} was closed by operator.", summary.task_id),
        Some(task_event_payload(&summary)),
    );
    Ok(summary)
}

pub fn get_task_status(task_id: &str) -> Result<TaskStatusDetail, String> {
    get_task_detail(task_id).ok_or_else(|| format!("task not found: {task_id}"))
}

pub fn list_task_runtime_events(
    task_id: &str,
    limit: Option<usize>,
    include_related: bool,
) -> Result<Vec<RuntimeEvent>, String> {
    if get_task_detail(task_id).is_none() {
        return Err(format!("task not found: {task_id}"));
    }

    let task_ids = if include_related {
        collect_related_task_ids(task_id)
    } else {
        vec![task_id.to_string()]
    };
    let task_ids = task_ids.into_iter().collect::<HashSet<_>>();
    let limit = limit.unwrap_or(50).clamp(1, 200);
    let mut events = load_runtime_state()
        .recent_events
        .into_iter()
        .filter(|event| event_matches_task_ids(event, &task_ids))
        .collect::<Vec<_>>();
    events.sort_by(|left, right| right.timestamp.cmp(&left.timestamp));
    events.truncate(limit);
    Ok(events)
}

pub fn list_attention_tasks() -> Vec<TaskSummary> {
    list_visible_task_details()
        .into_iter()
        .filter_map(|detail| match detail.summary.attention_state {
            TaskAttentionState::Completed => None,
            _ => Some(detail.summary),
        })
        .collect()
}

pub fn resume_session(task_id: &str) -> Result<TaskStatusDetail, String> {
    get_task_status(task_id)
}

pub fn save_task_plan(
    task_id: &str,
    markdown: &str,
    title: Option<&str>,
    file_name: Option<&str>,
) -> Result<TaskStatusDetail, String> {
    if markdown.trim().is_empty() {
        return Err("markdown is required".to_string());
    }
    if get_task_detail(task_id).is_none() {
        return Err(format!("task not found: {task_id}"));
    }

    let normalized_file_name = sanitize_artifact_file_name(file_name);
    let path = task_plan_path(task_id, &normalized_file_name);
    write_text_file_atomically(&path, markdown)?;

    let now = now_timestamp_ms();
    let title = title
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Plan Document")
        .to_string();
    let path_string = path.to_string_lossy().to_string();
    let updated = update_task(task_id, |detail| {
        if let Some(existing) = detail
            .artifacts
            .iter_mut()
            .find(|artifact| artifact.kind == TaskArtifactKind::Plan)
        {
            existing.title = title.clone();
            existing.path = path_string.clone();
            existing.mime_type = "text/markdown".to_string();
            existing.updated_at = now;
        } else {
            detail.artifacts.push(TaskArtifact {
                artifact_id: generate_id("artifact"),
                kind: TaskArtifactKind::Plan,
                title: title.clone(),
                path: path_string.clone(),
                mime_type: "text/markdown".to_string(),
                created_at: now,
                updated_at: now,
            });
        }
    })?;
    let detail = updated.ok_or_else(|| format!("task not found: {task_id}"))?;
    let _ = record_runtime_event(
        "task-plan-saved",
        format!("Saved plan document for task {}.", detail.summary.task_id),
        Some(json!({
            "taskId": detail.summary.task_id,
            "artifactPath": path_string,
            "title": title,
        })),
    );
    Ok(detail)
}

pub fn request_or_validate_approval(
    request_id: Option<&str>,
    tool_name: &str,
    reason: &str,
    risk_level: ApprovalRiskLevel,
    payload_preview: String,
) -> Result<ApprovalRequest, PendingApprovalResult> {
    let approval_key = super::approval::build_approval_key(tool_name, &payload_preview);

    if let Some(request_id) = request_id {
        if let Some(request) = get_approval(request_id) {
            if approval_matches_action(&request, tool_name, &approval_key) {
                return match request.status {
                    ApprovalDecision::Approved => Ok(request),
                    ApprovalDecision::Rejected => Err(PendingApprovalResult {
                        approval_required: true,
                        request,
                    }),
                    ApprovalDecision::Pending => Err(PendingApprovalResult {
                        approval_required: true,
                        request,
                    }),
                    ApprovalDecision::Executed => Err(PendingApprovalResult {
                        approval_required: true,
                        request,
                    }),
                };
            }
        }
    }

    if let Some(request) = get_approval_by_key(&approval_key) {
        match request.status {
            ApprovalDecision::Pending | ApprovalDecision::Rejected | ApprovalDecision::Approved => {
                return Err(PendingApprovalResult {
                    approval_required: true,
                    request,
                });
            }
            ApprovalDecision::Executed => {}
        }
    }

    let request = create_approval_request(tool_name, reason, risk_level, payload_preview)
        .expect("approval creation should succeed");
    Err(PendingApprovalResult {
        approval_required: true,
        request,
    })
}

pub fn mark_approval_executed(request_id: &str) {
    if let Ok(request) = set_approval_status(request_id, ApprovalDecision::Executed) {
        let _ = record_runtime_event(
            "approval-executed",
            format!("Approval {} marked executed.", request.request_id),
            Some(json!({
                "requestId": request.request_id,
                "toolName": request.tool_name,
                "status": request.status,
            })),
        );
    }
}

pub fn request_task_close(
    task_id: &str,
    approval_request_id: Option<&str>,
    cascade_children: bool,
) -> Result<AgentActionResult<TaskSummary>, String> {
    if !running_task_exists(task_id) {
        return Err(format!("task is not running: {task_id}"));
    }

    let running_descendant_task_ids = if cascade_children {
        collect_running_descendant_task_ids(task_id)
    } else {
        Vec::new()
    };

    let request = match request_or_validate_approval(
        approval_request_id,
        "close_task",
        "Closing a task can interrupt an active agent run.",
        ApprovalRiskLevel::Medium,
        approval_payload_for_close_task(
            task_id,
            cascade_children,
            running_descendant_task_ids.len(),
        ),
    ) {
        Ok(request) => request,
        Err(pending) => return Ok(AgentActionResult::approval_required(pending.request)),
    };

    if cascade_children && !running_descendant_task_ids.is_empty() {
        let _ = record_runtime_event(
            "task-close-cascade",
            format!(
                "Cascade close requested for task {} and {} descendant tasks.",
                task_id,
                running_descendant_task_ids.len()
            ),
            Some(json!({
                "taskId": task_id,
                "cascadeChildren": true,
                "descendantTaskIds": running_descendant_task_ids.clone(),
            })),
        );
    }

    for descendant_task_id in &running_descendant_task_ids {
        if running_task_exists(descendant_task_id) {
            close_task(descendant_task_id)?;
        }
    }
    let result = close_task(task_id)?;
    mark_approval_executed(&request.request_id);
    Ok(AgentActionResult::success(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_backends::{
        clear_backend_runtime_state, default_backend_for_target, find_agent_backend,
        mark_backend_ready,
    };
    use crate::agent_core::{
        approval::{create_approval_request, set_approval_status},
        models::{ApprovalRiskLevel, TaskAttentionState, TaskContextPreset, TaskRole, TaskTarget},
        task_store::{get_task_detail, upsert_task_detail},
    };
    use crate::config::{
        load_config_from_path, save_config_to_path, AgentBackendsConfig, SidecarBackendConfig,
        SidecarProviderConfig, SidecarStartupMode,
    };
    use crate::mcp::tools::test_support::TestHarness;
    use crate::runtime_mcp::{write_runtime_state_for_tests, RuntimeEvent, RuntimeMcpState};
    use std::io;
    use std::sync::{Mutex, OnceLock};

    #[derive(Debug)]
    struct NoopKiller;

    struct EnvVarGuard {
        key: &'static str,
        previous: Option<String>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, value: &str) -> Self {
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

    impl portable_pty::ChildKiller for NoopKiller {
        fn kill(&mut self) -> io::Result<()> {
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            Box::new(NoopKiller)
        }
    }

    fn sidecar_env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn sample_task(task_id: &str, workspace_path: &str) -> TaskStatusDetail {
        TaskStatusDetail {
            summary: TaskSummary {
                task_id: task_id.to_string(),
                workspace_id: "workspace-1".into(),
                workspace_name: "mini-term".into(),
                workspace_root_path: workspace_path.to_string(),
                target: TaskTarget::Codex,
                role: TaskRole::Coordinator,
                parent_task_id: None,
                backend_id: Some("codex-cli".into()),
                backend_display_name: Some("Codex CLI".into()),
                title: "Sample task".into(),
                status: "starting".into(),
                attention_state: TaskAttentionState::Running,
                session_id: task_id.to_string(),
                cwd: workspace_path.to_string(),
                started_at: 1,
                updated_at: 1,
                completed_at: None,
                exit_code: None,
                context_preset: TaskContextPreset::Standard,
                changed_files: Vec::new(),
                prompt_preview: "prompt".into(),
                last_output_excerpt: String::new(),
                injection_profile_id: None,
                injection_preset: None,
                policy_summary: None,
                termination_cause: None,
                retry_superseded: false,
                superseded_by_task_id: None,
            },
            recent_output_excerpt: String::new(),
            diff_summary: Vec::new(),
            log_path: log_path(task_id).to_string_lossy().to_string(),
            artifacts: Vec::new(),
        }
    }

    fn insert_running_task(task_id: &str) {
        runtime().running.lock().unwrap().insert(
            task_id.into(),
            RunningTaskHandle {
                controller: Box::new(BuiltinCliTaskController {
                    writer: Box::new(Vec::<u8>::new()),
                    killer: Box::new(NoopKiller),
                }),
                pending_initial_input: None,
                trust_prompt_handled: false,
            },
        );
    }

    fn wait_for_task(
        task_id: &str,
        predicate: impl Fn(&TaskStatusDetail) -> bool,
    ) -> TaskStatusDetail {
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut last_detail = None;
        loop {
            if let Some(detail) = get_task_detail(task_id) {
                if predicate(&detail) {
                    return detail;
                }
                last_detail = Some(detail);
            }
            if Instant::now() >= deadline {
                panic!(
                    "timed out waiting for task state: {task_id}; last detail: {:?}",
                    last_detail
                );
            }
            thread::sleep(Duration::from_millis(25));
        }
    }

    #[test]
    fn mismatched_approved_request_restarts_current_action_approval() {
        let _harness = TestHarness::new("approval-mismatch-payload");
        let old_request = create_approval_request(
            "write_file",
            "Writing a file changes repository state.",
            ApprovalRiskLevel::High,
            "Path: D:/repo/one.txt\nhello".into(),
        )
        .unwrap();
        set_approval_status(&old_request.request_id, ApprovalDecision::Approved).unwrap();

        let pending = request_or_validate_approval(
            Some(&old_request.request_id),
            "write_file",
            "Writing a file changes repository state.",
            ApprovalRiskLevel::High,
            "Path: D:/repo/two.txt\nhello".into(),
        )
        .unwrap_err();

        assert_ne!(pending.request.request_id, old_request.request_id);
        assert_eq!(pending.request.status, ApprovalDecision::Pending);
    }

    #[test]
    fn mismatched_request_reuses_current_action_approval_when_present() {
        let _harness = TestHarness::new("approval-mismatch-tool");
        let old_request = create_approval_request(
            "run_workspace_command",
            "Running arbitrary commands can modify files or execute side effects.",
            ApprovalRiskLevel::High,
            "Workspace: D:/repo\nCommand: echo hello".into(),
        )
        .unwrap();
        set_approval_status(&old_request.request_id, ApprovalDecision::Approved).unwrap();

        let current_request = create_approval_request(
            "write_file",
            "Writing a file changes repository state.",
            ApprovalRiskLevel::High,
            "Path: D:/repo/file.txt\nhello".into(),
        )
        .unwrap();
        set_approval_status(&current_request.request_id, ApprovalDecision::Approved).unwrap();

        let pending = request_or_validate_approval(
            Some(&old_request.request_id),
            "write_file",
            "Writing a file changes repository state.",
            ApprovalRiskLevel::High,
            "Path: D:/repo/file.txt\nhello".into(),
        )
        .unwrap_err();

        assert_eq!(pending.request.request_id, current_request.request_id);
        assert_eq!(pending.request.status, ApprovalDecision::Approved);
    }

    #[test]
    fn startup_failure_marks_task_as_failed_and_logs_error() {
        let harness = TestHarness::new("startup-failure");
        let detail = sample_task("task-startup-fail", &harness.workspace_path());
        upsert_task_detail(detail).unwrap();

        let message = fail_task_start("task-startup-fail", "spawn failed".into());
        assert_eq!(message, "spawn failed");

        let updated = get_task_detail("task-startup-fail").unwrap();
        assert_eq!(updated.summary.status, "error");
        assert_eq!(updated.summary.attention_state, TaskAttentionState::Failed);
        assert_eq!(
            updated.summary.termination_cause,
            Some(TaskTerminationCause::StartupFailed)
        );
        assert!(updated.recent_output_excerpt.contains("spawn failed"));
        assert!(std::fs::read_to_string(log_path("task-startup-fail"))
            .unwrap()
            .contains("spawn failed"));
    }

    #[test]
    fn transient_startup_retry_hides_superseded_failed_attempts() {
        let harness = TestHarness::new("startup-retry-superseded");
        let workspace_path = harness.workspace_path();
        let mut attempt = 0usize;

        let summary = start_summary_with_retry(|| {
            attempt += 1;
            let task_id = format!("task-retry-{attempt}");
            let mut detail = sample_task(&task_id, &workspace_path);
            if attempt == 1 {
                let excerpt = "Task process exited with code -1073741502 before producing terminal output. Launch command: codex <prompt-via-pty>";
                detail.summary.status = "error".into();
                detail.summary.attention_state = TaskAttentionState::Failed;
                detail.summary.completed_at = Some(now_timestamp_ms());
                detail.summary.exit_code = Some(-1073741502);
                detail.summary.termination_cause = Some(TaskTerminationCause::StartupFailed);
                detail.recent_output_excerpt = excerpt.into();
                detail.summary.last_output_excerpt = excerpt.into();
            } else {
                detail.summary.status = "running".into();
                detail.summary.attention_state = TaskAttentionState::Running;
            }
            let summary = detail.summary.clone();
            upsert_task_detail(detail).unwrap();
            Ok(summary)
        })
        .unwrap();

        if cfg!(windows) {
            assert_eq!(summary.task_id, "task-retry-2");
            let superseded = get_task_detail("task-retry-1").unwrap();
            assert!(superseded.summary.retry_superseded);
            assert_eq!(
                superseded.summary.superseded_by_task_id.as_deref(),
                Some("task-retry-2")
            );
            assert!(list_visible_task_details()
                .into_iter()
                .all(|detail| detail.summary.task_id != "task-retry-1"));
            assert!(list_attention_tasks()
                .into_iter()
                .all(|task| task.task_id != "task-retry-1"));
        } else {
            assert_eq!(summary.task_id, "task-retry-1");
            let visible_task_ids = list_visible_task_details()
                .into_iter()
                .map(|detail| detail.summary.task_id)
                .collect::<Vec<_>>();
            assert!(visible_task_ids
                .iter()
                .any(|task_id| task_id == "task-retry-1"));
        }
    }

    #[test]
    fn final_transient_startup_failure_remains_visible_after_retry_budget_exhausted() {
        let harness = TestHarness::new("startup-retry-final-failure");
        let workspace_path = harness.workspace_path();
        let mut attempt = 0usize;

        let summary = start_summary_with_retry(|| {
            attempt += 1;
            let task_id = format!("task-final-failure-{attempt}");
            let mut detail = sample_task(&task_id, &workspace_path);
            let excerpt = format!(
                "Task process exited with code -1073741502 before producing terminal output. Attempt {attempt}"
            );
            detail.summary.status = "error".into();
            detail.summary.attention_state = TaskAttentionState::Failed;
            detail.summary.completed_at = Some(now_timestamp_ms());
            detail.summary.exit_code = Some(-1073741502);
            detail.summary.termination_cause = Some(TaskTerminationCause::StartupFailed);
            detail.recent_output_excerpt = excerpt.clone();
            detail.summary.last_output_excerpt = excerpt;
            let summary = detail.summary.clone();
            upsert_task_detail(detail).unwrap();
            Ok(summary)
        })
        .unwrap();

        let final_attempt = if cfg!(windows) { 3 } else { 1 };
        let final_task_id = format!("task-final-failure-{final_attempt}");
        assert_eq!(summary.task_id, final_task_id);

        let visible_task_ids = list_visible_task_details()
            .into_iter()
            .map(|detail| detail.summary.task_id)
            .collect::<Vec<_>>();
        assert!(visible_task_ids
            .iter()
            .any(|task_id| task_id == &final_task_id));

        let attention_task_ids = list_attention_tasks()
            .into_iter()
            .map(|task| task.task_id)
            .filter(|task_id| task_id.starts_with("task-final-failure-"))
            .collect::<Vec<_>>();
        assert_eq!(attention_task_ids, vec![final_task_id.clone()]);

        for previous_attempt in 1..final_attempt {
            let task_id = format!("task-final-failure-{previous_attempt}");
            let superseded = get_task_detail(&task_id).unwrap();
            let expected_successor = format!("task-final-failure-{}", previous_attempt + 1);
            assert!(superseded.summary.retry_superseded);
            assert_eq!(
                superseded.summary.superseded_by_task_id.as_deref(),
                Some(expected_successor.as_str())
            );
        }

        let final_detail = get_task_detail(&final_task_id).unwrap();
        assert!(!final_detail.summary.retry_superseded);
        assert_eq!(
            final_detail.summary.termination_cause,
            Some(TaskTerminationCause::StartupFailed)
        );
    }

    #[test]
    fn output_updates_do_not_restore_terminal_tasks_to_running() {
        let harness = TestHarness::new("terminal-output");
        let mut detail = sample_task("task-terminal", &harness.workspace_path());
        detail.summary.status = "exited".into();
        detail.summary.attention_state = TaskAttentionState::Completed;
        detail.summary.termination_cause = Some(TaskTerminationCause::ManualClose);

        apply_output_update(&mut detail, "buffered output");

        assert_eq!(detail.summary.status, "exited");
        assert_eq!(
            detail.summary.termination_cause,
            Some(TaskTerminationCause::ManualClose)
        );
        assert!(detail.recent_output_excerpt.contains("buffered output"));
    }

    #[test]
    fn close_task_marks_manual_close_as_completed_exit() {
        let harness = TestHarness::new("close-task-manual-close");
        let mut detail = sample_task("task-manual-close", &harness.workspace_path());
        detail.summary.status = "running".into();
        upsert_task_detail(detail).unwrap();
        insert_running_task("task-manual-close");

        let updated = close_task("task-manual-close").unwrap();
        assert_eq!(updated.status, "exited");
        assert_eq!(updated.attention_state, TaskAttentionState::Completed);
        assert_eq!(
            updated.termination_cause,
            Some(TaskTerminationCause::ManualClose)
        );
    }

    #[test]
    fn build_worker_start_input_inherits_parent_defaults() {
        let harness = TestHarness::new("worker-inherits-parent");
        let mut parent = sample_task("task-parent", &harness.workspace_path());
        parent.summary.status = "running".into();
        parent.summary.context_preset = TaskContextPreset::Review;
        parent.summary.backend_id = Some("codex-cli".into());
        upsert_task_detail(parent).unwrap();

        let worker = build_worker_start_input(SpawnWorkerInput {
            parent_task_id: "task-parent".into(),
            prompt: "Review the newest diff".into(),
            target: None,
            context_preset: None,
            backend_id: None,
            cwd: None,
            title: Some("Review worker".into()),
        })
        .unwrap();

        assert_eq!(worker.workspace_id, "workspace-1");
        assert_eq!(worker.target, TaskTarget::Codex);
        assert_eq!(worker.context_preset, TaskContextPreset::Review);
        assert_eq!(worker.role, TaskRole::Worker);
        assert_eq!(worker.parent_task_id.as_deref(), Some("task-parent"));
        assert_eq!(worker.backend_id.as_deref(), Some("codex-cli"));
        assert_eq!(
            worker.cwd.as_deref(),
            Some(harness.workspace_path().as_str())
        );
        assert_eq!(worker.title.as_deref(), Some("Review worker"));
    }

    #[test]
    fn build_worker_start_input_drops_inherited_backend_when_target_changes() {
        let harness = TestHarness::new("worker-target-override");
        let mut parent = sample_task("task-parent", &harness.workspace_path());
        parent.summary.status = "running".into();
        parent.summary.target = TaskTarget::Codex;
        parent.summary.backend_id = Some("codex-cli".into());
        upsert_task_detail(parent).unwrap();

        let worker = build_worker_start_input(SpawnWorkerInput {
            parent_task_id: "task-parent".into(),
            prompt: "Switch to Claude for investigation".into(),
            target: Some(TaskTarget::Claude),
            context_preset: None,
            backend_id: None,
            cwd: None,
            title: None,
        })
        .unwrap();

        assert_eq!(worker.target, TaskTarget::Claude);
        assert!(worker.backend_id.is_none());
    }

    #[test]
    fn list_task_runtime_events_can_include_related_worker_events() {
        let harness = TestHarness::new("task-runtime-events-related");
        let parent = sample_task("task-parent", &harness.workspace_path());
        let mut child = sample_task("task-child", &harness.workspace_path());
        child.summary.role = TaskRole::Worker;
        child.summary.parent_task_id = Some("task-parent".into());
        upsert_task_detail(parent).unwrap();
        upsert_task_detail(child).unwrap();
        write_runtime_state_for_tests(RuntimeMcpState {
            recent_events: vec![
                RuntimeEvent {
                    event_id: "event-1".into(),
                    kind: "task-started".into(),
                    timestamp: 1,
                    summary: "Parent started".into(),
                    payload_preview: Some(json!({
                        "taskId": "task-parent",
                    })),
                },
                RuntimeEvent {
                    event_id: "event-2".into(),
                    kind: "task-input".into(),
                    timestamp: 2,
                    summary: "Child input".into(),
                    payload_preview: Some(json!({
                        "taskId": "task-child",
                    })),
                },
                RuntimeEvent {
                    event_id: "event-3".into(),
                    kind: "worker-spawned".into(),
                    timestamp: 3,
                    summary: "Worker spawned".into(),
                    payload_preview: Some(json!({
                        "taskId": "task-child",
                        "parentTaskId": "task-parent",
                    })),
                },
            ],
            ..RuntimeMcpState::default()
        });

        let direct_only = list_task_runtime_events("task-parent", Some(10), false).unwrap();
        let related = list_task_runtime_events("task-parent", Some(10), true).unwrap();

        assert_eq!(
            direct_only
                .into_iter()
                .map(|event| event.event_id)
                .collect::<Vec<_>>(),
            vec!["event-3".to_string(), "event-1".to_string()]
        );
        assert_eq!(
            related
                .into_iter()
                .map(|event| event.event_id)
                .collect::<Vec<_>>(),
            vec![
                "event-3".to_string(),
                "event-2".to_string(),
                "event-1".to_string(),
            ]
        );
    }

    #[test]
    fn request_task_close_cascade_requires_distinct_approval_payload() {
        let harness = TestHarness::new("close-task-cascade-approval");
        let mut parent = sample_task("task-parent", &harness.workspace_path());
        parent.summary.status = "running".into();
        let mut child = sample_task("task-child", &harness.workspace_path());
        child.summary.status = "running".into();
        child.summary.role = TaskRole::Worker;
        child.summary.parent_task_id = Some("task-parent".into());
        upsert_task_detail(parent).unwrap();
        upsert_task_detail(child).unwrap();
        insert_running_task("task-parent");
        insert_running_task("task-child");

        let pending = request_task_close("task-parent", None, true).unwrap();
        assert_eq!(pending.ok, false);
        assert_eq!(pending.approval_required, true);
        assert_eq!(
            pending
                .request
                .as_ref()
                .map(|request| request.payload_preview.clone()),
            Some("Task: task-parent\nCascadeChildren: true\nDescendantCount: 1".into())
        );
    }

    #[test]
    fn request_task_close_can_cascade_to_running_children() {
        let harness = TestHarness::new("close-task-cascade-success");
        let mut parent = sample_task("task-parent", &harness.workspace_path());
        parent.summary.status = "running".into();
        let mut child = sample_task("task-child", &harness.workspace_path());
        child.summary.status = "running".into();
        child.summary.role = TaskRole::Worker;
        child.summary.parent_task_id = Some("task-parent".into());
        upsert_task_detail(parent).unwrap();
        upsert_task_detail(child).unwrap();
        insert_running_task("task-parent");
        insert_running_task("task-child");

        let pending = request_task_close("task-parent", None, true).unwrap();
        let request_id = pending
            .request
            .as_ref()
            .map(|request| request.request_id.clone())
            .unwrap();
        set_approval_status(&request_id, ApprovalDecision::Approved).unwrap();

        let result = request_task_close("task-parent", Some(&request_id), true).unwrap();
        assert!(result.ok);
        assert_eq!(
            result.data.as_ref().map(|task| task.task_id.as_str()),
            Some("task-parent")
        );
        assert_eq!(
            get_task_detail("task-child").and_then(|detail| detail.summary.termination_cause),
            Some(TaskTerminationCause::ManualClose)
        );
        assert_eq!(
            get_task_detail("task-parent").and_then(|detail| detail.summary.termination_cause),
            Some(TaskTerminationCause::ManualClose)
        );
    }

    #[test]
    fn save_task_plan_creates_and_persists_plan_artifact() {
        let harness = TestHarness::new("save-task-plan-create");
        upsert_task_detail(sample_task("task-plan", &harness.workspace_path())).unwrap();

        let detail = save_task_plan(
            "task-plan",
            "# Plan\n\n1. Review\n2. Implement",
            Some("Execution Plan"),
            None,
        )
        .unwrap();

        assert_eq!(detail.artifacts.len(), 1);
        assert_eq!(detail.artifacts[0].kind, TaskArtifactKind::Plan);
        assert_eq!(detail.artifacts[0].title, "Execution Plan");
        assert!(detail.artifacts[0].path.ends_with("plan.md"));
        assert_eq!(
            std::fs::read_to_string(task_plan_path("task-plan", "plan.md")).unwrap(),
            "# Plan\n\n1. Review\n2. Implement"
        );
    }

    #[test]
    fn save_task_plan_overwrites_existing_plan_artifact() {
        let harness = TestHarness::new("save-task-plan-update");
        upsert_task_detail(sample_task("task-plan-update", &harness.workspace_path())).unwrap();

        let first = save_task_plan(
            "task-plan-update",
            "# First",
            Some("Plan"),
            Some("nested/plan.md"),
        )
        .unwrap();
        let first_artifact = first.artifacts[0].clone();

        std::thread::sleep(Duration::from_millis(2));
        let second = save_task_plan(
            "task-plan-update",
            "# Second",
            Some("Updated Plan"),
            Some("plan.md"),
        )
        .unwrap();

        assert_eq!(second.artifacts.len(), 1);
        assert_eq!(second.artifacts[0].artifact_id, first_artifact.artifact_id);
        assert_eq!(second.artifacts[0].title, "Updated Plan");
        assert!(second.artifacts[0].updated_at >= first_artifact.updated_at);
        assert_eq!(
            std::fs::read_to_string(task_plan_path("task-plan-update", "plan.md")).unwrap(),
            "# Second"
        );
    }

    #[test]
    fn save_task_plan_rejects_missing_task_and_empty_markdown() {
        let _harness = TestHarness::new("save-task-plan-errors");
        let missing = save_task_plan("missing-task", "# Plan", None, None).unwrap_err();
        assert_eq!(missing, "task not found: missing-task");

        upsert_task_detail(sample_task("task-empty-plan", "D:/code/mini-term")).unwrap();
        let empty = save_task_plan("task-empty-plan", "   ", None, None).unwrap_err();
        assert_eq!(empty, "markdown is required");
    }

    #[test]
    fn sidecar_backend_supports_start_input_and_close() {
        let _guard = sidecar_env_lock().lock().unwrap();
        let _backend_guard = crate::agent_backends::backend_runtime_test_lock()
            .lock()
            .unwrap();
        let _mode = EnvVarGuard::set("MINI_TERM_TEST_AGENT_SIDECAR_MODE", "loopback");
        let harness = TestHarness::new("sidecar-runtime-flow");
        clear_backend_runtime_state("claude-sidecar");
        let config_path = crate::agent_core::data_dir::config_path();
        let mut config = load_config_from_path(&config_path);
        config.agent_backends = Some(AgentBackendsConfig {
            routing: crate::config::AgentBackendRoutingConfig::default(),
            claude_sidecar: SidecarBackendConfig {
                enabled: true,
                command: None,
                args: Vec::new(),
                env: Default::default(),
                provider: SidecarProviderConfig::default(),
                cwd: None,
                startup_mode: SidecarStartupMode::Loopback,
                connection_timeout_ms: 2_000,
            },
        });
        save_config_to_path(&config_path, config).unwrap();
        let backend = find_agent_backend("claude-sidecar").unwrap();
        mark_backend_ready(
            "claude-sidecar",
            "Loopback sidecar verified for test.",
            1,
            Some(backend.capabilities.clone()),
        );
        let ready_backend = find_agent_backend("claude-sidecar").unwrap();
        assert!(ready_backend.available);
        assert_eq!(
            ready_backend.status,
            crate::agent_backends::AgentBackendRuntimeStatus::Ready
        );

        let summary = start_task(StartTaskInput {
            workspace_id: "workspace-1".into(),
            target: TaskTarget::Claude,
            prompt: "Inspect workspace state".into(),
            context_preset: TaskContextPreset::Light,
            role: TaskRole::Coordinator,
            parent_task_id: None,
            backend_id: Some("claude-sidecar".into()),
            cwd: Some(harness.workspace_path()),
            title: Some("Claude Sidecar".into()),
        })
        .unwrap();

        assert_eq!(summary.backend_id.as_deref(), Some("claude-sidecar"));
        assert!(running_task_exists(&summary.task_id));

        let started = wait_for_task(&summary.task_id, |detail| {
            detail
                .recent_output_excerpt
                .contains("Loopback sidecar ready: Claude Sidecar")
        });
        assert_eq!(started.summary.status, "running");

        send_task_input(&summary.task_id, "hello sidecar").unwrap();
        let waiting = wait_for_task(&summary.task_id, |detail| {
            detail
                .recent_output_excerpt
                .contains("INPUT: hello sidecar")
                && detail.summary.attention_state == TaskAttentionState::WaitingInput
        });
        assert_eq!(waiting.summary.status, "waiting-input");

        let closed = close_task(&summary.task_id).unwrap();
        assert_eq!(
            closed.termination_cause,
            Some(TaskTerminationCause::ManualClose)
        );
        assert!(!running_task_exists(&summary.task_id));

        let finished = wait_for_task(&summary.task_id, |detail| {
            detail.summary.termination_cause == Some(TaskTerminationCause::ManualClose)
                && detail.summary.status == "exited"
        });
        assert_eq!(
            finished.summary.attention_state,
            TaskAttentionState::Completed
        );
        clear_backend_runtime_state("claude-sidecar");
    }

    #[test]
    fn request_task_close_rejects_missing_task_before_approval() {
        let _harness = TestHarness::new("close-missing-before-approval");
        let error = request_task_close("missing-task", None, false).unwrap_err();
        assert_eq!(error, "task is not running: missing-task");
    }

    #[test]
    fn initialize_task_record_keeps_prompt_preview_focused_on_user_request() {
        let harness = TestHarness::new("task-prompt-preview");
        let detail = initialize_task_record(
            &StartTaskInput {
                workspace_id: "workspace-1".into(),
                target: TaskTarget::Codex,
                prompt: "Fix runtime MCP pagination".into(),
                context_preset: TaskContextPreset::Light,
                role: TaskRole::Coordinator,
                parent_task_id: None,
                backend_id: None,
                cwd: None,
                title: Some("Prompt preview".into()),
            },
            &default_backend_for_target(&TaskTarget::Codex).unwrap(),
            "mini-term".into(),
            harness.workspace_path(),
            harness.workspace_path(),
            "  Fix runtime MCP pagination  ",
        );

        assert_eq!(detail.summary.prompt_preview, "Fix runtime MCP pagination");
        assert!(!detail.summary.prompt_preview.contains("User request:"));
    }
}
