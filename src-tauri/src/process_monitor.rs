use serde::Serialize;
use std::collections::HashMap;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyStatusChangePayload {
    pub pty_id: u32,
    pub status: String,
}

#[cfg(target_os = "windows")]
fn get_child_process_names(parent_pid: u32) -> Vec<String> {
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32First, Process32Next, PROCESSENTRY32, TH32CS_SNAPPROCESS,
    };
    use windows::Win32::Foundation::CloseHandle;

    unsafe {
        let snapshot = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            Ok(h) => h,
            Err(_) => return vec![],
        };

        let mut entry = PROCESSENTRY32::default();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32>() as u32;

        let mut names = vec![];
        if Process32First(snapshot, &mut entry).is_ok() {
            loop {
                if entry.th32ParentProcessID == parent_pid {
                    let name = entry.szExeFile
                        .iter()
                        .take_while(|&&c| c != 0)
                        .map(|&c| c as u8 as char)
                        .collect::<String>()
                        .to_lowercase();
                    names.push(name);
                }
                if Process32Next(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
        names
    }
}

#[cfg(not(target_os = "windows"))]
fn get_child_process_names(_parent_pid: u32) -> Vec<String> {
    vec![]
}

const AI_PROCESS_NAMES: &[&str] = &["claude.exe", "codex.exe", "claude", "codex"];

fn detect_status(child_names: &[String]) -> &'static str {
    if child_names.is_empty() {
        return "idle";
    }
    for name in child_names {
        if AI_PROCESS_NAMES.iter().any(|ai| name.contains(ai)) {
            return "ai-working";
        }
    }
    "running"
}

pub fn start_monitor(app: AppHandle, pty_manager: crate::pty::PtyManager) {
    thread::spawn(move || {
        let mut prev_statuses: HashMap<u32, String> = HashMap::new();

        loop {
            let pids = pty_manager.get_pids();

            for (pty_id, child_pid) in &pids {
                let status = if let Some(pid) = child_pid {
                    let names = get_child_process_names(*pid);
                    detect_status(&names).to_string()
                } else {
                    "idle".to_string()
                };

                let prev = prev_statuses.get(pty_id);
                if prev.map(|s| s.as_str()) != Some(&status) {
                    let _ = app.emit("pty-status-change", PtyStatusChangePayload {
                        pty_id: *pty_id,
                        status: status.clone(),
                    });
                    prev_statuses.insert(*pty_id, status);
                }
            }

            prev_statuses.retain(|id, _| pids.contains_key(id));

            let sleep_ms = if pids.is_empty() { 2000 } else { 500 };
            thread::sleep(Duration::from_millis(sleep_ms));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_idle() {
        assert_eq!(detect_status(&[]), "idle");
    }

    #[test]
    fn detect_running() {
        assert_eq!(detect_status(&["node.exe".to_string()]), "running");
    }

    #[test]
    fn detect_ai_working() {
        assert_eq!(detect_status(&["claude.exe".to_string()]), "ai-working");
    }
}
