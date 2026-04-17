import { useAppStore, STATUS_PRIORITY, getHighestStatus } from '../store';
import type { PaneStatus } from '../types';

const STATUS_COLORS: Record<PaneStatus, string> = {
  idle: 'var(--text-muted)',
  'ai-idle': 'var(--color-success)',
  'ai-working': 'var(--color-ai-working)',
  error: 'var(--color-error)',
};

interface PanelDef {
  key: 'projects' | 'sessions' | 'files' | 'git';
  title: string;
  icon: React.ReactNode;
}

const PANELS: PanelDef[] = [
  {
    key: 'projects',
    title: 'Projects',
    icon: (
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 4h5l1.5-2H14v11H2z" />
      </svg>
    ),
  },
  {
    key: 'sessions',
    title: 'Sessions',
    icon: (
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 3h12v8H5l-3 3V3z" />
      </svg>
    ),
  },
  {
    key: 'files',
    title: 'Files',
    icon: (
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 1H4a1 1 0 00-1 1v12a1 1 0 001 1h8a1 1 0 001-1V5L9 1z" />
        <path d="M9 1v4h4" />
      </svg>
    ),
  },
  {
    key: 'git',
    title: 'Git',
    icon: (
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="5" cy="4" r="1.5" />
        <circle cx="11" cy="4" r="1.5" />
        <circle cx="5" cy="12" r="1.5" />
        <path d="M5 5.5v5M11 5.5v1a2 2 0 01-2 2H5" />
      </svg>
    ),
  },
];

const VISIBLE_KEY_MAP = {
  projects: 'projectsVisible',
  sessions: 'sessionsVisible',
  files: 'filesVisible',
  git: 'gitVisible',
} as const;

export function ActivityBar() {
  const config = useAppStore((s) => s.config);
  const projectStates = useAppStore((s) => s.projectStates);
  const togglePanel = useAppStore((s) => s.togglePanel);

  // 聚合所有项目的最高 AI 状态
  let globalStatus: PaneStatus = 'idle';
  for (const ps of projectStates.values()) {
    for (const tab of ps.tabs) {
      const s = getHighestStatus(tab.splitLayout);
      if (STATUS_PRIORITY[s] > STATUS_PRIORITY[globalStatus]) {
        globalStatus = s;
      }
    }
  }

  return (
    <div className="h-full bg-[var(--bg-surface)] flex flex-col items-center pt-2 gap-1 border-r border-[var(--border-subtle)] select-none"
      style={{ width: 40 }}>
      {PANELS.map((panel) => {
        const isActive = config[VISIBLE_KEY_MAP[panel.key]];
        const showBadge = panel.key === 'projects' && globalStatus !== 'idle';

        return (
          <button
            key={panel.key}
            className={`relative w-8 h-8 flex items-center justify-center rounded transition-colors ${
              isActive
                ? 'text-[var(--text-primary)] bg-[var(--border-subtle)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--border-subtle)]/50'
            }`}
            onClick={() => togglePanel(panel.key)}
            title={panel.title}
          >
            {panel.icon}
            {isActive && (
              <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 rounded-full bg-[var(--accent)]" />
            )}
            {showBadge && (
              <span
                className={`absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full border border-[var(--bg-surface)] ${
                  globalStatus === 'ai-working' ? 'animate-blink' : ''
                }`}
                style={{ backgroundColor: STATUS_COLORS[globalStatus] }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
