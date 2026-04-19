use crate::agent_ext::session_import::{collect_external_sessions, ExternalSessionSummary};
use serde::{Deserialize, Serialize};
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

fn map_external_session(summary: ExternalSessionSummary) -> AiSession {
    AiSession {
        id: summary.session_id,
        session_type: summary.provider_id,
        title: summary.title,
        timestamp: summary.timestamp,
        project_path: summary.project_path,
    }
}

fn collect_ai_sessions(home: &Path, project_paths: &[String]) -> Vec<AiSession> {
    collect_external_sessions(home, project_paths)
        .into_iter()
        .map(map_external_session)
        .collect()
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
    use std::fs;
    use std::fs::File;
    use std::io::Write;
    use std::path::{Path, PathBuf};
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

    fn encode_project_path(project_path: &str) -> String {
        project_path
            .trim_end_matches(['\\', '/'])
            .replace([':', '\\', '/'], "-")
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
    fn collect_ai_sessions_maps_external_sessions_to_legacy_shape() {
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

        let sessions = collect_ai_sessions(&home.path, std::slice::from_ref(&project_path));

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
            &[r#"{"type":"user","timestamp":"2026-04-01T09:30:00Z","message":{"role":"user","content":"Claude first prompt"}}"#.to_string()],
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
}
