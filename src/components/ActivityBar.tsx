import type { ReactNode } from 'react';
import { useAppStore, STATUS_PRIORITY, getHighestStatus } from '../store';
import { useT } from '../i18n';
import type { PaneStatus } from '../types';

const STATUS_COLORS: Record<PaneStatus, string> = {
  idle: 'var(--text-muted)',
  'ai-idle': 'var(--color-success)',
  'ai-working': 'var(--color-ai-working)',
  error: 'var(--color-error)',
};

const ICON_PANEL = (
  <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="M6.5 3v10" />
  </svg>
);
const ICON_OVERVIEW = (
  <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.5 3.5h4v4h-4z" />
    <path d="M9.5 3.5h4v2.5h-4z" />
    <path d="M9.5 9h4v3.5h-4z" />
    <path d="M2.5 10h4M2.5 12.5h4" />
  </svg>
);
const ICON_SESSIONS = (
  <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 3h12v8H5l-3 3V3z" />
  </svg>
);
const ICON_VCS = (
  <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="5" cy="4" r="1.5" />
    <circle cx="11" cy="4" r="1.5" />
    <circle cx="5" cy="12" r="1.5" />
    <path d="M5 5.5v5M11 5.5v1a2 2 0 01-2 2H5" />
  </svg>
);
const ICON_SETTINGS = (
  <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="8" cy="8" r="2.1" />
    <path d="M8 1.5v1.6M8 12.9v1.6M14.5 8h-1.6M3.1 8H1.5M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1M12.6 12.6l-1.1-1.1M4.5 4.5 3.4 3.4" />
  </svg>
);
const ICON_SSH = (
  <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="M4.8 6.5 6.6 8l-1.8 1.5M8.4 10h2.8" />
  </svg>
);
const ICON_CONNECT = (
  <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M7 9a3 3 0 004.24 0l1.5-1.5a3 3 0 00-4.24-4.24L8 4" />
    <path d="M9 7a3 3 0 00-4.24 0l-1.5 1.5a3 3 0 004.24 4.24L8 12" />
  </svg>
);

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
  badgeColor?: string;
  badgeBlink?: boolean;
  onClick: () => void;
}

function ActivityIconButton({
  title,
  icon,
  active = false,
  badgeColor,
  badgeBlink = false,
  onClick,
}: ActivityButtonProps) {
  return (
    <button
      type="button"
      className={`group relative w-8 h-8 flex items-center justify-center rounded transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] ${
        active
          ? 'text-[var(--text-primary)] bg-[var(--border-subtle)]'
          : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--border-subtle)]/50'
      }`}
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
    >
      {active && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 rounded-full bg-[var(--accent)]" />
      )}
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
  const rightDrawer = useAppStore((s) => s.rightDrawer);
  const togglePanel = useAppStore((s) => s.togglePanel);
  const toggleMiddleColumn = useAppStore((s) => s.toggleMiddleColumn);
  const toggleRightDrawer = useAppStore((s) => s.toggleRightDrawer);
  const ccConnectStatus = useAppStore((s) => s.ccConnectStatus);

  let globalStatus: PaneStatus = 'idle';
  for (const ps of projectStates.values()) {
    for (const tab of ps.tabs) {
      const status = getHighestStatus(tab.splitLayout);
      if (STATUS_PRIORITY[status] > STATUS_PRIORITY[globalStatus]) {
        globalStatus = status;
      }
    }
  }

  return (
    <div
      className="h-full bg-[var(--bg-surface)] flex flex-col items-center pt-2 pb-2 gap-1 border-r border-[var(--border-subtle)] select-none"
      style={{ width: 44 }}
    >
      <ActivityIconButton
        title={config.middleColumnVisible ? t('app.activityBar.collapse') : t('app.activityBar.expand')}
        icon={ICON_PANEL}
        active={config.middleColumnVisible}
        badgeColor={globalStatus !== 'idle' ? STATUS_COLORS[globalStatus] : undefined}
        badgeBlink={globalStatus === 'ai-working'}
        onClick={toggleMiddleColumn}
      />
      <ActivityIconButton
        title="Overview"
        icon={ICON_OVERVIEW}
        active={config.overviewVisible}
        onClick={() => togglePanel('overview')}
      />
      <ActivityIconButton
        title={t('app.activityBar.sessions')}
        icon={ICON_SESSIONS}
        active={rightDrawer === 'sessions'}
        onClick={() => toggleRightDrawer('sessions')}
      />
      <ActivityIconButton
        title="VCS"
        icon={ICON_VCS}
        active={rightDrawer === 'git'}
        onClick={() => toggleRightDrawer('git')}
      />

      <div className="mt-auto mb-2 flex flex-col items-center gap-1 border-t border-[var(--border-subtle)] pt-2">
        <ActivityIconButton
          title={t('app.activityBar.settings')}
          icon={ICON_SETTINGS}
          active={settingsActive}
          onClick={onOpenSettings}
        />
        <ActivityIconButton
          title={t('app.activityBar.ssh')}
          icon={ICON_SSH}
          active={sshActive}
          onClick={onOpenSsh}
        />
        <ActivityIconButton
          title={t('app.activityBar.connect')}
          icon={ICON_CONNECT}
          active={connectActive}
          badgeColor={ccConnectStatus?.running ? 'var(--color-success)' : ccConnectStatus?.diagnostic ? 'var(--color-error)' : undefined}
          onClick={onOpenConnect}
        />
      </div>
    </div>
  );
}
