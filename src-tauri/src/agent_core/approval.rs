use super::data_dir::{approvals_path, ensure_parent};
use super::models::{ApprovalDecision, ApprovalRequest, ApprovalRiskLevel};
use crate::runtime_mcp::record_runtime_event;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::fs;
use std::fs::OpenOptions;
use std::path::Path;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalStoreFile {
    #[serde(default)]
    approvals: Vec<ApprovalRequest>,
}

fn now_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn generate_id(prefix: &str) -> String {
    format!("{prefix}-{}", Uuid::now_v7())
}

fn normalize_payload_preview(payload_preview: &str) -> String {
    payload_preview.replace("\r\n", "\n").trim().to_string()
}

pub fn build_action_digest(tool_name: &str, payload_preview: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(tool_name.as_bytes());
    hasher.update(b"\n");
    hasher.update(normalize_payload_preview(payload_preview).as_bytes());
    format!("{:x}", hasher.finalize())
}

pub fn build_approval_key(tool_name: &str, payload_preview: &str) -> String {
    build_action_digest(tool_name, payload_preview)
}

fn approval_store_guard() -> &'static Mutex<()> {
    static GUARD: OnceLock<Mutex<()>> = OnceLock::new();
    GUARD.get_or_init(|| Mutex::new(()))
}

struct ApprovalStoreLock {
    _process_guard: MutexGuard<'static, ()>,
    lock_path: PathBuf,
}

impl Drop for ApprovalStoreLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.lock_path);
    }
}

fn acquire_store_lock(path: &Path) -> Result<ApprovalStoreLock, String> {
    let process_guard = approval_store_guard()
        .lock()
        .map_err(|_| "approval store is unavailable".to_string())?;
    let lock_path = path.with_extension("lock");
    ensure_parent(&lock_path)?;

    for _ in 0..200 {
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock_path)
        {
            Ok(_) => {
                return Ok(ApprovalStoreLock {
                    _process_guard: process_guard,
                    lock_path,
                });
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(_) => return Err("approval store is unavailable".to_string()),
        }
    }

    Err("approval store is unavailable".to_string())
}

fn with_store_read<T>(f: impl FnOnce(&ApprovalStoreFile) -> T) -> Result<T, String> {
    let path = approvals_path();
    let _lock = acquire_store_lock(&path)?;
    let store = read_store(&path);
    Ok(f(&store))
}

fn with_store_write<T>(f: impl FnOnce(&mut ApprovalStoreFile) -> Result<T, String>) -> Result<T, String> {
    let path = approvals_path();
    let _lock = acquire_store_lock(&path)?;
    let mut store = read_store(&path);
    let value = f(&mut store)?;
    write_store(&path, &store)?;
    Ok(value)
}

fn read_store(path: &Path) -> ApprovalStoreFile {
    match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => ApprovalStoreFile::default(),
    }
}

fn write_store(path: &Path, store: &ApprovalStoreFile) -> Result<(), String> {
    ensure_parent(path)?;
    let json = serde_json::to_string_pretty(store).map_err(|err| err.to_string())?;
    fs::write(path, json).map_err(|err| err.to_string())
}

pub fn list_approvals() -> Vec<ApprovalRequest> {
    let mut approvals = with_store_read(|store| store.approvals.clone()).unwrap_or_default();
    approvals.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    approvals
}

pub fn get_approval(request_id: &str) -> Option<ApprovalRequest> {
    list_approvals()
        .into_iter()
        .find(|request| request.request_id == request_id)
}

pub fn get_approval_by_key(approval_key: &str) -> Option<ApprovalRequest> {
    list_approvals()
        .into_iter()
        .find(|request| {
            request.approval_key.as_deref() == Some(approval_key)
                || request.action_digest.as_deref() == Some(approval_key)
        })
}

pub fn create_approval_request(
    tool_name: &str,
    reason: &str,
    risk_level: ApprovalRiskLevel,
    payload_preview: String,
) -> Result<ApprovalRequest, String> {
    let now = now_timestamp_ms();
    let normalized_payload = normalize_payload_preview(&payload_preview);
    let action_digest = build_action_digest(tool_name, &normalized_payload);
    let request = with_store_write(|store| {
        let request = ApprovalRequest {
            request_id: generate_id("approval"),
            tool_name: tool_name.to_string(),
            reason: reason.to_string(),
            risk_level,
            payload_preview: normalized_payload.clone(),
            status: ApprovalDecision::Pending,
            created_at: now,
            updated_at: now,
            action_digest: Some(action_digest.clone()),
            approval_key: Some(action_digest.clone()),
        };
        store.approvals.push(request.clone());
        Ok(request)
    })?;
    let _ = record_runtime_event(
        "approval-requested",
        format!("Approval requested for {}.", request.tool_name),
        Some(json!({
            "requestId": request.request_id.clone(),
            "toolName": request.tool_name.clone(),
            "riskLevel": request.risk_level.clone(),
            "status": request.status.clone(),
            "payloadPreview": request.payload_preview.clone(),
            "actionDigest": request.action_digest.clone(),
        })),
    );
    Ok(request)
}

pub fn set_approval_status(
    request_id: &str,
    status: ApprovalDecision,
) -> Result<ApprovalRequest, String> {
    let updated = with_store_write(|store| {
        for request in &mut store.approvals {
            if request.request_id == request_id {
                let next_status = next_approval_status(&request.status, &status);
                request.status = next_status;
                request.updated_at = now_timestamp_ms();
                return Ok(request.clone());
            }
        }
        Err("approval request not found".to_string())
    })?;

    if updated.status != ApprovalDecision::Executed {
        let status_label = match &updated.status {
            ApprovalDecision::Approved => "approved",
            ApprovalDecision::Rejected => "rejected",
            ApprovalDecision::Pending => "pending",
            ApprovalDecision::Executed => "executed",
        };
        let _ = record_runtime_event(
            "approval-decision",
            format!("Approval {} set to {}.", updated.request_id, status_label),
            Some(json!({
                "requestId": updated.request_id.clone(),
                "toolName": updated.tool_name.clone(),
                "status": updated.status.clone(),
                "actionDigest": updated.action_digest.clone(),
            })),
        );
    }

    Ok(updated)
}

fn next_approval_status(
    current: &ApprovalDecision,
    requested: &ApprovalDecision,
) -> ApprovalDecision {
    match (current, requested) {
        (ApprovalDecision::Pending, ApprovalDecision::Approved)
        | (ApprovalDecision::Pending, ApprovalDecision::Rejected)
        | (ApprovalDecision::Approved, ApprovalDecision::Executed) => requested.clone(),
        (current, requested) if current == requested => current.clone(),
        (ApprovalDecision::Executed, _) => ApprovalDecision::Executed,
        (ApprovalDecision::Approved, _) => ApprovalDecision::Approved,
        (ApprovalDecision::Rejected, _) => ApprovalDecision::Rejected,
        (ApprovalDecision::Pending, ApprovalDecision::Executed) => ApprovalDecision::Pending,
        (ApprovalDecision::Pending, _) => current.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_core::data_dir::{clear_thread_data_dir, set_thread_data_dir};
    use std::sync::Arc;
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn isolated_data_dir(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("mini-term-approval-{label}-{unique}"))
    }

    #[test]
    fn executed_status_is_terminal() {
        assert_eq!(
            next_approval_status(&ApprovalDecision::Pending, &ApprovalDecision::Approved),
            ApprovalDecision::Approved
        );
        assert_eq!(
            next_approval_status(&ApprovalDecision::Approved, &ApprovalDecision::Executed),
            ApprovalDecision::Executed
        );
        assert_eq!(
            next_approval_status(&ApprovalDecision::Executed, &ApprovalDecision::Rejected),
            ApprovalDecision::Executed
        );
    }

    #[test]
    fn approval_key_normalizes_payload_whitespace() {
        let left = build_approval_key("write_file", "Path: D:/repo/file.txt\r\n\r\nhello");
        let right = build_approval_key("write_file", "Path: D:/repo/file.txt\n\nhello  ");
        assert_eq!(left, right);
    }

    #[test]
    fn approval_key_changes_when_tool_or_payload_changes() {
        let base = build_approval_key("write_file", "Path: D:/repo/file.txt\nhello");
        let other_tool =
            build_approval_key("run_workspace_command", "Path: D:/repo/file.txt\nhello");
        let other_payload = build_approval_key("write_file", "Path: D:/repo/file.txt\nbye");

        assert_ne!(base, other_tool);
        assert_ne!(base, other_payload);
    }

    #[test]
    fn action_digest_matches_approval_key_for_legacy_compatibility() {
        let payload = "Workspace: D:/repo\nCommand: echo hello";
        assert_eq!(
            build_action_digest("run_workspace_command", payload),
            build_approval_key("run_workspace_command", payload)
        );
    }

    #[test]
    fn approval_store_serializes_concurrent_writes() {
        let data_dir = Arc::new(isolated_data_dir("concurrency"));
        std::fs::create_dir_all(&*data_dir).unwrap();

        let mut handles = Vec::new();
        for index in 0..8 {
            let data_dir = Arc::clone(&data_dir);
            handles.push(thread::spawn(move || {
                set_thread_data_dir((*data_dir).clone());
                let request = create_approval_request(
                    "write_file",
                    "Testing concurrent approval writes.",
                    ApprovalRiskLevel::High,
                    format!("Path: D:/repo/{index}.txt"),
                )
                .unwrap();
                clear_thread_data_dir();
                request.request_id
            }));
        }

        let mut request_ids = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();
        request_ids.sort();
        request_ids.dedup();

        set_thread_data_dir((*data_dir).clone());
        let approvals = list_approvals();
        clear_thread_data_dir();

        assert_eq!(request_ids.len(), 8);
        assert_eq!(approvals.len(), 8);

        let _ = std::fs::remove_dir_all(&*data_dir);
    }
}
