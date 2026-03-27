use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AISession {
    pub id: String,
    pub session_type: String,
    pub project_path: String,
    pub start_time: String,
    pub message_count: usize,
}

trait AISessionReader {
    fn list_sessions(&self, project_path: &Path) -> Vec<AISession>;
}

struct ClaudeSessionReader;

impl ClaudeSessionReader {
    fn claude_projects_dir() -> Option<PathBuf> {
        let home = dirs::home_dir()?;
        let claude_dir = home.join(".claude").join("projects");
        if claude_dir.is_dir() { Some(claude_dir) } else { None }
    }

    fn find_project_dir(projects_dir: &Path, project_path: &Path) -> Option<PathBuf> {
        let project_str = project_path.to_string_lossy().to_string();

        // 将项目路径编码为 Claude 的目录名格式
        let encoded = project_str
            .replace(":", "")
            .replace("\\", "-")
            .replace("/", "-");

        // 直接匹配编码后的目录名
        let direct = projects_dir.join(&encoded);
        if direct.is_dir() {
            return Some(direct);
        }

        // 模糊匹配：遍历所有项目目录，检查是否包含编码后的路径
        if let Ok(entries) = fs::read_dir(projects_dir) {
            for entry in entries.flatten() {
                if !entry.file_type().ok().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                let dir_name = entry.file_name().to_string_lossy().to_string();
                // 检查目录名是否以编码后的路径结尾（Claude 可能加了前缀）
                if dir_name == encoded || dir_name.ends_with(&encoded) {
                    return Some(entry.path());
                }
            }
        }

        None
    }
}

impl AISessionReader for ClaudeSessionReader {
    fn list_sessions(&self, project_path: &Path) -> Vec<AISession> {
        let projects_dir = match Self::claude_projects_dir() {
            Some(d) => d,
            None => return vec![],
        };
        let project_dir = match Self::find_project_dir(&projects_dir, project_path) {
            Some(d) => d,
            None => return vec![],
        };
        let mut sessions = vec![];
        if let Ok(entries) = fs::read_dir(&project_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().map(|e| e == "jsonl").unwrap_or(false) {
                    let id = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
                    let message_count = fs::File::open(&path)
                        .map(|f| std::io::BufRead::lines(std::io::BufReader::new(f)).count())
                        .unwrap_or(0);
                    let start_time = entry.metadata().ok()
                        .and_then(|m| m.modified().ok())
                        .map(|t| {
                            let duration = t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
                            format!("{}", duration.as_secs())
                        })
                        .unwrap_or_default();
                    sessions.push(AISession {
                        id, session_type: "claude".to_string(),
                        project_path: project_path.to_string_lossy().to_string(),
                        start_time, message_count,
                    });
                }
            }
        }
        sessions.sort_by(|a, b| b.start_time.cmp(&a.start_time));
        sessions
    }
}

#[tauri::command]
pub fn get_ai_sessions(project_path: String) -> Vec<AISession> {
    let path = Path::new(&project_path);
    let claude_reader = ClaudeSessionReader;
    claude_reader.list_sessions(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_sessions_when_no_claude_dir() {
        let reader = ClaudeSessionReader;
        let sessions = reader.list_sessions(Path::new("C:\\nonexistent\\project"));
        assert!(sessions.is_empty());
    }
}
