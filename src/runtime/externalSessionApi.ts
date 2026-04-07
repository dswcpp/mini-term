import { invoke } from "@tauri-apps/api/core";
import type {
  ExternalSessionDeleteOutcome,
  ExternalSessionMessage,
  ExternalSessionSummary,
  ExternalSessionProviderId,
} from "../types";

export async function listExternalSessions(
  projectPaths: string[],
): Promise<ExternalSessionSummary[]> {
  return invoke<ExternalSessionSummary[]>("list_external_sessions", {
    projectPaths,
  });
}

export async function getExternalSessionMessages(
  providerId: ExternalSessionProviderId,
  sourcePath: string,
): Promise<ExternalSessionMessage[]> {
  return invoke<ExternalSessionMessage[]>("get_external_session_messages", {
    providerId,
    sourcePath,
  });
}

export async function deleteExternalSession(
  providerId: ExternalSessionProviderId,
  sessionId: string,
  sourcePath: string,
): Promise<ExternalSessionDeleteOutcome> {
  return invoke<ExternalSessionDeleteOutcome>("delete_external_session", {
    providerId,
    sessionId,
    sourcePath,
  });
}
