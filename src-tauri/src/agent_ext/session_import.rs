use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

const MAX_SUMMARY_CHARS: usize = 160;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSessionSummary {
    pub provider_id: String,
    pub session_id: String,
    pub title: String,
    pub timestamp: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    pub source_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_command: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSessionMessage {
    pub role: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSessionDeleteOutcome {
    pub provider_id: String,
    pub session_id: String,
    pub source_path: String,
    pub deleted: bool,
}

fn home_dir() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("MINI_TERM_HOME_DIR") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    dirs::home_dir()
}

fn clean_path(path: &str) -> String {
    #[cfg(windows)]
    {
        let cleaned = if let Some(rest) = path.strip_prefix("\\\\?\\UNC\\") {
            format!("\\\\{rest}")
        } else if let Some(rest) = path.strip_prefix("\\\\?\\") {
            rest.to_string()
        } else {
            path.to_string()
        };
        cleaned.replace('/', "\\")
    }

    #[cfg(not(windows))]
    {
        path.to_string()
    }
}

fn normalize_project_path_input(path: &str) -> String {
    clean_path(path).trim_end_matches(['\\', '/']).to_string()
}

fn normalize_path(path: &str) -> String {
    clean_path(path)
        .replace('/', "\\")
        .to_lowercase()
        .trim_end_matches('\\')
        .to_string()
}

fn encode_project_path(project_path: &str) -> String {
    normalize_project_path_input(project_path)
        .replace(':', "-")
        .replace('\\', "-")
        .replace('/', "-")
}

fn dedupe_project_paths(project_paths: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut deduped = Vec::new();
    for project_path in project_paths {
        let normalized = normalize_project_path_input(project_path);
        if seen.insert(normalized.clone()) {
            deduped.push(normalized);
        }
    }
    deduped
}

fn build_project_path_lookup(project_paths: &[String]) -> HashMap<String, String> {
    let mut lookup = HashMap::new();
    for project_path in project_paths {
        lookup
            .entry(normalize_path(project_path))
            .or_insert_with(|| project_path.clone());
    }
    lookup
}

fn maybe_iso_timestamp(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn extract_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.trim().to_string(),
        Value::Array(items) => items
            .iter()
            .filter_map(|item| {
                item.get("text")
                    .or_else(|| item.get("content"))
                    .map(extract_text)
                    .filter(|text| !text.is_empty())
            })
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string(),
        Value::Object(map) => map
            .get("text")
            .or_else(|| map.get("content"))
            .map(extract_text)
            .unwrap_or_default(),
        _ => String::new(),
    }
}

fn truncate_summary(value: &str) -> String {
    let truncated: String = value.chars().take(MAX_SUMMARY_CHARS).collect();
    if value.chars().count() > MAX_SUMMARY_CHARS {
        format!("{truncated}...")
    } else {
        truncated
    }
}

fn path_basename(path: &str) -> Option<&str> {
    let normalized = path.trim_end_matches(['\\', '/']);
    normalized
        .rsplit(['\\', '/'])
        .find(|segment| !segment.trim().is_empty())
}

fn read_head_tail_lines(
    path: &Path,
    head_limit: usize,
    tail_limit: usize,
) -> Result<(Vec<String>, Vec<String>), String> {
    let file = fs::File::open(path)
        .map_err(|err| format!("failed to open session file {}: {err}", path.display()))?;
    let reader = BufReader::new(file);
    let mut head = Vec::new();
    let mut tail = VecDeque::with_capacity(tail_limit);

    for line in reader.lines().flatten() {
        if head.len() < head_limit {
            head.push(line.clone());
        }
        if tail_limit > 0 {
            if tail.len() == tail_limit {
                tail.pop_front();
            }
            tail.push_back(line);
        }
    }

    Ok((head, tail.into_iter().collect()))
}

fn load_codex_thread_names(codex_dir: &Path) -> HashMap<String, String> {
    let index_path = codex_dir.join("session_index.jsonl");
    let file = match fs::File::open(index_path) {
        Ok(file) => file,
        Err(_) => return HashMap::new(),
    };

    let reader = BufReader::new(file);
    let mut map = HashMap::new();
    for line in reader.lines().flatten() {
        if let Ok(obj) = serde_json::from_str::<Value>(&line) {
            if let (Some(id), Some(name)) = (
                obj.get("id").and_then(Value::as_str),
                obj.get("thread_name").and_then(Value::as_str),
            ) {
                map.insert(id.to_string(), name.to_string());
            }
        }
    }
    map
}

fn remove_path_if_exists(path: &Path) -> std::io::Result<()> {
    match fs::metadata(path) {
        Ok(meta) => {
            if meta.is_dir() {
                fs::remove_dir_all(path)
            } else {
                fs::remove_file(path)
            }
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

fn canonicalize_existing_path(path: &Path, label: &str) -> Result<PathBuf, String> {
    if !path.exists() {
        return Err(format!("{label} not found: {}", path.display()));
    }
    path.canonicalize()
        .map_err(|err| format!("failed to resolve {label} {}: {err}", path.display()))
}

fn provider_root(home: &Path, provider_id: &str) -> Result<PathBuf, String> {
    match provider_id {
        "claude" => Ok(home.join(".claude").join("projects")),
        "codex" => Ok(home.join(".codex").join("sessions")),
        _ => Err(format!(
            "unsupported external session provider: {provider_id}"
        )),
    }
}

fn validate_session_source_path(
    home: &Path,
    provider_id: &str,
    source_path: &Path,
) -> Result<PathBuf, String> {
    let root = provider_root(home, provider_id)?;
    let validated_root = canonicalize_existing_path(&root, "session root")?;
    let validated_source = canonicalize_existing_path(source_path, "session source")?;
    if !validated_source.starts_with(&validated_root) {
        return Err(format!(
            "session source path is outside provider root: {}",
            source_path.display()
        ));
    }
    Ok(validated_source)
}

fn read_claude_session_summary(path: &Path, project_path: &str) -> Option<ExternalSessionSummary> {
    let (head, tail) = read_head_tail_lines(path, 10, 30).ok()?;
    let mut session_id = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(str::to_string)
        .unwrap_or_default();
    let mut title = "Untitled".to_string();
    let mut created_at = String::new();
    let mut summary = None;
    let mut first_user_text = None;

    for line in &head {
        let value: Value = serde_json::from_str(line).ok()?;
        if session_id.is_empty() {
            session_id = value
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
        }
        if created_at.is_empty() {
            created_at = value
                .get("timestamp")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
        }
        if let Some(message) = value.get("message") {
            let content = message.get("content").map(extract_text).unwrap_or_default();
            let role = message
                .get("role")
                .and_then(Value::as_str)
                .or_else(|| value.get("type").and_then(Value::as_str))
                .unwrap_or_default();
            if role == "user" {
                let trimmed = content.trim_start();
                if !trimmed.is_empty() && !trimmed.starts_with('<') {
                    first_user_text = Some(trimmed.to_string());
                    break;
                }
            }
        }
    }

    if let Some(first_user_text) = first_user_text {
        title = first_user_text.chars().take(100).collect();
    }

    let mut last_timestamp = created_at.clone();
    for line in tail.iter().rev() {
        let value: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if last_timestamp.is_empty() {
            if let Some(timestamp) = value.get("timestamp").and_then(Value::as_str) {
                last_timestamp = timestamp.to_string();
            }
        }
        if summary.is_none() && value.get("isMeta").and_then(Value::as_bool) != Some(true) {
            let text = value
                .get("message")
                .and_then(|message| message.get("content"))
                .map(extract_text)
                .unwrap_or_default();
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                summary = Some(truncate_summary(trimmed));
            }
        }
        if !last_timestamp.is_empty() && summary.is_some() {
            break;
        }
    }

    if session_id.is_empty() {
        return None;
    }

    let project_label = path_basename(project_path)
        .map(str::to_string)
        .unwrap_or_else(|| project_path.to_string());
    let title = if title.trim().is_empty() {
        project_label
    } else {
        title
    };

    Some(ExternalSessionSummary {
        provider_id: "claude".to_string(),
        session_id: session_id.clone(),
        title,
        timestamp: if last_timestamp.is_empty() {
            created_at
        } else {
            last_timestamp
        },
        summary,
        project_path: Some(project_path.to_string()),
        source_path: path.to_string_lossy().to_string(),
        resume_command: Some(format!("claude --resume {session_id}")),
    })
}

fn list_claude_sessions(home: &Path, project_paths: &[String]) -> Vec<ExternalSessionSummary> {
    let mut sessions = Vec::new();
    for project_path in project_paths {
        let encoded = encode_project_path(project_path);
        let sessions_dir = home.join(".claude").join("projects").join(encoded);
        let entries = match fs::read_dir(&sessions_dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                continue;
            }
            if let Some(session) = read_claude_session_summary(&path, project_path) {
                sessions.push(session);
            }
        }
    }
    sessions
}

fn list_codex_sessions(home: &Path, project_paths: &[String]) -> Vec<ExternalSessionSummary> {
    let codex_dir = home.join(".codex");
    let sessions_dir = codex_dir.join("sessions");
    if !sessions_dir.exists() {
        return Vec::new();
    }

    let project_paths_by_normalized = build_project_path_lookup(project_paths);
    if project_paths_by_normalized.is_empty() {
        return Vec::new();
    }

    let thread_names = load_codex_thread_names(&codex_dir);
    let mut sessions = Vec::new();
    walk_codex_sessions(
        &sessions_dir,
        &project_paths_by_normalized,
        &thread_names,
        &mut sessions,
    );
    sessions
}

fn walk_codex_sessions(
    dir: &Path,
    project_paths_by_normalized: &HashMap<String, String>,
    thread_names: &HashMap<String, String>,
    sessions: &mut Vec<ExternalSessionSummary>,
) {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_codex_sessions(&path, project_paths_by_normalized, thread_names, sessions);
        } else if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
            if let Some(session) =
                try_read_codex_session_summary(&path, project_paths_by_normalized, thread_names)
            {
                sessions.push(session);
            }
        }
    }
}

fn try_read_codex_session_summary(
    path: &Path,
    project_paths_by_normalized: &HashMap<String, String>,
    thread_names: &HashMap<String, String>,
) -> Option<ExternalSessionSummary> {
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut matched_id = None;
    let mut matched_timestamp = String::new();
    let mut matched_project_path = None;
    let mut lines_iter = reader.lines();

    for line in (&mut lines_iter).take(5) {
        let line = line.ok()?;
        let obj: Value = serde_json::from_str(&line).ok()?;
        if obj.get("type").and_then(Value::as_str) != Some("session_meta") {
            continue;
        }
        let cwd = obj
            .pointer("/payload/cwd")
            .and_then(Value::as_str)
            .unwrap_or_default();
        matched_project_path = project_paths_by_normalized
            .get(&normalize_path(cwd))
            .cloned();
        if matched_project_path.is_none() {
            return None;
        }
        matched_id = obj
            .pointer("/payload/id")
            .and_then(Value::as_str)
            .map(str::to_string);
        matched_timestamp = obj
            .pointer("/payload/timestamp")
            .or_else(|| obj.get("timestamp"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        break;
    }

    let session_id = matched_id?;
    let project_path = matched_project_path?;
    let mut title = thread_names.get(&session_id).cloned().unwrap_or_default();
    let mut summary = None;

    for line in lines_iter.take(60) {
        let line = match line {
            Ok(line) => line,
            Err(_) => continue,
        };
        let obj: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if obj.get("type").and_then(Value::as_str) != Some("response_item") {
            continue;
        }
        let role = obj
            .pointer("/payload/role")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let content = obj
            .pointer("/payload/content")
            .cloned()
            .unwrap_or(Value::Null);
        let extracted = extract_codex_response_content(&content);
        let trimmed = extracted.trim();
        if trimmed.is_empty() || trimmed.starts_with('<') || trimmed.starts_with("# AGENTS.md") {
            continue;
        }
        if role == "user" && title.is_empty() {
            title = trimmed.chars().take(100).collect();
        }
        if summary.is_none() {
            summary = Some(truncate_summary(trimmed));
        }
        if !title.is_empty() && summary.is_some() {
            break;
        }
    }

    if title.is_empty() {
        title = "Untitled".to_string();
    }

    Some(ExternalSessionSummary {
        provider_id: "codex".to_string(),
        session_id: session_id.clone(),
        title,
        timestamp: matched_timestamp,
        summary,
        project_path: Some(project_path),
        source_path: path.to_string_lossy().to_string(),
        resume_command: Some(format!("codex resume {session_id}")),
    })
}

fn extract_codex_response_content(value: &Value) -> String {
    match value {
        Value::Array(items) => items
            .iter()
            .filter_map(|item| {
                item.get("text")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| {
                        item.get("content")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    })
                    .or_else(|| {
                        if item.get("type").and_then(Value::as_str) == Some("input_text") {
                            item.get("text").and_then(Value::as_str).map(str::to_string)
                        } else {
                            None
                        }
                    })
            })
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string(),
        _ => extract_text(value),
    }
}

fn load_claude_messages(path: &Path) -> Result<Vec<ExternalSessionMessage>, String> {
    let file = fs::File::open(path)
        .map_err(|err| format!("failed to open Claude session {}: {err}", path.display()))?;
    let reader = BufReader::new(file);
    let mut messages = Vec::new();

    for line in reader.lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => continue,
        };
        let value: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if value.get("isMeta").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let message = match value.get("message") {
            Some(message) => message,
            None => continue,
        };
        let mut role = message
            .get("role")
            .and_then(Value::as_str)
            .or_else(|| value.get("type").and_then(Value::as_str))
            .unwrap_or("unknown")
            .to_string();
        if role == "user" {
            if let Some(Value::Array(items)) = message.get("content") {
                let all_tool_results = !items.is_empty()
                    && items.iter().all(|item| {
                        item.get("type").and_then(Value::as_str) == Some("tool_result")
                    });
                if all_tool_results {
                    role = "tool".to_string();
                }
            }
        }
        let content = message.get("content").map(extract_text).unwrap_or_default();
        if content.trim().is_empty() {
            continue;
        }
        messages.push(ExternalSessionMessage {
            role,
            content,
            timestamp: value.get("timestamp").and_then(maybe_iso_timestamp),
        });
    }

    Ok(messages)
}

fn load_codex_messages(path: &Path) -> Result<Vec<ExternalSessionMessage>, String> {
    let file = fs::File::open(path)
        .map_err(|err| format!("failed to open Codex session {}: {err}", path.display()))?;
    let reader = BufReader::new(file);
    let mut messages = Vec::new();

    for line in reader.lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => continue,
        };
        let value: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if value.get("type").and_then(Value::as_str) != Some("response_item") {
            continue;
        }
        let role = value
            .pointer("/payload/role")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let content = value
            .pointer("/payload/content")
            .map(extract_codex_response_content)
            .unwrap_or_default();
        if content.trim().is_empty() {
            continue;
        }
        let timestamp = value
            .pointer("/payload/timestamp")
            .or_else(|| value.get("timestamp"))
            .and_then(maybe_iso_timestamp);
        messages.push(ExternalSessionMessage {
            role,
            content,
            timestamp,
        });
    }

    Ok(messages)
}

fn delete_claude_session(path: &Path, session_id: &str) -> Result<bool, String> {
    let summary =
        read_claude_session_summary(path, path.parent().and_then(Path::to_str).unwrap_or(""))
            .ok_or_else(|| {
                format!(
                    "failed to parse Claude session metadata: {}",
                    path.display()
                )
            })?;
    if summary.session_id != session_id {
        return Err(format!(
            "Claude session ID mismatch: expected {session_id}, found {}",
            summary.session_id
        ));
    }

    if let Some(stem) = path.file_stem() {
        let sibling = path.parent().unwrap_or_else(|| Path::new("")).join(stem);
        remove_path_if_exists(&sibling).map_err(|err| {
            format!(
                "failed to delete Claude session sidecar {}: {err}",
                sibling.display()
            )
        })?;
    }

    fs::remove_file(path).map_err(|err| {
        format!(
            "failed to delete Claude session file {}: {err}",
            path.display()
        )
    })?;
    Ok(true)
}

fn delete_codex_session(path: &Path, session_id: &str) -> Result<bool, String> {
    let file = fs::File::open(path)
        .map_err(|err| format!("failed to open Codex session {}: {err}", path.display()))?;
    let reader = BufReader::new(file);
    let mut found_id = None;
    for line in reader.lines().flatten().take(5) {
        let value: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if value.get("type").and_then(Value::as_str) != Some("session_meta") {
            continue;
        }
        found_id = value
            .pointer("/payload/id")
            .and_then(Value::as_str)
            .map(str::to_string);
        break;
    }

    let found_id = found_id.or_else(|| {
        path.file_stem()
            .and_then(|stem| stem.to_str())
            .map(str::to_string)
    });
    let found_id = found_id.ok_or_else(|| {
        format!(
            "failed to determine Codex session ID for {}",
            path.display()
        )
    })?;
    if found_id != session_id {
        return Err(format!(
            "Codex session ID mismatch: expected {session_id}, found {found_id}"
        ));
    }
    fs::remove_file(path).map_err(|err| {
        format!(
            "failed to delete Codex session file {}: {err}",
            path.display()
        )
    })?;
    Ok(true)
}

pub fn collect_external_sessions(
    home: &Path,
    project_paths: &[String],
) -> Vec<ExternalSessionSummary> {
    let project_paths = dedupe_project_paths(project_paths);
    let mut sessions = Vec::new();
    sessions.extend(list_claude_sessions(home, &project_paths));
    sessions.extend(list_codex_sessions(home, &project_paths));
    sessions.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    sessions
}

#[tauri::command]
pub fn list_external_sessions(
    project_paths: Vec<String>,
) -> Result<Vec<ExternalSessionSummary>, String> {
    if project_paths.is_empty() {
        return Ok(Vec::new());
    }
    let home = match home_dir() {
        Some(home) => home,
        None => return Ok(Vec::new()),
    };
    Ok(collect_external_sessions(&home, &project_paths))
}

#[tauri::command]
pub fn get_external_session_messages(
    provider_id: String,
    source_path: String,
) -> Result<Vec<ExternalSessionMessage>, String> {
    let home = home_dir().ok_or_else(|| "unable to resolve home directory".to_string())?;
    let validated = validate_session_source_path(&home, &provider_id, Path::new(&source_path))?;
    match provider_id.as_str() {
        "claude" => load_claude_messages(&validated),
        "codex" => load_codex_messages(&validated),
        _ => Err(format!(
            "unsupported external session provider: {provider_id}"
        )),
    }
}

#[tauri::command]
pub fn delete_external_session(
    provider_id: String,
    session_id: String,
    source_path: String,
) -> Result<ExternalSessionDeleteOutcome, String> {
    let home = home_dir().ok_or_else(|| "unable to resolve home directory".to_string())?;
    let validated = validate_session_source_path(&home, &provider_id, Path::new(&source_path))?;
    let deleted = match provider_id.as_str() {
        "claude" => delete_claude_session(&validated, &session_id)?,
        "codex" => delete_codex_session(&validated, &session_id)?,
        _ => {
            return Err(format!(
                "unsupported external session provider: {provider_id}"
            ))
        }
    };

    Ok(ExternalSessionDeleteOutcome {
        provider_id,
        session_id,
        source_path: validated.to_string_lossy().to_string(),
        deleted,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::fs::File;
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new(prefix: &str) -> Self {
            let unique = format!(
                "{}-{}-{}",
                prefix,
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .expect("system time should be after epoch")
                    .as_nanos()
            );
            let path = env::temp_dir().join(unique);
            fs::create_dir_all(&path).expect("failed to create temp dir");
            Self { path }
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn write_lines(path: &Path, lines: &[String]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("failed to create parent dir");
        }
        let mut file = File::create(path).expect("failed to create file");
        for line in lines {
            writeln!(file, "{line}").expect("failed to write line");
        }
    }

    #[test]
    fn collect_external_sessions_reads_codex_and_claude_for_matching_projects() {
        let home = TestDir::new("mini-term-external-sessions");
        let project_path = home.path.join("workspace").to_string_lossy().to_string();

        let claude_session_path = home
            .path
            .join(".claude")
            .join("projects")
            .join(encode_project_path(&project_path))
            .join("claude-1.jsonl");
        write_lines(
            &claude_session_path,
            &[
                r#"{"type":"user","timestamp":"2026-04-01T09:30:00Z","message":{"role":"user","content":"Claude first prompt"}}"#.to_string(),
                r#"{"timestamp":"2026-04-01T09:31:00Z","message":{"role":"assistant","content":"Claude summary line"}}"#.to_string(),
            ],
        );

        let codex_index_path = home.path.join(".codex").join("session_index.jsonl");
        write_lines(
            &codex_index_path,
            &[r#"{"id":"codex-1","thread_name":"Codex Thread"}"#.to_string()],
        );

        let project_path_json =
            serde_json::to_string(&project_path).expect("failed to serialize project path");
        let codex_session_path = home
            .path
            .join(".codex")
            .join("sessions")
            .join("2026")
            .join("04")
            .join("04")
            .join("codex-1.jsonl");
        write_lines(
            &codex_session_path,
            &[
                format!(
                    r#"{{"type":"session_meta","payload":{{"cwd":{project_path_json},"id":"codex-1","timestamp":"2026-04-04T12:00:00Z"}}}}"#
                ),
                r#"{"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"Inspect changes"}]}}"#.to_string(),
            ],
        );

        let sessions = collect_external_sessions(&home.path, &[project_path.clone()]);
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].provider_id, "codex");
        assert_eq!(sessions[0].title, "Codex Thread");
        assert_eq!(sessions[1].provider_id, "claude");
        assert_eq!(sessions[1].title, "Claude first prompt");
        assert_eq!(sessions[1].summary.as_deref(), Some("Claude summary line"));
    }

    #[test]
    fn loads_claude_messages_and_reclassifies_tool_results() {
        let home = TestDir::new("mini-term-external-session-messages");
        let source = home
            .path
            .join(".claude")
            .join("projects")
            .join("workspace")
            .join("s1.jsonl");
        write_lines(
            &source,
            &[
                r#"{"timestamp":"2026-04-01T09:30:00Z","message":{"role":"user","content":"Plan work"}}"#.to_string(),
                r#"{"timestamp":"2026-04-01T09:31:00Z","message":{"role":"user","content":[{"type":"tool_result","text":"ok"}]}}"#.to_string(),
                r#"{"timestamp":"2026-04-01T09:32:00Z","message":{"role":"assistant","content":"Done"}}"#.to_string(),
            ],
        );

        let messages = load_claude_messages(&source).expect("messages should load");
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[1].role, "tool");
        assert_eq!(messages[2].content, "Done");
    }

    #[test]
    fn rejects_delete_when_source_is_outside_provider_root() {
        let home = TestDir::new("mini-term-external-delete-guard");
        fs::create_dir_all(home.path.join(".claude").join("projects")).unwrap();
        let outside = home.path.join("outside.jsonl");
        write_lines(
            &outside,
            &[r#"{"message":{"content":"hello"}}"#.to_string()],
        );
        let error = validate_session_source_path(&home.path, "claude", &outside).unwrap_err();
        assert!(error.contains("outside provider root"));
    }

    #[test]
    fn delete_codex_session_removes_session_file() {
        let home = TestDir::new("mini-term-external-delete-codex");
        let project_path = home.path.join("workspace").to_string_lossy().to_string();
        let project_path_json =
            serde_json::to_string(&project_path).expect("failed to serialize project path");
        let session_path = home
            .path
            .join(".codex")
            .join("sessions")
            .join("2026")
            .join("04")
            .join("05")
            .join("codex-7.jsonl");
        write_lines(
            &session_path,
            &[format!(
                r#"{{"type":"session_meta","payload":{{"cwd":{project_path_json},"id":"codex-7","timestamp":"2026-04-05T12:00:00Z"}}}}"#
            )],
        );
        let deleted =
            delete_codex_session(&session_path, "codex-7").expect("delete should succeed");
        assert!(deleted);
        assert!(!session_path.exists());
    }
}
