import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../store';
import {
  closeAgentTask,
  getAgentTaskStatus,
  listApprovalRequests,
  listAgentTasks,
  resumeAgentTask,
  sendAgentTaskInput,
} from '../runtime/agentApi';
import { getTaskEffectivePolicy } from '../runtime/agentPolicyApi';
import type {
  AgentTaskPanelTab,
  AgentTaskStatusDetail,
  TaskAttentionState,
  TaskEffectivePolicy,
  TaskTarget,
} from '../types';

interface AgentTaskPanelTabHostProps {
  tab: AgentTaskPanelTab;
  workspaceId: string;
  isActive: boolean;
}

function formatRelativeTime(timestamp: number) {
  if (!timestamp) return '';
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

const ATTENTION_OPTIONS: Array<TaskAttentionState | 'all'> = [
  'all',
  'running',
  'waiting-input',
  'needs-review',
  'failed',
  'completed',
];
const TARGET_OPTIONS: Array<TaskTarget | 'all'> = ['all', 'codex', 'claude'];

function attentionLabel(value: TaskAttentionState | 'all') {
  switch (value) {
    case 'all':
      return '全部';
    case 'running':
      return '运行中';
    case 'waiting-input':
      return '等待输入';
    case 'needs-review':
      return '待审查';
    case 'failed':
      return '失败';
    case 'completed':
      return '已完成';
  }
}

function targetLabel(value: TaskTarget | 'all') {
  switch (value) {
    case 'all':
      return '全部';
    case 'codex':
      return 'Codex';
    case 'claude':
      return 'Claude';
  }
}

function statusLabel(value: string) {
  switch (value) {
    case 'starting':
      return '启动中';
    case 'running':
      return '运行中';
    case 'waiting-input':
      return '等待输入';
    case 'exited':
      return '已退出';
    case 'error':
      return '错误';
    default:
      return value;
  }
}

function presetLabel(value: string) {
  switch (value) {
    case 'light':
      return '轻量';
    case 'standard':
      return '标准';
    case 'review':
      return '审查';
    default:
      return value;
  }
}

async function findApprovedCloseRequestId(
  taskId: string,
): Promise<string | undefined> {
  const approvals = await listApprovalRequests();
  const matching = approvals
    .filter(
      (request) =>
        request.toolName === 'close_task' &&
        request.status === 'approved' &&
        request.payloadPreview.trim() === `Task: ${taskId}`,
    )
    .sort((left, right) => right.updatedAt - left.updatedAt);
  return matching[0]?.requestId;
}

export function AgentTaskPanelTabHost({
  tab,
  workspaceId,
  isActive,
}: AgentTaskPanelTabHostProps) {
  const setActiveWorkspace = useAppStore((state) => state.setActiveWorkspace);
  const openFileViewer = useAppStore((state) => state.openFileViewer);
  const openWorktreeDiff = useAppStore((state) => state.openWorktreeDiff);
  const setAgentTaskPanelSelection = useAppStore(
    (state) => state.setAgentTaskPanelSelection,
  );
  const setAgentTaskPanelFilter = useAppStore(
    (state) => state.setAgentTaskPanelFilter,
  );

  const [tasks, setTasks] = useState<AgentTaskStatusDetail[]>([]);
  const [selectedTask, setSelectedTask] =
    useState<AgentTaskStatusDetail | null>(null);
  const [effectivePolicy, setEffectivePolicy] =
    useState<TaskEffectivePolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [approvalNotice, setApprovalNotice] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [actionState, setActionState] = useState<
    'idle' | 'sending' | 'closing' | 'resuming'
  >('idle');

  const refreshTasks = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listAgentTasks();
      setTasks(result);
      setError(null);
    } catch {
      setError('加载任务列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshSelectedTask = useCallback(async (taskId: string) => {
    setDetailLoading(true);
    try {
      const [detail, policy] = await Promise.all([
        getAgentTaskStatus(taskId),
        getTaskEffectivePolicy(taskId),
      ]);
      setSelectedTask(detail);
      setEffectivePolicy(policy);
      setDetailError(null);
    } catch {
      setSelectedTask(null);
      setEffectivePolicy(null);
      setDetailError('加载任务详情失败');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isActive) {
      return;
    }

    const refresh = () => {
      void refreshTasks();
      if (tab.selectedTaskId) {
        void refreshSelectedTask(tab.selectedTaskId);
      }
    };

    refresh();
    const timer = window.setInterval(refresh, 8_000);
    return () => window.clearInterval(timer);
  }, [isActive, refreshSelectedTask, refreshTasks, tab.selectedTaskId]);

  useEffect(() => {
    if (!tab.selectedTaskId) {
      setSelectedTask(null);
      setEffectivePolicy(null);
      return;
    }
    if (selectedTask && selectedTask.summary.taskId !== tab.selectedTaskId) {
      setSelectedTask(null);
      setEffectivePolicy(null);
    }
  }, [selectedTask, tab.selectedTaskId]);

  const visibleTasks = useMemo(() => {
    return tasks.filter((item) => {
      const matchesScope =
        tab.filter.scope === 'all' || item.summary.workspaceId === workspaceId;
      const matchesAttention =
        !tab.filter.attention ||
        tab.filter.attention === 'all' ||
        item.summary.attentionState === tab.filter.attention;
      const matchesTarget =
        !tab.filter.target ||
        tab.filter.target === 'all' ||
        item.summary.target === tab.filter.target;
      return matchesScope && matchesAttention && matchesTarget;
    });
  }, [tab.filter.attention, tab.filter.scope, tab.filter.target, tasks, workspaceId]);

  useEffect(() => {
    if (visibleTasks.length === 0) {
      if (tab.selectedTaskId) {
        setAgentTaskPanelSelection(workspaceId, tab.id, undefined);
      }
      setSelectedTask(null);
      return;
    }

    const hasSelected =
      tab.selectedTaskId &&
      visibleTasks.some((item) => item.summary.taskId === tab.selectedTaskId);
    const nextTaskId = hasSelected
      ? tab.selectedTaskId
      : visibleTasks[0].summary.taskId;
    if (nextTaskId !== tab.selectedTaskId) {
      setAgentTaskPanelSelection(workspaceId, tab.id, nextTaskId);
      return;
    }

    if (
      nextTaskId &&
      (!selectedTask || selectedTask.summary.taskId !== nextTaskId)
    ) {
      void refreshSelectedTask(nextTaskId);
    }
  }, [
    refreshSelectedTask,
    selectedTask,
    setAgentTaskPanelSelection,
    tab.id,
    tab.selectedTaskId,
    visibleTasks,
    workspaceId,
  ]);

  const openDiff = useCallback(() => {
    if (!selectedTask?.summary.changedFiles[0]) {
      return;
    }
    setActiveWorkspace(selectedTask.summary.workspaceId);
    openWorktreeDiff(
      selectedTask.summary.workspaceId,
      selectedTask.summary.workspaceRootPath,
      selectedTask.summary.changedFiles[0],
    );
  }, [openWorktreeDiff, selectedTask, setActiveWorkspace]);

  const openPlan = useCallback(() => {
    const artifact = selectedTask?.artifacts.find((item) => item.kind === 'plan');
    if (!selectedTask || !artifact) {
      return;
    }
    setActiveWorkspace(selectedTask.summary.workspaceId);
    openFileViewer(selectedTask.summary.workspaceId, artifact.path, {
      initialMode: 'preview',
    });
  }, [openFileViewer, selectedTask, setActiveWorkspace]);

  const handleSendInput = useCallback(async () => {
    if (!selectedTask || !inputValue.trim()) {
      return;
    }
    setActionState('sending');
    try {
      await sendAgentTaskInput(selectedTask.summary.taskId, inputValue.trim());
      setInputValue('');
      await refreshTasks();
      await refreshSelectedTask(selectedTask.summary.taskId);
    } catch {
      setDetailError('发送任务输入失败');
    } finally {
      setActionState('idle');
    }
  }, [inputValue, refreshSelectedTask, refreshTasks, selectedTask]);

  const handleCloseTask = useCallback(async () => {
    if (!selectedTask) {
      return;
    }
    setActionState('closing');
    try {
      const approvalRequestId = await findApprovedCloseRequestId(
        selectedTask.summary.taskId,
      );
      const result = approvalRequestId
        ? await closeAgentTask(selectedTask.summary.taskId, approvalRequestId)
        : await closeAgentTask(selectedTask.summary.taskId);
      if (result.ok) {
        setApprovalNotice(null);
        await refreshTasks();
        await refreshSelectedTask(selectedTask.summary.taskId);
        setDetailError(null);
      } else if (result.approvalRequired) {
        setApprovalNotice('已创建关闭审批，请先在 Inbox 中批准后再重试。');
        setDetailError(null);
      } else {
        setDetailError('关闭任务失败');
      }
    } catch {
      setDetailError('关闭任务失败');
    } finally {
      setActionState('idle');
    }
  }, [refreshSelectedTask, refreshTasks, selectedTask]);

  const handleResumeTask = useCallback(async () => {
    if (!selectedTask) {
      return;
    }
    setActionState('resuming');
    try {
      const detail = await resumeAgentTask(selectedTask.summary.taskId);
      setSelectedTask(detail);
      await refreshTasks();
      setApprovalNotice(null);
      setDetailError(null);
    } catch {
      setDetailError('恢复会话失败');
    } finally {
      setActionState('idle');
    }
  }, [refreshTasks, selectedTask]);

  const selectedSummary =
    visibleTasks.find((item) => item.summary.taskId === tab.selectedTaskId)
      ?.summary ??
    (selectedTask && selectedTask.summary.taskId === tab.selectedTaskId
      ? selectedTask.summary
      : null);
  const planArtifact = selectedTask?.artifacts.find((artifact) => artifact.kind === 'plan');
  const canSendInput = selectedSummary?.status === 'running';

  return (
    <div className="flex h-full bg-[var(--bg-terminal)] text-[var(--text-primary)]">
      <div className="flex w-[320px] shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-elevated)]">
        <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-3 py-2">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
              任务
            </div>
            <div className="mt-0.5 text-[11px] text-[var(--text-secondary)]">
              {tab.filter.scope === 'all' ? '全部工作区' : '当前工作区'}
            </div>
          </div>
          <button
            type="button"
            className="rounded-[var(--radius-sm)] border border-[var(--border-default)] px-2 py-1 text-[11px] text-[var(--text-secondary)]"
            onClick={() => {
              void refreshTasks();
              if (tab.selectedTaskId) {
                void refreshSelectedTask(tab.selectedTaskId);
              }
            }}
          >
            刷新
          </button>
        </div>

        <div className="grid grid-cols-3 gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-[0.08em] text-[var(--text-muted)]">
            范围
            <select
              aria-label="范围"
              className="rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 py-1 text-[11px] text-[var(--text-primary)]"
              value={tab.filter.scope}
              onChange={(event) =>
                setAgentTaskPanelFilter(workspaceId, tab.id, {
                  scope: event.target.value as AgentTaskPanelTab['filter']['scope'],
                })
              }
            >
              <option value="workspace">当前</option>
              <option value="all">全部</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-[0.08em] text-[var(--text-muted)]">
            状态
            <select
              aria-label="状态"
              className="rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 py-1 text-[11px] text-[var(--text-primary)]"
              value={tab.filter.attention ?? 'all'}
              onChange={(event) =>
                setAgentTaskPanelFilter(workspaceId, tab.id, {
                  attention: event.target.value as TaskAttentionState | 'all',
                })
              }
            >
              {ATTENTION_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {attentionLabel(option)}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-[0.08em] text-[var(--text-muted)]">
            目标
            <select
              aria-label="目标"
              className="rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 py-1 text-[11px] text-[var(--text-primary)]"
              value={tab.filter.target ?? 'all'}
              onChange={(event) =>
                setAgentTaskPanelFilter(workspaceId, tab.id, {
                  target: event.target.value as TaskTarget | 'all',
                })
              }
            >
              {TARGET_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {targetLabel(option)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="px-3 py-3 text-xs text-[var(--text-muted)]">
              正在加载任务...
            </div>
          ) : null}
          {!loading && error ? (
            <div className="px-3 py-3 text-xs text-[var(--color-danger)]">
              {error}
            </div>
          ) : null}
          {!loading && !error && visibleTasks.length === 0 ? (
            <div className="px-3 py-3 text-xs text-[var(--text-muted)]">
              当前筛选条件下没有任务
            </div>
          ) : null}
          {visibleTasks.map((item) => {
            const summary = item.summary;
            const selected = summary.taskId === tab.selectedTaskId;
            return (
              <button
                key={summary.taskId}
                type="button"
                className={`flex w-full flex-col items-start gap-1 border-b border-[var(--border-subtle)] px-3 py-2 text-left ${
                  selected
                    ? 'bg-[var(--accent-subtle)]/30'
                    : 'hover:bg-[var(--bg-surface)]'
                }`}
                onClick={() =>
                  setAgentTaskPanelSelection(workspaceId, tab.id, summary.taskId)
                }
              >
                <div className="flex w-full items-center justify-between gap-2">
                  <div className="truncate text-xs font-medium">
                    {summary.title}
                  </div>
                  <span className="shrink-0 text-[10px] uppercase tracking-[0.08em] text-[var(--text-muted)]">
                    {attentionLabel(summary.attentionState)}
                  </span>
                </div>
                <div className="truncate text-[11px] text-[var(--text-secondary)]">
                  {targetLabel(summary.target)} · {summary.workspaceName}
                </div>
                <div className="line-clamp-2 text-[11px] text-[var(--text-muted)]">
                  {summary.lastOutputExcerpt || summary.promptPreview}
                </div>
                <div className="flex items-center gap-2 text-[10px] text-[var(--text-muted)]">
                  <span>{formatRelativeTime(summary.updatedAt)}</span>
                  {summary.changedFiles.length > 0 ? (
                    <span>{summary.changedFiles.length} 个变更</span>
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-w-0 flex-1">
        {!selectedSummary ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">
            请选择一个任务查看详情
          </div>
        ) : (
          <div className="flex h-full flex-col">
            <div className="border-b border-[var(--border-subtle)] px-4 py-3">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">
                    {selectedSummary.title}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-[var(--text-muted)]">
                    <span>{targetLabel(selectedSummary.target)}</span>
                    <span>{selectedSummary.workspaceName}</span>
                    <span>{statusLabel(selectedSummary.status)}</span>
                    <span>{attentionLabel(selectedSummary.attentionState)}</span>
                    <span>{presetLabel(selectedSummary.contextPreset)}</span>
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    className="rounded-[var(--radius-sm)] border border-[var(--border-default)] px-2.5 py-1 text-[11px] text-[var(--text-secondary)]"
                    onClick={() => void handleResumeTask()}
                    disabled={actionState !== 'idle'}
                  >
                    恢复会话
                  </button>
                  <button
                    type="button"
                    className="rounded-[var(--radius-sm)] border border-[var(--border-default)] px-2.5 py-1 text-[11px] text-[var(--text-secondary)]"
                    onClick={() => void handleCloseTask()}
                    disabled={actionState !== 'idle'}
                  >
                    关闭任务
                  </button>
                  {selectedSummary.attentionState === 'needs-review' &&
                  selectedSummary.changedFiles[0] ? (
                    <button
                      type="button"
                      className="rounded-[var(--radius-sm)] border border-[var(--accent)]/40 bg-[var(--accent-subtle)] px-2.5 py-1 text-[11px] text-[var(--accent)]"
                      onClick={openDiff}
                    >
                      打开首个 Diff
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="mt-2 text-[11px] text-[var(--text-muted)]">
                当前工作目录：{selectedSummary.cwd}
              </div>
            </div>

            <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_320px]">
              <div className="min-h-0 overflow-y-auto px-4 py-3">
                {detailLoading ? (
                  <div className="text-xs text-[var(--text-muted)]">
                    正在加载任务详情...
                  </div>
                ) : null}
                {detailError ? (
                  <div className="mb-3 text-xs text-[var(--color-danger)]">
                    {detailError}
                  </div>
                ) : null}
                {approvalNotice ? (
                  <div className="mb-3 text-xs text-[var(--accent)]">
                    {approvalNotice}
                  </div>
                ) : null}

                <div className="mb-4">
                  <div className="text-[10px] uppercase tracking-[0.1em] text-[var(--text-muted)]">
                    提示词预览
                  </div>
                  <pre className="mt-1 whitespace-pre-wrap rounded bg-[var(--bg-elevated)] px-3 py-2 text-[11px] leading-5 text-[var(--text-secondary)]">
                    {selectedSummary.promptPreview || '暂无提示词预览'}
                  </pre>
                </div>

                <div className="mb-4">
                  <div className="text-[10px] uppercase tracking-[0.1em] text-[var(--text-muted)]">
                    注入策略
                  </div>
                  <div className="mt-1 rounded bg-[var(--bg-elevated)] px-3 py-2 text-[11px] leading-5 text-[var(--text-secondary)]">
                    {effectivePolicy?.isInjected ? (
                      <>
                        <div>
                          配置：{effectivePolicy.injectionProfileId ?? '未知'}
                        </div>
                        <div>
                          预设：{effectivePolicy.injectionPreset ?? '未知'}
                        </div>
                        <div className="mt-1">
                          {effectivePolicy.policySummary ??
                            selectedSummary.policySummary ??
                            '该任务已通过 Mini-Term 策略运行时注入。'}
                        </div>
                      </>
                    ) : (
                      '该任务没有 Mini-Term 注入元数据。'
                    )}
                  </div>
                </div>

                <div className="mb-4">
                  <div className="text-[10px] uppercase tracking-[0.1em] text-[var(--text-muted)]">
                    最近输出
                  </div>
                  <pre className="mt-1 max-h-[320px] overflow-auto whitespace-pre-wrap rounded bg-[var(--bg-elevated)] px-3 py-2 text-[11px] leading-5 text-[var(--text-secondary)]">
                    {selectedTask?.recentOutputExcerpt ||
                      selectedSummary.lastOutputExcerpt ||
                      '暂无输出'}
                  </pre>
                </div>

                <div className="mb-4">
                  <div className="text-[10px] uppercase tracking-[0.1em] text-[var(--text-muted)]">
                    Plan Document
                  </div>
                  {!planArtifact ? (
                    <div className="mt-1 text-[11px] text-[var(--text-muted)]">
                      No saved plan document yet
                    </div>
                  ) : (
                    <div className="mt-1 rounded bg-[var(--bg-elevated)] px-3 py-2 text-[11px] leading-5 text-[var(--text-secondary)]">
                      <div className="font-medium text-[var(--text-primary)]">
                        {planArtifact.title}
                      </div>
                      <div className="mt-1 text-[var(--text-muted)]">
                        Updated {formatRelativeTime(planArtifact.updatedAt)}
                      </div>
                      <div className="mt-1 break-all text-[var(--text-muted)]">
                        {planArtifact.path}
                      </div>
                      <button
                        type="button"
                        className="mt-2 rounded-[var(--radius-sm)] border border-[var(--accent)]/40 bg-[var(--accent-subtle)] px-2.5 py-1 text-[11px] text-[var(--accent)]"
                        onClick={openPlan}
                      >
                        Open Plan Document
                      </button>
                    </div>
                  )}
                </div>

                <div>
                  <div className="text-[10px] uppercase tracking-[0.1em] text-[var(--text-muted)]">
                    变更文件
                  </div>
                  {selectedSummary.changedFiles.length === 0 ? (
                    <div className="mt-1 text-[11px] text-[var(--text-muted)]">
                      没有跟踪到文件变更
                    </div>
                  ) : (
                    <div className="mt-1 space-y-1">
                      {selectedSummary.changedFiles.map((status) => (
                        <button
                          key={`${selectedSummary.taskId}-${status.path}`}
                          type="button"
                          className="flex w-full items-center justify-between rounded border border-[var(--border-default)] px-3 py-2 text-left text-[11px] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                          onClick={() => {
                            setActiveWorkspace(selectedSummary.workspaceId);
                            openWorktreeDiff(
                              selectedSummary.workspaceId,
                              selectedSummary.workspaceRootPath,
                              status,
                            );
                          }}
                        >
                          <span className="truncate">{status.path}</span>
                          <span className="ml-2 shrink-0 text-[10px] text-[var(--text-muted)]">
                            {status.statusLabel}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="border-l border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-4 py-3">
                <div className="text-[10px] uppercase tracking-[0.1em] text-[var(--text-muted)]">
                  任务控制
                </div>

                <div className="mt-3">
                  <div className="mb-1 text-[11px] text-[var(--text-secondary)]">
                    工作区根目录
                  </div>
                  <div className="break-all text-[11px] text-[var(--text-muted)]">
                    {selectedSummary.workspaceRootPath}
                  </div>
                </div>

                <div className="mt-4">
                  <div className="mb-1 text-[11px] text-[var(--text-secondary)]">
                    当前工作目录
                  </div>
                  <div className="break-all text-[11px] text-[var(--text-muted)]">
                    {selectedSummary.cwd}
                  </div>
                </div>

                <div className="mt-4">
                  <div className="mb-1 text-[11px] text-[var(--text-secondary)]">
                    日志路径
                  </div>
                  <div className="break-all text-[11px] text-[var(--text-muted)]">
                    {selectedTask?.logPath || '暂无日志路径'}
                  </div>
                </div>

                <div className="mt-4">
                  <div className="mb-1 text-[11px] text-[var(--text-secondary)]">
                    发送输入
                  </div>
                  {canSendInput ? (
                    <>
                      <textarea
                        value={inputValue}
                        onChange={(event) => setInputValue(event.target.value)}
                        className="min-h-[120px] w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                        placeholder="向运行中的任务发送补充输入..."
                      />
                      <button
                        type="button"
                        className="mt-2 rounded-[var(--radius-sm)] border border-[var(--accent)]/40 bg-[var(--accent-subtle)] px-3 py-1.5 text-[11px] text-[var(--accent)]"
                        onClick={() => void handleSendInput()}
                        disabled={actionState !== 'idle' || !inputValue.trim()}
                      >
                        发送输入
                      </button>
                    </>
                  ) : (
                    <div className="text-[11px] text-[var(--text-muted)]">
                      只有运行中的任务可以发送输入。
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
