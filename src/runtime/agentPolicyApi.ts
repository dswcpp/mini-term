import { invoke } from '@tauri-apps/api/core';
import type {
  AgentClientType,
  McpClientInstallResult,
  AgentPolicyExportBundle,
  AgentPolicyProfile,
  TaskContextPreset,
  TaskEffectivePolicy,
  TaskInjectionPreview,
  TaskTarget,
} from '../types';

export async function listAgentPolicyProfiles(): Promise<AgentPolicyProfile[]> {
  return invoke<AgentPolicyProfile[]>('list_agent_policy_profiles');
}

export async function getAgentPolicyProfile(profileId: string): Promise<AgentPolicyProfile> {
  return invoke<AgentPolicyProfile>('get_agent_policy_profile', { profileId });
}

export async function getDefaultAgentPolicyProfile(profileId: string): Promise<AgentPolicyProfile> {
  return invoke<AgentPolicyProfile>('get_default_agent_policy_profile', { profileId });
}

export async function saveAgentPolicyProfile(profile: AgentPolicyProfile): Promise<AgentPolicyProfile> {
  return invoke<AgentPolicyProfile>('save_agent_policy_profile', { profile });
}

export async function resetAgentPolicyProfile(profileId: string): Promise<AgentPolicyProfile> {
  return invoke<AgentPolicyProfile>('reset_agent_policy_profile', { profileId });
}

export async function exportAgentPolicyBundle(
  clientType: AgentClientType,
  workspaceId?: string,
): Promise<AgentPolicyExportBundle> {
  return invoke<AgentPolicyExportBundle>('export_agent_policy_bundle', { clientType, workspaceId });
}

export async function installMcpClientConfig(clientType: AgentClientType): Promise<McpClientInstallResult> {
  return invoke<McpClientInstallResult>('install_mcp_client_config_command', { clientType });
}

export async function getTaskInjectionPreview(
  target: TaskTarget,
  workspaceId: string,
  preset: TaskContextPreset,
  prompt: string,
): Promise<TaskInjectionPreview> {
  return invoke<TaskInjectionPreview>('get_task_injection_preview', { target, workspaceId, preset, prompt });
}

export async function getTaskEffectivePolicy(taskId: string): Promise<TaskEffectivePolicy> {
  return invoke<TaskEffectivePolicy>('get_task_effective_policy', { taskId });
}
