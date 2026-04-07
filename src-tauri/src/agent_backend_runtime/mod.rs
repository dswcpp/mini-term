mod builtin_cli;
mod sidecar;

use crate::agent_backends::{AgentBackendDescriptor, AgentBackendKind};
use portable_pty::CommandBuilder;

pub use sidecar::{
    start_sidecar_session, SidecarAttentionState, SidecarEvent, SidecarSessionController,
    SidecarStartRequest, StartedSidecarSession,
};

pub struct BackendLaunchRequest<'a> {
    pub backend: &'a AgentBackendDescriptor,
    pub prompt: &'a str,
    pub cwd: &'a str,
    pub title: &'a str,
}

pub struct BackendLaunchSpec {
    pub builder: CommandBuilder,
    pub display: String,
    pub initial_input: Option<String>,
}

pub fn build_launch_command(
    request: BackendLaunchRequest<'_>,
) -> Result<BackendLaunchSpec, String> {
    match request.backend.kind {
        AgentBackendKind::BuiltinCli => builtin_cli::build_launch_command(request),
        AgentBackendKind::Sidecar => Err(format!(
            "backend {} must be started through the sidecar session runtime",
            request.backend.backend_id
        )),
    }
}
