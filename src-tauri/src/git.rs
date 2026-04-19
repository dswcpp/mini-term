use git2::{
    build::CheckoutBuilder, Blame, BlameOptions, BranchType, Repository, Status, StatusOptions,
};
use pathdiff::diff_paths;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

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
    pub hunk_key: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<DiffLine>,
    pub change_blocks: Vec<DiffChangeBlockInfo>,
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
pub struct GitBlameInfo {
    pub author_name: String,
    pub author_email: Option<String>,
    pub author_time: i64,
    pub commit_id: Option<String>,
    pub summary: Option<String>,
    pub is_uncommitted: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiffChangeBlockInfo {
    pub block_index: usize,
    pub line_start_index: usize,
    pub line_end_index: usize,
    pub blame: Option<GitBlameInfo>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffResult {
    pub old_content: String,
    pub new_content: String,
    pub hunks: Vec<DiffHunk>,
    pub is_binary: bool,
    pub too_large: bool,
    pub can_restore_file: bool,
    pub can_restore_partial: bool,
    pub restore_mode: GitRestoreMode,
    pub diff_cleared: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum GitRestoreMode {
    FileOnly,
    FileAndHunk,
    Unsupported,
}

// ---------------------------------------------------------------------------
// Task 2: get_git_status implementation
// ---------------------------------------------------------------------------

fn map_status(status: Status, is_empty_repo: bool) -> Option<GitStatus> {
    if status.contains(Status::CONFLICTED) {
        return Some(GitStatus::Conflicted);
    }
    if status.contains(Status::INDEX_RENAMED) || status.contains(Status::WT_RENAMED) {
        return Some(GitStatus::Renamed);
    }
    if status.contains(Status::INDEX_NEW) {
        return Some(GitStatus::Added);
    }
    if status.contains(Status::INDEX_MODIFIED) || status.contains(Status::WT_MODIFIED) {
        return Some(GitStatus::Modified);
    }
    if status.contains(Status::INDEX_DELETED) || status.contains(Status::WT_DELETED) {
        return Some(GitStatus::Deleted);
    }
    if status.contains(Status::WT_NEW) {
        if is_empty_repo {
            return Some(GitStatus::Added);
        } else {
            return Some(GitStatus::Untracked);
        }
    }
    None
}

fn status_label(status: &GitStatus) -> &'static str {
    match status {
        GitStatus::Modified => "M",
        GitStatus::Added => "A",
        GitStatus::Deleted => "D",
        GitStatus::Renamed => "R",
        GitStatus::Untracked => "?",
        GitStatus::Conflicted => "C",
    }
}

fn map_staged_status(status: Status) -> Option<GitStatus> {
    if status.contains(Status::CONFLICTED) {
        return Some(GitStatus::Conflicted);
    }
    if status.contains(Status::INDEX_RENAMED) {
        return Some(GitStatus::Renamed);
    }
    if status.contains(Status::INDEX_NEW) {
        return Some(GitStatus::Added);
    }
    if status.contains(Status::INDEX_MODIFIED) {
        return Some(GitStatus::Modified);
    }
    if status.contains(Status::INDEX_DELETED) {
        return Some(GitStatus::Deleted);
    }
    None
}

fn map_unstaged_status(status: Status, is_empty_repo: bool) -> Option<GitStatus> {
    if status.contains(Status::CONFLICTED) {
        return Some(GitStatus::Conflicted);
    }
    if status.contains(Status::WT_RENAMED) {
        return Some(GitStatus::Renamed);
    }
    if status.contains(Status::WT_MODIFIED) {
        return Some(GitStatus::Modified);
    }
    if status.contains(Status::WT_DELETED) {
        return Some(GitStatus::Deleted);
    }
    if status.contains(Status::WT_NEW) {
        if is_empty_repo {
            return Some(GitStatus::Added);
        } else {
            return Some(GitStatus::Untracked);
        }
    }
    None
}

fn collect_repo_status(
    repo: &Repository,
    path_prefix: Option<&Path>,
) -> Result<Vec<GitFileStatus>, String> {
    let is_empty_repo = repo.head().is_err();

    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);

    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for entry in statuses.iter() {
        let raw_path = entry.path().unwrap_or("").to_string();
        let s = entry.status();

        let git_status = match map_status(s, is_empty_repo) {
            Some(gs) => gs,
            None => continue,
        };

        let label = status_label(&git_status).to_string();

        // Compute path relative to path_prefix (if given), else use raw_path
        let display_path = if let Some(prefix) = path_prefix {
            let repo_workdir = repo.workdir().unwrap_or_else(|| repo.path());
            let abs = repo_workdir.join(&raw_path);
            diff_paths(&abs, prefix)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|| raw_path.clone())
        } else {
            raw_path.clone()
        };

        // old_path for renames
        let old_path = if matches!(git_status, GitStatus::Renamed) {
            entry.head_to_index().and_then(|d| {
                d.old_file()
                    .path()
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
            })
        } else {
            None
        };

        result.push(GitFileStatus {
            path: display_path,
            old_path,
            status: git_status,
            status_label: label,
        });
    }

    Ok(result)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoInfo {
    pub name: String,
    pub path: String,
    pub current_branch: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitCompletionData {
    pub repo_root: String,
    pub current_branch: Option<String>,
    pub local_branches: Vec<String>,
    pub remote_branches: Vec<String>,
    pub remotes: Vec<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitInfo {
    pub hash: String,
    pub short_hash: String,
    pub message: String,
    pub body: Option<String>,
    pub author: String,
    pub timestamp: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommitFileInfo {
    pub path: String,
    pub status: String,
    pub old_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub is_head: bool,
    pub is_remote: bool,
    pub commit_hash: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitFileHistoryEntry {
    pub commit_hash: String,
    pub short_hash: String,
    pub message: String,
    pub author: String,
    pub timestamp: i64,
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitFileHistoryResult {
    pub repo_path: String,
    pub file_path: String,
    pub entries: Vec<GitFileHistoryEntry>,
    pub has_more: bool,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitBlameRange {
    pub start_line: u32,
    pub end_line: u32,
    pub lines: Vec<String>,
    pub author: String,
    pub timestamp: i64,
    pub commit_hash: String,
    pub short_hash: String,
    pub message: String,
    pub is_uncommitted: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitFileBlameResult {
    pub repo_path: String,
    pub file_path: String,
    pub ranges: Vec<GitBlameRange>,
    pub is_binary: bool,
    pub too_large: bool,
}

/// Scan project_path for git repositories.
fn find_repos(project_path: &Path) -> Vec<(String, PathBuf, Repository)> {
    let mut repos = Vec::new();

    // 1) 椤圭洰璺緞鑷韩鏄惁涓轰粨搴擄紙浣跨敤 discover 淇濇寔鍚戜笂鎼滅储鑳藉姏锛?
    if let Ok(repo) = Repository::discover(project_path) {
        if let Some(workdir) = repo.workdir() {
            let repo_root = workdir.to_path_buf();
            let name = repo_root
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "root".to_string());
            repos.push((name, repo_root, repo));
            return repos;
        }
    }

    // 2) 閫掑綊鎵弿瀛愮洰褰曟煡鎵?git 浠撳簱锛堟渶澶?5 灞傦級
    const MAX_DEPTH: u32 = 5;
    const SKIP_DIRS: &[&str] = &[
        ".git",
        "node_modules",
        "target",
        ".next",
        "dist",
        "__pycache__",
        ".superpowers",
    ];
    fn scan(dir: &Path, depth: u32, repos: &mut Vec<(String, PathBuf, Repository)>) {
        if depth > MAX_DEPTH {
            return;
        }
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let sub = entry.path();
            if !sub.is_dir() {
                continue;
            }
            let dir_name = entry.file_name();
            let dir_name_str = dir_name.to_string_lossy();
            if SKIP_DIRS.contains(&dir_name_str.as_ref()) {
                continue;
            }
            if let Ok(repo) = Repository::open(&sub) {
                if let Some(workdir) = repo.workdir() {
                    if workdir.canonicalize().ok() == sub.canonicalize().ok() {
                        let name = sub
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_default();
                        repos.push((name, sub, repo));
                        continue; // 鎵惧埌浠撳簱鍚庝笉鍐嶆繁鍏ュ叾鍐呴儴
                    }
                }
            }
            scan(&sub, depth + 1, repos);
        }
    }
    scan(project_path, 1, &mut repos);

    repos
}

fn sort_and_dedupe(mut values: Vec<String>) -> Vec<String> {
    values.sort_by(|left, right| {
        left.to_lowercase()
            .cmp(&right.to_lowercase())
            .then_with(|| left.cmp(right))
    });
    values.dedup();
    values
}

fn map_delta_status(delta: git2::Delta) -> &'static str {
    match delta {
        git2::Delta::Added => "added",
        git2::Delta::Deleted => "deleted",
        git2::Delta::Modified => "modified",
        git2::Delta::Renamed => "renamed",
        _ => "modified",
    }
}

fn short_hash(value: &str) -> String {
    value[..7.min(value.len())].to_string()
}

fn canonicalize_repo_workdir(repo: &Repository) -> Result<PathBuf, String> {
    repo.workdir()
        .ok_or("bare repositories are not supported".to_string())
        .and_then(|path| path.canonicalize().map_err(|_| "repository worktree is unavailable".to_string()))
}

fn canonicalize_git_path_for_write(path: &Path) -> Result<PathBuf, String> {
    if path.exists() {
        return path
            .canonicalize()
            .map_err(|_| "path does not exist".to_string());
    }

    let parent = path.parent().ok_or("path has no parent".to_string())?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|_| "path does not exist".to_string())?;
    let file_name = path.file_name().ok_or("path has no file name".to_string())?;
    Ok(canonical_parent.join(file_name))
}

fn resolve_repo_relative_mutation_path(
    repo: &Repository,
    requested_path: &str,
    allow_missing_leaf: bool,
) -> Result<(PathBuf, String), String> {
    let workdir = canonicalize_repo_workdir(repo)?;
    let candidate = if Path::new(requested_path).is_absolute() {
        PathBuf::from(requested_path)
    } else {
        workdir.join(requested_path)
    };

    let resolved = if allow_missing_leaf {
        canonicalize_git_path_for_write(&candidate)?
    } else {
        candidate
            .canonicalize()
            .map_err(|_| "path does not exist".to_string())?
    };

    if !resolved.starts_with(&workdir) {
        return Err("path is outside repository worktree".to_string());
    }

    let relative = resolved
        .strip_prefix(&workdir)
        .map_err(|_| "path is outside repository worktree".to_string())?
        .to_string_lossy()
        .replace('\\', "/");

    Ok((resolved, relative))
}

fn restore_error(code: &str, detail: impl Into<String>) -> String {
    let detail = detail.into();
    if detail.is_empty() {
        code.to_string()
    } else {
        format!("{code}: {detail}")
    }
}

fn normalize_diff_line_content(value: &str) -> String {
    value.strip_suffix('\r').unwrap_or(value).to_string()
}

fn create_hunk_key(
    old_start: u32,
    old_lines: u32,
    new_start: u32,
    new_lines: u32,
    lines: &[DiffLine],
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(old_start.to_le_bytes());
    hasher.update(old_lines.to_le_bytes());
    hasher.update(new_start.to_le_bytes());
    hasher.update(new_lines.to_le_bytes());
    for line in lines {
        hasher.update(line.kind.as_bytes());
        hasher.update([0]);
        hasher.update(line.content.as_bytes());
        hasher.update([0]);
        hasher.update(line.old_lineno.unwrap_or_default().to_le_bytes());
        hasher.update(line.new_lineno.unwrap_or_default().to_le_bytes());
    }
    format!("{:x}", hasher.finalize())
}

fn create_diff_hunk(
    old_start: u32,
    old_lines: u32,
    new_start: u32,
    new_lines: u32,
    lines: Vec<DiffLine>,
) -> DiffHunk {
    let hunk_key = create_hunk_key(old_start, old_lines, new_start, new_lines, &lines);
    DiffHunk {
        hunk_key,
        old_start,
        old_lines,
        new_start,
        new_lines,
        lines,
        change_blocks: Vec::new(),
    }
}

fn restore_capabilities_for_status(
    status: Option<&GitStatus>,
    hunks: &[DiffHunk],
    is_binary: bool,
    too_large: bool,
) -> (bool, bool, GitRestoreMode) {
    let can_restore_file = matches!(
        status,
        Some(
            GitStatus::Modified
                | GitStatus::Added
                | GitStatus::Deleted
                | GitStatus::Renamed
                | GitStatus::Untracked
        )
    );

    let can_restore_partial = !is_binary
        && !too_large
        && !hunks.is_empty()
        && matches!(status, Some(GitStatus::Modified | GitStatus::Renamed));

    let restore_mode = if can_restore_partial {
        GitRestoreMode::FileAndHunk
    } else if can_restore_file {
        GitRestoreMode::FileOnly
    } else {
        GitRestoreMode::Unsupported
    };

    (can_restore_file, can_restore_partial, restore_mode)
}

fn build_worktree_diff_result(
    old_content: String,
    new_content: String,
    hunks: Vec<DiffHunk>,
    is_binary: bool,
    too_large: bool,
    status: Option<&GitStatus>,
) -> GitDiffResult {
    let (can_restore_file, can_restore_partial, restore_mode) =
        restore_capabilities_for_status(status, &hunks, is_binary, too_large);
    let diff_cleared = !is_binary && !too_large && hunks.is_empty();

    GitDiffResult {
        old_content,
        new_content,
        hunks,
        is_binary,
        too_large,
        can_restore_file,
        can_restore_partial,
        restore_mode,
        diff_cleared,
    }
}

fn build_read_only_diff_result(
    old_content: String,
    new_content: String,
    hunks: Vec<DiffHunk>,
    is_binary: bool,
    too_large: bool,
) -> GitDiffResult {
    GitDiffResult {
        old_content,
        new_content,
        hunks,
        is_binary,
        too_large,
        can_restore_file: false,
        can_restore_partial: false,
        restore_mode: GitRestoreMode::Unsupported,
        diff_cleared: false,
    }
}

#[cfg(windows)]
fn strip_windows_verbatim_prefix(path: PathBuf) -> PathBuf {
    let value = path.to_string_lossy();
    if let Some(stripped) = value.strip_prefix(r"\\?\") {
        PathBuf::from(stripped)
    } else {
        path
    }
}

#[cfg(not(windows))]
fn strip_windows_verbatim_prefix(path: PathBuf) -> PathBuf {
    path
}

fn resolve_workspace_file_path(project_path: &str, file_path: &str) -> Result<PathBuf, String> {
    let project_root = strip_windows_verbatim_prefix(
        Path::new(project_path)
            .canonicalize()
            .map_err(|error| restore_error("RESTORE_OUTSIDE_PROJECT", error.to_string()))?,
    );
    let candidate = project_root.join(file_path);

    let resolved = if candidate.exists() {
        strip_windows_verbatim_prefix(
            candidate
                .canonicalize()
                .map_err(|error| restore_error("RESTORE_FILE_NOT_FOUND", error.to_string()))?,
        )
    } else {
        let parent = candidate.parent().ok_or_else(|| {
            restore_error(
                "RESTORE_FILE_NOT_FOUND",
                "unable to resolve parent directory for target path",
            )
        })?;
        let parent = strip_windows_verbatim_prefix(
            parent
                .canonicalize()
                .map_err(|error| restore_error("RESTORE_FILE_NOT_FOUND", error.to_string()))?,
        );
        let file_name = candidate.file_name().ok_or_else(|| {
            restore_error("RESTORE_FILE_NOT_FOUND", "missing file name in target path")
        })?;
        parent.join(file_name)
    };

    if !resolved.starts_with(&project_root) {
        return Err(restore_error(
            "RESTORE_OUTSIDE_PROJECT",
            format!("{file_path} is outside {project_path}"),
        ));
    }

    Ok(resolved)
}

fn repo_relative_path(workdir: &Path, abs_path: &Path) -> Result<String, String> {
    let normalized_workdir = strip_windows_verbatim_prefix(workdir.to_path_buf());
    let normalized_abs_path = strip_windows_verbatim_prefix(abs_path.to_path_buf());
    normalized_abs_path
        .strip_prefix(&normalized_workdir)
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .map_err(|_| "file is outside repository working directory".to_string())
}

fn discover_repo_for_path(abs_path: &Path) -> Result<Repository, String> {
    let probe = if abs_path.exists() {
        abs_path
    } else {
        abs_path.parent().ok_or_else(|| {
            restore_error(
                "RESTORE_FILE_NOT_FOUND",
                "unable to resolve repository root for target path",
            )
        })?
    };

    Repository::discover(probe).map_err(|error| error.to_string())
}

fn get_head_content_bytes(repo: &Repository, rel_path: &str) -> Result<Option<Vec<u8>>, String> {
    let head = match repo.head() {
        Ok(head) => head,
        Err(_) => return Ok(None),
    };
    let tree = head.peel_to_tree().map_err(|e| e.to_string())?;
    let entry = match tree.get_path(Path::new(rel_path)) {
        Ok(entry) => entry,
        Err(_) => return Ok(Some(Vec::new())),
    };
    let object = entry.to_object(repo).map_err(|e| e.to_string())?;
    let blob = object.as_blob().ok_or("not a blob")?;

    if blob.is_binary() {
        return Err("binary".to_string());
    }

    Ok(Some(blob.content().to_vec()))
}

#[tauri::command]
pub fn get_git_completion_data(cwd: String) -> Result<Option<GitCompletionData>, String> {
    let repo = match Repository::discover(Path::new(&cwd)) {
        Ok(repo) => repo,
        Err(_) => return Ok(None),
    };

    let repo_root = repo
        .workdir()
        .unwrap_or_else(|| repo.path())
        .to_string_lossy()
        .to_string();

    let current_branch = repo
        .head()
        .ok()
        .and_then(|head| head.shorthand().map(|value| value.to_string()))
        .filter(|name| name != "HEAD");

    let mut local_branches = Vec::new();
    if let Ok(branches) = repo.branches(Some(BranchType::Local)) {
        for branch in branches.flatten() {
            if let Ok(Some(name)) = branch.0.name() {
                local_branches.push(name.to_string());
            }
        }
    }

    let mut remote_branches = Vec::new();
    if let Ok(branches) = repo.branches(Some(BranchType::Remote)) {
        for branch in branches.flatten() {
            if let Ok(Some(name)) = branch.0.name() {
                if !name.ends_with("/HEAD") {
                    remote_branches.push(name.to_string());
                }
            }
        }
    }

    let remotes = repo
        .remotes()
        .map(|remotes| {
            remotes
                .iter()
                .flatten()
                .map(|name| name.to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let tags = repo
        .tag_names(None)
        .map(|tags| {
            tags.iter()
                .flatten()
                .map(|name| name.to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(Some(GitCompletionData {
        repo_root,
        current_branch,
        local_branches: sort_and_dedupe(local_branches),
        remote_branches: sort_and_dedupe(remote_branches),
        remotes: sort_and_dedupe(remotes),
        tags: sort_and_dedupe(tags),
    }))
}

#[tauri::command]
pub fn get_git_status(project_path: String) -> Result<Vec<GitFileStatus>, String> {
    let path = Path::new(&project_path);
    let repos = find_repos(path);

    if repos.is_empty() {
        return Ok(Vec::new());
    }

    let mut all = Vec::new();
    for (_, _, repo) in &repos {
        if let Ok(mut files) = collect_repo_status(repo, Some(path)) {
            all.append(&mut files);
        }
    }
    Ok(all)
}

#[tauri::command]
pub fn get_changes_status(repo_path: String) -> Result<Vec<ChangeFileStatus>, String> {
    let path = Path::new(&repo_path);
    let repo = Repository::open(path).map_err(|e| e.to_string())?;
    let is_empty_repo = repo.head().is_err();

    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);

    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;
    let workdir = repo.workdir().unwrap_or_else(|| repo.path());

    let mut result = Vec::new();
    for entry in statuses.iter() {
        let raw_path = entry.path().unwrap_or("").to_string();
        let s = entry.status();

        let staged = map_staged_status(s);
        let unstaged = map_unstaged_status(s, is_empty_repo);

        if staged.is_none() && unstaged.is_none() {
            continue;
        }

        let label = staged
            .as_ref()
            .or(unstaged.as_ref())
            .map(status_label)
            .unwrap_or("")
            .to_string();

        let abs = workdir.join(&raw_path);
        let display_path = diff_paths(&abs, path)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|| raw_path.clone());

        let old_path = if s.contains(Status::INDEX_RENAMED) || s.contains(Status::WT_RENAMED) {
            entry
                .head_to_index()
                .and_then(|d| {
                    d.old_file()
                        .path()
                        .map(|p| p.to_string_lossy().replace('\\', "/"))
                })
        } else {
            None
        };

        result.push(ChangeFileStatus {
            path: display_path,
            old_path,
            staged_status: staged,
            unstaged_status: unstaged,
            status_label: label,
        });
    }

    Ok(result)
}

#[tauri::command]
pub fn discover_git_repos(project_path: String) -> Result<Vec<GitRepoInfo>, String> {
    let path = Path::new(&project_path);
    let repos = find_repos(path);
    Ok(repos
        .into_iter()
        .map(|(name, abs_path, repo)| {
            let current_branch = repo.head().ok().and_then(|head| {
                if head.is_branch() {
                    head.shorthand().map(|value| value.to_string())
                } else {
                    head.target().map(|oid| {
                        let hash = oid.to_string();
                        format!("({})", &hash[..7.min(hash.len())])
                    })
                }
            });

            GitRepoInfo {
                name,
                path: abs_path.to_string_lossy().to_string(),
                current_branch,
            }
        })
        .collect())
}

#[tauri::command]
pub fn get_git_log(
    repo_path: String,
    before_commit: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<GitCommitInfo>, String> {
    let path = Path::new(&repo_path);
    let repo = Repository::open(path).map_err(|e| e.to_string())?;
    let limit = limit.unwrap_or(30);

    let mut revwalk = repo.revwalk().map_err(|e| e.to_string())?;
    revwalk
        .set_sorting(git2::Sort::TIME)
        .map_err(|e| e.to_string())?;

    if let Some(ref hash) = before_commit {
        let oid = git2::Oid::from_str(hash).map_err(|e| e.to_string())?;
        let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
        for parent_id in commit.parent_ids() {
            revwalk.push(parent_id).map_err(|e| e.to_string())?;
        }
    } else {
        revwalk.push_head().map_err(|e| e.to_string())?;
    }

    let mut result = Vec::with_capacity(limit);
    for oid_result in revwalk {
        if result.len() >= limit {
            break;
        }
        let oid = oid_result.map_err(|e| e.to_string())?;
        let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
        let hash = oid.to_string();
        let short_hash = hash[..7.min(hash.len())].to_string();
        let message = commit.summary().unwrap_or("").to_string();
        let body = commit.body().map(|value| value.to_string());
        let author = commit.author().name().unwrap_or("unknown").to_string();
        let timestamp = commit.time().seconds();
        result.push(GitCommitInfo {
            hash,
            short_hash,
            message,
            body,
            author,
            timestamp,
        });
    }

    Ok(result)
}

#[tauri::command]
pub fn get_repo_branches(repo_path: String) -> Result<Vec<BranchInfo>, String> {
    let repo = Repository::open(Path::new(&repo_path)).map_err(|e| e.to_string())?;
    let head_target = repo.head().ok().and_then(|head| head.target());

    let mut branches = Vec::new();

    for branch_result in repo
        .branches(Some(BranchType::Local))
        .map_err(|e| e.to_string())?
    {
        let (branch, _) = branch_result.map_err(|e| e.to_string())?;
        let name = branch
            .name()
            .map_err(|e| e.to_string())?
            .unwrap_or("")
            .to_string();
        if let Some(target) = branch.get().target() {
            branches.push(BranchInfo {
                name,
                is_head: head_target == Some(target),
                is_remote: false,
                commit_hash: target.to_string(),
            });
        }
    }

    for branch_result in repo
        .branches(Some(BranchType::Remote))
        .map_err(|e| e.to_string())?
    {
        let (branch, _) = branch_result.map_err(|e| e.to_string())?;
        let name = branch
            .name()
            .map_err(|e| e.to_string())?
            .unwrap_or("")
            .to_string();
        if name.ends_with("/HEAD") {
            continue;
        }
        if let Some(target) = branch.get().target() {
            branches.push(BranchInfo {
                name,
                is_head: false,
                is_remote: true,
                commit_hash: target.to_string(),
            });
        }
    }

    Ok(branches)
}

#[tauri::command]
pub fn get_commit_files(
    repo_path: String,
    commit_hash: String,
) -> Result<Vec<CommitFileInfo>, String> {
    let repo = Repository::open(Path::new(&repo_path)).map_err(|e| e.to_string())?;
    let oid = git2::Oid::from_str(&commit_hash).map_err(|e| e.to_string())?;
    let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
    let tree = commit.tree().map_err(|e| e.to_string())?;

    let parent_tree = if commit.parent_count() > 0 {
        Some(
            commit
                .parent(0)
                .map_err(|e| e.to_string())?
                .tree()
                .map_err(|e| e.to_string())?,
        )
    } else {
        None
    };

    let diff = repo
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)
        .map_err(|e| e.to_string())?;

    let mut files = Vec::new();
    for delta in diff.deltas() {
        let status = match delta.status() {
            git2::Delta::Added => "added",
            git2::Delta::Deleted => "deleted",
            git2::Delta::Modified => "modified",
            git2::Delta::Renamed => "renamed",
            _ => "modified",
        };
        let path = delta
            .new_file()
            .path()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let old_path = if delta.status() == git2::Delta::Renamed {
            delta
                .old_file()
                .path()
                .map(|p| p.to_string_lossy().to_string())
        } else {
            None
        };
        files.push(CommitFileInfo {
            path,
            status: status.to_string(),
            old_path,
        });
    }
    Ok(files)
}

#[tauri::command]
pub fn get_commit_file_diff(
    repo_path: String,
    commit_hash: String,
    file_path: String,
    old_file_path: Option<String>,
) -> Result<GitDiffResult, String> {
    let repo = Repository::open(Path::new(&repo_path)).map_err(|e| e.to_string())?;
    let oid = git2::Oid::from_str(&commit_hash).map_err(|e| e.to_string())?;
    let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
    let tree = commit.tree().map_err(|e| e.to_string())?;

    let parent_tree = if commit.parent_count() > 0 {
        Some(
            commit
                .parent(0)
                .map_err(|e| e.to_string())?
                .tree()
                .map_err(|e| e.to_string())?,
        )
    } else {
        None
    };

    let new_content = match tree.get_path(Path::new(&file_path)) {
        Ok(entry) => {
            let obj = entry.to_object(&repo).map_err(|e| e.to_string())?;
            let blob = obj.as_blob().ok_or("not a blob")?;
            if blob.is_binary() {
                return Ok(build_read_only_diff_result(
                    String::new(),
                    String::new(),
                    Vec::new(),
                    true,
                    false,
                ));
            }
            if blob.content().len() > 1_048_576 {
                return Ok(build_read_only_diff_result(
                    String::new(),
                    String::new(),
                    Vec::new(),
                    false,
                    true,
                ));
            }
            std::str::from_utf8(blob.content())
                .map_err(|_| "binary".to_string())?
                .to_string()
        }
        Err(_) => String::new(),
    };

    let old_lookup_path = old_file_path.as_deref().unwrap_or(&file_path);
    let old_content = if let Some(ref pt) = parent_tree {
        match pt.get_path(Path::new(old_lookup_path)) {
            Ok(entry) => {
                let obj = entry.to_object(&repo).map_err(|e| e.to_string())?;
                let blob = obj.as_blob().ok_or("not a blob")?;
                if blob.is_binary() {
                    return Ok(build_read_only_diff_result(
                        String::new(),
                        String::new(),
                        Vec::new(),
                        true,
                        false,
                    ));
                }
                std::str::from_utf8(blob.content())
                    .map_err(|_| "binary".to_string())?
                    .to_string()
            }
            Err(_) => String::new(),
        }
    } else {
        String::new()
    };

    let old_lines: Vec<&str> = old_content.lines().collect();
    let new_lines: Vec<&str> = new_content.lines().collect();

    let ol = old_lines.len() as u64;
    let nl = new_lines.len() as u64;

    let hunks = if ol * nl > 10_000_000 {
        full_replace_diff(&old_content, &new_content)
    } else {
        build_hunks(&old_lines, &new_lines)
    };

    Ok(build_read_only_diff_result(
        old_content,
        new_content,
        hunks,
        false,
        false,
    ))
}

#[tauri::command]
pub fn git_stage(repo_path: String, files: Vec<String>) -> Result<(), String> {
    let repo = Repository::open(Path::new(&repo_path)).map_err(|e| e.to_string())?;
    let mut index = repo.index().map_err(|e| e.to_string())?;
    for file in &files {
        let (abs_path, relative_path) = resolve_repo_relative_mutation_path(&repo, file, true)?;
        let path = Path::new(&relative_path);
        if abs_path.exists() {
            index.add_path(path).map_err(|e| e.to_string())?;
        } else {
            index.remove_path(path).map_err(|e| e.to_string())?;
        }
    }
    index.write().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn git_unstage(repo_path: String, files: Vec<String>) -> Result<(), String> {
    let repo = Repository::open(Path::new(&repo_path)).map_err(|e| e.to_string())?;
    let head = match repo.head() {
        Ok(h) => Some(h.peel_to_commit().map_err(|e| e.to_string())?),
        Err(_) => None,
    };
    if let Some(ref commit) = head {
        for file in &files {
            let (_, relative_path) = resolve_repo_relative_mutation_path(&repo, file, true)?;
            repo.reset_default(Some(commit.as_object()), [relative_path.as_str()])
                .map_err(|e| e.to_string())?;
        }
    } else {
        let mut index = repo.index().map_err(|e| e.to_string())?;
        for file in &files {
            let (_, relative_path) = resolve_repo_relative_mutation_path(&repo, file, true)?;
            index.remove_path(Path::new(&relative_path))
                .map_err(|e| e.to_string())?;
        }
        index.write().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn git_stage_all(repo_path: String) -> Result<(), String> {
    let repo = Repository::open(Path::new(&repo_path)).map_err(|e| e.to_string())?;
    let mut index = repo.index().map_err(|e| e.to_string())?;
    index
        .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
        .map_err(|e| e.to_string())?;
    let workdir = repo.workdir().ok_or("bare repo")?;
    let entries: Vec<String> = index
        .iter()
        .filter_map(|e| {
            let path = String::from_utf8_lossy(&e.path).to_string();
            if !workdir.join(&path).exists() {
                Some(path)
            } else {
                None
            }
        })
        .collect();
    for path in entries {
        index.remove_path(Path::new(&path)).map_err(|e| e.to_string())?;
    }
    index.write().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn git_unstage_all(repo_path: String) -> Result<(), String> {
    let repo = Repository::open(Path::new(&repo_path)).map_err(|e| e.to_string())?;
    match repo.head() {
        Ok(head) => {
            let commit = head.peel_to_commit().map_err(|e| e.to_string())?;
            repo.reset(commit.as_object(), git2::ResetType::Mixed, None)
                .map_err(|e| e.to_string())?;
        }
        Err(_) => {
            let mut index = repo.index().map_err(|e| e.to_string())?;
            index.clear().map_err(|e| e.to_string())?;
            index.write().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn git_commit(repo_path: String, message: String) -> Result<String, String> {
    let repo = Repository::discover(Path::new(&repo_path))
        .map_err(|_| "repository not found".to_string())?;
    let workdir = canonicalize_repo_workdir(&repo)?;
    let output = std::process::Command::new("git")
        .args(["commit", "--message", &message, "--"])
        .current_dir(workdir)
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|_| "failed to start git commit".to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
pub fn git_discard_file(repo_path: String, files: Vec<String>) -> Result<(), String> {
    let repo = Repository::open(Path::new(&repo_path)).map_err(|e| e.to_string())?;
    let _workdir = canonicalize_repo_workdir(&repo)?;
    for file in &files {
        let (abs_path, relative_path) = resolve_repo_relative_mutation_path(&repo, file, true)?;
        let mut opts = StatusOptions::new();
        opts.pathspec(&relative_path);
        let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;
        let is_untracked = statuses.iter().any(|e| e.status().contains(Status::WT_NEW));
        if is_untracked {
            if abs_path.exists() {
                std::fs::remove_file(&abs_path).map_err(|e| e.to_string())?;
            }
        } else {
            let head = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
            if let Some(ref commit) = head {
                let _ = repo.reset_default(Some(commit.as_object()), [relative_path.as_str()]);
            }
            repo.checkout_head(Some(
                git2::build::CheckoutBuilder::new()
                    .force()
                    .path(&relative_path),
            ))
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn git_pull(repo_path: String) -> Result<String, String> {
    let output = std::process::Command::new("git")
        .arg("pull")
        .current_dir(&repo_path)
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|error| format!("Failed to execute git pull: {error}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
pub async fn git_push(repo_path: String) -> Result<String, String> {
    let output = std::process::Command::new("git")
        .arg("push")
        .current_dir(&repo_path)
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|error| format!("Failed to execute git push: {error}"))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}


struct MatchedHistoryEntry {
    entry: GitFileHistoryEntry,
    previous_path: Option<String>,
}

fn match_file_history_entry(
    repo: &Repository,
    commit: &git2::Commit<'_>,
    tracked_path: &str,
) -> Result<Option<MatchedHistoryEntry>, String> {
    #[derive(Clone)]
    struct HistoryDeltaRecord {
        status: git2::Delta,
        new_path: Option<String>,
        old_path: Option<String>,
        new_id: git2::Oid,
        old_id: git2::Oid,
    }

    let tree = commit.tree().map_err(|error| error.to_string())?;
    let parent_tree = if commit.parent_count() > 0 {
        Some(
            commit
                .parent(0)
                .map_err(|error| error.to_string())?
                .tree()
                .map_err(|error| error.to_string())?,
        )
    } else {
        None
    };

    let mut diff = repo
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)
        .map_err(|error| error.to_string())?;
    let mut find_options = git2::DiffFindOptions::new();
    find_options
        .all(true)
        .renames(true)
        .renames_from_rewrites(true);
    diff.find_similar(Some(&mut find_options))
        .map_err(|error| error.to_string())?;

    let deltas = diff
        .deltas()
        .map(|delta| HistoryDeltaRecord {
            status: delta.status(),
            new_path: delta
                .new_file()
                .path()
                .map(|path| path.to_string_lossy().replace('\\', "/")),
            old_path: delta
                .old_file()
                .path()
                .map(|path| path.to_string_lossy().replace('\\', "/")),
            new_id: delta.new_file().id(),
            old_id: delta.old_file().id(),
        })
        .collect::<Vec<_>>();

    if let Some(added_delta) = deltas.iter().find(|delta| {
        delta.status == git2::Delta::Added && delta.new_path.as_deref() == Some(tracked_path)
    }) {
        if let Some(deleted_delta) = deltas.iter().find(|delta| {
            delta.status == git2::Delta::Deleted
                && delta.old_path.is_some()
                && delta.old_id == added_delta.new_id
        }) {
            let hash = commit.id().to_string();
            return Ok(Some(MatchedHistoryEntry {
                entry: GitFileHistoryEntry {
                    commit_hash: hash.clone(),
                    short_hash: short_hash(&hash),
                    message: commit.summary().unwrap_or("").to_string(),
                    author: commit.author().name().unwrap_or("unknown").to_string(),
                    timestamp: commit.time().seconds(),
                    path: added_delta
                        .new_path
                        .clone()
                        .unwrap_or_else(|| tracked_path.to_string()),
                    old_path: deleted_delta.old_path.clone(),
                    status: "renamed".to_string(),
                },
                previous_path: deleted_delta.old_path.clone(),
            }));
        }
    }

    for delta in deltas {
        let new_path = delta.new_path;
        let old_path = delta.old_path;
        let matches =
            new_path.as_deref() == Some(tracked_path) || old_path.as_deref() == Some(tracked_path);

        if !matches {
            continue;
        }

        let hash = commit.id().to_string();
        let previous_path =
            if delta.status == git2::Delta::Renamed && new_path.as_deref() == Some(tracked_path) {
                old_path.clone()
            } else {
                None
            };
        let path = if delta.status == git2::Delta::Deleted {
            old_path.clone().unwrap_or_else(|| tracked_path.to_string())
        } else {
            new_path
                .clone()
                .or_else(|| old_path.clone())
                .unwrap_or_else(|| tracked_path.to_string())
        };

        return Ok(Some(MatchedHistoryEntry {
            entry: GitFileHistoryEntry {
                commit_hash: hash.clone(),
                short_hash: short_hash(&hash),
                message: commit.summary().unwrap_or("").to_string(),
                author: commit.author().name().unwrap_or("unknown").to_string(),
                timestamp: commit.time().seconds(),
                path,
                old_path: (delta.status == git2::Delta::Renamed)
                    .then_some(old_path.clone())
                    .flatten(),
                status: map_delta_status(delta.status).to_string(),
            },
            previous_path,
        }));
    }

    Ok(None)
}

fn collect_file_history_entries(
    repo: &Repository,
    rel_path: &str,
    before_commit: Option<&str>,
    limit: usize,
) -> Result<(Vec<GitFileHistoryEntry>, bool), String> {
    let mut revwalk = repo.revwalk().map_err(|error| error.to_string())?;
    revwalk
        .set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)
        .map_err(|error| error.to_string())?;
    revwalk.push_head().map_err(|error| error.to_string())?;

    let mut tracked_path = rel_path.to_string();
    let mut cursor = before_commit.map(|value| value.to_string());
    let mut entries = Vec::with_capacity(limit);

    for oid_result in revwalk {
        let oid = oid_result.map_err(|error| error.to_string())?;
        let commit = repo.find_commit(oid).map_err(|error| error.to_string())?;
        let matched = match_file_history_entry(repo, &commit, &tracked_path)?;
        let Some(matched) = matched else {
            continue;
        };

        if let Some(previous_path) = matched.previous_path.clone() {
            tracked_path = previous_path;
        }

        if let Some(cursor_hash) = cursor.as_ref() {
            if matched.entry.commit_hash == *cursor_hash {
                cursor = None;
            }
            continue;
        }

        if entries.len() >= limit {
            return Ok((entries, true));
        }

        entries.push(matched.entry);
    }

    Ok((entries, false))
}

#[tauri::command]
pub fn get_file_git_history(
    project_path: String,
    file_path: String,
    before_commit: Option<String>,
    limit: Option<usize>,
) -> Result<GitFileHistoryResult, String> {
    let abs_file = resolve_workspace_file_path(&project_path, &file_path)?;
    let repo = discover_repo_for_path(&abs_file)?;
    let workdir = repo.workdir().ok_or("bare repository not supported")?;
    let rel_path = repo_relative_path(workdir, &abs_file)?;
    let limit = limit.unwrap_or(30).clamp(1, 100);
    let (entries, has_more) =
        collect_file_history_entries(&repo, &rel_path, before_commit.as_deref(), limit)?;

    Ok(GitFileHistoryResult {
        repo_path: strip_windows_verbatim_prefix(workdir.to_path_buf())
            .to_string_lossy()
            .to_string(),
        file_path: rel_path,
        next_cursor: has_more
            .then(|| entries.last().map(|entry| entry.commit_hash.clone()))
            .flatten(),
        entries,
        has_more,
    })
}

#[tauri::command]
pub fn get_file_git_blame(
    project_path: String,
    file_path: String,
) -> Result<GitFileBlameResult, String> {
    let abs_file = resolve_workspace_file_path(&project_path, &file_path)?;
    let repo = discover_repo_for_path(&abs_file)?;
    let workdir = repo.workdir().ok_or("bare repository not supported")?;
    let rel_path = repo_relative_path(workdir, &abs_file)?;
    let bytes = std::fs::read(&abs_file).map_err(|error| error.to_string())?;

    if bytes.len() > 1_048_576 {
        return Ok(GitFileBlameResult {
            repo_path: strip_windows_verbatim_prefix(workdir.to_path_buf())
                .to_string_lossy()
                .to_string(),
            file_path: rel_path,
            ranges: Vec::new(),
            is_binary: false,
            too_large: true,
        });
    }

    let content = match std::str::from_utf8(&bytes) {
        Ok(value) => value.to_string(),
        Err(_) => {
            return Ok(GitFileBlameResult {
                repo_path: strip_windows_verbatim_prefix(workdir.to_path_buf())
                    .to_string_lossy()
                    .to_string(),
                file_path: rel_path,
                ranges: Vec::new(),
                is_binary: true,
                too_large: false,
            })
        }
    };

    let mut options = BlameOptions::new();
    if let Some(head_oid) = repo.head().ok().and_then(|head| head.target()) {
        options.newest_commit(head_oid);
    }
    options
        .track_copies_same_file(true)
        .track_copies_same_commit_moves(true)
        .track_copies_same_commit_copies(true);

    let blame = repo
        .blame_file(Path::new(&rel_path), Some(&mut options))
        .map_err(|error| error.to_string())?;
    let lines = split_text_lines(&content);
    let mut ranges = Vec::new();
    let mut line_no = 1usize;

    while line_no <= lines.len() {
        let Some(blame_hunk) = blame.get_line(line_no) else {
            let mut range_end = line_no;
            while range_end < lines.len() && blame.get_line(range_end + 1).is_none() {
                range_end += 1;
            }
            ranges.push(build_uncommitted_blame_range(&lines, line_no, range_end));
            line_no = range_end + 1;
            continue;
        };
        let blame_info = build_git_blame_info(&repo, &blame_hunk);
        let start_line = blame_hunk.final_start_line();
        let range_start = start_line.max(line_no);
        let range_end = (start_line + blame_hunk.lines_in_hunk().saturating_sub(1))
            .min(lines.len())
            .max(range_start);
        let commit_hash = blame_info.commit_id.clone().unwrap_or_default();

        ranges.push(GitBlameRange {
            start_line: range_start as u32,
            end_line: range_end as u32,
            lines: lines[(range_start - 1)..range_end].to_vec(),
            author: blame_info.author_name,
            timestamp: blame_info.author_time,
            short_hash: short_hash(&commit_hash),
            message: blame_info.summary.unwrap_or_default(),
            commit_hash,
            is_uncommitted: blame_info.is_uncommitted,
        });

        line_no = range_end + 1;
    }

    Ok(GitFileBlameResult {
        repo_path: strip_windows_verbatim_prefix(workdir.to_path_buf())
            .to_string_lossy()
            .to_string(),
        file_path: rel_path,
        ranges,
        is_binary: false,
        too_large: false,
    })
}

// ---------------------------------------------------------------------------
// get_git_diff implementation
// ---------------------------------------------------------------------------

fn get_head_content(repo: &Repository, rel_path: &str) -> Result<Option<String>, String> {
    match get_head_content_bytes(repo, rel_path)? {
        None => Ok(None),
        Some(bytes) => std::str::from_utf8(&bytes)
            .map(|value| Some(value.to_string()))
            .map_err(|_| "binary".to_string()),
    }
}

// LCS-based diff producing DiffHunks (context = 3 lines)
fn build_hunks(old_lines: &[&str], new_lines: &[&str]) -> Vec<DiffHunk> {
    let m = old_lines.len();
    let n = new_lines.len();

    // LCS DP table
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

    // Produce flat edit list: ('=', old_i, new_j) | ('-', old_i, _) | ('+', _, new_j)
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

    // Group into hunks (context = 3 lines)
    const CONTEXT: usize = 3;
    let mut hunks: Vec<DiffHunk> = Vec::new();

    // Find ranges of non-equal edits, expand with context
    let changed_indices: Vec<usize> = flat
        .iter()
        .enumerate()
        .filter(|(_, (k, _, _))| *k != '=')
        .map(|(idx, _)| idx)
        .collect();

    if changed_indices.is_empty() {
        return hunks;
    }

    // Group changed indices into contiguous ranges (with context)
    let mut groups: Vec<(usize, usize)> = Vec::new(); // (start, end) in flat[]
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
                        // new_start might be the next insert; approximate
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

        hunks.push(create_diff_hunk(
            old_start, old_count, new_start, new_count, lines_out,
        ));
    }

    hunks
}

fn full_replace_diff(old_content: &str, new_content: &str) -> Vec<DiffHunk> {
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

    vec![create_diff_hunk(
        1,
        old_lines.len() as u32,
        1,
        new_lines.len() as u32,
        lines_out,
    )]
}

fn load_worktree_diff(
    project_path: &str,
    file_path: &str,
    old_file_path: Option<&str>,
    status: Option<&GitStatus>,
) -> Result<GitDiffResult, String> {
    let abs_file = resolve_workspace_file_path(project_path, file_path)?;

    let repo = discover_repo_for_path(&abs_file)?;
    let workdir = repo.workdir().ok_or("bare repository not supported")?;

    // Relative path inside repo
    let rel_str = repo_relative_path(workdir, &abs_file)?;
    let old_lookup = if let Some(old_file_path) = old_file_path {
        let old_abs_file = resolve_workspace_file_path(project_path, old_file_path)?;
        repo_relative_path(workdir, &old_abs_file)?
    } else {
        rel_str.clone()
    };

    // Read new (working tree) content
    let new_bytes = match std::fs::read(&abs_file) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(error.to_string()),
    };

    // Large file protection (> 1 MB)
    if new_bytes.len() > 1_048_576 {
        return Ok(build_worktree_diff_result(
            String::new(),
            String::new(),
            Vec::new(),
            false,
            true,
            status,
        ));
    }

    // Binary detection
    let new_content = match std::str::from_utf8(&new_bytes) {
        Ok(s) => s.to_string(),
        Err(_) => {
            return Ok(build_worktree_diff_result(
                String::new(),
                String::new(),
                Vec::new(),
                true,
                false,
                status,
            ))
        }
    };

    // Get HEAD content
    let old_content: String = get_head_content(&repo, &old_lookup)?.unwrap_or_default();

    // Check blob binary via git2 as well
    // (already covered by UTF-8 check above for new content; old content checked in get_head_content)

    let old_lines: Vec<&str> = old_content.lines().collect();
    let new_lines_vec: Vec<&str> = new_content.lines().collect();

    let ol = old_lines.len() as u64;
    let nl = new_lines_vec.len() as u64;

    let mut hunks = if ol * nl > 10_000_000 {
        full_replace_diff(&old_content, &new_content)
    } else {
        build_hunks(&old_lines, &new_lines_vec)
    };

    annotate_change_blocks_with_blame(&repo, &old_lookup, &mut hunks);

    Ok(build_worktree_diff_result(
        old_content,
        new_content,
        hunks,
        false,
        false,
        status,
    ))
}

#[tauri::command]
pub fn get_git_diff(
    project_path: String,
    file_path: String,
    old_file_path: Option<String>,
    status: Option<GitStatus>,
) -> Result<GitDiffResult, String> {
    load_worktree_diff(
        &project_path,
        &file_path,
        old_file_path.as_deref(),
        status.as_ref(),
    )
}

fn checkout_path_from_head(repo: &Repository, rel_path: &str) -> Result<(), String> {
    let head = repo
        .head()
        .map_err(|error| restore_error("RESTORE_FILE_NOT_FOUND", error.to_string()))?;
    let tree = head
        .peel_to_tree()
        .map_err(|error| restore_error("RESTORE_FILE_NOT_FOUND", error.to_string()))?;

    let mut checkout = CheckoutBuilder::new();
    checkout.force().recreate_missing(true).path(rel_path);
    repo.checkout_tree(tree.as_object(), Some(&mut checkout))
        .map_err(|error| restore_error("RESTORE_PATCH_APPLY_FAILED", error.to_string()))
}

fn reset_index_path_to_head(repo: &Repository, rel_path: &str) -> Result<(), String> {
    let head = repo
        .head()
        .map_err(|error| restore_error("RESTORE_FILE_NOT_FOUND", error.to_string()))?
        .peel_to_commit()
        .map_err(|error| restore_error("RESTORE_FILE_NOT_FOUND", error.to_string()))?;
    let object = head.as_object();
    repo.reset_default(Some(object), [rel_path])
        .map_err(|error| restore_error("RESTORE_PATCH_APPLY_FAILED", error.to_string()))
}

fn remove_index_path(repo: &Repository, rel_path: &str) -> Result<(), String> {
    let mut index = repo
        .index()
        .map_err(|error| restore_error("RESTORE_PATCH_APPLY_FAILED", error.to_string()))?;
    match index.remove_path(Path::new(rel_path)) {
        Ok(()) => {}
        Err(error) if error.code() == git2::ErrorCode::NotFound => {}
        Err(error) => {
            return Err(restore_error(
                "RESTORE_PATCH_APPLY_FAILED",
                error.to_string(),
            ))
        }
    }
    index
        .write()
        .map_err(|error| restore_error("RESTORE_PATCH_APPLY_FAILED", error.to_string()))
}

fn discover_old_restore_path(
    repo: &Repository,
    rel_path: &str,
    provided_old_file_path: Option<&str>,
) -> Result<Option<String>, String> {
    if let Some(old_file_path) = provided_old_file_path {
        return Ok(Some(old_file_path.to_string()));
    }

    let statuses = collect_repo_status(repo, None)?;
    Ok(statuses
        .into_iter()
        .find(|status| status.path == rel_path)
        .and_then(|status| status.old_path))
}

fn detect_newline(value: &str) -> &'static str {
    if value.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

fn split_text_lines(value: &str) -> Vec<String> {
    if value.is_empty() {
        Vec::new()
    } else {
        value.lines().map(normalize_diff_line_content).collect()
    }
}

fn render_text_lines(lines: &[String], newline: &str, trailing_newline: bool) -> String {
    if lines.is_empty() {
        return String::new();
    }

    let mut rendered = lines.join(newline);
    if trailing_newline {
        rendered.push_str(newline);
    }
    rendered
}

#[derive(Debug, Clone)]
struct DiffChangeBlock {
    block_index: usize,
    line_start_index: usize,
    line_end_index: usize,
    new_range_start: usize,
    new_range_end: usize,
    replacement_lines: Vec<String>,
}

fn build_reverted_hunk_lines(hunk: &DiffHunk) -> Vec<String> {
    hunk.lines
        .iter()
        .filter_map(|line| match line.kind.as_str() {
            "context" | "delete" => Some(normalize_diff_line_content(&line.content)),
            _ => None,
        })
        .collect()
}

fn resolve_change_block_anchor_line(
    hunk: &DiffHunk,
    line_start_index: usize,
    line_end_index: usize,
) -> Option<usize> {
    for line in &hunk.lines[line_start_index..=line_end_index] {
        if let Some(old_lineno) = line.old_lineno {
            return Some(old_lineno as usize);
        }
    }

    for line in hunk.lines[..line_start_index].iter().rev() {
        if line.kind == "context" {
            return line.old_lineno.map(|value| value as usize);
        }
    }

    for line in &hunk.lines[line_end_index.saturating_add(1)..] {
        if line.kind == "context" {
            return line.old_lineno.map(|value| value as usize);
        }
    }

    None
}

fn build_change_blocks(hunk: &DiffHunk) -> Vec<DiffChangeBlock> {
    let mut blocks = Vec::new();
    let mut new_cursor = hunk.new_start as usize;
    let mut current_block_start: Option<usize> = None;
    let mut current_new_range_start = 0usize;
    let mut current_new_lines = 0usize;
    let mut current_replacement_lines: Vec<String> = Vec::new();

    for (line_index, line) in hunk.lines.iter().enumerate() {
        match line.kind.as_str() {
            "context" => {
                if let Some(block_start) = current_block_start {
                    let block_end = line_index.saturating_sub(1);
                    let block_index = blocks.len();
                    blocks.push(DiffChangeBlock {
                        block_index,
                        line_start_index: block_start,
                        line_end_index: block_end,
                        new_range_start: current_new_range_start,
                        new_range_end: current_new_range_start.saturating_add(current_new_lines),
                        replacement_lines: std::mem::take(&mut current_replacement_lines),
                    });
                    current_block_start = None;
                    current_new_lines = 0;
                }
                new_cursor = new_cursor.saturating_add(1);
            }
            "delete" => {
                if current_block_start.is_none() {
                    current_block_start = Some(line_index);
                    current_new_range_start = new_cursor.saturating_sub(1);
                }
                current_replacement_lines.push(normalize_diff_line_content(&line.content));
            }
            "add" => {
                if current_block_start.is_none() {
                    current_block_start = Some(line_index);
                    current_new_range_start = new_cursor.saturating_sub(1);
                }
                current_new_lines = current_new_lines.saturating_add(1);
                new_cursor = new_cursor.saturating_add(1);
            }
            _ => {}
        }
    }

    if let Some(block_start) = current_block_start {
        let block_index = blocks.len();
        blocks.push(DiffChangeBlock {
            block_index,
            line_start_index: block_start,
            line_end_index: hunk.lines.len().saturating_sub(1),
            new_range_start: current_new_range_start,
            new_range_end: current_new_range_start.saturating_add(current_new_lines),
            replacement_lines: current_replacement_lines,
        });
    }

    blocks
}

fn load_head_blame<'repo>(repo: &'repo Repository, rel_path: &str) -> Option<Blame<'repo>> {
    let head_oid = repo.head().ok().and_then(|head| head.target())?;
    let mut options = BlameOptions::new();
    options
        .newest_commit(head_oid)
        .track_copies_same_file(true)
        .track_copies_same_commit_moves(true)
        .track_copies_same_commit_copies(true);

    repo.blame_file(Path::new(rel_path), Some(&mut options))
        .ok()
}

fn build_git_blame_info(repo: &Repository, blame_hunk: &git2::BlameHunk<'_>) -> GitBlameInfo {
    let signature = blame_hunk.final_signature();
    let commit_id = blame_hunk.final_commit_id();
    let commit_summary = if commit_id.is_zero() {
        None
    } else {
        repo.find_commit(commit_id)
            .ok()
            .and_then(|commit| commit.summary().map(|value| value.to_string()))
    };

    GitBlameInfo {
        author_name: signature.name().unwrap_or("Unknown").to_string(),
        author_email: signature.email().map(|value| value.to_string()),
        author_time: signature.when().seconds(),
        commit_id: (!commit_id.is_zero()).then(|| commit_id.to_string()),
        summary: commit_summary,
        is_uncommitted: commit_id.is_zero(),
    }
}

fn build_uncommitted_blame_range(
    lines: &[String],
    start_line: usize,
    end_line: usize,
) -> GitBlameRange {
    GitBlameRange {
        start_line: start_line as u32,
        end_line: end_line as u32,
        lines: lines[(start_line - 1)..end_line].to_vec(),
        author: "Uncommitted".to_string(),
        timestamp: 0,
        commit_hash: String::new(),
        short_hash: String::new(),
        message: String::new(),
        is_uncommitted: true,
    }
}

fn annotate_change_blocks_with_blame(repo: &Repository, rel_path: &str, hunks: &mut [DiffHunk]) {
    let blame = match load_head_blame(repo, rel_path) {
        Some(blame) => blame,
        None => {
            for hunk in hunks {
                hunk.change_blocks = build_change_blocks(hunk)
                    .into_iter()
                    .map(|block| DiffChangeBlockInfo {
                        block_index: block.block_index,
                        line_start_index: block.line_start_index,
                        line_end_index: block.line_end_index,
                        blame: None,
                    })
                    .collect();
            }
            return;
        }
    };

    for hunk in hunks {
        hunk.change_blocks = build_change_blocks(hunk)
            .into_iter()
            .map(|block| {
                let blame_info = resolve_change_block_anchor_line(
                    hunk,
                    block.line_start_index,
                    block.line_end_index,
                )
                .and_then(|lineno| blame.get_line(lineno))
                .map(|blame_hunk| build_git_blame_info(repo, &blame_hunk));

                DiffChangeBlockInfo {
                    block_index: block.block_index,
                    line_start_index: block.line_start_index,
                    line_end_index: block.line_end_index,
                    blame: blame_info,
                }
            })
            .collect();
    }
}

fn write_restored_lines(
    abs_file: &Path,
    diff: &GitDiffResult,
    start: usize,
    end: usize,
    replacement: Vec<String>,
) -> Result<(), String> {
    let original_lines = split_text_lines(&diff.new_content);
    if end > original_lines.len() {
        return Err(restore_error(
            "RESTORE_PATCH_APPLY_FAILED",
            "target restore range is outside the current document",
        ));
    }

    let mut next_lines = Vec::with_capacity(
        original_lines
            .len()
            .saturating_sub(end.saturating_sub(start))
            + replacement.len(),
    );
    next_lines.extend_from_slice(&original_lines[..start]);
    next_lines.extend(replacement);
    next_lines.extend_from_slice(&original_lines[end..]);

    let newline = detect_newline(if diff.new_content.is_empty() {
        &diff.old_content
    } else {
        &diff.new_content
    });
    let original_had_trailing_newline =
        diff.new_content.ends_with('\n') || diff.new_content.ends_with("\r\n");
    let old_had_trailing_newline =
        diff.old_content.ends_with('\n') || diff.old_content.ends_with("\r\n");
    let target_has_trailing_newline = if end == original_lines.len() {
        old_had_trailing_newline
    } else {
        original_had_trailing_newline
    };

    let rendered = render_text_lines(&next_lines, newline, target_has_trailing_newline);
    std::fs::write(abs_file, rendered.as_bytes())
        .map_err(|error| restore_error("RESTORE_PATCH_APPLY_FAILED", error.to_string()))
}

#[tauri::command]
pub fn restore_git_file(
    project_path: String,
    file_path: String,
    status: GitStatus,
    old_file_path: Option<String>,
) -> Result<GitDiffResult, String> {
    if status == GitStatus::Conflicted {
        return Err(restore_error(
            "RESTORE_CONFLICTED_FILE",
            "conflicted files must be resolved manually",
        ));
    }

    let abs_file = resolve_workspace_file_path(&project_path, &file_path)?;
    let repo = discover_repo_for_path(&abs_file)?;
    let workdir = repo.workdir().ok_or("bare repository not supported")?;
    let rel_path = repo_relative_path(workdir, &abs_file)
        .map_err(|error| restore_error("RESTORE_OUTSIDE_PROJECT", error))?;
    let old_rel_path = if let Some(ref old_file_path) = old_file_path {
        let old_abs = resolve_workspace_file_path(&project_path, old_file_path)?;
        Some(
            repo_relative_path(workdir, &old_abs)
                .map_err(|error| restore_error("RESTORE_OUTSIDE_PROJECT", error))?,
        )
    } else {
        None
    };

    match status {
        GitStatus::Added | GitStatus::Untracked => {
            if abs_file.exists() {
                std::fs::remove_file(&abs_file).map_err(|error| {
                    restore_error("RESTORE_PATCH_APPLY_FAILED", error.to_string())
                })?;
            }
            remove_index_path(&repo, &rel_path)?;
        }
        GitStatus::Deleted | GitStatus::Modified => {
            reset_index_path_to_head(&repo, &rel_path)?;
            checkout_path_from_head(&repo, &rel_path)?;
        }
        GitStatus::Renamed => {
            let old_rel_path =
                discover_old_restore_path(&repo, &rel_path, old_rel_path.as_deref())?.ok_or_else(
                    || {
                        restore_error(
                            "RESTORE_FILE_NOT_FOUND",
                            "unable to resolve original path for renamed file",
                        )
                    },
                )?;

            if abs_file.exists() {
                std::fs::remove_file(&abs_file).map_err(|error| {
                    restore_error("RESTORE_PATCH_APPLY_FAILED", error.to_string())
                })?;
            }
            remove_index_path(&repo, &rel_path)?;
            reset_index_path_to_head(&repo, &old_rel_path)?;
            checkout_path_from_head(&repo, &old_rel_path)?;

            return Ok(build_worktree_diff_result(
                String::new(),
                String::new(),
                Vec::new(),
                false,
                false,
                Some(&status),
            ));
        }
        GitStatus::Conflicted => unreachable!(),
    }

    load_worktree_diff(
        &project_path,
        &file_path,
        old_file_path.as_deref(),
        Some(&status),
    )
}

#[tauri::command]
pub fn restore_git_hunk(
    project_path: String,
    file_path: String,
    hunk_key: String,
    status: GitStatus,
    old_file_path: Option<String>,
) -> Result<GitDiffResult, String> {
    if !matches!(status, GitStatus::Modified | GitStatus::Renamed) {
        return Err(restore_error(
            "RESTORE_UNSUPPORTED_STATUS",
            "partial restore is only supported for modified and renamed files",
        ));
    }

    let diff = load_worktree_diff(
        &project_path,
        &file_path,
        old_file_path.as_deref(),
        Some(&status),
    )?;

    if !diff.can_restore_partial {
        return Err(restore_error(
            "RESTORE_UNSUPPORTED_STATUS",
            "this diff does not support hunk restore",
        ));
    }

    let hunk = diff
        .hunks
        .iter()
        .find(|candidate| candidate.hunk_key == hunk_key)
        .ok_or_else(|| restore_error("RESTORE_HUNK_NOT_FOUND", "target hunk was not found"))?;

    let abs_file = resolve_workspace_file_path(&project_path, &file_path)?;
    let start = hunk.new_start.saturating_sub(1) as usize;
    let end = start.saturating_add(hunk.new_lines as usize);
    let replacement = build_reverted_hunk_lines(hunk);
    write_restored_lines(&abs_file, &diff, start, end, replacement)?;

    load_worktree_diff(
        &project_path,
        &file_path,
        old_file_path.as_deref(),
        Some(&status),
    )
}

#[tauri::command]
pub fn restore_git_change_block(
    project_path: String,
    file_path: String,
    hunk_key: String,
    block_index: usize,
    status: GitStatus,
    old_file_path: Option<String>,
) -> Result<GitDiffResult, String> {
    if !matches!(status, GitStatus::Modified | GitStatus::Renamed) {
        return Err(restore_error(
            "RESTORE_UNSUPPORTED_STATUS",
            "partial restore is only supported for modified and renamed files",
        ));
    }

    let diff = load_worktree_diff(
        &project_path,
        &file_path,
        old_file_path.as_deref(),
        Some(&status),
    )?;

    if !diff.can_restore_partial {
        return Err(restore_error(
            "RESTORE_UNSUPPORTED_STATUS",
            "this diff does not support partial restore",
        ));
    }

    let hunk = diff
        .hunks
        .iter()
        .find(|candidate| candidate.hunk_key == hunk_key)
        .ok_or_else(|| restore_error("RESTORE_HUNK_NOT_FOUND", "target hunk was not found"))?;

    let change_block = build_change_blocks(hunk)
        .into_iter()
        .nth(block_index)
        .ok_or_else(|| {
            restore_error(
                "RESTORE_CHANGE_BLOCK_NOT_FOUND",
                "target change block was not found",
            )
        })?;

    let abs_file = resolve_workspace_file_path(&project_path, &file_path)?;
    write_restored_lines(
        &abs_file,
        &diff,
        change_block.new_range_start,
        change_block.new_range_end,
        change_block.replacement_lines,
    )?;

    load_worktree_diff(
        &project_path,
        &file_path,
        old_file_path.as_deref(),
        Some(&status),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{IndexAddOption, Signature};
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    struct TestRepo {
        root: PathBuf,
    }

    impl TestRepo {
        fn new() -> Self {
            let unique = format!(
                "mini-term-git-test-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            );
            let root = std::env::temp_dir().join(unique);
            fs::create_dir_all(&root).unwrap();
            let repo = Repository::init(&root).unwrap();
            let mut config = repo.config().unwrap();
            config.set_str("user.name", "MiniTerm").unwrap();
            config
                .set_str("user.email", "mini-term@example.com")
                .unwrap();
            Self { root }
        }

        fn repo(&self) -> Repository {
            Repository::open(&self.root).unwrap()
        }

        fn path(&self, rel: &str) -> PathBuf {
            self.root.join(rel)
        }

        fn write_file(&self, rel: &str, content: &str) {
            let path = self.path(rel);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(path, content).unwrap();
        }

        fn remove_file(&self, rel: &str) {
            fs::remove_file(self.path(rel)).unwrap();
        }

        fn rename_file(&self, from: &str, to: &str) {
            let to_path = self.path(to);
            if let Some(parent) = to_path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::rename(self.path(from), to_path).unwrap();
        }

        fn commit_all(&self, message: &str) {
            let repo = self.repo();
            let mut index = repo.index().unwrap();
            index
                .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
                .unwrap();
            index.write().unwrap();
            let tree_id = index.write_tree().unwrap();
            let tree = repo.find_tree(tree_id).unwrap();
            let signature = Signature::now("MiniTerm", "mini-term@example.com").unwrap();
            let parent = repo
                .head()
                .ok()
                .and_then(|head| head.target())
                .and_then(|oid| repo.find_commit(oid).ok());

            if let Some(parent) = parent.as_ref() {
                repo.commit(
                    Some("HEAD"),
                    &signature,
                    &signature,
                    message,
                    &tree,
                    &[parent],
                )
                .unwrap();
            } else {
                repo.commit(Some("HEAD"), &signature, &signature, message, &tree, &[])
                    .unwrap();
            }
        }

        fn commit_rename(&self, from: &str, to: &str, message: &str) {
            let repo = self.repo();
            let mut index = repo.index().unwrap();
            index.remove_path(Path::new(from)).unwrap();
            index.add_path(Path::new(to)).unwrap();
            index.write().unwrap();
            let tree_id = index.write_tree().unwrap();
            let tree = repo.find_tree(tree_id).unwrap();
            let signature = Signature::now("MiniTerm", "mini-term@example.com").unwrap();
            let parent = repo
                .head()
                .ok()
                .and_then(|head| head.target())
                .and_then(|oid| repo.find_commit(oid).ok())
                .unwrap();

            repo.commit(
                Some("HEAD"),
                &signature,
                &signature,
                message,
                &tree,
                &[&parent],
            )
            .unwrap();
        }
    }

    impl Drop for TestRepo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn get_git_diff_reports_restore_capabilities_for_modified_files() {
        let repo = TestRepo::new();
        repo.write_file("src/main.ts", "line 1\nline 2\nline 3\n");
        repo.commit_all("initial");
        repo.write_file("src/main.ts", "line 1\nline 2 changed\nline 3\n");

        let diff = get_git_diff(
            repo.root.to_string_lossy().to_string(),
            "src/main.ts".to_string(),
            None,
            Some(GitStatus::Modified),
        )
        .unwrap();

        assert!(diff.can_restore_file);
        assert!(diff.can_restore_partial);
        assert_eq!(diff.restore_mode, GitRestoreMode::FileAndHunk);
        assert_eq!(diff.hunks.len(), 1);
        assert!(!diff.hunks[0].hunk_key.is_empty());
        assert_eq!(diff.hunks[0].change_blocks.len(), 1);
        assert_eq!(
            diff.hunks[0].change_blocks[0]
                .blame
                .as_ref()
                .map(|value| value.author_name.as_str()),
            Some("MiniTerm")
        );
    }

    #[test]
    fn restore_git_file_removes_untracked_file() {
        let repo = TestRepo::new();
        repo.write_file("tracked.txt", "tracked\n");
        repo.commit_all("initial");
        repo.write_file("scratch.txt", "scratch\n");

        let result = restore_git_file(
            repo.root.to_string_lossy().to_string(),
            "scratch.txt".to_string(),
            GitStatus::Untracked,
            None,
        )
        .unwrap();

        assert!(!repo.path("scratch.txt").exists());
        assert!(result.diff_cleared);
        assert!(result.hunks.is_empty());
    }

    #[test]
    fn restore_git_file_restores_deleted_file() {
        let repo = TestRepo::new();
        repo.write_file("deleted.txt", "before\n");
        repo.commit_all("initial");
        repo.remove_file("deleted.txt");

        let result = restore_git_file(
            repo.root.to_string_lossy().to_string(),
            "deleted.txt".to_string(),
            GitStatus::Deleted,
            None,
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(repo.path("deleted.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "before\n"
        );
        assert!(result.diff_cleared);
    }

    #[test]
    fn restore_git_hunk_reverts_only_the_selected_hunk() {
        let repo = TestRepo::new();
        repo.write_file(
            "src/app.ts",
            "one\ncontext a\ncontext b\ncontext c\ncontext d\ncontext e\ncontext f\ncontext g\nseven\n",
        );
        repo.commit_all("initial");
        repo.write_file(
            "src/app.ts",
            "ONE\ncontext a\ncontext b\ncontext c\ncontext d\ncontext e\ncontext f\ncontext g\nSEVEN\n",
        );

        let before = get_git_diff(
            repo.root.to_string_lossy().to_string(),
            "src/app.ts".to_string(),
            None,
            Some(GitStatus::Modified),
        )
        .unwrap();
        assert!(before.hunks.len() >= 2);

        let result = restore_git_hunk(
            repo.root.to_string_lossy().to_string(),
            "src/app.ts".to_string(),
            before.hunks[0].hunk_key.clone(),
            GitStatus::Modified,
            None,
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(repo.path("src/app.ts")).unwrap(),
            "one\ncontext a\ncontext b\ncontext c\ncontext d\ncontext e\ncontext f\ncontext g\nSEVEN\n"
        );
        assert_eq!(result.hunks.len(), 1);
    }

    #[test]
    fn restore_git_change_block_reverts_only_the_selected_block() {
        let repo = TestRepo::new();
        repo.write_file("src/app.ts", "alpha\nsame one\nbeta\nsame two\ngamma\n");
        repo.commit_all("initial");
        repo.write_file("src/app.ts", "ALPHA\nsame one\nBETA\nsame two\ngamma\n");

        let before = get_git_diff(
            repo.root.to_string_lossy().to_string(),
            "src/app.ts".to_string(),
            None,
            Some(GitStatus::Modified),
        )
        .unwrap();

        assert_eq!(before.hunks.len(), 1);
        assert_eq!(build_change_blocks(&before.hunks[0]).len(), 2);

        let result = restore_git_change_block(
            repo.root.to_string_lossy().to_string(),
            "src/app.ts".to_string(),
            before.hunks[0].hunk_key.clone(),
            0,
            GitStatus::Modified,
            None,
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(repo.path("src/app.ts")).unwrap(),
            "alpha\nsame one\nBETA\nsame two\ngamma\n"
        );
        assert_eq!(result.hunks.len(), 1);
    }

    #[test]
    fn git_stage_rejects_paths_outside_repository_workdir() {
        let repo = TestRepo::new();
        let outside = std::env::temp_dir().join(format!(
            "mini-term-git-outside-stage-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::write(&outside, "outside\n").unwrap();

        let error = git_stage(
            repo.root.to_string_lossy().to_string(),
            vec![outside.to_string_lossy().to_string()],
        )
        .unwrap_err();

        assert_eq!(error, "path is outside repository worktree");
        let _ = fs::remove_file(outside);
    }

    #[test]
    fn git_discard_file_rejects_paths_outside_repository_workdir() {
        let repo = TestRepo::new();
        let outside = std::env::temp_dir().join(format!(
            "mini-term-git-outside-discard-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::write(&outside, "outside\n").unwrap();

        let error = git_discard_file(
            repo.root.to_string_lossy().to_string(),
            vec![outside.to_string_lossy().to_string()],
        )
        .unwrap_err();

        assert_eq!(error, "path is outside repository worktree");
        let _ = fs::remove_file(outside);
    }

    #[test]
    fn git_commit_accepts_dash_prefixed_message_and_discovers_repo_from_subdir() {
        let repo = TestRepo::new();
        repo.write_file("nested/file.txt", "hello\n");
        git_stage_all(repo.root.to_string_lossy().to_string()).unwrap();

        let nested = repo.path("nested");
        git_commit(
            nested.to_string_lossy().to_string(),
            "-dash prefixed message".to_string(),
        )
        .unwrap();

        let repository = repo.repo();
        let head = repository.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.message(), Some("-dash prefixed message\n"));
    }

    #[test]
    fn restore_git_hunk_rejects_unknown_hunk_keys() {
        let repo = TestRepo::new();
        repo.write_file("src/app.ts", "before\n");
        repo.commit_all("initial");
        repo.write_file("src/app.ts", "after\n");

        let error = restore_git_hunk(
            repo.root.to_string_lossy().to_string(),
            "src/app.ts".to_string(),
            "missing".to_string(),
            GitStatus::Modified,
            None,
        )
        .unwrap_err();

        assert!(error.starts_with("RESTORE_HUNK_NOT_FOUND"));
    }

    #[test]
    fn restore_git_change_block_rejects_unknown_block_indexes() {
        let repo = TestRepo::new();
        repo.write_file("src/app.ts", "before\n");
        repo.commit_all("initial");
        repo.write_file("src/app.ts", "after\n");

        let diff = get_git_diff(
            repo.root.to_string_lossy().to_string(),
            "src/app.ts".to_string(),
            None,
            Some(GitStatus::Modified),
        )
        .unwrap();

        let error = restore_git_change_block(
            repo.root.to_string_lossy().to_string(),
            "src/app.ts".to_string(),
            diff.hunks[0].hunk_key.clone(),
            99,
            GitStatus::Modified,
            None,
        )
        .unwrap_err();

        assert!(error.starts_with("RESTORE_CHANGE_BLOCK_NOT_FOUND"));
    }

    #[test]
    fn renamed_files_only_allow_partial_restore_when_content_changes() {
        let repo = TestRepo::new();
        repo.write_file("src/original.ts", "before\n");
        repo.commit_all("initial");
        repo.rename_file("src/original.ts", "src/renamed.ts");

        let renamed_only = get_git_diff(
            repo.root.to_string_lossy().to_string(),
            "src/renamed.ts".to_string(),
            Some("src/original.ts".to_string()),
            Some(GitStatus::Renamed),
        )
        .unwrap();
        assert!(renamed_only.can_restore_file);
        assert!(!renamed_only.can_restore_partial);

        repo.write_file("src/renamed.ts", "after\n");
        let renamed_with_changes = get_git_diff(
            repo.root.to_string_lossy().to_string(),
            "src/renamed.ts".to_string(),
            Some("src/original.ts".to_string()),
            Some(GitStatus::Renamed),
        )
        .unwrap();
        assert!(renamed_with_changes.can_restore_partial);
    }

    #[test]
    fn get_file_git_history_follows_renames() {
        let repo = TestRepo::new();
        repo.write_file("src/original.ts", "one\n");
        repo.commit_all("initial");
        repo.rename_file("src/original.ts", "src/renamed.ts");
        repo.commit_rename("src/original.ts", "src/renamed.ts", "rename file");
        repo.write_file("src/renamed.ts", "two\n");
        repo.commit_all("update renamed");

        let result = get_file_git_history(
            repo.root.to_string_lossy().to_string(),
            repo.path("src/renamed.ts").to_string_lossy().to_string(),
            None,
            Some(10),
        )
        .unwrap();

        assert_eq!(result.entries.len(), 3);
        assert_eq!(result.entries[0].message, "update renamed");
        assert_eq!(result.entries[0].path, "src/renamed.ts");
        assert_eq!(result.entries[1].message, "rename file");
        assert_eq!(result.entries[1].path, "src/renamed.ts");
        assert_eq!(
            result.entries[1].old_path.as_deref(),
            Some("src/original.ts")
        );
        assert_eq!(result.entries[2].message, "initial");
        assert_eq!(result.entries[2].path, "src/original.ts");
    }

    #[test]
    fn get_file_git_blame_returns_grouped_ranges() {
        let repo = TestRepo::new();
        repo.write_file("src/app.ts", "line 1\nline 2\nline 3\nline 4\n");
        repo.commit_all("initial");
        repo.write_file("src/app.ts", "line 1\nline 2\nLINE 3\nLINE 4\n");
        repo.commit_all("update tail");

        let result = get_file_git_blame(
            repo.root.to_string_lossy().to_string(),
            repo.path("src/app.ts").to_string_lossy().to_string(),
        )
        .unwrap();

        assert!(!result.is_binary);
        assert!(!result.too_large);
        assert!(result.ranges.len() >= 2);
        assert_eq!(result.ranges[0].start_line, 1);
        assert!(result
            .ranges
            .iter()
            .any(|range| range.message == "initial" && range.start_line == 1));
        assert!(result
            .ranges
            .iter()
            .any(|range| range.message == "update tail" && range.start_line >= 3));
    }

    #[test]
    fn get_file_git_blame_handles_uncommitted_changes() {
        let repo = TestRepo::new();
        repo.write_file("src/app.ts", "line 1\nline 2\n");
        repo.commit_all("initial");
        repo.write_file("src/app.ts", "line 1\nline 2 changed\nline 3 new\n");

        let result = get_file_git_blame(
            repo.root.to_string_lossy().to_string(),
            repo.path("src/app.ts").to_string_lossy().to_string(),
        )
        .unwrap();

        assert!(!result.is_binary);
        assert!(!result.too_large);
        assert!(!result.ranges.is_empty());
        assert!(result.ranges.iter().any(|range| range.is_uncommitted));
    }
}
