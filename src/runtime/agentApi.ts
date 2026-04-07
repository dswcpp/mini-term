import { invoke } from "@tauri-apps/api/core";
import type {
  AgentBackendConnectionTestResult,
  AgentActionResult,
  AgentBackendDescriptor,
  AgentTaskRuntimeEvent,
  AgentWorkspaceSummary,
  AgentTaskStatusDetail,
  AgentTaskSummary,
  ApprovalRequest,
  StartAgentTaskInput,
  SpawnWorkerInput,
  TaskContextPreset,
  WorkspaceContextResult,
} from "../types";
import { normalizeAgentBackends } from "../utils/agentBackends";

export async function listApprovalRequests(): Promise<ApprovalRequest[]> {
  return invoke<ApprovalRequest[]>("list_approval_requests");
}

export async function listAgentBackends(): Promise<AgentBackendDescriptor[]> {
  const result = await invoke<AgentBackendDescriptor[]>("list_agent_backends");
  return normalizeAgentBackends(result);
}

export async function testAgentBackendConnection(
  backendId: string,
): Promise<AgentBackendConnectionTestResult> {
  return invoke<AgentBackendConnectionTestResult>("test_agent_backend_connection", {
    backendId,
  });
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

export async function startAgentTask(
  input: StartAgentTaskInput,
): Promise<AgentTaskSummary> {
  return invoke<AgentTaskSummary>("start_agent_task", { input });
}

export async function sendAgentTaskInput(
  taskId: string,
  input: string,
): Promise<AgentTaskSummary> {
  return invoke<AgentTaskSummary>("send_agent_task_input", { taskId, input });
}

export async function spawnWorkerTask(
  input: SpawnWorkerInput,
): Promise<AgentTaskSummary> {
  return invoke<AgentTaskSummary>("spawn_worker_agent_task", { input });
}

export async function closeAgentTask(
  taskId: string,
  approvalRequestId?: string,
  cascadeChildren?: boolean,
): Promise<AgentActionResult<AgentTaskSummary>> {
  return invoke<AgentActionResult<AgentTaskSummary>>("close_agent_task", {
    taskId,
    approvalRequestId,
    cascadeChildren,
  });
}

export async function resumeAgentTask(
  taskId: string,
): Promise<AgentTaskStatusDetail> {
  return invoke<AgentTaskStatusDetail>("resume_agent_task", { taskId });
}

export async function listAgentTaskEvents(
  taskId: string,
  limit?: number,
  includeRelated?: boolean,
): Promise<AgentTaskRuntimeEvent[]> {
  return invoke<AgentTaskRuntimeEvent[]>("list_agent_task_events", {
    taskId,
    limit,
    includeRelated,
  });
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
