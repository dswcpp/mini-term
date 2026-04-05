import { invoke } from '@tauri-apps/api/core';
import type { EmbeddedMcpCallResult, EmbeddedMcpToolDefinition, McpLaunchInfo } from '../types';

export async function getEmbeddedMcpLaunchInfo(): Promise<McpLaunchInfo> {
  return invoke<McpLaunchInfo>('get_embedded_mcp_launch_info');
}

export async function listEmbeddedMcpTools(): Promise<EmbeddedMcpToolDefinition[]> {
  return invoke<EmbeddedMcpToolDefinition[]>('list_embedded_mcp_tools_command');
}

export async function callEmbeddedMcpTool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<EmbeddedMcpCallResult> {
  return invoke<EmbeddedMcpCallResult>('call_embedded_mcp_tool_command', {
    name,
    arguments: args,
  });
}
