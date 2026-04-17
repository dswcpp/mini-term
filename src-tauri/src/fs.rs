use base64::Engine as _;
use ignore::gitignore::Gitignore;
use notify::{Event as NotifyEvent, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::runtime_mcp;

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
        b.is_dir
            .cmp(&a.is_dir)
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

fn path_contains_always_ignored_component(
    project_root: &Path,
    full_path: &Path,
    is_dir: bool,
) -> bool {
    let relative = full_path
        .strip_prefix(project_root)
        .unwrap_or(full_path)
        .components()
        .filter_map(|component| component.as_os_str().to_str());

    for component in relative {
        if ALWAYS_IGNORE.contains(&component) {
            return true;
        }
    }

    if is_dir {
        return full_path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|name| ALWAYS_IGNORE.contains(&name));
    }

    false
}

fn should_ignore_watch_path(filter: &WatchFilter, full_path: &Path, is_dir: bool) -> bool {
    if path_contains_always_ignored_component(&filter.project_root, full_path, is_dir) {
        return true;
    }

    if let Some(gitignore) = &filter.gitignore {
        let mut current = Some(full_path);
        let mut current_is_dir = is_dir;
        while let Some(path) = current {
            if gitignore.matched(path, current_is_dir).is_ignore() {
                return true;
            }
            if path == filter.project_root {
                break;
            }
            current = path.parent();
            current_is_dir = true;
        }
    }

    false
}

fn start_runtime_batcher(project_path: String) -> mpsc::Sender<runtime_mcp::RuntimeFsEventRecord> {
    let runtime_path = runtime_mcp::runtime_state_path_for_current_thread();
    let (tx, rx) = mpsc::channel::<runtime_mcp::RuntimeFsEventRecord>();
    thread::spawn(move || {
        let mut pending = Vec::<runtime_mcp::RuntimeFsEventRecord>::new();
        loop {
            match rx.recv_timeout(WATCH_BATCH_WINDOW) {
                Ok(event) => {
                    pending.push(event);
                    while let Ok(event) = rx.try_recv() {
                        pending.push(event);
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    if !pending.is_empty() {
                        let _ = runtime_mcp::record_fs_event_batch_for_path(
                            runtime_path.clone(),
                            &project_path,
                            &pending,
                        );
                    }
                    return;
                }
            }

            if !pending.is_empty() {
                let batch = std::mem::take(&mut pending);
                let _ = runtime_mcp::record_fs_event_batch_for_path(
                    runtime_path.clone(),
                    &project_path,
                    &batch,
                );
            }
        }
    });
    tx
}

const ALWAYS_IGNORE: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    ".next",
    "dist",
    "__pycache__",
    ".superpowers",
];

const WATCH_BATCH_WINDOW: Duration = Duration::from_millis(150);

struct WatchFilter {
    project_root: PathBuf,
    gitignore: Option<Gitignore>,
}

struct FsWatchHandle {
    _watcher: RecommendedWatcher,
    _runtime_batcher: mpsc::Sender<runtime_mcp::RuntimeFsEventRecord>,
}

/// 过滤出有效的目录路径（用于拖拽添加项目时验证）
#[tauri::command]
pub fn filter_directories(paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .filter(|p| Path::new(p).is_dir())
        .collect()
}

#[cfg(test)]
fn should_ignore(
    name: &str,
    full_path: &Path,
    is_dir: bool,
    gitignore: &Option<Gitignore>,
) -> bool {
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
    watchers: Arc<Mutex<HashMap<String, FsWatchHandle>>>,
}

impl FsWatcherManager {
    pub fn new() -> Self {
        Self {
            watchers: Arc::new(Mutex::new(HashMap::new())),
        }
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
    let filter = Arc::new(WatchFilter {
        project_root: PathBuf::from(&project_path),
        gitignore: build_gitignore(Path::new(&project_path)),
    });
    let runtime_batcher = start_runtime_batcher(project_path.clone());
    let runtime_batcher_clone = runtime_batcher.clone();

    let mut watcher = notify::recommended_watcher(move |res: Result<NotifyEvent, _>| {
        if let Ok(event) = res {
            for p in &event.paths {
                let is_dir = p.is_dir();
                if should_ignore_watch_path(&filter, p, is_dir) {
                    continue;
                }

                let path = p.to_string_lossy().to_string();
                let kind = format!("{:?}", event.kind);
                let _ = app_clone.emit(
                    "fs-change",
                    FsChangePayload {
                        project_path: project_path_clone.clone(),
                        path: path.clone(),
                        kind: kind.clone(),
                    },
                );
                let _ =
                    runtime_batcher_clone.send(runtime_mcp::RuntimeFsEventRecord { path, kind });
            }
        }
    })
    .map_err(|e| e.to_string())?;

    let recursive_mode = if recursive.unwrap_or(false) {
        RecursiveMode::Recursive
    } else {
        RecursiveMode::NonRecursive
    };

    watcher
        .watch(&watch_path, recursive_mode)
        .map_err(|e| e.to_string())?;

    let mut watchers = state.watchers.lock().unwrap();
    watchers.remove(&path);
    watchers.insert(
        path,
        FsWatchHandle {
            _watcher: watcher,
            _runtime_batcher: runtime_batcher,
        },
    );
    let _ = runtime_mcp::register_fs_watch(
        &watch_path.to_string_lossy(),
        &project_path,
        recursive.unwrap_or(false),
    );
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContentResult {
    pub content: String,
    pub is_binary: bool,
    pub too_large: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPreviewResult {
    pub kind: String,
    pub mime_type: Option<String>,
    pub text_content: Option<String>,
    pub too_large: bool,
    pub byte_length: u64,
    pub open_externally_recommended: bool,
    pub warning: Option<String>,
}

const MAX_FILE_VIEW_SIZE: u64 = 1_048_576; // 1MB
const MAX_DOCUMENT_PREVIEW_SIZE: u64 = 25 * 1024 * 1024; // 25MB

fn normalized_extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{}", value.to_ascii_lowercase()))
        .unwrap_or_default()
}

fn normalized_file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default()
}

fn text_like_extension(extension: &str) -> bool {
    matches!(
        extension,
        ".c" | ".cc"
            | ".cpp"
            | ".cxx"
            | ".h"
            | ".hh"
            | ".hpp"
            | ".hxx"
            | ".py"
            | ".rs"
            | ".go"
            | ".qml"
            | ".qss"
            | ".ps1"
            | ".bat"
            | ".cmd"
            | ".sh"
            | ".bash"
            | ".zsh"
            | ".js"
            | ".jsx"
            | ".ts"
            | ".tsx"
            | ".css"
            | ".html"
            | ".htm"
            | ".json"
            | ".yaml"
            | ".yml"
            | ".toml"
            | ".xml"
            | ".ui"
            | ".md"
            | ".markdown"
            | ".mdown"
            | ".mkd"
            | ".mmd"
            | ".mermaid"
            | ".txt"
            | ".log"
            | ".ini"
            | ".conf"
            | ".cfg"
            | ".csv"
            | ".tsv"
            | ".env"
            | ".sql"
    )
}

fn text_like_file_name(file_name: &str) -> bool {
    matches!(
        file_name,
        "dockerfile" | "makefile" | "readme" | "license" | ".gitignore"
    )
}

fn markdown_extension(extension: &str) -> bool {
    matches!(extension, ".md" | ".markdown" | ".mdown" | ".mkd")
}

fn image_extension(extension: &str) -> bool {
    matches!(
        extension,
        ".png" | ".jpg" | ".jpeg" | ".gif" | ".webp" | ".bmp" | ".ico"
    )
}

fn binary_preview_extension(extension: &str) -> bool {
    image_extension(extension) || matches!(extension, ".pdf" | ".docx")
}

fn mime_type_for_extension(extension: &str) -> Option<&'static str> {
    match extension {
        ".md" | ".markdown" | ".mdown" | ".mkd" => Some("text/markdown"),
        ".mmd" | ".mermaid" => Some("text/plain"),
        ".svg" => Some("image/svg+xml"),
        ".png" => Some("image/png"),
        ".jpg" | ".jpeg" => Some("image/jpeg"),
        ".gif" => Some("image/gif"),
        ".webp" => Some("image/webp"),
        ".bmp" => Some("image/bmp"),
        ".ico" => Some("image/x-icon"),
        ".pdf" => Some("application/pdf"),
        ".docx" => Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        ".doc" => Some("application/msword"),
        _ => None,
    }
}

fn build_document_preview_result(
    kind: &str,
    byte_length: u64,
    mime_type: Option<&'static str>,
    text_content: Option<String>,
    too_large: bool,
    open_externally_recommended: bool,
    warning: Option<String>,
) -> DocumentPreviewResult {
    DocumentPreviewResult {
        kind: kind.to_string(),
        mime_type: mime_type.map(str::to_string),
        text_content,
        too_large,
        byte_length,
        open_externally_recommended,
        warning,
    }
}

fn read_utf8_preview(
    path: &Path,
    kind: &str,
    byte_length: u64,
    mime_type: Option<&'static str>,
) -> DocumentPreviewResult {
    match fs::read(path) {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(text) => build_document_preview_result(
                kind,
                byte_length,
                mime_type,
                Some(text),
                false,
                false,
                None,
            ),
            Err(_) => build_document_preview_result(
                "unsupported",
                byte_length,
                mime_type,
                None,
                false,
                true,
                Some("Mini-Term could not decode this file as UTF-8 text.".to_string()),
            ),
        },
        Err(error) => build_document_preview_result(
            "unsupported",
            byte_length,
            mime_type,
            None,
            false,
            true,
            Some(format!("Failed to read file: {error}")),
        ),
    }
}

#[tauri::command]
pub fn read_file_content(path: String) -> Result<FileContentResult, String> {
    let p = Path::new(&path);
    if !p.is_file() {
        return Err(format!("不是文件: {}", path));
    }
    let metadata = fs::metadata(p).map_err(|e| e.to_string())?;
    if metadata.len() > MAX_FILE_VIEW_SIZE {
        return Ok(FileContentResult {
            content: String::new(),
            is_binary: false,
            too_large: true,
        });
    }
    let bytes = fs::read(p).map_err(|e| e.to_string())?;
    match String::from_utf8(bytes) {
        Ok(s) => Ok(FileContentResult {
            content: s,
            is_binary: false,
            too_large: false,
        }),
        Err(_) => Ok(FileContentResult {
            content: String::new(),
            is_binary: true,
            too_large: false,
        }),
    }
}

#[tauri::command]
pub fn read_document_preview(path: String) -> Result<DocumentPreviewResult, String> {
    let p = Path::new(&path);
    if !p.is_file() {
        return Err(format!("Not a file: {}", path));
    }

    let metadata = fs::metadata(p).map_err(|e| e.to_string())?;
    let byte_length = metadata.len();
    let extension = normalized_extension(p);
    let file_name = normalized_file_name(p);
    let mime_type = mime_type_for_extension(&extension);

    if image_extension(&extension) {
        if byte_length > MAX_DOCUMENT_PREVIEW_SIZE {
            return Ok(build_document_preview_result(
                "image",
                byte_length,
                mime_type,
                None,
                true,
                true,
                Some("This image is larger than Mini-Term's 25 MB preview limit.".to_string()),
            ));
        }

        return Ok(build_document_preview_result(
            "image",
            byte_length,
            mime_type,
            None,
            false,
            false,
            None,
        ));
    }

    if extension == ".pdf" {
        if byte_length > MAX_DOCUMENT_PREVIEW_SIZE {
            return Ok(build_document_preview_result(
                "pdf",
                byte_length,
                mime_type,
                None,
                true,
                true,
                Some("This PDF is larger than Mini-Term's 25 MB preview limit.".to_string()),
            ));
        }

        return Ok(build_document_preview_result(
            "pdf",
            byte_length,
            mime_type,
            None,
            false,
            false,
            None,
        ));
    }

    if extension == ".docx" {
        if byte_length > MAX_DOCUMENT_PREVIEW_SIZE {
            return Ok(build_document_preview_result(
                "docx",
                byte_length,
                mime_type,
                None,
                true,
                true,
                Some("This DOCX file is larger than Mini-Term's 25 MB preview limit.".to_string()),
            ));
        }

        return Ok(build_document_preview_result(
            "docx",
            byte_length,
            mime_type,
            None,
            false,
            false,
            None,
        ));
    }

    if extension == ".doc" {
        if byte_length > MAX_DOCUMENT_PREVIEW_SIZE {
            return Ok(build_document_preview_result(
                "doc",
                byte_length,
                mime_type,
                None,
                true,
                true,
                Some("This DOC file is larger than Mini-Term's 25 MB preview limit.".to_string()),
            ));
        }

        return Ok(build_document_preview_result(
            "doc",
            byte_length,
            mime_type,
            None,
            false,
            true,
            Some(
                "Mini-Term does not provide in-app layout preview for legacy .doc files."
                    .to_string(),
            ),
        ));
    }

    if extension == ".svg" {
        if byte_length > MAX_DOCUMENT_PREVIEW_SIZE {
            return Ok(build_document_preview_result(
                "svg",
                byte_length,
                mime_type,
                None,
                true,
                true,
                Some("This SVG file is larger than Mini-Term's 25 MB preview limit.".to_string()),
            ));
        }

        return Ok(read_utf8_preview(p, "svg", byte_length, mime_type));
    }

    if byte_length <= MAX_FILE_VIEW_SIZE {
        let text_kind = if markdown_extension(&extension) {
            "markdown"
        } else if text_like_extension(&extension)
            || text_like_file_name(&file_name)
            || extension.is_empty()
        {
            "text"
        } else {
            ""
        };

        if !text_kind.is_empty() {
            return Ok(read_utf8_preview(p, text_kind, byte_length, mime_type));
        }

        return match fs::read(p) {
            Ok(bytes) => match String::from_utf8(bytes) {
                Ok(text) => Ok(build_document_preview_result(
                    "text",
                    byte_length,
                    Some("text/plain"),
                    Some(text),
                    false,
                    false,
                    None,
                )),
                Err(_) => Ok(build_document_preview_result(
                    "unsupported",
                    byte_length,
                    None,
                    None,
                    false,
                    true,
                    Some("Mini-Term does not support previewing this file type.".to_string()),
                )),
            },
            Err(error) => Err(error.to_string()),
        };
    }

    if markdown_extension(&extension)
        || text_like_extension(&extension)
        || text_like_file_name(&file_name)
    {
        return Ok(build_document_preview_result(
            if markdown_extension(&extension) {
                "markdown"
            } else {
                "text"
            },
            byte_length,
            mime_type.or(Some("text/plain")),
            None,
            true,
            true,
            Some("This text file is larger than Mini-Term's 1 MB preview limit.".to_string()),
        ));
    }

    Ok(build_document_preview_result(
        "unsupported",
        byte_length,
        mime_type,
        None,
        byte_length > MAX_DOCUMENT_PREVIEW_SIZE,
        true,
        Some(
            if byte_length > MAX_DOCUMENT_PREVIEW_SIZE {
                "This file is larger than Mini-Term's preview limit."
            } else {
                "Mini-Term does not support previewing this file type."
            }
            .to_string(),
        ),
    ))
}

#[tauri::command]
pub fn read_image_data_url(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    if !p.is_file() {
        return Err(format!("Not a file: {}", path));
    }

    let metadata = fs::metadata(p).map_err(|e| e.to_string())?;
    let byte_length = metadata.len();
    let extension = normalized_extension(p);
    let mime_type = mime_type_for_extension(&extension)
        .filter(|_| image_extension(&extension))
        .ok_or_else(|| format!("Unsupported image type: {}", extension))?;

    if byte_length > MAX_DOCUMENT_PREVIEW_SIZE {
        return Err(format!(
            "Image exceeds Mini-Term's {} byte preview limit.",
            MAX_DOCUMENT_PREVIEW_SIZE
        ));
    }

    let bytes = fs::read(p).map_err(|e| e.to_string())?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{};base64,{}", mime_type, encoded))
}

#[tauri::command]
pub fn read_binary_preview_base64(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    if !p.is_file() {
        return Err(format!("Not a file: {}", path));
    }

    let metadata = fs::metadata(p).map_err(|e| e.to_string())?;
    let byte_length = metadata.len();
    let extension = normalized_extension(p);

    if !binary_preview_extension(&extension) {
        return Err(format!("Unsupported binary preview type: {}", extension));
    }

    if byte_length > MAX_DOCUMENT_PREVIEW_SIZE {
        return Err(format!(
            "File exceeds Mini-Term's {} byte preview limit.",
            MAX_DOCUMENT_PREVIEW_SIZE
        ));
    }

    let bytes = fs::read(p).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
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
pub fn unwatch_directory(
    state: tauri::State<'_, FsWatcherManager>,
    path: String,
) -> Result<(), String> {
    let mut watchers = state.watchers.lock().unwrap();
    watchers.remove(&path);
    let _ = runtime_mcp::unregister_fs_watch(&path);
    Ok(())
}

#[tauri::command]
pub fn rename_entry(old_path: String, new_name: String) -> Result<String, String> {
    let p = Path::new(&old_path);
    if !p.exists() {
        return Err(format!("路径不存在: {}", old_path));
    }
    let parent = p.parent().ok_or("无法获取父目录")?;
    let new_path = parent.join(&new_name);
    if new_path.exists() {
        return Err(format!("目标已存在: {}", new_path.display()));
    }
    fs::rename(p, &new_path).map_err(|e| e.to_string())?;
    Ok(new_path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::tools::test_support::TestHarness;
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

        assert_eq!(
            entries.first().map(|entry| entry.name.as_str()),
            Some("src")
        );
        assert_eq!(entries.first().map(|entry| entry.is_dir), Some(true));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn should_ignore_watch_paths_for_nested_ignored_directories() {
        let root = create_temp_dir("watch-ignore-nested");
        let nested = root.join("node_modules").join("package").join("index.js");
        let filter = WatchFilter {
            project_root: root.clone(),
            gitignore: None,
        };

        assert!(should_ignore_watch_path(&filter, &nested, false));
        assert!(path_contains_always_ignored_component(
            &root,
            &root.join(".git").join("objects"),
            true
        ));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn should_ignore_watch_paths_respects_gitignore() {
        let root = create_temp_dir("watch-ignore-gitignore");
        fs::write(root.join(".gitignore"), "*.log\ncoverage/\n").unwrap();
        let filter = WatchFilter {
            project_root: root.clone(),
            gitignore: build_gitignore(&root),
        };

        assert!(should_ignore_watch_path(
            &filter,
            &root.join("build.log"),
            false
        ));
        assert!(should_ignore_watch_path(
            &filter,
            &root.join("coverage").join("index.html"),
            false
        ));
        assert!(!should_ignore_watch_path(
            &filter,
            &root.join("src").join("main.rs"),
            false
        ));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn runtime_batcher_coalesces_fs_events() {
        let harness = TestHarness::new("fs-runtime-batcher");
        runtime_mcp::initialize_runtime_host("test-version").unwrap();
        let batcher = start_runtime_batcher(harness.workspace_path());
        batcher
            .send(runtime_mcp::RuntimeFsEventRecord {
                path: format!("{}/src/main.rs", harness.workspace_path()),
                kind: "Modify(File(Data(Any)))".to_string(),
            })
            .unwrap();
        batcher
            .send(runtime_mcp::RuntimeFsEventRecord {
                path: format!("{}/src/lib.rs", harness.workspace_path()),
                kind: "Modify(File(Data(Any)))".to_string(),
            })
            .unwrap();
        drop(batcher);

        std::thread::sleep(WATCH_BATCH_WINDOW + Duration::from_millis(50));

        let state = runtime_mcp::load_runtime_state();
        let event = state
            .recent_events
            .iter()
            .rev()
            .find(|event| event.kind == "fs-change")
            .expect("fs-change event should exist");
        assert!(event.summary.contains("2 paths"));
        assert_eq!(
            event
                .payload_preview
                .as_ref()
                .and_then(|payload| payload.get("count"))
                .and_then(|value| value.as_u64()),
            Some(2)
        );
    }

    #[test]
    fn read_document_preview_detects_markdown_and_text() {
        let root = create_temp_dir("preview-markdown");
        let markdown_path = root.join("README.md");
        let text_path = root.join("notes.txt");
        let mermaid_path = root.join("flow.mmd");
        fs::write(&markdown_path, "# Title").unwrap();
        fs::write(&text_path, "hello").unwrap();
        fs::write(&mermaid_path, "graph TD\n  A --> B").unwrap();

        let markdown = read_document_preview(markdown_path.to_string_lossy().to_string()).unwrap();
        let text = read_document_preview(text_path.to_string_lossy().to_string()).unwrap();
        let mermaid = read_document_preview(mermaid_path.to_string_lossy().to_string()).unwrap();

        assert_eq!(markdown.kind, "markdown");
        assert_eq!(markdown.text_content.as_deref(), Some("# Title"));
        assert_eq!(text.kind, "text");
        assert_eq!(text.text_content.as_deref(), Some("hello"));
        assert_eq!(mermaid.kind, "text");
        assert_eq!(mermaid.text_content.as_deref(), Some("graph TD\n  A --> B"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn read_document_preview_detects_svg_and_binary_documents() {
        let root = create_temp_dir("preview-assets");
        let svg_path = root.join("icon.svg");
        let png_path = root.join("image.png");
        let pdf_path = root.join("book.pdf");
        let docx_path = root.join("spec.docx");
        let doc_path = root.join("legacy.doc");

        fs::write(
            &svg_path,
            r#"<svg xmlns="http://www.w3.org/2000/svg"></svg>"#,
        )
        .unwrap();
        fs::write(&png_path, [0x89, b'P', b'N', b'G']).unwrap();
        fs::write(&pdf_path, b"%PDF-1.7").unwrap();
        fs::write(&docx_path, b"PK\x03\x04").unwrap();
        fs::write(&doc_path, [0xD0, 0xCF, 0x11, 0xE0]).unwrap();

        let svg = read_document_preview(svg_path.to_string_lossy().to_string()).unwrap();
        let png = read_document_preview(png_path.to_string_lossy().to_string()).unwrap();
        let pdf = read_document_preview(pdf_path.to_string_lossy().to_string()).unwrap();
        let docx = read_document_preview(docx_path.to_string_lossy().to_string()).unwrap();
        let doc = read_document_preview(doc_path.to_string_lossy().to_string()).unwrap();

        assert_eq!(svg.kind, "svg");
        assert!(svg.text_content.is_some());
        assert_eq!(png.kind, "image");
        assert_eq!(pdf.kind, "pdf");
        assert_eq!(docx.kind, "docx");
        assert_eq!(doc.kind, "doc");
        assert!(doc.open_externally_recommended);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn read_document_preview_flags_unsupported_binary() {
        let root = create_temp_dir("preview-unsupported");
        let path = root.join("archive.bin");
        fs::write(&path, [0, 159, 146, 150]).unwrap();

        let preview = read_document_preview(path.to_string_lossy().to_string()).unwrap();
        assert_eq!(preview.kind, "unsupported");
        assert!(preview.open_externally_recommended);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn read_document_preview_applies_size_limits() {
        let root = create_temp_dir("preview-size");
        let text_path = root.join("large.txt");
        let image_path = root.join("large.png");

        fs::write(&text_path, vec![b'a'; (MAX_FILE_VIEW_SIZE + 1) as usize]).unwrap();
        fs::write(
            &image_path,
            vec![0; (MAX_DOCUMENT_PREVIEW_SIZE + 1) as usize],
        )
        .unwrap();

        let text_preview = read_document_preview(text_path.to_string_lossy().to_string()).unwrap();
        let image_preview =
            read_document_preview(image_path.to_string_lossy().to_string()).unwrap();

        assert_eq!(text_preview.kind, "text");
        assert!(text_preview.too_large);
        assert_eq!(image_preview.kind, "image");
        assert!(image_preview.too_large);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn read_image_data_url_returns_inline_payload_for_supported_images() {
        let root = create_temp_dir("preview-image-data-url");
        let ico_path = root.join("icon.ico");
        fs::write(&ico_path, [0, 0, 1, 0, 1, 0]).unwrap();

        let data_url = read_image_data_url(ico_path.to_string_lossy().to_string()).unwrap();

        assert!(data_url.starts_with("data:image/x-icon;base64,"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn read_binary_preview_base64_returns_payload_for_docx() {
        let root = create_temp_dir("preview-binary-base64");
        let docx_path = root.join("spec.docx");
        fs::write(&docx_path, b"PK\x03\x04").unwrap();

        let payload = read_binary_preview_base64(docx_path.to_string_lossy().to_string()).unwrap();

        assert_eq!(payload, "UEsDBA==");

        let _ = fs::remove_dir_all(root);
    }
}
