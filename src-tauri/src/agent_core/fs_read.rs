use super::models::{ReadFileResult, SearchFileMatch};
use crate::fs::read_file_content;
use std::fs;
use std::path::{Path, PathBuf};

const SEARCH_SKIP_DIRS: &[&str] = &[
    ".git",
    ".claude",
    ".codex",
    ".cursor",
    "node_modules",
    "target",
    ".next",
    "dist",
    "__pycache__",
    ".superpowers",
];

pub fn read_file(path: String) -> Result<ReadFileResult, String> {
    Ok(ReadFileResult {
        path: path.clone(),
        file: read_file_content(path)?,
    })
}

fn walk(dir: &Path, files: &mut Vec<PathBuf>) {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if SEARCH_SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            walk(&path, files);
        } else if path.is_file() {
            files.push(path);
        }
    }
}

pub fn search_files(root: &str, query: &str, limit: usize) -> Vec<SearchFileMatch> {
    if query.trim().is_empty() {
        return Vec::new();
    }

    let mut files = Vec::new();
    walk(Path::new(root), &mut files);

    let normalized_query = query.to_lowercase();
    let mut matches = Vec::new();
    for path in files {
        if matches.len() >= limit {
            break;
        }

        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        for (index, line) in content.lines().enumerate() {
            if !line.to_lowercase().contains(&normalized_query) {
                continue;
            }
            matches.push(SearchFileMatch {
                path: path.to_string_lossy().to_string(),
                line: index + 1,
                line_text: line.trim().to_string(),
            });
            if matches.len() >= limit {
                break;
            }
        }
    }

    matches
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("mini-term-fs-read-{label}-{unique}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn search_files_skips_agent_runtime_directories() {
        let root = unique_temp_dir("skip-agent-dirs");
        let visible = root.join("src").join("notes.txt");
        let hidden = root.join(".codex").join("cache.txt");
        fs::create_dir_all(visible.parent().unwrap()).unwrap();
        fs::create_dir_all(hidden.parent().unwrap()).unwrap();
        fs::write(&visible, "needle in source").unwrap();
        fs::write(&hidden, "needle in runtime cache").unwrap();

        let matches = search_files(&root.to_string_lossy(), "needle", 10);

        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].path, visible.to_string_lossy());

        let _ = fs::remove_dir_all(root);
    }
}
