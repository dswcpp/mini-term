use super::data_dir::config_path;
use super::git_context::get_git_summary;
use super::models::{
    AgentWorkspaceSummary, ContextDocument, ResolvedWorkspacePath, TaskContextPreset,
    ValidatedTaskWorkingDirectory, ValidatedWorkspaceCommand, WorkspaceContextResult,
};
use crate::ai_sessions::get_ai_sessions;
use crate::config::{load_config_from_path, WorkspaceConfig};
use std::fs;
use std::path::{Component, Path, PathBuf};

fn find_workspace<'a>(
    workspaces: &'a [WorkspaceConfig],
    workspace_id: &str,
) -> Option<&'a WorkspaceConfig> {
    workspaces
        .iter()
        .find(|workspace| workspace.id == workspace_id)
}

fn canonicalize_existing(path: &Path) -> Result<PathBuf, String> {
    fs::canonicalize(path).map_err(|err| err.to_string())
}

fn canonicalize_for_write(path: &Path) -> Result<PathBuf, String> {
    if path.exists() {
        return canonicalize_existing(path);
    }

    let parent = path.parent().ok_or("path has no parent")?;
    let canonical_parent = canonicalize_existing(parent)?;
    let file_name = path.file_name().ok_or("path has no file name")?;
    Ok(canonical_parent.join(file_name))
}

fn display_path_string(path: &str) -> String {
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

fn display_path(path: &Path) -> String {
    display_path_string(path.to_string_lossy().as_ref())
}

fn has_parent_traversal(path: &Path) -> bool {
    path.components()
        .any(|component| matches!(component, Component::ParentDir))
}

fn resolve_workspace_path_in_workspaces(
    workspaces: &[WorkspaceConfig],
    requested_path: &Path,
    allow_missing_leaf: bool,
) -> Result<ResolvedWorkspacePath, String> {
    let normalized_requested = if allow_missing_leaf {
        canonicalize_for_write(requested_path)?
    } else {
        canonicalize_existing(requested_path)?
    };

    for workspace in workspaces {
        for root in &workspace.roots {
            let Ok(root_path) = canonicalize_existing(Path::new(&root.path)) else {
                continue;
            };

            if normalized_requested.starts_with(&root_path) {
                return Ok(ResolvedWorkspacePath {
                    workspace_id: workspace.id.clone(),
                    workspace_name: workspace.name.clone(),
                    root_path: display_path(&root_path),
                    requested_path: display_path(&normalized_requested),
                });
            }
        }
    }

    Err("workspace path is outside configured roots".to_string())
}

fn collect_instruction_file(path: PathBuf, label: &str, documents: &mut Vec<ContextDocument>) {
    let Ok(content) = fs::read_to_string(&path) else {
        return;
    };
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return;
    }
    documents.push(ContextDocument {
        path: display_path(&path),
        label: label.to_string(),
        content: trimmed.chars().take(16_000).collect(),
    });
}

fn collect_instruction_docs(root: &Path) -> Vec<ContextDocument> {
    let mut documents = Vec::new();
    collect_instruction_file(root.join("AGENTS.md"), "AGENTS", &mut documents);
    collect_instruction_file(root.join("CLAUDE.md"), "CLAUDE", &mut documents);
    collect_instruction_file(root.join("CODEX.md"), "CODEX", &mut documents);
    documents
}

fn collect_related_files(root: &Path, preset: &TaskContextPreset) -> Vec<ContextDocument> {
    if matches!(preset, TaskContextPreset::Light) {
        return Vec::new();
    }

    let candidates = [
        root.join("README.md"),
        root.join("package.json"),
        root.join("Cargo.toml"),
    ];
    let mut related = Vec::new();
    for path in candidates {
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        related.push(ContextDocument {
            path: display_path(&path),
            label: path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("context")
                .to_string(),
            content: content.chars().take(8_000).collect(),
        });
    }
    related
}

pub fn list_workspaces() -> Vec<AgentWorkspaceSummary> {
    let config = load_config_from_path(&config_path());
    config
        .workspaces
        .iter()
        .map(AgentWorkspaceSummary::from)
        .collect()
}

pub fn resolve_workspace_path(path: &str) -> Result<ResolvedWorkspacePath, String> {
    let config = load_config_from_path(&config_path());
    resolve_workspace_path_in_workspaces(&config.workspaces, Path::new(path), false)
}

pub fn resolve_workspace_path_for_write(path: &str) -> Result<ResolvedWorkspacePath, String> {
    let config = load_config_from_path(&config_path());
    resolve_workspace_path_in_workspaces(&config.workspaces, Path::new(path), true)
}

pub fn validate_workspace_command_target(
    workspace_path: &str,
    command: &str,
) -> Result<ValidatedWorkspaceCommand, String> {
    if command.trim().is_empty() {
        return Err("command is required".to_string());
    }

    let path = Path::new(workspace_path);
    if !path.is_dir() {
        return Err("workspace path must be an existing directory".to_string());
    }

    let resolved = resolve_workspace_path(workspace_path)?;

    Ok(ValidatedWorkspaceCommand {
        workspace_id: resolved.workspace_id,
        workspace_name: resolved.workspace_name,
        workspace_path: resolved.requested_path,
        command: command.trim().to_string(),
    })
}

pub fn validate_task_working_directory(
    workspace_id: &str,
    cwd: Option<&str>,
) -> Result<ValidatedTaskWorkingDirectory, String> {
    let config = load_config_from_path(&config_path());
    validate_task_working_directory_in_workspaces(&config.workspaces, workspace_id, cwd)
}

fn validate_task_working_directory_in_workspaces(
    workspaces: &[WorkspaceConfig],
    workspace_id: &str,
    cwd: Option<&str>,
) -> Result<ValidatedTaskWorkingDirectory, String> {
    let workspace = find_workspace(workspaces, workspace_id)
        .ok_or_else(|| format!("workspace not found: {workspace_id}"))?;

    let primary_root = workspace
        .roots
        .iter()
        .find(|root| root.role == "primary")
        .or_else(|| workspace.roots.first())
        .ok_or("workspace has no roots")?;

    let canonical_primary_root = canonicalize_existing(Path::new(&primary_root.path))?;
    if !canonical_primary_root.is_dir() {
        return Err("workspace root must be an existing directory".to_string());
    }

    if let Some(cwd) = cwd.filter(|value| !value.trim().is_empty()) {
        let canonical_cwd = canonicalize_existing(Path::new(cwd))?;
        if !canonical_cwd.is_dir() {
            return Err("task cwd must be an existing directory".to_string());
        }

        for root in &workspace.roots {
            let canonical_root = canonicalize_existing(Path::new(&root.path))?;
            if canonical_cwd.starts_with(&canonical_root) {
                return Ok(ValidatedTaskWorkingDirectory {
                    workspace_id: workspace.id.clone(),
                    workspace_name: workspace.name.clone(),
                    workspace_root_path: display_path(&canonical_root),
                    cwd: display_path(&canonical_cwd),
                });
            }
        }

        return Err("task cwd must stay inside the selected workspace".to_string());
    }

    Ok(ValidatedTaskWorkingDirectory {
        workspace_id: workspace.id.clone(),
        workspace_name: workspace.name.clone(),
        workspace_root_path: display_path(&canonical_primary_root),
        cwd: display_path(&canonical_primary_root),
    })
}

pub fn get_workspace_context(
    workspace_id: &str,
    preset: TaskContextPreset,
) -> Result<WorkspaceContextResult, String> {
    let config = load_config_from_path(&config_path());
    let workspace = find_workspace(&config.workspaces, workspace_id)
        .ok_or_else(|| format!("workspace not found: {workspace_id}"))?;
    let summary = AgentWorkspaceSummary::from(workspace);
    let root_path = summary
        .primary_root_path
        .clone()
        .or_else(|| summary.root_paths.first().cloned())
        .ok_or("workspace has no roots")?;

    let recent_sessions = get_ai_sessions(summary.root_paths.clone())?
        .into_iter()
        .take(10)
        .collect();
    let git_summary = get_git_summary(&root_path)?;
    let instructions = collect_instruction_docs(Path::new(&root_path));
    let related_files = collect_related_files(Path::new(&root_path), &preset);

    Ok(WorkspaceContextResult {
        workspace: summary,
        preset,
        instructions,
        git_summary,
        recent_sessions,
        related_files,
    })
}

pub fn validate_workspace_relative_file_path(
    project_path: &str,
    file_path: &str,
) -> Result<String, String> {
    if file_path.trim().is_empty() {
        return Err("filePath is required".to_string());
    }

    let requested = Path::new(file_path);
    if requested.is_absolute() {
        resolve_workspace_path(file_path)?;
        let project_root = canonicalize_existing(Path::new(project_path))?;
        let resolved_file = canonicalize_existing(Path::new(file_path))?;
        let relative = resolved_file
            .strip_prefix(project_root)
            .map_err(|_| "file path must be inside project path".to_string())?;
        return Ok(relative.to_string_lossy().replace('\\', "/"));
    }

    if has_parent_traversal(requested) {
        return Err("file path must not escape the project path".to_string());
    }

    Ok(requested.to_string_lossy().replace('\\', "/"))
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
        let path = std::env::temp_dir().join(format!("mini-term-workspace-{label}-{unique}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn test_workspace(root: &Path) -> WorkspaceConfig {
        WorkspaceConfig {
            id: "workspace-1".into(),
            name: "mini-term".into(),
            roots: vec![crate::config::WorkspaceRootConfig {
                id: "root-1".into(),
                name: "root".into(),
                path: root.to_string_lossy().to_string(),
                role: "primary".into(),
            }],
            pinned: false,
            accent: None,
            saved_layout: None,
            expanded_dirs_by_root: Default::default(),
            created_at: 1,
            last_opened_at: 1,
        }
    }

    #[test]
    fn resolves_existing_file_inside_workspace() {
        let root = unique_temp_dir("resolve-file");
        let file = root.join("README.md");
        fs::write(&file, "demo").unwrap();
        let resolved =
            resolve_workspace_path_in_workspaces(&[test_workspace(&root)], &file, false).unwrap();
        let canonical_root = fs::canonicalize(&root).unwrap();
        let canonical_file = fs::canonicalize(&file).unwrap();

        assert_eq!(resolved.workspace_id, "workspace-1");
        assert_eq!(resolved.root_path, display_path(&canonical_root));
        assert_eq!(resolved.requested_path, display_path(&canonical_file));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn resolves_new_file_inside_workspace_for_write() {
        let root = unique_temp_dir("resolve-write");
        let file = root.join("notes").join("plan.md");
        fs::create_dir_all(file.parent().unwrap()).unwrap();

        let resolved =
            resolve_workspace_path_in_workspaces(&[test_workspace(&root)], &file, true).unwrap();
        assert!(resolved.requested_path.ends_with("plan.md"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_path_outside_workspace() {
        let root = unique_temp_dir("resolve-reject-root");
        let outside = unique_temp_dir("resolve-reject-outside");
        let file = outside.join("README.md");
        fs::write(&file, "demo").unwrap();

        let error = resolve_workspace_path_in_workspaces(&[test_workspace(&root)], &file, false)
            .unwrap_err();
        assert_eq!(error, "workspace path is outside configured roots");

        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn rejects_parent_traversal_relative_file_path() {
        let error =
            validate_workspace_relative_file_path("D:/code/JavaScript/mini-term", "../secret.txt")
                .unwrap_err();
        assert_eq!(error, "file path must not escape the project path");
    }

    #[test]
    fn validates_task_working_directory_for_workspace_root_and_subdir() {
        let root = unique_temp_dir("task-cwd-root");
        let nested = root.join("packages").join("app");
        fs::create_dir_all(&nested).unwrap();
        let workspaces = vec![test_workspace(&root)];

        let default_cwd =
            validate_task_working_directory_in_workspaces(&workspaces, "workspace-1", None)
                .unwrap();
        assert_eq!(
            default_cwd.workspace_root_path,
            display_path(&fs::canonicalize(&root).unwrap())
        );
        assert_eq!(default_cwd.cwd, default_cwd.workspace_root_path);

        let nested_cwd = validate_task_working_directory_in_workspaces(
            &workspaces,
            "workspace-1",
            Some(&nested.to_string_lossy()),
        )
        .unwrap();
        assert_eq!(
            nested_cwd.cwd,
            display_path(&fs::canonicalize(&nested).unwrap())
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_task_working_directory_outside_workspace() {
        let root = unique_temp_dir("task-cwd-outside-root");
        let outside = unique_temp_dir("task-cwd-outside-target");
        let workspaces = vec![test_workspace(&root)];

        let error = validate_task_working_directory_in_workspaces(
            &workspaces,
            "workspace-1",
            Some(&outside.to_string_lossy()),
        )
        .unwrap_err();
        assert_eq!(error, "task cwd must stay inside the selected workspace");

        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }

    #[cfg(windows)]
    #[test]
    fn display_path_string_strips_windows_verbatim_prefix() {
        assert_eq!(
            display_path_string(r"\\?\C:\code\mini-term\package.json"),
            r"C:\code\mini-term\package.json"
        );
        assert_eq!(
            display_path_string(r"C:/code/mini-term/AGENTS.md"),
            r"C:\code\mini-term\AGENTS.md"
        );
        assert_eq!(
            display_path_string(r"\\?\UNC\server\share\repo"),
            r"\\server\share\repo"
        );
    }
}
