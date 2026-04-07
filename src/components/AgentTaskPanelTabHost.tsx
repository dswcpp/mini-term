import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppStore } from "../store";
import {
  closeAgentTask,
  getAgentTaskStatus,
  listAgentBackends,
  listAgentTaskEvents,
  listApprovalRequests,
  listAgentTasks,
  resumeAgentTask,
  sendAgentTaskInput,
  startAgentTask,
  spawnWorkerTask,
} from "../runtime/agentApi";
import { getTaskEffectivePolicy } from "../runtime/agentPolicyApi";
import { normalizeAgentBackends } from "../utils/agentBackends";
import type {
  AgentBackendDescriptor,
  AgentTaskRuntimeEvent,
  AgentTaskSummary,
  AgentTaskPanelTab,
  AgentTaskStatusDetail,
  StartAgentTaskInput,
  TaskAttentionState,
  TaskContextPreset,
  TaskEffectivePolicy,
  TaskTarget,
} from "../types";

interface AgentTaskPanelTabHostProps {
  tab: AgentTaskPanelTab;
  workspaceId: string;
  isActive: boolean;
}

function formatRelativeTime(timestamp: number) {
  if (!timestamp) return "";
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

const ATTENTION_OPTIONS: Array<TaskAttentionState | "all"> = [
  "all",
  "running",
  "waiting-input",
  "needs-review",
  "failed",
  "completed",
];
const PRESET_OPTIONS: TaskContextPreset[] = ["light", "standard", "review"];
const TARGET_OPTIONS: Array<TaskTarget | "all"> = ["all", "codex", "claude"];

function attentionLabel(value: TaskAttentionState | "all") {
  switch (value) {
    case "all":
      return "全部";
    case "running":
      return "运行中";
    case "waiting-input":
      return "等待输入";
    case "needs-review":
      return "待审查";
    case "failed":
      return "失败";
    case "completed":
      return "已完成";
  }
}

function targetLabel(value: TaskTarget | "all") {
  switch (value) {
    case "all":
      return "全部";
    case "codex":
      return "Codex";
    case "claude":
      return "Claude";
  }
}

function roleLabel(role: AgentTaskSummary["role"]) {
  return role === "worker" ? "Worker" : "Coordinator";
}

function backendLabel(
  summary: Pick<AgentTaskSummary, "backendDisplayName" | "target">,
) {
  return (
    summary.backendDisplayName ??
    (summary.target === "codex" ? "Codex CLI" : "Claude CLI")
  );
}

function backendKindLabel(kind: AgentBackendDescriptor["kind"]) {
  return kind === "sidecar" ? "Sidecar" : "Built-in CLI";
}

function backendTransportLabel(transport: AgentBackendDescriptor["transport"]) {
  return transport === "sidecar-rpc" ? "Sidecar RPC" : "PTY Command";
}

function backendRuntimeStatusLabel(status?: AgentBackendDescriptor["status"]) {
  switch (status) {
    case "unconfigured":
      return "未配置";
    case "configured":
      return "已配置";
    case "starting":
      return "启动中";
    case "ready":
      return "就绪";
    case "degraded":
      return "降级";
    case "error":
      return "错误";
    default:
      return "未知";
  }
}

function formatHandshakeTime(timestamp?: number) {
  if (!timestamp) {
    return "尚未握手";
  }
  return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
}

function statusLabel(value: string) {
  switch (value) {
    case "starting":
      return "启动中";
    case "running":
      return "运行中";
    case "waiting-input":
      return "等待输入";
    case "exited":
      return "已退出";
    case "error":
      return "错误";
    default:
      return value;
  }
}

function presetLabel(value: string) {
  switch (value) {
    case "light":
      return "轻量";
    case "standard":
      return "标准";
    case "review":
      return "审查";
    default:
      return value;
  }
}

function defaultBackendForTarget(
  backends: AgentBackendDescriptor[],
  target: TaskTarget,
) {
  return (
    backends.find(
      (backend) => backend.target === target && backend.defaultForTarget,
    ) ??
    backends.find(
      (backend) => backend.target === target && backend.kind === "builtin-cli",
    ) ?? backends.find((backend) => backend.target === target) ?? null
  );
}

function buildBackendContractWarnings(
  backend: AgentBackendDescriptor | null,
): string[] {
  if (!backend) {
    return [];
  }

  const warnings: string[] = [];
  if (!backend.capabilities.supportsResume) {
    warnings.push("该 backend 启动的任务不支持恢复会话。");
  }
  if (!backend.capabilities.supportsWorkers) {
    warnings.push("该 backend 启动的 coordinator 任务不能派生 worker。");
  }
  if (!backend.capabilities.supportsToolCalls) {
    warnings.push("该 backend 未声明工具调用能力，任务执行路径可能受限。");
  }
  if (backend.capabilities.restrictedToolNames.length > 0) {
    warnings.push(
      "该 backend 通过 Mini-Term 代理工具调用，并保留部分任务生命周期工具。",
    );
  }
  return warnings;
}

function sidecarPreflightBlockReason(
  backend: AgentBackendDescriptor | null,
): string | null {
  if (!backend || backend.kind !== "sidecar") {
    return null;
  }
  if (!backend.configured) {
    return backend.statusMessage ?? "当前 sidecar backend 尚未配置。";
  }
  if (backend.available) {
    return null;
  }
  if (backend.status === "configured") {
    return (
      backend.statusMessage ??
      "当前 sidecar backend 已配置，但尚未完成启动/握手测试。"
    );
  }
  return (
    backend.lastError ??
    backend.statusMessage ??
    "当前 sidecar backend 尚未通过预检。"
  );
}

async function findApprovedCloseRequestId(
  taskId: string,
  cascadeChildren: boolean,
): Promise<string | undefined> {
  const approvals = await listApprovalRequests();
  const matching = approvals
    .filter((request) => {
      if (request.toolName !== "close_task" || request.status !== "approved") {
        return false;
      }
      const match = request.payloadPreview.match(/^\s*Task:\s*(.+?)\s*$/m);
      if (match?.[1] !== taskId) {
        return false;
      }
      const requestCascade =
        /^\s*CascadeChildren:\s*true\s*$/im.test(request.payloadPreview);
      return requestCascade === cascadeChildren;
    })
    .sort((left, right) => right.updatedAt - left.updatedAt);
  return matching[0]?.requestId;
}

function formatEventKind(value: string) {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function AgentTaskPanelTabHost({
  tab,
  workspaceId,
  isActive,
}: AgentTaskPanelTabHostProps) {
  const workspaceConfig = useAppStore(
    (state) =>
      state.config.workspaces.find((item) => item.id === workspaceId) ?? null,
  );
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
  const [agentBackends, setAgentBackends] = useState<AgentBackendDescriptor[]>(
    [],
  );
  const [selectedTask, setSelectedTask] =
    useState<AgentTaskStatusDetail | null>(null);
  const [effectivePolicy, setEffectivePolicy] =
    useState<TaskEffectivePolicy | null>(null);
  const [taskEvents, setTaskEvents] = useState<AgentTaskRuntimeEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [backendRegistryError, setBackendRegistryError] = useState<
    string | null
  >(null);
  const [createTarget, setCreateTarget] = useState<TaskTarget>("codex");
  const [createContextPreset, setCreateContextPreset] =
    useState<TaskContextPreset>("standard");
  const [createBackendId, setCreateBackendId] = useState("");
  const [createTitle, setCreateTitle] = useState("");
  const [createPrompt, setCreatePrompt] = useState("");
  const [createCwd, setCreateCwd] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [approvalNotice, setApprovalNotice] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [workerPrompt, setWorkerPrompt] = useState("");
  const [workerTitle, setWorkerTitle] = useState("");
  const [actionState, setActionState] = useState<
    "idle" | "starting" | "sending" | "closing" | "resuming" | "spawning"
  >("idle");

  const refreshTasks = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listAgentTasks();
      setTasks(result);
      setError(null);
    } catch {
      setError("加载任务列表失败");
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshAgentBackends = useCallback(async () => {
    try {
      const result = await listAgentBackends();
      setAgentBackends(normalizeAgentBackends(result));
      setBackendRegistryError(null);
    } catch {
      setAgentBackends([]);
      setBackendRegistryError("加载 backend 契约失败");
    }
  }, []);

  const refreshSelectedTask = useCallback(async (taskId: string) => {
    setDetailLoading(true);
    try {
      const loadTaskSnapshot = async (currentTaskId: string) =>
        Promise.all([
          getAgentTaskStatus(currentTaskId),
          getTaskEffectivePolicy(currentTaskId),
          listAgentTaskEvents(currentTaskId, 30, true),
        ]);

      let resolvedTaskId = taskId;
      let [detail, policy, events] = await loadTaskSnapshot(resolvedTaskId);
      let redirectCount = 0;

      while (
        detail.summary.retrySuperseded &&
        detail.summary.supersededByTaskId &&
        detail.summary.supersededByTaskId !== resolvedTaskId &&
        redirectCount < 4
      ) {
        resolvedTaskId = detail.summary.supersededByTaskId;
        [detail, policy, events] = await loadTaskSnapshot(resolvedTaskId);
        redirectCount += 1;
      }

      if (resolvedTaskId !== taskId) {
        setAgentTaskPanelSelection(workspaceId, tab.id, resolvedTaskId);
      }

      setSelectedTask(detail);
      setEffectivePolicy(policy);
      setTaskEvents(events);
      setDetailError(null);
    } catch {
      setSelectedTask(null);
      setEffectivePolicy(null);
      setTaskEvents([]);
      setDetailError("加载任务详情失败");
    } finally {
      setDetailLoading(false);
    }
  }, [setAgentTaskPanelSelection, tab.id, workspaceId]);

  useEffect(() => {
    if (!isActive) {
      return;
    }

    const refresh = () => {
      void refreshAgentBackends();
      void refreshTasks();
      if (tab.selectedTaskId) {
        void refreshSelectedTask(tab.selectedTaskId);
      }
    };

    refresh();
    const timer = window.setInterval(refresh, 8_000);
    return () => window.clearInterval(timer);
  }, [
    isActive,
    refreshAgentBackends,
    refreshSelectedTask,
    refreshTasks,
    tab.selectedTaskId,
  ]);

  useEffect(() => {
    if (!tab.selectedTaskId) {
      setSelectedTask(null);
      setEffectivePolicy(null);
      setTaskEvents([]);
      setWorkerPrompt("");
      setWorkerTitle("");
      return;
    }
    if (selectedTask && selectedTask.summary.taskId !== tab.selectedTaskId) {
      setSelectedTask(null);
      setEffectivePolicy(null);
      setTaskEvents([]);
      setWorkerPrompt("");
      setWorkerTitle("");
    }
  }, [selectedTask, tab.selectedTaskId]);

  const workspaceRootPath = useMemo(() => {
    const primaryRoot =
      workspaceConfig?.roots.find((root) => root.role === "primary") ??
      workspaceConfig?.roots[0];
    return primaryRoot?.path ?? "";
  }, [workspaceConfig]);

  useEffect(() => {
    setCreateCwd(workspaceRootPath);
  }, [workspaceRootPath]);

  useEffect(() => {
    if (agentBackends.length === 0) {
      return;
    }
    if (!agentBackends.some((backend) => backend.target === createTarget)) {
      setCreateTarget(agentBackends[0].target);
    }
  }, [agentBackends, createTarget]);

  const visibleTasks = useMemo(() => {
    return tasks.filter((item) => {
      const matchesScope =
        tab.filter.scope === "all" || item.summary.workspaceId === workspaceId;
      const matchesAttention =
        !tab.filter.attention ||
        tab.filter.attention === "all" ||
        item.summary.attentionState === tab.filter.attention;
      const matchesTarget =
        !tab.filter.target ||
        tab.filter.target === "all" ||
        item.summary.target === tab.filter.target;
      return matchesScope && matchesAttention && matchesTarget;
    });
  }, [
    tab.filter.attention,
    tab.filter.scope,
    tab.filter.target,
    tasks,
    workspaceId,
  ]);

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
    const artifact = selectedTask?.artifacts.find(
      (item) => item.kind === "plan",
    );
    if (!selectedTask || !artifact) {
      return;
    }
    setActiveWorkspace(selectedTask.summary.workspaceId);
    openFileViewer(selectedTask.summary.workspaceId, artifact.path, {
      initialMode: "preview",
    });
  }, [openFileViewer, selectedTask, setActiveWorkspace]);

  const handleSendInput = useCallback(async () => {
    if (!selectedTask || !inputValue.trim()) {
      return;
    }
    setActionState("sending");
    try {
      await sendAgentTaskInput(selectedTask.summary.taskId, inputValue.trim());
      setInputValue("");
      await refreshTasks();
      await refreshSelectedTask(selectedTask.summary.taskId);
    } catch {
      setDetailError("发送任务输入失败");
    } finally {
      setActionState("idle");
    }
  }, [inputValue, refreshSelectedTask, refreshTasks, selectedTask]);

  const handleCloseTask = useCallback(async (cascadeChildren = false) => {
    if (!selectedTask) {
      return;
    }
    setActionState("closing");
    try {
      const approvalRequestId = await findApprovedCloseRequestId(
        selectedTask.summary.taskId,
        cascadeChildren,
      );
      const result = approvalRequestId
        ? await closeAgentTask(
            selectedTask.summary.taskId,
            approvalRequestId,
            cascadeChildren,
          )
        : await closeAgentTask(
            selectedTask.summary.taskId,
            undefined,
            cascadeChildren,
          );
      if (result.ok) {
        setApprovalNotice(null);
        await refreshTasks();
        await refreshSelectedTask(selectedTask.summary.taskId);
        setDetailError(null);
      } else if (result.approvalRequired) {
        setApprovalNotice("已创建关闭审批，请先在 Inbox 中批准后再重试。");
        setDetailError(null);
      } else {
        setDetailError("关闭任务失败");
      }
    } catch {
      setDetailError("关闭任务失败");
    } finally {
      setActionState("idle");
    }
  }, [refreshSelectedTask, refreshTasks, selectedTask]);

  const handleSpawnWorker = useCallback(async () => {
    if (!selectedTask || !workerPrompt.trim()) {
      return;
    }
    setActionState("spawning");
    try {
      const worker = await spawnWorkerTask({
        parentTaskId: selectedTask.summary.taskId,
        prompt: workerPrompt.trim(),
        title: workerTitle.trim() || undefined,
      });
      setApprovalNotice(null);
      setDetailError(null);
      setWorkerPrompt("");
      setWorkerTitle("");
      await refreshTasks();
      setAgentTaskPanelSelection(workspaceId, tab.id, worker.taskId);
      await refreshSelectedTask(worker.taskId);
    } catch {
      setDetailError("Failed to spawn worker task");
    } finally {
      setActionState("idle");
    }
  }, [
    refreshSelectedTask,
    refreshTasks,
    selectedTask,
    setAgentTaskPanelSelection,
    tab.id,
    workerPrompt,
    workerTitle,
    workspaceId,
  ]);

  const handleResumeTask = useCallback(async () => {
    if (!selectedTask) {
      return;
    }
    setActionState("resuming");
    try {
      await resumeAgentTask(selectedTask.summary.taskId);
      await refreshTasks();
      await refreshSelectedTask(selectedTask.summary.taskId);
      setApprovalNotice(null);
      setDetailError(null);
    } catch {
      setDetailError("恢复会话失败");
    } finally {
      setActionState("idle");
    }
  }, [refreshSelectedTask, refreshTasks, selectedTask]);

  const createBackendOptions = useMemo(
    () => agentBackends.filter((backend) => backend.target === createTarget),
    [agentBackends, createTarget],
  );
  const fallbackCreateBackend = useMemo(
    () => defaultBackendForTarget(agentBackends, createTarget),
    [agentBackends, createTarget],
  );
  const selectedCreateBackend =
    createBackendOptions.find((backend) => backend.backendId === createBackendId) ??
    fallbackCreateBackend;
  const createBackendWarnings = useMemo(
    () => buildBackendContractWarnings(selectedCreateBackend),
    [selectedCreateBackend],
  );
  const createBackendPreflightBlock = useMemo(
    () => sidecarPreflightBlockReason(selectedCreateBackend),
    [selectedCreateBackend],
  );

  useEffect(() => {
    const hasSelectedBackend = createBackendOptions.some(
      (backend) => backend.backendId === createBackendId,
    );
    if (hasSelectedBackend) {
      return;
    }
    setCreateBackendId(selectedCreateBackend?.backendId ?? "");
  }, [createBackendId, createBackendOptions, selectedCreateBackend]);

  const handleStartTask = useCallback(async () => {
    if (!createPrompt.trim()) {
      setCreateError("请输入任务说明。");
      return;
    }
    if (!selectedCreateBackend) {
      setCreateError("当前目标没有可用 backend。");
      return;
    }

    if (createBackendPreflightBlock) {
      setCreateError(createBackendPreflightBlock);
      return;
    }

    setActionState("starting");
    try {
      const filterPatch: Partial<AgentTaskPanelTab["filter"]> = {};
      if (
        tab.filter.attention &&
        tab.filter.attention !== "all" &&
        tab.filter.attention !== "running"
      ) {
        filterPatch.attention = "all";
      }
      if (
        tab.filter.target &&
        tab.filter.target !== "all" &&
        tab.filter.target !== createTarget
      ) {
        filterPatch.target = createTarget;
      }
      if (Object.keys(filterPatch).length > 0) {
        setAgentTaskPanelFilter(workspaceId, tab.id, filterPatch);
      }

      const input: StartAgentTaskInput = {
        workspaceId,
        target: createTarget,
        prompt: createPrompt.trim(),
        contextPreset: createContextPreset,
        backendId: selectedCreateBackend.backendId,
        cwd: createCwd.trim() || undefined,
        title: createTitle.trim() || undefined,
      };
      const startedTask = await startAgentTask(input);

      setApprovalNotice(null);
      setCreateError(null);
      setDetailError(null);
      setCreatePrompt("");
      setCreateTitle("");
      await refreshTasks();
      setAgentTaskPanelSelection(workspaceId, tab.id, startedTask.taskId);
      await refreshSelectedTask(startedTask.taskId);
    } catch (cause) {
      setCreateError(
        cause instanceof Error ? cause.message : "启动任务失败",
      );
    } finally {
      setActionState("idle");
    }
  }, [
    createContextPreset,
    createCwd,
    createPrompt,
    createTarget,
    createTitle,
    createBackendPreflightBlock,
    refreshSelectedTask,
    refreshTasks,
    selectedCreateBackend,
    setAgentTaskPanelFilter,
    setAgentTaskPanelSelection,
    tab.filter.attention,
    tab.filter.target,
    tab.id,
    workspaceId,
  ]);

  const selectedSummary =
    visibleTasks.find((item) => item.summary.taskId === tab.selectedTaskId)
      ?.summary ??
    (selectedTask && selectedTask.summary.taskId === tab.selectedTaskId
      ? selectedTask.summary
      : null);
  const parentSummary = selectedSummary?.parentTaskId
    ? tasks.find((item) => item.summary.taskId === selectedSummary.parentTaskId)
        ?.summary
    : null;
  const childTaskSummaries = selectedSummary
    ? tasks
        .filter((item) => item.summary.parentTaskId === selectedSummary.taskId)
        .map((item) => item.summary)
    : [];
  const planArtifact = selectedTask?.artifacts.find(
    (artifact) => artifact.kind === "plan",
  );
  const canSendInput = selectedSummary?.status === "running";
  const selectedBackend = selectedSummary
    ? agentBackends.find(
        (backend) => backend.backendId === selectedSummary.backendId,
      ) ??
      (!selectedSummary.backendId
        ? defaultBackendForTarget(agentBackends, selectedSummary.target)
        : null)
    : null;
  const selectedBackendPreflightBlock = sidecarPreflightBlockReason(selectedBackend);
  const resumeSupported = selectedBackend?.capabilities.supportsResume ?? true;
  const workersSupported = selectedBackend?.capabilities.supportsWorkers ?? true;
  const canSpawnWorker =
    selectedSummary?.role === "coordinator" && workersSupported;
  const workerBlockReason =
    selectedSummary?.role !== "coordinator"
      ? "只有 coordinator 任务可以派生 worker。"
      : !workersSupported
        ? "当前 backend 未声明 worker 能力，无法从该任务派生 worker。"
        : null;
  const resumeBlockReason = !resumeSupported
    ? "当前 backend 未声明恢复会话能力。"
    : null;

  return (
    <div className="flex h-full bg-[var(--bg-terminal)] text-[var(--text-primary)]">
      <div className="flex w-[320px] shrink-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-elevated)]">
        <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-3 py-2">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
              任务
            </div>
            <div className="mt-0.5 text-[11px] text-[var(--text-secondary)]">
              {tab.filter.scope === "all" ? "全部工作区" : "当前工作区"}
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

        <div className="border-b border-[var(--border-subtle)] px-3 py-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--text-muted)]">
              启动任务
            </div>
            <div className="truncate text-[10px] text-[var(--text-muted)]">
              {workspaceConfig?.name ?? workspaceId}
            </div>
          </div>
          <div className="mt-1 text-[11px] text-[var(--text-muted)]">
            默认工作目录：
            {workspaceRootPath || "未检测到工作区根目录"}
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-[10px] uppercase tracking-[0.08em] text-[var(--text-muted)]">
              目标
              <select
                aria-label="新任务目标"
                className="rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 py-1 text-[11px] text-[var(--text-primary)]"
                value={createTarget}
                onChange={(event) =>
                  setCreateTarget(event.target.value as TaskTarget)
                }
              >
                {TARGET_OPTIONS.filter((option) => option !== "all").map(
                  (option) => (
                    <option key={option} value={option}>
                      {targetLabel(option)}
                    </option>
                  ),
                )}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-[10px] uppercase tracking-[0.08em] text-[var(--text-muted)]">
              预设
              <select
                aria-label="新任务预设"
                className="rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 py-1 text-[11px] text-[var(--text-primary)]"
                value={createContextPreset}
                onChange={(event) =>
                  setCreateContextPreset(
                    event.target.value as TaskContextPreset,
                  )
                }
              >
                {PRESET_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {presetLabel(option)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="mt-2 flex flex-col gap-1 text-[10px] uppercase tracking-[0.08em] text-[var(--text-muted)]">
            Backend
            <select
              aria-label="新任务 Backend"
              className="rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 py-1 text-[11px] text-[var(--text-primary)]"
              value={createBackendId}
              onChange={(event) => setCreateBackendId(event.target.value)}
              disabled={createBackendOptions.length === 0}
            >
              {createBackendOptions.length === 0 ? (
                <option value="">当前目标没有可用 backend</option>
              ) : (
                createBackendOptions.map((backend) => (
                  <option key={backend.backendId} value={backend.backendId}>
                    {backend.displayName}
                    {backend.defaultForTarget ? " (default)" : ""}
                  </option>
                ))
              )}
            </select>
          </label>

          {backendRegistryError ? (
            <div className="mt-2 rounded border border-[var(--color-danger)]/30 px-2 py-2 text-[11px] text-[var(--color-danger)]">
              {backendRegistryError}
            </div>
          ) : selectedCreateBackend ? (
            <div className="mt-2 space-y-2 rounded border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 py-2 text-[11px] text-[var(--text-muted)]">
              <div className="font-medium text-[var(--text-primary)]">
                {selectedCreateBackend.displayName}
              </div>
              <div>
                {backendKindLabel(selectedCreateBackend.kind)} |{" "}
                {backendTransportLabel(selectedCreateBackend.transport)}
              </div>
              <div>
                Status: {backendRuntimeStatusLabel(selectedCreateBackend.status)} | Configured:{" "}
                {selectedCreateBackend.configured ? "yes" : "no"} | Available:{" "}
                {selectedCreateBackend.available ? "yes" : "no"}
              </div>
              <div>
                Last Handshake: {formatHandshakeTime(selectedCreateBackend.lastHandshakeAt)}
              </div>
              {selectedCreateBackend.routingStatusMessage ? (
                <div>{selectedCreateBackend.routingStatusMessage}</div>
              ) : null}
              {selectedCreateBackend.statusMessage ? (
                <div>{selectedCreateBackend.statusMessage}</div>
              ) : null}
              {selectedCreateBackend.lastError ? (
                <div className="text-[var(--color-danger)]">
                  Last error: {selectedCreateBackend.lastError}
                </div>
              ) : null}
              <div className="flex flex-wrap gap-1">
                <span className="rounded-full border border-[var(--border-subtle)] px-2 py-0.5 text-[10px]">
                  {selectedCreateBackend.capabilities.supportsWorkers
                    ? "Workers"
                    : "No Workers"}
                </span>
                <span className="rounded-full border border-[var(--border-subtle)] px-2 py-0.5 text-[10px]">
                  {selectedCreateBackend.capabilities.supportsResume
                    ? "Resume"
                    : "No Resume"}
                </span>
                <span className="rounded-full border border-[var(--border-subtle)] px-2 py-0.5 text-[10px]">
                  {selectedCreateBackend.capabilities.supportsToolCalls
                    ? "Tool Calls"
                    : "No Tool Calls"}
                </span>
              </div>
              {createBackendWarnings.map((warning) => (
                <div key={warning}>{warning}</div>
              ))}
              {selectedCreateBackend.capabilities.toolCallAuthority ? (
                <div>
                  Tool authority:{" "}
                  {selectedCreateBackend.capabilities.toolCallAuthority}
                </div>
              ) : null}
              {selectedCreateBackend.capabilities.approvalFlowNotes ? (
                <div>{selectedCreateBackend.capabilities.approvalFlowNotes}</div>
              ) : null}
              {selectedCreateBackend.capabilities.restrictedToolNames.length >
              0 ? (
                <div className="flex flex-wrap gap-1">
                  {selectedCreateBackend.capabilities.restrictedToolNames.map(
                    (toolName) => (
                      <span
                        key={`${selectedCreateBackend.backendId}-${toolName}`}
                        className="rounded-full border border-[var(--border-subtle)] px-2 py-0.5 text-[10px]"
                      >
                        {toolName}
                      </span>
                    ),
                  )}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="mt-2 rounded border border-[var(--border-default)] px-2 py-2 text-[11px] text-[var(--text-muted)]">
              当前目标没有可用 backend。
            </div>
          )}

          <input
            aria-label="新任务标题"
            value={createTitle}
            onChange={(event) => setCreateTitle(event.target.value)}
            className="mt-2 w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            placeholder="可选标题"
          />
          <input
            aria-label="新任务工作目录"
            value={createCwd}
            onChange={(event) => setCreateCwd(event.target.value)}
            className="mt-2 w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            placeholder="工作目录（默认当前工作区根目录）"
          />
          <textarea
            aria-label="新任务说明"
            value={createPrompt}
            onChange={(event) => setCreatePrompt(event.target.value)}
            className="mt-2 min-h-[120px] w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            placeholder="描述你要启动的任务..."
          />
          {createBackendPreflightBlock ? (
            <div className="mt-2 text-[11px] text-[var(--color-danger)]">
              {createBackendPreflightBlock}
            </div>
          ) : null}
          {createError ? (
            <div className="mt-2 text-[11px] text-[var(--color-danger)]">
              {createError}
            </div>
          ) : null}
          <button
            type="button"
            className="mt-2 rounded-[var(--radius-sm)] border border-[var(--accent)]/40 bg-[var(--accent-subtle)] px-3 py-1.5 text-[11px] text-[var(--accent)]"
            onClick={() => void handleStartTask()}
            disabled={
              actionState !== "idle" ||
              !createPrompt.trim() ||
              !selectedCreateBackend ||
              !!createBackendPreflightBlock
            }
          >
            启动任务
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
                  scope: event.target
                    .value as AgentTaskPanelTab["filter"]["scope"],
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
              value={tab.filter.attention ?? "all"}
              onChange={(event) =>
                setAgentTaskPanelFilter(workspaceId, tab.id, {
                  attention: event.target.value as TaskAttentionState | "all",
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
              value={tab.filter.target ?? "all"}
              onChange={(event) =>
                setAgentTaskPanelFilter(workspaceId, tab.id, {
                  target: event.target.value as TaskTarget | "all",
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
                    ? "bg-[var(--accent-subtle)]/30"
                    : "hover:bg-[var(--bg-surface)]"
                }`}
                onClick={() =>
                  setAgentTaskPanelSelection(
                    workspaceId,
                    tab.id,
                    summary.taskId,
                  )
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
                  {backendLabel(summary)} | {roleLabel(summary.role)} |{" "}
                  {summary.workspaceName}
                </div>
                <div className="line-clamp-2 text-[11px] text-[var(--text-muted)]">
                  {summary.lastOutputExcerpt || summary.promptPreview}
                </div>
                {summary.parentTaskId ? (
                  <div className="text-[10px] text-[var(--text-muted)]">
                    Parent {summary.parentTaskId}
                  </div>
                ) : null}
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
            左侧可启动新任务，或选择已有任务查看详情
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
                    <span>{backendLabel(selectedSummary)}</span>
                    <span>{roleLabel(selectedSummary.role)}</span>
                    <span>{selectedSummary.workspaceName}</span>
                    <span>{statusLabel(selectedSummary.status)}</span>
                    <span>
                      {attentionLabel(selectedSummary.attentionState)}
                    </span>
                    <span>{presetLabel(selectedSummary.contextPreset)}</span>
                    {selectedSummary.parentTaskId ? (
                      <span>Parent {selectedSummary.parentTaskId}</span>
                    ) : null}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    className="rounded-[var(--radius-sm)] border border-[var(--border-default)] px-2.5 py-1 text-[11px] text-[var(--text-secondary)]"
                    onClick={() => void handleResumeTask()}
                    disabled={actionState !== "idle" || !resumeSupported}
                    title={resumeBlockReason ?? undefined}
                  >
                    恢复会话
                  </button>
                  <button
                    type="button"
                    className="rounded-[var(--radius-sm)] border border-[var(--border-default)] px-2.5 py-1 text-[11px] text-[var(--text-secondary)]"
                    onClick={() => void handleCloseTask(false)}
                    disabled={actionState !== "idle"}
                  >
                    关闭任务
                  </button>
                  {childTaskSummaries.length > 0 ? (
                    <button
                      type="button"
                      className="rounded-[var(--radius-sm)] border border-[var(--border-default)] px-2.5 py-1 text-[11px] text-[var(--text-secondary)]"
                      onClick={() => void handleCloseTask(true)}
                      disabled={actionState !== "idle"}
                    >
                      Close + Children
                    </button>
                  ) : null}
                  {selectedSummary.attentionState === "needs-review" &&
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
                    {selectedSummary.promptPreview || "暂无提示词预览"}
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
                          配置：{effectivePolicy.injectionProfileId ?? "未知"}
                        </div>
                        <div>
                          预设：{effectivePolicy.injectionPreset ?? "未知"}
                        </div>
                        <div className="mt-1">
                          {effectivePolicy.policySummary ??
                            selectedSummary.policySummary ??
                            "该任务已通过 Mini-Term 策略运行时注入。"}
                        </div>
                      </>
                    ) : (
                      "该任务没有 Mini-Term 注入元数据。"
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
                      "暂无输出"}
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

                <div className="mb-4">
                  <div className="text-[10px] uppercase tracking-[0.1em] text-[var(--text-muted)]">
                    Task Graph
                  </div>
                  <div className="mt-1 space-y-2 rounded bg-[var(--bg-elevated)] px-3 py-2 text-[11px] leading-5 text-[var(--text-secondary)]">
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-muted)]">
                        Parent
                      </div>
                      {!parentSummary ? (
                        <div className="mt-1 text-[var(--text-muted)]">
                          No parent task
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="mt-1 flex w-full items-center justify-between rounded border border-[var(--border-default)] px-2 py-1 text-left hover:border-[var(--accent)] hover:text-[var(--accent)]"
                          onClick={() =>
                            setAgentTaskPanelSelection(
                              workspaceId,
                              tab.id,
                              parentSummary.taskId,
                            )
                          }
                        >
                          <span className="truncate">{parentSummary.title}</span>
                          <span className="ml-2 shrink-0 text-[10px] text-[var(--text-muted)]">
                            {roleLabel(parentSummary.role)}
                          </span>
                        </button>
                      )}
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-muted)]">
                        Children
                      </div>
                      {childTaskSummaries.length === 0 ? (
                        <div className="mt-1 text-[var(--text-muted)]">
                          No child tasks
                        </div>
                      ) : (
                        <div className="mt-1 space-y-1">
                          {childTaskSummaries.map((childSummary) => (
                            <button
                              key={childSummary.taskId}
                              type="button"
                              className="flex w-full items-center justify-between rounded border border-[var(--border-default)] px-2 py-1 text-left hover:border-[var(--accent)] hover:text-[var(--accent)]"
                              onClick={() =>
                                setAgentTaskPanelSelection(
                                  workspaceId,
                                  tab.id,
                                  childSummary.taskId,
                                )
                              }
                            >
                              <span className="truncate">{childSummary.title}</span>
                              <span className="ml-2 shrink-0 text-[10px] text-[var(--text-muted)]">
                                {statusLabel(childSummary.status)}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="mb-4">
                  <div className="text-[10px] uppercase tracking-[0.1em] text-[var(--text-muted)]">
                    Timeline
                  </div>
                  {taskEvents.length === 0 ? (
                    <div className="mt-1 text-[11px] text-[var(--text-muted)]">
                      No runtime events yet
                    </div>
                  ) : (
                    <div className="mt-1 space-y-1">
                      {taskEvents.map((event) => (
                        <div
                          key={event.eventId}
                          className="rounded border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-2"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="text-[11px] font-medium text-[var(--text-primary)]">
                              {formatEventKind(event.kind)}
                            </div>
                            <div className="shrink-0 text-[10px] text-[var(--text-muted)]">
                              {formatRelativeTime(event.timestamp)}
                            </div>
                          </div>
                          <div className="mt-1 text-[11px] text-[var(--text-secondary)]">
                            {event.summary}
                          </div>
                        </div>
                      ))}
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
                    Backend
                  </div>
                  <div className="break-all text-[11px] text-[var(--text-muted)]">
                    {backendLabel(selectedSummary)}
                  </div>
                </div>

                <div className="mt-4">
                  <div className="mb-1 text-[11px] text-[var(--text-secondary)]">
                    Backend Contract
                  </div>
                  {backendRegistryError ? (
                    <div className="rounded border border-[var(--color-danger)]/30 px-2 py-2 text-[11px] text-[var(--color-danger)]">
                      {backendRegistryError}
                    </div>
                  ) : selectedBackend ? (
                    <div className="space-y-2 rounded border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 py-2 text-[11px] text-[var(--text-muted)]">
                      <div>
                        {backendKindLabel(selectedBackend.kind)} |{" "}
                        {backendTransportLabel(selectedBackend.transport)}
                      </div>
                      <div>
                        Status: {backendRuntimeStatusLabel(selectedBackend.status)} | Configured:{" "}
                        {selectedBackend.configured ? "yes" : "no"} | Available:{" "}
                        {selectedBackend.available ? "yes" : "no"}
                      </div>
                      <div>
                        Last Handshake: {formatHandshakeTime(selectedBackend.lastHandshakeAt)}
                      </div>
                      {selectedBackend.routingStatusMessage ? (
                        <div>{selectedBackend.routingStatusMessage}</div>
                      ) : null}
                      {selectedBackend.statusMessage ? (
                        <div>{selectedBackend.statusMessage}</div>
                      ) : null}
                      {selectedBackend.lastError ? (
                        <div className="text-[var(--color-danger)]">
                          Last error: {selectedBackend.lastError}
                        </div>
                      ) : null}
                      <div className="flex flex-wrap gap-1">
                        <span className="rounded-full border border-[var(--border-subtle)] px-2 py-0.5 text-[10px]">
                          {selectedBackend.capabilities.supportsWorkers
                            ? "Workers"
                            : "No Workers"}
                        </span>
                        <span className="rounded-full border border-[var(--border-subtle)] px-2 py-0.5 text-[10px]">
                          {selectedBackend.capabilities.supportsResume
                            ? "Resume"
                            : "No Resume"}
                        </span>
                        <span className="rounded-full border border-[var(--border-subtle)] px-2 py-0.5 text-[10px]">
                          {selectedBackend.capabilities.supportsToolCalls
                            ? "Tool Calls"
                            : "No Tool Calls"}
                        </span>
                        <span className="rounded-full border border-[var(--border-subtle)] px-2 py-0.5 text-[10px]">
                          {selectedBackend.capabilities.brokeredApprovals
                            ? "Brokered Approvals"
                            : "Direct Approvals"}
                        </span>
                      </div>
                      {selectedBackend.capabilities.toolCallAuthority ? (
                        <div>
                          Tool authority:{" "}
                          {selectedBackend.capabilities.toolCallAuthority}
                        </div>
                      ) : null}
                      {selectedBackend.capabilities.toolCallNotes ? (
                        <div>{selectedBackend.capabilities.toolCallNotes}</div>
                      ) : null}
                      {selectedBackend.capabilities.approvalFlowNotes ? (
                        <div>{selectedBackend.capabilities.approvalFlowNotes}</div>
                      ) : null}
                      {selectedBackend.capabilities.restrictedToolNames.length >
                      0 ? (
                        <div>
                          <div className="mb-1 text-[10px] uppercase tracking-[0.08em] text-[var(--text-secondary)]">
                            Reserved tools
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {selectedBackend.capabilities.restrictedToolNames.map(
                              (toolName) => (
                                <span
                                  key={`${selectedBackend.backendId}-${toolName}`}
                                  className="rounded-full border border-[var(--border-subtle)] px-2 py-0.5 text-[10px]"
                                >
                                  {toolName}
                                </span>
                              ),
                            )}
                          </div>
                        </div>
                      ) : null}
                      {selectedBackendPreflightBlock ? (
                        <div className="rounded border border-[var(--color-danger)]/30 px-2 py-2 text-[11px] text-[var(--color-danger)]">
                          {selectedBackendPreflightBlock}
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="rounded border border-[var(--border-default)] px-2 py-2 text-[11px] text-[var(--text-muted)]">
                      {selectedSummary.backendId
                        ? `未找到 backend 描述：${selectedSummary.backendId}`
                        : "当前任务没有 backend 描述元数据。"}
                    </div>
                  )}
                </div>

                <div className="mt-4">
                  <div className="mb-1 text-[11px] text-[var(--text-secondary)]">
                    Role
                  </div>
                  <div className="break-all text-[11px] text-[var(--text-muted)]">
                    {roleLabel(selectedSummary.role)}
                  </div>
                  {resumeBlockReason ? (
                    <div className="mt-2 text-[11px] text-[var(--text-muted)]">
                      {resumeBlockReason}
                    </div>
                  ) : null}
                </div>

                {selectedSummary.parentTaskId ? (
                  <div className="mt-4">
                    <div className="mb-1 text-[11px] text-[var(--text-secondary)]">
                      Parent Task
                    </div>
                    {parentSummary ? (
                      <button
                        type="button"
                        className="w-full rounded border border-[var(--border-default)] px-2 py-1 text-left text-[11px] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                        onClick={() =>
                          setAgentTaskPanelSelection(
                            workspaceId,
                            tab.id,
                            parentSummary.taskId,
                          )
                        }
                      >
                        {parentSummary.title}
                      </button>
                    ) : (
                      <div className="break-all text-[11px] text-[var(--text-muted)]">
                        {selectedSummary.parentTaskId}
                      </div>
                    )}
                  </div>
                ) : null}

                <div className="mt-4">
                  <div className="mb-1 text-[11px] text-[var(--text-secondary)]">
                    Child Tasks
                  </div>
                  <div className="break-all text-[11px] text-[var(--text-muted)]">
                    {childTaskSummaries.length}
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
                    {selectedTask?.logPath || "暂无日志路径"}
                  </div>
                </div>

                <div className="mt-4">
                  <div className="mb-1 text-[11px] text-[var(--text-secondary)]">
                    发送输入
                  </div>
                  <div className="mb-1 text-[11px] text-[var(--text-secondary)]">
                    Spawn Worker
                  </div>
                  {canSpawnWorker ? (
                    <>
                      <input
                        value={workerTitle}
                        onChange={(event) => setWorkerTitle(event.target.value)}
                        className="mb-2 w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                        placeholder="Optional worker title"
                      />
                      <textarea
                        value={workerPrompt}
                        onChange={(event) => setWorkerPrompt(event.target.value)}
                        className="min-h-[120px] w-full rounded-[var(--radius-sm)] border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                        placeholder="Describe the worker task..."
                      />
                      <button
                        type="button"
                        className="mt-2 rounded-[var(--radius-sm)] border border-[var(--accent)]/40 bg-[var(--accent-subtle)] px-3 py-1.5 text-[11px] text-[var(--accent)]"
                        onClick={() => void handleSpawnWorker()}
                        disabled={actionState !== "idle" || !workerPrompt.trim()}
                      >
                        Spawn Worker
                      </button>
                    </>
                  ) : (
                    <div className="text-[11px] text-[var(--text-muted)]">
                      {workerBlockReason ?? "当前无法派生 worker。"}
                    </div>
                  )}

                  <div className="mt-4 mb-1 text-[11px] text-[var(--text-secondary)]">
                    Send Input
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
                        disabled={actionState !== "idle" || !inputValue.trim()}
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
