import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../store';
import type {
  AgentClientType,
  EmbeddedMcpToolDefinition,
  AgentPoliciesConfig,
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
import { exportAgentPolicyBundleFiles } from '../../utils/agentPolicyExport';

const CLIENT_TYPES: AgentClientType[] = ['codex', 'claude', 'cursor', 'generic-mcp'];
const PROMPT_STYLES: PromptStyle[] = ['minimal', 'balanced', 'strict'];
const TASK_TARGETS: TaskTarget[] = ['codex', 'claude'];
const PRESETS: TaskContextPreset[] = ['light', 'standard', 'review'];

function targetLabel(target: TaskTarget) {
  return target === 'codex' ? 'Codex' : 'Claude';
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
  const [embeddedLaunchInfo, setEmbeddedLaunchInfo] = useState<McpLaunchInfo | null>(null);
  const [embeddedTools, setEmbeddedTools] = useState<EmbeddedMcpToolDefinition[]>([]);
  const [selectedEmbeddedTool, setSelectedEmbeddedTool] = useState('ping');
  const [embeddedToolArgs, setEmbeddedToolArgs] = useState('{}');
  const [embeddedToolResult, setEmbeddedToolResult] = useState('');
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

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

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
                    {embeddedTools.find((tool) => tool.name === selectedEmbeddedTool)?.description ?? '当前未选择 tool'}
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
                    value={embeddedTools.map((tool) => `${tool.name} | ${tool.group} | ${tool.stability}`).join('\n')}
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

