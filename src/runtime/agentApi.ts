import { invoke } from "@tauri-apps/api/core";
import type {
  AgentActionResult,
  AgentBackendDescriptor,
  AgentWorkspaceSummary,
  AgentTaskStatusDetail,
  AgentTaskSummary,
  ApprovalRequest,
  TaskContextPreset,
  WorkspaceContextResult,
} from "../types";

export async function listApprovalRequests(): Promise<ApprovalRequest[]> {
  return invoke<ApprovalRequest[]>("list_approval_requests");
}

export async function listAgentBackends(): Promise<AgentBackendDescriptor[]> {
  return invoke<AgentBackendDescriptor[]>("list_agent_backends");
}

export async function resolveApprovalRequest(
  requestId: string,
  approved: boolean,
): Promise<ApprovalRequest> {
  return invoke<ApprovalRequest>("resolve_approval_request", {
    requestId,
    approved,
  });
}

export async function listAttentionTaskSummaries(): Promise<
  AgentTaskSummary[]
> {
  return invoke<AgentTaskSummary[]>("list_attention_task_summaries");
}

export async function listAgentTasks(): Promise<AgentTaskStatusDetail[]> {
  return invoke<AgentTaskStatusDetail[]>("list_agent_tasks");
}

export async function listAgentWorkspaces(): Promise<AgentWorkspaceSummary[]> {
  return invoke<AgentWorkspaceSummary[]>("list_agent_workspaces");
}

export async function getAgentTaskStatus(
  taskId: string,
): Promise<AgentTaskStatusDetail> {
  return invoke<AgentTaskStatusDetail>("get_agent_task_status", { taskId });
}

export async function getAgentWorkspaceContext(
  workspaceId: string,
  preset: TaskContextPreset = "light",
): Promise<WorkspaceContextResult> {
  return invoke<WorkspaceContextResult>("get_agent_workspace_context", {
    workspaceId,
    preset,
  });
}

export async function sendAgentTaskInput(
  taskId: string,
  input: string,
): Promise<AgentTaskSummary> {
  return invoke<AgentTaskSummary>("send_agent_task_input", { taskId, input });
}

export async function closeAgentTask(
  taskId: string,
  approvalRequestId?: string,
): Promise<AgentActionResult<AgentTaskSummary>> {
  return invoke<AgentActionResult<AgentTaskSummary>>("close_agent_task", {
    taskId,
    approvalRequestId,
  });
}

export async function resumeAgentTask(
  taskId: string,
): Promise<AgentTaskStatusDetail> {
  return invoke<AgentTaskStatusDetail>("resume_agent_task", { taskId });
}

export async function saveAgentTaskPlan(
  taskId: string,
  markdown: string,
  title?: string,
  fileName?: string,
): Promise<AgentTaskStatusDetail> {
  return invoke<AgentTaskStatusDetail>("save_agent_task_plan", {
    taskId,
    markdown,
    title,
    fileName,
  });
}
