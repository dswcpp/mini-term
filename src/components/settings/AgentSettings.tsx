import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../store';
import type {
  AgentClientType,
  AgentBackendConnectionTestResult,
  AgentBackendDescriptor,
  AgentBackendRoutingConfig,
  AgentBackendsConfig,
  ClaudeSidecarBackendConfig,
  ClaudeSidecarProviderConfig,
  EmbeddedMcpToolDefinition,
  AgentPoliciesConfig,
  ExternalMcpCatalog,
  ExternalMcpClientType,
  ExternalMcpSyncResult,
  McpClientInstallResult,
  AgentPolicyExportBundle,
  AgentPolicyProfile,
  AppConfig,
  McpLaunchInfo,
  PromptStyle,
  TaskContextPreset,
  TaskInjectionPreview,
  TaskTarget,
  WorkspacePolicyOverride,
} from '../../types';
import { patchAppConfig } from './saveConfig';
import { listAgentBackends, testAgentBackendConnection } from '../../runtime/agentApi';
import {
  exportAgentPolicyBundle,
  getDefaultAgentPolicyProfile,
  installMcpClientConfig,
  getTaskInjectionPreview,
  listAgentPolicyProfiles,
  resetAgentPolicyProfile,
  saveAgentPolicyProfile,
} from '../../runtime/agentPolicyApi';
import {
  callEmbeddedMcpTool,
  getEmbeddedMcpLaunchInfo,
  listEmbeddedMcpTools,
} from '../../runtime/embeddedMcpApi';
import { listExternalMcpServers, syncExternalMcpServers } from '../../runtime/mcpInteropApi';
import {
  createDefaultAgentBackendsConfig,
  createDefaultExternalMcpInteropConfig,
} from '../../runtime/tauriRuntime';
import { exportAgentPolicyBundleFiles } from '../../utils/agentPolicyExport';
import { normalizeAgentBackends } from '../../utils/agentBackends';

const CLIENT_TYPES: AgentClientType[] = ['codex', 'claude', 'cursor', 'generic-mcp'];
const PROMPT_STYLES: PromptStyle[] = ['minimal', 'balanced', 'strict'];
const TASK_TARGETS: TaskTarget[] = ['codex', 'claude'];
const PRESETS: TaskContextPreset[] = ['light', 'standard', 'review'];

function targetLabel(target: TaskTarget) {
  return target === 'codex' ? 'Codex' : 'Claude';
}

function backendKindLabel(kind: AgentBackendDescriptor['kind']) {
  return kind === 'sidecar' ? 'Sidecar' : 'Built-in CLI';
}

function backendTransportLabel(transport: AgentBackendDescriptor['transport']) {
  return transport === 'sidecar-rpc' ? 'Sidecar RPC' : 'PTY Command';
}

function backendRuntimeStatusLabel(status?: AgentBackendDescriptor['status']) {
  switch (status) {
    case 'unconfigured':
      return '未配置';
    case 'configured':
      return '已配置';
    case 'starting':
      return '启动中';
    case 'ready':
      return '就绪';
    case 'degraded':
      return '降级';
    case 'error':
      return '错误';
    default:
      return '未知';
  }
}

function formatBackendHandshakeTime(timestamp?: number) {
  if (!timestamp) {
    return '尚未握手';
  }
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}

function formatRuntimeTimestamp(timestamp?: number) {
  if (!timestamp) {
    return '尚无记录';
  }
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}

function cloneSidecarConfig(config?: ClaudeSidecarBackendConfig): ClaudeSidecarBackendConfig {
  const fallback = createDefaultAgentBackendsConfig().claudeSidecar;
  return {
    ...(config ?? fallback),
    args: [...(config?.args ?? fallback.args)],
    env: { ...(config?.env ?? fallback.env) },
    provider: {
      ...(fallback.provider ?? {}),
      ...(config?.provider ?? {}),
    },
  };
}

function cloneBackendRoutingConfig(config?: AgentBackendsConfig): AgentBackendRoutingConfig {
  const fallback = createDefaultAgentBackendsConfig().routing;
  return {
    codex: {
      ...fallback.codex,
      ...(config?.routing?.codex ?? {}),
    },
    claude: {
      ...fallback.claude,
      ...(config?.routing?.claude ?? {}),
    },
  };
}

function resolvedDefaultBackendForTarget(
  backends: AgentBackendDescriptor[],
  target: TaskTarget,
) {
  return (
    backends.find((backend) => backend.target === target && backend.defaultForTarget) ??
    backends.find((backend) => backend.target === target && backend.kind === 'builtin-cli') ??
    backends.find((backend) => backend.target === target) ??
    null
  );
}

function capabilityTone(enabled: boolean) {
  return enabled
    ? 'border-[var(--accent)]/30 bg-[var(--accent-subtle)] text-[var(--accent)]'
    : 'border-[var(--border-subtle)] bg-[var(--bg-base)] text-[var(--text-muted)]';
}

type ProfileSectionKey =
  | 'platformPromptTemplate'
  | 'toolPolicyPromptTemplate'
  | 'clientWrapperPromptTemplate'
  | 'skillTemplate'
  | 'mcpInstructionsTemplate';

interface ProfileSectionDefinition {
  key: ProfileSectionKey;
  title: string;
  description: string;
  rows: number;
}

const PROFILE_SECTION_DEFINITIONS: ProfileSectionDefinition[] = [
  {
    key: 'platformPromptTemplate',
    title: '平台提示词',
    description: '定义 Mini-Term 的角色、控制边界和硬约束。这一层是平台基线，不应混入客户端特有语气。',
    rows: 10,
  },
  {
    key: 'toolPolicyPromptTemplate',
    title: '工具策略提示词',
    description: '定义工具分组、推荐调用顺序、只读检查规则、任务控制规则以及审批停止点。',
    rows: 10,
  },
  {
    key: 'clientWrapperPromptTemplate',
    title: '客户端适配提示词',
    description: '将平台基线适配到 Codex、Claude、Cursor 或通用 MCP 客户端，但不能削弱核心约束。',
    rows: 9,
  },
  {
    key: 'skillTemplate',
    title: 'Skill 工作流',
    description: '这是导出的 skill 指南，应重点说明工作流和操作顺序，而不是重复整段 system prompt。',
    rows: 9,
  },
  {
    key: 'mcpInstructionsTemplate',
    title: 'MCP 导出说明',
    description: '导出的 MCP 交接说明应简短且可执行，聚焦启动命令、审批门禁和 review 预期。',
    rows: 7,
  },
];

const SIDECAR_PROVIDER_ENV_EXAMPLE = JSON.stringify(
  {
    MINI_TERM_SIDECAR_PROVIDER: 'openai-compatible',
    MINI_TERM_SIDECAR_BASE_URL: 'https://api.openai.com/v1',
    MINI_TERM_SIDECAR_MODEL: 'gpt-4.1-mini',
    MINI_TERM_SIDECAR_API_KEY: '<YOUR_API_KEY>',
    MINI_TERM_SIDECAR_PROVIDER_TIMEOUT_MS: '60000',
  },
  null,
  2,
);

const SIDECAR_PROVIDER_ENV_NOTES = [
  '`MINI_TERM_SIDECAR_PROVIDER` 默认是 `reference`，也支持 `openai-compatible` 和 `anthropic`。',
  '`MINI_TERM_SIDECAR_MODEL` 在 `openai-compatible` 与 `anthropic` 模式下必填。',
  'API Key 可以直接写入 `Env JSON`，也可以在下方改成读取 Mini-Term 进程环境变量，优先推荐后者。',
  '`MINI_TERM_SIDECAR_BASE_URL` 对 `openai-compatible` 默认回退到 `https://api.openai.com/v1`，对 `anthropic` 默认回退到 `https://api.anthropic.com`。',
  '`MINI_TERM_SIDECAR_PROVIDER_TIMEOUT_MS` 默认是 `60000`，可按模型响应时延调整。',
  '`MINI_TERM_SIDECAR_SYSTEM_PROMPT` 可选，用于覆盖 sidecar 发给模型的 system prompt。',
];

type SidecarProviderMode = 'reference' | 'openai-compatible' | 'anthropic';

interface SidecarProviderDraft {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  apiKeyEnvVar: string;
  timeoutMs: string;
  systemPrompt: string;
}

const SIDECAR_PROVIDER_ENV_KEYS = [
  'MINI_TERM_SIDECAR_PROVIDER',
  'MINI_TERM_SIDECAR_BASE_URL',
  'MINI_TERM_SIDECAR_MODEL',
  'MINI_TERM_SIDECAR_API_KEY',
  'MINI_TERM_SIDECAR_PROVIDER_TIMEOUT_MS',
  'MINI_TERM_SIDECAR_SYSTEM_PROMPT',
] as const;

function parseSidecarEnvJson(value: string): Record<string, string> | null {
  try {
    const parsed = JSON.parse(value || '{}') as unknown;
    if (parsed == null || Array.isArray(parsed) || typeof parsed !== 'object') {
      return null;
    }
    if (Object.values(parsed).some((entry) => typeof entry !== 'string')) {
      return null;
    }
    return parsed as Record<string, string>;
  } catch {
    return null;
  }
}

function normalizeSidecarProviderKind(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase();
  return normalized || 'reference';
}

function isKnownSidecarProviderMode(value: string): value is SidecarProviderMode {
  return value === 'reference' || value === 'openai-compatible' || value === 'anthropic';
}

function createSidecarProviderDraftFromEnv(env: Record<string, string>): SidecarProviderDraft {
  return {
    provider: normalizeSidecarProviderKind(env.MINI_TERM_SIDECAR_PROVIDER),
    baseUrl: env.MINI_TERM_SIDECAR_BASE_URL ?? '',
    model: env.MINI_TERM_SIDECAR_MODEL ?? '',
    apiKey: env.MINI_TERM_SIDECAR_API_KEY ?? '',
    apiKeyEnvVar: '',
    timeoutMs: env.MINI_TERM_SIDECAR_PROVIDER_TIMEOUT_MS ?? '',
    systemPrompt: env.MINI_TERM_SIDECAR_SYSTEM_PROMPT ?? '',
  };
}

function createSidecarProviderDraft(config: ClaudeSidecarBackendConfig): SidecarProviderDraft {
  const envDraft = createSidecarProviderDraftFromEnv(config.env);
  const normalizedConfigKind = normalizeSidecarProviderKind(config.provider?.kind);
  const hasExplicitProviderConfig =
    normalizedConfigKind !== 'reference' ||
    config.provider?.baseUrl !== undefined ||
    config.provider?.model !== undefined ||
    config.provider?.apiKey !== undefined ||
    config.provider?.apiKeyEnvVar !== undefined ||
    config.provider?.timeoutMs !== undefined ||
    config.provider?.systemPrompt !== undefined;

  return {
    provider: hasExplicitProviderConfig ? normalizedConfigKind : envDraft.provider,
    baseUrl: config.provider?.baseUrl ?? envDraft.baseUrl,
    model: config.provider?.model ?? envDraft.model,
    apiKey: config.provider?.apiKey ?? envDraft.apiKey,
    apiKeyEnvVar: config.provider?.apiKeyEnvVar ?? '',
    timeoutMs:
      config.provider?.timeoutMs !== undefined ? String(config.provider.timeoutMs) : envDraft.timeoutMs,
    systemPrompt: config.provider?.systemPrompt ?? envDraft.systemPrompt,
  };
}

function mergeSidecarProviderDraftIntoEnv(
  baseEnv: Record<string, string>,
  draft: SidecarProviderDraft,
): Record<string, string> {
  const nextEnv = { ...baseEnv };
  for (const key of SIDECAR_PROVIDER_ENV_KEYS) {
    delete nextEnv[key];
  }

  nextEnv.MINI_TERM_SIDECAR_PROVIDER = normalizeSidecarProviderKind(draft.provider);

  const trimmedBaseUrl = draft.baseUrl.trim();
  const trimmedModel = draft.model.trim();
  const trimmedApiKey = draft.apiKey.trim();
  const trimmedApiKeyEnvVar = draft.apiKeyEnvVar.trim();
  const trimmedTimeoutMs = draft.timeoutMs.trim();
  const trimmedSystemPrompt = draft.systemPrompt.trim();

  if (trimmedBaseUrl) {
    nextEnv.MINI_TERM_SIDECAR_BASE_URL = trimmedBaseUrl;
  }
  if (trimmedModel) {
    nextEnv.MINI_TERM_SIDECAR_MODEL = trimmedModel;
  }
  if (trimmedApiKey && !trimmedApiKeyEnvVar) {
    nextEnv.MINI_TERM_SIDECAR_API_KEY = trimmedApiKey;
  }
  if (trimmedTimeoutMs) {
    nextEnv.MINI_TERM_SIDECAR_PROVIDER_TIMEOUT_MS = trimmedTimeoutMs;
  }
  if (trimmedSystemPrompt) {
    nextEnv.MINI_TERM_SIDECAR_SYSTEM_PROMPT = trimmedSystemPrompt;
  }

  return nextEnv;
}

function isValidEnvVarName(value: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function createSidecarProviderConfig(
  draft: SidecarProviderDraft,
): ClaudeSidecarProviderConfig {
  const kind = normalizeSidecarProviderKind(draft.provider);
  const trimmedBaseUrl = draft.baseUrl.trim();
  const trimmedModel = draft.model.trim();
  const trimmedApiKey = draft.apiKey.trim();
  const trimmedApiKeyEnvVar = draft.apiKeyEnvVar.trim();
  const trimmedTimeoutMs = draft.timeoutMs.trim();
  const trimmedSystemPrompt = draft.systemPrompt.trim();

  if (trimmedTimeoutMs) {
    const parsed = Number.parseInt(trimmedTimeoutMs, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error('Provider Timeout 必须是正整数毫秒。');
    }
  }
  if (trimmedApiKeyEnvVar && !isValidEnvVarName(trimmedApiKeyEnvVar)) {
    throw new Error('API Key Env Var 必须是合法环境变量名。');
  }

  return {
    kind,
    baseUrl: trimmedBaseUrl || undefined,
    model: trimmedModel || undefined,
    apiKey: trimmedApiKeyEnvVar ? undefined : trimmedApiKey || undefined,
    apiKeyEnvVar: trimmedApiKeyEnvVar || undefined,
    timeoutMs: trimmedTimeoutMs ? Number.parseInt(trimmedTimeoutMs, 10) : undefined,
    systemPrompt: trimmedSystemPrompt || undefined,
  };
}

function serializeExternalMcpServersDraft(servers: ExternalMcpCatalog['servers']): string {
  return JSON.stringify(servers, null, 2);
}

function parseStringArrayField(value: unknown, label: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} 必须是字符串数组。`);
  }
  return value;
}

function parseStringRecordField(value: unknown, label: string): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  if (value == null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`${label} 必须是对象。`);
  }
  const entries = Object.entries(value);
  if (entries.some(([, entryValue]) => typeof entryValue !== 'string')) {
    throw new Error(`${label} 的值必须全部是字符串。`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function parseOptionalStringField(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${label} 必须是字符串。`);
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseExternalMcpServersDraft(value: string): ExternalMcpCatalog['servers'] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || '[]');
  } catch {
    throw new Error('External MCP servers JSON 不是合法 JSON。');
  }

  if (!Array.isArray(parsed)) {
    throw new Error('External MCP servers JSON 必须是数组。');
  }

  return parsed.map((item, index) => {
    if (item == null || Array.isArray(item) || typeof item !== 'object') {
      throw new Error(`第 ${index + 1} 个 server 必须是对象。`);
    }

    const server = item as Record<string, unknown>;
    const id = parseOptionalStringField(server.id, `第 ${index + 1} 个 server.id`);
    const name = parseOptionalStringField(server.name, `第 ${index + 1} 个 server.name`);
    const transport = parseOptionalStringField(
      server.transport,
      `第 ${index + 1} 个 server.transport`,
    );

    if (!id) {
      throw new Error(`第 ${index + 1} 个 server.id 不能为空。`);
    }
    if (!transport) {
      throw new Error(`第 ${index + 1} 个 server.transport 不能为空。`);
    }

    return {
      id,
      name: name ?? id,
      transport,
      command: parseOptionalStringField(server.command, `第 ${index + 1} 个 server.command`),
      args: parseStringArrayField(server.args, `第 ${index + 1} 个 server.args`),
      cwd: parseOptionalStringField(server.cwd, `第 ${index + 1} 个 server.cwd`),
      env: parseStringRecordField(server.env, `第 ${index + 1} 个 server.env`),
      url: parseOptionalStringField(server.url, `第 ${index + 1} 个 server.url`),
      headers: parseStringRecordField(server.headers, `第 ${index + 1} 个 server.headers`),
      sourceClients: parseStringArrayField(
        server.sourceClients,
        `第 ${index + 1} 个 server.sourceClients`,
      ) as ExternalMcpClientType[],
      sourcePaths: parseStringArrayField(
        server.sourcePaths,
        `第 ${index + 1} 个 server.sourcePaths`,
      ),
    };
  });
}

function CopyButton({ value, label }: { value: string; label: string }) {
  return (
    <button
      type="button"
      className="rounded-[var(--radius-sm)] border border-[var(--border-default)] px-2 py-1 text-[11px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
      onClick={() => void navigator.clipboard.writeText(value)}
    >
      {label}
    </button>
  );
}

function SectionCard({
  title,
  description,
  value,
  rows,
  defaultValue,
  onChange,
  onReset,
}: {
  title: string;
  description: string;
  value: string;
  rows: number;
  defaultValue?: string;
  onChange: (value: string) => void;
  onReset?: () => void;
}) {
  const isModified = defaultValue !== undefined && value !== defaultValue;

  return (
    <div className="space-y-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium text-[var(--text-primary)]">{title}</h3>
            {defaultValue !== undefined ? (
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] ${
                  isModified
                    ? 'bg-[var(--warning-subtle,#3a2913)] text-[var(--warning,#f0b35d)]'
                    : 'bg-[var(--accent-subtle)] text-[var(--accent)]'
                }`}
              >
                {isModified ? '已修改' : '默认'}
              </span>
            ) : (
              <span className="rounded-full bg-[var(--border-subtle)] px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-[var(--text-muted)]">
                自定义
              </span>
            )}
          </div>
          <p className="text-sm text-[var(--text-muted)]">{description}</p>
        </div>
        {defaultValue !== undefined && onReset ? (
          <button
            type="button"
            className="rounded-[var(--radius-sm)] border border-[var(--border-default)] px-2 py-1 text-[11px] text-[var(--text-secondary)] disabled:cursor-not-allowed disabled:opacity-50"
            onClick={onReset}
            disabled={!isModified}
          >
            重置当前分区
          </button>
        ) : null}
      </div>
      <textarea
        value={value}
        rows={rows}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-2 text-sm"
      />
      {defaultValue !== undefined ? (
        <details className="rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-2">
          <summary className="cursor-pointer text-xs uppercase tracking-[0.08em] text-[var(--text-muted)]">
            默认参考
          </summary>
          <textarea
            readOnly
            value={defaultValue}
            rows={Math.max(4, Math.min(rows, 10))}
            className="mt-3 w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-base)] px-3 py-2 text-sm text-[var(--text-secondary)]"
          />
        </details>
      ) : null}
    </div>
  );
}

function ReadonlyBlock({
  label,
  value,
  rows = 8,
}: {
  label: string;
  value: string;
  rows?: number;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm text-[var(--text-secondary)]">{label}</div>
        <CopyButton label={`复制${label}`} value={value} />
      </div>
      <textarea
        readOnly
        value={value}
        rows={rows}
        className="w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-2 text-sm"
      />
    </div>
  );
}

interface AgentSettingsProps {
  mode?: 'agent' | 'mcp' | 'all';
}

export function AgentSettings({ mode = 'agent' }: AgentSettingsProps) {
  const showAgentSections = mode === 'agent' || mode === 'all';
  const showMcpSections = mode === 'mcp' || mode === 'all';
  const config = useAppStore((state) => state.config);
  const setConfig = useAppStore((state) => state.setConfig);
  const workspaces = config.workspaces;
  const agentPolicies = config.agentPolicies;

  const [profiles, setProfiles] = useState<AgentPolicyProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState('codex-default');
  const [activeProfileSection, setActiveProfileSection] = useState<ProfileSectionKey>('platformPromptTemplate');
  const [editedProfile, setEditedProfile] = useState<AgentPolicyProfile | null>(null);
  const [defaultProfile, setDefaultProfile] = useState<AgentPolicyProfile | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState('');
  const [exportClientType, setExportClientType] = useState<AgentClientType>('codex');
  const [exportBundle, setExportBundle] = useState<AgentPolicyExportBundle | null>(null);
  const [injectingClientType, setInjectingClientType] = useState<AgentClientType | null>(null);
  const [installResult, setInstallResult] = useState<McpClientInstallResult | null>(null);
  const [previewTarget, setPreviewTarget] = useState<TaskTarget>('codex');
  const [previewPreset, setPreviewPreset] = useState<TaskContextPreset>('standard');
  const [activeInjectionTarget, setActiveInjectionTarget] = useState<TaskTarget>('codex');
  const [activeInjectionPreset, setActiveInjectionPreset] = useState<TaskContextPreset>('standard');
  const [previewPrompt, setPreviewPrompt] = useState('Review the current workspace and explain what changed.');
  const [previewResult, setPreviewResult] = useState<TaskInjectionPreview | null>(null);
  const [agentBackends, setAgentBackends] = useState<AgentBackendDescriptor[]>([]);
  const [agentBackendsError, setAgentBackendsError] = useState('');
  const [routingDraft, setRoutingDraft] = useState<AgentBackendRoutingConfig>(() =>
    cloneBackendRoutingConfig(config.agentBackends),
  );
  const [sidecarDraft, setSidecarDraft] = useState<ClaudeSidecarBackendConfig>(() =>
    cloneSidecarConfig(config.agentBackends?.claudeSidecar),
  );
  const [sidecarArgsJson, setSidecarArgsJson] = useState(() =>
    JSON.stringify(cloneSidecarConfig(config.agentBackends?.claudeSidecar).args, null, 2),
  );
  const [sidecarEnvJson, setSidecarEnvJson] = useState(() =>
    JSON.stringify(cloneSidecarConfig(config.agentBackends?.claudeSidecar).env, null, 2),
  );
  const [sidecarProviderDraft, setSidecarProviderDraft] = useState<SidecarProviderDraft>(() =>
    createSidecarProviderDraft(cloneSidecarConfig(config.agentBackends?.claudeSidecar)),
  );
  const [backendTestResult, setBackendTestResult] = useState<AgentBackendConnectionTestResult | null>(null);
  const [testingBackendId, setTestingBackendId] = useState<string | null>(null);
  const [embeddedLaunchInfo, setEmbeddedLaunchInfo] = useState<McpLaunchInfo | null>(null);
  const [embeddedTools, setEmbeddedTools] = useState<EmbeddedMcpToolDefinition[]>([]);
  const [selectedEmbeddedTool, setSelectedEmbeddedTool] = useState('ping');
  const [embeddedToolArgs, setEmbeddedToolArgs] = useState('{}');
  const [embeddedToolResult, setEmbeddedToolResult] = useState('');
  const [externalMcpCatalog, setExternalMcpCatalog] = useState<ExternalMcpCatalog | null>(
    () => config.externalMcp?.importedCatalog ?? null,
  );
  const [externalMcpSyncResults, setExternalMcpSyncResults] = useState<ExternalMcpSyncResult[]>(
    () => config.externalMcp?.lastSyncResults ?? [],
  );
  const [externalMcpEditorJson, setExternalMcpEditorJson] = useState(() =>
    serializeExternalMcpServersDraft(config.externalMcp?.importedCatalog?.servers ?? []),
  );
  const [externalMcpEditorError, setExternalMcpEditorError] = useState('');
  const [loadingExternalMcp, setLoadingExternalMcp] = useState(false);
  const [syncingExternalMcpClient, setSyncingExternalMcpClient] = useState<ExternalMcpClientType | 'both' | null>(null);
  const [statusMessage, setStatusMessage] = useState('');

  useEffect(() => {
    if (!selectedWorkspaceId && workspaces[0]) {
      setSelectedWorkspaceId(workspaces[0].id);
    }
  }, [selectedWorkspaceId, workspaces]);

  const selectedOverride = useMemo<WorkspacePolicyOverride | undefined>(() => {
    return agentPolicies?.workspaceOverrides.find(
      (item) => item.workspaceId === selectedWorkspaceId && item.profileId === selectedProfileId,
    );
  }, [agentPolicies?.workspaceOverrides, selectedProfileId, selectedWorkspaceId]);

  const profileSectionData = useMemo(() => {
    if (!editedProfile) {
      return [];
    }
    return PROFILE_SECTION_DEFINITIONS.map((section) => ({
      ...section,
      value: editedProfile[section.key],
      defaultValue: defaultProfile?.[section.key],
    }));
  }, [defaultProfile, editedProfile]);

  const activeProfileSectionData = useMemo(() => {
    return (
      profileSectionData.find((section) => section.key === activeProfileSection) ??
      profileSectionData[0] ??
      null
    );
  }, [activeProfileSection, profileSectionData]);

  const injectionProfileBindings = useMemo(
    () => ({
      codex: agentPolicies?.taskInjection.profileBindings.codex ?? 'codex-default',
      claude: agentPolicies?.taskInjection.profileBindings.claude ?? 'claude-default',
    }),
    [agentPolicies?.taskInjection.profileBindings.claude, agentPolicies?.taskInjection.profileBindings.codex],
  );

  const taskProfilesByTarget = useMemo(
    () => ({
      codex: profiles.filter((profile) => profile.clientType === 'codex'),
      claude: profiles.filter((profile) => profile.clientType === 'claude'),
    }),
    [profiles],
  );

  const activeInjectionProfileCandidates = taskProfilesByTarget[activeInjectionTarget];
  const activeBoundProfileId = injectionProfileBindings[activeInjectionTarget];
  const activeBoundProfile =
    activeInjectionProfileCandidates.find((profile) => profile.id === activeBoundProfileId) ??
    profiles.find((profile) => profile.id === activeBoundProfileId) ??
    null;
  const activeTargetPresetOverride =
    agentPolicies?.taskInjection.targetPresetPolicies[activeInjectionTarget];
  const activeTargetPresetValue =
    activeTargetPresetOverride?.[activeInjectionPreset] ??
    agentPolicies?.taskInjection.presetPolicies[activeInjectionPreset] ??
    '';

  const reloadConfig = useCallback(async () => {
    const nextConfig = await invoke<AppConfig>('load_config');
    setConfig(nextConfig);
  }, [setConfig]);

  const loadProfiles = useCallback(async () => {
    try {
      const nextProfiles = await listAgentPolicyProfiles();
      setProfiles(nextProfiles);
      if (!nextProfiles.some((profile) => profile.id === selectedProfileId)) {
        setSelectedProfileId(nextProfiles[0]?.id ?? '');
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '加载策略配置失败');
    }
  }, [selectedProfileId]);

  const loadAgentBackends = useCallback(async () => {
    try {
      const nextBackends = await listAgentBackends();
      setAgentBackends(normalizeAgentBackends(nextBackends));
      setAgentBackendsError('');
    } catch (error) {
      setAgentBackends([]);
      setAgentBackendsError(error instanceof Error ? error.message : '加载任务 backend 失败');
    }
  }, []);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  useEffect(() => {
    void loadAgentBackends();
  }, [loadAgentBackends]);

  useEffect(() => {
    setRoutingDraft(cloneBackendRoutingConfig(config.agentBackends));
    const nextDraft = cloneSidecarConfig(config.agentBackends?.claudeSidecar);
    setSidecarDraft(nextDraft);
    setSidecarArgsJson(JSON.stringify(nextDraft.args, null, 2));
    setSidecarEnvJson(JSON.stringify(nextDraft.env, null, 2));
    setSidecarProviderDraft(createSidecarProviderDraft(nextDraft));
  }, [config.agentBackends]);

  useEffect(() => {
    setExternalMcpCatalog(config.externalMcp?.importedCatalog ?? null);
    setExternalMcpSyncResults(config.externalMcp?.lastSyncResults ?? []);
    setExternalMcpEditorJson(
      serializeExternalMcpServersDraft(config.externalMcp?.importedCatalog?.servers ?? []),
    );
    setExternalMcpEditorError('');
  }, [config.externalMcp]);

  useEffect(() => {
    const profile = profiles.find((item) => item.id === selectedProfileId) ?? null;
    setEditedProfile(profile ? { ...profile, toolUsagePolicy: { ...profile.toolUsagePolicy } } : null);
  }, [profiles, selectedProfileId]);

  useEffect(() => {
    if (!embeddedTools.some((tool) => tool.name === selectedEmbeddedTool)) {
      setSelectedEmbeddedTool(embeddedTools[0]?.name ?? 'ping');
    }
  }, [embeddedTools, selectedEmbeddedTool]);

  useEffect(() => {
    if (!selectedProfileId) {
      setDefaultProfile(null);
      return;
    }
    let cancelled = false;
    const loadDefaultProfile = async () => {
      try {
        const profile = await getDefaultAgentPolicyProfile(selectedProfileId);
        if (!cancelled) {
          setDefaultProfile(profile);
        }
      } catch {
        if (!cancelled) {
          setDefaultProfile(null);
        }
      }
    };
    void loadDefaultProfile();
    return () => {
      cancelled = true;
    };
  }, [selectedProfileId]);

  const updateProfileField = useCallback(
    (field: ProfileSectionKey, value: string) => {
      if (!editedProfile) {
        return;
      }
      setEditedProfile({
        ...editedProfile,
        [field]: value,
      });
    },
    [editedProfile],
  );

  const sidecarBackend = useMemo(
    () => agentBackends.find((backend) => backend.backendId === 'claude-sidecar') ?? null,
    [agentBackends],
  );

  const resolvedDefaultBackends = useMemo(
    () => ({
      codex: resolvedDefaultBackendForTarget(agentBackends, 'codex'),
      claude: resolvedDefaultBackendForTarget(agentBackends, 'claude'),
    }),
    [agentBackends],
  );

  const routingValidationMessages = useMemo(() => {
    const messages: string[] = [];

    for (const target of TASK_TARGETS) {
      const preferredBackendId = routingDraft[target].preferredBackendId?.trim() ?? '';
      if (!preferredBackendId) {
        messages.push(`${targetLabel(target)} 默认 backend 不能为空。`);
        continue;
      }

      const hasMatchingBackend = agentBackends.some(
        (backend) => backend.target === target && backend.backendId === preferredBackendId,
      );
      if (!hasMatchingBackend) {
        messages.push(`${targetLabel(target)} 默认 backend 未在当前注册列表中：${preferredBackendId}`);
      }
    }

    return messages;
  }, [agentBackends, routingDraft]);

  const sidecarValidationMessages = useMemo(() => {
    const messages: string[] = [];

    try {
      const parsedArgs = JSON.parse(sidecarArgsJson || '[]') as unknown;
      if (!Array.isArray(parsedArgs) || parsedArgs.some((value) => typeof value !== 'string')) {
        messages.push('Args JSON 必须是字符串数组。');
      }
    } catch {
      messages.push('Args JSON 必须是合法 JSON。');
    }

    const parsedEnv = parseSidecarEnvJson(sidecarEnvJson);
    if (!parsedEnv) {
      messages.push('Env JSON 必须是字符串值对象。');
    }

    if (sidecarDraft.enabled && sidecarDraft.startupMode === 'process' && !sidecarDraft.command?.trim()) {
      messages.push('启用 process 模式时必须填写 Command。');
    }

    const provider = normalizeSidecarProviderKind(sidecarProviderDraft.provider);
    if (provider === 'openai-compatible' || provider === 'anthropic') {
      if (!sidecarProviderDraft.model.trim()) {
        messages.push(`${provider} provider 必须填写 Model。`);
      }
      if (!sidecarProviderDraft.apiKey.trim() && !sidecarProviderDraft.apiKeyEnvVar.trim()) {
        messages.push(`${provider} provider 必须填写 API Key 或 API Key Env Var。`);
      }
      if (
        sidecarProviderDraft.apiKeyEnvVar.trim() &&
        !isValidEnvVarName(sidecarProviderDraft.apiKeyEnvVar.trim())
      ) {
        messages.push('API Key Env Var 必须是合法环境变量名。');
      }
      if (
        sidecarProviderDraft.baseUrl.trim() &&
        !/^https?:\/\//.test(sidecarProviderDraft.baseUrl.trim())
      ) {
        messages.push('Base URL 必须以 http:// 或 https:// 开头。');
      }
    }

    if (
      sidecarProviderDraft.timeoutMs.trim() &&
      !/^[1-9]\d*$/.test(sidecarProviderDraft.timeoutMs.trim())
    ) {
      messages.push('Provider Timeout 必须是正整数毫秒。');
    }

    return messages;
  }, [sidecarArgsJson, sidecarDraft.command, sidecarDraft.enabled, sidecarDraft.startupMode, sidecarEnvJson, sidecarProviderDraft]);

  const handleSidecarProviderDraftChange = useCallback((patch: Partial<SidecarProviderDraft>) => {
    setSidecarProviderDraft((current) => {
      const next = { ...current, ...patch };
      setSidecarEnvJson((currentEnvJson) => {
        const baseEnv = parseSidecarEnvJson(currentEnvJson) ?? {};
        return JSON.stringify(mergeSidecarProviderDraftIntoEnv(baseEnv, next), null, 2);
      });
      return next;
    });
  }, []);

  const handleSaveBackendRouting = useCallback(async () => {
    try {
      if (routingValidationMessages.length > 0) {
        throw new Error(routingValidationMessages[0]);
      }

      const nextRouting: AgentBackendRoutingConfig = {
        codex: {
          preferredBackendId: routingDraft.codex.preferredBackendId?.trim() || undefined,
          allowBuiltinFallback: routingDraft.codex.allowBuiltinFallback,
        },
        claude: {
          preferredBackendId: routingDraft.claude.preferredBackendId?.trim() || undefined,
          allowBuiltinFallback: routingDraft.claude.allowBuiltinFallback,
        },
      };

      await patchAppConfig((currentConfig) => {
        const currentAgentBackends: AgentBackendsConfig =
          currentConfig.agentBackends ?? createDefaultAgentBackendsConfig();
        return {
          ...currentConfig,
          agentBackends: {
            ...currentAgentBackends,
            routing: nextRouting,
          },
        };
      });
      await reloadConfig();
      await loadAgentBackends();
      setStatusMessage('任务 backend 路由已保存。');
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '保存任务 backend 路由失败');
    }
  }, [loadAgentBackends, reloadConfig, routingDraft, routingValidationMessages]);

  const handleResetBackendRouting = useCallback(() => {
    setRoutingDraft(cloneBackendRoutingConfig(config.agentBackends));
    setStatusMessage('任务 backend 路由草稿已重置为当前已保存配置。');
  }, [config.agentBackends]);

  const handleSidecarEnvJsonChange = useCallback((nextValue: string) => {
    setSidecarEnvJson(nextValue);
    const parsedEnv = parseSidecarEnvJson(nextValue);
    if (parsedEnv) {
      setSidecarProviderDraft(createSidecarProviderDraftFromEnv(parsedEnv));
    }
  }, []);

  const handleSaveSidecarConfig = useCallback(async () => {
    try {
      if (sidecarValidationMessages.length > 0) {
        throw new Error(sidecarValidationMessages[0]);
      }
      const parsedArgs = JSON.parse(sidecarArgsJson || '[]') as unknown;
      if (!Array.isArray(parsedArgs) || parsedArgs.some((value) => typeof value !== 'string')) {
        throw new Error('Args JSON 必须是字符串数组。');
      }

      const parsedEnv = JSON.parse(sidecarEnvJson || '{}') as unknown;
      if (parsedEnv == null || Array.isArray(parsedEnv) || typeof parsedEnv !== 'object') {
        throw new Error('Env JSON 必须是对象。');
      }
      if (Object.values(parsedEnv).some((value) => typeof value !== 'string')) {
        throw new Error('Env JSON 的值必须全部是字符串。');
      }

      const providerConfig = createSidecarProviderConfig(sidecarProviderDraft);
      const synchronizedEnv = mergeSidecarProviderDraftIntoEnv(
        parsedEnv as Record<string, string>,
        sidecarProviderDraft,
      );

      const nextSidecarConfig: ClaudeSidecarBackendConfig = {
        ...sidecarDraft,
        command: sidecarDraft.command?.trim() || undefined,
        cwd: sidecarDraft.cwd?.trim() || undefined,
        args: parsedArgs.map((value) => value.trim()).filter(Boolean),
        env: synchronizedEnv,
        provider: providerConfig,
        connectionTimeoutMs: Math.max(1, Math.floor(sidecarDraft.connectionTimeoutMs || 10_000)),
      };

      await patchAppConfig((currentConfig) => {
        const currentAgentBackends: AgentBackendsConfig =
          currentConfig.agentBackends ?? createDefaultAgentBackendsConfig();
        return {
          ...currentConfig,
          agentBackends: {
            ...currentAgentBackends,
            claudeSidecar: nextSidecarConfig,
          },
        };
      });
      await reloadConfig();
      await loadAgentBackends();
      setBackendTestResult(null);
      setStatusMessage('Claude Sidecar 配置已保存。');
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '保存 Claude Sidecar 配置失败');
    }
  }, [loadAgentBackends, reloadConfig, sidecarArgsJson, sidecarDraft, sidecarEnvJson, sidecarProviderDraft, sidecarValidationMessages]);

  const handleResetSidecarConfig = useCallback(() => {
    const nextDraft = cloneSidecarConfig(config.agentBackends?.claudeSidecar);
    setSidecarDraft(nextDraft);
    setSidecarArgsJson(JSON.stringify(nextDraft.args, null, 2));
    setSidecarEnvJson(JSON.stringify(nextDraft.env, null, 2));
    setSidecarProviderDraft(createSidecarProviderDraft(nextDraft));
    setBackendTestResult(null);
    setStatusMessage('Claude Sidecar 草稿已重置为当前已保存配置。');
  }, [config.agentBackends]);

  const handleTestSidecarConnection = useCallback(async () => {
    setTestingBackendId('claude-sidecar');
    try {
      const result = await testAgentBackendConnection('claude-sidecar');
      setBackendTestResult(result);
      await loadAgentBackends();
      setStatusMessage(result.message);
    } catch (error) {
      setBackendTestResult(null);
      setStatusMessage(error instanceof Error ? error.message : 'Claude Sidecar 测试失败');
    } finally {
      setTestingBackendId(null);
    }
  }, [loadAgentBackends]);

  const resetProfileField = useCallback(
    (field: ProfileSectionKey) => {
      if (!editedProfile || !defaultProfile) {
        return;
      }
      setEditedProfile({
        ...editedProfile,
        [field]: defaultProfile[field],
      });
      const section = PROFILE_SECTION_DEFINITIONS.find((item) => item.key === field);
      setStatusMessage(`已重置分区：${section?.title ?? field}`);
    },
    [defaultProfile, editedProfile],
  );

  const handleSaveProfile = useCallback(async () => {
    if (!editedProfile) return;
    try {
      const saved = await saveAgentPolicyProfile(editedProfile);
      setProfiles((current) => current.map((profile) => (profile.id === saved.id ? saved : profile)));
      await reloadConfig();
      setStatusMessage(`已保存配置：${saved.displayName}`);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '保存策略配置失败');
    }
  }, [editedProfile, reloadConfig]);

  const handleResetProfile = useCallback(async () => {
    try {
      const reset = await resetAgentPolicyProfile(selectedProfileId);
      setProfiles((current) => current.map((profile) => (profile.id === reset.id ? reset : profile)));
      setEditedProfile({ ...reset, toolUsagePolicy: { ...reset.toolUsagePolicy } });
      setDefaultProfile(reset);
      await reloadConfig();
      setStatusMessage(`已恢复默认配置：${reset.displayName}`);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '重置策略配置失败');
    }
  }, [reloadConfig, selectedProfileId]);

  const handleExport = useCallback(async () => {
    try {
      const bundle = await exportAgentPolicyBundle(exportClientType, selectedWorkspaceId || undefined);
      setExportBundle(bundle);
      setStatusMessage(`已加载 ${bundle.clientType} 导出包`);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '导出策略包失败');
    }
  }, [exportClientType, selectedWorkspaceId]);

  const handleExportFiles = useCallback(async () => {
    try {
      const bundle = exportBundle ?? (await exportAgentPolicyBundle(exportClientType, selectedWorkspaceId || undefined));
      if (!exportBundle) {
        setExportBundle(bundle);
      }
      const exportDirectory = await exportAgentPolicyBundleFiles(bundle);
      if (!exportDirectory) {
        setStatusMessage('已取消导出');
        return;
      }
      setStatusMessage(`已导出策略文件到 ${exportDirectory}`);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '导出策略文件失败');
    }
  }, [exportBundle, exportClientType, selectedWorkspaceId]);

  const handleInstallClientConfig = useCallback(async (clientType: AgentClientType) => {
    setInjectingClientType(clientType);
    try {
      const result = await installMcpClientConfig(clientType);
      setInstallResult(result);
      const changedPaths = result.files
        .filter((file) => file.created || file.updated)
        .map((file) => file.path);
      const actionLabel =
        changedPaths.length > 0 ? `已写入 ${changedPaths.length} 个配置文件` : '配置已是最新，无需改动';
      setStatusMessage(`${clientType} MCP 注入完成：${actionLabel}`);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : `${clientType} MCP 注入失败`);
    } finally {
      setInjectingClientType(null);
    }
  }, []);

  const handleLoadExternalMcp = useCallback(async () => {
    setLoadingExternalMcp(true);
    try {
      const catalog = await listExternalMcpServers();
      setExternalMcpCatalog(catalog);
      setExternalMcpEditorJson(serializeExternalMcpServersDraft(catalog.servers));
      setExternalMcpEditorError('');
      await patchAppConfig((currentConfig) => {
        const currentExternalMcp =
          currentConfig.externalMcp ?? createDefaultExternalMcpInteropConfig();
        return {
          ...currentConfig,
          externalMcp: {
            ...currentExternalMcp,
            importedCatalog: catalog,
            lastImportedAt: Date.now(),
          },
        };
      });
      setStatusMessage(`已导入外部 MCP 配置，共发现 ${catalog.servers.length} 个 server`);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '导入外部 MCP 配置失败');
    } finally {
      setLoadingExternalMcp(false);
    }
  }, []);

  const handleApplyExternalMcpEditor = useCallback(async () => {
    try {
      const nextServers = parseExternalMcpServersDraft(externalMcpEditorJson);
      const nextCatalog: ExternalMcpCatalog = {
        servers: nextServers,
        sources: externalMcpCatalog?.sources ?? config.externalMcp?.importedCatalog?.sources ?? [],
        warnings: externalMcpCatalog?.warnings ?? config.externalMcp?.importedCatalog?.warnings ?? [],
      };

      setExternalMcpCatalog(nextCatalog);
      setExternalMcpSyncResults([]);
      setExternalMcpEditorError('');
      await patchAppConfig((currentConfig) => {
        const currentExternalMcp =
          currentConfig.externalMcp ?? createDefaultExternalMcpInteropConfig();
        return {
          ...currentConfig,
          externalMcp: {
            ...currentExternalMcp,
            importedCatalog: nextCatalog,
            lastSyncResults: [],
            lastImportedAt: currentExternalMcp.lastImportedAt ?? Date.now(),
            lastSyncedAt: undefined,
          },
        };
      });
      setStatusMessage(`已保存外部 MCP catalog 草稿，共 ${nextServers.length} 个 server`);
    } catch (error) {
      const message = error instanceof Error ? error.message : '保存外部 MCP catalog 失败';
      setExternalMcpEditorError(message);
      setStatusMessage(message);
    }
  }, [config.externalMcp?.importedCatalog?.sources, config.externalMcp?.importedCatalog?.warnings, externalMcpCatalog?.sources, externalMcpCatalog?.warnings, externalMcpEditorJson]);

  const handleResetExternalMcpEditor = useCallback(() => {
    setExternalMcpEditorJson(
      serializeExternalMcpServersDraft(externalMcpCatalog?.servers ?? []),
    );
    setExternalMcpEditorError('');
    setStatusMessage('已重置外部 MCP catalog 编辑器。');
  }, [externalMcpCatalog?.servers]);

  const handleRemoveExternalMcpServer = useCallback(
    async (serverId: string) => {
      if (!externalMcpCatalog) {
        return;
      }

      const nextCatalog: ExternalMcpCatalog = {
        ...externalMcpCatalog,
        servers: externalMcpCatalog.servers.filter((server) => server.id !== serverId),
      };
      setExternalMcpCatalog(nextCatalog);
      setExternalMcpSyncResults([]);
      setExternalMcpEditorJson(serializeExternalMcpServersDraft(nextCatalog.servers));
      setExternalMcpEditorError('');
      await patchAppConfig((currentConfig) => {
        const currentExternalMcp =
          currentConfig.externalMcp ?? createDefaultExternalMcpInteropConfig();
        return {
          ...currentConfig,
          externalMcp: {
            ...currentExternalMcp,
            importedCatalog: nextCatalog,
            lastSyncResults: [],
            lastSyncedAt: undefined,
          },
        };
      });
      setStatusMessage(`已移除外部 MCP server：${serverId}`);
    },
    [externalMcpCatalog],
  );

  const handleClearExternalMcpCache = useCallback(async () => {
    setExternalMcpCatalog(null);
    setExternalMcpSyncResults([]);
    setExternalMcpEditorJson(serializeExternalMcpServersDraft([]));
    setExternalMcpEditorError('');
    await patchAppConfig((currentConfig) => ({
      ...currentConfig,
      externalMcp: createDefaultExternalMcpInteropConfig(),
    }));
    setStatusMessage('已清空外部 MCP 缓存。');
  }, []);

  const handleSyncExternalMcp = useCallback(
    async (clientType: ExternalMcpClientType | 'both') => {
      if (!externalMcpCatalog?.servers.length) {
        setStatusMessage('没有可同步的外部 MCP server，请先导入配置');
        return;
      }

      const clientTypes = clientType === 'both' ? (['codex', 'claude'] as ExternalMcpClientType[]) : [clientType];
      setSyncingExternalMcpClient(clientType);
      try {
        const results = await syncExternalMcpServers(clientTypes, externalMcpCatalog.servers);
        setExternalMcpSyncResults(results);
        await patchAppConfig((currentConfig) => {
          const currentExternalMcp =
            currentConfig.externalMcp ?? createDefaultExternalMcpInteropConfig();
          return {
            ...currentConfig,
            externalMcp: {
              ...currentExternalMcp,
              importedCatalog: externalMcpCatalog,
              lastSyncResults: results,
              lastSyncedAt: Date.now(),
            },
          };
        });
        const summary = results.map((result) => `${result.clientType}:${result.serverCount}`).join(', ');
        setStatusMessage(`外部 MCP 同步完成：${summary}`);
      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : '同步外部 MCP 配置失败');
      } finally {
        setSyncingExternalMcpClient(null);
      }
    },
    [externalMcpCatalog],
  );

  const handlePreview = useCallback(async () => {
    if (!selectedWorkspaceId) {
      setStatusMessage('生成预览前请先选择工作区');
      return;
    }
    try {
      const preview = await getTaskInjectionPreview(previewTarget, selectedWorkspaceId, previewPreset, previewPrompt);
      setPreviewResult(preview);
      setStatusMessage(`已生成预览：${preview.profileId}`);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '生成预览失败');
    }
  }, [previewPreset, previewPrompt, previewTarget, selectedWorkspaceId]);

  const handleLoadEmbeddedMcp = useCallback(async () => {
    try {
      const [launchInfo, tools] = await Promise.all([getEmbeddedMcpLaunchInfo(), listEmbeddedMcpTools()]);
      setEmbeddedLaunchInfo(launchInfo);
      setEmbeddedTools(tools);
      setSelectedEmbeddedTool((current) => (tools.some((tool) => tool.name === current) ? current : tools[0]?.name ?? 'ping'));
      setStatusMessage(`已加载内嵌 MCP bridge，共 ${tools.length} 个 tools`);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '加载内嵌 MCP bridge 失败');
    }
  }, []);

  const handleCallEmbeddedTool = useCallback(async () => {
    try {
      const parsed = JSON.parse(embeddedToolArgs || '{}') as unknown;
      if (parsed == null || Array.isArray(parsed) || typeof parsed !== 'object') {
        setStatusMessage('MCP tool arguments 必须是 JSON object');
        return;
      }
      const result = await callEmbeddedMcpTool(selectedEmbeddedTool, parsed as Record<string, unknown>);
      setEmbeddedToolResult(JSON.stringify(result, null, 2));
      setStatusMessage(`已调用内嵌 MCP tool：${selectedEmbeddedTool}`);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '调用内嵌 MCP tool 失败');
    }
  }, [embeddedToolArgs, selectedEmbeddedTool]);

  const selectedEmbeddedToolDefinition = embeddedTools.find((tool) => tool.name === selectedEmbeddedTool);

  const handleTaskInjectionPatch = useCallback(
    async (taskInjection: AgentPoliciesConfig['taskInjection']) => {
      try {
        await patchAppConfig((currentConfig) => ({
          ...currentConfig,
          agentPolicies: currentConfig.agentPolicies
            ? {
                ...currentConfig.agentPolicies,
                taskInjection,
              }
            : currentConfig.agentPolicies,
        }));
        setStatusMessage('已更新任务注入策略');
      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : '更新任务注入策略失败');
      }
    },
    [],
  );

  const handleTaskInjectionProfileBindingChange = useCallback(
    async (target: TaskTarget, profileId: string) => {
      if (!agentPolicies) {
        return;
      }
      await handleTaskInjectionPatch({
        ...agentPolicies.taskInjection,
        profileBindings: {
          ...agentPolicies.taskInjection.profileBindings,
          [target]: profileId || undefined,
        },
      });
    },
    [agentPolicies, handleTaskInjectionPatch],
  );

  const handleTaskInjectionTargetPresetToggle = useCallback(
    async (target: TaskTarget, enabled: boolean) => {
      if (!agentPolicies) {
        return;
      }
      const nextTargetPresetPolicies: AgentPoliciesConfig['taskInjection']['targetPresetPolicies'] = {
        ...agentPolicies.taskInjection.targetPresetPolicies,
      };
      if (enabled) {
        nextTargetPresetPolicies[target] = { ...agentPolicies.taskInjection.presetPolicies };
      } else {
        delete nextTargetPresetPolicies[target];
      }
      await handleTaskInjectionPatch({
        ...agentPolicies.taskInjection,
        targetPresetPolicies: nextTargetPresetPolicies,
      });
    },
    [agentPolicies, handleTaskInjectionPatch],
  );

  const handleTaskInjectionTargetPresetChange = useCallback(
    async (target: TaskTarget, preset: TaskContextPreset, value: string) => {
      if (!agentPolicies) {
        return;
      }
      const nextTargetPresetPolicies: AgentPoliciesConfig['taskInjection']['targetPresetPolicies'] = {
        ...agentPolicies.taskInjection.targetPresetPolicies,
        [target]: {
          ...(agentPolicies.taskInjection.targetPresetPolicies[target] ?? agentPolicies.taskInjection.presetPolicies),
          [preset]: value,
        },
      };
      await handleTaskInjectionPatch({
        ...agentPolicies.taskInjection,
        targetPresetPolicies: nextTargetPresetPolicies,
      });
    },
    [agentPolicies, handleTaskInjectionPatch],
  );

  const handleWorkspaceOverrideSave = useCallback(
    async (override: WorkspacePolicyOverride) => {
      try {
        await patchAppConfig((currentConfig) => {
          if (!currentConfig.agentPolicies) {
            return currentConfig;
          }
          const overrides = [...currentConfig.agentPolicies.workspaceOverrides];
          const index = overrides.findIndex(
            (item) => item.workspaceId === override.workspaceId && item.profileId === override.profileId,
          );
          if (index >= 0) {
            overrides[index] = override;
          } else {
            overrides.push(override);
          }
          return {
            ...currentConfig,
            agentPolicies: {
              ...currentConfig.agentPolicies,
              workspaceOverrides: overrides,
            },
          };
        });
        setStatusMessage('已保存工作区覆盖规则');
      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : '保存工作区覆盖规则失败');
      }
    },
    [],
  );

  const handleWorkspaceOverrideDelete = useCallback(async () => {
    try {
      await patchAppConfig((currentConfig) => {
        if (!currentConfig.agentPolicies) {
          return currentConfig;
        }
        return {
          ...currentConfig,
          agentPolicies: {
            ...currentConfig.agentPolicies,
            workspaceOverrides: currentConfig.agentPolicies.workspaceOverrides.filter(
              (item) => !(item.workspaceId === selectedWorkspaceId && item.profileId === selectedProfileId),
            ),
          },
        };
      });
      setStatusMessage('已删除工作区覆盖规则');
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '删除工作区覆盖规则失败');
    }
  }, [selectedProfileId, selectedWorkspaceId]);

  const selectedWorkspace = workspaces.find((workspace) => workspace.id === selectedWorkspaceId);
  const enabledProfilesCount = profiles.filter((profile) => profile.enabled).length;
  const workspaceOverrideCount = agentPolicies?.workspaceOverrides.length ?? 0;
  const injectionTargetLabel =
    agentPolicies?.taskInjection.targets === 'both' ? 'Codex + Claude' : agentPolicies?.taskInjection.targets ?? 'none';

  if (!agentPolicies || !editedProfile) {
    return <div className="text-sm text-[var(--text-muted)]">正在加载 Agent / MCP 设置...</div>;
  }

  return (
    <div className="space-y-8">
      {showAgentSections ? (
        <section className="space-y-4">
          <div className="flex items-end justify-between gap-4">
            <div className="space-y-1">
              <div className="text-base uppercase tracking-[0.1em] text-[var(--text-muted)]">概览</div>
              <div className="text-sm text-[var(--text-secondary)]">
                Agent 策略负责运行时注入、配置编辑和工作区级指令增强。MCP 的导出与预览保留在独立的 MCP 页面。
              </div>
            </div>
            <div className="rounded-full border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-1 text-xs uppercase tracking-[0.08em] text-[var(--text-muted)]">
              当前配置：{editedProfile.displayName}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
              <div className="text-xs uppercase tracking-[0.08em] text-[var(--text-muted)]">策略配置</div>
              <div className="mt-2 text-2xl font-semibold text-[var(--text-primary)]">{enabledProfilesCount}</div>
              <div className="mt-1 text-sm text-[var(--text-secondary)]">共 {profiles.length} 套配置，按客户端类型区分。</div>
            </div>
            <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
              <div className="text-xs uppercase tracking-[0.08em] text-[var(--text-muted)]">任务注入</div>
              <div className="mt-2 text-2xl font-semibold text-[var(--text-primary)]">
                {agentPolicies.taskInjection.enabled ? '开启' : '关闭'}
              </div>
              <div className="mt-1 text-sm text-[var(--text-secondary)]">
                目标：{injectionTargetLabel}。预设：{PRESETS.join(' / ')}。
              </div>
            </div>
            <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
              <div className="text-xs uppercase tracking-[0.08em] text-[var(--text-muted)]">工作区覆盖</div>
              <div className="mt-2 text-2xl font-semibold text-[var(--text-primary)]">{workspaceOverrideCount}</div>
              <div className="mt-1 text-sm text-[var(--text-secondary)]">
                {selectedWorkspace ? `${selectedWorkspace.name} 已可配置工作区级增强指令。` : '请先在下方选择工作区后再编辑覆盖规则。'}
              </div>
            </div>
            <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
              <div className="text-xs uppercase tracking-[0.08em] text-[var(--text-muted)]">硬约束</div>
              <div className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
                命中审批即停止执行。Review 规则必须保留。工作区上下文始终是必选前置条件。
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {showAgentSections ? (
        <section className="space-y-4">
          <div className="space-y-1">
            <div className="text-base uppercase tracking-[0.1em] text-[var(--text-muted)]">任务 Backends</div>
            <div className="text-sm text-[var(--text-secondary)]">
              这里展示 Mini-Term 当前注册的任务 backend 契约。Sidecar backend 的工具调用和审批边界以这里的描述为准，不应靠隐式约定猜测。
            </div>
          </div>

          {agentBackendsError ? (
            <div className="rounded-[var(--radius-md)] border border-[var(--color-danger)]/30 bg-[var(--bg-base)] px-4 py-3 text-sm text-[var(--color-danger)]">
              {agentBackendsError}
            </div>
          ) : null}

          <div className="grid gap-4 xl:grid-cols-3">
            {agentBackends.map((backend) => (
              <div
                key={backend.backendId}
                className={`rounded-[var(--radius-md)] border p-4 ${
                  backend.kind === 'sidecar'
                    ? 'border-[var(--accent)]/30 bg-[var(--accent-subtle)]/20'
                    : 'border-[var(--border-subtle)] bg-[var(--bg-base)]'
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <div className="text-sm font-medium text-[var(--text-primary)]">{backend.displayName}</div>
                    <div className="text-xs uppercase tracking-[0.08em] text-[var(--text-muted)]">
                      {targetLabel(backend.target)} | {backend.provider}
                    </div>
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    {backend.preferredForTarget ? (
                      <div className="rounded-full border border-[var(--border-default)] bg-[var(--bg-base)] px-2 py-1 text-[10px] uppercase tracking-[0.08em] text-[var(--text-secondary)]">
                        Preferred
                      </div>
                    ) : null}
                    {backend.defaultForTarget ? (
                      <div className="rounded-full border border-[var(--accent)]/30 bg-[var(--accent-subtle)] px-2 py-1 text-[10px] uppercase tracking-[0.08em] text-[var(--accent)]">
                        Default
                      </div>
                    ) : null}
                    <div className="rounded-full border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2 py-1 text-[10px] uppercase tracking-[0.08em] text-[var(--text-muted)]">
                      {backendKindLabel(backend.kind)}
                    </div>
                  </div>
                </div>

                <div className="mt-3 text-sm text-[var(--text-secondary)]">{backend.description}</div>

                <div className="mt-3 grid gap-2 text-xs text-[var(--text-muted)]">
                  <div>Backend ID: {backend.backendId}</div>
                  <div>Transport: {backendTransportLabel(backend.transport)}</div>
                  <div>Launch: {backend.cliCommand ?? '由 Mini-Term sidecar runtime 决定'}</div>
                  <div>Status: {backendRuntimeStatusLabel(backend.status)}</div>
                  <div>Configured: {backend.configured ? 'yes' : 'no'} | Available: {backend.available ? 'yes' : 'no'}</div>
                  <div>Last Handshake: {formatBackendHandshakeTime(backend.lastHandshakeAt)}</div>
                </div>

                {backend.routingStatusMessage || backend.statusMessage || backend.lastError ? (
                  <div className="mt-3 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2 text-sm text-[var(--text-secondary)]">
                    {backend.routingStatusMessage ? <div>{backend.routingStatusMessage}</div> : null}
                    {backend.statusMessage ? <div>{backend.statusMessage}</div> : null}
                    {backend.lastError ? (
                      <div className="mt-2 text-[var(--color-danger)]">Last error: {backend.lastError}</div>
                    ) : null}
                  </div>
                ) : null}

                <div className="mt-3 flex flex-wrap gap-2">
                  <span className={`rounded-full border px-2 py-1 text-[10px] uppercase tracking-[0.08em] ${capabilityTone(backend.capabilities.supportsWorkers)}`}>
                    Workers
                  </span>
                  <span className={`rounded-full border px-2 py-1 text-[10px] uppercase tracking-[0.08em] ${capabilityTone(backend.capabilities.supportsResume)}`}>
                    Resume
                  </span>
                  <span className={`rounded-full border px-2 py-1 text-[10px] uppercase tracking-[0.08em] ${capabilityTone(backend.capabilities.supportsToolCalls)}`}>
                    Tool Calls
                  </span>
                  <span className={`rounded-full border px-2 py-1 text-[10px] uppercase tracking-[0.08em] ${capabilityTone(backend.capabilities.brokeredTools)}`}>
                    Brokered Tools
                  </span>
                  <span className={`rounded-full border px-2 py-1 text-[10px] uppercase tracking-[0.08em] ${capabilityTone(backend.capabilities.brokeredApprovals)}`}>
                    Brokered Approvals
                  </span>
                </div>

                {backend.capabilities.toolCallAuthority || backend.capabilities.toolCallNotes ? (
                  <div className="mt-4 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2 text-sm text-[var(--text-secondary)]">
                    {backend.capabilities.toolCallAuthority ? (
                      <div className="text-xs uppercase tracking-[0.08em] text-[var(--text-muted)]">
                        Tool Authority: {backend.capabilities.toolCallAuthority}
                      </div>
                    ) : null}
                    {backend.capabilities.toolCallNotes ? (
                      <div className="mt-1">{backend.capabilities.toolCallNotes}</div>
                    ) : null}
                  </div>
                ) : null}

                {backend.capabilities.approvalFlowNotes ? (
                  <div className="mt-3 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2 text-sm text-[var(--text-secondary)]">
                    <div className="text-xs uppercase tracking-[0.08em] text-[var(--text-muted)]">Approval Flow</div>
                    <div className="mt-1">{backend.capabilities.approvalFlowNotes}</div>
                  </div>
                ) : null}

                {backend.capabilities.restrictedToolNames.length > 0 ? (
                  <div className="mt-3 space-y-2">
                    <div className="text-xs uppercase tracking-[0.08em] text-[var(--text-muted)]">
                      Reserved Tools
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {backend.capabilities.restrictedToolNames.map((toolName) => (
                        <span
                          key={`${backend.backendId}-${toolName}`}
                          className="rounded-full border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2 py-1 text-[10px] text-[var(--text-muted)]"
                        >
                          {toolName}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
            {agentBackends.length === 0 && !agentBackendsError ? (
              <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-4 py-3 text-sm text-[var(--text-muted)] xl:col-span-3">
                当前未读取到任务 backend 描述。
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {showAgentSections ? (
        <section className="space-y-4">
          <div className="space-y-1">
            <div className="text-base uppercase tracking-[0.1em] text-[var(--text-muted)]">Backend Routing</div>
            <div className="text-sm text-[var(--text-secondary)]">
              这里决定未显式指定 backend 时，各任务目标默认走哪条执行路径。对于 Claude，可以把默认值切到 sidecar，再决定 sidecar 不可用时是否自动回退到内置 CLI。
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            {TASK_TARGETS.map((target) => {
              const targetBackends = agentBackends.filter((backend) => backend.target === target);
              const preferredBackendId = routingDraft[target].preferredBackendId ?? '';
              const resolvedDefaultBackend = resolvedDefaultBackends[target];
              const fallbackActive =
                !!preferredBackendId &&
                !!resolvedDefaultBackend &&
                resolvedDefaultBackend.backendId !== preferredBackendId;

              return (
                <div
                  key={target}
                  className="space-y-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4"
                >
                  <div className="space-y-1">
                    <div className="text-sm font-medium text-[var(--text-primary)]">{targetLabel(target)}</div>
                  <div className="text-xs text-[var(--text-muted)]">
                    当前生效默认: {resolvedDefaultBackend?.displayName ?? '未解析'}
                  </div>
                  {resolvedDefaultBackend?.routingStatusMessage ? (
                    <div className="text-xs text-[var(--text-muted)]">
                      {resolvedDefaultBackend.routingStatusMessage}
                    </div>
                  ) : null}
                </div>

                  <label className="block space-y-2">
                    <div className="text-sm text-[var(--text-secondary)]">Default Backend</div>
                    <select
                      aria-label={`${targetLabel(target)} Default Backend`}
                      value={preferredBackendId}
                      onChange={(event) =>
                        setRoutingDraft((current) => ({
                          ...current,
                          [target]: {
                            ...current[target],
                            preferredBackendId: event.target.value,
                          },
                        }))
                      }
                      className="w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-2 text-sm"
                    >
                      {!targetBackends.some((backend) => backend.backendId === preferredBackendId) &&
                      preferredBackendId ? (
                        <option value={preferredBackendId}>{preferredBackendId}</option>
                      ) : null}
                      {targetBackends.map((backend) => (
                        <option key={`${target}-${backend.backendId}`} value={backend.backendId}>
                          {backend.displayName}
                          {backend.defaultForTarget ? ' (current)' : ''}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="flex items-center gap-3 text-sm text-[var(--text-secondary)]">
                    <input
                      type="checkbox"
                      aria-label={`${targetLabel(target)} Built-in Fallback`}
                      checked={routingDraft[target].allowBuiltinFallback}
                      onChange={(event) =>
                        setRoutingDraft((current) => ({
                          ...current,
                          [target]: {
                            ...current[target],
                            allowBuiltinFallback: event.target.checked,
                          },
                        }))
                      }
                    />
                    Preferred backend unavailable 时回退到 Built-in CLI
                  </label>

                  {fallbackActive ? (
                    <div className="rounded-[var(--radius-sm)] border border-[var(--warning,#f0b35d)]/40 bg-[var(--warning-subtle,#3a2913)] px-3 py-3 text-sm text-[var(--warning,#f0b35d)]">
                      当前已从 `{preferredBackendId}` 回退到 `{resolvedDefaultBackend?.backendId}`，因为 preferred backend 尚未就绪或不可用。
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>

          {routingValidationMessages.length > 0 ? (
            <div className="space-y-2 rounded-[var(--radius-sm)] border border-[var(--warning,#f0b35d)]/40 bg-[var(--warning-subtle,#3a2913)] px-3 py-3 text-sm text-[var(--warning,#f0b35d)]">
              <div className="text-xs uppercase tracking-[0.08em]">Routing Validation</div>
              {routingValidationMessages.map((message) => (
                <div key={message}>{message}</div>
              ))}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              className="rounded-[var(--radius-sm)] border border-[var(--accent)]/40 bg-[var(--accent-subtle)] px-3 py-1.5 text-sm text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void handleSaveBackendRouting()}
              disabled={routingValidationMessages.length > 0 || !!agentBackendsError}
            >
              保存 Backend 路由
            </button>
            <button
              type="button"
              className="rounded-[var(--radius-sm)] border border-[var(--border-default)] px-3 py-1.5 text-sm text-[var(--text-secondary)]"
              onClick={handleResetBackendRouting}
            >
              重置路由草稿
            </button>
          </div>
        </section>
      ) : null}

      {showAgentSections ? (
        <section className="space-y-4">
          <div className="space-y-1">
            <div className="text-base uppercase tracking-[0.1em] text-[var(--text-muted)]">Claude Sidecar</div>
            <div className="text-sm text-[var(--text-secondary)]">
              在这里配置 `claude-sidecar` 的启动方式、命令参数、环境变量和握手超时，并直接执行一次启动握手验证。
            </div>
            <div className="text-xs text-[var(--text-muted)]">
              仓库内参考实现可直接通过 `npm run agent:claude-sidecar` 启动；等价命令是 `cargo run --manifest-path src-tauri/Cargo.toml --bin mini-term-claude-sidecar`。
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
            <div className="space-y-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
              <label className="flex items-center gap-3 text-sm text-[var(--text-secondary)]">
                <input
                  type="checkbox"
                  checked={sidecarDraft.enabled}
                  onChange={(event) =>
                    setSidecarDraft((current) => ({ ...current, enabled: event.target.checked }))
                  }
                />
                启用 Claude Sidecar
              </label>

              <div className="grid gap-3 md:grid-cols-2">
                <label className="space-y-2">
                  <div className="text-sm text-[var(--text-secondary)]">Startup Mode</div>
                  <select
                    value={sidecarDraft.startupMode}
                    onChange={(event) =>
                      setSidecarDraft((current) => ({
                        ...current,
                        startupMode: event.target.value as ClaudeSidecarBackendConfig['startupMode'],
                      }))
                    }
                    className="w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-2 text-sm"
                  >
                    <option value="process">process</option>
                    <option value="loopback">loopback</option>
                  </select>
                </label>

                <label className="space-y-2">
                  <div className="text-sm text-[var(--text-secondary)]">Connection Timeout (ms)</div>
                  <input
                    type="number"
                    min={1}
                    step={500}
                    value={sidecarDraft.connectionTimeoutMs}
                    onChange={(event) =>
                      setSidecarDraft((current) => ({
                        ...current,
                        connectionTimeoutMs: Number(event.target.value) || 10_000,
                      }))
                    }
                    className="w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-2 text-sm"
                  />
                </label>
              </div>

              <label className="block space-y-2">
                <div className="text-sm text-[var(--text-secondary)]">Command</div>
                <input
                  value={sidecarDraft.command ?? ''}
                  onChange={(event) =>
                    setSidecarDraft((current) => ({ ...current, command: event.target.value }))
                  }
                  className="w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-2 text-sm"
                  placeholder="例如：node、cargo、claude-sidecar"
                />
              </label>

              <label className="block space-y-2">
                <div className="text-sm text-[var(--text-secondary)]">Working Directory</div>
                <input
                  value={sidecarDraft.cwd ?? ''}
                  onChange={(event) =>
                    setSidecarDraft((current) => ({ ...current, cwd: event.target.value }))
                  }
                  className="w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-2 text-sm"
                  placeholder="可选；为空时回退到任务 cwd"
                />
              </label>

              <label className="block space-y-2">
                <div className="text-sm text-[var(--text-secondary)]">Args JSON</div>
                <textarea
                  value={sidecarArgsJson}
                  onChange={(event) => setSidecarArgsJson(event.target.value)}
                  rows={6}
                  className="w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-2 text-sm"
                />
              </label>

              <div className="space-y-4 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-3">
                <div className="space-y-1">
                  <div className="text-xs uppercase tracking-[0.08em] text-[var(--text-muted)]">Provider Settings</div>
                  <div className="text-sm text-[var(--text-secondary)]">
                    常用 provider 字段在这里直接配置，修改后会实时同步回下方的 `Env JSON`。其他自定义环境变量仍然保留在原始 JSON 中。
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <label className="space-y-2">
                    <div className="text-sm text-[var(--text-secondary)]">Provider</div>
                    <select
                      value={sidecarProviderDraft.provider}
                      onChange={(event) =>
                        handleSidecarProviderDraftChange({
                          provider: event.target.value,
                        })
                      }
                      className="w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-base)] px-3 py-2 text-sm"
                    >
                      {!isKnownSidecarProviderMode(sidecarProviderDraft.provider) ? (
                        <option value={sidecarProviderDraft.provider}>
                          {sidecarProviderDraft.provider}
                        </option>
                      ) : null}
                      <option value="reference">reference</option>
                      <option value="openai-compatible">openai-compatible</option>
                      <option value="anthropic">anthropic</option>
                    </select>
                  </label>

                  <label className="space-y-2">
                    <div className="text-sm text-[var(--text-secondary)]">Provider Timeout (ms)</div>
                    <input
                      value={sidecarProviderDraft.timeoutMs}
                      onChange={(event) =>
                        handleSidecarProviderDraftChange({
                          timeoutMs: event.target.value,
                        })
                      }
                      className="w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-base)] px-3 py-2 text-sm"
                      placeholder="默认 60000"
                    />
                  </label>
                </div>

                {!isKnownSidecarProviderMode(sidecarProviderDraft.provider) ? (
                  <div className="rounded-[var(--radius-sm)] border border-[var(--warning,#f0b35d)]/40 bg-[var(--warning-subtle,#3a2913)] px-3 py-3 text-sm text-[var(--warning,#f0b35d)]">
                    当前 provider `{sidecarProviderDraft.provider}` 不在 Mini-Term 已支持列表内。保存后 backend 预检会失败，除非切回 `reference`、`openai-compatible` 或 `anthropic`。
                  </div>
                ) : null}

                {sidecarProviderDraft.provider === 'reference' ? (
                  <div className="rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-3 text-sm text-[var(--text-secondary)]">
                    `reference` 模式下，slash commands 仍在 sidecar 本地处理，自由输入走离线、确定性的参考 provider，适合先验证协议、审批和 brokered tools。
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="grid gap-3 md:grid-cols-3">
                      <label className="space-y-2">
                        <div className="text-sm text-[var(--text-secondary)]">Model</div>
                        <input
                          value={sidecarProviderDraft.model}
                          onChange={(event) =>
                            handleSidecarProviderDraftChange({
                              model: event.target.value,
                            })
                          }
                          className="w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-base)] px-3 py-2 text-sm"
                          placeholder="例如：gpt-4.1-mini"
                        />
                      </label>

                      <label className="space-y-2">
                        <div className="text-sm text-[var(--text-secondary)]">API Key</div>
                        <input
                          type="password"
                          value={sidecarProviderDraft.apiKey}
                          onChange={(event) =>
                            handleSidecarProviderDraftChange({
                              apiKey: event.target.value,
                            })
                          }
                          className="w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-base)] px-3 py-2 text-sm"
                          placeholder="MINI_TERM_SIDECAR_API_KEY"
                        />
                      </label>

                      <label className="space-y-2">
                        <div className="text-sm text-[var(--text-secondary)]">API Key Env Var</div>
                        <input
                          value={sidecarProviderDraft.apiKeyEnvVar}
                          onChange={(event) =>
                            handleSidecarProviderDraftChange({
                              apiKeyEnvVar: event.target.value,
                            })
                          }
                          className="w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-base)] px-3 py-2 text-sm"
                          placeholder="例如：OPENAI_API_KEY"
                        />
                      </label>
                    </div>

                    <div className="rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-3 text-sm text-[var(--text-secondary)]">
                      如果填写 `API Key Env Var`，保存时会优先使用该环境变量名，并且不会再把 inline API Key 写回 `Env JSON`。
                    </div>

                    <label className="block space-y-2">
                      <div className="text-sm text-[var(--text-secondary)]">Base URL</div>
                      <input
                        value={sidecarProviderDraft.baseUrl}
                        onChange={(event) =>
                          handleSidecarProviderDraftChange({
                            baseUrl: event.target.value,
                          })
                        }
                        className="w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-base)] px-3 py-2 text-sm"
                        placeholder="默认 https://api.openai.com/v1"
                      />
                    </label>

                    <label className="block space-y-2">
                      <div className="text-sm text-[var(--text-secondary)]">System Prompt Override</div>
                      <textarea
                        value={sidecarProviderDraft.systemPrompt}
                        onChange={(event) =>
                          handleSidecarProviderDraftChange({
                            systemPrompt: event.target.value,
                          })
                        }
                        rows={5}
                        className="w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-base)] px-3 py-2 text-sm"
                        placeholder="可选；覆盖 sidecar 发给模型的 system prompt"
                      />
                    </label>
                  </div>
                )}
              </div>

              <label className="block space-y-2">
                <div className="text-sm text-[var(--text-secondary)]">Env JSON</div>
                <textarea
                  value={sidecarEnvJson}
                  onChange={(event) => handleSidecarEnvJsonChange(event.target.value)}
                  rows={7}
                  className="w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-2 text-sm"
                />
              </label>

              <div className="space-y-3 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-3 text-sm text-[var(--text-secondary)]">
                <div className="text-xs uppercase tracking-[0.08em] text-[var(--text-muted)]">Provider Env Contract</div>
                <div>
                  `Env JSON` 会原样传给 sidecar 进程。参考实现默认使用离线 `reference`
                  provider；如果要接入外部模型，把 provider 相关环境变量写在这里即可。
                </div>
                <div className="space-y-1">
                  {SIDECAR_PROVIDER_ENV_NOTES.map((note) => (
                    <div key={note}>{note}</div>
                  ))}
                </div>
                <ReadonlyBlock label="示例 Env JSON" value={SIDECAR_PROVIDER_ENV_EXAMPLE} rows={8} />
              </div>

              {sidecarValidationMessages.length > 0 ? (
                <div className="space-y-2 rounded-[var(--radius-sm)] border border-[var(--warning,#f0b35d)]/40 bg-[var(--warning-subtle,#3a2913)] px-3 py-3 text-sm text-[var(--warning,#f0b35d)]">
                  <div className="text-xs uppercase tracking-[0.08em]">Draft Validation</div>
                  {sidecarValidationMessages.map((message) => (
                    <div key={message}>{message}</div>
                  ))}
                </div>
              ) : null}

              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  className="rounded-[var(--radius-sm)] border border-[var(--accent)]/40 bg-[var(--accent-subtle)] px-3 py-1.5 text-sm text-[var(--accent)]"
                  onClick={() => void handleSaveSidecarConfig()}
                  disabled={sidecarValidationMessages.length > 0}
                >
                  保存 Sidecar 配置
                </button>
                <button
                  type="button"
                  className="rounded-[var(--radius-sm)] border border-[var(--border-default)] px-3 py-1.5 text-sm text-[var(--text-secondary)]"
                  onClick={handleResetSidecarConfig}
                >
                  重置草稿
                </button>
                <button
                  type="button"
                  className="rounded-[var(--radius-sm)] border border-[var(--border-default)] px-3 py-1.5 text-sm text-[var(--text-secondary)] disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => void handleTestSidecarConnection()}
                  disabled={testingBackendId === 'claude-sidecar'}
                >
                  {testingBackendId === 'claude-sidecar' ? '测试中...' : '测试启动 / 握手'}
                </button>
              </div>
            </div>

            <div className="space-y-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
              <div className="text-xs uppercase tracking-[0.08em] text-[var(--text-muted)]">Runtime Snapshot</div>
              <div className="rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-3 text-sm text-[var(--text-secondary)]">
                <div>Backend: {sidecarBackend?.displayName ?? 'Claude Sidecar'}</div>
                <div className="mt-1">Status: {backendRuntimeStatusLabel(sidecarBackend?.status)}</div>
                <div className="mt-1">
                  Configured: {sidecarBackend?.configured ? 'yes' : 'no'} | Available: {sidecarBackend?.available ? 'yes' : 'no'}
                </div>
                <div className="mt-1">Last Handshake: {formatBackendHandshakeTime(sidecarBackend?.lastHandshakeAt)}</div>
                {sidecarBackend?.routingStatusMessage ? (
                  <div className="mt-2">{sidecarBackend.routingStatusMessage}</div>
                ) : null}
                {sidecarBackend?.statusMessage ? <div className="mt-2">{sidecarBackend.statusMessage}</div> : null}
                {sidecarBackend?.lastError ? (
                  <div className="mt-2 text-[var(--color-danger)]">Last error: {sidecarBackend.lastError}</div>
                ) : null}
              </div>

              {backendTestResult ? (
                <div className="rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-3 text-sm text-[var(--text-secondary)]">
                  <div className="text-xs uppercase tracking-[0.08em] text-[var(--text-muted)]">Last Test Result</div>
                  <div className="mt-2">
                    {backendTestResult.ok ? 'Success' : 'Failed'} | {backendRuntimeStatusLabel(backendTestResult.status)}
                  </div>
                  <div className="mt-1">{backendTestResult.message}</div>
                  <div className="mt-1">
                    Last Handshake: {formatBackendHandshakeTime(backendTestResult.lastHandshakeAt)}
                  </div>
                </div>
              ) : null}

              <div className="rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-3 text-sm text-[var(--text-secondary)]">
                <div className="text-xs uppercase tracking-[0.08em] text-[var(--text-muted)]">Preflight Rule</div>
                <div className="mt-2">
                  sidecar backend 只有在配置完成并且成功通过一次启动握手测试后，任务面板才会允许启动任务。
                </div>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {showAgentSections ? (
        <>
          <section className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
            <section className="space-y-4">
              <div>
                <div className="text-base uppercase tracking-[0.1em] text-[var(--text-muted)]">策略配置</div>
                <div className="text-sm text-[var(--text-secondary)]">
                  按客户端配置编辑分层提示词。平台层、工具策略层和客户端适配层在这里保持明确分离。
                </div>
              </div>

              <div className="grid gap-4 xl:grid-cols-[220px_minmax(0,1fr)]">
                <div className="space-y-2">
                  {profiles.map((profile) => (
                    <button
                      key={profile.id}
                      type="button"
                      className={`w-full rounded-[var(--radius-sm)] border px-3 py-3 text-left text-sm transition-colors ${
                        selectedProfileId === profile.id
                          ? 'border-[var(--accent)] bg-[var(--accent-subtle)] text-[var(--accent)]'
                          : 'border-[var(--border-subtle)] bg-[var(--bg-base)] text-[var(--text-secondary)] hover:border-[var(--border-default)]'
                      }`}
                      onClick={() => setSelectedProfileId(profile.id)}
                    >
                      <div className="font-medium">{profile.displayName}</div>
                      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] uppercase tracking-[0.08em]">
                        <span>{profile.clientType}</span>
                        <span>{profile.enabled ? '启用中' : '已停用'}</span>
                      </div>
                    </button>
                  ))}
                </div>

                <div className="min-w-0 space-y-4">
                  <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
                    <div className="flex flex-wrap items-center justify-between gap-4">
                      <div>
                        <div className="text-lg font-medium text-[var(--text-primary)]">{editedProfile.displayName}</div>
                        <div className="text-sm text-[var(--text-muted)]">{editedProfile.id}</div>
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                          <input
                            type="checkbox"
                            checked={editedProfile.enabled}
                            onChange={(event) => setEditedProfile({ ...editedProfile, enabled: event.target.checked })}
                          />
                          已启用
                        </label>
                        <button
                          type="button"
                          className="rounded-[var(--radius-sm)] bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--bg-base)]"
                          onClick={() => void handleSaveProfile()}
                        >
                          保存配置
                        </button>
                        <button
                          type="button"
                          className="rounded-[var(--radius-sm)] border border-[var(--border-default)] px-3 py-1.5 text-sm text-[var(--text-secondary)]"
                          onClick={() => void handleResetProfile()}
                        >
                          恢复默认
                        </button>
                      </div>
                    </div>
                    <div className="mt-4 grid gap-3 text-sm text-[var(--text-secondary)] md:grid-cols-2">
                      <div>推荐顺序：{editedProfile.toolUsagePolicy.preferredSequence.join(' -> ')}</div>
                      <div>审批工具：{editedProfile.toolUsagePolicy.approvalTools.join(', ')}</div>
                      <div>只读工具：{editedProfile.toolUsagePolicy.readOnlyTools.join(', ')}</div>
                      <div>任务工具：{editedProfile.toolUsagePolicy.taskTools.join(', ')}</div>
                    </div>
                    <div className="mt-3 text-xs text-[var(--text-muted)]">
                      兼容字段 `systemPromptTemplate` 仍会保存在配置中，但不再作为主编辑入口，也不参与当前导出与运行时注入。
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3">
                      <div className="mb-3 flex flex-wrap gap-2">
                        {PROFILE_SECTION_DEFINITIONS.map((section) => (
                          <button
                            key={section.key}
                            type="button"
                            className={`rounded-full border px-3 py-1.5 text-xs uppercase tracking-[0.08em] transition-colors ${
                              activeProfileSection === section.key
                                ? 'border-[var(--accent)] bg-[var(--accent-subtle)] text-[var(--accent)]'
                                : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--border-default)] hover:text-[var(--text-primary)]'
                            }`}
                            onClick={() => setActiveProfileSection(section.key)}
                          >
                            {section.title}
                          </button>
                        ))}
                      </div>
                      <div className="text-xs text-[var(--text-muted)]">
                        每次只编辑一层提示词。默认参考保留在分区内部，方便快速对比和重置。
                      </div>
                    </div>

                    {activeProfileSectionData ? (
                      <SectionCard
                        key={activeProfileSectionData.key}
                        title={activeProfileSectionData.title}
                        description={activeProfileSectionData.description}
                        value={activeProfileSectionData.value}
                        rows={activeProfileSectionData.rows}
                        defaultValue={activeProfileSectionData.defaultValue}
                        onChange={(value) => updateProfileField(activeProfileSectionData.key, value)}
                        onReset={() => resetProfileField(activeProfileSectionData.key)}
                      />
                    ) : null}
                  </div>
                </div>
              </div>
            </section>

            <section className="space-y-4">
              <div>
                <div className="text-base uppercase tracking-[0.1em] text-[var(--text-muted)]">任务注入</div>
                <div className="text-sm text-[var(--text-secondary)]">
                  控制 Mini-Term 托管的 Codex 和 Claude 任务如何注入运行时提示词。
                </div>
              </div>

              <div className="space-y-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
                <div className="flex flex-wrap items-center gap-4 text-sm text-[var(--text-secondary)]">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={agentPolicies.taskInjection.enabled}
                      onChange={(event) =>
                        void handleTaskInjectionPatch({
                          ...agentPolicies.taskInjection,
                          enabled: event.target.checked,
                        })
                      }
                    />
                    已启用
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={agentPolicies.taskInjection.approvalHints}
                      onChange={(event) =>
                        void handleTaskInjectionPatch({
                          ...agentPolicies.taskInjection,
                          approvalHints: event.target.checked,
                        })
                      }
                    />
                    审批提示
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={agentPolicies.taskInjection.reviewHints}
                      onChange={(event) =>
                        void handleTaskInjectionPatch({
                          ...agentPolicies.taskInjection,
                          reviewHints: event.target.checked,
                        })
                      }
                    />
                    Review 提示
                  </label>
                </div>

                <label className="block space-y-2">
                  <div className="text-xs uppercase tracking-[0.08em] text-[var(--text-muted)]">注入目标</div>
                  <select
                    value={agentPolicies.taskInjection.targets}
                    onChange={(event) =>
                      void handleTaskInjectionPatch({
                        ...agentPolicies.taskInjection,
                        targets: event.target.value as 'codex' | 'claude' | 'both',
                      })
                    }
                    className="w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-elevated)] px-2 py-1.5 text-sm"
                  >
                    <option value="both">both</option>
                    <option value="codex">codex</option>
                    <option value="claude">claude</option>
                  </select>
                </label>

                <div className="grid gap-3 md:grid-cols-2">
                  {TASK_TARGETS.map((target) => {
                    const boundProfileId = injectionProfileBindings[target];
                    const boundProfile =
                      taskProfilesByTarget[target].find((profile) => profile.id === boundProfileId) ??
                      profiles.find((profile) => profile.id === boundProfileId) ??
                      null;
                    const usesOverride = !!agentPolicies.taskInjection.targetPresetPolicies[target];
                    return (
                      <div
                        key={target}
                        className="rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-2"
                      >
                        <div className="text-xs uppercase tracking-[0.08em] text-[var(--text-muted)]">
                          {targetLabel(target)}
                        </div>
                        <div className="mt-1 text-sm text-[var(--text-primary)]">
                          {boundProfile?.displayName ?? boundProfileId}
                        </div>
                        <div className="mt-1 text-xs text-[var(--text-muted)]">
                          {usesOverride ? '使用独立预设覆盖' : '沿用共享预设模板'}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="space-y-3">
                  <div className="flex flex-wrap gap-2">
                    {TASK_TARGETS.map((target) => (
                      <button
                        key={target}
                        type="button"
                        className={`rounded-full border px-3 py-1.5 text-xs uppercase tracking-[0.08em] transition-colors ${
                          activeInjectionTarget === target
                            ? 'border-[var(--accent)] bg-[var(--accent-subtle)] text-[var(--accent)]'
                            : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--border-default)] hover:text-[var(--text-primary)]'
                        }`}
                        onClick={() => setActiveInjectionTarget(target)}
                      >
                        {targetLabel(target)}
                      </button>
                    ))}
                  </div>

                  <label className="block space-y-2">
                    <div className="text-sm font-medium text-[var(--text-secondary)]">
                      {targetLabel(activeInjectionTarget)} 绑定配置
                    </div>
                    <select
                      value={activeBoundProfileId}
                      onChange={(event) =>
                        void handleTaskInjectionProfileBindingChange(activeInjectionTarget, event.target.value)
                      }
                      className="w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-elevated)] px-2 py-1.5 text-sm"
                    >
                      {activeInjectionProfileCandidates.map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.displayName}
                        </option>
                      ))}
                    </select>
                    <div className="text-xs text-[var(--text-muted)]">
                      实际命中：{activeBoundProfile?.displayName ?? activeBoundProfileId}。如果该 profile 被停用，运行时才会回退到同客户端类型的其他启用配置。
                    </div>
                  </label>

                  <div className="flex flex-wrap gap-2">
                    {PRESETS.map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        className={`rounded-full border px-3 py-1.5 text-xs uppercase tracking-[0.08em] transition-colors ${
                          activeInjectionPreset === preset
                            ? 'border-[var(--accent)] bg-[var(--accent-subtle)] text-[var(--accent)]'
                            : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:border-[var(--border-default)] hover:text-[var(--text-primary)]'
                        }`}
                        onClick={() => setActiveInjectionPreset(preset)}
                      >
                        {preset}
                      </button>
                    ))}
                  </div>

                  <div className="grid gap-4 xl:grid-cols-2">
                    <label className="block space-y-2">
                      <div className="text-sm font-medium text-[var(--text-secondary)]">共享 {activeInjectionPreset} 预设</div>
                      <textarea
                        value={agentPolicies.taskInjection.presetPolicies[activeInjectionPreset]}
                        onChange={(event) =>
                          void handleTaskInjectionPatch({
                            ...agentPolicies.taskInjection,
                            presetPolicies: {
                              ...agentPolicies.taskInjection.presetPolicies,
                              [activeInjectionPreset]: event.target.value,
                            },
                          })
                        }
                        rows={8}
                        className="w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-2 text-sm"
                      />
                    </label>

                    <div className="space-y-2">
                      <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                        <input
                          type="checkbox"
                          checked={!!activeTargetPresetOverride}
                          onChange={(event) =>
                            void handleTaskInjectionTargetPresetToggle(activeInjectionTarget, event.target.checked)
                          }
                        />
                        为 {targetLabel(activeInjectionTarget)} 启用独立预设覆盖
                      </label>
                      <textarea
                        value={activeTargetPresetValue}
                        onChange={(event) =>
                          void handleTaskInjectionTargetPresetChange(
                            activeInjectionTarget,
                            activeInjectionPreset,
                            event.target.value,
                          )
                        }
                        rows={8}
                        disabled={!activeTargetPresetOverride}
                        className="w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                      />
                      <div className="text-xs text-[var(--text-muted)]">
                        {activeTargetPresetOverride
                          ? `当前正在编辑 ${targetLabel(activeInjectionTarget)} 的独立覆盖模板。`
                          : `当前显示的是共享模板；启用覆盖后，${targetLabel(activeInjectionTarget)} 可以单独使用不同文案。`}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-2 text-sm text-[var(--text-muted)]">
                  工作区覆盖规则只能补充或收紧约束，不能移除平台级审批、review 或工作区上下文规则。
                </div>
              </div>
            </section>
          </section>

          <section className="space-y-4">
            <div>
              <div className="text-base uppercase tracking-[0.1em] text-[var(--text-muted)]">工作区覆盖</div>
              <div className="text-sm text-[var(--text-secondary)]">
                为工作区补充特定指令，但不能削弱平台级安全约束。
              </div>
            </div>

            <div className="space-y-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
              <div className="grid gap-3 md:grid-cols-3">
                <select
                  value={selectedWorkspaceId}
                  onChange={(event) => setSelectedWorkspaceId(event.target.value)}
                  className="rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-elevated)] px-2 py-1.5 text-sm"
                >
                  {workspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.name}
                    </option>
                  ))}
                </select>
                <select
                  value={selectedProfileId}
                  onChange={(event) => setSelectedProfileId(event.target.value)}
                  className="rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-elevated)] px-2 py-1.5 text-sm"
                >
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.displayName}
                    </option>
                  ))}
                </select>
                <select
                  value={selectedOverride?.promptStyle ?? 'balanced'}
                  onChange={(event) =>
                    void handleWorkspaceOverrideSave({
                      workspaceId: selectedWorkspaceId,
                      profileId: selectedProfileId,
                      enabledTools: [],
                      extraInstructions: selectedOverride?.extraInstructions ?? '',
                      promptStyle: event.target.value as PromptStyle,
                    })
                  }
                  className="rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-elevated)] px-2 py-1.5 text-sm"
                >
                  {PROMPT_STYLES.map((style) => (
                    <option key={style} value={style}>
                      {style}
                    </option>
                  ))}
                </select>
              </div>
              <textarea
                value={selectedOverride?.extraInstructions ?? ''}
                onChange={(event) =>
                  void handleWorkspaceOverrideSave({
                    workspaceId: selectedWorkspaceId,
                    profileId: selectedProfileId,
                    enabledTools: [],
                    extraInstructions: event.target.value,
                    promptStyle: selectedOverride?.promptStyle ?? 'balanced',
                  })
                }
                rows={5}
                className="w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-2 text-sm"
                placeholder="填写工作区级补充说明。可以加强指导，但不能绕过平台安全规则。"
              />
              <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-[var(--text-muted)]">
                <span>
                  {selectedOverride
                    ? `${selectedWorkspace?.name ?? selectedWorkspaceId} / ${editedProfile.displayName} 已启用覆盖规则。`
                    : '当前工作区 / 配置尚未设置覆盖规则。'}
                </span>
                {selectedOverride ? (
                  <button
                    type="button"
                    className="rounded-[var(--radius-sm)] border border-[var(--border-default)] px-2 py-1 text-[11px] text-[var(--text-secondary)]"
                    onClick={() => void handleWorkspaceOverrideDelete()}
                  >
                    删除覆盖规则
                  </button>
                ) : null}
              </div>
            </div>
          </section>
        </>
      ) : null}

      {showMcpSections ? (
        <section className="space-y-4">
          <div className="space-y-1">
            <div className="text-base uppercase tracking-[0.1em] text-[var(--text-muted)]">注入、导出与预览</div>
            <div className="text-sm text-[var(--text-secondary)]">
              先用一键注入把 Mini-Term MCP 写入 Codex / Claude 本地配置，再按需导出接入包和预览运行时提示词。
            </div>
          </div>
          <div className="space-y-4 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
          <div className="space-y-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <div className="text-sm uppercase tracking-[0.08em] text-[var(--text-muted)]">一键注入</div>
                <div className="text-sm text-[var(--text-secondary)]">
                  直接把 `mini-term` MCP server 合并写入用户本地客户端配置。Codex 写入 `~/.codex/config.toml`，Claude 写入 `~/.claude.json`，并在存在时同步 `~/.claude/mcp-configs/mcp-servers.json`。
                </div>
              </div>
              <div className="rounded-full border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-1 text-xs uppercase tracking-[0.08em] text-[var(--text-muted)]">
                推荐先注入，再打开客户端验证 `ping`
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {(['codex', 'claude'] as AgentClientType[]).map((clientType) => (
                <button
                  key={clientType}
                  type="button"
                  className="rounded-[var(--radius-sm)] border border-[var(--accent)]/40 bg-[var(--accent-subtle)] px-4 py-3 text-left text-sm text-[var(--accent)] transition-colors hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => void handleInstallClientConfig(clientType)}
                  disabled={injectingClientType !== null}
                >
                  <div className="font-medium">一键注入到 {clientType === 'codex' ? 'Codex' : 'Claude'}</div>
                  <div className="mt-1 text-xs text-[var(--text-secondary)]">
                    {clientType === 'codex'
                      ? '使用本地 stdio MCP 启动命令，客户端保存后即可直接拉起 Mini-Term MCP。'
                      : '写入 Claude 主配置，并同步 MCP servers 清单，尽量减少手工拷贝步骤。'}
                  </div>
                  {injectingClientType === clientType ? (
                    <div className="mt-2 text-xs text-[var(--text-secondary)]">正在写入配置...</div>
                  ) : null}
                </button>
              ))}
            </div>

            {installResult ? (
              <div className="space-y-3 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-3">
                <div className="text-sm text-[var(--text-secondary)]">
                  最近一次注入：{installResult.clientType} | server: {installResult.serverName} | transport:{' '}
                  {installResult.launch.transport}
                </div>
                <div className="space-y-2 text-sm text-[var(--text-secondary)]">
                  {installResult.files.map((file) => (
                    <div key={`${file.kind}:${file.path}`} className="rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-2">
                      <div className="font-medium text-[var(--text-primary)]">
                        {file.kind === 'primary' ? '主配置' : 'MCP 清单'}
                      </div>
                      <div className="break-all">{file.path}</div>
                      <div className="mt-1 text-xs text-[var(--text-muted)]">
                        {file.created ? '已创建' : file.updated ? '已更新' : '无变更'}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <div className="border-t border-[var(--border-subtle)] pt-4">
            <div className="space-y-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="text-sm uppercase tracking-[0.08em] text-[var(--text-muted)]">外部 MCP 互操作</div>
                  <div className="text-sm text-[var(--text-secondary)]">
                    扫描 Claude / Codex 本地配置里已经存在的 MCP servers，统一展示后可整批同步到另一侧客户端配置。
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-testid="external-mcp-import"
                    className="rounded-[var(--radius-sm)] border border-[var(--accent)]/40 bg-[var(--accent-subtle)] px-3 py-1.5 text-sm text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => void handleLoadExternalMcp()}
                    disabled={loadingExternalMcp}
                  >
                    {loadingExternalMcp ? '导入中...' : '导入外部配置'}
                  </button>
                  <button
                    type="button"
                    data-testid="external-mcp-sync-codex"
                    className="rounded-[var(--radius-sm)] border border-[var(--border-default)] px-3 py-1.5 text-sm text-[var(--text-secondary)] disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => void handleSyncExternalMcp('codex')}
                    disabled={!externalMcpCatalog?.servers.length || syncingExternalMcpClient !== null}
                  >
                    {syncingExternalMcpClient === 'codex' ? '同步中...' : '同步到 Codex'}
                  </button>
                  <button
                    type="button"
                    data-testid="external-mcp-sync-claude"
                    className="rounded-[var(--radius-sm)] border border-[var(--border-default)] px-3 py-1.5 text-sm text-[var(--text-secondary)] disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => void handleSyncExternalMcp('claude')}
                    disabled={!externalMcpCatalog?.servers.length || syncingExternalMcpClient !== null}
                  >
                    {syncingExternalMcpClient === 'claude' ? '同步中...' : '同步到 Claude'}
                  </button>
                  <button
                    type="button"
                    data-testid="external-mcp-sync-both"
                    className="rounded-[var(--radius-sm)] border border-[var(--border-default)] px-3 py-1.5 text-sm text-[var(--text-secondary)] disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => void handleSyncExternalMcp('both')}
                    disabled={!externalMcpCatalog?.servers.length || syncingExternalMcpClient !== null}
                  >
                    {syncingExternalMcpClient === 'both' ? '同步中...' : '双向批量同步'}
                  </button>
                  <button
                    type="button"
                    data-testid="external-mcp-clear-cache"
                    className="rounded-[var(--radius-sm)] border border-[var(--border-default)] px-3 py-1.5 text-sm text-[var(--text-secondary)] disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => void handleClearExternalMcpCache()}
                    disabled={loadingExternalMcp || syncingExternalMcpClient !== null}
                  >
                    清空缓存
                  </button>
                </div>
              </div>

              {externalMcpCatalog ? (
                <>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2 text-sm text-[var(--text-secondary)]">
                      最近导入：{formatRuntimeTimestamp(config.externalMcp?.lastImportedAt)}
                    </div>
                    <div className="rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2 text-sm text-[var(--text-secondary)]">
                      最近同步：{formatRuntimeTimestamp(config.externalMcp?.lastSyncedAt)}
                    </div>
                  </div>

                  <div className="grid gap-3 md:grid-cols-3">
                    {externalMcpCatalog.sources.map((source) => (
                      <div
                        key={`${source.clientType}:${source.sourceKind}:${source.path}`}
                        className="rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2 text-sm text-[var(--text-secondary)]"
                      >
                        <div className="font-medium text-[var(--text-primary)]">
                          {source.clientType} / {source.sourceKind}
                        </div>
                        <div className="mt-1 break-all text-xs text-[var(--text-muted)]">{source.path}</div>
                        <div className="mt-1 text-xs text-[var(--text-muted)]">
                          {source.exists ? `已发现 ${source.serverCount} 个 server` : '配置不存在'}
                        </div>
                      </div>
                    ))}
                  </div>

                  {externalMcpCatalog.warnings.length > 0 ? (
                    <div className="rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2 text-sm text-[var(--text-secondary)]">
                      <div className="font-medium text-[var(--text-primary)]">导入警告</div>
                      <div className="mt-2 space-y-1 text-xs text-[var(--text-muted)]">
                        {externalMcpCatalog.warnings.map((warning) => (
                          <div key={warning}>{warning}</div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <div className="space-y-3 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="font-medium text-[var(--text-primary)]">Catalog Servers JSON</div>
                        <div className="text-xs text-[var(--text-muted)]">
                          这里编辑的是持久化到 Mini-Term 配置里的 `importedCatalog.servers`，适合做小范围增删改后再同步到 Codex / Claude。
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          data-testid="external-mcp-apply-json"
                          className="rounded-[var(--radius-sm)] border border-[var(--accent)]/40 bg-[var(--accent-subtle)] px-3 py-1.5 text-sm text-[var(--accent)]"
                          onClick={() => void handleApplyExternalMcpEditor()}
                        >
                          应用编辑
                        </button>
                        <button
                          type="button"
                          data-testid="external-mcp-reset-json"
                          className="rounded-[var(--radius-sm)] border border-[var(--border-default)] px-3 py-1.5 text-sm text-[var(--text-secondary)]"
                          onClick={handleResetExternalMcpEditor}
                        >
                          重置编辑器
                        </button>
                      </div>
                    </div>
                    <textarea
                      aria-label="External MCP Servers JSON"
                      data-testid="external-mcp-servers-json"
                      value={externalMcpEditorJson}
                      onChange={(event) => {
                        setExternalMcpEditorJson(event.target.value);
                        if (externalMcpEditorError) {
                          setExternalMcpEditorError('');
                        }
                      }}
                      rows={12}
                      className="w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-2 font-mono text-xs"
                    />
                    {externalMcpEditorError ? (
                      <div className="text-sm text-[var(--color-danger)]">{externalMcpEditorError}</div>
                    ) : null}
                  </div>

                  <div className="space-y-2">
                    {externalMcpCatalog.servers.length === 0 ? (
                      <div className="rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-3 text-sm text-[var(--text-muted)]">
                        未发现可导入的外部 MCP server。
                      </div>
                    ) : (
                      externalMcpCatalog.servers.map((server) => (
                        <div
                          key={server.id}
                          className="rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-3 text-sm text-[var(--text-secondary)]"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <div className="font-medium text-[var(--text-primary)]">{server.name}</div>
                              <div className="mt-1 text-xs text-[var(--text-muted)]">
                                {server.transport}
                                {server.command ? ` | ${server.command}` : server.url ? ` | ${server.url}` : ''}
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <div className="text-xs text-[var(--text-muted)]">
                                来源: {server.sourceClients.join(', ')}
                              </div>
                              <button
                                type="button"
                                data-testid={`external-mcp-remove-${server.id}`}
                                className="rounded-[var(--radius-sm)] border border-[var(--border-default)] px-2 py-1 text-[10px] text-[var(--text-secondary)] transition-colors hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]"
                                onClick={() => void handleRemoveExternalMcpServer(server.id)}
                              >
                                移除
                              </button>
                            </div>
                          </div>
                          {server.args.length > 0 ? (
                            <div className="mt-2 text-xs text-[var(--text-muted)]">
                              args: {server.args.join(' ')}
                            </div>
                          ) : null}
                        </div>
                      ))
                    )}
                  </div>

                  {externalMcpSyncResults.length > 0 ? (
                    <div className="space-y-2 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-3">
                      <div className="text-sm font-medium text-[var(--text-primary)]">最近一次同步结果</div>
                      {externalMcpSyncResults.map((result) => (
                        <div key={result.clientType} className="rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-2 text-sm text-[var(--text-secondary)]">
                          <div>
                            {result.clientType} | {result.serverCount} 个 server
                          </div>
                          <div className="mt-1 space-y-1 text-xs text-[var(--text-muted)]">
                            {result.files.map((file) => (
                              <div key={`${result.clientType}:${file.path}`}>
                                {file.kind}: {file.path} | {file.created ? 'created' : file.updated ? 'updated' : 'unchanged'}
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>

          <div className="border-t border-[var(--border-subtle)] pt-4">
            <div className="mb-3 text-sm uppercase tracking-[0.08em] text-[var(--text-muted)]">导出接入包</div>
          <div className="grid gap-3 md:grid-cols-3">
            <select
              value={exportClientType}
              onChange={(event) => setExportClientType(event.target.value as AgentClientType)}
              className="rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-elevated)] px-2 py-1.5 text-sm"
            >
              {CLIENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
            <select
              value={selectedWorkspaceId}
              onChange={(event) => setSelectedWorkspaceId(event.target.value)}
              className="rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-elevated)] px-2 py-1.5 text-sm"
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="rounded-[var(--radius-sm)] border border-[var(--accent)]/40 bg-[var(--accent-subtle)] px-3 py-1.5 text-sm text-[var(--accent)]"
              onClick={() => void handleExport()}
            >
              加载导出包
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm text-[var(--text-secondary)]">
            <button
              type="button"
              className="rounded-[var(--radius-sm)] border border-[var(--border-default)] px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
              onClick={() => void handleExportFiles()}
            >
              导出策略文件
            </button>
            <span>导出内容包含分层提示词、skill 文本、MCP 接入说明、MCP 配置、预设模板以及简单清单。</span>
          </div>
          </div>

          {exportBundle ? (
            <div className="space-y-4 border-t border-[var(--border-subtle)] pt-4">
              <div className="grid gap-3 text-sm text-[var(--text-secondary)] md:grid-cols-2">
                <div>客户端：{exportBundle.clientType}</div>
                <div>工作区：{exportBundle.workspaceName ?? 'Mini-Term'}</div>
              </div>
              <div className="rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-2 text-sm text-[var(--text-secondary)]">
                生效策略摘要：{exportBundle.effectivePolicySummary}
              </div>
              <ReadonlyBlock label="平台提示词" value={exportBundle.platformPrompt} rows={9} />
              <ReadonlyBlock label="工具策略提示词" value={exportBundle.toolPolicyPrompt} rows={9} />
              <ReadonlyBlock label="客户端适配提示词" value={exportBundle.clientWrapperPrompt} rows={8} />
              {exportBundle.workspaceOverridePrompt ? (
                <ReadonlyBlock label="工作区覆盖段" value={exportBundle.workspaceOverridePrompt} rows={6} />
              ) : null}
              <ReadonlyBlock label="System Prompt" value={exportBundle.systemPrompt} rows={12} />
              <ReadonlyBlock label="Skill 文本" value={exportBundle.skillText} rows={12} />
              <ReadonlyBlock label="MCP 说明" value={exportBundle.mcpInstructions} rows={7} />
              <ReadonlyBlock
                label="MCP 启动信息"
                value={JSON.stringify(exportBundle.mcpLaunch, null, 2)}
                rows={8}
              />
              <ReadonlyBlock label="MCP 配置" value={exportBundle.mcpConfigJson} rows={8} />
              <div className="grid gap-4 lg:grid-cols-3">
                <ReadonlyBlock label="Light 预设模板" value={exportBundle.taskPresetTemplates.light} rows={7} />
                <ReadonlyBlock label="Standard 预设模板" value={exportBundle.taskPresetTemplates.standard} rows={7} />
                <ReadonlyBlock label="Review 预设模板" value={exportBundle.taskPresetTemplates.review} rows={7} />
              </div>
            </div>
          ) : null}

          <div className="border-t border-[var(--border-subtle)] pt-4">
            <div className="mb-3 text-sm uppercase tracking-[0.08em] text-[var(--text-muted)]">渲染预览</div>
            <div className="grid gap-3 md:grid-cols-3">
              <select
                value={previewTarget}
                onChange={(event) => setPreviewTarget(event.target.value as TaskTarget)}
                className="rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-elevated)] px-2 py-1.5 text-sm"
              >
                {TASK_TARGETS.map((target) => (
                  <option key={target} value={target}>
                    {target}
                  </option>
                ))}
              </select>
              <select
                value={previewPreset}
                onChange={(event) => setPreviewPreset(event.target.value as TaskContextPreset)}
                className="rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-elevated)] px-2 py-1.5 text-sm"
              >
                {PRESETS.map((preset) => (
                  <option key={preset} value={preset}>
                    {preset}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="rounded-[var(--radius-sm)] border border-[var(--accent)]/40 bg-[var(--accent-subtle)] px-3 py-1.5 text-sm text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => void handlePreview()}
                disabled={!selectedWorkspaceId}
              >
                生成预览
              </button>
            </div>
            <textarea
              value={previewPrompt}
              onChange={(event) => setPreviewPrompt(event.target.value)}
              rows={5}
              className="mt-3 w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-2 text-sm"
            />
            {previewResult ? (
              <div className="mt-4 space-y-4">
                <div className="text-sm text-[var(--text-secondary)]">
                  {previewResult.workspaceName} | {previewResult.profileId} | {previewResult.policySummary}
                </div>
                <div className="grid gap-4 lg:grid-cols-2">
                  <ReadonlyBlock label="渲染后的平台提示词" value={previewResult.renderedSections.platformPrompt} rows={8} />
                  <ReadonlyBlock label="渲染后的工具策略提示词" value={previewResult.renderedSections.toolPolicyPrompt} rows={8} />
                  <ReadonlyBlock label="渲染后的客户端适配提示词" value={previewResult.renderedSections.clientWrapperPrompt} rows={8} />
                  <ReadonlyBlock label="渲染后的任务预设提示词" value={previewResult.renderedSections.taskPresetPrompt} rows={8} />
                </div>
                <ReadonlyBlock
                  label="渲染后的工作区覆盖"
                  value={previewResult.renderedSections.workspaceOverridePrompt || '（无）'}
                  rows={4}
                />
                <ReadonlyBlock label="最终提示词" value={previewResult.finalPrompt} rows={14} />
              </div>
            ) : null}
          </div>

          <div className="border-t border-[var(--border-subtle)] pt-4">
            <div className="mb-3 text-sm uppercase tracking-[0.08em] text-[var(--text-muted)]">内嵌 Bridge</div>
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3 text-sm text-[var(--text-secondary)]">
                <button
                  type="button"
                  className="rounded-[var(--radius-sm)] border border-[var(--accent)]/40 bg-[var(--accent-subtle)] px-3 py-1.5 text-sm text-[var(--accent)]"
                  onClick={() => void handleLoadEmbeddedMcp()}
                >
                  加载内嵌 MCP bridge
                </button>
                <span>通过桌面端直接拉起 `mini-term-mcp`，获取 tools 并转发 `tools/call`。</span>
              </div>

              {embeddedLaunchInfo ? (
                <ReadonlyBlock label="Bridge 启动信息" value={JSON.stringify(embeddedLaunchInfo, null, 2)} rows={7} />
              ) : null}

              {embeddedTools.length > 0 ? (
                <>
                  <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
                    <select
                      value={selectedEmbeddedTool}
                      onChange={(event) => setSelectedEmbeddedTool(event.target.value)}
                      className="rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-elevated)] px-2 py-1.5 text-sm"
                    >
                      {embeddedTools.map((tool) => (
                        <option key={tool.name} value={tool.name}>
                          {tool.name} [{tool.group}]
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="rounded-[var(--radius-sm)] border border-[var(--border-default)] px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                      onClick={() => void handleCallEmbeddedTool()}
                    >
                      调用当前 tool
                    </button>
                  </div>

                  <div className="rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-2 text-sm text-[var(--text-secondary)]">
                    <div>{selectedEmbeddedToolDefinition?.description ?? '当前未选择 tool'}</div>
                    {selectedEmbeddedToolDefinition ? (
                      <div className="mt-2 text-xs text-[var(--text-muted)]">
                        {[
                          `authority=${selectedEmbeddedToolDefinition.authorityScope ?? 'n/a'}`,
                          `kind=${selectedEmbeddedToolDefinition.executionKind ?? 'n/a'}`,
                          `risk=${selectedEmbeddedToolDefinition.riskLevel ?? 'n/a'}`,
                          `degrade=${selectedEmbeddedToolDefinition.degradationMode ?? 'n/a'}`,
                          `idempotency=${selectedEmbeddedToolDefinition.idempotency ?? 'n/a'}`,
                        ].join(' | ')}
                      </div>
                    ) : null}
                  </div>

                  <label className="block space-y-2">
                    <div className="text-sm text-[var(--text-secondary)]">Tool arguments JSON</div>
                    <textarea
                      value={embeddedToolArgs}
                      onChange={(event) => setEmbeddedToolArgs(event.target.value)}
                      rows={6}
                      className="w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-2 text-sm"
                    />
                  </label>

                  <ReadonlyBlock
                    label="Tool 列表摘要"
                    value={embeddedTools
                      .map(
                        (tool) =>
                          `${tool.name} | ${tool.group} | ${tool.authorityScope ?? 'n/a'} | ${tool.executionKind ?? 'n/a'} | ${tool.riskLevel ?? 'n/a'}`,
                      )
                      .join('\n')}
                    rows={8}
                  />

                  {embeddedToolResult ? (
                    <ReadonlyBlock label="Tool 调用结果" value={embeddedToolResult} rows={12} />
                  ) : null}
                </>
              ) : null}
            </div>
          </div>
          </div>
        </section>
      ) : null}

      {statusMessage ? (
        <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-4 py-3 text-sm text-[var(--text-secondary)]">
          {statusMessage}
        </div>
      ) : null}
    </div>
  );
}

