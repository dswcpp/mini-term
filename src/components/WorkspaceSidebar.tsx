import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import {
  selectWorkspaceRuntimeSummary,
  selectWorkspaceSections,
  useAppStore,
} from '../store';
import type { RecentWorkspaceEntry, WorkspaceConfig } from '../types';
import { showContextMenu } from '../utils/contextMenu';
import { showPrompt } from '../utils/prompt';
import { getPathBaseName, getWorkspacePrimaryRoot, getWorkspacePrimaryRootPath } from '../utils/workspace';
import { SessionList } from './SessionList';
import { StatusDot } from './StatusDot';

function formatRecentLabel(lastOpenedAt: number) {
  const diff = Date.now() - lastOpenedAt;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`;
  return new Date(lastOpenedAt).toLocaleDateString();
}

function normalizeSearchText(value: string) {
  return value.trim().toLowerCase();
}

function buildWorkspaceSearchText(workspace: WorkspaceConfig | RecentWorkspaceEntry) {
  const rootPaths = 'roots' in workspace ? workspace.roots.map((root) => root.path) : workspace.rootPaths;
  const rootNames = 'roots' in workspace ? workspace.roots.map((root) => root.name) : workspace.rootPaths.map(getPathBaseName);
  return [workspace.name, ...rootNames, ...rootPaths].join(' ').toLowerCase();
}

function WorkspaceRow({
  workspace,
  active,
  section,
  onClick,
  onContextMenu,
}: {
  workspace: WorkspaceConfig;
  active: boolean;
  section: 'pinned' | 'open';
  onClick: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
}) {
  const summary = useAppStore(selectWorkspaceRuntimeSummary(workspace.id));
  const primaryRoot = getWorkspacePrimaryRoot(workspace);
  const rootCount = workspace.roots.length;

  return (
    <div
      className={`group rounded-[var(--radius-md)] border px-2.5 py-2 transition-colors ${
        active
          ? 'border-[var(--accent)] bg-[var(--accent-subtle)]'
          : 'border-transparent bg-transparent hover:border-[var(--border-subtle)] hover:bg-[var(--border-subtle)]'
      }`}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <div className="flex items-center gap-2">
        <StatusDot status={summary.status} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-[var(--text-primary)]">{workspace.name}</span>
            {workspace.pinned ? (
              <span className="rounded-full border border-[var(--border-default)] px-1.5 py-px text-[9px] uppercase tracking-[0.08em] text-[var(--text-muted)]">
                pin
              </span>
            ) : null}
            {section === 'open' ? (
              <span className="rounded-full border border-[var(--border-subtle)] px-1.5 py-px text-[9px] uppercase tracking-[0.08em] text-[var(--text-muted)]">
                open
              </span>
            ) : null}
          </div>
          <div className="truncate text-[11px] text-[var(--text-muted)]">{primaryRoot?.path}</div>
        </div>
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-[10px] uppercase tracking-[0.08em] text-[var(--text-muted)]">
        <span>{rootCount} roots</span>
        <span>{summary.totalTabCount} tabs</span>
        <span>{formatRecentLabel(workspace.lastOpenedAt)}</span>
      </div>
    </div>
  );
}

function RecentRow({
  workspace,
  onClick,
  onContextMenu,
}: {
  workspace: RecentWorkspaceEntry;
  onClick: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
}) {
  return (
    <div
      className="group rounded-[var(--radius-md)] border border-transparent px-2.5 py-2 transition-colors hover:border-[var(--border-subtle)] hover:bg-[var(--border-subtle)]"
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <div className="truncate text-sm font-medium text-[var(--text-primary)]">{workspace.name}</div>
      <div className="truncate text-[11px] text-[var(--text-muted)]">{workspace.rootPaths[0]}</div>
      <div className="mt-1.5 flex items-center gap-2 text-[10px] uppercase tracking-[0.08em] text-[var(--text-muted)]">
        <span>{workspace.rootPaths.length} roots</span>
        <span>{formatRecentLabel(workspace.lastOpenedAt)}</span>
      </div>
    </div>
  );
}

export function WorkspaceSidebar() {
  const { pinned, open: openWorkspaces, recent } = useAppStore(selectWorkspaceSections);
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId);
  const setActiveWorkspace = useAppStore((state) => state.setActiveWorkspace);
  const createWorkspaceFromFolder = useAppStore((state) => state.createWorkspaceFromFolder);
  const createWorkspaceFromFolders = useAppStore((state) => state.createWorkspaceFromFolders);
  const renameWorkspace = useAppStore((state) => state.renameWorkspace);
  const pinWorkspace = useAppStore((state) => state.pinWorkspace);
  const moveWorkspace = useAppStore((state) => state.moveWorkspace);
  const removeWorkspace = useAppStore((state) => state.removeWorkspace);
  const reopenRecentWorkspace = useAppStore((state) => state.reopenRecentWorkspace);
  const forgetRecentWorkspace = useAppStore((state) => state.forgetRecentWorkspace);
  const addRootToWorkspace = useAppStore((state) => state.addRootToWorkspace);
  const setPrimaryWorkspaceRoot = useAppStore((state) => state.setPrimaryWorkspaceRoot);

  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [query, setQuery] = useState('');

  const persistConfig = useCallback(async () => {
    await invoke('save_config', { config: useAppStore.getState().config });
  }, []);

  const handleCreateWorkspace = useCallback(async (multiple: boolean) => {
    const selected = await open({ directory: true, multiple });
    if (!selected) {
      return;
    }

    if (Array.isArray(selected)) {
      const id = createWorkspaceFromFolders(selected, {});
      if (id) {
        await persistConfig();
      }
      return;
    }

    const id = createWorkspaceFromFolder(selected, {});
    if (id) {
      await persistConfig();
    }
  }, [createWorkspaceFromFolder, createWorkspaceFromFolders, persistConfig]);

  const quickSwitcherItems = useMemo(() => {
    const normalizedQuery = normalizeSearchText(query);
    const openItems = [...pinned, ...openWorkspaces].map((workspace) => ({
      id: workspace.id,
      label: workspace.name,
      detail: getWorkspacePrimaryRootPath(workspace) ?? '',
      mode: 'open' as const,
      searchText: buildWorkspaceSearchText(workspace),
    }));
    const recentItems = recent.map((workspace) => ({
      id: workspace.id,
      label: workspace.name,
      detail: workspace.rootPaths[0] ?? '',
      mode: 'recent' as const,
      searchText: buildWorkspaceSearchText(workspace),
    }));

    return [...openItems, ...recentItems].filter((item) =>
      normalizedQuery ? item.searchText.includes(normalizedQuery) : true,
    );
  }, [openWorkspaces, pinned, query, recent]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isSwitcherShortcut = (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'o';
      if (isSwitcherShortcut) {
        event.preventDefault();
        setSwitcherOpen(true);
      }
      if (event.key === 'Escape') {
        setSwitcherOpen(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const handleWorkspaceContextMenu = useCallback(
    (event: React.MouseEvent, workspace: WorkspaceConfig) => {
      event.preventDefault();
      event.stopPropagation();
      const primaryRoot = getWorkspacePrimaryRoot(workspace);
      const items: Parameters<typeof showContextMenu>[2] = [
        {
          label: 'Reveal Primary Root',
          disabled: !primaryRoot,
          onClick: () => primaryRoot && revealItemInDir(primaryRoot.path),
        },
        {
          label: 'Copy Primary Path',
          disabled: !primaryRoot,
          onClick: () => primaryRoot && navigator.clipboard.writeText(primaryRoot.path),
        },
        { separator: true },
        {
          label: 'Rename Workspace',
          onClick: async () => {
            const nextName = await showPrompt('Rename Workspace', 'Enter a new workspace name', workspace.name);
            if (!nextName?.trim()) {
              return;
            }
            renameWorkspace(workspace.id, nextName);
            await persistConfig();
          },
        },
        {
          label: 'Add Folder To Workspace',
          onClick: async () => {
            const selected = await open({ directory: true, multiple: false });
            if (!selected || Array.isArray(selected)) {
              return;
            }
            addRootToWorkspace(workspace.id, selected);
            await persistConfig();
          },
        },
      ];

      for (const root of workspace.roots.filter((root) => root.role !== 'primary')) {
        items.push({
          label: `Set Primary: ${root.name}`,
          onClick: async () => {
            setPrimaryWorkspaceRoot(workspace.id, root.id);
            await persistConfig();
          },
        });
      }

      items.push(
        { separator: true },
        {
          label: workspace.pinned ? 'Unpin Workspace' : 'Pin Workspace',
          onClick: async () => {
            pinWorkspace(workspace.id);
            await persistConfig();
          },
        },
        {
          label: 'Move Up',
          onClick: async () => {
            moveWorkspace(workspace.id, 'up');
            await persistConfig();
          },
        },
        {
          label: 'Move Down',
          onClick: async () => {
            moveWorkspace(workspace.id, 'down');
            await persistConfig();
          },
        },
        { separator: true },
        {
          label: 'Remove From Open',
          danger: true,
          onClick: () => {
            void removeWorkspace(workspace.id);
          },
        },
      );

      showContextMenu(event.clientX, event.clientY, items);
    },
    [addRootToWorkspace, moveWorkspace, persistConfig, pinWorkspace, removeWorkspace, renameWorkspace, setPrimaryWorkspaceRoot],
  );

  const handleRecentContextMenu = useCallback(
    (event: React.MouseEvent, workspace: RecentWorkspaceEntry) => {
      event.preventDefault();
      event.stopPropagation();
      showContextMenu(event.clientX, event.clientY, [
        {
          label: 'Reopen Workspace',
          onClick: async () => {
            const id = reopenRecentWorkspace(workspace.id);
            if (id) {
              await persistConfig();
            }
          },
        },
        {
          label: 'Forget Workspace',
          danger: true,
          onClick: async () => {
            forgetRecentWorkspace(workspace.id);
            await persistConfig();
          },
        },
      ]);
    },
    [forgetRecentWorkspace, persistConfig, reopenRecentWorkspace],
  );

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-[var(--bg-surface)]">
      <div className="flex items-center justify-between px-3 pt-3 pb-1.5">
        <div className="text-sm font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">Workspaces</div>
        <div className="flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
          <button
            type="button"
            className="rounded-[var(--radius-sm)] px-2 py-1 transition-colors hover:bg-[var(--border-subtle)] hover:text-[var(--text-primary)]"
            onClick={() => setSwitcherOpen(true)}
          >
            Switch
          </button>
          <button
            type="button"
            className="rounded-[var(--radius-sm)] px-2 py-1 transition-colors hover:bg-[var(--border-subtle)] hover:text-[var(--text-primary)]"
            onClick={(event) => {
              showContextMenu(event.clientX, event.clientY, [
                {
                  label: 'Open Folder As Workspace',
                  onClick: () => {
                    void handleCreateWorkspace(false);
                  },
                },
                {
                  label: 'Create Multi-root Workspace',
                  onClick: () => {
                    void handleCreateWorkspace(true);
                  },
                },
              ]);
            }}
          >
            +
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-1.5 pb-2">
        <div className="space-y-1.5">
          {pinned.length > 0 ? (
            <>
              <div className="px-2.5 pt-1 text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)]">Pinned</div>
              {pinned.map((workspace) => (
                <WorkspaceRow
                  key={workspace.id}
                  workspace={workspace}
                  active={workspace.id === activeWorkspaceId}
                  section="pinned"
                  onClick={() => setActiveWorkspace(workspace.id)}
                  onContextMenu={(event) => handleWorkspaceContextMenu(event, workspace)}
                />
              ))}
            </>
          ) : null}

          <div className="px-2.5 pt-2 text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)]">Open</div>
          {openWorkspaces.length === 0 ? (
            <div className="px-2.5 py-2 text-xs text-[var(--text-muted)]">No open workspaces</div>
          ) : (
            openWorkspaces.map((workspace) => (
              <WorkspaceRow
                key={workspace.id}
                workspace={workspace}
                active={workspace.id === activeWorkspaceId}
                section="open"
                onClick={() => setActiveWorkspace(workspace.id)}
                onContextMenu={(event) => handleWorkspaceContextMenu(event, workspace)}
              />
            ))
          )}

          <div className="px-2.5 pt-2 text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)]">Recent</div>
          {recent.length === 0 ? (
            <div className="px-2.5 py-2 text-xs text-[var(--text-muted)]">No recent workspaces</div>
          ) : (
            recent.map((workspace) => (
              <RecentRow
                key={workspace.id}
                workspace={workspace}
                onClick={async () => {
                  const id = reopenRecentWorkspace(workspace.id);
                  if (id) {
                    await persistConfig();
                  }
                }}
                onContextMenu={(event) => handleRecentContextMenu(event, workspace)}
              />
            ))
          )}
        </div>
      </div>

      <div className="min-h-[140px] border-t border-[var(--border-subtle)]">
        <SessionList />
      </div>

      {switcherOpen ? (
        <div className="absolute inset-0 z-20 flex items-start justify-center bg-black/30 px-3 pt-12" onClick={() => setSwitcherOpen(false)}>
          <div
            className="w-full max-w-[320px] rounded-[var(--radius-lg)] border border-[var(--border-strong)] bg-[var(--bg-elevated)] shadow-[var(--shadow-overlay)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="border-b border-[var(--border-subtle)] px-3 py-2">
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={async (event) => {
                  if (event.key !== 'Enter') {
                    return;
                  }
                  const first = quickSwitcherItems[0];
                  if (!first) {
                    return;
                  }
                  if (first.mode === 'open') {
                    setActiveWorkspace(first.id);
                  } else {
                    const id = reopenRecentWorkspace(first.id);
                    if (id) {
                      await persistConfig();
                    }
                  }
                  setSwitcherOpen(false);
                  setQuery('');
                }}
                placeholder="Search workspace, root or path"
                className="w-full bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
              />
            </div>
            <div className="max-h-[320px] overflow-y-auto p-1.5">
              {quickSwitcherItems.length === 0 ? (
                <div className="px-2.5 py-4 text-center text-xs text-[var(--text-muted)]">No matching workspace</div>
              ) : (
                quickSwitcherItems.map((item) => (
                  <button
                    key={`${item.mode}:${item.id}`}
                    type="button"
                    className="flex w-full items-center justify-between rounded-[var(--radius-md)] px-2.5 py-2 text-left transition-colors hover:bg-[var(--border-subtle)]"
                    onClick={async () => {
                      if (item.mode === 'open') {
                        setActiveWorkspace(item.id);
                      } else {
                        const id = reopenRecentWorkspace(item.id);
                        if (id) {
                          await persistConfig();
                        }
                      }
                      setSwitcherOpen(false);
                      setQuery('');
                    }}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm text-[var(--text-primary)]">{item.label}</div>
                      <div className="truncate text-[11px] text-[var(--text-muted)]">{item.detail}</div>
                    </div>
                    <span className="ml-3 rounded-full border border-[var(--border-default)] px-1.5 py-px text-[9px] uppercase tracking-[0.08em] text-[var(--text-muted)]">
                      {item.mode}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
