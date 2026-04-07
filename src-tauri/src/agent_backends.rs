use crate::agent_core::data_dir::config_path;
use crate::agent_core::models::TaskTarget;
use crate::agent_tool_broker::{
    SIDECAR_APPROVAL_FLOW_NOTES, SIDECAR_RESERVED_TOOL_NAMES, SIDECAR_TOOL_CALL_AUTHORITY,
    SIDECAR_TOOL_CALL_NOTES,
};
use crate::config::{load_config_from_path, AppConfig, SidecarBackendConfig, SidecarStartupMode};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AgentBackendKind {
    BuiltinCli,
    Sidecar,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AgentBackendTransport {
    PtyCommand,
    SidecarRpc,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentBackendRuntimeStatus {
    Unconfigured,
    Configured,
    Starting,
    Ready,
    Degraded,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentBackendCapabilities {
    pub supports_workers: bool,
    pub supports_resume: bool,
    pub supports_tool_calls: bool,
    pub brokered_tools: bool,
    pub brokered_approvals: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub restricted_tool_names: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_authority: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_flow_notes: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct StaticAgentBackendCapabilities {
    supports_workers: bool,
    supports_resume: bool,
    supports_tool_calls: bool,
    brokered_tools: bool,
    brokered_approvals: bool,
    restricted_tool_names: &'static [&'static str],
    tool_call_authority: Option<&'static str>,
    tool_call_notes: Option<&'static str>,
    approval_flow_notes: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentBackendDescriptor {
    pub backend_id: String,
    pub display_name: String,
    pub target: TaskTarget,
    pub preferred_for_target: bool,
    pub default_for_target: bool,
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cli_command: Option<String>,
    pub description: String,
    pub builtin: bool,
    pub kind: AgentBackendKind,
    pub transport: AgentBackendTransport,
    pub capabilities: AgentBackendCapabilities,
    pub configured: bool,
    pub available: bool,
    pub status: AgentBackendRuntimeStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routing_status_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_handshake_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct StaticAgentBackend {
    backend_id: &'static str,
    display_name: &'static str,
    target: TaskTarget,
    provider: &'static str,
    cli_command: Option<&'static str>,
    description: &'static str,
    builtin: bool,
    kind: AgentBackendKind,
    transport: AgentBackendTransport,
    capabilities: StaticAgentBackendCapabilities,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AgentBackendRuntimeRecord {
    config_signature: String,
    status: AgentBackendRuntimeStatus,
    status_message: Option<String>,
    last_error: Option<String>,
    last_handshake_at: Option<u64>,
    runtime_capabilities: Option<AgentBackendCapabilities>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AgentBackendRuntimeView {
    configured: bool,
    available: bool,
    status: AgentBackendRuntimeStatus,
    status_message: Option<String>,
    last_error: Option<String>,
    last_handshake_at: Option<u64>,
    runtime_capabilities: Option<AgentBackendCapabilities>,
}

const BUILTIN_CLI_CAPABILITIES: StaticAgentBackendCapabilities = StaticAgentBackendCapabilities {
    supports_workers: true,
    supports_resume: true,
    supports_tool_calls: true,
    brokered_tools: true,
    brokered_approvals: true,
    restricted_tool_names: &[],
    tool_call_authority: Some("mini-term"),
    tool_call_notes: Some(
        "Built-in CLI backends are launched and tracked by Mini-Term. They do not use a sidecar RPC broker path.",
    ),
    approval_flow_notes: Some(
        "Approval-gated actions still pause in Mini-Term Inbox before execution continues.",
    ),
};

const CLAUDE_SIDECAR_CAPABILITIES: StaticAgentBackendCapabilities =
    StaticAgentBackendCapabilities {
        supports_workers: true,
        supports_resume: true,
        supports_tool_calls: true,
        brokered_tools: true,
        brokered_approvals: true,
        restricted_tool_names: SIDECAR_RESERVED_TOOL_NAMES,
        tool_call_authority: Some(SIDECAR_TOOL_CALL_AUTHORITY),
        tool_call_notes: Some(SIDECAR_TOOL_CALL_NOTES),
        approval_flow_notes: Some(SIDECAR_APPROVAL_FLOW_NOTES),
    };

const AGENT_BACKENDS: [StaticAgentBackend; 3] = [
    StaticAgentBackend {
        backend_id: "codex-cli",
        display_name: "Codex CLI",
        target: TaskTarget::Codex,
        provider: "OpenAI",
        cli_command: Some("codex"),
        description: "Built-in Codex CLI task backend managed by Mini-Term.",
        builtin: true,
        kind: AgentBackendKind::BuiltinCli,
        transport: AgentBackendTransport::PtyCommand,
        capabilities: BUILTIN_CLI_CAPABILITIES,
    },
    StaticAgentBackend {
        backend_id: "claude-cli",
        display_name: "Claude CLI",
        target: TaskTarget::Claude,
        provider: "Anthropic",
        cli_command: Some("claude"),
        description: "Built-in Claude CLI task backend managed by Mini-Term.",
        builtin: true,
        kind: AgentBackendKind::BuiltinCli,
        transport: AgentBackendTransport::PtyCommand,
        capabilities: BUILTIN_CLI_CAPABILITIES,
    },
    StaticAgentBackend {
        backend_id: "claude-sidecar",
        display_name: "Claude Sidecar",
        target: TaskTarget::Claude,
        provider: "External",
        cli_command: None,
        description:
            "Reserved sidecar backend slot for a Claude-compatible runtime integrated behind Mini-Term's control plane.",
        builtin: false,
        kind: AgentBackendKind::Sidecar,
        transport: AgentBackendTransport::SidecarRpc,
        capabilities: CLAUDE_SIDECAR_CAPABILITIES,
    },
];

fn runtime_records() -> &'static Mutex<HashMap<String, AgentBackendRuntimeRecord>> {
    static STORE: OnceLock<Mutex<HashMap<String, AgentBackendRuntimeRecord>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(test)]
pub(crate) fn backend_runtime_test_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn load_current_config() -> AppConfig {
    load_config_from_path(&config_path())
}

fn current_sidecar_config(config: &AppConfig, backend_id: &str) -> Option<SidecarBackendConfig> {
    match backend_id {
        "claude-sidecar" => Some(
            config
                .agent_backends
                .clone()
                .unwrap_or_default()
                .claude_sidecar,
        ),
        _ => None,
    }
}

fn current_backend_routing(
    config: &AppConfig,
    target: &TaskTarget,
) -> crate::config::TaskTargetBackendRoutingConfig {
    let routing = config.agent_backends.clone().unwrap_or_default().routing;
    match target {
        TaskTarget::Codex => routing.codex,
        TaskTarget::Claude => routing.claude,
    }
}

fn config_signature_for_backend(config: &AppConfig, backend_id: &str) -> String {
    match current_sidecar_config(config, backend_id) {
        Some(sidecar) => serde_json::to_string(&sidecar).unwrap_or_else(|_| backend_id.to_string()),
        None => backend_id.to_string(),
    }
}

fn configured_status_message(config: &SidecarBackendConfig) -> String {
    let provider = config.provider.display_label();
    match config.startup_mode {
        SidecarStartupMode::Loopback => format!(
            "Loopback sidecar is configured for provider {provider}. Run Test Launch to verify handshake."
        ),
        SidecarStartupMode::Process => format!(
            "Sidecar command is configured for provider {provider}: {}. Run Test Launch to verify handshake.",
            config.command.clone().unwrap_or_default(),
        ),
    }
}

fn unconfigured_status_message(config: &SidecarBackendConfig) -> String {
    config
        .launch_validation_error()
        .unwrap_or_else(|| "Sidecar backend is not configured.".to_string())
}

fn runtime_view_for_backend(
    backend: &StaticAgentBackend,
    config: &AppConfig,
) -> AgentBackendRuntimeView {
    if backend.kind == AgentBackendKind::BuiltinCli {
        return AgentBackendRuntimeView {
            configured: true,
            available: true,
            status: AgentBackendRuntimeStatus::Ready,
            status_message: Some("Built-in backend managed by Mini-Term.".to_string()),
            last_error: None,
            last_handshake_at: None,
            runtime_capabilities: None,
        };
    }

    let sidecar_config = current_sidecar_config(config, backend.backend_id).unwrap_or_default();
    let configured = sidecar_config.is_launchable();
    let base_status = if configured {
        AgentBackendRuntimeStatus::Configured
    } else {
        AgentBackendRuntimeStatus::Unconfigured
    };
    let base_message = if configured {
        configured_status_message(&sidecar_config)
    } else {
        unconfigured_status_message(&sidecar_config)
    };

    let signature = config_signature_for_backend(config, backend.backend_id);
    let record = runtime_records()
        .lock()
        .unwrap()
        .get(backend.backend_id)
        .cloned()
        .filter(|item| item.config_signature == signature);

    if let Some(record) = record {
        return AgentBackendRuntimeView {
            configured,
            available: matches!(record.status, AgentBackendRuntimeStatus::Ready),
            status: record.status,
            status_message: record.status_message.or(Some(base_message)),
            last_error: record.last_error,
            last_handshake_at: record.last_handshake_at,
            runtime_capabilities: record.runtime_capabilities,
        };
    }

    AgentBackendRuntimeView {
        configured,
        available: false,
        status: base_status,
        status_message: Some(base_message),
        last_error: None,
        last_handshake_at: None,
        runtime_capabilities: None,
    }
}

fn static_backend_descriptor(
    backend: StaticAgentBackend,
    config: &AppConfig,
    preferred_for_target: bool,
    default_for_target: bool,
    routing_status_message: Option<String>,
) -> AgentBackendDescriptor {
    let runtime = runtime_view_for_backend(&backend, config);
    let capabilities = runtime
        .runtime_capabilities
        .unwrap_or(AgentBackendCapabilities {
            supports_workers: backend.capabilities.supports_workers,
            supports_resume: backend.capabilities.supports_resume,
            supports_tool_calls: backend.capabilities.supports_tool_calls,
            brokered_tools: backend.capabilities.brokered_tools,
            brokered_approvals: backend.capabilities.brokered_approvals,
            restricted_tool_names: backend
                .capabilities
                .restricted_tool_names
                .iter()
                .map(|name| (*name).to_string())
                .collect(),
            tool_call_authority: backend.capabilities.tool_call_authority.map(str::to_string),
            tool_call_notes: backend.capabilities.tool_call_notes.map(str::to_string),
            approval_flow_notes: backend.capabilities.approval_flow_notes.map(str::to_string),
        });
    AgentBackendDescriptor {
        backend_id: backend.backend_id.to_string(),
        display_name: backend.display_name.to_string(),
        target: backend.target,
        preferred_for_target,
        default_for_target,
        provider: backend.provider.to_string(),
        cli_command: backend.cli_command.map(str::to_string),
        description: backend.description.to_string(),
        builtin: backend.builtin,
        kind: backend.kind,
        transport: backend.transport,
        capabilities,
        configured: runtime.configured,
        available: runtime.available,
        status: runtime.status,
        status_message: runtime.status_message,
        routing_status_message,
        last_error: runtime.last_error,
        last_handshake_at: runtime.last_handshake_at,
    }
}

fn descriptor_for_backend_id(
    config: &AppConfig,
    backend_id: &str,
) -> Option<AgentBackendDescriptor> {
    AGENT_BACKENDS
        .iter()
        .cloned()
        .find(|backend| backend.backend_id == backend_id)
        .map(|backend| static_backend_descriptor(backend, config, false, false, None))
}

fn builtin_backend_for_target(
    config: &AppConfig,
    target: &TaskTarget,
) -> Option<AgentBackendDescriptor> {
    AGENT_BACKENDS
        .iter()
        .cloned()
        .find(|backend| {
            backend.target == target.clone() && backend.kind == AgentBackendKind::BuiltinCli
        })
        .map(|backend| static_backend_descriptor(backend, config, false, false, None))
}

fn first_backend_for_target(
    config: &AppConfig,
    target: &TaskTarget,
) -> Option<AgentBackendDescriptor> {
    AGENT_BACKENDS
        .iter()
        .cloned()
        .find(|backend| backend.target == target.clone())
        .map(|backend| static_backend_descriptor(backend, config, false, false, None))
}

fn default_backend_for_target_with_config(
    config: &AppConfig,
    target: &TaskTarget,
) -> Option<AgentBackendDescriptor> {
    let routing = current_backend_routing(config, target);
    let preferred_backend = routing
        .preferred_backend_id
        .as_deref()
        .and_then(|backend_id| descriptor_for_backend_id(config, backend_id))
        .filter(|backend| backend.target == target.clone());
    let builtin_backend = builtin_backend_for_target(config, target);

    if let Some(preferred_backend) = preferred_backend.clone() {
        if preferred_backend.kind == AgentBackendKind::BuiltinCli
            || preferred_backend.available
            || !routing.allow_builtin_fallback
        {
            return Some(preferred_backend);
        }
    }

    builtin_backend
        .or(preferred_backend)
        .or_else(|| first_backend_for_target(config, target))
}

fn resolved_default_backend_id(config: &AppConfig, target: &TaskTarget) -> Option<String> {
    default_backend_for_target_with_config(config, target).map(|backend| backend.backend_id)
}

fn routing_status_message_for_backend(
    backend: &StaticAgentBackend,
    preferred_backend_id: Option<&str>,
    default_backend_id: Option<&str>,
    allow_builtin_fallback: bool,
) -> Option<String> {
    let target = backend.target.as_str();
    let preferred_for_target = preferred_backend_id == Some(backend.backend_id);
    let default_for_target = default_backend_id == Some(backend.backend_id);

    match (preferred_for_target, default_for_target) {
        (true, true) => Some(format!(
            "Configured as the preferred backend for {target} and currently selected by default."
        )),
        (true, false) => Some(match default_backend_id {
            Some(default_id) if allow_builtin_fallback => format!(
                "Configured as the preferred backend for {target}, but Mini-Term is currently falling back to `{default_id}` because this backend is not ready."
            ),
            Some(default_id) => format!(
                "Configured as the preferred backend for {target}, but Mini-Term resolved `{default_id}` as the active default."
            ),
            None => format!(
                "Configured as the preferred backend for {target}, but Mini-Term could not resolve an active default backend."
            ),
        }),
        (false, true) => Some(match preferred_backend_id {
            Some(preferred_id) if preferred_id != backend.backend_id && allow_builtin_fallback => format!(
                "Currently acting as the default backend for {target} because preferred backend `{preferred_id}` is unavailable or not ready."
            ),
            Some(preferred_id) if preferred_id != backend.backend_id => format!(
                "Currently acting as the default backend for {target} instead of configured preferred backend `{preferred_id}`."
            ),
            _ => format!("Currently selected as the default backend for {target}."),
        }),
        _ => None,
    }
}

fn record_runtime_state(
    backend_id: &str,
    status: AgentBackendRuntimeStatus,
    status_message: Option<String>,
    last_error: Option<String>,
    last_handshake_at: Option<u64>,
    runtime_capabilities: Option<AgentBackendCapabilities>,
) {
    let config = load_current_config();
    let signature = config_signature_for_backend(&config, backend_id);
    runtime_records().lock().unwrap().insert(
        backend_id.to_string(),
        AgentBackendRuntimeRecord {
            config_signature: signature,
            status,
            status_message,
            last_error,
            last_handshake_at,
            runtime_capabilities,
        },
    );
}

fn sanitize_backend_message(backend_id: &str, message: &str) -> String {
    sidecar_backend_config(backend_id)
        .map(|config| config.redact_secrets_in_text(message))
        .unwrap_or_else(|| message.to_string())
}

fn classify_backend_runtime_error_status(error: &str) -> AgentBackendRuntimeStatus {
    if error.contains("disabled in Mini-Term settings")
        || error.contains("launch command is missing")
        || error.contains("requires an API key")
        || error.contains("requires an API key or API key env var")
        || error.contains("requires a model")
        || error.contains("not supported")
    {
        AgentBackendRuntimeStatus::Unconfigured
    } else if error.contains("timed out") || error.contains("channel disconnected") {
        AgentBackendRuntimeStatus::Degraded
    } else {
        AgentBackendRuntimeStatus::Error
    }
}

pub fn classify_backend_runtime_error(
    backend_id: &str,
    error: impl AsRef<str>,
) -> (AgentBackendRuntimeStatus, String) {
    let error = sanitize_backend_message(backend_id, error.as_ref());
    (classify_backend_runtime_error_status(&error), error)
}

pub fn mark_backend_starting(backend_id: &str, status_message: impl Into<String>) {
    record_runtime_state(
        backend_id,
        AgentBackendRuntimeStatus::Starting,
        Some(sanitize_backend_message(backend_id, &status_message.into())),
        None,
        None,
        None,
    );
}

pub fn mark_backend_ready(
    backend_id: &str,
    status_message: impl Into<String>,
    last_handshake_at: u64,
    runtime_capabilities: Option<AgentBackendCapabilities>,
) {
    record_runtime_state(
        backend_id,
        AgentBackendRuntimeStatus::Ready,
        Some(sanitize_backend_message(backend_id, &status_message.into())),
        None,
        Some(last_handshake_at),
        runtime_capabilities,
    );
}

pub fn mark_backend_error(backend_id: &str, error: impl Into<String>) {
    let (status, error) = classify_backend_runtime_error(backend_id, error.into());
    record_runtime_state(
        backend_id,
        status,
        Some(error.clone()),
        Some(error),
        None,
        None,
    );
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn clear_backend_runtime_state(backend_id: &str) {
    runtime_records().lock().unwrap().remove(backend_id);
}

pub fn sidecar_backend_config(backend_id: &str) -> Option<SidecarBackendConfig> {
    current_sidecar_config(&load_current_config(), backend_id)
}

impl AgentBackendDescriptor {
    pub fn requires_ready_preflight(&self) -> bool {
        self.kind == AgentBackendKind::Sidecar
    }
}

pub fn list_agent_backends() -> Vec<AgentBackendDescriptor> {
    list_agent_backends_with_config(&load_current_config())
}

pub fn list_agent_backends_with_config(config: &AppConfig) -> Vec<AgentBackendDescriptor> {
    let codex_default_backend_id = resolved_default_backend_id(config, &TaskTarget::Codex);
    let claude_default_backend_id = resolved_default_backend_id(config, &TaskTarget::Claude);
    AGENT_BACKENDS
        .iter()
        .cloned()
        .map(|backend| {
            let (preferred_backend_id, default_backend_id, allow_builtin_fallback) =
                match &backend.target {
                    TaskTarget::Codex => (
                        current_backend_routing(config, &TaskTarget::Codex).preferred_backend_id,
                        codex_default_backend_id.clone(),
                        current_backend_routing(config, &TaskTarget::Codex).allow_builtin_fallback,
                    ),
                    TaskTarget::Claude => (
                        current_backend_routing(config, &TaskTarget::Claude).preferred_backend_id,
                        claude_default_backend_id.clone(),
                        current_backend_routing(config, &TaskTarget::Claude).allow_builtin_fallback,
                    ),
                };
            let preferred_for_target = preferred_backend_id.as_deref() == Some(backend.backend_id);
            let default_for_target = default_backend_id.as_deref() == Some(backend.backend_id);
            let routing_status_message = routing_status_message_for_backend(
                &backend,
                preferred_backend_id.as_deref(),
                default_backend_id.as_deref(),
                allow_builtin_fallback,
            );
            static_backend_descriptor(
                backend,
                config,
                preferred_for_target,
                default_for_target,
                routing_status_message,
            )
        })
        .collect()
}

fn find_agent_backend_with_config(
    config: &AppConfig,
    backend_id: &str,
) -> Option<AgentBackendDescriptor> {
    let codex_routing = current_backend_routing(config, &TaskTarget::Codex);
    let claude_routing = current_backend_routing(config, &TaskTarget::Claude);
    let codex_default_backend_id = resolved_default_backend_id(config, &TaskTarget::Codex);
    let claude_default_backend_id = resolved_default_backend_id(config, &TaskTarget::Claude);
    AGENT_BACKENDS
        .iter()
        .cloned()
        .find(|backend| backend.backend_id == backend_id)
        .map(|backend| {
            let (preferred_backend_id, default_backend_id, allow_builtin_fallback) =
                match &backend.target {
                    TaskTarget::Codex => (
                        codex_routing.preferred_backend_id.clone(),
                        codex_default_backend_id.clone(),
                        codex_routing.allow_builtin_fallback,
                    ),
                    TaskTarget::Claude => (
                        claude_routing.preferred_backend_id.clone(),
                        claude_default_backend_id.clone(),
                        claude_routing.allow_builtin_fallback,
                    ),
                };
            let preferred_for_target = preferred_backend_id.as_deref() == Some(backend.backend_id);
            let default_for_target = default_backend_id.as_deref() == Some(backend.backend_id);
            let routing_status_message = routing_status_message_for_backend(
                &backend,
                preferred_backend_id.as_deref(),
                default_backend_id.as_deref(),
                allow_builtin_fallback,
            );
            static_backend_descriptor(
                backend,
                config,
                preferred_for_target,
                default_for_target,
                routing_status_message,
            )
        })
}

pub fn find_agent_backend(backend_id: &str) -> Option<AgentBackendDescriptor> {
    let config = load_current_config();
    find_agent_backend_with_config(&config, backend_id)
}

pub fn default_backend_for_target(target: &TaskTarget) -> Option<AgentBackendDescriptor> {
    let config = load_current_config();
    let backend_id = resolved_default_backend_id(&config, target)?;
    find_agent_backend_with_config(&config, &backend_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_core::data_dir::{clear_thread_data_dir, set_thread_data_dir};

    fn prepare_config(config: AppConfig, label: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("mini-term-agent-backends-{label}"));
        std::fs::create_dir_all(&path).unwrap();
        set_thread_data_dir(path.clone());
        crate::config::save_config_to_path(&crate::agent_core::data_dir::config_path(), config)
            .unwrap();
        path
    }

    #[test]
    fn registry_returns_builtin_and_sidecar_backends() {
        let _guard = backend_runtime_test_lock().lock().unwrap();
        let _data_dir = prepare_config(AppConfig::default(), "registry");
        let backends = list_agent_backends();
        assert_eq!(backends.len(), 3);
        assert_eq!(backends[0].backend_id, "codex-cli");
        assert_eq!(backends[1].backend_id, "claude-cli");
        assert_eq!(backends[2].backend_id, "claude-sidecar");
        clear_thread_data_dir();
    }

    #[test]
    fn default_backend_prefers_builtin_cli_for_target() {
        let _guard = backend_runtime_test_lock().lock().unwrap();
        let _data_dir = prepare_config(AppConfig::default(), "default-target");
        let codex = default_backend_for_target(&TaskTarget::Codex).unwrap();
        let claude = default_backend_for_target(&TaskTarget::Claude).unwrap();

        assert_eq!(codex.backend_id, "codex-cli");
        assert!(codex.preferred_for_target);
        assert!(codex.default_for_target);
        assert_eq!(claude.backend_id, "claude-cli");
        assert_eq!(claude.kind, AgentBackendKind::BuiltinCli);
        assert!(claude.preferred_for_target);
        assert!(claude.default_for_target);
        clear_thread_data_dir();
    }

    #[test]
    fn sidecar_status_reflects_configuration_and_runtime_state() {
        let _guard = backend_runtime_test_lock().lock().unwrap();
        let mut config = AppConfig::default();
        config.agent_backends = Some(crate::config::AgentBackendsConfig {
            routing: crate::config::AgentBackendRoutingConfig::default(),
            claude_sidecar: SidecarBackendConfig {
                enabled: true,
                command: Some("claude-rs".into()),
                args: vec!["serve".into()],
                env: Default::default(),
                provider: crate::config::SidecarProviderConfig::default(),
                cwd: None,
                startup_mode: SidecarStartupMode::Process,
                connection_timeout_ms: 2_000,
            },
        });
        let _data_dir = prepare_config(config, "runtime-state");

        let configured = find_agent_backend("claude-sidecar").unwrap();
        assert!(configured.configured);
        assert!(!configured.available);
        assert_eq!(configured.status, AgentBackendRuntimeStatus::Configured);

        mark_backend_ready("claude-sidecar", "Handshake ok", 123, None);
        let ready = find_agent_backend("claude-sidecar").unwrap();
        assert!(ready.available);
        assert_eq!(ready.status, AgentBackendRuntimeStatus::Ready);
        assert_eq!(ready.last_handshake_at, Some(123));

        clear_thread_data_dir();
    }

    #[test]
    fn default_backend_prefers_ready_sidecar_when_routing_requests_it() {
        let _guard = backend_runtime_test_lock().lock().unwrap();
        clear_backend_runtime_state("claude-sidecar");
        let mut config = AppConfig::default();
        config.agent_backends = Some(crate::config::AgentBackendsConfig {
            routing: crate::config::AgentBackendRoutingConfig {
                codex: crate::config::AgentBackendRoutingConfig::default().codex,
                claude: crate::config::TaskTargetBackendRoutingConfig {
                    preferred_backend_id: Some("claude-sidecar".into()),
                    allow_builtin_fallback: true,
                },
            },
            claude_sidecar: SidecarBackendConfig {
                enabled: true,
                command: Some("node".into()),
                args: vec!["dist/sidecar.js".into()],
                env: Default::default(),
                provider: crate::config::SidecarProviderConfig::default(),
                cwd: None,
                startup_mode: SidecarStartupMode::Process,
                connection_timeout_ms: 2_000,
            },
        });
        let _data_dir = prepare_config(config, "preferred-ready-sidecar");

        mark_backend_ready("claude-sidecar", "Handshake ok", 123, None);
        let backend = default_backend_for_target(&TaskTarget::Claude).unwrap();
        assert_eq!(backend.backend_id, "claude-sidecar");
        assert!(backend.preferred_for_target);
        assert!(backend.default_for_target);
        assert!(backend
            .routing_status_message
            .as_deref()
            .unwrap_or_default()
            .contains("preferred backend"));

        clear_thread_data_dir();
        clear_backend_runtime_state("claude-sidecar");
    }

    #[test]
    fn default_backend_falls_back_to_builtin_when_sidecar_is_unavailable() {
        let _guard = backend_runtime_test_lock().lock().unwrap();
        clear_backend_runtime_state("claude-sidecar");
        let mut config = AppConfig::default();
        config.agent_backends = Some(crate::config::AgentBackendsConfig {
            routing: crate::config::AgentBackendRoutingConfig {
                codex: crate::config::AgentBackendRoutingConfig::default().codex,
                claude: crate::config::TaskTargetBackendRoutingConfig {
                    preferred_backend_id: Some("claude-sidecar".into()),
                    allow_builtin_fallback: true,
                },
            },
            claude_sidecar: SidecarBackendConfig {
                enabled: true,
                command: Some("node".into()),
                args: vec!["dist/sidecar.js".into()],
                env: Default::default(),
                provider: crate::config::SidecarProviderConfig::default(),
                cwd: None,
                startup_mode: SidecarStartupMode::Process,
                connection_timeout_ms: 2_000,
            },
        });
        let _data_dir = prepare_config(config, "preferred-sidecar-fallback");

        let backend = default_backend_for_target(&TaskTarget::Claude).unwrap();
        assert_eq!(backend.backend_id, "claude-cli");
        assert!(backend.default_for_target);
        assert!(!backend.preferred_for_target);
        assert!(backend
            .routing_status_message
            .as_deref()
            .unwrap_or_default()
            .contains("preferred backend `claude-sidecar`"));
        let preferred = find_agent_backend("claude-sidecar").unwrap();
        assert!(preferred.preferred_for_target);
        assert!(!preferred.default_for_target);
        assert!(preferred
            .routing_status_message
            .as_deref()
            .unwrap_or_default()
            .contains("falling back"));

        clear_thread_data_dir();
        clear_backend_runtime_state("claude-sidecar");
    }

    #[test]
    fn default_backend_keeps_preferred_sidecar_when_fallback_is_disabled() {
        let _guard = backend_runtime_test_lock().lock().unwrap();
        clear_backend_runtime_state("claude-sidecar");
        let mut config = AppConfig::default();
        config.agent_backends = Some(crate::config::AgentBackendsConfig {
            routing: crate::config::AgentBackendRoutingConfig {
                codex: crate::config::AgentBackendRoutingConfig::default().codex,
                claude: crate::config::TaskTargetBackendRoutingConfig {
                    preferred_backend_id: Some("claude-sidecar".into()),
                    allow_builtin_fallback: false,
                },
            },
            claude_sidecar: SidecarBackendConfig {
                enabled: true,
                command: Some("node".into()),
                args: vec!["dist/sidecar.js".into()],
                env: Default::default(),
                provider: crate::config::SidecarProviderConfig::default(),
                cwd: None,
                startup_mode: SidecarStartupMode::Process,
                connection_timeout_ms: 2_000,
            },
        });
        let _data_dir = prepare_config(config, "preferred-sidecar-no-fallback");

        let backend = default_backend_for_target(&TaskTarget::Claude).unwrap();
        assert_eq!(backend.backend_id, "claude-sidecar");
        assert!(backend.preferred_for_target);
        assert!(backend.default_for_target);
        assert!(backend
            .routing_status_message
            .as_deref()
            .unwrap_or_default()
            .contains("preferred backend"));

        clear_thread_data_dir();
        clear_backend_runtime_state("claude-sidecar");
    }

    #[test]
    fn disabled_sidecar_reports_unconfigured_status() {
        let _guard = backend_runtime_test_lock().lock().unwrap();
        let _data_dir = prepare_config(AppConfig::default(), "disabled-sidecar");
        let backend = find_agent_backend("claude-sidecar").unwrap();
        assert!(!backend.configured);
        assert!(!backend.available);
        assert_eq!(backend.status, AgentBackendRuntimeStatus::Unconfigured);
        assert!(backend
            .status_message
            .as_deref()
            .unwrap_or_default()
            .contains("disabled"));
        clear_thread_data_dir();
    }

    #[test]
    fn invalid_sidecar_provider_reports_preflight_error() {
        let _guard = backend_runtime_test_lock().lock().unwrap();
        let mut config = AppConfig::default();
        config.agent_backends = Some(crate::config::AgentBackendsConfig {
            routing: crate::config::AgentBackendRoutingConfig::default(),
            claude_sidecar: SidecarBackendConfig {
                enabled: true,
                command: Some("node".into()),
                args: vec!["dist/sidecar.js".into()],
                env: Default::default(),
                provider: crate::config::SidecarProviderConfig {
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
                connection_timeout_ms: 2_000,
            },
        });
        let _data_dir = prepare_config(config, "invalid-provider");

        let backend = find_agent_backend("claude-sidecar").unwrap();
        assert!(!backend.configured);
        assert_eq!(backend.status, AgentBackendRuntimeStatus::Unconfigured);
        assert!(backend
            .status_message
            .as_deref()
            .unwrap_or_default()
            .contains("requires an API key"));

        clear_thread_data_dir();
    }
}
