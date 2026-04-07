import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppStore, selectWorkspaceConfig } from '../store';
import { showContextMenu } from '../utils/contextMenu';
import {
  deleteExternalSession,
  getExternalSessionMessages,
  listExternalSessions,
} from '../runtime/externalSessionApi';
import type { ExternalSessionMessage, ExternalSessionSummary } from '../types';

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

function formatTimestampLabel(iso?: string): string {
  if (!iso) return 'unknown time';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function previewSessionKey(session: Pick<ExternalSessionSummary, 'providerId' | 'sourcePath'>): string {
  return `${session.providerId}:${session.sourcePath}`;
}

function roleBadgeClass(role: string): string {
  switch (role.toLowerCase()) {
    case 'assistant':
      return 'border-[var(--accent)]/30 bg-[var(--accent-subtle)] text-[var(--accent)]';
    case 'user':
      return 'border-[var(--color-success)]/30 bg-[var(--color-success)]/10 text-[var(--color-success)]';
    case 'tool':
      return 'border-[var(--color-warning,#f5c063)]/30 bg-[var(--color-warning,#f5c063)]/10 text-[var(--color-warning,#f5c063)]';
    default:
      return 'border-[var(--border-default)] bg-[var(--bg-elevated)] text-[var(--text-muted)]';
  }
}

function formatRoleLabel(role: string): string {
  const trimmed = role.trim();
  return trimmed ? trimmed.toUpperCase() : 'UNKNOWN';
}

function SessionActionButton({
  label,
  onClick,
  tone = 'default',
}: {
  label: string;
  onClick: () => void;
  tone?: 'default' | 'danger';
}) {
  return (
    <button
      type="button"
      className={`rounded-[var(--radius-sm)] border px-2 py-1 text-[10px] transition-colors ${
        tone === 'danger'
          ? 'border-[var(--color-danger)]/35 text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10'
          : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]'
      }`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

const SESSION_GROUPS: Array<{
  type: ExternalSessionSummary['providerId'];
  label: string;
  emptyLabel: string;
}> = [
  { type: 'codex', label: 'Codex', emptyLabel: 'No Codex sessions' },
  { type: 'claude', label: 'Claude', emptyLabel: 'No Claude sessions' },
];

const TYPE_BADGE: Record<ExternalSessionSummary['providerId'], { label: string; color: string }> = {
  claude: { label: 'C', color: 'var(--color-ai)' },
  codex: { label: 'X', color: 'var(--color-success)' },
};

function getResumeCommand(session: ExternalSessionSummary) {
  if (session.resumeCommand?.trim()) {
    return session.resumeCommand;
  }
  return session.providerId === 'claude'
    ? `claude --resume ${session.sessionId}`
    : `codex resume ${session.sessionId}`;
}

export function SessionList() {
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId);
  const activeWorkspace = useAppStore(selectWorkspaceConfig(activeWorkspaceId));
  const rootNameByPath = useMemo(
    () => new Map(activeWorkspace?.roots.map((root) => [root.path, root.name]) ?? []),
    [activeWorkspace],
  );

  const [sessions, setSessions] = useState<ExternalSessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedSessionKey, setExpandedSessionKey] = useState<string | null>(null);
  const [messageCache, setMessageCache] = useState<Record<string, ExternalSessionMessage[]>>({});
  const [messageErrors, setMessageErrors] = useState<Record<string, string | undefined>>({});
  const [loadingPreviewKey, setLoadingPreviewKey] = useState<string | null>(null);

  const fetchSessions = useCallback(async (projectPaths: string[]) => {
    setLoading(true);
    try {
      const result = await listExternalSessions(projectPaths);
      setSessions(result);
      setError(null);
    } catch (cause) {
      setSessions([]);
      setError(cause instanceof Error ? cause.message : 'Unable to load external sessions');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSessionMessages = useCallback(
    async (session: ExternalSessionSummary, force = false) => {
      const key = previewSessionKey(session);
      if (!force && messageCache[key]) {
        return;
      }

      setLoadingPreviewKey(key);
      setMessageErrors((current) => ({
        ...current,
        [key]: undefined,
      }));

      try {
        const result = await getExternalSessionMessages(session.providerId, session.sourcePath);
        setMessageCache((current) => ({
          ...current,
          [key]: result,
        }));
      } catch (cause) {
        setMessageErrors((current) => ({
          ...current,
          [key]: cause instanceof Error ? cause.message : 'Unable to load session messages',
        }));
      } finally {
        setLoadingPreviewKey((current) => (current === key ? null : current));
      }
    },
    [messageCache],
  );

  useEffect(() => {
    if (activeWorkspace?.roots.length) {
      void fetchSessions(activeWorkspace.roots.map((root) => root.path));
    } else {
      setSessions([]);
      setError(null);
    }
  }, [activeWorkspace, fetchSessions]);

  useEffect(() => {
    setExpandedSessionKey(null);
    setMessageCache({});
    setMessageErrors({});
    setLoadingPreviewKey(null);
  }, [activeWorkspaceId]);

  const sessionsByType = useMemo(
    () => ({
      codex: sessions.filter((session) => session.providerId === 'codex'),
      claude: sessions.filter((session) => session.providerId === 'claude'),
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
            Refresh
          </span>
        ) : null}
      </div>

      <div className="flex-1 overflow-y-auto px-1.5 pb-2">
        {loading && sessions.length === 0 ? (
          <div className="px-2.5 py-3 text-center text-xs text-[var(--text-muted)]">Loading...</div>
        ) : null}

        {!loading && error ? (
          <div className="px-2.5 py-3 text-center text-xs text-[var(--color-danger)]">{error}</div>
        ) : null}

        {!loading && sessions.length === 0 && !error ? (
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
                      const badge = TYPE_BADGE[session.providerId] ?? TYPE_BADGE.claude;
                      const rootLabel = session.projectPath
                        ? rootNameByPath.get(session.projectPath) ?? session.projectPath
                        : undefined;
                      const key = previewSessionKey(session);
                      const isExpanded = expandedSessionKey === key;
                      const cachedMessages = messageCache[key] ?? [];
                      const previewMessages = cachedMessages.slice(-8);
                      const previewError = messageErrors[key];
                      const previewLoading = loadingPreviewKey === key;

                      const handleDelete = async () => {
                        const confirmed = window.confirm(
                          `Delete ${session.providerId} session ${session.sessionId}?`,
                        );
                        if (!confirmed) {
                          return;
                        }
                        await deleteExternalSession(
                          session.providerId,
                          session.sessionId,
                          session.sourcePath,
                        );
                        setMessageCache((current) => {
                          const next = { ...current };
                          delete next[key];
                          return next;
                        });
                        setMessageErrors((current) => {
                          const next = { ...current };
                          delete next[key];
                          return next;
                        });
                        setExpandedSessionKey((current) => (current === key ? null : current));
                        if (activeWorkspace?.roots.length) {
                          await fetchSessions(activeWorkspace.roots.map((root) => root.path));
                        } else {
                          setSessions((current) =>
                            current.filter(
                              (item) =>
                                !(
                                  item.providerId === session.providerId
                                  && item.sessionId === session.sessionId
                                  && item.sourcePath === session.sourcePath
                                ),
                            ),
                          );
                        }
                      };

                      return (
                        <div
                          key={`${session.providerId}-${session.sessionId}`}
                          className="group rounded-[var(--radius-sm)] px-2.5 py-1.5 text-xs transition-colors hover:bg-[var(--border-subtle)]"
                          title={`${session.providerId.toUpperCase()} | ${session.timestamp}`}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            showContextMenu(event.clientX, event.clientY, [
                              {
                                label: 'Copy Resume Command',
                                onClick: () => navigator.clipboard.writeText(getResumeCommand(session)),
                              },
                              {
                                label: 'Copy Source Path',
                                onClick: () => navigator.clipboard.writeText(session.sourcePath),
                              },
                              {
                                label: 'Delete Session',
                                onClick: () => {
                                  void handleDelete();
                                },
                              },
                            ]);
                          }}
                        >
                          <button
                            type="button"
                            className="flex w-full items-start gap-2 text-left"
                            aria-expanded={isExpanded}
                            onClick={() => {
                              if (isExpanded) {
                                setExpandedSessionKey(null);
                                return;
                              }
                              setExpandedSessionKey(key);
                              void loadSessionMessages(session);
                            }}
                          >
                            <span
                              className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-[10px] font-bold"
                              style={{ backgroundColor: `${badge.color}22`, color: badge.color }}
                            >
                              {badge.label}
                            </span>

                            <div className="min-w-0 flex-1">
                              <div className="flex items-start justify-between gap-2">
                                <div className="truncate leading-snug text-[var(--text-secondary)] transition-colors group-hover:text-[var(--text-primary)]">
                                  {session.title}
                                </div>
                                <span className="mt-0.5 flex-shrink-0 text-[10px] text-[var(--text-muted)]">
                                  {isExpanded ? 'Collapse' : 'Preview'}
                                </span>
                              </div>
                              {session.summary ? (
                                <div className="mt-0.5 line-clamp-2 text-[11px] text-[var(--text-muted)]">
                                  {session.summary}
                                </div>
                              ) : null}
                              <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[var(--text-muted)]">
                                <span>{formatTime(session.timestamp)}</span>
                                {rootLabel ? (
                                  <>
                                    <span>|</span>
                                    <span className="truncate">{rootLabel}</span>
                                  </>
                                ) : null}
                              </div>
                            </div>
                          </button>

                          {isExpanded ? (
                            <div className="mt-2 ml-6 space-y-2 rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2.5 py-2">
                              <div className="flex flex-wrap gap-1.5">
                                <SessionActionButton
                                  label="Copy Resume"
                                  onClick={() => void navigator.clipboard.writeText(getResumeCommand(session))}
                                />
                                <SessionActionButton
                                  label="Copy Source"
                                  onClick={() => void navigator.clipboard.writeText(session.sourcePath)}
                                />
                                <SessionActionButton
                                  label="Reload Preview"
                                  onClick={() => void loadSessionMessages(session, true)}
                                />
                                <SessionActionButton
                                  label="Delete Session"
                                  tone="danger"
                                  onClick={() => {
                                    void handleDelete();
                                  }}
                                />
                              </div>

                              {previewLoading ? (
                                <div className="text-[11px] text-[var(--text-muted)]">Loading messages...</div>
                              ) : null}

                              {!previewLoading && previewError ? (
                                <div className="text-[11px] text-[var(--color-danger)]">{previewError}</div>
                              ) : null}

                              {!previewLoading && !previewError && cachedMessages.length === 0 ? (
                                <div className="text-[11px] text-[var(--text-muted)]">No message history.</div>
                              ) : null}

                              {!previewLoading && !previewError && previewMessages.length > 0 ? (
                                <div className="space-y-2">
                                  <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-muted)]">
                                    {cachedMessages.length > previewMessages.length
                                      ? `Showing last ${previewMessages.length} of ${cachedMessages.length} messages`
                                      : `${previewMessages.length} messages`}
                                  </div>
                                  <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
                                    {previewMessages.map((message, index) => (
                                      <div
                                        key={`${key}-${index}-${message.timestamp ?? 'na'}`}
                                        className="rounded-[var(--radius-sm)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-2"
                                      >
                                        <div className="mb-1 flex items-center justify-between gap-2">
                                          <span
                                            className={`rounded-full border px-1.5 py-px text-[9px] tracking-[0.08em] ${roleBadgeClass(message.role)}`}
                                          >
                                            {formatRoleLabel(message.role)}
                                          </span>
                                          <span className="text-[10px] text-[var(--text-muted)]">
                                            {formatTimestampLabel(message.timestamp)}
                                          </span>
                                        </div>
                                        <div className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-[var(--text-secondary)]">
                                          {message.content}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          ) : null}
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
