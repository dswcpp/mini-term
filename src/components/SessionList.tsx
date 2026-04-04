import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore, selectWorkspaceConfig } from '../store';
import { showContextMenu } from '../utils/contextMenu';
import type { AiSession } from '../types';

function formatTime(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  const now = Date.now();
  const diff = now - date.getTime();
  const minutes = Math.floor(diff / 60000);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  const month = date.getMonth() + 1;
  const day = date.getDate();
  const year = date.getFullYear();
  const currentYear = new Date().getFullYear();
  return year === currentYear ? `${month}/${day}` : `${year}/${month}/${day}`;
}

const SESSION_GROUPS: Array<{
  type: AiSession['sessionType'];
  label: string;
  emptyLabel: string;
}> = [
  { type: 'codex', label: 'Codex', emptyLabel: 'No Codex sessions' },
  { type: 'claude', label: 'Claude', emptyLabel: 'No Claude sessions' },
];

const TYPE_BADGE: Record<AiSession['sessionType'], { label: string; color: string }> = {
  claude: { label: 'C', color: 'var(--color-ai)' },
  codex: { label: 'X', color: 'var(--color-success)' },
};

function getResumeCommand(session: AiSession) {
  return session.sessionType === 'claude'
    ? `claude --resume ${session.id}`
    : `codex resume ${session.id}`;
}

export function SessionList() {
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId);
  const activeWorkspace = useAppStore(selectWorkspaceConfig(activeWorkspaceId));
  const rootNameByPath = useMemo(
    () => new Map(activeWorkspace?.roots.map((root) => [root.path, root.name]) ?? []),
    [activeWorkspace],
  );

  const [sessions, setSessions] = useState<AiSession[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchSessions = useCallback(async (projectPaths: string[]) => {
    setLoading(true);
    try {
      const result = await invoke<AiSession[]>('get_ai_sessions', { projectPaths });
      setSessions(result);
    } catch {
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeWorkspace?.roots.length) {
      void fetchSessions(activeWorkspace.roots.map((root) => root.path));
    } else {
      setSessions([]);
    }
  }, [activeWorkspace, fetchSessions]);

  const sessionsByType = useMemo(
    () => ({
      codex: sessions.filter((session) => session.sessionType === 'codex'),
      claude: sessions.filter((session) => session.sessionType === 'claude'),
    }),
    [sessions],
  );

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[var(--bg-surface)]">
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5 text-sm font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">
        <span>Sessions</span>
        {activeWorkspace ? (
          <span
            className="cursor-pointer text-xs normal-case tracking-normal transition-colors hover:text-[var(--text-primary)]"
            onClick={() => void fetchSessions(activeWorkspace.roots.map((root) => root.path))}
            title="Refresh session list"
          >
            ↻
          </span>
        ) : null}
      </div>

      <div className="flex-1 overflow-y-auto px-1.5 pb-2">
        {loading && sessions.length === 0 ? (
          <div className="px-2.5 py-3 text-center text-xs text-[var(--text-muted)]">Loading...</div>
        ) : null}

        {!loading && sessions.length === 0 ? (
          <div className="px-2.5 py-3 text-center text-xs text-[var(--text-muted)]">
            {activeWorkspace ? 'No session history' : 'Select a workspace'}
          </div>
        ) : null}

        {sessions.length > 0
          ? SESSION_GROUPS.map((group) => {
              const groupSessions = sessionsByType[group.type];

              return (
                <div key={group.type} className="mb-2 last:mb-0">
                  <div className="flex items-center justify-between px-2.5 pt-1.5 pb-1 text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)]">
                    <span>{group.label}</span>
                    <span>{groupSessions.length}</span>
                  </div>

                  {groupSessions.length === 0 ? (
                    <div className="px-2.5 py-2 text-xs text-[var(--text-muted)]">{group.emptyLabel}</div>
                  ) : (
                    groupSessions.map((session) => {
                      const badge = TYPE_BADGE[session.sessionType] ?? TYPE_BADGE.claude;
                      const rootLabel = session.projectPath
                        ? rootNameByPath.get(session.projectPath) ?? session.projectPath
                        : undefined;

                      return (
                        <div
                          key={`${session.sessionType}-${session.id}`}
                          className="group flex cursor-default items-start gap-2 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-xs transition-colors hover:bg-[var(--border-subtle)]"
                          title={`${session.sessionType.toUpperCase()} · ${session.timestamp}`}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            showContextMenu(event.clientX, event.clientY, [
                              {
                                label: 'Copy Resume Command',
                                onClick: () => navigator.clipboard.writeText(getResumeCommand(session)),
                              },
                            ]);
                          }}
                        >
                          <span
                            className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-[10px] font-bold"
                            style={{ backgroundColor: `${badge.color}22`, color: badge.color }}
                          >
                            {badge.label}
                          </span>

                          <div className="min-w-0 flex-1">
                            <div className="truncate leading-snug text-[var(--text-secondary)] transition-colors group-hover:text-[var(--text-primary)]">
                              {session.title}
                            </div>
                            <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[var(--text-muted)]">
                              <span>{formatTime(session.timestamp)}</span>
                              {rootLabel ? (
                                <>
                                  <span>·</span>
                                  <span className="truncate">{rootLabel}</span>
                                </>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              );
            })
          : null}
      </div>
    </div>
  );
}
