use crate::{git, svn};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GitStatus {
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
    Conflicted,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    pub path: String,
    pub old_path: Option<String>,
    pub status: GitStatus,
    pub status_label: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChangeFileStatus {
    pub path: String,
    pub old_path: Option<String>,
    pub staged_status: Option<GitStatus>,
    pub unstaged_status: Option<GitStatus>,
    pub status_label: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: String,
    pub content: String,
    pub old_lineno: Option<u32>,
    pub new_lineno: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffResult {
    pub old_content: String,
    pub new_content: String,
    pub hunks: Vec<DiffHunk>,
    pub is_binary: bool,
    pub too_large: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum VcsKind {
    Git,
    Svn,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VcsRepoInfo {
    pub name: String,
    pub path: String,
    pub vcs_kind: VcsKind,
    pub current_branch: Option<String>,
}

pub(crate) const MAX_REPO_DISCOVER_DEPTH: u32 = 5;
pub(crate) const SKIP_DISCOVERY_DIRS: &[&str] = &[
    ".git",
    ".svn",
    "node_modules",
    "target",
    ".next",
    "dist",
    "__pycache__",
    ".superpowers",
];

pub(crate) fn status_label(status: &GitStatus) -> &'static str {
    match status {
        GitStatus::Modified => "M",
        GitStatus::Added => "A",
        GitStatus::Deleted => "D",
        GitStatus::Renamed => "R",
        GitStatus::Untracked => "?",
        GitStatus::Conflicted => "C",
    }
}

/// 在 Windows GUI 应用(windows_subsystem = "windows")下 spawn console 子进程
/// (比如 git.exe / svn.exe)默认会弹出 conhost 黑框,并且窗口创建/焦点切换会让 UI 感知卡顿。
/// 这里统一给 `Command` 加 CREATE_NO_WINDOW 抑制掉控制台分配。
pub(crate) fn hide_console_window(_cmd: &mut std::process::Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        _cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

pub(crate) fn repo_display_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("repository")
        .to_string()
}

// LCS-based diff producing DiffHunks (context = 3 lines)
pub(crate) fn build_hunks(old_lines: &[&str], new_lines: &[&str]) -> Vec<DiffHunk> {
    let m = old_lines.len();
    let n = new_lines.len();

    let mut dp = vec![vec![0usize; n + 1]; m + 1];
    for i in (0..m).rev() {
        for j in (0..n).rev() {
            if old_lines[i] == new_lines[j] {
                dp[i][j] = dp[i + 1][j + 1] + 1;
            } else {
                dp[i][j] = dp[i + 1][j].max(dp[i][j + 1]);
            }
        }
    }

    let mut flat: Vec<(char, usize, usize)> = Vec::new();
    let mut i = 0;
    let mut j = 0;
    while i < m || j < n {
        if i < m && j < n && old_lines[i] == new_lines[j] {
            flat.push(('=', i, j));
            i += 1;
            j += 1;
        } else if j < n && (i >= m || dp[i][j + 1] >= dp[i + 1][j]) {
            flat.push(('+', i, j));
            j += 1;
        } else {
            flat.push(('-', i, j));
            i += 1;
        }
    }

    const CONTEXT: usize = 3;
    let mut hunks: Vec<DiffHunk> = Vec::new();
    let changed_indices: Vec<usize> = flat
        .iter()
        .enumerate()
        .filter(|(_, (k, _, _))| *k != '=')
        .map(|(idx, _)| idx)
        .collect();

    if changed_indices.is_empty() {
        return hunks;
    }

    let mut groups: Vec<(usize, usize)> = Vec::new();
    let start = changed_indices[0].saturating_sub(CONTEXT);
    let end = (changed_indices[0] + CONTEXT + 1).min(flat.len());
    groups.push((start, end));

    for &idx in &changed_indices[1..] {
        let last = groups.last_mut().unwrap();
        let expanded_start = idx.saturating_sub(CONTEXT);
        let expanded_end = (idx + CONTEXT + 1).min(flat.len());
        if expanded_start <= last.1 {
            last.1 = last.1.max(expanded_end);
        } else {
            groups.push((expanded_start, expanded_end));
        }
    }

    for (grp_start, grp_end) in groups {
        let slice = &flat[grp_start..grp_end];
        let mut lines_out: Vec<DiffLine> = Vec::new();
        let mut old_start = 0u32;
        let mut new_start = 0u32;
        let mut old_count = 0u32;
        let mut new_count = 0u32;
        let mut first = true;

        for (k, oi, ni) in slice {
            let old_lineno = (*oi as u32) + 1;
            let new_lineno = (*ni as u32) + 1;
            match k {
                '=' => {
                    if first {
                        old_start = old_lineno;
                        new_start = new_lineno;
                        first = false;
                    }
                    lines_out.push(DiffLine {
                        kind: "context".to_string(),
                        content: old_lines[*oi].to_string(),
                        old_lineno: Some(old_lineno),
                        new_lineno: Some(new_lineno),
                    });
                    old_count += 1;
                    new_count += 1;
                }
                '-' => {
                    if first {
                        old_start = old_lineno;
                        new_start = (*ni as u32) + 1;
                        first = false;
                    }
                    lines_out.push(DiffLine {
                        kind: "delete".to_string(),
                        content: old_lines[*oi].to_string(),
                        old_lineno: Some(old_lineno),
                        new_lineno: None,
                    });
                    old_count += 1;
                }
                '+' => {
                    if first {
                        old_start = (*oi as u32) + 1;
                        new_start = new_lineno;
                        first = false;
                    }
                    lines_out.push(DiffLine {
                        kind: "add".to_string(),
                        content: new_lines[*ni].to_string(),
                        old_lineno: None,
                        new_lineno: Some(new_lineno),
                    });
                    new_count += 1;
                }
                _ => {}
            }
        }

        hunks.push(DiffHunk {
            old_start,
            old_lines: old_count,
            new_start,
            new_lines: new_count,
            lines: lines_out,
        });
    }

    hunks
}

pub(crate) fn full_replace_diff(old_content: &str, new_content: &str) -> Vec<DiffHunk> {
    let old_lines: Vec<&str> = old_content.lines().collect();
    let new_lines: Vec<&str> = new_content.lines().collect();
    let mut lines_out: Vec<DiffLine> = Vec::new();

    for (i, l) in old_lines.iter().enumerate() {
        lines_out.push(DiffLine {
            kind: "delete".to_string(),
            content: l.to_string(),
            old_lineno: Some((i as u32) + 1),
            new_lineno: None,
        });
    }
    for (i, l) in new_lines.iter().enumerate() {
        lines_out.push(DiffLine {
            kind: "add".to_string(),
            content: l.to_string(),
            old_lineno: None,
            new_lineno: Some((i as u32) + 1),
        });
    }

    if lines_out.is_empty() {
        return Vec::new();
    }

    vec![DiffHunk {
        old_start: 1,
        old_lines: old_lines.len() as u32,
        new_start: 1,
        new_lines: new_lines.len() as u32,
        lines: lines_out,
    }]
}

#[tauri::command]
pub fn discover_vcs_repos(project_path: String) -> Result<Vec<VcsRepoInfo>, String> {
    let path = Path::new(&project_path);
    let mut repos: Vec<VcsRepoInfo> = git::discover_git_repos(project_path.clone())?
        .into_iter()
        .map(|repo| VcsRepoInfo {
            name: repo.name,
            path: repo.path,
            vcs_kind: VcsKind::Git,
            current_branch: repo.current_branch,
        })
        .collect();

    for root in svn::discover_svn_repo_paths(path) {
        let root_str = root.to_string_lossy().to_string();
        if !repos.iter().any(|repo| repo.path == root_str) {
            repos.push(VcsRepoInfo {
                name: repo_display_name(&root),
                path: root_str,
                vcs_kind: VcsKind::Svn,
                current_branch: None,
            });
        }
    }

    Ok(repos)
}

#[tauri::command]
pub fn get_vcs_status(project_path: String) -> Result<Vec<GitFileStatus>, String> {
    let path = Path::new(&project_path);
    let mut all = git::get_git_status(project_path.clone())?;
    if let Some(root) = svn::svn_working_copy_root(path) {
        if let Ok(mut files) = svn::collect_svn_status(&root, Some(path)) {
            all.append(&mut files);
        }
    }
    Ok(all)
}

#[tauri::command]
pub fn get_vcs_changes_status(
    repo_path: String,
    vcs_kind: Option<VcsKind>,
) -> Result<Vec<ChangeFileStatus>, String> {
    match vcs_kind.unwrap_or(VcsKind::Git) {
        VcsKind::Git => git::get_changes_status(repo_path),
        VcsKind::Svn => svn::get_svn_changes_status(&repo_path),
    }
}

#[tauri::command]
pub fn get_vcs_diff(
    project_path: String,
    file_path: String,
    staged: Option<bool>,
    vcs_kind: Option<VcsKind>,
) -> Result<GitDiffResult, String> {
    match vcs_kind.unwrap_or(VcsKind::Git) {
        VcsKind::Git => git::get_git_diff(project_path, file_path, staged),
        VcsKind::Svn => svn::get_svn_diff(project_path, file_path),
    }
}

#[tauri::command]
pub fn vcs_commit(repo_path: String, vcs_kind: VcsKind, message: String) -> Result<String, String> {
    match vcs_kind {
        VcsKind::Git => git::git_commit(repo_path, message),
        VcsKind::Svn => svn::run_svn_command(Path::new(&repo_path), &["commit", "-m", &message]),
    }
}

#[tauri::command]
pub fn vcs_stage(repo_path: String, vcs_kind: VcsKind, files: Vec<String>) -> Result<(), String> {
    match vcs_kind {
        VcsKind::Git => git::git_stage(repo_path, files),
        VcsKind::Svn => {
            let repo = Path::new(&repo_path);
            for file in files {
                svn::svn_stage_file(repo, &file)?;
            }
            Ok(())
        }
    }
}

#[tauri::command]
pub fn vcs_stage_all(
    repo_path: String,
    vcs_kind: VcsKind,
    include_untracked: Option<bool>,
) -> Result<(), String> {
    match vcs_kind {
        VcsKind::Git => git::git_stage_all(repo_path),
        VcsKind::Svn => svn::svn_stage_all(&repo_path, include_untracked.unwrap_or(true)),
    }
}

#[tauri::command(async)]
pub fn vcs_update(repo_path: String, vcs_kind: VcsKind) -> Result<String, String> {
    match vcs_kind {
        VcsKind::Git => git::git_pull(repo_path),
        VcsKind::Svn => svn::run_svn_command(Path::new(&repo_path), &["update"]),
    }
}

#[tauri::command]
pub fn vcs_discard_file(
    repo_path: String,
    vcs_kind: VcsKind,
    files: Vec<String>,
) -> Result<(), String> {
    match vcs_kind {
        VcsKind::Git => git::git_discard_file(repo_path, files),
        VcsKind::Svn => {
            let repo = Path::new(&repo_path);
            let changes = svn::get_svn_changes_status(&repo_path)?;
            let status_by_path: HashMap<String, GitStatus> = changes
                .into_iter()
                .filter_map(|change| change.unstaged_status.map(|status| (change.path, status)))
                .collect();

            for file in files {
                if matches!(status_by_path.get(&file), Some(GitStatus::Untracked)) {
                    let abs = repo.join(file.replace('/', std::path::MAIN_SEPARATOR_STR));
                    if abs.is_dir() {
                        std::fs::remove_dir_all(&abs).map_err(|e| e.to_string())?;
                    } else if abs.exists() {
                        std::fs::remove_file(&abs).map_err(|e| e.to_string())?;
                    }
                } else {
                    svn::run_svn_command(repo, &["revert", "--depth", "infinity", &file])?;
                }
            }
            Ok(())
        }
    }
}
