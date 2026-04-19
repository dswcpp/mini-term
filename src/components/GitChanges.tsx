import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTauriEvent } from '../hooks/useTauriEvent';
import { showContextMenu } from '../utils/contextMenu';
import { DiffModal } from './DiffModal';
import type { ChangeFileStatus, GitFileStatus, GitStatusType, PtyOutputPayload } from '../types';

interface GitChangesProps {
  projectPath: string;
  repoPath: string;
  onCommitSuccess: () => void;
}

type ViewMode = 'list' | 'tree';
type ChangeArea = 'staged' | 'unstaged' | 'untracked';

const GIT_REFRESH_PATTERNS = [
  /create mode/,
  /Switched to/,
  /Already up to date/,
  /insertions?\(\+\)/,
  /deletions?\(-\)/,
];

interface FileTreeNode {
  name: string;
  fullPath: string;
  file?: ChangeFileStatus;
  children: FileTreeNode[];
}

function buildFileTree(files: ChangeFileStatus[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];
  for (const file of files) {
    const parts = file.path.split('/');
    let current = root;
    let pathSoFar = '';
    for (let i = 0; i < parts.length; i += 1) {
      pathSoFar += `${i > 0 ? '/' : ''}${parts[i]}`;
      const isLast = i === parts.length - 1;
      if (isLast) {
        current.push({ name: parts[i], fullPath: pathSoFar, file, children: [] });
      } else {
        let dir = current.find((node) => node.name === parts[i] && !node.file);
        if (!dir) {
          dir = { name: parts[i], fullPath: pathSoFar, children: [] };
          current.push(dir);
        }
        current = dir.children;
      }
    }
  }
  return root;
}

function statusLabelFor(status?: GitStatusType): string {
  switch (status) {
    case 'modified':
      return 'M';
    case 'added':
      return 'A';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    case 'untracked':
      return '?';
    case 'conflicted':
      return 'C';
    default:
      return ' ';
  }
}

function statusColor(file: ChangeFileStatus, area: ChangeArea): string {
  const status = area === 'staged' ? file.stagedStatus : file.unstagedStatus;
  switch (status) {
    case 'modified':
      return 'text-[var(--color-warning,#e5c07b)]';
    case 'added':
      return 'text-[var(--color-success,#98c379)]';
    case 'deleted':
      return 'text-[var(--color-error,#e06c75)]';
    case 'renamed':
      return 'text-[var(--color-info,#61afef)]';
    case 'untracked':
      return 'text-[var(--color-success,#98c379)]';
    default:
      return 'text-[var(--text-muted)]';
  }
}

function getDiffStatus(file: ChangeFileStatus, area: ChangeArea): GitStatusType {
  if (area === 'staged') {
    return file.stagedStatus ?? file.unstagedStatus ?? 'modified';
  }

  if (area === 'untracked') {
    return 'untracked';
  }

  return file.unstagedStatus ?? file.stagedStatus ?? 'modified';
}

export function GitChanges({ projectPath: _projectPath, repoPath, onCommitSuccess }: GitChangesProps) {
  const [changes, setChanges] = useState<ChangeFileStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [commitMsg, setCommitMsg] = useState('');
  const [committing, setCommitting] = useState(false);
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  const [diffModal, setDiffModal] = useState<{
    open: boolean;
    file: ChangeFileStatus;
    area: ChangeArea;
  } | null>(null);

  const staged = changes.filter((change) => change.stagedStatus);
  const unstaged = changes.filter((change) => change.unstagedStatus && change.unstagedStatus !== 'untracked');
  const untracked = changes.filter((change) => change.unstagedStatus === 'untracked');

  const loadChanges = useCallback(() => {
    if (!repoPath) {
      return;
    }
    setLoading(true);
    invoke<ChangeFileStatus[]>('get_changes_status', { repoPath })
      .then(setChanges)
      .catch(() => setChanges([]))
      .finally(() => setLoading(false));
  }, [repoPath]);

  useEffect(() => {
    loadChanges();
  }, [loadChanges]);

  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedRefresh = useCallback(() => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = setTimeout(loadChanges, 500);
  }, [loadChanges]);

  useTauriEvent<PtyOutputPayload>(
    'pty-output',
    useCallback(
      (payload: PtyOutputPayload) => {
        if (GIT_REFRESH_PATTERNS.some((pattern) => pattern.test(payload.data))) {
          debouncedRefresh();
        }
      },
      [debouncedRefresh],
    ),
  );

  const handleStage = useCallback(async (files: string[]) => {
    try {
      await invoke('git_stage', { repoPath, files });
      loadChanges();
    } catch (error) {
      console.error('stage failed:', error);
    }
  }, [repoPath, loadChanges]);

  const handleUnstage = useCallback(async (files: string[]) => {
    try {
      await invoke('git_unstage', { repoPath, files });
      loadChanges();
    } catch (error) {
      console.error('unstage failed:', error);
    }
  }, [repoPath, loadChanges]);

  const handleStageAll = useCallback(async () => {
    try {
      await invoke('git_stage_all', { repoPath });
      loadChanges();
    } catch (error) {
      console.error('stage all failed:', error);
    }
  }, [repoPath, loadChanges]);

  const handleUnstageAll = useCallback(async () => {
    try {
      await invoke('git_unstage_all', { repoPath });
      loadChanges();
    } catch (error) {
      console.error('unstage all failed:', error);
    }
  }, [repoPath, loadChanges]);

  const handleCommit = useCallback(async () => {
    if (!commitMsg.trim() || staged.length === 0) {
      return;
    }
    setCommitting(true);
    try {
      await invoke('git_commit', { repoPath, message: commitMsg.trim() });
      setCommitMsg('');
      loadChanges();
      onCommitSuccess();
    } catch (error) {
      console.error('commit failed:', error);
    } finally {
      setCommitting(false);
    }
  }, [repoPath, commitMsg, staged.length, loadChanges, onCommitSuccess]);

  const handleDiscard = useCallback(async (files: string[]) => {
    if (!confirm(`Discard changes for ${files.length} file(s)? This cannot be undone.`)) {
      return;
    }
    try {
      await invoke('git_discard_file', { repoPath, files });
      loadChanges();
    } catch (error) {
      console.error('discard failed:', error);
    }
  }, [repoPath, loadChanges]);

  const handleViewDiff = useCallback((file: ChangeFileStatus, area: ChangeArea) => {
    setDiffModal({ open: true, file, area });
  }, []);

  const toggleViewMode = useCallback(() => {
    setViewMode((current) => (current === 'list' ? 'tree' : 'list'));
  }, []);

  const renderFileRow = (
    file: ChangeFileStatus,
    area: ChangeArea,
    displayName: string,
    depth = 0,
  ) => {
    const isStaged = area === 'staged';
    const statusChar = isStaged
      ? statusLabelFor(file.stagedStatus)
      : statusLabelFor(file.unstagedStatus);

    return (
      <div
        key={`${area}-${file.path}`}
        className="group flex cursor-pointer items-center justify-between rounded-[var(--radius-sm)] px-2 py-1 text-sm hover:bg-[var(--border-subtle)]"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => handleViewDiff(file, area)}
        onContextMenu={(event) => {
          event.preventDefault();
          const separator = { separator: true as const };
          const items: Parameters<typeof showContextMenu>[2] = [
            { label: 'View Diff', onClick: () => handleViewDiff(file, area) },
            separator,
            ...(isStaged
              ? [{ label: 'Unstage', onClick: () => handleUnstage([file.path]) }]
              : [{ label: 'Stage', onClick: () => handleStage([file.path]) }]),
            ...(area !== 'staged'
              ? [separator, { label: 'Discard Changes', onClick: () => handleDiscard([file.path]) }]
              : []),
          ];
          showContextMenu(event.clientX, event.clientY, items);
        }}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={`w-4 shrink-0 text-center font-mono text-xs ${statusColor(file, area)}`}>
            {statusChar}
          </span>
          <span className="truncate" title={file.path}>
            {displayName}
          </span>
        </div>
        <button
          type="button"
          className="h-5 w-5 shrink-0 text-sm text-[var(--text-muted)] opacity-0 transition-opacity group-hover:opacity-100 hover:text-[var(--text-primary)]"
          title={isStaged ? 'Unstage' : 'Stage'}
          onClick={(event) => {
            event.stopPropagation();
            if (isStaged) {
              void handleUnstage([file.path]);
            } else {
              void handleStage([file.path]);
            }
          }}
        >
          {isStaged ? '-' : '+'}
        </button>
      </div>
    );
  };

  const renderTreeNode = (node: FileTreeNode, area: ChangeArea, depth: number) => {
    if (node.file) {
      return renderFileRow(node.file, area, node.name, depth);
    }

    const key = `${area}:${node.fullPath}`;
    const isCollapsed = collapsedDirs.has(key);

    return (
      <div key={`dir-${area}-${node.fullPath}`}>
        <div
          className="flex cursor-pointer items-center gap-1 rounded-[var(--radius-sm)] px-2 py-0.5 text-sm text-[var(--text-muted)] hover:bg-[var(--border-subtle)]"
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() => {
            setCollapsedDirs((previous) => {
              const next = new Set(previous);
              if (next.has(key)) {
                next.delete(key);
              } else {
                next.add(key);
              }
              return next;
            });
          }}
        >
          <span
            className="inline-block w-3 text-center text-[11px]"
            style={{
              transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
              transition: 'transform 150ms',
            }}
          >
            ▾
          </span>
          <span>{node.name}</span>
        </div>
        {!isCollapsed && node.children.map((child) => renderTreeNode(child, area, depth + 1))}
      </div>
    );
  };

  const renderFiles = (files: ChangeFileStatus[], area: ChangeArea) => {
    if (viewMode === 'tree') {
      return buildFileTree(files).map((node) => renderTreeNode(node, area, 0));
    }
    return files.map((file) => renderFileRow(file, area, file.path));
  };

  const renderGroup = (
    title: string,
    files: ChangeFileStatus[],
    area: ChangeArea,
    action?: { label: string; onClick: () => void },
  ) => {
    if (files.length === 0) {
      return null;
    }

    return (
      <div className="mb-2">
        <div className="flex items-center justify-between px-2 py-1">
          <span className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
            {title} ({files.length})
          </span>
          {action ? (
            <button
              type="button"
              className="text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
              onClick={action.onClick}
            >
              {action.label}
            </button>
          ) : null}
        </div>
        {renderFiles(files, area)}
      </div>
    );
  };

  const diffModalStatus: GitFileStatus | null = diffModal
    ? {
        path: diffModal.file.path,
        oldPath: diffModal.file.oldPath,
        status: getDiffStatus(diffModal.file, diffModal.area),
        statusLabel: statusLabelFor(getDiffStatus(diffModal.file, diffModal.area)),
      }
    : null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between px-3 py-1.5">
        <button
          type="button"
          className="text-sm text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
          onClick={loadChanges}
          title="Refresh"
        >
          ↻
        </button>
        <button
          type="button"
          className="text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
          onClick={toggleViewMode}
          title={viewMode === 'list' ? 'Switch to tree view' : 'Switch to list view'}
        >
          {viewMode === 'list' ? 'Tree' : 'List'}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-1">
        {loading && changes.length === 0 ? (
          <div className="py-6 text-center text-sm text-[var(--text-muted)]">Loading changes...</div>
        ) : null}

        {!loading && changes.length === 0 ? (
          <div className="py-6 text-center text-sm text-[var(--text-muted)]">No changes</div>
        ) : null}

        {renderGroup('Staged Changes', staged, 'staged', {
          label: 'Unstage All',
          onClick: () => {
            void handleUnstageAll();
          },
        })}
        {renderGroup('Changes', unstaged, 'unstaged', {
          label: 'Stage All',
          onClick: () => {
            void handleStageAll();
          },
        })}
        {renderGroup('Untracked Files', untracked, 'untracked', {
          label: 'Stage All',
          onClick: () => {
            void handleStageAll();
          },
        })}
      </div>

      <div className="shrink-0 border-t border-[var(--border-subtle)] p-2">
        <textarea
          className="w-full resize-none rounded border border-[var(--border-default)] bg-[var(--bg-base)] px-2 py-1.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
          rows={3}
          placeholder="Commit message..."
          value={commitMsg}
          onChange={(event) => setCommitMsg(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              void handleCommit();
            }
          }}
        />
        <button
          type="button"
          className={`mt-1.5 w-full rounded py-1.5 text-sm font-medium transition-colors ${
            commitMsg.trim() && staged.length > 0 && !committing
              ? 'cursor-pointer bg-[var(--accent)] text-white hover:opacity-90'
              : 'cursor-not-allowed bg-[var(--bg-elevated)] text-[var(--text-muted)]'
          }`}
          disabled={!commitMsg.trim() || staged.length === 0 || committing}
          onClick={() => {
            void handleCommit();
          }}
        >
          {committing ? 'Committing...' : `Commit (${staged.length})`}
        </button>
      </div>

      {diffModal && diffModalStatus && repoPath ? (
        <DiffModal
          open={diffModal.open}
          onClose={() => setDiffModal(null)}
          projectPath={repoPath}
          status={diffModalStatus}
        />
      ) : null}
    </div>
  );
}
