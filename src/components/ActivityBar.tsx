import type { ReactNode } from 'react';
import { useAppStore, STATUS_PRIORITY, getHighestStatus } from '../store';
import type { PaneStatus } from '../types';
import { useT } from '../i18n';

const STATUS_COLORS: Record<PaneStatus, string> = {
  idle: 'var(--text-muted)',
  'ai-idle': 'var(--color-success)',
  'ai-working': 'var(--color-ai-working)',
  error: 'var(--color-error)',
};

interface PanelDef {
  key: 'overview' | 'projects' | 'sessions' | 'files' | 'git';
  title: string;
  icon: ReactNode;
}

interface ActivityBarProps {
  settingsActive?: boolean;
  sshActive?: boolean;
  connectActive?: boolean;
  onOpenSettings: () => void;
  onOpenSsh: () => void;
  onOpenConnect: () => void;
}

interface ActivityButtonProps {
  title: string;
  icon: ReactNode;
  active?: boolean;
  pressed?: boolean;
  badgeColor?: string;
  badgeBlink?: boolean;
  onClick: () => void;
}

const PANELS: PanelDef[] = [
  {
    key: 'overview',
    title: 'Overview',
    icon: (
      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2.5 3.5h4v4h-4z" />
        <path d="M9.5 3.5h4v2.5h-4z" />
        <path d="M9.5 9h4v3.5h-4z" />
        <path d="M2.5 10h4" />
        <path d="M2.5 12.5h4" />
      </svg>
    ),
  },
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
    title: 'VCS',
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
  overview: 'overviewVisible',
  projects: 'projectsVisible',
  sessions: 'sessionsVisible',
  files: 'filesVisible',
  git: 'gitVisible',
} as const;

function ActivityIconButton({
  title,
  icon,
  active = false,
  pressed,
  badgeColor,
  badgeBlink = false,
  onClick,
}: ActivityButtonProps) {
  return (
    <button
      type="button"
      className={`group relative w-8 h-8 flex items-center justify-center rounded transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ${
        active
          ? 'text-[var(--accent)] bg-[var(--accent-subtle)]'
          : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--border-subtle)]/50'
      }`}
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={pressed}
    >
      <span className="flex h-5 w-5 items-center justify-center transition-transform duration-150 ease-out will-change-transform group-hover:scale-115 group-active:scale-95 motion-reduce:transition-none motion-reduce:transform-none">
        {icon}
      </span>
      {badgeColor && (
        <span
          className={`absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full border border-[var(--bg-surface)] ${
            badgeBlink ? 'animate-blink' : ''
          }`}
          style={{ backgroundColor: badgeColor }}
        />
      )}
    </button>
  );
}

export function ActivityBar({
  settingsActive = false,
  sshActive = false,
  connectActive = false,
  onOpenSettings,
  onOpenSsh,
  onOpenConnect,
}: ActivityBarProps) {
  const t = useT();
  const config = useAppStore((s) => s.config);
  const projectStates = useAppStore((s) => s.projectStates);
  const togglePanel = useAppStore((s) => s.togglePanel);
  const ccConnectStatus = useAppStore((s) => s.ccConnectStatus);

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
          <ActivityIconButton
            key={panel.key}
            title={panel.title}
            icon={panel.icon}
            active={isActive}
            pressed={isActive}
            badgeColor={showBadge ? STATUS_COLORS[globalStatus] : undefined}
            badgeBlink={globalStatus === 'ai-working'}
            onClick={() => togglePanel(panel.key)}
          />
        );
      })}

      <div className="mt-auto mb-2 flex flex-col items-center gap-1 border-t border-[var(--border-subtle)] pt-2">
        <ActivityIconButton
          title={t('app.menu.settings')}
          icon={(
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="8" cy="8" r="2.2" />
              <path d="M8 1.8v1.4M8 12.8v1.4M3.6 3.6l1 1M11.4 11.4l1 1M1.8 8h1.4M12.8 8h1.4M3.6 12.4l1-1M11.4 4.6l1-1" />
            </svg>
          )}
          active={settingsActive}
          onClick={onOpenSettings}
        />
        <ActivityIconButton
          title="SSH"
          icon={(
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2.5 3.5h11v9h-11z" />
              <path d="M4.5 6.5l2 1.5-2 1.5M7.5 10h3.5" />
            </svg>
          )}
          active={sshActive}
          onClick={onOpenSsh}
        />
        <ActivityIconButton
          title={t('app.menu.connect')}
          icon={(
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6.5 5.5l3 5M4.5 10.5h-1a2 2 0 010-4h1M11.5 5.5h1a2 2 0 010 4h-1" />
              <path d="M5 8h6" />
            </svg>
          )}
          active={connectActive}
          badgeColor={ccConnectStatus?.running ? 'var(--color-success)' : ccConnectStatus?.diagnostic ? 'var(--color-error)' : undefined}
          onClick={onOpenConnect}
        />
      </div>
    </div>
  );
}
