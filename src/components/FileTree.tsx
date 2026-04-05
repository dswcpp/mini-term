import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import {
  toggleExpandedDir,
  useAppStore,
  selectWorkspaceConfig,
} from '../store';
import {
  retainProjectTreeWatch,
  subscribeProjectFs,
  subscribeProjectGitDirty,
} from '../runtime/workspaceRuntime';
import type { FileEntry, GitFileHistoryResult, GitFileStatus, WorkspaceRootConfig } from '../types';
import { showContextMenu } from '../utils/contextMenu';
import { isMarkdownFilePath } from '../utils/markdownPreview';
import { showPrompt } from '../utils/prompt';

const ROW_HEIGHT = 26;
const OVERSCAN_ROWS = 10;

interface VisibleTreeNode {
  entry: FileEntry;
  depth: number;
  root: WorkspaceRootConfig;
  isRoot: boolean;
}

function normalizePath(value: string) {
  return value.replace(/[\\/]+/g, '/').replace(/\/$/, '');
}

function getRelativePath(targetPath: string, rootPath: string) {
  const normalizedRoot = normalizePath(rootPath);
  const normalizedTarget = normalizePath(targetPath);
  const separator = rootPath.includes('\\') ? '\\' : '/';

  if (normalizedTarget === normalizedRoot) {
    return '.';
  }

  if (!normalizedTarget.startsWith(`${normalizedRoot}/`)) {
    return targetPath;
  }

  return normalizedTarget.slice(normalizedRoot.length + 1).replace(/\//g, separator);
}

function isPathAffected(changedPath: string, directoryPath: string) {
  const normalizedChangedPath = normalizePath(changedPath);
  const normalizedDirectoryPath = normalizePath(directoryPath);
  return (
    normalizedChangedPath === normalizedDirectoryPath ||
    normalizedChangedPath.startsWith(`${normalizedDirectoryPath}/`) ||
    normalizedDirectoryPath.startsWith(`${normalizedChangedPath}/`)
  );
}

function belongsToRoot(path: string, rootPath: string) {
  const normalizedRoot = normalizePath(rootPath);
  const normalizedPath = normalizePath(path);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function getPathDetail(path: string) {
  const normalized = normalizePath(path);
  const segments = normalized.split('/');
  segments.pop();
  return segments.join('/');
}

function getBestDirectoryStatusLabel(directoryPath: string, gitStatusMap: Map<string, GitFileStatus>) {
  const normalizedDirectory = normalizePath(directoryPath);
  const prefix = normalizedDirectory === '.' ? '' : `${normalizedDirectory}/`;
  const priority: Record<string, number> = { C: 6, D: 5, M: 4, A: 3, R: 2, '?': 1 };

  let bestLabel = '';
  let bestPriority = 0;
  for (const [path, status] of gitStatusMap) {
    if (prefix && !path.startsWith(prefix)) {
      continue;
    }

    const currentPriority = priority[status.statusLabel] ?? 0;
    if (currentPriority > bestPriority) {
      bestPriority = currentPriority;
      bestLabel = status.statusLabel;
    }
  }

  return bestLabel;
}

function flattenEntries(
  root: WorkspaceRootConfig,
  entriesByDirectory: Map<string, FileEntry[]>,
  expandedPaths: Set<string>,
  output: VisibleTreeNode[],
) {
  const walk = (entries: FileEntry[], depth: number) => {
    for (const entry of entries) {
      output.push({ entry, depth, root, isRoot: false });
      if (!entry.isDir || !expandedPaths.has(entry.path)) {
        continue;
      }
      const children = entriesByDirectory.get(entry.path);
      if (!children || children.length === 0) {
        continue;
      }
      walk(children, depth + 1);
    }
  };

  output.push({
    entry: {
      name: root.name,
      path: root.path,
      isDir: true,
    },
    depth: 0,
    root,
    isRoot: true,
  });

  if (!expandedPaths.has(root.path)) {
    return;
  }

  walk(entriesByDirectory.get(root.path) ?? [], 1);
}

export function FileTree() {
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId);
  const openFileViewer = useAppStore((state) => state.openFileViewer);
  const openWorktreeDiff = useAppStore((state) => state.openWorktreeDiff);
  const openFileHistory = useAppStore((state) => state.openFileHistory);
  const createTerminalTab = useAppStore((state) => state.createTerminalTab);
  const workspace = useAppStore(selectWorkspaceConfig(activeWorkspaceId));

  const [entriesByDirectory, setEntriesByDirectory] = useState<Map<string, FileEntry[]>>(new Map());
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [gitStatusByRoot, setGitStatusByRoot] = useState<Map<string, Map<string, GitFileStatus>>>(new Map());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(320);

  const listRef = useRef<HTMLDivElement | null>(null);
  const expandedPathsRef = useRef(expandedPaths);
  expandedPathsRef.current = expandedPaths;

  const loadDirectory = useCallback(
    async (rootPath: string, directoryPath: string) => {
      const entries = await invoke<FileEntry[]>('list_directory', {
        projectRoot: rootPath,
        path: directoryPath,
      });

      setEntriesByDirectory((prev) => {
        const next = new Map(prev);
        next.set(directoryPath, entries);
        return next;
      });
    },
    [],
  );

  const loadGitStatus = useCallback(async (root: WorkspaceRootConfig) => {
    try {
      const statuses = await invoke<GitFileStatus[]>('get_git_status', { projectPath: root.path });
      const next = new Map<string, GitFileStatus>();
      for (const status of statuses) {
        next.set(normalizePath(status.path), status);
      }
      setGitStatusByRoot((prev) => {
        const map = new Map(prev);
        map.set(root.id, next);
        return map;
      });
    } catch {
      setGitStatusByRoot((prev) => {
        const map = new Map(prev);
        map.set(root.id, new Map());
        return map;
      });
    }
  }, []);

  useEffect(() => {
    if (!workspace) {
      setEntriesByDirectory(new Map());
      setExpandedPaths(new Set());
      setGitStatusByRoot(new Map());
      return;
    }

    const initialExpanded = new Set<string>();
    for (const root of workspace.roots) {
      initialExpanded.add(root.path);
      const persisted = workspace.expandedDirsByRoot?.[root.id] ?? [];
      persisted.forEach((path) => initialExpanded.add(path));
    }

    setExpandedPaths(initialExpanded);
    setEntriesByDirectory(new Map());
    setGitStatusByRoot(new Map());

    for (const root of workspace.roots) {
      void loadDirectory(root.path, root.path);
      void loadGitStatus(root);
      for (const path of workspace.expandedDirsByRoot?.[root.id] ?? []) {
        void loadDirectory(root.path, path);
      }
    }
  }, [loadDirectory, loadGitStatus, workspace]);

  useEffect(() => {
    if (!workspace) {
      return;
    }

    const disposers: Array<() => void> = [];
    for (const root of workspace.roots) {
      const releaseWatch = retainProjectTreeWatch(root.path);
      const unsubscribeFs = subscribeProjectFs(root.path, (events) => {
        const loadedDirectories = new Set<string>(
          [root.path, ...expandedPathsRef.current].filter((path) => belongsToRoot(path, root.path)),
        );
        for (const directoryPath of loadedDirectories) {
          if (events.some((event) => isPathAffected(event.path, directoryPath))) {
            void loadDirectory(root.path, directoryPath);
          }
        }
      });
      const unsubscribeGitDirty = subscribeProjectGitDirty(root.path, () => {
        void loadGitStatus(root);
      });
      disposers.push(() => {
        unsubscribeFs();
        unsubscribeGitDirty();
        releaseWatch();
      });
    }

    return () => {
      disposers.forEach((dispose) => dispose());
    };
  }, [loadDirectory, loadGitStatus, workspace]);

  useEffect(() => {
    const element = listRef.current;
    if (!element) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const nextHeight = entries[0]?.contentRect.height ?? element.clientHeight;
      setViewportHeight(Math.max(0, nextHeight));
    });

    observer.observe(element);
    setViewportHeight(element.clientHeight);
    return () => observer.disconnect();
  }, [workspace?.id]);

  const visibleNodes = useMemo(() => {
    if (!workspace) {
      return [];
    }

    const output: VisibleTreeNode[] = [];
    for (const root of workspace.roots) {
      flattenEntries(root, entriesByDirectory, expandedPaths, output);
    }
    return output;
  }, [entriesByDirectory, expandedPaths, workspace]);

  const visibleRange = useMemo(() => {
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS);
    const end = Math.min(
      visibleNodes.length,
      Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN_ROWS,
    );
    return { start, end };
  }, [scrollTop, viewportHeight, visibleNodes.length]);

  const totalHeight = visibleNodes.length * ROW_HEIGHT;
  const offsetTop = visibleRange.start * ROW_HEIGHT;
  const renderedNodes = visibleNodes.slice(visibleRange.start, visibleRange.end);

  const handleOpenFile = useCallback(
    (filePath: string, options?: { initialPreview?: boolean }) => {
      if (!workspace) {
        return;
      }
      openFileViewer(workspace.id, filePath, {
        initialMode: options?.initialPreview ? 'preview' : 'source',
      });
    },
    [openFileViewer, workspace],
  );

  const handleOpenDiff = useCallback(
    (root: WorkspaceRootConfig, status: GitFileStatus) => {
      if (!workspace) {
        return;
      }
      openWorktreeDiff(workspace.id, root.path, status);
    },
    [openWorktreeDiff, workspace],
  );

  const resolveFileHistoryMenuItem = useCallback(
    async (root: WorkspaceRootConfig, entry: FileEntry, gitStatus?: GitFileStatus) => {
      if (!workspace || entry.isDir) {
        return null;
      }

      if (entry.ignored) {
        return {
          label: '查看修改历史（已忽略）',
          disabled: true,
        };
      }

      if (gitStatus?.status === 'untracked') {
        return {
          label: '查看修改历史（未纳入 Git）',
          disabled: true,
        };
      }

      if (gitStatus?.status === 'added') {
        return {
          label: '查看修改历史（尚无提交记录）',
          disabled: true,
        };
      }

      try {
        const result = await invoke<GitFileHistoryResult>('get_file_git_history', {
          projectPath: root.path,
          filePath: entry.path,
          beforeCommit: null,
          limit: 1,
        });

        if (result.entries.length === 0) {
          return {
            label: '查看修改历史（暂无提交记录）',
            disabled: true,
          };
        }

        return {
          label: '查看修改历史',
          disabled: false,
          onClick: () => openFileHistory(workspace.id, root.path, entry.path),
        };
      } catch {
        return {
          label: '查看修改历史（不在 Git 仓库中）',
          disabled: true,
        };
      }
    },
    [openFileHistory, workspace],
  );

  const handleToggleEntry = useCallback(
    async (node: VisibleTreeNode) => {
      if (!workspace) {
        return;
      }

      const { entry, root } = node;
      if (!entry.isDir) {
        const relativePath = normalizePath(getRelativePath(entry.path, root.path));
        const fileStatus = gitStatusByRoot.get(root.id)?.get(relativePath);
        if (fileStatus) {
          handleOpenDiff(root, fileStatus);
        } else {
          handleOpenFile(entry.path);
        }
        return;
      }

      const nextExpanded = !expandedPaths.has(entry.path);
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        if (nextExpanded) next.add(entry.path);
        else next.delete(entry.path);
        return next;
      });
      toggleExpandedDir(workspace.id, root.id, entry.path, nextExpanded);

      if (nextExpanded) {
        await loadDirectory(root.path, entry.path);
      }
    },
    [expandedPaths, gitStatusByRoot, handleOpenDiff, handleOpenFile, loadDirectory, workspace],
  );

  const handleEntryContextMenu = useCallback(
    async (event: React.MouseEvent, node: VisibleTreeNode) => {
      if (!workspace) {
        return;
      }

      const { entry, root, isRoot } = node;
      event.preventDefault();
      event.stopPropagation();

      const relativePath = getRelativePath(entry.path, root.path);
      const normalizedRelativePath = normalizePath(relativePath);
      const gitStatus = gitStatusByRoot.get(root.id)?.get(normalizedRelativePath);
      const separator = root.path.includes('/') ? '/' : '\\';
      const clientX = event.clientX;
      const clientY = event.clientY;
      const items: Parameters<typeof showContextMenu>[2] = [];

      if (!entry.isDir) {
        if (isMarkdownFilePath(entry.path)) {
          items.push({
            label: 'Markdown Preview',
            onClick: () => handleOpenFile(entry.path, { initialPreview: true }),
          });
        }
        items.push(
          {
            label: 'Open In App',
            onClick: () => handleOpenFile(entry.path),
          },
          {
            label: 'Open With Default App',
            onClick: () => openPath(entry.path),
          },
          { separator: true },
        );
      }

      items.push(
        {
          label: 'Copy Relative Path',
          onClick: () => writeText(relativePath),
        },
        {
          label: 'Copy Absolute Path',
          onClick: () => writeText(entry.path),
        },
        { separator: true },
        {
          label: isRoot ? 'Reveal Root In Explorer' : 'Reveal In Explorer',
          onClick: () => revealItemInDir(entry.path),
        },
      );

      if (entry.isDir) {
        items.push(
          { separator: true },
          {
            label: 'New Terminal Here',
            onClick: () => {
              void createTerminalTab(workspace.id, { cwd: entry.path });
            },
          },
          {
            label: 'New File',
            onClick: async () => {
              const name = await showPrompt('New File', 'Enter file name');
              if (!name?.trim()) {
                return;
              }
              await invoke('create_file', { path: `${entry.path}${separator}${name.trim()}` });
              await loadDirectory(root.path, entry.path);
            },
          },
          {
            label: 'New Folder',
            onClick: async () => {
              const name = await showPrompt('New Folder', 'Enter folder name');
              if (!name?.trim()) {
                return;
              }
              await invoke('create_directory', { path: `${entry.path}${separator}${name.trim()}` });
              await loadDirectory(root.path, entry.path);
            },
          },
        );
      }

      if (!entry.isDir) {
        const fileHistoryItem = await resolveFileHistoryMenuItem(root, entry, gitStatus);
        if (fileHistoryItem) {
          items.push({ separator: true }, fileHistoryItem);
        }
      }

      if (gitStatus && !entry.isDir) {
        items.push(
          { separator: true },
          {
            label: 'View Diff',
            onClick: () => handleOpenDiff(root, gitStatus),
          },
        );
      }

      showContextMenu(clientX, clientY, items);
    },
    [
      createTerminalTab,
      gitStatusByRoot,
      handleOpenDiff,
      handleOpenFile,
      loadDirectory,
      resolveFileHistoryMenuItem,
      workspace,
    ],
  );

  if (!workspace) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--bg-surface)] text-base text-[var(--text-muted)]">
        Select a workspace
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden border-l border-[var(--border-subtle)] bg-[var(--bg-surface)]">
      <div className="px-3 pt-3 pb-1.5 text-sm font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">
        Files / {workspace.name}
      </div>

      <div
        ref={listRef}
        className="flex-1 overflow-auto px-1"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        {visibleNodes.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">
            Empty workspace
          </div>
        ) : (
          <div style={{ height: `${totalHeight}px`, position: 'relative' }}>
            <div style={{ transform: `translateY(${offsetTop}px)` }}>
              {renderedNodes.map((node, index) => {
                const relativePath = normalizePath(getRelativePath(node.entry.path, node.root.path));
                const gitStatus = gitStatusByRoot.get(node.root.id)?.get(relativePath);
                const directoryStatusLabel = node.entry.isDir
                  ? getBestDirectoryStatusLabel(relativePath, gitStatusByRoot.get(node.root.id) ?? new Map())
                  : undefined;
                const statusLabel = gitStatus?.statusLabel ?? directoryStatusLabel;
                const statusTone = statusLabel === 'M'
                  ? 'text-[var(--color-warning)]'
                  : statusLabel === 'A' || statusLabel === '?'
                    ? 'text-[var(--color-success)]'
                    : statusLabel === 'D' || statusLabel === 'C'
                      ? 'text-[var(--color-error)]'
                      : statusLabel === 'R'
                        ? 'text-[var(--color-info)]'
                        : 'text-[var(--text-muted)]';

                return (
                  <div
                    key={`${node.root.id}:${node.entry.path}`}
                    className={`flex cursor-pointer items-center gap-1 rounded-[var(--radius-sm)] py-[3px] text-base transition-colors duration-100 hover:bg-[var(--border-subtle)] ${
                      node.entry.ignored
                        ? 'text-[var(--text-muted)] opacity-50'
                        : node.entry.isDir
                          ? 'text-[var(--color-folder)]'
                          : 'text-[var(--color-file)]'
                    }`}
                    style={{
                      height: `${ROW_HEIGHT}px`,
                      paddingLeft: `${node.depth * 16 + 8}px`,
                    }}
                    onClick={() => {
                      void handleToggleEntry(node);
                    }}
                    onContextMenu={(event) => handleEntryContextMenu(event, node)}
                    draggable={!node.entry.isDir}
                    onDragStart={(event) => {
                      event.dataTransfer.setData('text/plain', node.entry.path);
                      event.dataTransfer.effectAllowed = 'copy';
                    }}
                    title={!node.entry.isDir ? getPathDetail(relativePath) : node.entry.path}
                    data-index={visibleRange.start + index}
                  >
                    {node.entry.isDir ? (
                      <span
                        className="w-3 text-center text-[13px] text-[var(--text-muted)] transition-transform duration-150"
                        style={{
                          transform: expandedPaths.has(node.entry.path) ? 'rotate(0deg)' : 'rotate(-90deg)',
                          display: 'inline-block',
                        }}
                      >
                        ▾
                      </span>
                    ) : (
                      <span className="w-3 text-center text-xs text-[var(--text-muted)]">•</span>
                    )}
                    <span className="truncate">
                      {node.isRoot ? `${node.entry.name} (${node.root.role})` : node.entry.name}
                    </span>
                    {statusLabel ? (
                      <span className={`ml-1.5 flex-shrink-0 text-xs font-bold ${statusTone}`}>
                        {statusLabel}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
