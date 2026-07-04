import { useMemo } from 'react';
import type { MouseEvent } from 'react';
import { useAppStore } from '../store';
import { useT } from '../i18n';
import { formatRelativeTime } from '../utils/timeFormat';
import { refreshWorkspaceOverview } from '../hooks/useWorkspaceOverview';
import type { OverviewProjectSummary, PaneStatus } from '../types';

const STATUS_CLASS: Record<PaneStatus, string> = {
  idle: 'bg-[var(--text-muted)]',
  'ai-idle': 'bg-[var(--color-success)]',
  'ai-working': 'bg-[var(--color-ai-working)] animate-blink',
  error: 'bg-[var(--color-error)]',
};

function formatTimeMs(timestamp?: number): string {
  if (!timestamp) return '-';
  return formatRelativeTime(Math.floor(timestamp / 1000));
}

function cx(...classes: Array<string | false | undefined>) {
  return classes.filter(Boolean).join(' ');
}

function StatusPill({ status }: { status: PaneStatus }) {
  const t = useT();
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] text-[var(--text-secondary)]">
      <span className={cx('w-1.5 h-1.5 rounded-full', STATUS_CLASS[status])} />
      {t(`overview.status.${status}`)}
    </span>
  );
}

function Metric({ label, value, tone }: { label: string; value: string | number; tone?: 'accent' | 'warning' | 'danger' }) {
  return (
    <div className="min-w-0 py-2 border-r border-[var(--border-subtle)] last:border-r-0">
      <div
        className={cx(
          'text-base font-semibold leading-5 truncate',
          tone === 'accent' && 'text-[var(--accent)]',
          tone === 'warning' && 'text-[var(--color-warning,#e5c07b)]',
          tone === 'danger' && 'text-[var(--color-error)]',
          !tone && 'text-[var(--text-primary)]',
        )}
        title={String(value)}
      >
        {value}
      </div>
      <div className="mt-0.5 text-[10px] text-[var(--text-muted)] truncate" title={label}>{label}</div>
    </div>
  );
}

function ProjectRow({ project }: { project: OverviewProjectSummary }) {
  const t = useT();
  const config = useAppStore((s) => s.config);
  const setActiveProject = useAppStore((s) => s.setActiveProject);
  const togglePanel = useAppStore((s) => s.togglePanel);
  const openCcDashboard = useAppStore((s) => s.openCcDashboard);
  const ccConnectRunning = useAppStore((s) => s.workspaceOverview.ccConnect.running);

  const showGit = (e: MouseEvent) => {
    e.stopPropagation();
    setActiveProject(project.projectId);
    if (!config.gitVisible) togglePanel('git');
  };

  const openConnect = (e: MouseEvent) => {
    e.stopPropagation();
    setActiveProject(project.projectId);
    if (project.ccConnectProjectName) {
      openCcDashboard(`/projects/${encodeURIComponent(project.ccConnectProjectName)}`);
      return;
    }
    openCcDashboard();
  };

  return (
    <div
      className="group grid grid-cols-[minmax(0,1fr)_auto] gap-2 px-2 py-2 border-b border-[var(--border-subtle)] hover:bg-[var(--border-subtle)]/45 cursor-pointer"
      onClick={() => setActiveProject(project.projectId)}
      title={project.path}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="truncate text-sm text-[var(--text-primary)]">{project.name}</span>
          <StatusPill status={project.status} />
        </div>
        <div className="mt-1 flex items-center gap-2 text-[10px] text-[var(--text-muted)] min-w-0">
          <span>{t('overview.project.tabsPanes', { tabs: project.tabCount, panes: project.paneCount })}</span>
          {project.aiWorkingCount > 0 && (
            <span className="text-[var(--color-ai-working)]">{t('overview.project.aiWorking', { count: project.aiWorkingCount })}</span>
          )}
          <span
            className={cx(
              project.gitError && 'text-[var(--color-error)]',
              project.gitChangeCount > 0 && !project.gitError && 'text-[var(--color-warning,#e5c07b)]',
            )}
            title={project.gitError}
          >
            {project.gitError
              ? t('overview.project.gitError')
              : t('overview.project.gitChanges', { count: project.gitChangeCount })}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1 self-start">
        <span
          className={cx(
            'px-1.5 py-0.5 rounded text-[10px]',
            project.ccConnectMissing && 'bg-[var(--color-error)]/12 text-[var(--color-error)]',
            project.ccConnectLinked && !project.ccConnectMissing && 'bg-[var(--color-success)]/12 text-[var(--color-success)]',
            !project.ccConnectLinked && 'bg-[var(--bg-elevated)] text-[var(--text-muted)]',
          )}
          title={project.ccConnectProjectName}
        >
          {project.ccConnectMissing
            ? t('overview.project.ccMissing')
            : project.ccConnectLinked
              ? t('overview.project.ccLinked')
              : t('overview.project.ccUnlinked')}
        </span>
        <button
          className="w-6 h-6 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--border-subtle)] opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={showGit}
          title={t('overview.actions.openGit')}
        >
          G
        </button>
        <button
          className="w-6 h-6 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--border-subtle)] disabled:opacity-30 disabled:cursor-not-allowed opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={openConnect}
          disabled={!ccConnectRunning}
          title={t('overview.actions.openConnect')}
        >
          C
        </button>
      </div>
    </div>
  );
}

export function OverviewPanel() {
  const t = useT();
  const overview = useAppStore((s) => s.workspaceOverview);
  const notifications = useAppStore((s) => s.notifications);
  const openCcDashboard = useAppStore((s) => s.openCcDashboard);

  const recentNotifications = useMemo(
    () => [...notifications].sort((a, b) => b.timestamp - a.timestamp).slice(0, 5),
    [notifications],
  );

  const refreshing = overview.refreshStatus === 'loading';
  const ccTone = overview.ccConnect.running
    ? overview.ccConnect.missingLinkCount > 0
      ? 'warning'
      : 'accent'
    : undefined;

  return (
    <div data-panel className="h-full bg-[var(--bg-surface)] flex flex-col select-none">
      <div className="px-3 py-2.5 border-b border-[var(--border-subtle)] flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-[var(--text-primary)] truncate">{t('overview.title')}</div>
          <div className="mt-0.5 text-[10px] text-[var(--text-muted)] truncate">
            {overview.refreshStatus === 'idle'
              ? t('overview.notRefreshed')
              : t('overview.lastUpdated', { time: formatTimeMs(overview.lastUpdated) })}
          </div>
        </div>
        <button
          className="w-7 h-7 rounded flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--border-subtle)] disabled:opacity-60"
          onClick={() => void refreshWorkspaceOverview()}
          disabled={refreshing}
          title={t('overview.actions.refresh')}
        >
          <svg className={refreshing ? 'animate-spin' : ''} width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13 8a5 5 0 1 1-1.5-3.6" />
            <path d="M13 3.5V7h-3.5" />
          </svg>
        </button>
      </div>

      <div className="grid grid-cols-5 px-2 border-b border-[var(--border-subtle)] text-center">
        <Metric label={t('overview.metrics.projects')} value={overview.totals.projectCount} />
        <Metric label={t('overview.metrics.tabs')} value={overview.totals.openTabCount} />
        <Metric label={t('overview.metrics.panes')} value={overview.totals.paneCount} />
        <Metric label={t('overview.metrics.aiWorking')} value={overview.totals.aiWorkingCount} tone={overview.totals.aiWorkingCount > 0 ? 'accent' : undefined} />
        <Metric label={t('overview.metrics.git')} value={overview.totals.gitChangeCount} tone={overview.totals.gitChangeCount > 0 ? 'warning' : undefined} />
      </div>

      <div className="px-3 py-2 border-b border-[var(--border-subtle)]">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-[0.12em] text-[var(--text-muted)]">{t('overview.cc.title')}</div>
            <div className="mt-1 flex items-center gap-2 text-xs text-[var(--text-secondary)] min-w-0">
              <span className={cx('w-1.5 h-1.5 rounded-full', overview.ccConnect.running ? 'bg-[var(--color-success)]' : 'bg-[var(--text-muted)]')} />
              <span className="truncate">
                {overview.ccConnect.running
                  ? t('overview.cc.running', { port: overview.ccConnect.port })
                  : t('overview.cc.stopped')}
              </span>
              {overview.ccConnect.version && <span className="font-mono text-[10px] text-[var(--text-muted)]">{overview.ccConnect.version}</span>}
            </div>
          </div>
          <button
            className="px-2 py-1 rounded text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--border-subtle)] disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={() => openCcDashboard()}
            disabled={!overview.ccConnect.running}
            title={t('overview.actions.openConnect')}
          >
            {t('overview.actions.dashboard')}
          </button>
        </div>
        <div className="mt-2 grid grid-cols-3 text-center border border-[var(--border-subtle)] rounded-[var(--radius-sm)] overflow-hidden">
          <Metric label={t('overview.cc.linked')} value={overview.ccConnect.linkedProjectCount} tone={ccTone} />
          <Metric label={t('overview.cc.missing')} value={overview.ccConnect.missingLinkCount} tone={overview.ccConnect.missingLinkCount > 0 ? 'danger' : undefined} />
          <Metric label={t('overview.cc.remote')} value={overview.ccConnect.remoteListLoaded ? t('overview.cc.loaded') : '-'} />
        </div>
        {(overview.ccConnect.remoteListError || overview.ccConnect.diagnostic || overview.error) && (
          <div className="mt-2 text-[10px] text-[var(--color-error)] truncate" title={overview.ccConnect.remoteListError ?? overview.ccConnect.diagnostic ?? overview.error}>
            {overview.ccConnect.remoteListError ?? overview.ccConnect.diagnostic ?? overview.error}
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="px-3 py-2 text-[11px] uppercase tracking-[0.12em] text-[var(--text-muted)]">
          {t('overview.projectsTitle')}
        </div>
        {overview.projects.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-[var(--text-muted)]">{t('overview.emptyProjects')}</div>
        ) : (
          overview.projects.map((project) => (
            <ProjectRow key={project.projectId} project={project} />
          ))
        )}
      </div>

      <div className="border-t border-[var(--border-subtle)]">
        <div className="px-3 py-2 text-[11px] uppercase tracking-[0.12em] text-[var(--text-muted)]">
          {t('overview.notificationsTitle')}
        </div>
        <div className="max-h-36 overflow-y-auto px-2 pb-2 space-y-1">
          {recentNotifications.length === 0 ? (
            <div className="py-3 text-center text-xs text-[var(--text-muted)]">{t('overview.emptyNotifications')}</div>
          ) : (
            recentNotifications.map((notification) => (
              <button
                key={notification.id}
                className="w-full text-left px-2 py-1.5 rounded-[var(--radius-sm)] hover:bg-[var(--border-subtle)] text-xs"
                onClick={() => notification.kind !== 'wsl-info' && useAppStore.getState().setActiveProject(notification.projectId)}
                title={notification.message ?? notification.projectName}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[var(--text-secondary)]">{notification.message ?? notification.projectName}</span>
                  <span className="shrink-0 text-[10px] text-[var(--text-muted)]">{formatTimeMs(notification.timestamp)}</span>
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
