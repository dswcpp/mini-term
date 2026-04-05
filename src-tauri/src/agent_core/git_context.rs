use super::models::{GitSummary, ReviewDiffResult};
use crate::git::{get_git_diff, get_git_status};

pub fn get_git_summary(project_path: &str) -> Result<GitSummary, String> {
    let changed_files = get_git_status(project_path.to_string())?;
    Ok(GitSummary {
        repo_count: if changed_files.is_empty() { 0 } else { 1 },
        changed_files,
    })
}

pub fn get_diff_for_review(
    project_path: &str,
    file_path: &str,
) -> Result<ReviewDiffResult, String> {
    Ok(ReviewDiffResult {
        file_path: file_path.to_string(),
        diff: get_git_diff(project_path.to_string(), file_path.to_string(), None, None)?,
    })
}
