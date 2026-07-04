import type {
  AiCompletionNotification,
  AppConfig,
  CcConnectStatus,
  OverviewProjectSummary,
  OverviewTotals,
  PaneStatus,
  ProjectState,
  SplitNode,
  WorkspaceOverviewState,
} from '../types';
import { normalizeCcConnectConfig } from './ccConnectConfig';
import { listCcConnectProjects } from './ccConnectApi';
import { getVcsStatus } from './vcsApi';

const DEFAULT_CC_CONNECT_PORT = 9820;
const GIT_CONCURRENCY = 3;

const STATUS_PRIORITY: Record<PaneStatus, number> = {
  error: 3,
  'ai-working': 2,
  'ai-idle': 1,
  idle: 0,
};

interface PaneMetrics {
  paneCount: number;
  aiWorkingCount: number;
  status: PaneStatus;
}

interface ProjectRuntimeMetrics {
  tabCount: number;
  paneCount: number;
  aiWorkingCount: number;
  status: PaneStatus;
}

interface GitSummary {
  projectId: string;
  changeCount: number;
  error?: string;
}

export interface WorkspaceOverviewInput {
  config: AppConfig;
  projectStates: Map<string, ProjectState>;
  notifications: AiCompletionNotification[];
  ccConnectStatus: CcConnectStatus | null;
}

function mergeStatus(a: PaneStatus, b: PaneStatus): PaneStatus {
  return STATUS_PRIORITY[b] > STATUS_PRIORITY[a] ? b : a;
}

function getPaneMetrics(node: SplitNode): PaneMetrics {
  if (node.type === 'leaf') {
    return node.panes.reduce<PaneMetrics>(
      (acc, pane) => ({
        paneCount: acc.paneCount + 1,
        aiWorkingCount: acc.aiWorkingCount + (pane.status === 'ai-working' ? 1 : 0),
        status: mergeStatus(acc.status, pane.status),
      }),
      { paneCount: 0, aiWorkingCount: 0, status: 'idle' },
    );
  }

  return node.children.reduce<PaneMetrics>((acc, child) => {
    const childMetrics = getPaneMetrics(child);
    return {
      paneCount: acc.paneCount + childMetrics.paneCount,
      aiWorkingCount: acc.aiWorkingCount + childMetrics.aiWorkingCount,
      status: mergeStatus(acc.status, childMetrics.status),
    };
  }, { paneCount: 0, aiWorkingCount: 0, status: 'idle' });
}

function getProjectRuntimeMetrics(state: ProjectState | undefined): ProjectRuntimeMetrics {
  if (!state || state.tabs.length === 0) {
    return { tabCount: 0, paneCount: 0, aiWorkingCount: 0, status: 'idle' };
  }

  return state.tabs.reduce<ProjectRuntimeMetrics>((acc, tab) => {
    const metrics = getPaneMetrics(tab.splitLayout);
    return {
      tabCount: acc.tabCount + 1,
      paneCount: acc.paneCount + metrics.paneCount,
      aiWorkingCount: acc.aiWorkingCount + metrics.aiWorkingCount,
      status: mergeStatus(acc.status, metrics.status),
    };
  }, { tabCount: 0, paneCount: 0, aiWorkingCount: 0, status: 'idle' });
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

async function loadGitSummaries(config: AppConfig): Promise<Map<string, GitSummary>> {
  const summaries = await mapWithConcurrency(config.projects, GIT_CONCURRENCY, async (project) => {
    try {
      const changes = await getVcsStatus(project.path);
      return {
        projectId: project.id,
        changeCount: changes.length,
      };
    } catch (e) {
      return {
        projectId: project.id,
        changeCount: 0,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  });

  return new Map(summaries.map((summary) => [summary.projectId, summary]));
}

export async function buildWorkspaceOverviewSnapshot({
  config,
  projectStates,
  notifications,
  ccConnectStatus,
}: WorkspaceOverviewInput): Promise<WorkspaceOverviewState> {
  const ccConfig = normalizeCcConnectConfig(config.ccConnect);
  const projectLinks = ccConfig.projectLinks;
  const linkedProjectNames = Object.values(projectLinks).filter(Boolean);
  const linkedProjectCount = linkedProjectNames.length;
  const running = ccConnectStatus?.running ?? false;
  let remoteProjectNames: Set<string> | null = null;
  let remoteListError: string | undefined;

  if (running) {
    try {
      const remoteProjects = await listCcConnectProjects(ccConfig.configPath);
      remoteProjectNames = new Set(remoteProjects.map((project) => project.name));
    } catch (e) {
      remoteListError = e instanceof Error ? e.message : String(e);
    }
  }

  const gitSummaries = await loadGitSummaries(config);

  let totals: OverviewTotals = {
    projectCount: config.projects.length,
    openTabCount: 0,
    paneCount: 0,
    aiWorkingCount: 0,
    gitChangedProjectCount: 0,
    gitChangeCount: 0,
    notificationCount: notifications.length,
  };

  const projects: OverviewProjectSummary[] = config.projects.map((project) => {
    const runtime = getProjectRuntimeMetrics(projectStates.get(project.id));
    const git = gitSummaries.get(project.id);
    const ccConnectProjectName = projectLinks[project.id];
    const ccConnectLinked = Boolean(ccConnectProjectName);
    const ccConnectMissing = Boolean(
      ccConnectProjectName && remoteProjectNames && !remoteProjectNames.has(ccConnectProjectName),
    );

    totals = {
      ...totals,
      openTabCount: totals.openTabCount + runtime.tabCount,
      paneCount: totals.paneCount + runtime.paneCount,
      aiWorkingCount: totals.aiWorkingCount + runtime.aiWorkingCount,
      gitChangedProjectCount: totals.gitChangedProjectCount + ((git?.changeCount ?? 0) > 0 ? 1 : 0),
      gitChangeCount: totals.gitChangeCount + (git?.changeCount ?? 0),
    };

    return {
      projectId: project.id,
      name: project.name,
      path: project.path,
      status: runtime.status,
      tabCount: runtime.tabCount,
      paneCount: runtime.paneCount,
      aiWorkingCount: runtime.aiWorkingCount,
      gitChangeCount: git?.changeCount ?? 0,
      gitError: git?.error,
      ccConnectLinked,
      ccConnectProjectName,
      ccConnectMissing,
    };
  });

  const missingLinkCount = remoteProjectNames
    ? projects.filter((project) => project.ccConnectMissing).length
    : 0;

  return {
    refreshStatus: 'ready',
    lastUpdated: Date.now(),
    totals,
    projects,
    ccConnect: {
      running,
      port: ccConnectStatus?.port ?? DEFAULT_CC_CONNECT_PORT,
      version: ccConnectStatus?.version,
      ownPid: ccConnectStatus?.ownPid,
      diagnostic: ccConnectStatus?.diagnostic,
      linkedProjectCount,
      missingLinkCount,
      remoteListLoaded: Boolean(remoteProjectNames),
      remoteListError,
    },
  };
}
