import { useMemo } from 'react';
import { useAppStore } from '../store';
import type { PaneStatus, WorkspaceTab } from '../types';

const STATUS_COLORS: Record<PaneStatus, string> = {
  idle: 'var(--text-muted)',
  'ai-idle': 'var(--color-success)',
  'ai-working': 'var(--color-ai-working)',
  error: 'var(--color-error)',
};

const STATUS_PRIORITY: Record<PaneStatus, number> = {
  error: 3,
  'ai-working': 2,
  'ai-idle': 1,
  idle: 0,
};

function getTabStatus(tab: WorkspaceTab, tabRuntimeAggregate: Map<string, PaneStatus>): PaneStatus {
  switch (tab.kind) {
    case 'terminal':
      return tabRuntimeAggregate.get(tab.id) ?? tab.status;
    case 'file-viewer':
    case 'agent-tasks':
      return tab.status;
    default:
      return 'idle';
  }
}

function getStatusLabel(status: PaneStatus) {
  switch (status) {
    case 'error':
      return 'Error';
    case 'ai-working':
      return 'AI Running';
    case 'ai-idle':
      return 'AI Ready';
    default:
      return 'Idle';
  }
}

export function ActivityBar() {
  const workspaces = useAppStore((state) => state.config.workspaces);
  const workspaceStates = useAppStore((state) => state.workspaceStates);
  const tabRuntimeAggregate = useAppStore((state) => state.tabRuntimeAggregate);
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId);
  const openSettings = useAppStore((state) => state.openSettings);

  const summary = useMemo(() => {
    let globalStatus: PaneStatus = 'idle';
    let tabCount = 0;

    for (const workspaceState of workspaceStates.values()) {
      tabCount += workspaceState.tabs.length;
      for (const tab of workspaceState.tabs) {
        const status = getTabStatus(tab, tabRuntimeAggregate);
        if (STATUS_PRIORITY[status] > STATUS_PRIORITY[globalStatus]) {
          globalStatus = status;
        }
      }
    }

    return { globalStatus, tabCount };
  }, [tabRuntimeAggregate, workspaceStates]);

  return (
    <div
      className="flex h-full w-10 flex-col items-center border-r border-[var(--border-subtle)] bg-[var(--bg-surface)] py-2 text-[10px] select-none"
      aria-label="Legacy activity bar"
    >
      <div
        className="flex h-8 w-8 items-center justify-center rounded border border-[var(--border-subtle)] bg-[var(--bg-elevated)]"
        title={`Global status: ${getStatusLabel(summary.globalStatus)}`}
      >
        <span
          className={`h-2.5 w-2.5 rounded-full ${summary.globalStatus === 'ai-working' ? 'animate-blink' : ''}`}
          style={{ backgroundColor: STATUS_COLORS[summary.globalStatus] }}
        />
      </div>

      <div className="mt-3 flex flex-col items-center gap-2 text-[var(--text-muted)]">
        <div className="flex h-8 w-8 flex-col items-center justify-center rounded border border-[var(--border-subtle)]">
          <span className="text-[9px] uppercase tracking-[0.08em]">WS</span>
          <span className="text-[11px] text-[var(--text-primary)]">{workspaces.length}</span>
        </div>
        <div className="flex h-8 w-8 flex-col items-center justify-center rounded border border-[var(--border-subtle)]">
          <span className="text-[9px] uppercase tracking-[0.08em]">Tab</span>
          <span className="text-[11px] text-[var(--text-primary)]">{summary.tabCount}</span>
        </div>
      </div>

      <div className="mt-auto flex flex-col items-center gap-2">
        {activeWorkspaceId ? (
          <span
            className="max-w-8 truncate text-center text-[9px] uppercase tracking-[0.08em] text-[var(--text-muted)]"
            title={activeWorkspaceId}
          >
            {activeWorkspaceId}
          </span>
        ) : null}

        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center rounded border border-[var(--border-subtle)] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
          onClick={() => openSettings()}
          title="Open settings"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="8" cy="8" r="2.2" />
            <path d="M8 1.8v1.5M8 12.7v1.5M14.2 8h-1.5M3.3 8H1.8M12.4 3.6l-1 1M4.6 11.4l-1 1M12.4 12.4l-1-1M4.6 4.6l-1-1" />
          </svg>
        </button>
      </div>
    </div>
  );
}
