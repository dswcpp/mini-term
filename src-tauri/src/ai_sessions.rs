use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSession {
    pub id: String,
    pub session_type: String, // "claude" | "codex"
    pub title: String,
    pub timestamp: String, // ISO 8601
    pub project_path: Option<String>,
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

fn encode_project_path(project_path: &str) -> String {
    normalize_project_path_input(project_path)
        .replace(':', "-")
        .replace('\\', "-")
        .replace('/', "-")
}

fn normalize_path(path: &str) -> String {
    clean_path(path)
        .replace('/', "\\")
        .to_lowercase()
        .trim_end_matches('\\')
        .to_string()
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

fn read_claude_session_info(path: &Path) -> (String, String) {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return ("Untitled".into(), String::new()),
    };

    let reader = BufReader::new(file);

    for line in reader.lines().take(50) {
        let line = match line {
            Ok(line) => line,
            Err(_) => continue,
        };

        let obj: serde_json::Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };

        if obj.get("type").and_then(|value| value.as_str()) != Some("user") {
            continue;
        }

        let content_val = obj.pointer("/message/content");
        let content = if let Some(text) = content_val.and_then(|value| value.as_str()) {
            text.to_string()
        } else if let Some(items) = content_val.and_then(|value| value.as_array()) {
            items
                .iter()
                .find_map(|item| {
                    if item.get("type").and_then(|value| value.as_str()) == Some("text") {
                        item.get("text")
                            .and_then(|value| value.as_str())
                            .map(String::from)
                    } else {
                        None
                    }
                })
                .unwrap_or_else(|| "Untitled".into())
        } else {
            "Untitled".into()
        };

        let trimmed = content.trim_start();
        if trimmed.starts_with('<') {
            continue;
        }

        let title: String = content.chars().take(100).collect();
        let timestamp = obj
            .get("timestamp")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();

        return (title, timestamp);
    }

    ("Untitled".into(), String::new())
}

fn get_claude_sessions(home: &Path, project_path: &str) -> Vec<AiSession> {
    let encoded = encode_project_path(project_path);
    let sessions_dir = home.join(".claude").join("projects").join(encoded);

    if !sessions_dir.exists() {
        return vec![];
    }

    let entries = match fs::read_dir(&sessions_dir) {
        Ok(entries) => entries,
        Err(_) => return vec![],
    };

    let mut sessions = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
            continue;
        }

        let id = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_string();
        let (title, timestamp) = read_claude_session_info(&path);

        sessions.push(AiSession {
            id,
            session_type: "claude".to_string(),
            title,
            timestamp,
            project_path: Some(project_path.to_string()),
        });
    }

    sessions
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
        if let Ok(obj) = serde_json::from_str::<serde_json::Value>(&line) {
            if let (Some(id), Some(name)) = (
                obj.get("id").and_then(|value| value.as_str()),
                obj.get("thread_name").and_then(|value| value.as_str()),
            ) {
                map.insert(id.to_string(), name.to_string());
            }
        }
    }

    map
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

fn try_read_codex_session(
    path: &Path,
    project_paths_by_normalized: &HashMap<String, String>,
    thread_names: &HashMap<String, String>,
) -> Option<AiSession> {
    let file = fs::File::open(path).ok()?;
    let reader = BufReader::new(file);

    let mut matched_id = None;
    let mut matched_timestamp = String::new();
    let mut matched_project_path = None;
    let mut lines_iter = reader.lines();

    for line in (&mut lines_iter).take(5) {
        let line = line.ok()?;
        let obj: serde_json::Value = serde_json::from_str(&line).ok()?;

        if obj.get("type").and_then(|value| value.as_str()) != Some("session_meta") {
            continue;
        }

        let cwd = obj
            .pointer("/payload/cwd")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        matched_project_path = project_paths_by_normalized
            .get(&normalize_path(cwd))
            .cloned();

        if matched_project_path.is_none() {
            return None;
        }

        matched_id = Some(
            obj.pointer("/payload/id")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string(),
        );
        matched_timestamp = obj
            .pointer("/payload/timestamp")
            .or_else(|| obj.get("timestamp"))
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();

        break;
    }

    let id = matched_id?;
    let project_path = matched_project_path?;
    let mut title = thread_names.get(&id).cloned().unwrap_or_default();

    if title.is_empty() {
        for line in lines_iter.take(30) {
            let line = match line {
                Ok(line) => line,
                Err(_) => continue,
            };
            let obj: serde_json::Value = match serde_json::from_str(&line) {
                Ok(value) => value,
                Err(_) => continue,
            };

            if obj.get("type").and_then(|value| value.as_str()) != Some("response_item") {
                continue;
            }
            if obj
                .pointer("/payload/role")
                .and_then(|value| value.as_str())
                != Some("user")
            {
                continue;
            }

            if let Some(items) = obj
                .pointer("/payload/content")
                .and_then(|value| value.as_array())
            {
                for item in items {
                    if item.get("type").and_then(|value| value.as_str()) != Some("input_text") {
                        continue;
                    }

                    let text = item
                        .get("text")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    let trimmed = text.trim_start();
                    if !trimmed.is_empty()
                        && !trimmed.starts_with('<')
                        && !trimmed.starts_with("# AGENTS.md")
                    {
                        title = trimmed.chars().take(100).collect();
                        break;
                    }
                }
            }

            if !title.is_empty() {
                break;
            }
        }

        if title.is_empty() {
            title = "Untitled".into();
        }
    }

    Some(AiSession {
        id,
        session_type: "codex".to_string(),
        title,
        timestamp: matched_timestamp,
        project_path: Some(project_path),
    })
}

fn walk_codex_sessions(
    dir: &Path,
    project_paths_by_normalized: &HashMap<String, String>,
    thread_names: &HashMap<String, String>,
    sessions: &mut Vec<AiSession>,
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
                try_read_codex_session(&path, project_paths_by_normalized, thread_names)
            {
                sessions.push(session);
            }
        }
    }
}

fn get_codex_sessions(home: &Path, project_paths: &[String]) -> Vec<AiSession> {
    let codex_dir = home.join(".codex");
    let sessions_dir = codex_dir.join("sessions");
    if !sessions_dir.exists() {
        return vec![];
    }

    let project_paths_by_normalized = build_project_path_lookup(project_paths);
    if project_paths_by_normalized.is_empty() {
        return vec![];
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

fn collect_ai_sessions(home: &Path, project_paths: &[String]) -> Vec<AiSession> {
    let project_paths = dedupe_project_paths(project_paths);
    let mut sessions = Vec::new();

    for project_path in &project_paths {
        sessions.extend(get_claude_sessions(home, project_path));
    }
    sessions.extend(get_codex_sessions(home, &project_paths));
    sessions.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));

    sessions
}

#[tauri::command]
pub fn get_ai_sessions(project_paths: Vec<String>) -> Result<Vec<AiSession>, String> {
    if project_paths.is_empty() {
        return Ok(vec![]);
    }

    let home = match home_dir() {
        Some(home) => home,
        None => return Ok(vec![]),
    };

    Ok(collect_ai_sessions(&home, &project_paths))
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
    fn collect_ai_sessions_reads_codex_and_claude_for_matching_projects() {
        let home = TestDir::new("mini-term-ai-sessions");
        let project_path = home.path.join("workspace").to_string_lossy().to_string();

        let claude_session_path = home
            .path
            .join(".claude")
            .join("projects")
            .join(encode_project_path(&project_path))
            .join("claude-1.jsonl");
        write_lines(
            &claude_session_path,
            &[r#"{"type":"user","timestamp":"2026-04-01T09:30:00Z","message":{"content":"Claude first prompt"}}"#.to_string()],
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
            &[format!(
                r#"{{"type":"session_meta","payload":{{"cwd":{project_path_json},"id":"codex-1","timestamp":"2026-04-04T12:00:00Z"}}}}"#
            )],
        );

        let sessions = collect_ai_sessions(&home.path, &[project_path.clone()]);

        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].session_type, "codex");
        assert_eq!(sessions[0].title, "Codex Thread");
        assert_eq!(
            sessions[0].project_path.as_deref(),
            Some(project_path.as_str())
        );
        assert_eq!(sessions[1].session_type, "claude");
        assert_eq!(sessions[1].title, "Claude first prompt");
        assert_eq!(
            sessions[1].project_path.as_deref(),
            Some(project_path.as_str())
        );
    }

    #[test]
    fn get_ai_sessions_supports_mini_term_home_dir_override() {
        let home = TestDir::new("mini-term-ai-sessions-home-override");
        let project_path = home.path.join("workspace").to_string_lossy().to_string();

        let claude_session_path = home
            .path
            .join(".claude")
            .join("projects")
            .join(encode_project_path(&project_path))
            .join("claude-1.jsonl");
        write_lines(
            &claude_session_path,
            &[r#"{"type":"user","timestamp":"2026-04-01T09:30:00Z","message":{"content":"Claude first prompt"}}"#.to_string()],
        );

        std::env::set_var("MINI_TERM_HOME_DIR", &home.path);
        let sessions = get_ai_sessions(vec![project_path.clone()]).expect("sessions should load");
        std::env::remove_var("MINI_TERM_HOME_DIR");

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_type, "claude");
        assert_eq!(sessions[0].title, "Claude first prompt");
        assert_eq!(
            sessions[0].project_path.as_deref(),
            Some(project_path.as_str())
        );
    }

    #[cfg(windows)]
    #[test]
    fn collect_ai_sessions_matches_windows_verbatim_project_paths() {
        let home = TestDir::new("mini-term-ai-sessions-verbatim");
        let project_path = home.path.join("workspace").to_string_lossy().to_string();

        let claude_session_path = home
            .path
            .join(".claude")
            .join("projects")
            .join(encode_project_path(&project_path))
            .join("claude-1.jsonl");
        write_lines(
            &claude_session_path,
            &[r#"{"type":"user","timestamp":"2026-04-01T09:30:00Z","message":{"content":"Claude first prompt"}}"#.to_string()],
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
            &[format!(
                r#"{{"type":"session_meta","payload":{{"cwd":{project_path_json},"id":"codex-1","timestamp":"2026-04-04T12:00:00Z"}}}}"#
            )],
        );

        let sessions = collect_ai_sessions(&home.path, &[format!("\\\\?\\{project_path}")]);

        assert_eq!(sessions.len(), 2);
        assert_eq!(
            sessions[0].project_path.as_deref(),
            Some(project_path.as_str())
        );
        assert_eq!(
            sessions[1].project_path.as_deref(),
            Some(project_path.as_str())
        );
    }

    #[cfg(windows)]
    #[test]
    fn collect_ai_sessions_normalizes_windows_separator_style() {
        let home = TestDir::new("mini-term-ai-sessions-separators");
        let project_path = home
            .path
            .join("workspace")
            .to_string_lossy()
            .replace('\\', "/");

        let claude_session_path = home
            .path
            .join(".claude")
            .join("projects")
            .join(encode_project_path(&project_path))
            .join("claude-1.jsonl");
        write_lines(
            &claude_session_path,
            &[r#"{"type":"user","timestamp":"2026-04-01T09:30:00Z","message":{"content":"Claude first prompt"}}"#.to_string()],
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
            &[format!(
                r#"{{"type":"session_meta","payload":{{"cwd":{project_path_json},"id":"codex-1","timestamp":"2026-04-04T12:00:00Z"}}}}"#
            )],
        );

        let sessions = collect_ai_sessions(&home.path, &[project_path]);

        assert_eq!(sessions.len(), 2);
        assert_eq!(
            sessions[0].project_path.as_deref(),
            Some(home.path.join("workspace").to_string_lossy().as_ref())
        );
        assert_eq!(
            sessions[1].project_path.as_deref(),
            Some(home.path.join("workspace").to_string_lossy().as_ref())
        );
    }
}
