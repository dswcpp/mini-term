use crate::ai_sessions::AiSession;
use crate::config::WorkspaceConfig;
use crate::fs::FileContentResult;
use crate::git::{GitDiffResult, GitFileStatus};
use serde::{Deserialize, Serialize};

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TaskTarget {
    Codex,
    Claude,
}

impl TaskTarget {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TaskContextPreset {
    Light,
    Standard,
    Review,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TaskAttentionState {
    Running,
    WaitingInput,
    NeedsReview,
    Failed,
    Completed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalRiskLevel {
    Medium,
    High,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalDecision {
    Pending,
    Approved,
    Rejected,
    Executed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TaskArtifactKind {
    Plan,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskArtifact {
    pub artifact_id: String,
    pub kind: TaskArtifactKind,
    pub title: String,
    pub path: String,
    pub mime_type: String,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSummary {
    pub task_id: String,
    pub workspace_id: String,
    pub workspace_name: String,
    pub workspace_root_path: String,
    pub target: TaskTarget,
    pub title: String,
    pub status: String,
    pub attention_state: TaskAttentionState,
    pub session_id: String,
    pub cwd: String,
    pub started_at: u64,
    pub updated_at: u64,
    pub completed_at: Option<u64>,
    pub exit_code: Option<i32>,
    pub context_preset: TaskContextPreset,
    pub changed_files: Vec<GitFileStatus>,
    pub prompt_preview: String,
    pub last_output_excerpt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub injection_profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub injection_preset: Option<TaskContextPreset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy_summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub termination_cause: Option<TaskTerminationCause>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatusDetail {
    pub summary: TaskSummary,
    pub recent_output_excerpt: String,
    pub diff_summary: Vec<GitFileStatus>,
    pub log_path: String,
    #[serde(default)]
    pub artifacts: Vec<TaskArtifact>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    pub request_id: String,
    pub tool_name: String,
    pub reason: String,
    pub risk_level: ApprovalRiskLevel,
    pub payload_preview: String,
    pub status: ApprovalDecision,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkspaceSummary {
    pub workspace_id: String,
    pub name: String,
    pub root_paths: Vec<String>,
    pub primary_root_path: Option<String>,
}

impl From<&WorkspaceConfig> for AgentWorkspaceSummary {
    fn from(value: &WorkspaceConfig) -> Self {
        let primary_root = value
            .roots
            .iter()
            .find(|root| root.role == "primary")
            .or_else(|| value.roots.first());
        Self {
            workspace_id: value.id.clone(),
            name: value.name.clone(),
            root_paths: value
                .roots
                .iter()
                .map(|root| display_path_string(&root.path))
                .collect(),
            primary_root_path: primary_root.map(|root| display_path_string(&root.path)),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSummary {
    pub repo_count: usize,
    pub changed_files: Vec<GitFileStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextDocument {
    pub path: String,
    pub label: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContextResult {
    pub workspace: AgentWorkspaceSummary,
    pub preset: TaskContextPreset,
    pub instructions: Vec<ContextDocument>,
    pub git_summary: GitSummary,
    pub recent_sessions: Vec<AiSession>,
    pub related_files: Vec<ContextDocument>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFileMatch {
    pub path: String,
    pub line: usize,
    pub line_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartTaskInput {
    pub workspace_id: String,
    pub target: TaskTarget,
    pub prompt: String,
    pub context_preset: TaskContextPreset,
    pub cwd: Option<String>,
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingApprovalResult {
    pub approval_required: bool,
    pub request: ApprovalRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentActionResult<T> {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(default)]
    pub approval_required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<ApprovalRequest>,
}

impl<T> AgentActionResult<T> {
    pub fn success(data: T) -> Self {
        Self {
            ok: true,
            data: Some(data),
            approval_required: false,
            request: None,
        }
    }

    pub fn approval_required(request: ApprovalRequest) -> Self {
        Self {
            ok: false,
            data: None,
            approval_required: true,
            request: Some(request),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TaskTerminationCause {
    ManualClose,
    ProcessExit,
    StartupFailed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileResult {
    pub path: String,
    #[serde(flatten)]
    pub file: FileContentResult,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDiffResult {
    pub file_path: String,
    pub diff: GitDiffResult,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedWorkspacePath {
    pub workspace_id: String,
    pub workspace_name: String,
    pub root_path: String,
    pub requested_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedWorkspaceCommand {
    pub workspace_id: String,
    pub workspace_name: String,
    pub workspace_path: String,
    pub command: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedTaskWorkingDirectory {
    pub workspace_id: String,
    pub workspace_name: String,
    pub workspace_root_path: String,
    pub cwd: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn workspace_summary_normalizes_windows_paths() {
        let workspace = WorkspaceConfig {
            id: "workspace-1".into(),
            name: "mini-term".into(),
            roots: vec![crate::config::WorkspaceRootConfig {
                id: "root-1".into(),
                name: "root".into(),
                path: r"\\?\C:/code/mini-term".into(),
                role: "primary".into(),
            }],
            pinned: false,
            accent: None,
            saved_layout: None,
            expanded_dirs_by_root: Default::default(),
            created_at: 1,
            last_opened_at: 1,
        };

        let summary = AgentWorkspaceSummary::from(&workspace);
        assert_eq!(
            summary.primary_root_path.as_deref(),
            Some(r"C:\code\mini-term")
        );
        assert_eq!(summary.root_paths, vec![r"C:\code\mini-term".to_string()]);
    }
}
