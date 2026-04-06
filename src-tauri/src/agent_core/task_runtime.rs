use super::approval::{
    create_approval_request, get_approval, get_approval_by_key, set_approval_status,
};
use super::data_dir::{ensure_parent, logs_dir, task_artifacts_dir};
use super::git_context::get_git_summary;
use super::models::{
    AgentActionResult, ApprovalDecision, ApprovalRequest, ApprovalRiskLevel, PendingApprovalResult,
    StartTaskInput, TaskArtifact, TaskArtifactKind, TaskAttentionState, TaskContextPreset,
    TaskStatusDetail, TaskSummary, TaskTarget, TaskTerminationCause,
};
use super::task_store::{get_task_detail, list_task_details, update_task, upsert_task_detail};
use super::workspace_context::{get_workspace_context, validate_task_working_directory};
use crate::agent_backends::{
    default_backend_for_target, find_agent_backend, AgentBackendDescriptor,
};
use crate::agent_policy::build_injected_prompt;
use crate::runtime_mcp::record_runtime_event;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, PtySize};
use serde_json::json;
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

struct RunningTaskHandle {
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pending_initial_input: Option<String>,
    trust_prompt_handled: bool,
}

struct LaunchCommand {
    builder: CommandBuilder,
    display: String,
    initial_input: Option<String>,
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

fn shim_command_for(target: &TaskTarget) -> Option<CommandBuilder> {
    let shim = std::env::var("MINI_TERM_AGENT_SHIM")
        .ok()
        .or_else(|| std::env::var("MINI_TERM_TEST_AGENT_SHIM").ok())?;

    let lower = shim.to_ascii_lowercase();
    if lower.ends_with(".js") || lower.ends_with(".mjs") || lower.ends_with(".cjs") {
        #[cfg(windows)]
        let node = resolve_windows_command("node");
        #[cfg(not(windows))]
        let node = "node".to_string();
        let mut builder = CommandBuilder::new(&node);
        builder.arg(&shim);
        builder.arg(target.as_str());
        return Some(builder);
    }

    #[cfg(windows)]
    {
        let mut builder = wrap_windows_command(&shim);
        builder.arg(target.as_str());
        return Some(builder);
    }

    #[cfg(not(windows))]
    {
        let mut builder = CommandBuilder::new("sh");
        builder.arg(&shim);
        builder.arg(target.as_str());
        return Some(builder);
    }
}

fn shell_escape(arg: &str) -> String {
    if arg.is_empty()
        || arg
            .chars()
            .any(|ch| ch.is_whitespace() || ch == '"' || ch == '\'')
    {
        format!("{arg:?}")
    } else {
        arg.to_string()
    }
}

#[cfg(windows)]
fn wrap_windows_command(path: &str) -> CommandBuilder {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".cmd") || lower.ends_with(".bat") {
        let mut builder = CommandBuilder::new("cmd");
        builder.arg("/C");
        builder.arg(path);
        return builder;
    }
    if lower.ends_with(".ps1") {
        let mut builder = CommandBuilder::new("powershell");
        builder.arg("-NoLogo");
        builder.arg("-NoProfile");
        builder.arg("-ExecutionPolicy");
        builder.arg("Bypass");
        builder.arg("-File");
        builder.arg(path);
        return builder;
    }
    CommandBuilder::new(path)
}

#[cfg(windows)]
fn resolve_windows_command(program: &str) -> String {
    let requested = Path::new(program);
    if requested.components().count() > 1 {
        return program.to_string();
    }

    let path_var = std::env::var_os("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path_var) {
        for candidate in [
            dir.join(format!("{program}.exe")),
            dir.join(format!("{program}.com")),
            dir.join(format!("{program}.cmd")),
            dir.join(format!("{program}.bat")),
            dir.join(format!("{program}.ps1")),
        ] {
            if candidate.is_file() {
                return candidate.to_string_lossy().to_string();
            }
        }
    }

    program.to_string()
}

#[cfg(windows)]
fn resolve_claude_windows_launch() -> (CommandBuilder, String) {
    let resolved = resolve_windows_command("claude");
    let cli_js = PathBuf::from(&resolved)
        .parent()
        .map(|dir| {
            dir.join("node_modules")
                .join("@anthropic-ai")
                .join("claude-code")
                .join("cli.js")
        })
        .filter(|path| path.is_file());

    if let Some(cli_js) = cli_js {
        let node = resolve_windows_command("node");
        let mut builder = CommandBuilder::new(&node);
        builder.arg(cli_js.to_string_lossy().as_ref());
        return (
            builder,
            format!("{} {}", node, shell_escape(&cli_js.to_string_lossy())),
        );
    }

    (wrap_windows_command(&resolved), resolved)
}

#[cfg(windows)]
fn resolve_codex_windows_launch() -> (CommandBuilder, String) {
    let resolved = resolve_windows_command("codex");
    let cli_js = PathBuf::from(&resolved)
        .parent()
        .map(|dir| {
            dir.join("node_modules")
                .join("@openai")
                .join("codex")
                .join("bin")
                .join("codex.js")
        })
        .filter(|path| path.is_file());

    if let Some(cli_js) = cli_js {
        let node = resolve_windows_command("node");
        let mut builder = CommandBuilder::new(&node);
        builder.arg(cli_js.to_string_lossy().as_ref());
        return (
            builder,
            format!("{} {}", node, shell_escape(&cli_js.to_string_lossy())),
        );
    }

    (wrap_windows_command(&resolved), resolved)
}

fn command_for(
    backend: &AgentBackendDescriptor,
    prompt: &str,
    cwd: &str,
    title: &str,
) -> LaunchCommand {
    if let Some(mut command) = shim_command_for(&backend.target) {
        command.cwd(cwd);
        return LaunchCommand {
            builder: command,
            display: format!(
                "{} {}",
                std::env::var("MINI_TERM_AGENT_SHIM")
                    .ok()
                    .or_else(|| std::env::var("MINI_TERM_TEST_AGENT_SHIM").ok())
                    .unwrap_or_else(|| "<shim>".to_string()),
                backend.backend_id
            ),
            initial_input: None,
        };
    }

    let (mut command, display, initial_input) = match backend.backend_id.as_str() {
        "codex-cli" => {
            #[cfg(windows)]
            let (mut builder, launch_prefix) = resolve_codex_windows_launch();
            #[cfg(not(windows))]
            let resolved = "codex".to_string();
            #[cfg(not(windows))]
            let launch_prefix = resolved.clone();
            #[cfg(not(windows))]
            let mut builder = CommandBuilder::new("codex");
            #[cfg(windows)]
            let args = codex_args_without_prompt(cwd);
            #[cfg(not(windows))]
            let args = codex_args(cwd, prompt);
            for arg in &args {
                builder.arg(arg);
            }
            let display = format!(
                "{} {}{}",
                launch_prefix,
                args.iter()
                    .map(|arg| shell_escape(arg))
                    .collect::<Vec<_>>()
                    .join(" "),
                if cfg!(windows) {
                    " <prompt-via-pty>"
                } else {
                    ""
                }
            );
            let initial_input = if cfg!(windows) {
                Some(prompt.to_string())
            } else {
                None
            };
            (builder, display, initial_input)
        }
        "claude-cli" => {
            #[cfg(windows)]
            let (mut builder, launch_prefix) = resolve_claude_windows_launch();
            #[cfg(not(windows))]
            let resolved = "claude".to_string();
            #[cfg(not(windows))]
            let launch_prefix = resolved.clone();
            #[cfg(not(windows))]
            let mut builder = CommandBuilder::new("claude");
            #[cfg(windows)]
            let args = claude_args_without_prompt(title);
            #[cfg(not(windows))]
            let args = claude_args(title, prompt);
            for arg in &args {
                builder.arg(arg);
            }
            let display = format!(
                "{} {}{}",
                launch_prefix,
                args.iter()
                    .map(|arg| shell_escape(arg))
                    .collect::<Vec<_>>()
                    .join(" "),
                if cfg!(windows) {
                    " <prompt-via-pty>"
                } else {
                    ""
                }
            );
            let initial_input = if cfg!(windows) {
                Some(prompt.to_string())
            } else {
                None
            };
            (builder, display, initial_input)
        }
        other => {
            panic!("unsupported builtin backend: {other}");
        }
    };
    command.cwd(cwd);
    LaunchCommand {
        builder: command,
        display,
        initial_input,
    }
}

#[cfg_attr(windows, allow(dead_code))]
fn codex_args(cwd: &str, prompt: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        vec![
            "-c".to_string(),
            r#"trust_level="trusted""#.to_string(),
            "-C".to_string(),
            cwd.to_string(),
            prompt.to_string(),
        ]
    }

    #[cfg(not(windows))]
    {
        vec!["-C".to_string(), cwd.to_string(), prompt.to_string()]
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
fn codex_args_without_prompt(cwd: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        vec![
            "-c".to_string(),
            r#"trust_level="trusted""#.to_string(),
            "-C".to_string(),
            cwd.to_string(),
        ]
    }

    #[cfg(not(windows))]
    {
        vec!["-C".to_string(), cwd.to_string()]
    }
}

#[cfg_attr(windows, allow(dead_code))]
fn claude_args(title: &str, prompt: &str) -> Vec<String> {
    vec!["-n".to_string(), title.to_string(), prompt.to_string()]
}

#[cfg_attr(not(windows), allow(dead_code))]
fn claude_args_without_prompt(title: &str) -> Vec<String> {
    vec!["-n".to_string(), title.to_string()]
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
    write_interactive_input(&mut *handle.writer, &input)?;
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
    write_interactive_input(&mut *handle.writer, "").map(|_| true)
}

fn schedule_pending_initial_input(task_id: String, delay: Duration) {
    thread::spawn(move || {
        thread::sleep(delay);
        let _ = flush_pending_initial_input(&task_id);
    });
}

fn schedule_workspace_trust_continue(task_id: String, delay: Duration) {
    thread::spawn(move || {
        thread::sleep(delay);
        if submit_workspace_trust_continue(&task_id).unwrap_or(false) {
            schedule_pending_initial_input(task_id.clone(), Duration::from_millis(750));
        }
    });
}

fn start_pending_initial_input_watch(task_id: String) {
    thread::spawn(move || {
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

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 32,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| fail_task_start(&task_id, err.to_string()))?;

    let LaunchCommand {
        builder,
        display: launch_display,
        initial_input,
    } = command_for(&backend, &prompt, &cwd, &initial_detail.summary.title);
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
            writer,
            killer,
            pending_initial_input: initial_input,
            trust_prompt_handled: false,
        },
    );

    if let Err(err) = update_task(&task_id, |detail| {
        detail.summary.status = "running".to_string();
        detail.summary.attention_state = TaskAttentionState::Running;
    }) {
        if let Some(mut handle) = runtime().running.lock().unwrap().remove(&task_id) {
            let _ = handle.killer.kill();
        }
        return Err(fail_task_start(&task_id, err));
    }

    if let Some(started_summary) = get_task_detail(&task_id).map(|detail| detail.summary) {
        let _ = record_runtime_event(
            "task-started",
            format!(
                "Task {} started with backend {}.",
                started_summary.task_id, backend.display_name
            ),
            Some(task_event_payload(&started_summary)),
        );
    }

    let task_id_for_output = task_id.clone();
    thread::spawn(move || {
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
    thread::spawn(move || {
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
            let termination_cause = detail.summary.termination_cause.clone();
            detail.summary.exit_code = exit_code;
            detail.summary.completed_at = Some(now_timestamp_ms());
            if let Some(git_summary) = &git_summary {
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
                if let Some(message) = &synthesized_exit_message {
                    detail.recent_output_excerpt = message.clone();
                    detail.summary.last_output_excerpt = message.clone();
                }
            }
            detail.summary.termination_cause = Some(TaskTerminationCause::ProcessExit);
            detail.summary.status = if exit_code.unwrap_or_default() == 0 {
                "exited".to_string()
            } else {
                "error".to_string()
            };
        });
        runtime().running.lock().unwrap().remove(&task_id_for_exit);
    });

    Ok(get_task_detail(&task_id)
        .map(|detail| detail.summary)
        .unwrap_or(initial_detail.summary))
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
    write_interactive_input(&mut *handle.writer, input)?;
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
    let handle = running
        .get_mut(task_id)
        .ok_or_else(|| format!("task is not running: {task_id}"))?;
    if let Err(err) = handle.killer.kill() {
        let message = err.to_string();
        if !message.contains("os error 0") {
            return Err(message);
        }
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

pub fn list_attention_tasks() -> Vec<TaskSummary> {
    list_task_details()
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
) -> Result<AgentActionResult<TaskSummary>, String> {
    if !running_task_exists(task_id) {
        return Err(format!("task is not running: {task_id}"));
    }

    let request = match request_or_validate_approval(
        approval_request_id,
        "close_task",
        "Closing a task can interrupt an active agent run.",
        ApprovalRiskLevel::Medium,
        format!("Task: {task_id}"),
    ) {
        Ok(request) => request,
        Err(pending) => return Ok(AgentActionResult::approval_required(pending.request)),
    };

    let result = close_task(task_id)?;
    mark_approval_executed(&request.request_id);
    Ok(AgentActionResult::success(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_backends::default_backend_for_target;
    use crate::agent_core::{
        approval::{create_approval_request, set_approval_status},
        models::{ApprovalRiskLevel, TaskAttentionState, TaskContextPreset, TaskRole},
        task_store::{get_task_detail, upsert_task_detail},
    };
    use crate::mcp::tools::test_support::TestHarness;
    use std::io;

    #[derive(Debug)]
    struct NoopKiller;

    impl portable_pty::ChildKiller for NoopKiller {
        fn kill(&mut self) -> io::Result<()> {
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            Box::new(NoopKiller)
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
            },
            recent_output_excerpt: String::new(),
            diff_summary: Vec::new(),
            log_path: log_path(task_id).to_string_lossy().to_string(),
            artifacts: Vec::new(),
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
        runtime().running.lock().unwrap().insert(
            "task-manual-close".into(),
            RunningTaskHandle {
                writer: Box::new(Vec::<u8>::new()),
                killer: Box::new(NoopKiller),
                pending_initial_input: None,
                trust_prompt_handled: false,
            },
        );

        let updated = close_task("task-manual-close").unwrap();
        assert_eq!(updated.status, "exited");
        assert_eq!(updated.attention_state, TaskAttentionState::Completed);
        assert_eq!(
            updated.termination_cause,
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
    fn request_task_close_rejects_missing_task_before_approval() {
        let _harness = TestHarness::new("close-missing-before-approval");
        let error = request_task_close("missing-task", None).unwrap_err();
        assert_eq!(error, "task is not running: missing-task");
    }

    #[test]
    fn codex_args_include_cwd_and_prompt() {
        let args = codex_args("D:/repo", "fix the bug");
        #[cfg(windows)]
        assert_eq!(
            args,
            vec![
                "-c".to_string(),
                r#"trust_level="trusted""#.to_string(),
                "-C".to_string(),
                "D:/repo".to_string(),
                "fix the bug".to_string(),
            ]
        );
        #[cfg(not(windows))]
        assert_eq!(
            args,
            vec![
                "-C".to_string(),
                "D:/repo".to_string(),
                "fix the bug".to_string(),
            ]
        );
    }

    #[cfg(windows)]
    #[test]
    fn command_for_codex_streams_initial_prompt_via_pty() {
        let backend = default_backend_for_target(&TaskTarget::Codex).unwrap();
        let launch = command_for(&backend, "review pending changes", "D:/repo", "Codex task");
        assert!(launch.display.contains("<prompt-via-pty>"));
        assert!(launch.display.contains("trust_level"));
        assert_eq!(
            launch.initial_input.as_deref(),
            Some("review pending changes")
        );
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

    #[cfg(windows)]
    #[test]
    fn resolve_windows_command_prefers_wrapped_scripts_over_extensionless_stub() {
        let harness = TestHarness::new("windows-command-resolution");
        let bin_dir = harness.workspace_root.join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        std::fs::write(bin_dir.join("codex"), "stub").unwrap();
        std::fs::write(bin_dir.join("codex.cmd"), "@echo off\r\n").unwrap();

        let original_path = std::env::var("PATH").unwrap_or_default();
        std::env::set_var(
            "PATH",
            format!("{};{original_path}", bin_dir.to_string_lossy()),
        );
        let resolved = resolve_windows_command("codex");
        std::env::set_var("PATH", original_path);

        assert!(resolved.to_ascii_lowercase().ends_with("codex.cmd"));
    }
}
