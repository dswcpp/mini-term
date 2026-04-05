use crate::runtime_mcp::{load_runtime_state, RuntimeMcpState};
use serde_json::{json, Value};

pub const PROTOCOL_VERSION: &str = "2025-03-26";
pub const SERVER_NAME: &str = "mini-term-mcp";
const HOST_STALE_AFTER_MS: u64 = 5_000;

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

    json!({
        "status": if connected { "connected" } else { "unavailable" },
        "mode": host
            .as_ref()
            .map(|item| item.transport_mode.clone())
            .unwrap_or_else(|| "standalone".to_string()),
        "lastHeartbeatAt": last_heartbeat_at,
        "desktopPid": host.as_ref().map(|item| item.desktop_pid),
        "hostControl": host
            .as_ref()
            .and_then(|item| item.host_control.clone()),
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
    let app_version = state
        .host
        .as_ref()
        .map(|item| item.app_version.clone())
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
    let diagnostics = if host_connection["status"] == "connected" {
        vec![json!({
            "level": "info",
            "code": "HOST_CONNECTED",
            "message": "Mini-Term desktop runtime snapshot is available."
        })]
    } else {
        vec![json!({
            "level": "warning",
            "code": "HOST_UNAVAILABLE",
            "message": "Mini-Term desktop runtime snapshot is unavailable or stale."
        })]
    };

    json!({
        "serverName": SERVER_NAME,
        "serverVersion": env!("CARGO_PKG_VERSION"),
        "protocolVersion": PROTOCOL_VERSION,
        "appVersion": app_version,
        "transport": current_transport(),
        "hostConnection": host_connection,
        "capabilities": {
            "tools": true,
            "runtimeSnapshots": true,
            "pagedLists": true,
            "dryRunWrites": true,
        },
        "diagnostics": diagnostics,
    })
}
