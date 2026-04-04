use ignore::gitignore::Gitignore;
use notify::{RecommendedWatcher, RecursiveMode, Watcher, Event as NotifyEvent};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub ignored: bool,
}

fn sort_entries(entries: &mut [FileEntry]) {
    entries.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir)
            .then_with(|| a.ignored.cmp(&b.ignored))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

fn build_gitignore(project_root: &Path) -> Option<Gitignore> {
    let gitignore_path = project_root.join(".gitignore");
    if !gitignore_path.exists() {
        return None;
    }
    let (gi, _err) = Gitignore::new(&gitignore_path);
    Some(gi)
}

const ALWAYS_IGNORE: &[&str] = &[".git", "node_modules", "target", ".next", "dist", "__pycache__", ".superpowers"];

#[cfg(test)]
fn should_ignore(name: &str, full_path: &Path, is_dir: bool, gitignore: &Option<Gitignore>) -> bool {
    if is_dir && ALWAYS_IGNORE.contains(&name) {
        return true;
    }
    if let Some(gi) = gitignore {
        return gi.matched(full_path, is_dir).is_ignore();
    }
    false
}

#[tauri::command]
pub fn list_directory(project_root: String, path: String) -> Result<Vec<FileEntry>, String> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }
    let gitignore = build_gitignore(Path::new(&project_root));
    let mut entries: Vec<FileEntry> = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().ok()?.is_dir();
            let full_path = entry.path();
            // ALWAYS_IGNORE 目录仍然完全隐藏
            if is_dir && ALWAYS_IGNORE.contains(&name.as_str()) {
                return None;
            }
            let ignored = if let Some(gi) = &gitignore {
                gi.matched(&full_path, is_dir).is_ignore()
            } else {
                false
            };
            Some(FileEntry {
                name,
                path: full_path.to_string_lossy().to_string(),
                is_dir,
                ignored,
            })
        })
        .collect();
    sort_entries(&mut entries);
    Ok(entries)
}

#[tauri::command]
pub fn complete_path_entries(path: String) -> Result<Vec<FileEntry>, String> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let mut entries: Vec<FileEntry> = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().ok()?.is_dir();
            let full_path = entry.path();
            Some(FileEntry {
                name,
                path: full_path.to_string_lossy().to_string(),
                is_dir,
                ignored: false,
            })
        })
        .collect();
    sort_entries(&mut entries);
    Ok(entries)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FsChangePayload {
    project_path: String,
    path: String,
    kind: String,
}

pub struct FsWatcherManager {
    watchers: Arc<Mutex<HashMap<String, RecommendedWatcher>>>,
}

impl FsWatcherManager {
    pub fn new() -> Self {
        Self { watchers: Arc::new(Mutex::new(HashMap::new())) }
    }
}

#[tauri::command]
pub fn watch_directory(
    app: AppHandle,
    state: tauri::State<'_, FsWatcherManager>,
    path: String,
    project_path: String,
    recursive: Option<bool>,
) -> Result<(), String> {
    let watch_path = PathBuf::from(&path);
    let project_path_clone = project_path.clone();
    let app_clone = app.clone();

    let mut watcher = notify::recommended_watcher(move |res: Result<NotifyEvent, _>| {
        if let Ok(event) = res {
            for p in &event.paths {
                let _ = app_clone.emit("fs-change", FsChangePayload {
                    project_path: project_path_clone.clone(),
                    path: p.to_string_lossy().to_string(),
                    kind: format!("{:?}", event.kind),
                });
            }
        }
    }).map_err(|e| e.to_string())?;

    let recursive_mode = if recursive.unwrap_or(false) {
        RecursiveMode::Recursive
    } else {
        RecursiveMode::NonRecursive
    };

    watcher.watch(&watch_path, recursive_mode).map_err(|e| e.to_string())?;

    let mut watchers = state.watchers.lock().unwrap();
    watchers.insert(path, watcher);
    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContentResult {
    pub content: String,
    pub is_binary: bool,
    pub too_large: bool,
}

const MAX_FILE_VIEW_SIZE: u64 = 1_048_576; // 1MB

#[tauri::command]
pub fn read_file_content(path: String) -> Result<FileContentResult, String> {
    let p = Path::new(&path);
    if !p.is_file() {
        return Err(format!("不是文件: {}", path));
    }
    let metadata = fs::metadata(p).map_err(|e| e.to_string())?;
    if metadata.len() > MAX_FILE_VIEW_SIZE {
        return Ok(FileContentResult { content: String::new(), is_binary: false, too_large: true });
    }
    let bytes = fs::read(p).map_err(|e| e.to_string())?;
    match String::from_utf8(bytes) {
        Ok(s) => Ok(FileContentResult { content: s, is_binary: false, too_large: false }),
        Err(_) => Ok(FileContentResult { content: String::new(), is_binary: true, too_large: false }),
    }
}

#[tauri::command]
pub fn create_file(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.exists() {
        return Err(format!("已存在: {}", path));
    }
    fs::write(p, "").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_directory(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.exists() {
        return Err(format!("已存在: {}", path));
    }
    fs::create_dir(p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    fs::write(Path::new(&path), content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_binary_file(path: String, bytes: Vec<u8>) -> Result<(), String> {
    fs::write(Path::new(&path), bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn unwatch_directory(state: tauri::State<'_, FsWatcherManager>, path: String) -> Result<(), String> {
    let mut watchers = state.watchers.lock().unwrap();
    watchers.remove(&path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn create_temp_dir(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("mini-term-fs-{label}-{unique}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn should_ignore_node_modules() {
        let path = Path::new("node_modules");
        assert!(should_ignore("node_modules", path, true, &None));
        let git_path = Path::new(".git");
        assert!(should_ignore(".git", git_path, true, &None));
    }

    #[test]
    fn should_not_ignore_src() {
        let path = Path::new("src");
        assert!(!should_ignore("src", path, true, &None));
    }

    #[test]
    fn complete_path_entries_keeps_items_hidden_from_file_tree_filters() {
        let root = create_temp_dir("completion-hidden");
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(root.join(".env"), "demo").unwrap();

        let entries = complete_path_entries(root.to_string_lossy().to_string()).unwrap();
        let names: Vec<String> = entries.into_iter().map(|entry| entry.name).collect();

        assert!(names.contains(&".git".to_string()));
        assert!(names.contains(&"node_modules".to_string()));
        assert!(names.contains(&".env".to_string()));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn complete_path_entries_sorts_directories_before_files() {
        let root = create_temp_dir("completion-sort");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("README.md"), "demo").unwrap();

        let entries = complete_path_entries(root.to_string_lossy().to_string()).unwrap();

        assert_eq!(entries.first().map(|entry| entry.name.as_str()), Some("src"));
        assert_eq!(entries.first().map(|entry| entry.is_dir), Some(true));

        let _ = fs::remove_dir_all(root);
    }
}
