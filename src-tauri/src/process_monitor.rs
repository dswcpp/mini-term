use serde::Serialize;
use std::collections::HashMap;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::runtime_mcp;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyStatusChangePayload {
    pub session_id: String,
    pub pty_id: u32,
    pub status: String,
}

const AI_ACTIVE_TIMEOUT: Duration = Duration::from_secs(3);
const HUMAN_ACTIVE_TIMEOUT: Duration = Duration::from_secs(2);

fn derive_statuses(
    pty_manager: &crate::pty::PtyManager,
    pty_id: u32,
) -> (&'static str, &'static str) {
    if pty_manager.is_ai_session(pty_id) {
        if pty_manager.has_recent_output(pty_id, AI_ACTIVE_TIMEOUT) {
            ("ai-working", "ai-working")
        } else {
            ("ai-idle", "ai-idle")
        }
    } else if pty_manager.has_recent_output(pty_id, HUMAN_ACTIVE_TIMEOUT)
        || pty_manager.has_recent_command_activity(pty_id, HUMAN_ACTIVE_TIMEOUT)
    {
        ("idle", "running")
    } else {
        ("idle", "idle")
    }
}

pub fn start_monitor(app: AppHandle, pty_manager: crate::pty::PtyManager) {
    thread::spawn(move || {
        let mut prev_ui_statuses: HashMap<u32, String> = HashMap::new();
        let mut prev_runtime_statuses: HashMap<u32, String> = HashMap::new();

        loop {
            let pty_ids = pty_manager.get_pty_ids();

            for pty_id in &pty_ids {
                let (ui_status, runtime_status) = derive_statuses(&pty_manager, *pty_id);
                let is_ai_session = pty_manager.is_ai_session(*pty_id);

                let prev_ui = prev_ui_statuses.get(pty_id);
                if prev_ui.map(|status| status.as_str()) != Some(ui_status) {
                    let session_id = pty_manager.get_session_id(*pty_id);
                    let _ = app.emit(
                        "pty-status-change",
                        PtyStatusChangePayload {
                            session_id,
                            pty_id: *pty_id,
                            status: ui_status.to_string(),
                        },
                    );
                    prev_ui_statuses.insert(*pty_id, ui_status.to_string());
                }

                let prev_runtime = prev_runtime_statuses.get(pty_id);
                if prev_runtime.map(|status| status.as_str()) != Some(runtime_status) {
                    if is_ai_session {
                        let _ = runtime_mcp::update_pty_status(*pty_id, runtime_status);
                    } else if prev_runtime.is_some() && runtime_status == "idle" {
                        let _ = runtime_mcp::update_pty_status(*pty_id, "idle");
                    }
                    prev_runtime_statuses.insert(*pty_id, runtime_status.to_string());
                }
            }

            prev_ui_statuses.retain(|id, _| pty_ids.contains(id));
            prev_runtime_statuses.retain(|id, _| pty_ids.contains(id));

            let sleep_ms = if pty_ids.is_empty() { 2000 } else { 500 };
            thread::sleep(Duration::from_millis(sleep_ms));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::derive_statuses;
    use crate::pty::PtyManager;

    #[test]
    fn human_sessions_keep_ui_idle_but_runtime_running_when_recent_command_exists() {
        let manager = PtyManager::new();
        manager.note_command_activity(1);

        let (ui_status, runtime_status) = derive_statuses(&manager, 1);
        assert_eq!(ui_status, "idle");
        assert_eq!(runtime_status, "running");
    }

    #[test]
    fn ai_sessions_switch_between_idle_and_working_based_on_output() {
        let manager = PtyManager::new();
        manager.track_input(1, "codex\r");

        let (ui_status, runtime_status) = derive_statuses(&manager, 1);
        assert_eq!(ui_status, "ai-idle");
        assert_eq!(runtime_status, "ai-idle");

        manager.note_output_activity(1);
        let (ui_status, runtime_status) = derive_statuses(&manager, 1);
        assert_eq!(ui_status, "ai-working");
        assert_eq!(runtime_status, "ai-working");
    }
}
