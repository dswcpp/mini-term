use super::data_dir::{ensure_parent, tasks_path};
use super::models::{TaskAttentionState, TaskStatusDetail, TaskSummary, TaskTerminationCause};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskStoreFile {
    #[serde(default)]
    tasks: Vec<TaskStatusDetail>,
}

fn now_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn read_store(path: &Path) -> TaskStoreFile {
    match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => TaskStoreFile::default(),
    }
}

fn write_store(path: &Path, store: &TaskStoreFile) -> Result<(), String> {
    ensure_parent(path)?;
    let json = serde_json::to_string_pretty(store).map_err(|err| err.to_string())?;
    fs::write(path, json).map_err(|err| err.to_string())
}

fn derive_runtime_status(summary: &TaskSummary) -> String {
    if matches!(
        summary.termination_cause,
        Some(TaskTerminationCause::ManualClose)
    ) {
        return "exited".to_string();
    }

    match summary.status.as_str() {
        "starting" | "running" | "waiting-input" | "error" | "exited" => summary.status.clone(),
        _ if summary.exit_code.is_some_and(|code| code != 0) => "error".to_string(),
        _ => "running".to_string(),
    }
}

fn derive_attention(summary: &TaskSummary, derived_status: &str) -> TaskAttentionState {
    if matches!(
        summary.termination_cause,
        Some(TaskTerminationCause::ManualClose)
    ) {
        return TaskAttentionState::Completed;
    }

    if derived_status == "error" || summary.exit_code.is_some_and(|code| code != 0) {
        return TaskAttentionState::Failed;
    }
    if derived_status == "exited" {
        if !summary.changed_files.is_empty() {
            return TaskAttentionState::NeedsReview;
        }
        return TaskAttentionState::Completed;
    }
    if derived_status == "waiting-input" {
        return TaskAttentionState::WaitingInput;
    }
    TaskAttentionState::Running
}

pub fn list_task_details() -> Vec<TaskStatusDetail> {
    let store = read_store(&tasks_path());
    let mut tasks = store.tasks;
    for task in &mut tasks {
        let derived_status = derive_runtime_status(&task.summary);
        task.summary.status = derived_status.clone();
        task.summary.attention_state = derive_attention(&task.summary, &derived_status);
    }
    tasks.sort_by(|left, right| right.summary.updated_at.cmp(&left.summary.updated_at));
    tasks
}

pub fn get_task_detail(task_id: &str) -> Option<TaskStatusDetail> {
    list_task_details()
        .into_iter()
        .find(|task| task.summary.task_id == task_id)
}

pub fn upsert_task_detail(detail: TaskStatusDetail) -> Result<(), String> {
    let path = tasks_path();
    let mut store = read_store(&path);
    let mut replaced = false;
    for existing in &mut store.tasks {
        if existing.summary.task_id == detail.summary.task_id {
            *existing = detail.clone();
            replaced = true;
            break;
        }
    }
    if !replaced {
        store.tasks.push(detail);
    }
    write_store(&path, &store)
}

pub fn update_task<F>(task_id: &str, mut updater: F) -> Result<Option<TaskStatusDetail>, String>
where
    F: FnMut(&mut TaskStatusDetail),
{
    let path = tasks_path();
    let mut store = read_store(&path);
    let mut updated = None;
    for detail in &mut store.tasks {
        if detail.summary.task_id == task_id {
            updater(detail);
            detail.summary.updated_at = now_timestamp_ms().max(detail.summary.updated_at);
            let derived_status = derive_runtime_status(&detail.summary);
            detail.summary.status = derived_status.clone();
            detail.summary.attention_state = derive_attention(&detail.summary, &derived_status);
            updated = Some(detail.clone());
            break;
        }
    }
    if updated.is_some() {
        write_store(&path, &store)?;
    }
    Ok(updated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_core::models::{
        TaskAttentionState, TaskContextPreset, TaskSummary, TaskTarget, TaskTerminationCause,
    };
    fn sample_summary(status: &str) -> TaskSummary {
        TaskSummary {
            task_id: "task-1".into(),
            workspace_id: "workspace-1".into(),
            workspace_name: "mini-term".into(),
            workspace_root_path: "D:/code/mini-term".into(),
            target: TaskTarget::Codex,
            title: "Sample task".into(),
            status: status.into(),
            attention_state: TaskAttentionState::Running,
            session_id: "task-1".into(),
            cwd: "D:/code/mini-term".into(),
            started_at: 1,
            updated_at: 1,
            completed_at: None,
            exit_code: None,
            context_preset: TaskContextPreset::Standard,
            changed_files: Vec::new(),
            prompt_preview: "prompt".into(),
            last_output_excerpt: "output".into(),
            injection_profile_id: None,
            injection_preset: None,
            policy_summary: None,
            termination_cause: None,
        }
    }

    #[test]
    fn running_tasks_do_not_degrade_to_waiting_input_by_timeout() {
        let mut summary = sample_summary("running");
        summary.updated_at = 1;
        let derived = derive_runtime_status(&summary);
        assert_eq!(derived, "running");
        assert_eq!(
            derive_attention(&summary, &derived),
            TaskAttentionState::Running
        );
    }

    #[test]
    fn manual_close_is_treated_as_completed_exit() {
        let mut summary = sample_summary("error");
        summary.termination_cause = Some(TaskTerminationCause::ManualClose);

        let derived = derive_runtime_status(&summary);
        assert_eq!(derived, "exited");
        assert_eq!(
            derive_attention(&summary, &derived),
            TaskAttentionState::Completed
        );
    }
}
