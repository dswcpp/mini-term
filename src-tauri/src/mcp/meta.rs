use crate::agent_core::approval::list_approvals;
use crate::runtime_mcp::{load_runtime_state, RuntimeMcpState};
use serde_json::{json, Value};

pub const PROTOCOL_VERSION: &str = "2025-03-26";
pub const SERVER_NAME: &str = "mini-term-mcp";
const HOST_STALE_AFTER_MS: u64 = 5_000;
const SNAPSHOT_STALE_AFTER_MS: u64 = 10_000;

fn current_transport() -> &'static str {
    match std::env::var("MINI_TERM_MCP_TRANSPORT")
        .unwrap_or_else(|_| "stdio".to_string())
        .to_ascii_lowercase()
        .as_str()
    {
        "http" => "http",
        _ => "stdio",
    }
}

pub fn timestamp_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn host_connection_payload(state: &RuntimeMcpState) -> Value {
    let now = timestamp_ms();
    let host = state.host.clone();
    let last_heartbeat_at = host.as_ref().map(|item| item.last_heartbeat_at);
    let connected = last_heartbeat_at
        .map(|value| now.saturating_sub(value) <= HOST_STALE_AFTER_MS)
        .unwrap_or(false);
    let host_control_available = connected
        && host
            .as_ref()
            .and_then(|item| item.host_control.as_ref())
            .is_some();
    let status = if connected {
        "connected"
    } else if host.is_some() {
        "stale"
    } else {
        "unavailable"
    };
    let control_status = if host_control_available {
        "ready"
    } else if host.is_some() {
        "snapshot-only"
    } else {
        "unavailable"
    };

    json!({
        "status": status,
        "mode": host
            .as_ref()
            .map(|item| item.transport_mode.clone())
            .unwrap_or_else(|| "standalone".to_string()),
        "lastHeartbeatAt": last_heartbeat_at,
        "desktopPid": host.as_ref().map(|item| item.desktop_pid),
        "hostControl": host
            .as_ref()
            .and_then(|item| item.host_control.clone()),
        "hostControlAvailable": host_control_available,
        "controlStatus": control_status,
        "staleAfterMs": HOST_STALE_AFTER_MS,
    })
}

pub fn host_mode() -> String {
    let state = load_runtime_state();
    host_connection_payload(&state)["mode"]
        .as_str()
        .unwrap_or("standalone")
        .to_string()
}

pub fn build_server_info_payload() -> Value {
    let state = load_runtime_state();
    let host_connection = host_connection_payload(&state);
    let approvals = list_approvals();
    let snapshot_age_ms = timestamp_ms().saturating_sub(state.updated_at);
    let runtime_degradation_mode = match host_connection["controlStatus"].as_str() {
        Some("ready") => "full-control",
        Some("snapshot-only") => {
            if host_connection["status"] == "stale" {
                "stale-snapshot-only"
            } else {
                "snapshot-only"
            }
        }
        _ => "unavailable",
    };
    let app_version = state
        .host
        .as_ref()
        .map(|item| item.app_version.clone())
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
    let diagnostics = match host_connection["status"].as_str().unwrap_or("unavailable") {
        "connected" => vec![json!({
            "level": "info",
            "code": "HOST_CONNECTED",
            "message": "Mini-Term desktop runtime snapshot and host heartbeat are available."
        })],
        "stale" => vec![json!({
            "level": "warning",
            "code": "HOST_STALE",
            "message": "Mini-Term desktop host heartbeat is stale. Fall back to snapshot-only observation."
        })],
        _ => vec![json!({
            "level": "warning",
            "code": "HOST_UNAVAILABLE",
            "message": "Mini-Term desktop runtime snapshot is unavailable. Host-backed control is blocked."
        })],
    };

    json!({
        "serverName": SERVER_NAME,
        "serverVersion": env!("CARGO_PKG_VERSION"),
        "protocolVersion": PROTOCOL_VERSION,
        "appVersion": app_version,
        "transport": current_transport(),
        "hostConnection": host_connection,
        "runtime": {
            "stateOwner": "desktop-host",
            "authorityModel": "desktop-host-authoritative",
            "degradationMode": runtime_degradation_mode,
            "snapshotUpdatedAt": state.updated_at,
            "snapshotAgeMs": snapshot_age_ms,
            "snapshotStaleAfterMs": SNAPSHOT_STALE_AFTER_MS,
            "snapshotIsStale": snapshot_age_ms > SNAPSHOT_STALE_AFTER_MS,
            "hostBackedToolsAvailable": host_connection["hostControlAvailable"].clone(),
            "summary": {
                "ptyCount": state.ptys.len(),
                "watcherCount": state.watchers.len(),
                "recentEventCount": state.recent_events.len(),
                "approvalCount": approvals.len(),
                "pendingApprovalCount": approvals
                    .iter()
                    .filter(|request| request.status == crate::agent_core::models::ApprovalDecision::Pending)
                    .count(),
                "approvedApprovalCount": approvals
                    .iter()
                    .filter(|request| request.status == crate::agent_core::models::ApprovalDecision::Approved)
                    .count(),
            }
        },
        "capabilities": {
            "tools": true,
            "runtimeSnapshots": true,
            "pagedLists": true,
            "dryRunWrites": true,
        },
        "diagnostics": diagnostics,
    })
}

#[cfg(test)]
mod tests {
    use super::build_server_info_payload;
    use crate::agent_core::approval::create_approval_request;
    use crate::agent_core::models::ApprovalRiskLevel;
    use crate::mcp::tools::test_support::TestHarness;

    #[test]
    fn server_info_exposes_runtime_summary_and_control_status() {
        let _harness = TestHarness::new("meta-server-info");
        create_approval_request(
            "write_file",
            "test approval",
            ApprovalRiskLevel::High,
            "Path: notes.txt\nhello".to_string(),
        )
        .unwrap();

        let payload = build_server_info_payload();
        assert_eq!(payload["runtime"]["stateOwner"], "desktop-host");
        assert!(
            payload["runtime"]["summary"]["approvalCount"]
                .as_u64()
                .unwrap()
                >= 1
        );
        assert!(
            payload["runtime"]["summary"]["pendingApprovalCount"]
                .as_u64()
                .unwrap()
                >= 1
        );
        assert!(payload["hostConnection"]["controlStatus"].is_string());
    }
}
