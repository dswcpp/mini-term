use crate::config::{config_path_for_data_dir, APP_IDENTIFIER};
use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};

thread_local! {
    static THREAD_DATA_DIR: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
}

/// Override the data directory for the current test thread.
/// Each test thread gets its own isolated directory; no global lock needed.
#[cfg(test)]
pub fn set_thread_data_dir(path: PathBuf) {
    THREAD_DATA_DIR.with(|cell| *cell.borrow_mut() = Some(path));
}

/// Clear the per-thread data directory override set by `set_thread_data_dir`.
#[cfg(test)]
pub fn clear_thread_data_dir() {
    THREAD_DATA_DIR.with(|cell| *cell.borrow_mut() = None);
}

pub fn app_data_dir() -> PathBuf {
    // Per-thread override takes highest priority (used in tests).
    let thread_override = THREAD_DATA_DIR.with(|cell| cell.borrow().clone());
    if let Some(path) = thread_override {
        fs::create_dir_all(&path).ok();
        return path;
    }

    if let Ok(explicit) = std::env::var("MINI_TERM_DATA_DIR") {
        let path = PathBuf::from(explicit);
        fs::create_dir_all(&path).ok();
        return path;
    }

    let base = dirs::data_dir()
        .or_else(dirs::data_local_dir)
        .unwrap_or_else(std::env::temp_dir);
    let path = base.join(APP_IDENTIFIER);
    fs::create_dir_all(&path).ok();
    path
}

pub fn config_path() -> PathBuf {
    config_path_for_data_dir(&app_data_dir())
}

pub fn agent_state_dir() -> PathBuf {
    let path = app_data_dir().join("agent_state");
    fs::create_dir_all(&path).ok();
    path
}

pub fn logs_dir() -> PathBuf {
    let path = agent_state_dir().join("logs");
    fs::create_dir_all(&path).ok();
    path
}

pub fn task_artifacts_dir(task_id: &str) -> PathBuf {
    let path = agent_state_dir()
        .join("tasks")
        .join(task_id)
        .join("artifacts");
    fs::create_dir_all(&path).ok();
    path
}

pub fn tasks_path() -> PathBuf {
    agent_state_dir().join("tasks.json")
}

pub fn approvals_path() -> PathBuf {
    agent_state_dir().join("approvals.json")
}

pub fn ensure_parent(path: &Path) -> Result<(), String> {
    let parent = path.parent().ok_or("missing parent directory")?;
    fs::create_dir_all(parent).map_err(|err| err.to_string())
}
