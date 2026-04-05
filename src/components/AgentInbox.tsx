import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../store';
import {
  closeAgentTask,
  listApprovalRequests,
  listAttentionTaskSummaries,
  resolveApprovalRequest,
} from '../runtime/agentApi';
import type { AgentTaskSummary, ApprovalRequest, GitFileStatus } from '../types';

function formatRelativeTime(timestamp: number) {
  if (!timestamp) return '';
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function getAttentionTone(attention: AgentTaskSummary['attentionState']) {
  switch (attention) {
    case 'failed':
      return 'text-[var(--color-danger)]';
    case 'needs-review':
      return 'text-[var(--accent)]';
    case 'waiting-input':
      return 'text-[var(--color-ai)]';
    default:
      return 'text-[var(--color-success)]';
  }
}

function parseCloseTaskId(payloadPreview: string) {
  const match = payloadPreview.match(/^\s*Task:\s*(.+?)\s*$/m);
  return match?.[1] || null;
}

export function AgentInbox() {
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId);
  const setActiveWorkspace = useAppStore((state) => state.setActiveWorkspace);
  const openWorktreeDiff = useAppStore((state) => state.openWorktreeDiff);
  const openAgentTaskPanel = useAppStore((state) => state.openAgentTaskPanel);

  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [tasks, setTasks] = useState<AgentTaskSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadInbox = useCallback(async () => {
    const [approvalData, taskData] = await Promise.all([listApprovalRequests(), listAttentionTaskSummaries()]);
    setApprovals(approvalData.filter((item) => item.status === 'pending'));
    setTasks(taskData);
    setError(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    const refresh = () => {
      void loadInbox().catch(() => {
        setError('Unable to refresh inbox');
        setLoading(false);
      });
    };

    refresh();
    const timer = window.setInterval(refresh, 8_000);
    const handleFocus = () => refresh();
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        refresh();
      }
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [loadInbox]);

  const hasContent = approvals.length > 0 || tasks.length > 0;
  const visibleTasks = useMemo(() => tasks.slice(0, 6), [tasks]);

  const resolveApproval = useCallback(
    async (request: ApprovalRequest, approved: boolean) => {
      try {
        await resolveApprovalRequest(request.requestId, approved);

        if (approved && request.toolName === 'close_task') {
          const taskId = parseCloseTaskId(request.payloadPreview);
          if (taskId) {
            await closeAgentTask(taskId, request.requestId);
          }
        }

        await loadInbox();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Unable to resolve approval');
      }
    },
    [loadInbox],
  );

  const openTaskPanel = useCallback(
    (workspaceId: string, taskId?: string) => {
      setActiveWorkspace(workspaceId);
      openAgentTaskPanel(workspaceId, { selectedTaskId: taskId, scope: 'workspace' });
    },
    [openAgentTaskPanel, setActiveWorkspace],
  );

  const openTaskDiff = useCallback(
    (workspaceId: string, projectPath: string, status: GitFileStatus) => {
      setActiveWorkspace(workspaceId);
      openWorktreeDiff(workspaceId, projectPath, status);
    },
    [openWorktreeDiff, setActiveWorkspace],
  );

  return (
    <div className="border-b border-[var(--border-subtle)] bg-[var(--bg-surface)]">
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5 text-sm font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">
        <span>Inbox</span>
        <div className="flex items-center gap-2">
          <span className="text-[10px] normal-case tracking-normal">{approvals.length + tasks.length}</span>
          {activeWorkspaceId ? (
            <button
              type="button"
              className="rounded-[var(--radius-sm)] border border-[var(--border-default)] px-2 py-1 text-[10px] normal-case tracking-normal text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
              onClick={() => openTaskPanel(activeWorkspaceId)}
            >
              Open Tasks
            </button>
          ) : null}
        </div>
      </div>

      {!hasContent ? (
        <div className="px-3 pb-3 text-xs text-[var(--text-muted)]">
          {loading ? 'Loading inbox...' : error ?? 'No pending approvals or attention tasks'}
        </div>
      ) : (
        <div className="space-y-2 px-2 pb-2">
          {error ? <div className="px-1 text-xs text-[var(--color-danger)]">{error}</div> : null}

          <div className="max-h-[260px] space-y-2 overflow-y-auto">
            {approvals.map((approval) => (
              <div
                key={approval.requestId}
                className="rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-elevated)] px-2.5 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium text-[var(--text-primary)]">{approval.toolName}</div>
                    <div className="text-[10px] uppercase tracking-[0.1em] text-[var(--text-muted)]">
                      {approval.riskLevel} risk
                    </div>
                  </div>
                  <div className="text-[10px] text-[var(--text-muted)]">{formatRelativeTime(approval.createdAt)}</div>
                </div>
                <div className="mt-1 text-xs text-[var(--text-secondary)]">{approval.reason}</div>
                <pre className="mt-1.5 max-h-24 overflow-auto rounded bg-[var(--bg-terminal)] px-2 py-1.5 text-[10px] leading-4 text-[var(--text-muted)]">
                  {approval.payloadPreview}
                </pre>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    className="rounded-[var(--radius-sm)] border border-[var(--accent)]/40 bg-[var(--accent-subtle)] px-2 py-1 text-[11px] text-[var(--accent)]"
                    onClick={() => void resolveApproval(approval, true)}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="rounded-[var(--radius-sm)] border border-[var(--border-default)] px-2 py-1 text-[11px] text-[var(--text-muted)]"
                    onClick={() => void resolveApproval(approval, false)}
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}

            {visibleTasks.map((task) => (
              <div
                key={task.taskId}
                className="rounded-[var(--radius-md)] border border-[var(--border-default)] px-2.5 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium text-[var(--text-primary)]">{task.title}</div>
                    <div className="truncate text-[10px] text-[var(--text-muted)]">
                      {task.target} · {task.workspaceName}
                    </div>
                  </div>
                  <div className={`text-[10px] uppercase tracking-[0.1em] ${getAttentionTone(task.attentionState)}`}>
                    {task.attentionState}
                  </div>
                </div>
                <div className="mt-1 line-clamp-2 text-xs text-[var(--text-secondary)]">
                  {task.lastOutputExcerpt || task.promptPreview}
                </div>
                <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] text-[var(--text-muted)]">
                  <span>{formatRelativeTime(task.updatedAt)}</span>
                  {task.changedFiles.length > 0 ? <span>{task.changedFiles.length} changed</span> : null}
                </div>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    className="rounded-[var(--radius-sm)] border border-[var(--border-default)] px-2 py-1 text-[11px] text-[var(--text-primary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
                    onClick={() => openTaskPanel(task.workspaceId, task.taskId)}
                  >
                    Open Task Panel
                  </button>
                  {task.attentionState === 'needs-review' && task.changedFiles[0] ? (
                    <button
                      type="button"
                      className="rounded-[var(--radius-sm)] border border-[var(--border-default)] px-2 py-1 text-[11px] text-[var(--text-primary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
                      onClick={() => openTaskDiff(task.workspaceId, task.workspaceRootPath, task.changedFiles[0])}
                    >
                      View Diff
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
