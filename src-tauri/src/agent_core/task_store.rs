use super::data_dir::{ensure_parent, tasks_path};
use super::models::{TaskAttentionState, TaskStatusDetail, TaskSummary, TaskTerminationCause};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(test)]
use std::sync::atomic::AtomicUsize;

const FLUSH_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskStoreFile {
    #[serde(default)]
    tasks: Vec<TaskStatusDetail>,
}

struct TaskStoreRuntime {
    path: PathBuf,
    tasks: Mutex<Vec<TaskStatusDetail>>,
    dirty: AtomicBool,
    flush_started: OnceLock<()>,
    #[cfg(test)]
    write_count: AtomicUsize,
}

fn runtime_registry() -> &'static Mutex<HashMap<PathBuf, Arc<TaskStoreRuntime>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<PathBuf, Arc<TaskStoreRuntime>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
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
    let json = serde_json::to_vec_pretty(store).map_err(|err| err.to_string())?;
    fs::write(path, json).map_err(|err| err.to_string())
}

impl TaskStoreRuntime {
    fn new(path: PathBuf) -> Self {
        let store = read_store(&path);
        Self {
            path,
            tasks: Mutex::new(store.tasks),
            dirty: AtomicBool::new(false),
            flush_started: OnceLock::new(),
            #[cfg(test)]
            write_count: AtomicUsize::new(0),
        }
    }

    fn snapshot(&self) -> Vec<TaskStatusDetail> {
        self.tasks.lock().unwrap().clone()
    }

    fn mutate(
        &self,
        mutator: impl FnOnce(&mut Vec<TaskStatusDetail>) -> Option<TaskStatusDetail>,
    ) -> Option<TaskStatusDetail> {
        let mut tasks = self.tasks.lock().unwrap();
        let updated = mutator(&mut tasks);
        if updated.is_some() {
            self.dirty.store(true, Ordering::Release);
        }
        updated
    }

    #[cfg(test)]
    fn replace_for_tests(&self, store: TaskStoreFile) -> Result<(), String> {
        *self.tasks.lock().unwrap() = store.tasks;
        self.dirty.store(true, Ordering::Release);
        self.flush_now()
    }

    fn flush_now(&self) -> Result<(), String> {
        if !self.dirty.swap(false, Ordering::AcqRel) {
            return Ok(());
        }

        let store = TaskStoreFile {
            tasks: self.snapshot(),
        };
        match write_store(&self.path, &store) {
            Ok(()) => {
                #[cfg(test)]
                self.write_count.fetch_add(1, Ordering::Relaxed);
                Ok(())
            }
            Err(err) => {
                self.dirty.store(true, Ordering::Release);
                Err(err)
            }
        }
    }

    fn ensure_flush_thread(self: &Arc<Self>) {
        if self.flush_started.set(()).is_err() {
            return;
        }

        let store = Arc::clone(self);
        thread::spawn(move || loop {
            thread::sleep(FLUSH_INTERVAL);
            if store.dirty.load(Ordering::Acquire) {
                let _ = store.flush_now();
            }
        });
    }
}

fn runtime_store() -> Arc<TaskStoreRuntime> {
    let path = tasks_path();
    let store = {
        let mut registry = runtime_registry().lock().unwrap();
        registry
            .entry(path.clone())
            .or_insert_with(|| Arc::new(TaskStoreRuntime::new(path)))
            .clone()
    };
    store.ensure_flush_thread();
    store
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
    let mut tasks = runtime_store().snapshot();
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
    runtime_store().mutate(|tasks| {
        let mut replaced = false;
        for existing in tasks.iter_mut() {
            if existing.summary.task_id == detail.summary.task_id {
                *existing = detail.clone();
                replaced = true;
                break;
            }
        }
        if !replaced {
            tasks.push(detail.clone());
        }
        Some(detail)
    });
    Ok(())
}

pub fn update_task<F>(task_id: &str, mut updater: F) -> Result<Option<TaskStatusDetail>, String>
where
    F: FnMut(&mut TaskStatusDetail),
{
    Ok(runtime_store().mutate(|tasks| {
        let mut updated = None;
        for detail in tasks.iter_mut() {
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
        updated
    }))
}

#[cfg(test)]
fn write_store_for_tests(store: TaskStoreFile) {
    runtime_store().replace_for_tests(store).unwrap();
}

#[cfg(test)]
fn flush_store_for_tests() {
    runtime_store().flush_now().unwrap();
}

#[cfg(test)]
fn store_write_count_for_tests() -> usize {
    runtime_store().write_count.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_core::models::{
        TaskAttentionState, TaskContextPreset, TaskSummary, TaskTarget, TaskTerminationCause,
    };
    use crate::mcp::tools::test_support::TestHarness;

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

    fn sample_detail(task_id: &str, status: &str) -> TaskStatusDetail {
        let mut summary = sample_summary(status);
        summary.task_id = task_id.to_string();
        summary.session_id = task_id.to_string();
        TaskStatusDetail {
            summary,
            recent_output_excerpt: String::new(),
            diff_summary: Vec::new(),
            log_path: format!("{task_id}.log"),
            artifacts: Vec::new(),
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

    #[test]
    fn update_task_uses_runtime_cache_and_flushes_lazily() {
        let _harness = TestHarness::new("task-store-runtime-cache");
        write_store_for_tests(TaskStoreFile {
            tasks: vec![sample_detail("task-1", "starting")],
        });
        let baseline_writes = store_write_count_for_tests();

        let updated = update_task("task-1", |detail| {
            detail.summary.status = "running".to_string();
            detail.recent_output_excerpt = "hello".to_string();
        })
        .unwrap()
        .expect("task should exist");

        assert_eq!(updated.summary.status, "running");
        let detail = get_task_detail("task-1").expect("task should be cached");
        assert_eq!(detail.recent_output_excerpt, "hello");
        assert_eq!(store_write_count_for_tests(), baseline_writes);

        flush_store_for_tests();
        assert!(store_write_count_for_tests() > baseline_writes);

        let persisted = read_store(&tasks_path());
        assert_eq!(persisted.tasks.len(), 1);
        assert_eq!(persisted.tasks[0].recent_output_excerpt, "hello");
    }

    #[test]
    fn list_task_details_reads_from_runtime_cache() {
        let _harness = TestHarness::new("task-store-list-cache");
        write_store_for_tests(TaskStoreFile {
            tasks: vec![sample_detail("task-1", "starting")],
        });

        update_task("task-1", |detail| {
            detail.summary.status = "exited".to_string();
            detail.summary.exit_code = Some(0);
        })
        .unwrap();

        let detail = list_task_details()
            .into_iter()
            .find(|task| task.summary.task_id == "task-1")
            .expect("task should exist");
        assert_eq!(detail.summary.status, "exited");
        assert_eq!(
            detail.summary.attention_state,
            TaskAttentionState::Completed
        );
    }

    #[test]
    fn read_store_defaults_missing_artifacts_for_legacy_json() {
        let _harness = TestHarness::new("task-store-legacy-json");
        ensure_parent(&tasks_path()).unwrap();
        fs::write(
            tasks_path(),
            r#"{
  "tasks": [
    {
      "summary": {
        "taskId": "task-legacy",
        "workspaceId": "workspace-1",
        "workspaceName": "mini-term",
        "workspaceRootPath": "D:/code/mini-term",
        "target": "codex",
        "title": "Legacy task",
        "status": "running",
        "attentionState": "running",
        "sessionId": "task-legacy",
        "cwd": "D:/code/mini-term",
        "startedAt": 1,
        "updatedAt": 1,
        "contextPreset": "standard",
        "changedFiles": [],
        "promptPreview": "prompt",
        "lastOutputExcerpt": "output"
      },
      "recentOutputExcerpt": "output",
      "diffSummary": [],
      "logPath": "task-legacy.log"
    }
  ]
}"#,
        )
        .unwrap();

        let detail = list_task_details()
            .into_iter()
            .find(|task| task.summary.task_id == "task-legacy")
            .expect("legacy task should load");
        assert!(detail.artifacts.is_empty());
    }
}
