import type {
  AgentBackendCapabilities,
  AgentBackendDescriptor,
  AgentBackendKind,
  AgentBackendRuntimeStatus,
  AgentBackendTransport,
  TaskTarget,
} from "../types";

const DEFAULT_BACKEND_CAPABILITIES: AgentBackendCapabilities = {
  supportsWorkers: false,
  supportsResume: false,
  supportsToolCalls: false,
  brokeredTools: false,
  brokeredApprovals: false,
  restrictedToolNames: [],
};

function normalizeTarget(value: TaskTarget | undefined): TaskTarget {
  return value === "claude" ? "claude" : "codex";
}

function normalizeBackendKind(
  value: AgentBackendKind | undefined,
  backendId: string,
): AgentBackendKind {
  if (value === "builtin-cli" || value === "sidecar") {
    return value;
  }
  return backendId.includes("sidecar") ? "sidecar" : "builtin-cli";
}

function normalizeBackendTransport(
  value: AgentBackendTransport | undefined,
  kind: AgentBackendKind,
): AgentBackendTransport {
  if (value === "pty-command" || value === "sidecar-rpc") {
    return value;
  }
  return kind === "sidecar" ? "sidecar-rpc" : "pty-command";
}

function normalizeBackendStatus(
  value: AgentBackendRuntimeStatus | undefined,
  configured: boolean,
  available: boolean,
): AgentBackendRuntimeStatus {
  if (
    value === "unconfigured" ||
    value === "configured" ||
    value === "starting" ||
    value === "ready" ||
    value === "degraded" ||
    value === "error"
  ) {
    return value;
  }
  if (available) {
    return "ready";
  }
  if (configured) {
    return "configured";
  }
  return "unconfigured";
}

export function normalizeAgentBackendCapabilities(
  capabilities?: Partial<AgentBackendCapabilities> | null,
): AgentBackendCapabilities {
  return {
    ...DEFAULT_BACKEND_CAPABILITIES,
    ...(capabilities ?? {}),
    restrictedToolNames: Array.isArray(capabilities?.restrictedToolNames)
      ? capabilities.restrictedToolNames.filter(
          (toolName): toolName is string =>
            typeof toolName === "string" && toolName.trim().length > 0,
        )
      : [],
  };
}

export function normalizeAgentBackendDescriptor(
  backend: Partial<AgentBackendDescriptor>,
): AgentBackendDescriptor {
  const backendId =
    typeof backend.backendId === "string" && backend.backendId.trim().length > 0
      ? backend.backendId
      : "unknown-backend";
  const kind = normalizeBackendKind(backend.kind, backendId);
  const builtin = backend.builtin ?? kind === "builtin-cli";
  const configured = backend.configured ?? builtin;
  const available = backend.available ?? configured;

  return {
    backendId,
    displayName:
      typeof backend.displayName === "string" &&
      backend.displayName.trim().length > 0
        ? backend.displayName
        : backendId,
    target: normalizeTarget(backend.target),
    provider:
      typeof backend.provider === "string" && backend.provider.trim().length > 0
        ? backend.provider
        : "Unknown",
    preferredForTarget: backend.preferredForTarget ?? false,
    defaultForTarget: backend.defaultForTarget ?? false,
    cliCommand: backend.cliCommand ?? undefined,
    description:
      typeof backend.description === "string" ? backend.description : "",
    builtin,
    kind,
    transport: normalizeBackendTransport(backend.transport, kind),
    capabilities: normalizeAgentBackendCapabilities(backend.capabilities),
    configured,
    available,
    status: normalizeBackendStatus(backend.status, configured, available),
    statusMessage: backend.statusMessage ?? undefined,
    routingStatusMessage: backend.routingStatusMessage ?? undefined,
    lastError: backend.lastError ?? undefined,
    lastHandshakeAt: backend.lastHandshakeAt ?? undefined,
  };
}

export function normalizeAgentBackends(
  backends: Partial<AgentBackendDescriptor>[] | null | undefined,
): AgentBackendDescriptor[] {
  if (!Array.isArray(backends)) {
    return [];
  }
  return backends.map(normalizeAgentBackendDescriptor);
}
