import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../store';
import type { AgentPolicyProfile } from '../types';
import { SettingsModal } from './SettingsModal';

const listAgentPolicyProfiles = vi.fn();
const getDefaultAgentPolicyProfile = vi.fn();
const exportAgentPolicyBundle = vi.fn();
const installMcpClientConfig = vi.fn();
const getTaskInjectionPreview = vi.fn();
const saveAgentPolicyProfile = vi.fn();
const resetAgentPolicyProfile = vi.fn();
const exportAgentPolicyBundleFiles = vi.fn();

vi.mock('../runtime/agentPolicyApi', () => ({
  listAgentPolicyProfiles: (...args: unknown[]) => listAgentPolicyProfiles(...args),
  getDefaultAgentPolicyProfile: (...args: unknown[]) => getDefaultAgentPolicyProfile(...args),
  exportAgentPolicyBundle: (...args: unknown[]) => exportAgentPolicyBundle(...args),
  installMcpClientConfig: (...args: unknown[]) => installMcpClientConfig(...args),
  getTaskInjectionPreview: (...args: unknown[]) => getTaskInjectionPreview(...args),
  saveAgentPolicyProfile: (...args: unknown[]) => saveAgentPolicyProfile(...args),
  resetAgentPolicyProfile: (...args: unknown[]) => resetAgentPolicyProfile(...args),
}));

vi.mock('../utils/agentPolicyExport', () => ({
  exportAgentPolicyBundleFiles: (...args: unknown[]) => exportAgentPolicyBundleFiles(...args),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => useAppStore.getState().config),
}));

describe('SettingsModal Agent page', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    const profile: AgentPolicyProfile = {
      id: 'codex-default',
      clientType: 'codex',
      enabled: true,
      displayName: 'Codex Default',
      platformPromptTemplate: 'Platform prompt',
      toolPolicyPromptTemplate: 'Tool policy prompt',
      clientWrapperPromptTemplate: 'Client wrapper prompt',
      systemPromptTemplate: 'Legacy system prompt',
      skillTemplate: 'Skill text',
      mcpInstructionsTemplate: 'MCP instructions',
      toolUsagePolicy: {
        preferredSequence: ['list_workspaces', 'get_workspace_context'],
        approvalTools: ['write_file'],
        readOnlyTools: ['read_file'],
        taskTools: ['start_task'],
      },
    };

    useAppStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        workspaces: [
          {
            id: 'workspace-1',
            name: 'mini-term',
            roots: [
              {
                id: 'root-1',
                name: 'mini-term',
                path: 'D:/code/mini-term',
                role: 'primary',
              },
            ],
            pinned: false,
            createdAt: 1,
            lastOpenedAt: 1,
          },
        ],
        agentPolicies: {
          profiles: [profile],
          workspaceOverrides: [],
          taskInjection: {
            enabled: true,
            targets: 'both',
            presetPolicies: {
              light: 'light preset',
              standard: 'standard preset',
              review: 'review preset',
            },
            approvalHints: true,
            reviewHints: true,
            profileBindings: {
              codex: 'codex-default',
              claude: 'claude-default',
            },
            targetPresetPolicies: {},
          },
        },
      },
    }));

    listAgentPolicyProfiles.mockResolvedValue([profile]);
    getDefaultAgentPolicyProfile.mockResolvedValue({
      ...profile,
      platformPromptTemplate: 'Default platform prompt',
    });
    exportAgentPolicyBundle.mockResolvedValue({
      clientType: 'codex',
      profile,
      workspaceId: 'workspace-1',
      workspaceName: 'mini-term',
      platformPrompt: 'Rendered platform prompt',
      toolPolicyPrompt: 'Rendered tool policy prompt',
      clientWrapperPrompt: 'Rendered client wrapper prompt',
      taskPresetTemplates: {
        light: 'light preset',
        standard: 'standard preset',
        review: 'review preset',
      },
      systemPrompt: 'System prompt',
      skillText: 'Skill text',
      mcpInstructions: 'MCP instructions',
      workspaceOverridePrompt: 'Workspace override prompt',
      effectivePolicySummary:
        'Codex Default profile on standard preset with balanced workspace override',
      mcpLaunch: {
        status: 'resolved',
        transport: 'stdio',
        command: 'cargo',
        args: [
          'run',
          '--manifest-path',
          'D:/code/JavaScript/mini-term/src-tauri/Cargo.toml',
          '--bin',
          'mini-term-mcp',
        ],
        cwd: 'D:/code/JavaScript/mini-term',
        notes: 'Resolved from source checkout',
      },
      mcpConfigJson: '{"mini-term":{}}',
    });
    installMcpClientConfig.mockResolvedValue({
      clientType: 'codex',
      serverName: 'mini-term',
      files: [
        {
          path: 'C:/Users/test/.codex/config.toml',
          kind: 'primary',
          created: false,
          updated: true,
        },
      ],
      launch: {
        status: 'resolved',
        transport: 'stdio',
        command: 'cargo',
        args: ['run', '--bin', 'mini-term-mcp'],
        cwd: 'D:/code/JavaScript/mini-term',
      },
    });
    getTaskInjectionPreview.mockResolvedValue({
      profileId: 'codex-default',
      clientType: 'codex',
      preset: 'standard',
      workspaceId: 'workspace-1',
      workspaceName: 'mini-term',
      policySummary: 'Codex Default profile on standard preset',
      renderedSections: {
        platformPrompt: 'Preview platform prompt',
        toolPolicyPrompt: 'Preview tool policy prompt',
        clientWrapperPrompt: 'Preview client wrapper prompt',
        taskPresetPrompt: 'Preview task preset prompt',
        workspaceOverridePrompt: 'Workspace override prompt',
      },
      finalPrompt: 'Mini-Term runtime policy',
    });
    saveAgentPolicyProfile.mockResolvedValue(profile);
    resetAgentPolicyProfile.mockResolvedValue(profile);
    exportAgentPolicyBundleFiles.mockResolvedValue('D:/exports/mini-term-policy-codex-mini-term');
  });

  it('renders export and preview content on the MCP page', async () => {
    render(<SettingsModal open onClose={vi.fn()} initialPage="mcp" />);

    expect(await screen.findByText('注入、导出与预览')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '加载导出包' }));
    expect(await screen.findByDisplayValue('Rendered platform prompt')).not.toBeNull();
    expect(screen.getByDisplayValue('Rendered tool policy prompt')).not.toBeNull();
    expect(screen.getByDisplayValue('Rendered client wrapper prompt')).not.toBeNull();
    expect(screen.getByDisplayValue('Workspace override prompt')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '生成预览' }));
    expect(await screen.findByDisplayValue('Preview platform prompt')).not.toBeNull();
    expect(screen.getByDisplayValue('Preview task preset prompt')).not.toBeNull();
    expect(screen.getAllByDisplayValue('Workspace override prompt').length).toBeGreaterThan(0);
    expect(screen.getByDisplayValue('Mini-Term runtime policy')).not.toBeNull();
  });

  it('shows editable agent policy sections and reset controls', async () => {
    render(<SettingsModal open onClose={vi.fn()} initialPage="agent" />);

    expect(await screen.findByText('概览')).not.toBeNull();
    expect(screen.getAllByText('策略配置').length).toBeGreaterThan(0);
    expect(screen.getAllByText('任务注入').length).toBeGreaterThan(0);
    expect(screen.getAllByText('工作区覆盖').length).toBeGreaterThan(0);
    expect(screen.getAllByText('平台提示词').length).toBeGreaterThan(0);
    expect(screen.getByText('Codex 绑定配置')).not.toBeNull();
    expect(screen.getByText('为 Codex 启用独立预设覆盖')).not.toBeNull();
    const resetButtons = await screen.findAllByRole('button', {
      name: '重置当前分区',
    });
    expect(resetButtons.some((button) => !button.hasAttribute('disabled'))).toBe(true);
  });

  it('exports the current policy bundle to files', async () => {
    render(<SettingsModal open onClose={vi.fn()} initialPage="mcp" />);

    expect(await screen.findByText('注入、导出与预览')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '导出策略文件' }));

    await waitFor(() => {
      expect(exportAgentPolicyBundleFiles).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByText(/已导出策略文件到/)).not.toBeNull();
  });

  it('shows export errors from the MCP page', async () => {
    exportAgentPolicyBundle.mockRejectedValueOnce(new Error('workspace not found: missing'));

    render(<SettingsModal open onClose={vi.fn()} initialPage="mcp" />);

    fireEvent.click(await screen.findByRole('button', { name: '加载导出包' }));

    expect(await screen.findByText('workspace not found: missing')).not.toBeNull();
  });

  it('supports one-click MCP injection for Codex from settings', async () => {
    render(<SettingsModal open onClose={vi.fn()} initialPage="mcp" />);

    fireEvent.click(await screen.findByRole('button', { name: /一键注入到 Codex/ }));

    await waitFor(() => {
      expect(installMcpClientConfig).toHaveBeenCalledWith('codex');
    });
    expect(await screen.findByText(/codex MCP 注入完成/i)).not.toBeNull();
    expect(screen.getByText('C:/Users/test/.codex/config.toml')).not.toBeNull();
    expect(screen.getByText('已更新')).not.toBeNull();
  });
});
