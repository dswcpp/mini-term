use crate::agent_backends::{list_agent_backends_with_config, AgentBackendDescriptor};
use crate::agent_core::data_dir::config_path;
use crate::agent_core::models::TaskTarget;
use crate::ai_sessions::get_ai_sessions;
use crate::config::{
    load_config_from_path, save_config_to_path, AppConfig, ShellConfig, ThemeConfig,
};
use crate::mcp::meta::{build_server_info_payload, timestamp_ms};
use crate::mcp::registry::tool_definitions_with_meta;
use crate::runtime_mcp::load_runtime_state;
use serde::Deserialize;
use serde_json::{json, Value};

fn page_items<T: Clone>(
    items: &[T],
    cursor: Option<&str>,
    limit: usize,
    cursor_of: impl Fn(&T) -> String,
) -> Result<(Vec<T>, Option<String>), String> {
    let start = match cursor {
        Some(value) => items
            .iter()
            .position(|item| cursor_of(item) == value)
            .map(|index| index + 1)
            .ok_or_else(|| "cursor not found".to_string())?,
        None => 0,
    };
    let page = items
        .iter()
        .skip(start)
        .take(limit)
        .cloned()
        .collect::<Vec<_>>();
    let next_cursor = if start + page.len() < items.len() {
        page.last().map(cursor_of)
    } else {
        None
    };
    Ok((page, next_cursor))
}

fn parse_limit(
    object: &serde_json::Map<String, Value>,
    default_limit: usize,
    max_limit: usize,
) -> usize {
    object
        .get("limit")
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(default_limit)
        .clamp(1, max_limit)
}

fn backend_descriptor_value(backend: &AgentBackendDescriptor) -> Value {
    serde_json::to_value(backend).unwrap_or(Value::Null)
}

fn routing_target_config_view(
    backends: &[AgentBackendDescriptor],
    target: &TaskTarget,
    preferred_backend_id: Option<String>,
    allow_builtin_fallback: bool,
) -> Value {
    let preferred_backend = backends
        .iter()
        .find(|backend| backend.target == target.clone() && backend.preferred_for_target);
    let resolved_default = backends
        .iter()
        .find(|backend| backend.target == target.clone() && backend.default_for_target);

    json!({
        "preferredBackendId": preferred_backend_id,
        "allowBuiltinFallback": allow_builtin_fallback,
        "preferredBackend": preferred_backend.map(backend_descriptor_value),
        "resolvedDefault": resolved_default.map(backend_descriptor_value),
    })
}

fn config_view(config: &AppConfig) -> Value {
    let agent_backends = config.agent_backends.clone().unwrap_or_default();
    let backend_registry = list_agent_backends_with_config(config);
    let routing = &agent_backends.routing;
    let sidecar = &agent_backends.claude_sidecar;
    json!({
        "defaultShell": config.default_shell,
        "availableShells": config.available_shells,
        "uiFontSize": config.ui_font_size,
        "terminalFontSize": config.terminal_font_size,
        "layoutSizes": config.layout_sizes,
        "middleColumnSizes": config.middle_column_sizes,
        "workspaceSidebarSizes": config.workspace_sidebar_sizes,
        "theme": {
            "preset": config.theme.preset,
            "windowEffect": config.theme.window_effect,
        },
        "workspaceCount": config.workspaces.len(),
        "recentWorkspaceCount": config.recent_workspaces.len(),
        "agentBackends": {
            "routing": {
                "codex": routing_target_config_view(
                    &backend_registry,
                    &TaskTarget::Codex,
                    routing.codex.preferred_backend_id.clone(),
                    routing.codex.allow_builtin_fallback,
                ),
                "claude": routing_target_config_view(
                    &backend_registry,
                    &TaskTarget::Claude,
                    routing.claude.preferred_backend_id.clone(),
                    routing.claude.allow_builtin_fallback,
                ),
            },
            "registry": backend_registry
                .iter()
                .map(backend_descriptor_value)
                .collect::<Vec<_>>(),
            "claudeSidecar": {
                "enabled": sidecar.enabled,
                "startupMode": sidecar.startup_mode.clone(),
                "connectionTimeoutMs": sidecar.connection_timeout_ms,
                "commandConfigured": sidecar.command.is_some(),
                "cwdConfigured": sidecar.cwd.is_some(),
                "envEntryCount": sidecar.env.len(),
                "provider": {
                    "kind": sidecar.provider.normalized_kind(),
                    "baseUrl": sidecar.provider.base_url.clone(),
                    "model": sidecar.provider.model.clone(),
                    "timeoutMs": sidecar.provider.timeout_ms,
                    "systemPromptConfigured": sidecar.provider.system_prompt.is_some(),
                    "apiKeySource": sidecar.provider.api_key_source(),
                    "apiKeyEnvVar": sidecar.provider.api_key_env_var.clone(),
                }
            }
        },
    })
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThemePatch {
    preset: Option<String>,
    window_effect: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigPatch {
    default_shell: Option<String>,
    available_shells: Option<Vec<ShellConfig>>,
    ui_font_size: Option<f64>,
    terminal_font_size: Option<f64>,
    layout_sizes: Option<Vec<f64>>,
    middle_column_sizes: Option<Vec<f64>>,
    workspace_sidebar_sizes: Option<Vec<f64>>,
    theme: Option<ThemePatch>,
}

fn validate_shells(shells: &[ShellConfig]) -> Result<(), String> {
    if shells.is_empty() {
        return Err("availableShells must not be empty".to_string());
    }

    let mut seen = std::collections::BTreeSet::new();
    for shell in shells {
        if shell.name.trim().is_empty() {
            return Err("shell name must not be empty".to_string());
        }
        if shell.command.trim().is_empty() {
            return Err("shell command must not be empty".to_string());
        }
        if !seen.insert(shell.name.trim().to_ascii_lowercase()) {
            return Err("shell names must be unique".to_string());
        }
    }

    Ok(())
}

fn validate_size(name: &str, value: f64) -> Result<(), String> {
    if !value.is_finite() || !(8.0..=72.0).contains(&value) {
        return Err(format!("{name} must be between 8 and 72"));
    }
    Ok(())
}

fn validate_layout_sizes(name: &str, values: &[f64]) -> Result<(), String> {
    if values.is_empty() {
        return Err(format!("{name} must not be empty"));
    }
    if values
        .iter()
        .any(|value| !value.is_finite() || *value <= 0.0)
    {
        return Err(format!("{name} must contain positive finite numbers"));
    }
    Ok(())
}

fn apply_config_patch(config: &mut AppConfig, patch: ConfigPatch) -> Result<Vec<String>, String> {
    let mut changed_fields = Vec::new();

    if let Some(shells) = patch.available_shells {
        validate_shells(&shells)?;
        config.available_shells = shells;
        changed_fields.push("availableShells".to_string());
    }

    if let Some(default_shell) = patch.default_shell {
        if !config
            .available_shells
            .iter()
            .any(|shell| shell.name == default_shell)
        {
            return Err("defaultShell must match an available shell name".to_string());
        }
        config.default_shell = default_shell;
        changed_fields.push("defaultShell".to_string());
    }

    if let Some(value) = patch.ui_font_size {
        validate_size("uiFontSize", value)?;
        config.ui_font_size = value;
        changed_fields.push("uiFontSize".to_string());
    }

    if let Some(value) = patch.terminal_font_size {
        validate_size("terminalFontSize", value)?;
        config.terminal_font_size = value;
        changed_fields.push("terminalFontSize".to_string());
    }

    if let Some(values) = patch.layout_sizes {
        validate_layout_sizes("layoutSizes", &values)?;
        config.layout_sizes = Some(values);
        changed_fields.push("layoutSizes".to_string());
    }

    if let Some(values) = patch.middle_column_sizes {
        validate_layout_sizes("middleColumnSizes", &values)?;
        config.middle_column_sizes = Some(values);
        changed_fields.push("middleColumnSizes".to_string());
    }

    if let Some(values) = patch.workspace_sidebar_sizes {
        validate_layout_sizes("workspaceSidebarSizes", &values)?;
        config.workspace_sidebar_sizes = Some(values);
        changed_fields.push("workspaceSidebarSizes".to_string());
    }

    if let Some(theme) = patch.theme {
        let next_theme = ThemeConfig {
            preset: theme.preset.unwrap_or_else(|| config.theme.preset.clone()),
            window_effect: theme
                .window_effect
                .unwrap_or_else(|| config.theme.window_effect.clone()),
        };
        config.theme = next_theme;
        changed_fields.push("theme".to_string());
    }

    if changed_fields.is_empty() {
        return Err("patch must include at least one supported field".to_string());
    }

    Ok(changed_fields)
}

pub fn ping_tool(_: Value) -> Result<Value, String> {
    Ok(json!({
        "status": "ok",
        "timestamp": timestamp_ms(),
    }))
}

pub fn server_info_tool(_: Value) -> Result<Value, String> {
    Ok(build_server_info_payload())
}

pub fn list_tools_tool(args: Value) -> Result<Value, String> {
    let object = args.as_object().cloned().unwrap_or_default();
    let group = object.get("group").and_then(Value::as_str);
    let limit = parse_limit(&object, 50, 200);
    let cursor = object.get("cursor").and_then(Value::as_str);
    let tools = tool_definitions_with_meta()
        .into_iter()
        .filter(|item| {
            group
                .map(|expected| item["group"].as_str() == Some(expected))
                .unwrap_or(true)
        })
        .collect::<Vec<_>>();
    let (items, next_cursor) = page_items(&tools, cursor, limit, |item| {
        item["name"].as_str().unwrap_or_default().to_string()
    })?;
    Ok(json!({
        "items": items,
        "nextCursor": next_cursor,
    }))
}

pub fn list_ptys_tool(args: Value) -> Result<Value, String> {
    let object = args.as_object().cloned().unwrap_or_default();
    let limit = parse_limit(&object, 50, 200);
    let cursor = object.get("cursor").and_then(Value::as_str);
    let state = load_runtime_state();
    let mut items = state.ptys;
    items.sort_by_key(|item| item.pty_id);
    let (page, next_cursor) = page_items(&items, cursor, limit, |item| item.pty_id.to_string())?;
    let page = page
        .into_iter()
        .map(|item| {
            json!({
                "ptyId": item.pty_id,
                "sessionId": item.session_id,
                "shell": item.shell,
                "shellKind": item.shell_kind,
                "cwd": item.cwd,
                "rootPath": item.root_path,
                "mode": item.mode,
                "phase": item.phase,
                "status": item.status,
                "lastOutputAt": item.last_output_at,
                "outputPreview": item.output_preview,
                "createdAt": item.created_at,
                "updatedAt": item.updated_at,
                "exitCode": item.exit_code,
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "items": page,
        "nextCursor": next_cursor,
        "watcherCount": state.watchers.len(),
    }))
}

pub fn list_fs_watches_tool(args: Value) -> Result<Value, String> {
    let object = args.as_object().cloned().unwrap_or_default();
    let limit = parse_limit(&object, 50, 200);
    let cursor = object.get("cursor").and_then(Value::as_str);
    let state = load_runtime_state();
    let mut items = state.watchers;
    items.sort_by(|a, b| a.watch_path.cmp(&b.watch_path));
    let (page, next_cursor) = page_items(&items, cursor, limit, |item| item.watch_path.clone())?;
    Ok(json!({
        "items": page,
        "nextCursor": next_cursor,
        "ptyCount": state.ptys.len(),
    }))
}

pub fn get_recent_events_tool(args: Value) -> Result<Value, String> {
    let object = args.as_object().cloned().unwrap_or_default();
    let limit = parse_limit(&object, 50, 200);
    let cursor = object.get("cursor").and_then(Value::as_str);
    let kinds = object.get("kinds").and_then(Value::as_array).map(|values| {
        values
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect::<Vec<_>>()
    });
    let since = object.get("since").and_then(Value::as_u64);

    let state = load_runtime_state();
    let mut items = state
        .recent_events
        .into_iter()
        .filter(|event| {
            let kind_match = kinds
                .as_ref()
                .map(|expected| expected.iter().any(|value| value == &event.kind))
                .unwrap_or(true);
            let since_match = since.map(|value| event.timestamp >= value).unwrap_or(true);
            kind_match && since_match
        })
        .collect::<Vec<_>>();
    items.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    let (page, next_cursor) = page_items(&items, cursor, limit, |item| item.event_id.clone())?;
    Ok(json!({
        "items": page,
        "nextCursor": next_cursor,
    }))
}

pub fn get_ai_sessions_tool(args: Value) -> Result<Value, String> {
    let object = args.as_object().cloned().unwrap_or_default();
    let limit = parse_limit(&object, 50, 200);
    let cursor = object.get("cursor").and_then(Value::as_str);
    let workspace_id = object.get("workspaceId").and_then(Value::as_str);
    let config = load_config_from_path(&config_path());
    let project_paths = if let Some(workspace_id) = workspace_id {
        let workspace = config
            .workspaces
            .iter()
            .find(|workspace| workspace.id == workspace_id)
            .ok_or_else(|| format!("workspace not found: {workspace_id}"))?;
        workspace
            .roots
            .iter()
            .map(|root| root.path.clone())
            .collect::<Vec<_>>()
    } else {
        config
            .workspaces
            .iter()
            .flat_map(|workspace| workspace.roots.iter().map(|root| root.path.clone()))
            .collect::<Vec<_>>()
    };

    let mut sessions = get_ai_sessions(project_paths)?;
    sessions.sort_by(|a, b| b.timestamp.cmp(&a.timestamp).then_with(|| a.id.cmp(&b.id)));
    let (items, next_cursor) = page_items(&sessions, cursor, limit, |item| item.id.clone())?;
    Ok(json!({
        "items": items,
        "nextCursor": next_cursor,
    }))
}

pub fn get_config_tool(args: Value) -> Result<Value, String> {
    let object = args.as_object().cloned().unwrap_or_default();
    let sections = object
        .get("sections")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_else(|| vec!["shells", "theme", "layout", "workspaceSummary"]);
    let config = load_config_from_path(&config_path());
    Ok(json!({
        "sections": sections,
        "config": config_view(&config),
    }))
}

pub fn set_config_fields_tool(args: Value) -> Result<Value, String> {
    let object = args.as_object().cloned().unwrap_or_default();
    let dry_run = object
        .get("dryRun")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let patch_value = object.get("patch").cloned().ok_or("patch is required")?;
    let patch: ConfigPatch =
        serde_json::from_value(patch_value).map_err(|_| "patch is invalid".to_string())?;
    let path = config_path();
    let mut config = load_config_from_path(&path);
    let changed_fields = apply_config_patch(&mut config, patch)?;

    if !dry_run {
        save_config_to_path(&path, config.clone())?;
    }

    Ok(json!({
        "dryRun": dry_run,
        "changedFields": changed_fields,
        "config": config_view(&config),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_backends::{backend_runtime_test_lock, clear_backend_runtime_state};
    use crate::config::{
        load_config_from_path, save_config_to_path, AgentBackendRoutingConfig, AgentBackendsConfig,
        SidecarBackendConfig, SidecarProviderConfig, SidecarStartupMode,
        TaskTargetBackendRoutingConfig,
    };
    use crate::mcp::tools::test_support::TestHarness;
    use crate::runtime_mcp::{
        write_runtime_state_for_tests, RuntimeEvent, RuntimeHostInfo, RuntimeMcpState,
        RuntimePtySnapshot, RuntimeWatcherSnapshot,
    };
    use serde_json::json;
    use std::fs::{self, File};
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(prefix: &str) -> Self {
            let unique = format!(
                "{}-{}-{}",
                prefix,
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .expect("system time should be after epoch")
                    .as_nanos()
            );
            let path = std::env::temp_dir().join(unique);
            fs::create_dir_all(&path).expect("failed to create temp dir");
            Self { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn write_lines(path: &Path, lines: &[String]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("failed to create parent dir");
        }

        let mut file = File::create(path).expect("failed to create file");
        for line in lines {
            writeln!(file, "{line}").expect("failed to write line");
        }
    }

    fn encode_project_path(project_path: &str) -> String {
        project_path.replace(':', "-").replace(['\\', '/'], "-")
    }

    #[test]
    fn ping_tool_returns_ok_status_and_timestamp() {
        let _harness = TestHarness::new("runtime-ping");
        let value = ping_tool(json!({})).unwrap();
        assert_eq!(value["status"], "ok");
        assert!(value["timestamp"].as_u64().is_some());
    }

    #[test]
    fn get_config_returns_requested_sections_and_config_view() {
        let _harness = TestHarness::new("runtime-get-config");
        let value = get_config_tool(json!({
            "sections": ["shells", "theme"]
        }))
        .unwrap();

        assert_eq!(value["sections"], json!(["shells", "theme"]));
        assert_eq!(value["config"]["defaultShell"], "powershell");
        assert_eq!(value["config"]["workspaceCount"], 1);
        assert_eq!(value["config"]["availableShells"][0]["name"], "powershell");
        assert!(value["config"]["theme"]["preset"].as_str().is_some());
        assert!(value["config"]["theme"]["windowEffect"].as_str().is_some());
        assert_eq!(value["config"]["recentWorkspaceCount"], 0);
        assert!(value["config"]["availableShells"][0]["command"]
            .as_str()
            .is_some());
        assert_eq!(
            value["config"]["agentBackends"]["claudeSidecar"]["provider"]["kind"],
            "reference"
        );
        assert_eq!(
            value["config"]["agentBackends"]["claudeSidecar"]["provider"]["apiKeySource"],
            "missing"
        );
        assert_eq!(
            value["config"]["agentBackends"]["routing"]["codex"]["preferredBackendId"],
            "codex-cli"
        );
        assert_eq!(
            value["config"]["agentBackends"]["routing"]["claude"]["preferredBackendId"],
            "claude-cli"
        );
        assert_eq!(
            value["config"]["agentBackends"]["routing"]["codex"]["resolvedDefault"]["backendId"],
            "codex-cli"
        );
        assert_eq!(
            value["config"]["agentBackends"]["routing"]["claude"]["resolvedDefault"]["backendId"],
            "claude-cli"
        );
        assert_eq!(
            value["config"]["agentBackends"]["registry"]
                .as_array()
                .map(|items| items.len()),
            Some(3)
        );
    }

    #[test]
    fn get_config_includes_backend_routing_diagnostics() {
        let _guard = backend_runtime_test_lock().lock().unwrap();
        clear_backend_runtime_state("claude-sidecar");
        let _harness = TestHarness::new("runtime-get-config-routing");
        let config_path = config_path();
        let mut config = load_config_from_path(&config_path);
        config.agent_backends = Some(AgentBackendsConfig {
            routing: AgentBackendRoutingConfig {
                codex: AgentBackendRoutingConfig::default().codex,
                claude: TaskTargetBackendRoutingConfig {
                    preferred_backend_id: Some("claude-sidecar".into()),
                    allow_builtin_fallback: true,
                },
            },
            claude_sidecar: SidecarBackendConfig {
                enabled: true,
                command: Some("node".into()),
                args: vec!["dist/sidecar.js".into()],
                env: Default::default(),
                provider: SidecarProviderConfig::default(),
                cwd: None,
                startup_mode: SidecarStartupMode::Process,
                connection_timeout_ms: 2_000,
            },
        });
        save_config_to_path(&config_path, config).unwrap();

        let value = get_config_tool(json!({})).unwrap();

        assert_eq!(
            value["config"]["agentBackends"]["routing"]["claude"]["preferredBackend"]["backendId"],
            "claude-sidecar"
        );
        assert_eq!(
            value["config"]["agentBackends"]["routing"]["claude"]["resolvedDefault"]["backendId"],
            "claude-cli"
        );
        assert!(
            value["config"]["agentBackends"]["routing"]["claude"]["resolvedDefault"]
                ["routingStatusMessage"]
                .as_str()
                .unwrap_or_default()
                .contains("preferred backend `claude-sidecar`")
        );
        assert!(
            value["config"]["agentBackends"]["routing"]["claude"]["preferredBackend"]
                ["routingStatusMessage"]
                .as_str()
                .unwrap_or_default()
                .contains("falling back")
        );
    }

    #[test]
    fn list_ptys_returns_seeded_runtime_entries() {
        let harness = TestHarness::new("runtime-ptys");
        write_runtime_state_for_tests(RuntimeMcpState {
            host: Some(RuntimeHostInfo {
                app_version: "0.2.3".into(),
                desktop_pid: 1,
                transport_mode: "app-data-snapshot".into(),
                last_heartbeat_at: timestamp_ms(),
                host_control: None,
            }),
            ptys: vec![RuntimePtySnapshot {
                pty_id: 7,
                session_id: "session-7".into(),
                shell: "powershell".into(),
                shell_kind: "powershell".into(),
                cwd: harness.workspace_path(),
                root_path: harness.workspace_path(),
                mode: "human".into(),
                phase: "running".into(),
                status: "running".into(),
                last_output_at: Some(timestamp_ms()),
                output_preview: "hello".into(),
                output_tail: "hello".into(),
                startup_output: String::new(),
                cols: 120,
                rows: 32,
                root_pid: None,
                created_at: 1,
                updated_at: 2,
                exit_code: None,
            }],
            ..RuntimeMcpState::default()
        });

        let value = list_ptys_tool(json!({})).unwrap();
        assert_eq!(value["items"][0]["ptyId"], 7);
    }

    #[test]
    fn get_recent_events_supports_limit() {
        let _harness = TestHarness::new("runtime-events");
        write_runtime_state_for_tests(RuntimeMcpState {
            recent_events: vec![
                RuntimeEvent {
                    event_id: "evt-1".into(),
                    kind: "pty-output".into(),
                    timestamp: 1,
                    summary: "one".into(),
                    payload_preview: None,
                },
                RuntimeEvent {
                    event_id: "evt-2".into(),
                    kind: "fs-change".into(),
                    timestamp: 2,
                    summary: "two".into(),
                    payload_preview: None,
                },
            ],
            ..RuntimeMcpState::default()
        });

        let value = get_recent_events_tool(json!({ "limit": 1 })).unwrap();
        assert_eq!(value["items"].as_array().map(|items| items.len()), Some(1));
        assert_eq!(value["nextCursor"], "evt-2");
    }

    #[test]
    fn list_fs_watches_returns_seeded_runtime_entries() {
        let harness = TestHarness::new("runtime-watchers");
        write_runtime_state_for_tests(RuntimeMcpState {
            watchers: vec![RuntimeWatcherSnapshot {
                watch_path: harness.workspace_path(),
                project_path: harness.workspace_path(),
                recursive: true,
                updated_at: timestamp_ms(),
            }],
            ..RuntimeMcpState::default()
        });

        let value = list_fs_watches_tool(json!({})).unwrap();
        assert_eq!(value["items"][0]["watchPath"], harness.workspace_path());
        assert_eq!(value["ptyCount"], 0);
    }

    #[test]
    fn get_recent_events_rejects_unknown_cursor() {
        let _harness = TestHarness::new("runtime-events-bad-cursor");
        write_runtime_state_for_tests(RuntimeMcpState {
            recent_events: vec![RuntimeEvent {
                event_id: "evt-1".into(),
                kind: "pty-output".into(),
                timestamp: 1,
                summary: "one".into(),
                payload_preview: None,
            }],
            ..RuntimeMcpState::default()
        });

        let error = get_recent_events_tool(json!({
            "cursor": "missing-cursor"
        }))
        .unwrap_err();
        assert_eq!(error, "cursor not found");
    }

    #[test]
    fn list_fs_watches_rejects_unknown_cursor() {
        let harness = TestHarness::new("runtime-watchers-bad-cursor");
        write_runtime_state_for_tests(RuntimeMcpState {
            watchers: vec![RuntimeWatcherSnapshot {
                watch_path: harness.workspace_path(),
                project_path: harness.workspace_path(),
                recursive: true,
                updated_at: timestamp_ms(),
            }],
            ..RuntimeMcpState::default()
        });

        let error = list_fs_watches_tool(json!({
            "cursor": "missing-cursor"
        }))
        .unwrap_err();
        assert_eq!(error, "cursor not found");
    }

    #[test]
    fn list_ptys_rejects_unknown_cursor() {
        let harness = TestHarness::new("runtime-ptys-bad-cursor");
        write_runtime_state_for_tests(RuntimeMcpState {
            ptys: vec![RuntimePtySnapshot {
                pty_id: 7,
                session_id: "session-7".into(),
                shell: "powershell".into(),
                shell_kind: "powershell".into(),
                cwd: harness.workspace_path(),
                root_path: harness.workspace_path(),
                mode: "human".into(),
                phase: "running".into(),
                status: "running".into(),
                last_output_at: Some(timestamp_ms()),
                output_preview: "hello".into(),
                output_tail: "hello".into(),
                startup_output: String::new(),
                cols: 120,
                rows: 32,
                root_pid: None,
                created_at: 1,
                updated_at: 2,
                exit_code: None,
            }],
            ..RuntimeMcpState::default()
        });

        let error = list_ptys_tool(json!({
            "cursor": "missing-cursor"
        }))
        .unwrap_err();
        assert_eq!(error, "cursor not found");
    }

    #[test]
    fn server_info_reports_stale_host_snapshot() {
        let _harness = TestHarness::new("runtime-server-info-stale");
        write_runtime_state_for_tests(RuntimeMcpState {
            host: Some(RuntimeHostInfo {
                app_version: "9.9.9-host".into(),
                desktop_pid: 4242,
                transport_mode: "app-data-snapshot".into(),
                last_heartbeat_at: 1,
                host_control: None,
            }),
            ..RuntimeMcpState::default()
        });

        let value = server_info_tool(json!({})).unwrap();
        assert_eq!(value["appVersion"], "9.9.9-host");
        assert_eq!(value["hostConnection"]["status"], "stale");
        assert_eq!(value["hostConnection"]["controlStatus"], "snapshot-only");
        assert_eq!(value["hostConnection"]["mode"], "app-data-snapshot");
        assert_eq!(value["runtime"]["degradationMode"], "stale-snapshot-only");
        assert_eq!(value["diagnostics"][0]["code"], "HOST_STALE");
    }

    #[test]
    fn list_tools_rejects_unknown_cursor() {
        let _harness = TestHarness::new("runtime-tools-bad-cursor");

        let error = list_tools_tool(json!({
            "cursor": "missing-cursor"
        }))
        .unwrap_err();
        assert_eq!(error, "cursor not found");
    }

    #[test]
    fn get_ai_sessions_supports_pagination_and_bad_cursor() {
        let harness = TestHarness::new("runtime-ai-sessions");
        let home = TempDir::new("runtime-ai-sessions-home");
        let project_path = harness.workspace_path();

        let claude_session_path = home
            .path
            .join(".claude")
            .join("projects")
            .join(encode_project_path(&project_path))
            .join("claude-1.jsonl");
        write_lines(
            &claude_session_path,
            &[r#"{"type":"user","timestamp":"2026-04-01T09:30:00Z","message":{"content":"Claude first prompt"}}"#.to_string()],
        );

        let codex_index_path = home.path.join(".codex").join("session_index.jsonl");
        write_lines(
            &codex_index_path,
            &[r#"{"id":"codex-1","thread_name":"Codex Thread"}"#.to_string()],
        );

        let project_path_json =
            serde_json::to_string(&project_path).expect("failed to serialize project path");
        let codex_session_path = home
            .path
            .join(".codex")
            .join("sessions")
            .join("2026")
            .join("04")
            .join("04")
            .join("codex-1.jsonl");
        write_lines(
            &codex_session_path,
            &[format!(
                r#"{{"type":"session_meta","payload":{{"cwd":{project_path_json},"id":"codex-1","timestamp":"2026-04-04T12:00:00Z"}}}}"#
            )],
        );

        std::env::set_var("MINI_TERM_HOME_DIR", &home.path);
        let first_page = get_ai_sessions_tool(json!({ "limit": 1 })).unwrap();
        let second_page = get_ai_sessions_tool(json!({
            "limit": 1,
            "cursor": first_page["nextCursor"].clone(),
        }))
        .unwrap();
        let bad_cursor = get_ai_sessions_tool(json!({
            "cursor": "missing-cursor"
        }))
        .unwrap_err();
        std::env::remove_var("MINI_TERM_HOME_DIR");

        assert_eq!(first_page["items"][0]["sessionType"], "codex");
        assert_eq!(first_page["items"][0]["title"], "Codex Thread");
        assert_eq!(first_page["nextCursor"], "codex-1");
        assert_eq!(second_page["items"][0]["sessionType"], "claude");
        assert_eq!(second_page["items"][0]["title"], "Claude first prompt");
        assert_eq!(second_page["nextCursor"], Value::Null);
        assert_eq!(bad_cursor, "cursor not found");
    }

    #[test]
    fn set_config_fields_supports_dry_run() {
        let harness = TestHarness::new("runtime-config");
        let value = set_config_fields_tool(json!({
            "dryRun": true,
            "patch": {
                "uiFontSize": 16,
                "terminalFontSize": 18
            }
        }))
        .unwrap();

        assert_eq!(value["dryRun"], true);
        let config = load_config_from_path(&config_path());
        assert_ne!(config.ui_font_size, 16.0);
        drop(harness);
    }

    #[test]
    fn set_config_fields_requires_supported_patch() {
        let _harness = TestHarness::new("runtime-config-invalid");
        let error = set_config_fields_tool(json!({
            "patch": {}
        }))
        .unwrap_err();

        assert_eq!(error, "patch must include at least one supported field");
    }

    // ── page_items unit tests ─────────────────────────────────────────────────

    #[test]
    fn page_items_first_page_no_cursor() {
        let items: Vec<i32> = (1..=10).collect();
        let (page, next) = page_items(&items, None, 3, |i| i.to_string()).unwrap();
        assert_eq!(page, vec![1, 2, 3]);
        assert_eq!(next.as_deref(), Some("3"));
    }

    #[test]
    fn page_items_second_page_via_cursor() {
        let items: Vec<i32> = (1..=10).collect();
        let (page, next) = page_items(&items, Some("3"), 3, |i| i.to_string()).unwrap();
        assert_eq!(page, vec![4, 5, 6]);
        assert_eq!(next.as_deref(), Some("6"));
    }

    #[test]
    fn page_items_last_page_returns_no_next_cursor() {
        let items: Vec<i32> = (1..=5).collect();
        let (page, next) = page_items(&items, Some("4"), 3, |i| i.to_string()).unwrap();
        assert_eq!(page, vec![5]);
        assert!(next.is_none());
    }

    #[test]
    fn page_items_exact_page_boundary_returns_no_next_cursor() {
        // Requesting exactly the remaining items: no next cursor.
        let items: Vec<i32> = (1..=6).collect();
        let (page, next) = page_items(&items, None, 6, |i| i.to_string()).unwrap();
        assert_eq!(page.len(), 6);
        assert!(next.is_none());
    }

    #[test]
    fn page_items_invalid_cursor_returns_error() {
        let items: Vec<i32> = (1..=5).collect();
        let err = page_items(&items, Some("999"), 3, |i| i.to_string()).unwrap_err();
        assert_eq!(err, "cursor not found");
    }

    #[test]
    fn page_items_empty_list_no_cursor_returns_empty() {
        let items: Vec<i32> = vec![];
        let (page, next) = page_items(&items, None, 10, |i| i.to_string()).unwrap();
        assert!(page.is_empty());
        assert!(next.is_none());
    }

    #[test]
    fn list_tools_tool_supports_group_filter() {
        let _harness = TestHarness::new("runtime-tools-group-filter");
        let result = list_tools_tool(json!({ "group": "core-runtime" })).unwrap();
        let tools = result["items"].as_array().expect("items should be array");
        assert!(!tools.is_empty());
        assert!(tools.iter().all(|t| t["group"] == "core-runtime"));
    }
}
