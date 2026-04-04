use serde::{Deserialize, Deserializer, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
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
    Leaf { pane: SavedPane },
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

fn config_path(app: &AppHandle) -> PathBuf {
    let dir = app.path().app_data_dir().expect("failed to get app data dir");
    fs::create_dir_all(&dir).ok();
    dir.join("config.json")
}

fn get_path_base_name(path: &str) -> String {
    path.rsplit(['\\', '/'])
        .find(|segment| !segment.is_empty())
        .unwrap_or(path)
        .to_string()
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
        path: primary_root.map(|root| root.path.clone()).unwrap_or_default(),
        saved_layout: workspace.saved_layout.clone(),
        expanded_dirs,
    }
}

fn normalize_workspace(mut workspace: WorkspaceConfig) -> WorkspaceConfig {
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
        workspace
            .expanded_dirs_by_root
            .entry(root.id.clone())
            .or_default();
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

fn migrate_config(mut config: AppConfig) -> AppConfig {
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

fn normalize_config(mut config: AppConfig) -> AppConfig {
    if config.workspaces.is_empty() && !config.projects.is_empty() {
        config.workspaces = config.projects.iter().map(project_to_workspace).collect();
    }

    config.workspaces = config
        .workspaces
        .into_iter()
        .map(normalize_workspace)
        .collect();

    config.recent_workspaces = config
        .recent_workspaces
        .into_iter()
        .map(normalize_recent_workspace)
        .collect();

    if config.last_workspace_id.is_none() {
        config.last_workspace_id = config.workspaces.first().map(|workspace| workspace.id.clone());
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
    match fs::read_to_string(&path) {
        Ok(content) => normalize_config(migrate_config(serde_json::from_str(&content).unwrap_or_default())),
        Err(_) => normalize_config(migrate_config(AppConfig::default())),
    }
}

#[tauri::command]
pub fn save_config(app: AppHandle, config: AppConfig) -> Result<(), String> {
    let path = config_path(&app);
    let config = normalize_config(migrate_config(config));
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_has_shells() {
        let config = AppConfig::default();
        assert!(!config.available_shells.is_empty());
        assert!(!config.default_shell.is_empty());
    }

    #[test]
    fn config_round_trip() {
        let config = AppConfig::default();
        let json = serde_json::to_string(&config).unwrap();
        let parsed: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.available_shells.len(), config.available_shells.len());
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
        assert!(args.iter().any(|arg| arg.contains("Set-PSReadLineKeyHandler")));
    }

    #[test]
    fn layout_round_trip() {
        let layout = SavedProjectLayout {
            tabs: vec![SavedTab {
                custom_title: Some("test".into()),
                split_layout: SavedSplitNode::Split {
                    direction: "horizontal".into(),
                    children: vec![
                        SavedSplitNode::Leaf { pane: SavedPane { shell_name: "cmd".into(), run_command: None, run_profile: None } },
                        SavedSplitNode::Leaf { pane: SavedPane { shell_name: "powershell".into(), run_command: None, run_profile: None } },
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
        let config = normalize_config(AppConfig {
            projects: vec![ProjectConfig {
                id: "workspace-1".into(),
                name: "mini-term".into(),
                path: "/tmp/mini-term".into(),
                saved_layout: None,
                expanded_dirs: vec!["/tmp/mini-term/src".into()],
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
            vec!["/tmp/mini-term/src".to_string()]
        );
        assert_eq!(config.last_workspace_id.as_deref(), Some("workspace-1"));
    }

    #[test]
    fn workspaces_round_trip_with_recent_entries() {
        let json = r##"{
            "workspaces": [{
                "id": "workspace-1",
                "name": "mini-term",
                "roots": [
                    {"id": "root-a", "name": "mini-term", "path": "/tmp/mini-term", "role": "member"},
                    {"id": "root-b", "name": "shared", "path": "/tmp/shared", "role": "primary"}
                ],
                "pinned": true,
                "accent": "#ff6600",
                "expandedDirsByRoot": {
                    "root-a": ["/tmp/mini-term/src"]
                },
                "createdAt": 100,
                "lastOpenedAt": 200
            }],
            "recentWorkspaces": [{
                "id": "recent-1",
                "name": "recent workspace",
                "rootPaths": ["/tmp/recent"],
                "lastOpenedAt": 300
            }],
            "lastWorkspaceId": "workspace-1",
            "defaultShell": "cmd",
            "availableShells": [{"name": "cmd", "command": "cmd"}]
        }"##;

        let config = normalize_config(serde_json::from_str(json).unwrap());

        assert_eq!(config.workspaces.len(), 1);
        assert_eq!(config.workspaces[0].roots[0].role, "member");
        assert_eq!(config.workspaces[0].roots[1].role, "primary");
        assert_eq!(config.recent_workspaces.len(), 1);
        assert_eq!(config.recent_workspaces[0].root_paths, vec!["/tmp/recent".to_string()]);
        assert_eq!(config.projects.len(), 1);
        assert_eq!(config.projects[0].path, "/tmp/shared");
    }
}
