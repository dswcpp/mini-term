use crate::agent_ext::mcp_interop::{ExternalMcpCatalog, ExternalMcpSyncResult};
use crate::agent_ext::model_gateway::{ModelGatewayProviderKind, PROVIDER_KIND_REFERENCE};
use crate::agent_policy::AgentPoliciesConfig;
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ProjectTreeItem {
    ProjectId(String),
    Group(ProjectGroup),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGroup {
    pub id: String,
    pub name: String,
    pub collapsed: bool,
    pub children: Vec<ProjectTreeItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OldProjectGroup {
    pub id: String,
    pub name: String,
    pub collapsed: bool,
    pub project_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default)]
    pub workspaces: Vec<WorkspaceConfig>,
    #[serde(default)]
    pub recent_workspaces: Vec<RecentWorkspaceEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_workspace_id: Option<String>,
    #[serde(default)]
    pub projects: Vec<ProjectConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_tree: Option<Vec<ProjectTreeItem>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_groups: Option<Vec<OldProjectGroup>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_ordering: Option<Vec<String>>,
    pub default_shell: String,
    pub available_shells: Vec<ShellConfig>,
    #[serde(default = "default_ui_font_size")]
    pub ui_font_size: f64,
    #[serde(default = "default_terminal_font_size")]
    pub terminal_font_size: f64,
    #[serde(default)]
    pub layout_sizes: Option<Vec<f64>>,
    #[serde(default)]
    pub theme: ThemeConfig,
    #[serde(default)]
    pub middle_column_sizes: Option<Vec<f64>>,
    #[serde(default)]
    pub workspace_sidebar_sizes: Option<Vec<f64>>,
    #[serde(default)]
    pub completion_usage: CompletionUsageConfig,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_policies: Option<AgentPoliciesConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_backends: Option<AgentBackendsConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_mcp: Option<ExternalMcpInteropConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalMcpInteropConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imported_catalog: Option<ExternalMcpCatalog>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub last_sync_results: Vec<ExternalMcpSyncResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_imported_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_synced_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentBackendsConfig {
    #[serde(default)]
    pub routing: AgentBackendRoutingConfig,
    #[serde(default)]
    pub claude_sidecar: SidecarBackendConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentBackendRoutingConfig {
    #[serde(default = "default_codex_backend_routing")]
    pub codex: TaskTargetBackendRoutingConfig,
    #[serde(default = "default_claude_backend_routing")]
    pub claude: TaskTargetBackendRoutingConfig,
}

impl Default for AgentBackendRoutingConfig {
    fn default() -> Self {
        Self {
            codex: default_codex_backend_routing(),
            claude: default_claude_backend_routing(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskTargetBackendRoutingConfig {
    #[serde(default)]
    pub preferred_backend_id: Option<String>,
    #[serde(default = "default_allow_builtin_fallback")]
    pub allow_builtin_fallback: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SidecarBackendConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub provider: SidecarProviderConfig,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub startup_mode: SidecarStartupMode,
    #[serde(default = "default_sidecar_connection_timeout_ms")]
    pub connection_timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SidecarProviderConfig {
    #[serde(default = "default_sidecar_provider_kind")]
    pub kind: String,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub api_key_env_var: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub system_prompt: Option<String>,
}

impl Default for SidecarProviderConfig {
    fn default() -> Self {
        Self {
            kind: default_sidecar_provider_kind(),
            base_url: None,
            model: None,
            api_key: None,
            api_key_env_var: None,
            timeout_ms: None,
            system_prompt: None,
        }
    }
}

impl Default for SidecarBackendConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            command: None,
            args: Vec::new(),
            env: BTreeMap::new(),
            provider: SidecarProviderConfig::default(),
            cwd: None,
            startup_mode: SidecarStartupMode::default(),
            connection_timeout_ms: default_sidecar_connection_timeout_ms(),
        }
    }
}

impl SidecarBackendConfig {
    pub fn is_launchable(&self) -> bool {
        self.launch_validation_error().is_none()
    }

    pub fn launch_validation_error(&self) -> Option<String> {
        if !self.enabled {
            return Some("Sidecar backend is disabled in Mini-Term settings.".to_string());
        }

        if matches!(self.startup_mode, SidecarStartupMode::Process)
            && !self
                .command
                .as_deref()
                .map(str::trim)
                .is_some_and(|value| !value.is_empty())
        {
            return Some(
                "Sidecar backend is enabled, but the launch command is missing.".to_string(),
            );
        }

        self.provider_validation_error()
    }

    pub fn provider_validation_error(&self) -> Option<String> {
        let kind = self.provider.normalized_kind();
        let Some(provider_kind) = ModelGatewayProviderKind::parse(&kind) else {
            return Some(format!(
                "Sidecar provider `{kind}` is not supported. Use `reference`, `openai-compatible`, or `anthropic`."
            ));
        };

        if provider_kind.requires_model()
            && !self
                .provider
                .model
                .as_deref()
                .is_some_and(|value| !value.is_empty())
        {
            return Some(format!(
                "Sidecar provider `{}` requires a model.",
                provider_kind.as_str()
            ));
        }

        if provider_kind.requires_api_key() && !self.provider.has_resolved_api_key() {
            return Some(format!(
                "Sidecar provider `{}` requires an API key or API key env var.",
                provider_kind.as_str()
            ));
        }

        if self
            .provider
            .base_url
            .as_deref()
            .is_some_and(|value| !value.starts_with("http://") && !value.starts_with("https://"))
        {
            return Some(
                "Sidecar provider base URL must start with `http://` or `https://`.".to_string(),
            );
        }

        None
    }

    pub fn resolved_env(&self) -> BTreeMap<String, String> {
        merge_sidecar_provider_into_env(self.env.clone(), &self.provider)
    }

    pub fn redact_secrets_in_text(&self, text: &str) -> String {
        self.provider.redact_secrets_in_text(text)
    }
}

impl SidecarProviderConfig {
    pub fn normalized_kind(&self) -> String {
        let kind = self.kind.trim().to_ascii_lowercase();
        if kind.is_empty() {
            default_sidecar_provider_kind()
        } else {
            kind
        }
    }

    pub fn display_label(&self) -> String {
        match self.normalized_kind().as_str() {
            PROVIDER_KIND_REFERENCE => PROVIDER_KIND_REFERENCE.to_string(),
            "openai-compatible" | "anthropic" => self
                .model
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|model| format!("{}/{model}", self.normalized_kind()))
                .unwrap_or_else(|| self.normalized_kind()),
            other => other.to_string(),
        }
    }

    pub fn resolved_api_key(&self) -> Option<String> {
        normalize_optional_string(self.api_key.clone()).or_else(|| {
            normalize_optional_string(self.api_key_env_var.clone()).and_then(|env_var| {
                std::env::var(&env_var)
                    .ok()
                    .and_then(|value| normalize_optional_string(Some(value)))
            })
        })
    }

    pub fn has_resolved_api_key(&self) -> bool {
        self.resolved_api_key().is_some()
    }

    pub fn api_key_source(&self) -> &'static str {
        if normalize_optional_string(self.api_key_env_var.clone()).is_some() {
            "env-var"
        } else if normalize_optional_string(self.api_key.clone()).is_some() {
            "inline"
        } else {
            "missing"
        }
    }

    pub fn redact_secrets_in_text(&self, text: &str) -> String {
        let mut redacted = text.to_string();
        let env_secret =
            normalize_optional_string(self.api_key_env_var.clone()).and_then(|env_var| {
                std::env::var(&env_var)
                    .ok()
                    .and_then(|value| normalize_optional_string(Some(value)))
            });
        for secret in [normalize_optional_string(self.api_key.clone()), env_secret]
            .into_iter()
            .flatten()
        {
            if secret.len() >= 4 {
                redacted = redacted.replace(&secret, "[redacted]");
            }
        }
        redacted
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum SidecarStartupMode {
    #[default]
    Process,
    Loopback,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRootConfig {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default = "default_workspace_root_role")]
    pub role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceConfig {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub roots: Vec<WorkspaceRootConfig>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saved_layout: Option<SavedProjectLayout>,
    #[serde(default)]
    pub expanded_dirs_by_root: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub last_opened_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentWorkspaceEntry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub root_paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent: Option<String>,
    #[serde(default)]
    pub last_opened_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saved_layout: Option<SavedProjectLayout>,
    #[serde(default)]
    pub expanded_dirs_by_root: BTreeMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionUsageConfig {
    #[serde(default)]
    pub commands: BTreeMap<String, u32>,
    #[serde(default)]
    pub subcommands: BTreeMap<String, u32>,
    #[serde(default)]
    pub options: BTreeMap<String, u32>,
    #[serde(default)]
    pub arguments: BTreeMap<String, u32>,
    #[serde(default)]
    pub scopes: BTreeMap<String, CompletionUsageScopeConfig>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionUsageScopeConfig {
    #[serde(default)]
    pub commands: BTreeMap<String, u32>,
    #[serde(default)]
    pub subcommands: BTreeMap<String, u32>,
    #[serde(default)]
    pub options: BTreeMap<String, u32>,
    #[serde(default)]
    pub arguments: BTreeMap<String, u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeConfig {
    pub preset: String,
    pub window_effect: String,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum ThemeConfigRepr {
    Modern {
        #[serde(default = "default_theme_preset")]
        preset: String,
        #[serde(default = "default_theme_window_effect")]
        window_effect: String,
    },
    Legacy(String),
}

impl<'de> Deserialize<'de> for ThemeConfig {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let repr = ThemeConfigRepr::deserialize(deserializer)?;
        Ok(match repr {
            ThemeConfigRepr::Modern {
                preset,
                window_effect,
            } => Self {
                preset,
                window_effect,
            },
            ThemeConfigRepr::Legacy(mode) => Self {
                preset: legacy_theme_mode_to_preset(&mode),
                window_effect: default_theme_window_effect(),
            },
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunProfile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saved_command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_scope: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedPane {
    pub shell_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_profile: Option<RunProfile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum SavedSplitNode {
    Leaf {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pane: Option<SavedPane>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        panes: Vec<SavedPane>,
    },
    Split {
        direction: String,
        children: Vec<SavedSplitNode>,
        sizes: Vec<f64>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedTab {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_title: Option<String>,
    pub split_layout: SavedSplitNode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedProjectLayout {
    pub tabs: Vec<SavedTab>,
    pub active_tab_index: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConfig {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub saved_layout: Option<SavedProjectLayout>,
    #[serde(default)]
    pub expanded_dirs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellConfig {
    pub name: String,
    pub command: String,
    pub args: Option<Vec<String>>,
}

fn default_ui_font_size() -> f64 {
    13.0
}

fn default_terminal_font_size() -> f64 {
    14.0
}

fn default_sidecar_connection_timeout_ms() -> u64 {
    10_000
}

fn default_sidecar_provider_kind() -> String {
    PROVIDER_KIND_REFERENCE.into()
}

fn default_allow_builtin_fallback() -> bool {
    true
}

fn default_codex_backend_routing() -> TaskTargetBackendRoutingConfig {
    TaskTargetBackendRoutingConfig {
        preferred_backend_id: Some("codex-cli".into()),
        allow_builtin_fallback: true,
    }
}

fn default_claude_backend_routing() -> TaskTargetBackendRoutingConfig {
    TaskTargetBackendRoutingConfig {
        preferred_backend_id: Some("claude-cli".into()),
        allow_builtin_fallback: true,
    }
}

fn default_workspace_root_role() -> String {
    "member".into()
}

fn current_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn powershell_completion_bootstrap() -> String {
    [
        "Import-Module PSReadLine -ErrorAction SilentlyContinue",
        "if (Get-Command Set-PSReadLineKeyHandler -ErrorAction SilentlyContinue) {",
        "  Set-PSReadLineKeyHandler -Key Tab -Function MenuComplete",
        "  try { Set-PSReadLineOption -PredictionSource History -PredictionViewStyle ListView } catch {}",
        "}",
    ]
    .join("; ")
}

fn default_theme_preset() -> String {
    "warm-carbon".into()
}

fn default_theme_window_effect() -> String {
    "auto".into()
}

fn legacy_theme_mode_to_preset(mode: &str) -> String {
    match mode {
        "light" => "ghostty-light".into(),
        "dark" => "ghostty-dark".into(),
        _ => default_theme_preset(),
    }
}

impl Default for ThemeConfig {
    fn default() -> Self {
        Self {
            preset: default_theme_preset(),
            window_effect: default_theme_window_effect(),
        }
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            workspaces: vec![],
            recent_workspaces: vec![],
            last_workspace_id: None,
            projects: vec![],
            project_tree: None,
            project_groups: None,
            project_ordering: None,
            default_shell: default_shell_name(),
            available_shells: default_shells(),
            ui_font_size: default_ui_font_size(),
            terminal_font_size: default_terminal_font_size(),
            layout_sizes: None,
            theme: ThemeConfig::default(),
            middle_column_sizes: None,
            workspace_sidebar_sizes: None,
            completion_usage: CompletionUsageConfig::default(),
            agent_policies: Some(crate::agent_policy::default_agent_policies()),
            agent_backends: Some(AgentBackendsConfig::default()),
            external_mcp: Some(ExternalMcpInteropConfig::default()),
        }
    }
}

#[cfg(target_os = "windows")]
fn default_shell_name() -> String {
    "powershell".into()
}

#[cfg(target_os = "macos")]
fn default_shell_name() -> String {
    "zsh".into()
}

#[cfg(target_os = "linux")]
fn default_shell_name() -> String {
    "bash".into()
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn default_shell_name() -> String {
    "sh".into()
}

#[cfg(target_os = "windows")]
fn default_shells() -> Vec<ShellConfig> {
    vec![
        ShellConfig {
            name: "powershell".into(),
            command: "powershell".into(),
            args: Some(vec![
                "-NoLogo".into(),
                "-NoExit".into(),
                "-Command".into(),
                powershell_completion_bootstrap(),
            ]),
        },
        ShellConfig {
            name: "cmd".into(),
            command: "cmd".into(),
            args: None,
        },
    ]
}

#[cfg(target_os = "macos")]
fn default_shells() -> Vec<ShellConfig> {
    vec![
        ShellConfig {
            name: "zsh".into(),
            command: "/bin/zsh".into(),
            args: Some(vec!["--login".into()]),
        },
        ShellConfig {
            name: "bash".into(),
            command: "/bin/bash".into(),
            args: Some(vec!["--login".into()]),
        },
    ]
}

#[cfg(target_os = "linux")]
fn default_shells() -> Vec<ShellConfig> {
    vec![
        ShellConfig {
            name: "bash".into(),
            command: "/bin/bash".into(),
            args: None,
        },
        ShellConfig {
            name: "zsh".into(),
            command: "/usr/bin/zsh".into(),
            args: None,
        },
        ShellConfig {
            name: "sh".into(),
            command: "/bin/sh".into(),
            args: None,
        },
    ]
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn default_shells() -> Vec<ShellConfig> {
    vec![ShellConfig {
        name: "sh".into(),
        command: "/bin/sh".into(),
        args: None,
    }]
}

pub const APP_IDENTIFIER: &str = "com.tauri-app.tauri-app";

pub fn config_path_for_data_dir(data_dir: &Path) -> PathBuf {
    fs::create_dir_all(data_dir).ok();
    data_dir.join("config.json")
}

fn config_path(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .expect("failed to get app data dir");
    config_path_for_data_dir(&dir)
}

fn get_path_base_name(path: &str) -> String {
    path.rsplit(['\\', '/'])
        .find(|segment| !segment.is_empty())
        .unwrap_or(path)
        .to_string()
}

fn path_exists(path: &str) -> bool {
    fs::metadata(path).is_ok()
}

fn normalize_path_string(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_string()
}

fn path_is_within_root(path: &str, root_path: &str) -> bool {
    let normalized_path = normalize_path_string(path);
    let normalized_root = normalize_path_string(root_path);
    normalized_path == normalized_root
        || normalized_path.starts_with(&format!("{normalized_root}/"))
}

fn ensure_single_primary_root(roots: &mut [WorkspaceRootConfig]) {
    let primary_root_id = roots
        .iter()
        .find(|root| root.role == "primary")
        .map(|root| root.id.clone())
        .or_else(|| roots.first().map(|root| root.id.clone()));

    for root in roots.iter_mut() {
        if root.name.trim().is_empty() {
            root.name = get_path_base_name(&root.path);
        }

        if primary_root_id.as_deref() == Some(root.id.as_str()) {
            root.role = "primary".into();
        } else {
            root.role = "member".into();
        }
    }
}

fn legacy_project_root_id(project_id: &str) -> String {
    format!("{project_id}-root-1")
}

fn project_to_workspace(project: &ProjectConfig) -> WorkspaceConfig {
    let timestamp = current_timestamp_ms();
    let root_id = legacy_project_root_id(&project.id);
    WorkspaceConfig {
        id: project.id.clone(),
        name: project.name.clone(),
        roots: vec![WorkspaceRootConfig {
            id: root_id.clone(),
            name: get_path_base_name(&project.path),
            path: project.path.clone(),
            role: "primary".into(),
        }],
        pinned: false,
        accent: None,
        saved_layout: project.saved_layout.clone(),
        expanded_dirs_by_root: BTreeMap::from([(root_id, project.expanded_dirs.clone())]),
        created_at: timestamp,
        last_opened_at: timestamp,
    }
}

fn workspace_to_project(workspace: &WorkspaceConfig) -> ProjectConfig {
    let primary_root = workspace
        .roots
        .iter()
        .find(|root| root.role == "primary")
        .or_else(|| workspace.roots.first());

    let expanded_dirs = primary_root
        .and_then(|root| workspace.expanded_dirs_by_root.get(&root.id))
        .cloned()
        .unwrap_or_default();

    ProjectConfig {
        id: workspace.id.clone(),
        name: workspace.name.clone(),
        path: primary_root
            .map(|root| root.path.clone())
            .unwrap_or_default(),
        saved_layout: workspace.saved_layout.clone(),
        expanded_dirs,
    }
}

fn normalize_workspace(mut workspace: WorkspaceConfig) -> WorkspaceConfig {
    workspace
        .roots
        .retain(|root| !root.path.trim().is_empty() && path_exists(&root.path));
    workspace.roots.retain(|root| !root.path.trim().is_empty());
    ensure_single_primary_root(&mut workspace.roots);

    if workspace.name.trim().is_empty() {
        workspace.name = workspace
            .roots
            .first()
            .map(|root| get_path_base_name(&root.path))
            .unwrap_or_else(|| "Workspace".into());
    }

    let now = current_timestamp_ms();
    if workspace.created_at == 0 {
        workspace.created_at = now;
    }
    if workspace.last_opened_at == 0 {
        workspace.last_opened_at = workspace.created_at;
    }

    workspace
        .expanded_dirs_by_root
        .retain(|root_id, _| workspace.roots.iter().any(|root| root.id == *root_id));

    for root in &workspace.roots {
        let filtered = workspace
            .expanded_dirs_by_root
            .get(&root.id)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|path| path_exists(path) && path_is_within_root(path, &root.path))
            .collect::<Vec<_>>();
        workspace
            .expanded_dirs_by_root
            .insert(root.id.clone(), filtered);
    }

    workspace
}

fn normalize_recent_workspace(mut workspace: RecentWorkspaceEntry) -> RecentWorkspaceEntry {
    workspace.root_paths.retain(|path| !path.trim().is_empty());
    if workspace.name.trim().is_empty() {
        workspace.name = workspace
            .root_paths
            .first()
            .map(|path| get_path_base_name(path))
            .unwrap_or_else(|| "Workspace".into());
    }
    if workspace.last_opened_at == 0 {
        workspace.last_opened_at = current_timestamp_ms();
    }
    workspace
}

const SIDECAR_PROVIDER_ENV_KEY: &str = "MINI_TERM_SIDECAR_PROVIDER";
const SIDECAR_PROVIDER_BASE_URL_ENV_KEY: &str = "MINI_TERM_SIDECAR_BASE_URL";
const SIDECAR_PROVIDER_MODEL_ENV_KEY: &str = "MINI_TERM_SIDECAR_MODEL";
const SIDECAR_PROVIDER_API_KEY_ENV_KEY: &str = "MINI_TERM_SIDECAR_API_KEY";
const SIDECAR_PROVIDER_TIMEOUT_ENV_KEY: &str = "MINI_TERM_SIDECAR_PROVIDER_TIMEOUT_MS";
const SIDECAR_PROVIDER_SYSTEM_PROMPT_ENV_KEY: &str = "MINI_TERM_SIDECAR_SYSTEM_PROMPT";
const SIDECAR_PROVIDER_ENV_KEYS: [&str; 6] = [
    SIDECAR_PROVIDER_ENV_KEY,
    SIDECAR_PROVIDER_BASE_URL_ENV_KEY,
    SIDECAR_PROVIDER_MODEL_ENV_KEY,
    SIDECAR_PROVIDER_API_KEY_ENV_KEY,
    SIDECAR_PROVIDER_TIMEOUT_ENV_KEY,
    SIDECAR_PROVIDER_SYSTEM_PROMPT_ENV_KEY,
];

fn normalize_optional_string(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn env_string(env: &BTreeMap<String, String>, key: &str) -> Option<String> {
    env.get(key)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn env_positive_u64(env: &BTreeMap<String, String>, key: &str) -> Option<u64> {
    env.get(key)
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
}

fn normalize_sidecar_provider_config(
    mut provider: SidecarProviderConfig,
    env: &BTreeMap<String, String>,
) -> SidecarProviderConfig {
    let normalized_kind = provider.kind.trim().to_ascii_lowercase();
    let has_explicit_provider_config = normalized_kind != default_sidecar_provider_kind()
        || provider.base_url.is_some()
        || provider.model.is_some()
        || provider.api_key.is_some()
        || provider.api_key_env_var.is_some()
        || provider.timeout_ms.is_some()
        || provider.system_prompt.is_some();

    provider.kind = normalized_kind;
    if !has_explicit_provider_config || provider.kind.is_empty() {
        provider.kind = env_string(env, SIDECAR_PROVIDER_ENV_KEY)
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_else(default_sidecar_provider_kind);
    }

    provider.base_url = normalize_optional_string(provider.base_url)
        .or_else(|| env_string(env, SIDECAR_PROVIDER_BASE_URL_ENV_KEY));
    provider.model = normalize_optional_string(provider.model)
        .or_else(|| env_string(env, SIDECAR_PROVIDER_MODEL_ENV_KEY));
    provider.api_key = normalize_optional_string(provider.api_key)
        .or_else(|| env_string(env, SIDECAR_PROVIDER_API_KEY_ENV_KEY));
    provider.api_key_env_var = normalize_optional_string(provider.api_key_env_var);
    provider.timeout_ms = provider
        .timeout_ms
        .filter(|value| *value > 0)
        .or_else(|| env_positive_u64(env, SIDECAR_PROVIDER_TIMEOUT_ENV_KEY));
    provider.system_prompt = normalize_optional_string(provider.system_prompt)
        .or_else(|| env_string(env, SIDECAR_PROVIDER_SYSTEM_PROMPT_ENV_KEY));

    provider
}

fn merge_sidecar_provider_into_env(
    mut env: BTreeMap<String, String>,
    provider: &SidecarProviderConfig,
) -> BTreeMap<String, String> {
    env.retain(|key, _| !SIDECAR_PROVIDER_ENV_KEYS.contains(&key.as_str()));
    env.insert(SIDECAR_PROVIDER_ENV_KEY.into(), provider.normalized_kind());

    if let Some(base_url) = normalize_optional_string(provider.base_url.clone()) {
        env.insert(SIDECAR_PROVIDER_BASE_URL_ENV_KEY.into(), base_url);
    }
    if let Some(model) = normalize_optional_string(provider.model.clone()) {
        env.insert(SIDECAR_PROVIDER_MODEL_ENV_KEY.into(), model);
    }
    if let Some(api_key) = provider.resolved_api_key() {
        env.insert(SIDECAR_PROVIDER_API_KEY_ENV_KEY.into(), api_key);
    }
    if let Some(timeout_ms) = provider.timeout_ms.filter(|value| *value > 0) {
        env.insert(
            SIDECAR_PROVIDER_TIMEOUT_ENV_KEY.into(),
            timeout_ms.to_string(),
        );
    }
    if let Some(system_prompt) = normalize_optional_string(provider.system_prompt.clone()) {
        env.insert(SIDECAR_PROVIDER_SYSTEM_PROMPT_ENV_KEY.into(), system_prompt);
    }

    env
}

fn normalize_sidecar_config(mut config: SidecarBackendConfig) -> SidecarBackendConfig {
    config.command = config
        .command
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    config.args = config
        .args
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect();
    config.cwd = config
        .cwd
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    config.env = config
        .env
        .into_iter()
        .filter_map(|(key, value)| {
            let key = key.trim().to_string();
            if key.is_empty() {
                return None;
            }
            Some((key, value))
        })
        .collect();
    config.provider = normalize_sidecar_provider_config(config.provider, &config.env);
    config.env = merge_sidecar_provider_into_env(config.env, &config.provider);
    if config.connection_timeout_ms == 0 {
        config.connection_timeout_ms = default_sidecar_connection_timeout_ms();
    }
    config
}

fn normalize_target_backend_routing(
    mut config: TaskTargetBackendRoutingConfig,
    default_preferred_backend_id: &str,
) -> TaskTargetBackendRoutingConfig {
    config.preferred_backend_id = normalize_optional_string(config.preferred_backend_id)
        .or_else(|| Some(default_preferred_backend_id.to_string()));
    config
}

fn normalize_agent_backend_routing(
    mut config: AgentBackendRoutingConfig,
) -> AgentBackendRoutingConfig {
    config.codex = normalize_target_backend_routing(config.codex, "codex-cli");
    config.claude = normalize_target_backend_routing(config.claude, "claude-cli");
    config
}

fn normalize_agent_backends(mut config: AgentBackendsConfig) -> AgentBackendsConfig {
    config.routing = normalize_agent_backend_routing(config.routing);
    config.claude_sidecar = normalize_sidecar_config(config.claude_sidecar);
    config
}

fn normalize_split_node(node: &mut SavedSplitNode) {
    match node {
        SavedSplitNode::Leaf { pane, panes } => {
            if pane.is_none() {
                *pane = panes.first().cloned();
            }
            panes.clear();
        }
        SavedSplitNode::Split { children, .. } => {
            for child in children.iter_mut() {
                normalize_split_node(child);
            }
        }
    }
}

fn normalize_saved_layout(layout: &mut SavedProjectLayout) {
    for tab in layout.tabs.iter_mut() {
        normalize_split_node(&mut tab.split_layout);
    }
}

fn migrate_config(mut config: AppConfig) -> AppConfig {
    for project in config.projects.iter_mut() {
        if let Some(layout) = project.saved_layout.as_mut() {
            normalize_saved_layout(layout);
        }
    }

    for workspace in config.workspaces.iter_mut() {
        if let Some(layout) = workspace.saved_layout.as_mut() {
            normalize_saved_layout(layout);
        }
    }

    for recent_workspace in config.recent_workspaces.iter_mut() {
        if let Some(layout) = recent_workspace.saved_layout.as_mut() {
            normalize_saved_layout(layout);
        }
    }

    if config.project_tree.is_some() {
        config.project_groups = None;
        config.project_ordering = None;
        return config;
    }

    let groups = match config.project_groups.take() {
        Some(g) if !g.is_empty() => g,
        _ => return config,
    };
    let ordering = config.project_ordering.take().unwrap_or_default();
    let group_map: std::collections::HashMap<String, &OldProjectGroup> =
        groups.iter().map(|g| (g.id.clone(), g)).collect();

    let mut tree: Vec<ProjectTreeItem> = Vec::new();
    for item_id in &ordering {
        if let Some(old_group) = group_map.get(item_id) {
            tree.push(ProjectTreeItem::Group(ProjectGroup {
                id: old_group.id.clone(),
                name: old_group.name.clone(),
                collapsed: old_group.collapsed,
                children: old_group
                    .project_ids
                    .iter()
                    .map(|pid| ProjectTreeItem::ProjectId(pid.clone()))
                    .collect(),
            }));
        } else {
            tree.push(ProjectTreeItem::ProjectId(item_id.clone()));
        }
    }
    config.project_tree = Some(tree);
    config
}

pub fn normalize_config(mut config: AppConfig) -> AppConfig {
    if config.workspaces.is_empty() && !config.projects.is_empty() {
        config.workspaces = config.projects.iter().map(project_to_workspace).collect();
    }

    config.workspaces = config
        .workspaces
        .into_iter()
        .map(normalize_workspace)
        .filter(|workspace| !workspace.roots.is_empty())
        .collect();

    config.recent_workspaces = config
        .recent_workspaces
        .into_iter()
        .map(normalize_recent_workspace)
        .collect();

    if config.last_workspace_id.is_none() {
        config.last_workspace_id = config
            .workspaces
            .first()
            .map(|workspace| workspace.id.clone());
    }

    config.projects = config.workspaces.iter().map(workspace_to_project).collect();

    if config.available_shells.is_empty() {
        config.available_shells = default_shells();
    }

    config.available_shells = config
        .available_shells
        .into_iter()
        .map(normalize_shell)
        .collect();

    let default_shell_exists = config
        .available_shells
        .iter()
        .any(|shell| shell.name == config.default_shell);

    if config.default_shell.is_empty() || !default_shell_exists {
        config.default_shell = config
            .available_shells
            .first()
            .map(|shell| shell.name.clone())
            .unwrap_or_else(default_shell_name);
    }

    if config.agent_policies.is_none() {
        config.agent_policies = Some(crate::agent_policy::default_agent_policies());
    }

    config.agent_backends = Some(normalize_agent_backends(
        config.agent_backends.unwrap_or_default(),
    ));
    config.external_mcp = Some(config.external_mcp.unwrap_or_default());

    config
}

fn normalize_shell(mut shell: ShellConfig) -> ShellConfig {
    let command_name = shell
        .command
        .rsplit('\\')
        .next()
        .unwrap_or(shell.command.as_str())
        .rsplit('/')
        .next()
        .unwrap_or(shell.command.as_str())
        .to_ascii_lowercase();

    if matches!(shell.args.as_ref(), Some(args) if !args.is_empty()) {
        return shell;
    }

    shell.args = match command_name.as_str() {
        "powershell" | "powershell.exe" | "pwsh" | "pwsh.exe" => Some(vec![
            "-NoLogo".into(),
            "-NoExit".into(),
            "-Command".into(),
            powershell_completion_bootstrap(),
        ]),
        _ => None,
    };

    shell
}

#[tauri::command]
pub fn load_config(app: AppHandle) -> AppConfig {
    let path = config_path(&app);
    let config = load_config_from_path(&path);
    let _ = save_config_to_path(&path, config.clone());
    config
}

#[tauri::command]
pub fn save_config(app: AppHandle, config: AppConfig) -> Result<(), String> {
    let path = config_path(&app);
    save_config_to_path(&path, config)
}

pub fn load_config_from_path(path: &Path) -> AppConfig {
    match fs::read_to_string(path) {
        Ok(content) => normalize_config(migrate_config(
            serde_json::from_str(&content).unwrap_or_default(),
        )),
        Err(_) => normalize_config(migrate_config(AppConfig::default())),
    }
}

pub fn save_config_to_path(path: &Path, config: AppConfig) -> Result<(), String> {
    let config = normalize_config(migrate_config(config));
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn create_temp_dir(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("mini-term-config-{label}-{unique}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn default_config_has_shells() {
        let config = AppConfig::default();
        assert!(!config.available_shells.is_empty());
        assert!(!config.default_shell.is_empty());
    }

    #[test]
    fn default_agent_backend_routing_prefers_builtin_clis() {
        let routing = AppConfig::default().agent_backends.unwrap().routing;
        assert_eq!(
            routing.codex.preferred_backend_id.as_deref(),
            Some("codex-cli")
        );
        assert!(routing.codex.allow_builtin_fallback);
        assert_eq!(
            routing.claude.preferred_backend_id.as_deref(),
            Some("claude-cli")
        );
        assert!(routing.claude.allow_builtin_fallback);
    }

    #[test]
    fn config_round_trip() {
        let config = AppConfig::default();
        let json = serde_json::to_string(&config).unwrap();
        let parsed: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.available_shells.len(), config.available_shells.len());
    }

    #[test]
    fn config_round_trip_preserves_external_mcp_state() {
        let config = AppConfig {
            external_mcp: Some(ExternalMcpInteropConfig {
                imported_catalog: Some(ExternalMcpCatalog {
                    servers: vec![],
                    sources: vec![],
                    warnings: vec!["warning".into()],
                }),
                last_sync_results: vec![ExternalMcpSyncResult {
                    client_type: "codex".into(),
                    server_count: 2,
                    files: vec![],
                }],
                last_imported_at: Some(10),
                last_synced_at: Some(20),
            }),
            ..AppConfig::default()
        };

        let json = serde_json::to_string(&config).unwrap();
        let parsed: AppConfig = serde_json::from_str(&json).unwrap();
        let external_mcp = parsed
            .external_mcp
            .expect("external MCP state should deserialize");
        assert_eq!(external_mcp.last_sync_results.len(), 1);
        assert_eq!(external_mcp.last_imported_at, Some(10));
        assert_eq!(external_mcp.last_synced_at, Some(20));
        assert_eq!(
            external_mcp
                .imported_catalog
                .expect("catalog should deserialize")
                .warnings,
            vec!["warning".to_string()]
        );
    }

    #[test]
    fn old_config_without_layout_deserializes() {
        let json = r#"{
            "projects": [{"id": "1", "name": "test", "path": "/tmp"}],
            "defaultShell": "cmd",
            "availableShells": [{"name": "cmd", "command": "cmd"}],
            "uiFontSize": 13,
            "terminalFontSize": 14
        }"#;
        let config: AppConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.projects.len(), 1);
        assert!(config.projects[0].saved_layout.is_none());
    }

    #[test]
    fn old_config_without_groups_deserializes() {
        let json = r#"{
            "projects": [{"id": "1", "name": "test", "path": "/tmp"}],
            "defaultShell": "cmd",
            "availableShells": [{"name": "cmd", "command": "cmd"}],
            "uiFontSize": 13,
            "terminalFontSize": 14
        }"#;
        let config: AppConfig = serde_json::from_str(json).unwrap();
        assert!(config.project_tree.is_none());
        assert!(config.project_groups.is_none());
        assert!(config.project_ordering.is_none());
    }

    #[test]
    fn old_theme_mode_deserializes() {
        let json = r#"{
            "projects": [],
            "defaultShell": "cmd",
            "availableShells": [{"name": "cmd", "command": "cmd"}],
            "theme": "light"
        }"#;
        let config: AppConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.theme.preset, "ghostty-light");
        assert_eq!(config.theme.window_effect, "auto");
    }

    #[test]
    fn normalize_shell_adds_powershell_completion_args() {
        let shell = normalize_shell(ShellConfig {
            name: "powershell".into(),
            command: "powershell".into(),
            args: None,
        });

        let args = shell.args.expect("powershell args should be added");
        assert!(args.iter().any(|arg| arg == "-NoExit"));
        assert!(args
            .iter()
            .any(|arg| arg.contains("Set-PSReadLineKeyHandler")));
    }

    #[test]
    fn layout_round_trip() {
        let layout = SavedProjectLayout {
            tabs: vec![SavedTab {
                custom_title: Some("test".into()),
                split_layout: SavedSplitNode::Split {
                    direction: "horizontal".into(),
                    children: vec![
                        SavedSplitNode::Leaf {
                            pane: Some(SavedPane {
                                shell_name: "cmd".into(),
                                run_command: None,
                                run_profile: None,
                            }),
                            panes: Vec::new(),
                        },
                        SavedSplitNode::Leaf {
                            pane: Some(SavedPane {
                                shell_name: "powershell".into(),
                                run_command: None,
                                run_profile: None,
                            }),
                            panes: Vec::new(),
                        },
                    ],
                    sizes: vec![50.0, 50.0],
                },
            }],
            active_tab_index: 0,
        };
        let json = serde_json::to_string(&layout).unwrap();
        let parsed: SavedProjectLayout = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.tabs.len(), 1);
        assert_eq!(parsed.active_tab_index, 0);
    }

    #[test]
    fn migrate_old_groups_to_tree() {
        let json = r#"{
            "projects": [
                {"id": "p1", "name": "proj1", "path": "/tmp/1"},
                {"id": "p2", "name": "proj2", "path": "/tmp/2"}
            ],
            "projectGroups": [{"id": "g1", "name": "Group1", "collapsed": false, "projectIds": ["p1"]}],
            "projectOrdering": ["g1", "p2"],
            "defaultShell": "cmd",
            "availableShells": [{"name": "cmd", "command": "cmd"}],
            "uiFontSize": 13,
            "terminalFontSize": 14
        }"#;
        let config: AppConfig = serde_json::from_str(json).unwrap();
        let config = migrate_config(config);
        assert!(config.project_tree.is_some());
        assert!(config.project_groups.is_none());
        assert!(config.project_ordering.is_none());
        let tree = config.project_tree.unwrap();
        assert_eq!(tree.len(), 2);
    }

    #[test]
    fn nested_tree_round_trip() {
        let tree = vec![
            ProjectTreeItem::ProjectId("p1".into()),
            ProjectTreeItem::Group(ProjectGroup {
                id: "g1".into(),
                name: "Group1".into(),
                collapsed: false,
                children: vec![
                    ProjectTreeItem::ProjectId("p2".into()),
                    ProjectTreeItem::Group(ProjectGroup {
                        id: "g2".into(),
                        name: "Sub".into(),
                        collapsed: true,
                        children: vec![ProjectTreeItem::ProjectId("p3".into())],
                    }),
                ],
            }),
        ];
        let json = serde_json::to_string(&tree).unwrap();
        let parsed: Vec<ProjectTreeItem> = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.len(), 2);
    }

    #[test]
    fn normalize_config_migrates_legacy_projects_to_workspaces() {
        let root = create_temp_dir("legacy-workspace");
        let src = root.join("src");
        fs::create_dir_all(&src).unwrap();

        let config = normalize_config(AppConfig {
            projects: vec![ProjectConfig {
                id: "workspace-1".into(),
                name: "mini-term".into(),
                path: root.to_string_lossy().to_string(),
                saved_layout: None,
                expanded_dirs: vec![src.to_string_lossy().to_string()],
            }],
            ..AppConfig::default()
        });

        assert_eq!(config.workspaces.len(), 1);
        assert_eq!(config.workspaces[0].id, "workspace-1");
        assert_eq!(config.workspaces[0].roots.len(), 1);
        assert_eq!(config.workspaces[0].roots[0].role, "primary");
        assert_eq!(
            config.workspaces[0]
                .expanded_dirs_by_root
                .get("workspace-1-root-1")
                .cloned()
                .unwrap_or_default(),
            vec![src.to_string_lossy().to_string()]
        );
        assert_eq!(config.last_workspace_id.as_deref(), Some("workspace-1"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn workspaces_round_trip_with_recent_entries() {
        let root_a = create_temp_dir("workspace-root-a");
        let root_a_src = root_a.join("src");
        fs::create_dir_all(&root_a_src).unwrap();
        let root_b = create_temp_dir("workspace-root-b");

        let config = normalize_config(
            serde_json::from_value(serde_json::json!({
                "workspaces": [{
                    "id": "workspace-1",
                    "name": "mini-term",
                    "roots": [
                        {"id": "root-a", "name": "mini-term", "path": root_a.to_string_lossy(), "role": "member"},
                        {"id": "root-b", "name": "shared", "path": root_b.to_string_lossy(), "role": "primary"}
                    ],
                    "pinned": true,
                    "accent": "#ff6600",
                    "expandedDirsByRoot": {
                        "root-a": [root_a_src.to_string_lossy()]
                    },
                    "createdAt": 100,
                    "lastOpenedAt": 200
                }],
                "recentWorkspaces": [{
                    "id": "recent-1",
                    "name": "recent workspace",
                    "rootPaths": [root_a.to_string_lossy()],
                    "lastOpenedAt": 300
                }],
                "lastWorkspaceId": "workspace-1",
                "defaultShell": "cmd",
                "availableShells": [{"name": "cmd", "command": "cmd"}]
            }))
            .unwrap(),
        );

        assert_eq!(config.workspaces.len(), 1);
        assert_eq!(config.workspaces[0].roots[0].role, "member");
        assert_eq!(config.workspaces[0].roots[1].role, "primary");
        assert_eq!(config.recent_workspaces.len(), 1);
        assert_eq!(
            config.recent_workspaces[0].root_paths,
            vec![root_a.to_string_lossy().to_string()]
        );
        assert_eq!(config.projects.len(), 1);
        assert_eq!(
            config.projects[0].path,
            root_b.to_string_lossy().to_string()
        );

        let _ = fs::remove_dir_all(root_a);
        let _ = fs::remove_dir_all(root_b);
    }

    #[test]
    fn normalize_config_drops_missing_expanded_dirs_and_empty_workspaces() {
        let existing_root = std::env::temp_dir().join("mini-term-config-existing-root");
        let existing_child = existing_root.join("src");
        fs::create_dir_all(&existing_child).unwrap();

        let missing_root = std::env::temp_dir().join("mini-term-config-missing-root");
        let missing_child = existing_root.join("sanshu");

        let config = normalize_config(AppConfig {
            workspaces: vec![
                WorkspaceConfig {
                    id: "workspace-1".into(),
                    name: "mini-term".into(),
                    roots: vec![WorkspaceRootConfig {
                        id: "root-1".into(),
                        name: "mini-term".into(),
                        path: existing_root.to_string_lossy().to_string(),
                        role: "primary".into(),
                    }],
                    pinned: false,
                    accent: None,
                    saved_layout: None,
                    expanded_dirs_by_root: BTreeMap::from([(
                        "root-1".into(),
                        vec![
                            existing_child.to_string_lossy().to_string(),
                            missing_child.to_string_lossy().to_string(),
                        ],
                    )]),
                    created_at: 1,
                    last_opened_at: 1,
                },
                WorkspaceConfig {
                    id: "workspace-2".into(),
                    name: "missing".into(),
                    roots: vec![WorkspaceRootConfig {
                        id: "root-2".into(),
                        name: "missing".into(),
                        path: missing_root.to_string_lossy().to_string(),
                        role: "primary".into(),
                    }],
                    pinned: false,
                    accent: None,
                    saved_layout: None,
                    expanded_dirs_by_root: BTreeMap::new(),
                    created_at: 1,
                    last_opened_at: 1,
                },
            ],
            ..AppConfig::default()
        });

        assert_eq!(config.workspaces.len(), 1);
        assert_eq!(
            config.workspaces[0]
                .expanded_dirs_by_root
                .get("root-1")
                .cloned()
                .unwrap_or_default(),
            vec![existing_child.to_string_lossy().to_string()]
        );

        let _ = fs::remove_dir_all(existing_root);
    }

    #[test]
    fn normalize_sidecar_config_derives_provider_from_legacy_env() {
        let config = normalize_config(
            serde_json::from_value(serde_json::json!({
                "workspaces": [],
                "recentWorkspaces": [],
                "defaultShell": "cmd",
                "availableShells": [{"name": "cmd", "command": "cmd"}],
                "agentBackends": {
                    "claudeSidecar": {
                        "enabled": true,
                        "command": "node",
                        "args": ["dist/sidecar.js"],
                        "env": {
                            "MINI_TERM_SIDECAR_PROVIDER": "openai-compatible",
                            "MINI_TERM_SIDECAR_BASE_URL": "https://example.com/v1",
                            "MINI_TERM_SIDECAR_MODEL": "gpt-4.1-mini",
                            "MINI_TERM_SIDECAR_API_KEY": "secret-key",
                            "MINI_TERM_SIDECAR_PROVIDER_TIMEOUT_MS": "45000",
                            "MINI_TERM_SIDECAR_SYSTEM_PROMPT": "Reply plainly.",
                            "KEEP_ME": "1"
                        }
                    }
                }
            }))
            .unwrap(),
        );

        let sidecar = config.agent_backends.unwrap_or_default().claude_sidecar;
        assert_eq!(sidecar.provider.kind, "openai-compatible");
        assert_eq!(
            sidecar.provider.base_url.as_deref(),
            Some("https://example.com/v1")
        );
        assert_eq!(sidecar.provider.model.as_deref(), Some("gpt-4.1-mini"));
        assert_eq!(sidecar.provider.api_key.as_deref(), Some("secret-key"));
        assert_eq!(sidecar.provider.api_key_env_var.as_deref(), None);
        assert_eq!(sidecar.provider.timeout_ms, Some(45_000));
        assert_eq!(
            sidecar.provider.system_prompt.as_deref(),
            Some("Reply plainly.")
        );
        assert_eq!(sidecar.env.get("KEEP_ME").map(String::as_str), Some("1"));
    }

    #[test]
    fn normalize_sidecar_config_syncs_provider_fields_back_into_env() {
        let sidecar = normalize_sidecar_config(SidecarBackendConfig {
            enabled: true,
            command: Some("node".into()),
            args: vec!["dist/sidecar.js".into()],
            env: BTreeMap::from([("KEEP_ME".into(), "1".into())]),
            provider: SidecarProviderConfig {
                kind: "openai-compatible".into(),
                base_url: Some("https://api.openai.com/v1".into()),
                model: Some("gpt-4.1-mini".into()),
                api_key: Some("sk-test".into()),
                api_key_env_var: None,
                timeout_ms: Some(60_000),
                system_prompt: Some("Use plain text.".into()),
            },
            cwd: None,
            startup_mode: SidecarStartupMode::Process,
            connection_timeout_ms: 10_000,
        });

        assert_eq!(
            sidecar
                .env
                .get("MINI_TERM_SIDECAR_PROVIDER")
                .map(String::as_str),
            Some("openai-compatible")
        );
        assert_eq!(
            sidecar
                .env
                .get("MINI_TERM_SIDECAR_MODEL")
                .map(String::as_str),
            Some("gpt-4.1-mini")
        );
        assert_eq!(
            sidecar
                .env
                .get("MINI_TERM_SIDECAR_API_KEY")
                .map(String::as_str),
            Some("sk-test")
        );
        assert_eq!(
            sidecar
                .env
                .get("MINI_TERM_SIDECAR_PROVIDER_TIMEOUT_MS")
                .map(String::as_str),
            Some("60000")
        );
        assert_eq!(sidecar.env.get("KEEP_ME").map(String::as_str), Some("1"));
    }

    #[test]
    fn sidecar_provider_validation_rejects_missing_openai_fields() {
        let config = normalize_sidecar_config(SidecarBackendConfig {
            enabled: true,
            command: Some("node".into()),
            args: vec![],
            env: BTreeMap::new(),
            provider: SidecarProviderConfig {
                kind: "openai-compatible".into(),
                model: Some("gpt-4.1-mini".into()),
                api_key: None,
                api_key_env_var: None,
                base_url: None,
                timeout_ms: None,
                system_prompt: None,
            },
            cwd: None,
            startup_mode: SidecarStartupMode::Process,
            connection_timeout_ms: 10_000,
        });

        assert_eq!(
            config.provider_validation_error().as_deref(),
            Some("Sidecar provider `openai-compatible` requires an API key or API key env var.")
        );
        assert!(!config.is_launchable());
    }

    #[test]
    fn sidecar_provider_can_resolve_api_key_from_env_var_reference() {
        let _guard = env_lock().lock().unwrap();
        let env_var = "MINI_TERM_TEST_PROVIDER_API_KEY";
        std::env::set_var(env_var, "env-secret");
        let sidecar = normalize_sidecar_config(SidecarBackendConfig {
            enabled: true,
            command: Some("node".into()),
            args: vec![],
            env: BTreeMap::new(),
            provider: SidecarProviderConfig {
                kind: "openai-compatible".into(),
                model: Some("gpt-4.1-mini".into()),
                api_key: None,
                api_key_env_var: Some(env_var.into()),
                base_url: None,
                timeout_ms: None,
                system_prompt: None,
            },
            cwd: None,
            startup_mode: SidecarStartupMode::Process,
            connection_timeout_ms: 10_000,
        });

        assert_eq!(sidecar.provider.api_key_source(), "env-var");
        assert_eq!(
            sidecar.provider.resolved_api_key().as_deref(),
            Some("env-secret")
        );
        assert_eq!(
            sidecar
                .env
                .get("MINI_TERM_SIDECAR_API_KEY")
                .map(String::as_str),
            Some("env-secret")
        );
        assert!(sidecar.is_launchable());

        std::env::remove_var(env_var);
    }

    #[test]
    fn sidecar_provider_redacts_resolved_secret_values_from_text() {
        let _guard = env_lock().lock().unwrap();
        let env_var = "MINI_TERM_TEST_PROVIDER_API_KEY_REDACT";
        std::env::set_var(env_var, "env-secret-redact");
        let provider = SidecarProviderConfig {
            kind: "openai-compatible".into(),
            base_url: None,
            model: Some("gpt-4.1-mini".into()),
            api_key: Some("inline-secret".into()),
            api_key_env_var: Some(env_var.into()),
            timeout_ms: None,
            system_prompt: None,
        };

        let redacted =
            provider.redact_secrets_in_text("inline-secret and env-secret-redact should not leak");
        assert_eq!(redacted, "[redacted] and [redacted] should not leak");

        std::env::remove_var(env_var);
    }
}
