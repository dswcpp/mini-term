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
const listAgentBackends = vi.fn();
const testAgentBackendConnection = vi.fn();
const listExternalMcpServers = vi.fn();
const syncExternalMcpServers = vi.fn();

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

vi.mock('../runtime/agentApi', () => ({
  listAgentBackends: (...args: unknown[]) => listAgentBackends(...args),
  testAgentBackendConnection: (...args: unknown[]) => testAgentBackendConnection(...args),
}));

vi.mock('../runtime/mcpInteropApi', () => ({
  listExternalMcpServers: (...args: unknown[]) => listExternalMcpServers(...args),
  syncExternalMcpServers: (...args: unknown[]) => syncExternalMcpServers(...args),
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
        agentBackends: {
          routing: {
            codex: {
              preferredBackendId: 'codex-cli',
              allowBuiltinFallback: true,
            },
            claude: {
              preferredBackendId: 'claude-cli',
              allowBuiltinFallback: true,
            },
          },
          claudeSidecar: {
            enabled: true,
            command: 'node',
            args: ['dist/sidecar.js'],
            env: { MINI_TERM_SIDE_CAR: '1' },
            provider: {
              kind: 'reference',
            },
            cwd: 'D:/code/mini-term',
            startupMode: 'process',
            connectionTimeoutMs: 12000,
          },
        },
        externalMcp: {
          lastSyncResults: [],
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
    listAgentBackends.mockResolvedValue([
      {
        backendId: 'codex-cli',
        displayName: 'Codex CLI',
        target: 'codex',
        preferredForTarget: true,
        defaultForTarget: true,
        provider: 'OpenAI',
        cliCommand: 'codex',
        description: 'Built-in Codex CLI task backend managed by Mini-Term.',
        builtin: true,
        kind: 'builtin-cli',
        transport: 'pty-command',
        configured: true,
        available: true,
        status: 'ready',
        routingStatusMessage: 'Codex routing: built-in CLI is the preferred default.',
        statusMessage: 'Built-in backend managed by Mini-Term.',
        capabilities: {
          supportsWorkers: true,
          supportsResume: true,
          supportsToolCalls: true,
          brokeredTools: true,
          brokeredApprovals: true,
          restrictedToolNames: [],
          toolCallAuthority: 'mini-term',
          toolCallNotes:
            'Built-in CLI backends are launched and tracked by Mini-Term. They do not use a sidecar RPC broker path.',
          approvalFlowNotes:
            'Approval-gated actions still pause in Mini-Term Inbox before execution continues.',
        },
      },
      {
        backendId: 'claude-cli',
        displayName: 'Claude CLI',
        target: 'claude',
        preferredForTarget: false,
        defaultForTarget: true,
        provider: 'Anthropic',
        cliCommand: 'claude',
        description: 'Built-in Claude CLI task backend managed by Mini-Term.',
        builtin: true,
        kind: 'builtin-cli',
        transport: 'pty-command',
        configured: true,
        available: true,
        status: 'ready',
        routingStatusMessage: 'Claude routing: built-in fallback is active.',
        statusMessage: 'Built-in backend managed by Mini-Term.',
        capabilities: {
          supportsWorkers: true,
          supportsResume: true,
          supportsToolCalls: true,
          brokeredTools: true,
          brokeredApprovals: true,
          restrictedToolNames: [],
          toolCallAuthority: 'mini-term',
          toolCallNotes:
            'Built-in CLI backends are launched and tracked by Mini-Term. They do not use a sidecar RPC broker path.',
          approvalFlowNotes:
            'Approval-gated actions still pause in Mini-Term Inbox before execution continues.',
        },
      },
      {
        backendId: 'claude-sidecar',
        displayName: 'Claude Sidecar',
        target: 'claude',
        preferredForTarget: true,
        defaultForTarget: false,
        provider: 'External',
        description:
          "Reserved sidecar backend slot for a Claude-compatible runtime integrated behind Mini-Term's control plane.",
        builtin: false,
        kind: 'sidecar',
        transport: 'sidecar-rpc',
        configured: true,
        available: false,
        status: 'configured',
        routingStatusMessage: 'Claude routing: sidecar is preferred but not ready.',
        statusMessage: 'Configured but not yet tested.',
        lastHandshakeAt: 1710000000000,
        capabilities: {
          supportsWorkers: true,
          supportsResume: true,
          supportsToolCalls: true,
          brokeredTools: true,
          brokeredApprovals: true,
          restrictedToolNames: [
            'start_task',
            'spawn_worker',
            'resume_session',
            'send_task_input',
            'close_task',
            'decide_approval_request',
          ],
          toolCallAuthority: 'mini-term',
          toolCallNotes:
            'Sidecar tool calls are brokered through Mini-Term. Observation tools and approval-gated compat tools stay available, but Mini-Term-owned task lifecycle tools are reserved.',
          approvalFlowNotes:
            'Approval requests remain in Mini-Term Inbox. The sidecar only receives the final tool result after Mini-Term approves or rejects the action.',
        },
      },
    ]);
    testAgentBackendConnection.mockResolvedValue({
      backendId: 'claude-sidecar',
      ok: true,
      status: 'ready',
      message: 'Launch and handshake succeeded with claude-sidecar 0.1.0.',
      lastHandshakeAt: 1710000000000,
    });
    listExternalMcpServers.mockResolvedValue({
      servers: [
        {
          id: 'github',
          name: 'github',
          transport: 'stdio',
          command: 'uvx',
          args: ['mcp-server-github'],
          cwd: undefined,
          env: {},
          url: undefined,
          headers: {},
          sourceClients: ['codex'],
          sourcePaths: ['C:/Users/test/.codex/config.toml'],
        },
      ],
      sources: [
        {
          clientType: 'codex',
          sourceKind: 'primary',
          path: 'C:/Users/test/.codex/config.toml',
          exists: true,
          serverCount: 1,
        },
      ],
      warnings: [],
    });
    syncExternalMcpServers.mockResolvedValue([
      {
        clientType: 'codex',
        serverCount: 1,
        files: [
          {
            path: 'C:/Users/test/.codex/config.toml',
            kind: 'primary',
            created: false,
            updated: true,
          },
        ],
      },
    ]);
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

  it('persists imported external MCP catalog and sync results in config', async () => {
    render(<SettingsModal open onClose={vi.fn()} initialPage="mcp" />);

    fireEvent.click(await screen.findByTestId('external-mcp-import'));

    await waitFor(() => {
      expect(listExternalMcpServers).toHaveBeenCalledTimes(1);
    });

    expect(useAppStore.getState().config.externalMcp?.importedCatalog?.servers).toHaveLength(1);
    expect(useAppStore.getState().config.externalMcp?.lastImportedAt).toBeTypeOf('number');

    fireEvent.click(screen.getByTestId('external-mcp-sync-codex'));

    await waitFor(() => {
      expect(syncExternalMcpServers).toHaveBeenCalledWith(['codex'], [
        expect.objectContaining({
          id: 'github',
          transport: 'stdio',
        }),
      ]);
    });

    expect(useAppStore.getState().config.externalMcp?.lastSyncResults).toEqual([
      expect.objectContaining({
        clientType: 'codex',
        serverCount: 1,
      }),
    ]);
    expect(useAppStore.getState().config.externalMcp?.lastSyncedAt).toBeTypeOf('number');
  });

  it('allows editing, removing, and clearing persisted external MCP catalog', async () => {
    render(<SettingsModal open onClose={vi.fn()} initialPage="mcp" />);

    fireEvent.click(await screen.findByTestId('external-mcp-import'));

    const textarea = await screen.findByTestId('external-mcp-servers-json');
    fireEvent.change(textarea, {
      target: {
        value: JSON.stringify(
          [
            {
              id: 'github',
              name: 'GitHub Enterprise',
              transport: 'stdio',
              command: 'uvx',
              args: ['mcp-server-github'],
              env: {},
              headers: {},
              sourceClients: ['codex'],
              sourcePaths: ['C:/Users/test/.codex/config.toml'],
            },
          ],
          null,
          2,
        ),
      },
    });

    fireEvent.click(screen.getByTestId('external-mcp-apply-json'));

    await waitFor(() => {
      expect(useAppStore.getState().config.externalMcp?.importedCatalog?.servers[0]?.name).toBe(
        'GitHub Enterprise',
      );
    });

    fireEvent.click(screen.getByTestId('external-mcp-remove-github'));

    await waitFor(() => {
      expect(useAppStore.getState().config.externalMcp?.importedCatalog?.servers).toHaveLength(0);
    });

    fireEvent.click(screen.getByTestId('external-mcp-clear-cache'));

    await waitFor(() => {
      expect(useAppStore.getState().config.externalMcp?.importedCatalog).toBeUndefined();
    });
    expect(useAppStore.getState().config.externalMcp?.lastSyncResults).toEqual([]);
  });

  it('renders Claude Sidecar config, saves provider settings, and can test the handshake', async () => {
    render(<SettingsModal open onClose={vi.fn()} initialPage="agent" />);

    expect((await screen.findAllByText('Claude Sidecar')).length).toBeGreaterThan(0);
    expect(screen.getByDisplayValue('node')).not.toBeNull();
    expect(screen.getByDisplayValue('D:/code/mini-term')).not.toBeNull();
    expect(screen.getByDisplayValue('reference')).not.toBeNull();
    expect(screen.getByText('Provider Env Contract')).not.toBeNull();
    expect(screen.getAllByText(/MINI_TERM_SIDECAR_PROVIDER/).length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText('Provider'), {
      target: { value: 'openai-compatible' },
    });
    fireEvent.change(screen.getByLabelText('Model'), {
      target: { value: 'gpt-4.1-mini' },
    });
    fireEvent.change(screen.getByLabelText('API Key Env Var'), {
      target: { value: 'OPENAI_API_KEY' },
    });

    expect(screen.getByLabelText('Base URL')).not.toBeNull();
    expect((screen.getByLabelText('Env JSON') as HTMLTextAreaElement).value).toContain(
      '"MINI_TERM_SIDECAR_PROVIDER": "openai-compatible"',
    );
    expect((screen.getByLabelText('Env JSON') as HTMLTextAreaElement).value).toContain(
      '"MINI_TERM_SIDECAR_MODEL": "gpt-4.1-mini"',
    );

    fireEvent.click(screen.getByRole('button', { name: '保存 Sidecar 配置' }));

    await waitFor(() => {
      expect(useAppStore.getState().config.agentBackends?.claudeSidecar.provider).toEqual({
        kind: 'openai-compatible',
        model: 'gpt-4.1-mini',
        baseUrl: undefined,
        apiKey: undefined,
        apiKeyEnvVar: 'OPENAI_API_KEY',
        timeoutMs: undefined,
        systemPrompt: undefined,
      });
    });
    expect(useAppStore.getState().config.agentBackends?.claudeSidecar.env).toMatchObject({
      MINI_TERM_SIDE_CAR: '1',
      MINI_TERM_SIDECAR_PROVIDER: 'openai-compatible',
      MINI_TERM_SIDECAR_MODEL: 'gpt-4.1-mini',
    });

    fireEvent.click(screen.getByRole('button', { name: '测试启动 / 握手' }));

    await waitFor(() => {
      expect(testAgentBackendConnection).toHaveBeenCalledWith('claude-sidecar');
    });
    expect((await screen.findAllByText(/Launch and handshake succeeded/i)).length).toBeGreaterThan(0);
  });

  it('renders agent backends even when legacy capability fields are missing', async () => {
    listAgentBackends.mockResolvedValueOnce([
      {
        backendId: 'claude-sidecar',
        displayName: 'Legacy Claude Sidecar',
        target: 'claude',
        provider: 'External',
        description: 'Legacy runtime descriptor without complete capability metadata.',
        builtin: false,
        capabilities: {
          supportsWorkers: true,
          supportsResume: true,
          supportsToolCalls: true,
          brokeredTools: true,
          brokeredApprovals: true,
        },
      },
    ]);

    render(<SettingsModal open onClose={vi.fn()} initialPage="agent" />);

    expect((await screen.findAllByText('Legacy Claude Sidecar')).length).toBeGreaterThan(0);
    expect(screen.getByText(/Transport:\s*Sidecar RPC/)).not.toBeNull();
    expect(screen.getAllByText(/Configured:\s*no\s*\|\s*Available:\s*no/).length).toBeGreaterThan(0);
  });

  it('renders backend routing diagnostics and preferred backend badges', async () => {
    render(<SettingsModal open onClose={vi.fn()} initialPage="agent" />);

    expect(await screen.findByText('Backend Routing')).not.toBeNull();
    expect(screen.getAllByText('Preferred').length).toBeGreaterThan(0);
    expect(
      screen.getAllByText('Claude routing: built-in fallback is active.').length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText('Claude routing: sidecar is preferred but not ready.').length,
    ).toBeGreaterThan(0);
  });

  it('saves backend routing preferences from settings', async () => {
    render(<SettingsModal open onClose={vi.fn()} initialPage="agent" />);

    expect(await screen.findByText('Backend Routing')).not.toBeNull();

    fireEvent.change(screen.getByLabelText('Claude Default Backend'), {
      target: { value: 'claude-sidecar' },
    });
    fireEvent.click(screen.getByLabelText('Claude Built-in Fallback'));
    fireEvent.click(screen.getByRole('button', { name: '保存 Backend 路由' }));

    await waitFor(() => {
      expect(useAppStore.getState().config.agentBackends?.routing.claude).toEqual({
        preferredBackendId: 'claude-sidecar',
        allowBuiltinFallback: false,
      });
    });
  });
});
