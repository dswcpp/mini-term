import { invoke } from "@tauri-apps/api/core";
import type {
  ExternalMcpCatalog,
  ExternalMcpClientType,
  ExternalMcpServer,
  ExternalMcpSyncResult,
} from "../types";

export async function listExternalMcpServers(): Promise<ExternalMcpCatalog> {
  return invoke<ExternalMcpCatalog>("list_external_mcp_servers_command");
}

export async function syncExternalMcpServers(
  clientTypes: ExternalMcpClientType[],
  servers: ExternalMcpServer[],
): Promise<ExternalMcpSyncResult[]> {
  return invoke<ExternalMcpSyncResult[]>("sync_external_mcp_servers_command", {
    request: {
      clientTypes,
      servers,
    },
  });
}
