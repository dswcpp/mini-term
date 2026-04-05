use super::data_dir::{approvals_path, ensure_parent};
use super::models::{ApprovalDecision, ApprovalRequest, ApprovalRiskLevel};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
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

pub fn build_approval_key(tool_name: &str, payload_preview: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(tool_name.as_bytes());
    hasher.update(b"\n");
    hasher.update(normalize_payload_preview(payload_preview).as_bytes());
    format!("{:x}", hasher.finalize())
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
    let mut approvals = read_store(&approvals_path()).approvals;
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
        .find(|request| request.approval_key.as_deref() == Some(approval_key))
}

pub fn create_approval_request(
    tool_name: &str,
    reason: &str,
    risk_level: ApprovalRiskLevel,
    payload_preview: String,
) -> Result<ApprovalRequest, String> {
    let path = approvals_path();
    let mut store = read_store(&path);
    let now = now_timestamp_ms();
    let normalized_payload = normalize_payload_preview(&payload_preview);
    let approval_key = build_approval_key(tool_name, &normalized_payload);
    let request = ApprovalRequest {
        request_id: generate_id("approval"),
        tool_name: tool_name.to_string(),
        reason: reason.to_string(),
        risk_level,
        payload_preview: normalized_payload,
        status: ApprovalDecision::Pending,
        created_at: now,
        updated_at: now,
        approval_key: Some(approval_key),
    };
    store.approvals.push(request.clone());
    write_store(&path, &store)?;
    Ok(request)
}

pub fn set_approval_status(
    request_id: &str,
    status: ApprovalDecision,
) -> Result<ApprovalRequest, String> {
    let path = approvals_path();
    let mut store = read_store(&path);
    for request in &mut store.approvals {
        if request.request_id == request_id {
            let next_status = next_approval_status(&request.status, &status);
            request.status = next_status;
            request.updated_at = now_timestamp_ms();
            let updated = request.clone();
            write_store(&path, &store)?;
            return Ok(updated);
        }
    }
    Err(format!("approval request not found: {request_id}"))
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
}
