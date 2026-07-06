use crate::vcs::{
    build_hunks, full_replace_diff, hide_console_window, status_label, ChangeFileStatus,
    GitDiffResult, GitFileStatus, GitStatus, MAX_REPO_DISCOVER_DEPTH, SKIP_DISCOVERY_DIRS,
};
use pathdiff::diff_paths;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

pub(crate) fn run_svn_command(repo_path: &Path, args: &[&str]) -> Result<String, String> {
    if !repo_path.is_dir() {
        return Err(format!("不是有效目录:{}", repo_path.display()));
    }

    let mut cmd = std::process::Command::new("svn");
    cmd.args(args)
        .current_dir(repo_path)
        .stdin(std::process::Stdio::null());
    hide_console_window(&mut cmd);
    let output = cmd.output().map_err(|e| format!("启动 svn 失败:{}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        } else {
            stderr
        })
    }
}

pub(crate) fn svn_working_copy_root(path: &Path) -> Option<PathBuf> {
    let mut cmd = std::process::Command::new("svn");
    cmd.args(["info", "--show-item", "wc-root"])
        .arg(path)
        .stdin(std::process::Stdio::null());
    hide_console_window(&mut cmd);
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if root.is_empty() {
        None
    } else {
        Some(PathBuf::from(root))
    }
}

fn canonical_or_original(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn push_unique_svn_root(
    roots: &mut Vec<PathBuf>,
    seen: &mut HashSet<PathBuf>,
    root: PathBuf,
) -> bool {
    let key = canonical_or_original(&root);
    if !seen.insert(key) {
        return false;
    }
    roots.push(root);
    true
}

pub(crate) fn discover_svn_repo_paths(project_path: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let mut seen = HashSet::new();

    if let Some(root) = svn_working_copy_root(project_path) {
        push_unique_svn_root(&mut roots, &mut seen, root);
    }

    fn scan(dir: &Path, depth: u32, roots: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>) {
        if depth > MAX_REPO_DISCOVER_DEPTH {
            return;
        }

        let dir_entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };

        for entry in dir_entries.flatten() {
            let sub = entry.path();
            if !sub.is_dir() {
                continue;
            }

            let dir_name = entry.file_name();
            let dir_name_str = dir_name.to_string_lossy();
            if SKIP_DISCOVERY_DIRS.contains(&dir_name_str.as_ref()) {
                continue;
            }

            if sub.join(".svn").is_dir() {
                if let Some(root) = svn_working_copy_root(&sub) {
                    push_unique_svn_root(roots, seen, root);
                }
            }

            scan(&sub, depth + 1, roots, seen);
        }
    }

    scan(project_path, 1, &mut roots, &mut seen);
    roots
}

fn svn_status_from_char(ch: char) -> Option<GitStatus> {
    match ch {
        'M' | '~' => Some(GitStatus::Modified),
        'A' => Some(GitStatus::Added),
        'D' | '!' => Some(GitStatus::Deleted),
        'R' => Some(GitStatus::Renamed),
        '?' => Some(GitStatus::Untracked),
        'C' => Some(GitStatus::Conflicted),
        _ => None,
    }
}

fn parse_svn_status_line(line: &str) -> Option<(String, GitStatus)> {
    let mut chars = line.chars();
    let text_status = chars.next()?;
    let prop_status = chars.next().unwrap_or(' ');
    let status_char = if text_status == ' ' && prop_status == 'M' {
        'M'
    } else {
        text_status
    };
    let status = svn_status_from_char(status_char)?;
    let path = line.get(7..).or_else(|| line.get(1..))?.trim();
    if path.is_empty() || path.starts_with("moved ") {
        return None;
    }
    Some((path.replace('\\', "/"), status))
}

fn parse_svn_status(output: &str) -> Vec<(String, GitStatus)> {
    output.lines().filter_map(parse_svn_status_line).collect()
}

fn parse_svn_raw_status_line(line: &str) -> Option<(String, char)> {
    let status_char = line.chars().next()?;
    if !matches!(status_char, '?' | '!') {
        return None;
    }
    let path = line.get(7..).or_else(|| line.get(1..))?.trim();
    if path.is_empty() {
        return None;
    }
    Some((path.replace('\\', "/"), status_char))
}

fn parse_svn_raw_status(output: &str) -> Vec<(String, char)> {
    output
        .lines()
        .filter_map(parse_svn_raw_status_line)
        .collect()
}

pub(crate) fn collect_svn_status(
    repo_root: &Path,
    display_base: Option<&Path>,
) -> Result<Vec<GitFileStatus>, String> {
    let output = run_svn_command(repo_root, &["status"])?;
    let mut result = Vec::new();

    for (path, status) in parse_svn_status(&output) {
        let display_path = if let Some(base) = display_base {
            let abs = repo_root.join(path.replace('/', std::path::MAIN_SEPARATOR_STR));
            match diff_paths(&abs, base) {
                Some(p) => {
                    let normalized = p.to_string_lossy().replace('\\', "/");
                    if normalized.starts_with("../") || normalized == ".." {
                        continue;
                    }
                    normalized
                }
                None => continue,
            }
        } else {
            path
        };

        result.push(GitFileStatus {
            path: display_path,
            old_path: None,
            status_label: status_label(&status).to_string(),
            status,
        });
    }

    Ok(result)
}

pub(crate) fn get_svn_changes_status(repo_path: &str) -> Result<Vec<ChangeFileStatus>, String> {
    let repo_root = Path::new(repo_path);
    let files = collect_svn_status(repo_root, None)?;
    Ok(files
        .into_iter()
        .map(|file| ChangeFileStatus {
            path: file.path,
            old_path: None,
            staged_status: None,
            unstaged_status: Some(file.status),
            status_label: file.status_label,
        })
        .collect())
}

pub(crate) fn svn_stage_file(repo: &Path, file: &str) -> Result<(), String> {
    let abs = repo.join(file.replace('/', std::path::MAIN_SEPARATOR_STR));
    if abs.exists() {
        run_svn_command(repo, &["add", "--parents", file])?;
    } else {
        run_svn_command(repo, &["delete", "--force", file])?;
    }
    Ok(())
}

pub(crate) fn svn_stage_all(repo_path: &str, include_untracked: bool) -> Result<(), String> {
    let repo = Path::new(repo_path);
    let output = run_svn_command(repo, &["status"])?;
    for (path, status) in parse_svn_raw_status(&output) {
        match status {
            '?' if include_untracked => {
                run_svn_command(repo, &["add", "--parents", &path])?;
            }
            '!' => {
                run_svn_command(repo, &["delete", "--force", &path])?;
            }
            _ => {}
        }
    }
    Ok(())
}

fn read_text_file_for_diff(path: &Path) -> Result<(String, bool, bool), String> {
    if !path.exists() {
        return Ok((String::new(), false, false));
    }

    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() > 1_048_576 {
        return Ok((String::new(), false, true));
    }
    match std::str::from_utf8(&bytes) {
        Ok(s) => Ok((s.to_string(), false, false)),
        Err(_) => Ok((String::new(), true, false)),
    }
}

fn get_svn_base_content(repo_root: &Path, rel_path: &str) -> Result<(String, bool), String> {
    let mut cmd = std::process::Command::new("svn");
    cmd.args(["cat", rel_path])
        .current_dir(repo_root)
        .stdin(std::process::Stdio::null());
    hide_console_window(&mut cmd);
    let output = cmd
        .output()
        .map_err(|e| format!("启动 svn cat 失败:{}", e))?;

    if !output.status.success() {
        return Ok((String::new(), false));
    }
    if output.stdout.len() > 1_048_576 {
        return Ok((String::new(), false));
    }
    match std::str::from_utf8(&output.stdout) {
        Ok(s) => Ok((s.to_string(), false)),
        Err(_) => Ok((String::new(), true)),
    }
}

pub(crate) fn get_svn_diff(
    project_path: String,
    file_path: String,
) -> Result<GitDiffResult, String> {
    let project = Path::new(&project_path);
    let repo_root = svn_working_copy_root(project)
        .ok_or_else(|| format!("不是 SVN 工作副本:{}", project.display()))?;
    let abs_file = project.join(&file_path);
    let rel_path = diff_paths(&abs_file, &repo_root)
        .ok_or("file is outside SVN working copy")?
        .to_string_lossy()
        .replace('\\', "/");

    let (old_content, old_binary) = get_svn_base_content(&repo_root, &rel_path)?;
    if old_binary {
        return Ok(GitDiffResult {
            old_content: String::new(),
            new_content: String::new(),
            hunks: Vec::new(),
            is_binary: true,
            too_large: false,
        });
    }

    let (new_content, new_binary, too_large) = read_text_file_for_diff(&abs_file)?;
    if new_binary || too_large {
        return Ok(GitDiffResult {
            old_content: String::new(),
            new_content: String::new(),
            hunks: Vec::new(),
            is_binary: new_binary,
            too_large,
        });
    }

    let old_lines: Vec<&str> = old_content.lines().collect();
    let new_lines: Vec<&str> = new_content.lines().collect();
    let ol = old_lines.len() as u64;
    let nl = new_lines.len() as u64;
    let hunks = if ol * nl > 10_000_000 {
        full_replace_diff(&old_content, &new_content)
    } else {
        build_hunks(&old_lines, &new_lines)
    };

    Ok(GitDiffResult {
        old_content,
        new_content,
        hunks,
        is_binary: false,
        too_large: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_unique_svn_root_deduplicates_canonical_paths() {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("mini-term-svn-dedupe-{ts}"));
        std::fs::create_dir_all(&root).unwrap();
        let nested = root.join(".").join("child").join("..");

        let mut roots = Vec::new();
        let mut seen = HashSet::new();

        assert!(push_unique_svn_root(&mut roots, &mut seen, root.clone()));
        assert!(!push_unique_svn_root(&mut roots, &mut seen, nested));
        assert_eq!(roots, vec![root.clone()]);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn parse_svn_status_maps_common_states() {
        let output = "\
M       src/main.ts
 M      props-only.txt
A       src/new.ts
D       src/old.ts
?       scratch.txt
C       conflicted.txt
!       missing.txt
";

        let parsed = parse_svn_status(output);

        assert_eq!(parsed.len(), 7);
        assert_eq!(parsed[0], ("src/main.ts".to_string(), GitStatus::Modified));
        assert_eq!(
            parsed[1],
            ("props-only.txt".to_string(), GitStatus::Modified)
        );
        assert_eq!(parsed[2], ("src/new.ts".to_string(), GitStatus::Added));
        assert_eq!(parsed[3], ("src/old.ts".to_string(), GitStatus::Deleted));
        assert_eq!(parsed[4], ("scratch.txt".to_string(), GitStatus::Untracked));
        assert_eq!(
            parsed[5],
            ("conflicted.txt".to_string(), GitStatus::Conflicted)
        );
        assert_eq!(parsed[6], ("missing.txt".to_string(), GitStatus::Deleted));
    }

    #[test]
    fn parse_svn_status_ignores_metadata_lines() {
        let output = "\
        > moved from old-name.txt
X       external-lib
I       ignored.tmp
";

        assert!(parse_svn_status(output).is_empty());
    }

    #[test]
    fn parse_svn_raw_status_extracts_add_and_delete_candidates() {
        let output = "\
?       scratch.txt
!       missing.txt
M       modified.txt
";

        let parsed = parse_svn_raw_status(output);

        assert_eq!(
            parsed,
            vec![
                ("scratch.txt".to_string(), '?'),
                ("missing.txt".to_string(), '!'),
            ]
        );
    }
}
