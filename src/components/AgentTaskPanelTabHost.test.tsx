import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTaskPanelTabHost } from './AgentTaskPanelTabHost';
import { selectWorkspaceState, useAppStore } from '../store';

const listAgentTasks = vi.fn();
const listAgentBackends = vi.fn();
const listApprovalRequests = vi.fn();
const getAgentTaskStatus = vi.fn();
const listAgentTaskEvents = vi.fn();
const getTaskEffectivePolicy = vi.fn();
const sendAgentTaskInput = vi.fn();
const startAgentTask = vi.fn();
const closeAgentTask = vi.fn();
const resumeAgentTask = vi.fn();
const spawnWorkerTask = vi.fn();

vi.mock('../runtime/agentApi', () => ({
  listAgentTasks: (...args: unknown[]) => listAgentTasks(...args),
  listAgentBackends: (...args: unknown[]) => listAgentBackends(...args),
  listApprovalRequests: (...args: unknown[]) => listApprovalRequests(...args),
  getAgentTaskStatus: (...args: unknown[]) => getAgentTaskStatus(...args),
  listAgentTaskEvents: (...args: unknown[]) => listAgentTaskEvents(...args),
  sendAgentTaskInput: (...args: unknown[]) => sendAgentTaskInput(...args),
  startAgentTask: (...args: unknown[]) => startAgentTask(...args),
  closeAgentTask: (...args: unknown[]) => closeAgentTask(...args),
  resumeAgentTask: (...args: unknown[]) => resumeAgentTask(...args),
  spawnWorkerTask: (...args: unknown[]) => spawnWorkerTask(...args),
}));

vi.mock('../runtime/agentPolicyApi', () => ({
  getTaskEffectivePolicy: (...args: unknown[]) => getTaskEffectivePolicy(...args),
}));

function TaskPanelHarness() {
  const workspaceState = useAppStore(selectWorkspaceState('workspace-1'));
  const tab = workspaceState?.tabs.find((item) => item.kind === 'agent-tasks');
  if (!tab || tab.kind !== 'agent-tasks') {
    return null;
  }
  return <AgentTaskPanelTabHost tab={tab} workspaceId="workspace-1" isActive />;
}

function createTaskDetail(
  taskId: string,
  workspaceId: string,
  workspaceName: string,
  status: string = 'running',
  artifacts: Array<{
    artifactId: string;
    kind: 'plan';
    title: string;
    path: string;
    mimeType: string;
    createdAt: number;
    updatedAt: number;
  }> = [],
  overrides: Partial<{
    target: 'codex' | 'claude';
    role: 'coordinator' | 'worker';
    parentTaskId: string;
    backendId: string;
    backendDisplayName: string;
    title: string;
    promptPreview: string;
    lastOutputExcerpt: string;
  }> = {},
) {
  return {
    summary: {
      taskId,
      workspaceId,
      workspaceName,
      workspaceRootPath: `D:/code/${workspaceName}`,
      target: overrides.target ?? ('codex' as const),
      role: overrides.role ?? ('coordinator' as const),
      parentTaskId: overrides.parentTaskId,
      backendId: overrides.backendId ?? 'codex-cli',
      backendDisplayName: overrides.backendDisplayName ?? 'Codex CLI',
      title: overrides.title ?? `${workspaceName} task`,
      status,
      attentionState:
        status === 'waiting-input'
          ? ('waiting-input' as const)
          : ('running' as const),
      sessionId: taskId,
      cwd: `D:/code/${workspaceName}`,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      contextPreset: 'review' as const,
      changedFiles:
        status === 'exited'
          ? [{ path: 'src/main.ts', status: 'modified' as const, statusLabel: 'M' }]
          : [],
      promptPreview: overrides.promptPreview ?? 'Fix the task.',
      lastOutputExcerpt: overrides.lastOutputExcerpt ?? 'Recent output',
    },
    recentOutputExcerpt: overrides.lastOutputExcerpt ?? 'Recent output',
    diffSummary: [],
    logPath: `D:/logs/${taskId}.log`,
    artifacts,
  };
}

function defaultBackends() {
  return [
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
      preferredForTarget: true,
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
      routingStatusMessage: 'Claude routing: built-in CLI is the preferred default.',
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
      preferredForTarget: false,
      defaultForTarget: false,
      provider: 'External',
      description:
        "Reserved sidecar backend slot for a Claude-compatible runtime integrated behind Mini-Term's control plane.",
      builtin: false,
      kind: 'sidecar',
      transport: 'sidecar-rpc',
      configured: true,
      available: true,
      status: 'ready',
      routingStatusMessage: 'Claude routing: sidecar is available for explicit selection.',
      statusMessage: 'Handshake verified with claude-sidecar 0.1.0.',
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
  ];
}

function backendById(backendId: string) {
  return defaultBackends().find((backend) => backend.backendId === backendId)!;
}

describe('AgentTaskPanelTabHost', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    const baseTab = {
      kind: 'agent-tasks' as const,
      id: 'agent-panel-1',
      selectedTaskId: 'task-1',
      filter: {
        scope: 'workspace' as const,
        attention: 'all' as const,
        target: 'all' as const,
      },
      status: 'idle' as const,
    };

    useAppStore.setState((state) => ({
      ...state,
      activeWorkspaceId: 'workspace-1',
      config: {
        ...state.config,
        workspaces: [
          {
            id: 'workspace-1',
            name: 'mini-term',
            roots: [{ id: 'root-1', name: 'mini-term', path: 'D:/code/mini-term', role: 'primary' }],
            pinned: false,
            createdAt: 1,
            lastOpenedAt: 1,
          },
          {
            id: 'workspace-2',
            name: 'other-app',
            roots: [{ id: 'root-2', name: 'other-app', path: 'D:/code/other-app', role: 'primary' }],
            pinned: false,
            createdAt: 1,
            lastOpenedAt: 1,
          },
        ],
      },
      workspaceStates: new Map([
        [
          'workspace-1',
          {
            id: 'workspace-1',
            activeTabId: 'agent-panel-1',
            tabs: [baseTab],
          },
        ],
      ]),
    }));

    const taskOne = createTaskDetail('task-1', 'workspace-1', 'mini-term');
    const taskTwo = createTaskDetail('task-2', 'workspace-2', 'other-app');
    listAgentTasks.mockResolvedValue([taskOne, taskTwo]);
    listAgentBackends.mockResolvedValue(defaultBackends());
    listApprovalRequests.mockResolvedValue([]);
    getAgentTaskStatus.mockResolvedValue(taskOne);
    listAgentTaskEvents.mockResolvedValue([
      {
        eventId: 'event-1',
        kind: 'task-started',
        timestamp: Date.now(),
        summary: 'Task task-1 started',
      },
    ]);
    getTaskEffectivePolicy.mockResolvedValue({
      taskId: 'task-1',
      injectionProfileId: 'codex-default',
      injectionPreset: 'review',
      policySummary: 'Codex Default profile on review preset',
      isInjected: true,
    });
    sendAgentTaskInput.mockResolvedValue(taskOne.summary);
    startAgentTask.mockResolvedValue(
      createTaskDetail('task-started', 'workspace-1', 'mini-term').summary,
    );
    closeAgentTask.mockResolvedValue({
      ok: true,
      data: taskOne.summary,
      approvalRequired: false,
    });
    resumeAgentTask.mockResolvedValue(taskOne);
    spawnWorkerTask.mockResolvedValue(
      createTaskDetail('task-worker-1', 'workspace-1', 'mini-term', 'running', [], {
        role: 'worker',
        parentTaskId: 'task-1',
      }).summary,
    );
  });

  it('shows workspace tasks by default', async () => {
    render(<TaskPanelHarness />);

    expect(await screen.findByText('mini-term task')).not.toBeNull();
    expect(screen.queryByText('other-app task')).toBeNull();
  });

  it('shows all workspace tasks after switching the scope filter', async () => {
    render(<TaskPanelHarness />);

    fireEvent.change(await screen.findByLabelText('范围'), {
      target: { value: 'all' },
    });

    expect(await screen.findByText('other-app task')).not.toBeNull();
  });

  it('starts a sidecar-backed task when the backend is ready', async () => {
    const taskOne = createTaskDetail('task-1', 'workspace-1', 'mini-term');
    const taskTwo = createTaskDetail('task-2', 'workspace-2', 'other-app');
    const startedTask = createTaskDetail(
      'task-started',
      'workspace-1',
      'mini-term',
      'running',
      [],
      {
        target: 'claude',
        backendId: 'claude-sidecar',
        backendDisplayName: 'Claude Sidecar',
        title: 'Claude review task',
      },
    );
    let tasksSnapshot = [taskOne, taskTwo];

    listAgentTasks.mockImplementation(async () => tasksSnapshot);
    getAgentTaskStatus.mockImplementation(async (taskId: string) => {
      return tasksSnapshot.find((item) => item.summary.taskId === taskId) ?? taskOne;
    });
    startAgentTask.mockImplementation(async () => {
      tasksSnapshot = [...tasksSnapshot, startedTask];
      return startedTask.summary;
    });

    render(<TaskPanelHarness />);

    fireEvent.change(await screen.findByLabelText('新任务目标'), {
      target: { value: 'claude' },
    });
    fireEvent.change(screen.getByLabelText('新任务预设'), {
      target: { value: 'review' },
    });
    fireEvent.change(screen.getByLabelText('新任务 Backend'), {
      target: { value: 'claude-sidecar' },
    });

    expect(
      screen.getByText(/Approval requests remain in Mini-Term Inbox/i),
    ).not.toBeNull();

    fireEvent.change(screen.getByLabelText('新任务标题'), {
      target: { value: 'Claude review task' },
    });
    fireEvent.change(screen.getByLabelText('新任务工作目录'), {
      target: { value: 'D:/code/mini-term/src-tauri' },
    });
    fireEvent.change(screen.getByLabelText('新任务说明'), {
      target: { value: 'Review the sidecar broker path' },
    });
    fireEvent.click(screen.getByRole('button', { name: '启动任务' }));

    await waitFor(() => {
      expect(startAgentTask).toHaveBeenCalledWith({
        workspaceId: 'workspace-1',
        target: 'claude',
        prompt: 'Review the sidecar broker path',
        contextPreset: 'review',
        backendId: 'claude-sidecar',
        cwd: 'D:/code/mini-term/src-tauri',
        title: 'Claude review task',
      });
    });
    expect(await screen.findAllByText('Claude review task')).not.toHaveLength(0);
  });

  it('prefers the backend marked as default for the selected target', async () => {
    const routedBackends = defaultBackends().map((backend) =>
      backend.backendId === 'claude-cli'
        ? { ...backend, preferredForTarget: false, defaultForTarget: false }
        : backend.backendId === 'claude-sidecar'
          ? {
              ...backend,
              preferredForTarget: true,
              defaultForTarget: true,
              routingStatusMessage: 'Claude routing: sidecar is the resolved default backend.',
            }
          : backend,
    );
    listAgentBackends.mockResolvedValue(routedBackends);

    render(<TaskPanelHarness />);

    fireEvent.change(await screen.findByLabelText('新任务目标'), {
      target: { value: 'claude' },
    });

    await waitFor(() => {
      expect((screen.getByLabelText('新任务 Backend') as HTMLSelectElement).value).toBe(
        'claude-sidecar',
      );
    });
    expect(
      screen.getAllByText('Claude routing: sidecar is the resolved default backend.').length,
    ).toBeGreaterThan(0);
  });

  it('blocks sidecar task start until backend preflight is ready', async () => {
    listAgentBackends.mockResolvedValue([
      {
        ...backendById('claude-sidecar'),
        available: false,
        status: 'configured',
        statusMessage: 'Configured but not yet tested.',
      },
    ]);

    render(<TaskPanelHarness />);

    fireEvent.change(await screen.findByLabelText('新任务目标'), {
      target: { value: 'claude' },
    });

    expect(await screen.findAllByText('Configured but not yet tested.')).not.toHaveLength(0);
    const startButton = screen.getByRole('button', { name: '启动任务' });
    expect(startButton.hasAttribute('disabled')).toBe(true);
    expect(startAgentTask).not.toHaveBeenCalled();
  });

  it('sends input to the selected running task', async () => {
    render(<TaskPanelHarness />);

    fireEvent.change(
      await screen.findByPlaceholderText('向运行中的任务发送补充输入...'),
      {
        target: { value: 'continue with the fix' },
      },
    );
    fireEvent.click(screen.getByRole('button', { name: '发送输入' }));

    await waitFor(() => {
      expect(sendAgentTaskInput).toHaveBeenCalledWith('task-1', 'continue with the fix');
    });
  });

  it('resumes and closes the selected task', async () => {
    render(<TaskPanelHarness />);

    expect(await screen.findByText('D:/logs/task-1.log')).not.toBeNull();
    const resumeButton = screen.getByRole('button', { name: '恢复会话' });
    expect(resumeButton.hasAttribute('disabled')).toBe(false);
    fireEvent.click(resumeButton);
    await waitFor(() => {
      expect(resumeAgentTask).toHaveBeenCalledWith('task-1');
    });

    const closeButton = screen.getByRole('button', { name: '关闭任务' });
    expect(closeButton.hasAttribute('disabled')).toBe(false);
    fireEvent.click(closeButton);
    await waitFor(() => {
      expect(closeAgentTask).toHaveBeenCalledWith('task-1', undefined, false);
    });
  });

  it('shows the approval notice when closing requires inbox approval', async () => {
    closeAgentTask.mockResolvedValueOnce({
      ok: false,
      approvalRequired: true,
      request: {
        requestId: 'approval-1',
        toolName: 'close_task',
        reason: 'Closing a task can interrupt an active agent run.',
        riskLevel: 'medium',
        payloadPreview: 'Task: task-1',
        status: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    });

    render(<TaskPanelHarness />);

    fireEvent.click(await screen.findByRole('button', { name: '关闭任务' }));

    await waitFor(() => {
      expect(closeAgentTask).toHaveBeenCalledWith('task-1', undefined, false);
    });
  });

  it('opens a saved plan artifact in the file viewer', async () => {
    const planTask = createTaskDetail(
      'task-1',
      'workspace-1',
      'mini-term',
      'running',
      [
        {
          artifactId: 'artifact-1',
          kind: 'plan',
          title: 'Execution Plan',
          path: 'D:/Users/test/AppData/Roaming/mini-term/agent_state/tasks/task-1/artifacts/plan.md',
          mimeType: 'text/markdown',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    );
    listAgentTasks.mockResolvedValue([planTask]);
    getAgentTaskStatus.mockResolvedValue(planTask);

    render(<TaskPanelHarness />);

    expect(await screen.findByText('Execution Plan')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open Plan Document' }));

    await waitFor(() => {
      const workspaceState = useAppStore.getState().workspaceStates.get('workspace-1');
      expect(
        workspaceState?.tabs.some(
          (tab) =>
            tab.kind === 'file-viewer'
            && tab.filePath
              === 'D:/Users/test/AppData/Roaming/mini-term/agent_state/tasks/task-1/artifacts/plan.md',
        ),
      ).toBe(true);
    });
  });

  it('renders task graph and timeline details for related worker tasks', async () => {
    const parentTask = createTaskDetail('task-1', 'workspace-1', 'mini-term');
    const workerTask = createTaskDetail(
      'task-2',
      'workspace-1',
      'mini-term',
      'running',
      [],
      {
        role: 'worker',
        parentTaskId: 'task-1',
      },
    );
    listAgentTasks.mockResolvedValue([parentTask, workerTask]);
    listAgentTaskEvents.mockResolvedValue([
      {
        eventId: 'event-1',
        kind: 'worker-spawned',
        timestamp: Date.now(),
        summary: 'Worker task task-2 spawned from coordinator task-1.',
      },
      {
        eventId: 'event-2',
        kind: 'task-started',
        timestamp: Date.now() - 1000,
        summary: 'Task task-1 started.',
      },
    ]);

    render(<TaskPanelHarness />);

    expect(await screen.findByText('Task Graph')).not.toBeNull();
    expect(screen.getByText('Children')).not.toBeNull();
    expect(screen.getByText('Timeline')).not.toBeNull();
    expect(await screen.findByText('Worker Spawned')).not.toBeNull();
  });

  it('renders backend contract details for a sidecar task', async () => {
    const sidecarTask = createTaskDetail(
      'task-1',
      'workspace-1',
      'mini-term',
      'running',
      [],
      {
        target: 'claude',
        backendId: 'claude-sidecar',
        backendDisplayName: 'Claude Sidecar',
      },
    );
    listAgentTasks.mockResolvedValue([sidecarTask]);
    getAgentTaskStatus.mockResolvedValue(sidecarTask);

    render(<TaskPanelHarness />);

    expect(await screen.findByText('Backend Contract')).not.toBeNull();
    expect(screen.getByText('Sidecar | Sidecar RPC')).not.toBeNull();
    expect(screen.getAllByText('Tool authority: mini-term').length).toBeGreaterThan(0);
    expect(screen.getByText('Reserved tools')).not.toBeNull();
    expect(screen.getByText('close_task')).not.toBeNull();
    expect(screen.getByText(/Approval requests remain in Mini-Term Inbox/i)).not.toBeNull();
  });

  it('disables resume and worker actions when the backend capability is missing', async () => {
    const limitedSidecarTask = createTaskDetail(
      'task-1',
      'workspace-1',
      'mini-term',
      'running',
      [],
      {
        target: 'claude',
        backendId: 'claude-sidecar',
        backendDisplayName: 'Claude Sidecar',
      },
    );
    listAgentTasks.mockResolvedValue([limitedSidecarTask]);
    getAgentTaskStatus.mockResolvedValue(limitedSidecarTask);
    listAgentBackends.mockResolvedValue([
      {
        ...backendById('claude-sidecar'),
        capabilities: {
          ...backendById('claude-sidecar').capabilities,
          supportsWorkers: false,
          supportsResume: false,
          restrictedToolNames: ['close_task'],
          toolCallNotes: 'Brokered by Mini-Term.',
          approvalFlowNotes: 'Approval remains in Mini-Term.',
        },
      },
    ]);

    render(<TaskPanelHarness />);

    await waitFor(() => {
      const resumeButton = screen.getByRole('button', { name: '恢复会话' });
      expect(resumeButton.hasAttribute('disabled')).toBe(true);
    });
    expect(screen.queryByRole('button', { name: 'Spawn Worker' })).toBeNull();
  });

  it('spawns a worker task from the selected coordinator', async () => {
    render(<TaskPanelHarness />);

    fireEvent.change(await screen.findByPlaceholderText('Optional worker title'), {
      target: { value: 'Review worker' },
    });
    fireEvent.change(screen.getByPlaceholderText('Describe the worker task...'), {
      target: { value: 'Review the latest MCP changes' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Spawn Worker' }));

    await waitFor(() => {
      expect(spawnWorkerTask).toHaveBeenCalledWith({
        parentTaskId: 'task-1',
        prompt: 'Review the latest MCP changes',
        title: 'Review worker',
      });
    });
  });

  it('supports cascade close for coordinator tasks with children', async () => {
    const parentTask = createTaskDetail('task-1', 'workspace-1', 'mini-term');
    const workerTask = createTaskDetail(
      'task-2',
      'workspace-1',
      'mini-term',
      'running',
      [],
      {
        role: 'worker',
        parentTaskId: 'task-1',
      },
    );
    listAgentTasks.mockResolvedValue([parentTask, workerTask]);
    getAgentTaskStatus.mockResolvedValue(parentTask);
    closeAgentTask.mockResolvedValueOnce({ ok: true, data: parentTask.summary, approvalRequired: false });

    render(<TaskPanelHarness />);

    const closeChildrenButton = await screen.findByRole('button', { name: 'Close + Children' });
    await waitFor(() => {
      expect(closeChildrenButton.hasAttribute('disabled')).toBe(false);
    });
    fireEvent.click(closeChildrenButton);

    await waitFor(() => {
      expect(closeAgentTask).toHaveBeenCalledWith('task-1', undefined, true);
    });
  });
  it('retries close with an approved request id after inbox approval', async () => {
    closeAgentTask
      .mockResolvedValueOnce({
        approvalRequired: true,
        request: {
          requestId: 'approval-1',
          toolName: 'close_task',
          reason: 'Closing a task can interrupt an active agent run.',
          riskLevel: 'medium',
          payloadPreview: 'Task: task-1',
          status: 'pending',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: createTaskDetail('task-1', 'workspace-1', 'mini-term', 'exited').summary,
        approvalRequired: false,
      });
    listApprovalRequests
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          requestId: 'approval-1',
          toolName: 'close_task',
          reason: 'Closing a task can interrupt an active agent run.',
          riskLevel: 'medium',
          payloadPreview: 'Task: task-1',
          status: 'approved',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]);

    render(<TaskPanelHarness />);

    const closeButton = await screen.findByRole('button', { name: /关闭任务/ });
    fireEvent.click(closeButton);
    await screen.findByText('已创建关闭审批，请先在 Inbox 中批准后再重试。');

    fireEvent.click(closeButton);

    await waitFor(() => {
      expect(closeAgentTask).toHaveBeenLastCalledWith('task-1', 'approval-1', false);
    });
  });
});
