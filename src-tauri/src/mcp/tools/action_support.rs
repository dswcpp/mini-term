use crate::agent_core::models::{ApprovalDecision, PendingApprovalResult};
use serde_json::{json, Value};

fn approval_flow_status(status: &ApprovalDecision) -> &'static str {
    match status {
        ApprovalDecision::Pending => "approval-pending",
        ApprovalDecision::Approved => "approval-approved",
        ApprovalDecision::Rejected => "approval-rejected",
        ApprovalDecision::Executed => "approval-expired",
    }
}

fn approval_action_phase(status: &ApprovalDecision) -> &'static str {
    match status {
        ApprovalDecision::Pending => "awaiting-approval",
        ApprovalDecision::Approved => "approved-awaiting-retry",
        ApprovalDecision::Rejected => "blocked",
        ApprovalDecision::Executed => "consumed",
    }
}

fn approval_blocking_reason(status: &ApprovalDecision) -> &'static str {
    match status {
        ApprovalDecision::Pending => "Approval is pending in Mini-Term Inbox.",
        ApprovalDecision::Approved => {
            "Approval is granted; retry with approvalRequestId to execute the action."
        }
        ApprovalDecision::Rejected => "Approval was rejected in Mini-Term Inbox.",
        ApprovalDecision::Executed => {
            "This approval request was already consumed and cannot be replayed."
        }
    }
}

fn approval_retry_allowed(status: &ApprovalDecision) -> bool {
    matches!(
        status,
        ApprovalDecision::Pending | ApprovalDecision::Approved
    )
}

pub fn approval_pending_value(tool_name: &str, result: PendingApprovalResult) -> Value {
    let request = result.request;
    let retry_allowed = approval_retry_allowed(&request.status);
    let status = approval_flow_status(&request.status);
    let action_phase = approval_action_phase(&request.status);
    let blocking_reason = approval_blocking_reason(&request.status);
    let action_id = request
        .approval_key
        .clone()
        .unwrap_or_else(|| request.request_id.clone());
    let retry_request_id = request.request_id.clone();

    json!({
        "approvalRequired": result.approval_required,
        "request": request.clone(),
        "status": status,
        "blockingReason": blocking_reason,
        "approval": {
            "required": true,
            "status": request.status,
            "request": request,
        },
        "action": {
            "toolName": tool_name,
            "actionId": action_id,
            "phase": action_phase,
            "replayUnsafe": true,
            "retryable": retry_allowed,
            "degradationMode": "approval-required",
        },
        "retry": {
            "allowed": retry_allowed,
            "approvalRequestId": retry_request_id,
        }
    })
}
