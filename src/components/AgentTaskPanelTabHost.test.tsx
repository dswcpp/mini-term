import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTaskPanelTabHost } from './AgentTaskPanelTabHost';
import { selectWorkspaceState, useAppStore } from '../store';

const listAgentTasks = vi.fn();
const listApprovalRequests = vi.fn();
const getAgentTaskStatus = vi.fn();
const getTaskEffectivePolicy = vi.fn();
const sendAgentTaskInput = vi.fn();
const closeAgentTask = vi.fn();
const resumeAgentTask = vi.fn();

vi.mock('../runtime/agentApi', () => ({
  listAgentTasks: (...args: unknown[]) => listAgentTasks(...args),
  listApprovalRequests: (...args: unknown[]) => listApprovalRequests(...args),
  getAgentTaskStatus: (...args: unknown[]) => getAgentTaskStatus(...args),
  sendAgentTaskInput: (...args: unknown[]) => sendAgentTaskInput(...args),
  closeAgentTask: (...args: unknown[]) => closeAgentTask(...args),
  resumeAgentTask: (...args: unknown[]) => resumeAgentTask(...args),
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
) {
  return {
    summary: {
      taskId,
      workspaceId,
      workspaceName,
      workspaceRootPath: `D:/code/${workspaceName}`,
      target: 'codex' as const,
      title: `${workspaceName} task`,
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
      promptPreview: 'Fix the task.',
      lastOutputExcerpt: 'Recent output',
    },
    recentOutputExcerpt: 'Recent output',
    diffSummary: [],
    logPath: `D:/logs/${taskId}.log`,
    artifacts,
  };
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
    listApprovalRequests.mockResolvedValue([]);
    getAgentTaskStatus.mockResolvedValue(taskOne);
    getTaskEffectivePolicy.mockResolvedValue({
      taskId: 'task-1',
      injectionProfileId: 'codex-default',
      injectionPreset: 'review',
      policySummary: 'Codex Default profile on review preset',
      isInjected: true,
    });
    sendAgentTaskInput.mockResolvedValue(taskOne.summary);
    closeAgentTask.mockResolvedValue({
      ok: true,
      data: taskOne.summary,
      approvalRequired: false,
    });
    resumeAgentTask.mockResolvedValue(taskOne);
  });

  it('默认只显示当前工作区任务', async () => {
    render(<TaskPanelHarness />);

    expect(await screen.findByText('mini-term task')).not.toBeNull();
    expect(screen.queryByText('other-app task')).toBeNull();
  });

  it('切换到全部工作区后显示所有任务', async () => {
    render(<TaskPanelHarness />);

    fireEvent.change(await screen.findByLabelText('范围'), {
      target: { value: 'all' },
    });

    expect(await screen.findByText('other-app task')).not.toBeNull();
  });

  it('可向运行中的任务发送补充输入', async () => {
    render(<TaskPanelHarness />);

    fireEvent.change(
      await screen.findByPlaceholderText('向运行中的任务发送补充输入...'),
      {
        target: { value: 'continue with the fix' },
      },
    );
    fireEvent.click(screen.getByRole('button', { name: '发送输入' }));

    await waitFor(() => {
      expect(sendAgentTaskInput).toHaveBeenCalledWith(
        'task-1',
        'continue with the fix',
      );
    });
  });

  it('可以恢复并关闭当前任务', async () => {
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
      expect(closeAgentTask).toHaveBeenCalledWith('task-1');
    });
  });

  it('关闭任务需要审批时显示中文等待提示', async () => {
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

    expect(
      await screen.findByText('已创建关闭审批，请先在 Inbox 中批准后再重试。'),
    ).not.toBeNull();
  });

  it('renders a saved plan artifact and opens it in the file viewer', async () => {
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

  it('retries close with an approved request id after inbox approval', async () => {
    closeAgentTask
      .mockResolvedValueOnce({
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
      })
      .mockResolvedValueOnce({
        ok: true,
        data: createTaskDetail(
          'task-1',
          'workspace-1',
          'mini-term',
          'exited',
        ).summary,
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

    const closeButton = await screen.findByRole('button', {
      name: /关闭任务/,
    });
    fireEvent.click(closeButton);
    await screen.findByText(/Inbox/);

    fireEvent.click(closeButton);

    await waitFor(() => {
      expect(closeAgentTask).toHaveBeenLastCalledWith('task-1', 'approval-1');
    });
  });
});
