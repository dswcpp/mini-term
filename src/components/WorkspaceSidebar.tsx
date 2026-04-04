import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Allotment } from 'allotment';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { useShallow } from 'zustand/react/shallow';
import {
  selectWorkspaceRuntimeSummary,
  useAppStore,
} from '../store';
import type { RecentWorkspaceEntry, WorkspaceConfig } from '../types';
import { showContextMenu } from '../utils/contextMenu';
import { showAlert } from '../utils/messageBox';
import { showPrompt } from '../utils/prompt';
import {
  getPathBaseName,
  getWorkspaceCopyName,
  getWorkspacePrimaryRoot,
  getWorkspacePrimaryRootPath,
  normalizeWorkspacePath,
} from '../utils/workspace';
import { SessionList } from './SessionList';
import { StatusDot } from './StatusDot';

const MAX_ROOT_BADGES = 3;
const DEFAULT_SIDEBAR_PANEL_SIZES = [68, 32];
const SIDEBAR_PANEL_SIZE_TOLERANCE = 0.5;

function areSidebarPanelSizesEquivalent(left: number[], right: number[]) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => Math.abs(value - right[index]) < SIDEBAR_PANEL_SIZE_TOLERANCE);
}

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

function getWorkspaceRootBadges(workspace: WorkspaceConfig) {
  const badges = workspace.roots.slice(0, MAX_ROOT_BADGES).map((root) => ({
    id: root.id,
    label: root.role === 'primary' ? root.name : `+ ${root.name}`,
    title: root.path,
    primary: root.role === 'primary',
  }));

  if (workspace.roots.length > MAX_ROOT_BADGES) {
    badges.push({
      id: `${workspace.id}-more`,
      label: `+${workspace.roots.length - MAX_ROOT_BADGES}`,
      title: `${workspace.roots.length - MAX_ROOT_BADGES} more roots`,
      primary: false,
    });
  }

  return badges;
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
  const summary = useAppStore(useShallow(selectWorkspaceRuntimeSummary(workspace.id)));
  const primaryRoot = getWorkspacePrimaryRoot(workspace);
  const rootCount = workspace.roots.length;
  const rootBadges = getWorkspaceRootBadges(workspace);

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
      <div className="mt-1.5 flex flex-wrap gap-1">
        {rootBadges.map((badge) => (
          <span
            key={badge.id}
            title={badge.title}
            className={`rounded-full border px-1.5 py-px text-[9px] tracking-[0.08em] ${
              badge.primary
                ? 'border-[var(--accent)]/40 bg-[var(--accent-subtle)] text-[var(--accent)]'
                : 'border-[var(--border-default)] text-[var(--text-muted)]'
            }`}
          >
            {badge.label}
          </span>
        ))}
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
  const allWorkspaces = useAppStore((state) => state.config.workspaces);
  const recentWorkspaces = useAppStore((state) => state.config.recentWorkspaces);
  const workspaceSidebarSizes = useAppStore((state) => state.config.workspaceSidebarSizes);
  const setConfig = useAppStore((state) => state.setConfig);

  const pinned = useMemo(() => allWorkspaces.filter((w) => w.pinned), [allWorkspaces]);
  const openWorkspaces = useMemo(() => allWorkspaces.filter((w) => !w.pinned), [allWorkspaces]);
  const recent = useMemo(
    () => [...recentWorkspaces].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt),
    [recentWorkspaces],
  );
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId);
  const workspaceById = useAppStore((state) => state.workspaceById);
  const workspaceIdByRootPath = useAppStore((state) => state.workspaceIdByRootPath);
  const setActiveWorkspace = useAppStore((state) => state.setActiveWorkspace);
  const createWorkspaceFromFolder = useAppStore((state) => state.createWorkspaceFromFolder);
  const createWorkspaceFromFolders = useAppStore((state) => state.createWorkspaceFromFolders);
  const duplicateWorkspace = useAppStore((state) => state.duplicateWorkspace);
  const renameWorkspace = useAppStore((state) => state.renameWorkspace);
  const pinWorkspace = useAppStore((state) => state.pinWorkspace);
  const moveWorkspace = useAppStore((state) => state.moveWorkspace);
  const removeWorkspace = useAppStore((state) => state.removeWorkspace);
  const reopenRecentWorkspace = useAppStore((state) => state.reopenRecentWorkspace);
  const forgetRecentWorkspace = useAppStore((state) => state.forgetRecentWorkspace);
  const addRootToWorkspace = useAppStore((state) => state.addRootToWorkspace);
  const renameWorkspaceRoot = useAppStore((state) => state.renameWorkspaceRoot);
  const moveWorkspaceRoot = useAppStore((state) => state.moveWorkspaceRoot);
  const removeRootFromWorkspace = useAppStore((state) => state.removeRootFromWorkspace);
  const setPrimaryWorkspaceRoot = useAppStore((state) => state.setPrimaryWorkspaceRoot);

  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const sidebarSaveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const ignoreInitialSplitRef = useRef(true);
  const initialSidebarSizesRef = useRef<number[]>(
    workspaceSidebarSizes?.length === 2 ? [...workspaceSidebarSizes] : [...DEFAULT_SIDEBAR_PANEL_SIZES],
  );

  const persistConfig = useCallback(async () => {
    await invoke('save_config', { config: useAppStore.getState().config });
  }, []);

  useEffect(() => () => clearTimeout(sidebarSaveTimerRef.current), []);

  const saveWorkspaceSidebarSizes = useCallback(
    (sizes: number[]) => {
      clearTimeout(sidebarSaveTimerRef.current);
      sidebarSaveTimerRef.current = setTimeout(() => {
        const currentConfig = useAppStore.getState().config;
        const currentSizes =
          currentConfig.workspaceSidebarSizes?.length === 2
            ? currentConfig.workspaceSidebarSizes
            : DEFAULT_SIDEBAR_PANEL_SIZES;
        if (areSidebarPanelSizesEquivalent(currentSizes, sizes)) {
          return;
        }

        const nextConfig = {
          ...currentConfig,
          workspaceSidebarSizes: sizes,
        };
        setConfig(nextConfig);
        void invoke('save_config', { config: useAppStore.getState().config });
      }, 240);
    },
    [setConfig],
  );

  const getOwnedWorkspacesForPaths = useCallback((paths: string[]) => {
    const ownerIds = Array.from(
      new Set(
        paths
          .map((path) => workspaceIdByRootPath.get(normalizeWorkspacePath(path)))
          .filter((workspaceId): workspaceId is string => Boolean(workspaceId)),
      ),
    );

    return ownerIds
      .map((workspaceId) => workspaceById.get(workspaceId))
      .filter((workspace): workspace is WorkspaceConfig => Boolean(workspace));
  }, [workspaceById, workspaceIdByRootPath]);

  const handleCreateWorkspace = useCallback(async (multiple: boolean) => {
    const selected = await open({ directory: true, multiple });
    if (!selected) {
      return;
    }

    if (Array.isArray(selected)) {
      const ownerWorkspaces = getOwnedWorkspacesForPaths(selected);
      if (ownerWorkspaces.length > 1) {
        await showAlert(
          'Folders Already Belong To Multiple Workspaces',
          'Mini-Term will not duplicate the same root across several open workspaces.',
          {
            detail: ownerWorkspaces.map((workspace) => `- ${workspace.name}`).join('\n'),
            tone: 'warning',
          },
        );
        return;
      }

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
  }, [createWorkspaceFromFolder, createWorkspaceFromFolders, getOwnedWorkspacesForPaths, persistConfig]);

  const quickSwitcherItems = useMemo(() => {
    const normalizedQuery = normalizeSearchText(query);
    const pinnedItems = pinned.map((workspace) => ({
      id: workspace.id,
      label: workspace.name,
      detail: getWorkspacePrimaryRootPath(workspace) ?? '',
      mode: 'pinned' as const,
      searchText: buildWorkspaceSearchText(workspace),
    }));
    const openItems = openWorkspaces.map((workspace) => ({
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

    return [...pinnedItems, ...openItems, ...recentItems].filter((item) =>
      normalizedQuery ? item.searchText.includes(normalizedQuery) : true,
    );
  }, [openWorkspaces, pinned, query, recent]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query, switcherOpen]);

  useEffect(() => {
    if (quickSwitcherItems.length === 0) {
      setSelectedIndex(0);
      return;
    }

    setSelectedIndex((current) => Math.min(current, quickSwitcherItems.length - 1));
  }, [quickSwitcherItems]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isSwitcherShortcut = (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'o';
      if (isSwitcherShortcut) {
        event.preventDefault();
        setSwitcherOpen(true);
        setQuery('');
        setSelectedIndex(0);
      }
      if (event.key === 'Escape') {
        setSwitcherOpen(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const activateQuickSwitcherItem = useCallback(async (index: number) => {
    const item = quickSwitcherItems[index];
    if (!item) {
      return;
    }

    if (item.mode === 'recent') {
      const id = reopenRecentWorkspace(item.id);
      if (id) {
        await persistConfig();
      }
    } else {
      setActiveWorkspace(item.id);
    }

    setSwitcherOpen(false);
    setQuery('');
  }, [persistConfig, quickSwitcherItems, reopenRecentWorkspace, setActiveWorkspace]);

  const allWorkspaceNames = useMemo(
    () => [...pinned, ...openWorkspaces, ...recent].map((workspace) => workspace.name),
    [openWorkspaces, pinned, recent],
  );

  const handleWorkspaceContextMenu = useCallback(
    (event: React.MouseEvent, workspace: WorkspaceConfig) => {
      event.preventDefault();
      event.stopPropagation();
      const primaryRoot = getWorkspacePrimaryRoot(workspace);
      const rootItems: Parameters<typeof showContextMenu>[2] = workspace.roots.map((root, index) => {
        const children: Parameters<typeof showContextMenu>[2] = [
          {
            label: 'Reveal In Explorer',
            onClick: () => revealItemInDir(root.path),
          },
          {
            label: 'Copy Path',
            onClick: () => navigator.clipboard.writeText(root.path),
          },
          { separator: true },
          {
            label: 'Rename Root',
            onClick: async () => {
              const nextName = await showPrompt('Rename Root', 'Enter a root label', root.name);
              if (!nextName?.trim()) {
                return;
              }
              renameWorkspaceRoot(workspace.id, root.id, nextName);
              await persistConfig();
            },
          },
          {
            label: 'Set As Primary',
            disabled: root.role === 'primary',
            onClick: async () => {
              setPrimaryWorkspaceRoot(workspace.id, root.id);
              await persistConfig();
            },
          },
          {
            label: 'Move Up',
            disabled: index === 0,
            onClick: async () => {
              moveWorkspaceRoot(workspace.id, root.id, 'up');
              await persistConfig();
            },
          },
          {
            label: 'Move Down',
            disabled: index === workspace.roots.length - 1,
            onClick: async () => {
              moveWorkspaceRoot(workspace.id, root.id, 'down');
              await persistConfig();
            },
          },
          { separator: true },
          {
            label: 'Remove Root',
            danger: true,
            disabled: workspace.roots.length <= 1,
            onClick: async () => {
              removeRootFromWorkspace(workspace.id, root.id);
              await persistConfig();
            },
          },
        ];

        return {
          label: root.name,
          checked: root.role === 'primary',
          children,
        };
      });
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
          label: 'Save Workspace As...',
          onClick: async () => {
            const nextName = await showPrompt(
              'Save Workspace As',
              'Enter a name for the duplicated workspace',
              getWorkspaceCopyName(allWorkspaceNames, workspace.name),
            );
            if (!nextName?.trim()) {
              return;
            }
            const id = await duplicateWorkspace(workspace.id, { name: nextName, restoreTabs: true });
            if (id) {
              await persistConfig();
            }
          },
        },
        {
          label: 'Duplicate Workspace',
          onClick: async () => {
            const id = await duplicateWorkspace(workspace.id, {
              name: getWorkspaceCopyName(allWorkspaceNames, workspace.name),
              restoreTabs: true,
            });
            if (id) {
              await persistConfig();
            }
          },
        },
        {
          label: 'Add Folder To Workspace',
          onClick: async () => {
            const selected = await open({ directory: true, multiple: false });
            if (!selected || Array.isArray(selected)) {
              return;
            }

            const normalizedSelectedPath = normalizeWorkspacePath(selected);
            const existingWorkspaceId = workspaceIdByRootPath.get(normalizedSelectedPath);
            if (existingWorkspaceId === workspace.id) {
              await showAlert('Folder Already In Workspace', 'That folder is already part of this workspace.', {
                detail: selected,
              });
              return;
            }
            if (existingWorkspaceId) {
              const owner = workspaceById.get(existingWorkspaceId);
              await showAlert(
                'Folder Already Open Elsewhere',
                'Add the folder to its existing workspace, or remove it there before reusing it.',
                {
                  detail: owner ? `${selected}\n\nCurrent workspace: ${owner.name}` : selected,
                  tone: 'warning',
                },
              );
              return;
            }

            addRootToWorkspace(workspace.id, selected);
            await persistConfig();
          },
        },
        {
          label: 'Roots',
          children: rootItems,
        },
      ];

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
    [
      addRootToWorkspace,
      allWorkspaceNames,
      duplicateWorkspace,
      moveWorkspace,
      moveWorkspaceRoot,
      persistConfig,
      pinWorkspace,
      removeRootFromWorkspace,
      removeWorkspace,
      renameWorkspace,
      renameWorkspaceRoot,
      setPrimaryWorkspaceRoot,
      workspaceById,
      workspaceIdByRootPath,
    ],
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

  const handleSidebarSplitChange = useCallback(
    (sizes: number[]) => {
      if (ignoreInitialSplitRef.current) {
        ignoreInitialSplitRef.current = false;
        return;
      }

      if (sizes.length !== 2) {
        return;
      }

      saveWorkspaceSidebarSizes(sizes);
    },
    [saveWorkspaceSidebarSizes],
  );

  const resolvedSidebarSizes =
    workspaceSidebarSizes?.length === 2 ? workspaceSidebarSizes : DEFAULT_SIDEBAR_PANEL_SIZES;

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-[var(--bg-surface)]">
      <Allotment vertical defaultSizes={initialSidebarSizesRef.current ?? resolvedSidebarSizes} onChange={handleSidebarSplitChange}>
        <Allotment.Pane minSize={220}>
          <div className="flex h-full flex-col overflow-hidden">
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
          </div>
        </Allotment.Pane>

        <Allotment.Pane minSize={140}>
          <div className="h-full border-t border-[var(--border-subtle)]">
            <SessionList />
          </div>
        </Allotment.Pane>
      </Allotment>

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
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    if (quickSwitcherItems.length > 0) {
                      setSelectedIndex((current) => (current + 1) % quickSwitcherItems.length);
                    }
                    return;
                  }
                  if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    if (quickSwitcherItems.length > 0) {
                      setSelectedIndex((current) => (current - 1 + quickSwitcherItems.length) % quickSwitcherItems.length);
                    }
                    return;
                  }
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    await activateQuickSwitcherItem(selectedIndex);
                    return;
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setSwitcherOpen(false);
                    setQuery('');
                  }
                }}
                placeholder="Search workspace, root or path"
                className="w-full bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
              />
            </div>
            <div className="max-h-[320px] overflow-y-auto p-1.5">
              {quickSwitcherItems.length === 0 ? (
                <div className="px-2.5 py-4 text-center text-xs text-[var(--text-muted)]">No matching workspace</div>
              ) : (
                quickSwitcherItems.map((item, index) => (
                  <button
                    key={`${item.mode}:${item.id}`}
                    type="button"
                    data-selected={index === selectedIndex}
                    className={`flex w-full items-center justify-between rounded-[var(--radius-md)] px-2.5 py-2 text-left transition-colors ${
                      index === selectedIndex
                        ? 'bg-[var(--accent-subtle)] text-[var(--text-primary)]'
                        : 'hover:bg-[var(--border-subtle)]'
                    }`}
                    onMouseEnter={() => setSelectedIndex(index)}
                    onClick={() => {
                      void activateQuickSwitcherItem(index);
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
            <div className="border-t border-[var(--border-subtle)] px-3 py-2 text-[10px] uppercase tracking-[0.08em] text-[var(--text-muted)]">
              Enter opens selected · Up/Down navigates · Esc closes
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
