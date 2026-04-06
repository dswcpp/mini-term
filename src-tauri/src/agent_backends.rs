use crate::agent_core::models::TaskTarget;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentBackendDescriptor {
    pub backend_id: String,
    pub display_name: String,
    pub target: TaskTarget,
    pub provider: String,
    pub cli_command: String,
    pub description: String,
    pub builtin: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BuiltinAgentBackend {
    backend_id: &'static str,
    display_name: &'static str,
    target: TaskTarget,
    provider: &'static str,
    cli_command: &'static str,
    description: &'static str,
}

const BUILTIN_AGENT_BACKENDS: [BuiltinAgentBackend; 2] = [
    BuiltinAgentBackend {
        backend_id: "codex-cli",
        display_name: "Codex CLI",
        target: TaskTarget::Codex,
        provider: "OpenAI",
        cli_command: "codex",
        description: "Built-in Codex CLI task backend managed by Mini-Term.",
    },
    BuiltinAgentBackend {
        backend_id: "claude-cli",
        display_name: "Claude CLI",
        target: TaskTarget::Claude,
        provider: "Anthropic",
        cli_command: "claude",
        description: "Built-in Claude CLI task backend managed by Mini-Term.",
    },
];

impl BuiltinAgentBackend {
    fn descriptor(self) -> AgentBackendDescriptor {
        AgentBackendDescriptor {
            backend_id: self.backend_id.to_string(),
            display_name: self.display_name.to_string(),
            target: self.target,
            provider: self.provider.to_string(),
            cli_command: self.cli_command.to_string(),
            description: self.description.to_string(),
            builtin: true,
        }
    }
}

pub fn list_agent_backends() -> Vec<AgentBackendDescriptor> {
    BUILTIN_AGENT_BACKENDS
        .iter()
        .cloned()
        .map(BuiltinAgentBackend::descriptor)
        .collect()
}

pub fn find_agent_backend(backend_id: &str) -> Option<AgentBackendDescriptor> {
    BUILTIN_AGENT_BACKENDS
        .iter()
        .cloned()
        .find(|backend| backend.backend_id == backend_id)
        .map(BuiltinAgentBackend::descriptor)
}

pub fn default_backend_for_target(target: &TaskTarget) -> Option<AgentBackendDescriptor> {
    BUILTIN_AGENT_BACKENDS
        .iter()
        .cloned()
        .find(|backend| backend.target == target.clone())
        .map(BuiltinAgentBackend::descriptor)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_registry_returns_known_backends() {
        let backends = list_agent_backends();
        assert_eq!(backends.len(), 2);
        assert_eq!(backends[0].backend_id, "codex-cli");
        assert_eq!(backends[1].backend_id, "claude-cli");
    }

    #[test]
    fn default_backend_matches_task_target() {
        let codex = default_backend_for_target(&TaskTarget::Codex).unwrap();
        let claude = default_backend_for_target(&TaskTarget::Claude).unwrap();

        assert_eq!(codex.backend_id, "codex-cli");
        assert_eq!(claude.backend_id, "claude-cli");
    }

    #[test]
    fn backend_lookup_finds_exact_id() {
        let backend = find_agent_backend("claude-cli").unwrap();
        assert_eq!(backend.target, TaskTarget::Claude);
        assert!(find_agent_backend("missing-backend").is_none());
    }
}
