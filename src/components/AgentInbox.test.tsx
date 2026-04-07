import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../store';
import { AgentInbox } from './AgentInbox';

const listApprovalRequests = vi.fn();
const listAttentionTaskSummaries = vi.fn();
const resolveApprovalRequest = vi.fn();
const closeAgentTask = vi.fn();

vi.mock('../runtime/agentApi', () => ({
  listApprovalRequests: (...args: unknown[]) => listApprovalRequests(...args),
  listAttentionTaskSummaries: (...args: unknown[]) => listAttentionTaskSummaries(...args),
  resolveApprovalRequest: (...args: unknown[]) => resolveApprovalRequest(...args),
  closeAgentTask: (...args: unknown[]) => closeAgentTask(...args),
}));

describe('AgentInbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState((state) => ({
      ...state,
      activeWorkspaceId: 'workspace-1',
      workspaceStates: new Map([
        [
          'workspace-1',
          {
            id: 'workspace-1',
            activeTabId: '',
            tabs: [],
          },
        ],
      ]),
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
                path: 'D:/code/JavaScript/mini-term',
                role: 'primary',
              },
            ],
            pinned: false,
            createdAt: 1,
            lastOpenedAt: 1,
          },
        ],
      },
    }));
  });

  it('renders a pending approval and resolves it', async () => {
    listApprovalRequests.mockResolvedValue([
      {
        requestId: 'approval-1',
        toolName: 'write_file',
        reason: 'Write a file',
        riskLevel: 'high',
        payloadPreview: 'Path: D:/code/JavaScript/mini-term/README.md',
        status: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);
    listAttentionTaskSummaries.mockResolvedValue([]);
    resolveApprovalRequest.mockResolvedValue({
      requestId: 'approval-1',
      toolName: 'write_file',
      reason: 'Write a file',
      riskLevel: 'high',
      payloadPreview: 'Path: D:/code/JavaScript/mini-term/README.md',
      status: 'approved',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    render(<AgentInbox />);

    expect(await screen.findByText('write_file')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(resolveApprovalRequest).toHaveBeenCalledWith('approval-1', true);
    });
    expect(closeAgentTask).not.toHaveBeenCalled();
  });

  it('auto-executes approved close_task requests from inbox', async () => {
    listApprovalRequests.mockResolvedValue([
      {
        requestId: 'approval-close-1',
        toolName: 'close_task',
        reason: 'Close an agent task',
        riskLevel: 'medium',
        payloadPreview: 'Task: task-42',
        status: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);
    listAttentionTaskSummaries.mockResolvedValue([]);
    resolveApprovalRequest.mockResolvedValue({
      requestId: 'approval-close-1',
      toolName: 'close_task',
      reason: 'Close an agent task',
      riskLevel: 'medium',
      payloadPreview: 'Task: task-42',
      status: 'approved',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    closeAgentTask.mockResolvedValue({
      ok: true,
      approvalRequired: false,
      data: {
        taskId: 'task-42',
      },
    });

    render(<AgentInbox />);

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(resolveApprovalRequest).toHaveBeenCalledWith('approval-close-1', true);
      expect(closeAgentTask).toHaveBeenCalledWith('task-42', 'approval-close-1', false);
    });
  });

  it('passes cascadeChildren when approving cascade close requests', async () => {
    listApprovalRequests.mockResolvedValue([
      {
        requestId: 'approval-close-2',
        toolName: 'close_task',
        reason: 'Close an agent task and its children',
        riskLevel: 'medium',
        payloadPreview: 'Task: task-99\nCascadeChildren: true\nDescendantCount: 2',
        status: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);
    listAttentionTaskSummaries.mockResolvedValue([]);
    resolveApprovalRequest.mockResolvedValue({
      requestId: 'approval-close-2',
      toolName: 'close_task',
      reason: 'Close an agent task and its children',
      riskLevel: 'medium',
      payloadPreview: 'Task: task-99\nCascadeChildren: true\nDescendantCount: 2',
      status: 'approved',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    closeAgentTask.mockResolvedValue({
      ok: true,
      approvalRequired: false,
      data: {
        taskId: 'task-99',
      },
    });

    render(<AgentInbox />);

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(closeAgentTask).toHaveBeenCalledWith('task-99', 'approval-close-2', true);
    });
  });

  it('opens the task panel for the active workspace', async () => {
    listApprovalRequests.mockResolvedValue([]);
    listAttentionTaskSummaries.mockResolvedValue([]);

    render(<AgentInbox />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open Tasks' }));

    await waitFor(() => {
      const workspaceState = useAppStore.getState().workspaceStates.get('workspace-1');
      expect(workspaceState?.tabs.some((tab) => tab.kind === 'agent-tasks')).toBe(true);
    });
  });

  it('opens the task panel focused on a selected task', async () => {
    listApprovalRequests.mockResolvedValue([]);
    listAttentionTaskSummaries.mockResolvedValue([
      {
        taskId: 'task-1',
        workspaceId: 'workspace-1',
        workspaceName: 'mini-term',
        workspaceRootPath: 'D:/code/JavaScript/mini-term',
        target: 'codex',
        title: 'Fix MCP runtime',
        status: 'exited',
        attentionState: 'needs-review',
        sessionId: 'task-1',
        cwd: 'D:/code/JavaScript/mini-term',
        startedAt: Date.now(),
        updatedAt: Date.now(),
        contextPreset: 'review',
        changedFiles: [
          {
            path: 'src-tauri/src/mcp/mod.rs',
            status: 'modified',
            statusLabel: 'M',
          },
        ],
        promptPreview: 'Please fix the MCP runtime.',
        lastOutputExcerpt: 'Task finished with changes.',
      },
    ]);

    render(<AgentInbox />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open Task Panel' }));

    await waitFor(() => {
      const workspaceState = useAppStore.getState().workspaceStates.get('workspace-1');
      const taskTab = workspaceState?.tabs.find((tab) => tab.kind === 'agent-tasks');
      expect(taskTab && 'selectedTaskId' in taskTab ? taskTab.selectedTaskId : undefined).toBe('task-1');
    });
  });

  it('shows a lightweight error when inbox refresh fails', async () => {
    listApprovalRequests.mockRejectedValue(new Error('boom'));
    listAttentionTaskSummaries.mockResolvedValue([]);

    render(<AgentInbox />);

    expect(await screen.findByText('Unable to refresh inbox')).not.toBeNull();
  });
});
