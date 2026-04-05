import { useEffect, useMemo, useRef } from 'react';
import { useAppStore, selectWorkspaceExplorerRuntime } from '../store';
import type { FsChangePayload } from '../types';
import { subscribeProjectFs, subscribeProjectGitDirty } from '../runtime/workspaceRuntime';
import { normalizeWorkspacePath } from '../utils/workspace';

interface UseWorkspaceAutoRefreshOptions {
  active: boolean;
  projectPath?: string;
  filePaths?: string[];
  watchFs?: boolean;
  watchGit?: boolean;
  fsDebounceMs?: number;
  gitDebounceMs?: number;
  onFsChange?: (events: FsChangePayload[]) => void | Promise<void>;
  onGitDirty?: () => void | Promise<void>;
}

const DEFAULT_FS_DEBOUNCE_MS = 200;
const DEFAULT_GIT_DEBOUNCE_MS = 300;

function buildSyntheticFsEvents(projectPath: string, paths: string[]): FsChangePayload[] {
  return paths.map((path) => ({
    projectPath,
    path,
    kind: 'refresh',
  }));
}

export function useWorkspaceAutoRefresh({
  active,
  projectPath,
  filePaths = [],
  watchFs = false,
  watchGit = false,
  fsDebounceMs = DEFAULT_FS_DEBOUNCE_MS,
  gitDebounceMs = DEFAULT_GIT_DEBOUNCE_MS,
  onFsChange,
  onGitDirty,
}: UseWorkspaceAutoRefreshOptions) {
  const onFsChangeRef = useRef(onFsChange);
  const onGitDirtyRef = useRef(onGitDirty);

  onFsChangeRef.current = onFsChange;
  onGitDirtyRef.current = onGitDirty;

  const normalizedProjectPath = useMemo(
    () => (projectPath ? normalizeWorkspacePath(projectPath) : undefined),
    [projectPath],
  );
  const explorerRuntime = useAppStore(selectWorkspaceExplorerRuntime(normalizedProjectPath));
  const normalizedFilePaths = useMemo(
    () => Array.from(new Set(filePaths.map(normalizeWorkspacePath).filter(Boolean))).sort(),
    [filePaths],
  );
  const normalizedFilePathSet = useMemo(() => new Set(normalizedFilePaths), [normalizedFilePaths]);
  const previousActiveRef = useRef(active);
  const lastHandledFsChangeAtRef = useRef(0);
  const lastHandledGitDirtyTokenRef = useRef(0);

  useEffect(() => {
    if (!active || !normalizedProjectPath) {
      return;
    }

    let fsTimer: number | null = null;
    let gitTimer: number | null = null;

    const clearFsTimer = () => {
      if (fsTimer != null) {
        window.clearTimeout(fsTimer);
        fsTimer = null;
      }
    };

    const clearGitTimer = () => {
      if (gitTimer != null) {
        window.clearTimeout(gitTimer);
        gitTimer = null;
      }
    };

    const unsubscribeFs =
      watchFs && onFsChangeRef.current
        ? subscribeProjectFs(normalizedProjectPath, (events) => {
            const matchedEvents =
              normalizedFilePathSet.size === 0
                ? events
                : events.filter((event) => normalizedFilePathSet.has(normalizeWorkspacePath(event.path)));

            if (matchedEvents.length === 0) {
              return;
            }

            clearFsTimer();
            fsTimer = window.setTimeout(() => {
              lastHandledFsChangeAtRef.current =
                selectWorkspaceExplorerRuntime(normalizedProjectPath)(useAppStore.getState())?.lastFsChangeAt ?? Date.now();
              void onFsChangeRef.current?.(matchedEvents);
              fsTimer = null;
            }, fsDebounceMs);
          })
        : undefined;

    const unsubscribeGit =
      watchGit && onGitDirtyRef.current
        ? subscribeProjectGitDirty(normalizedProjectPath, () => {
            clearGitTimer();
            gitTimer = window.setTimeout(() => {
              lastHandledGitDirtyTokenRef.current =
                selectWorkspaceExplorerRuntime(normalizedProjectPath)(useAppStore.getState())?.gitDirtyToken ?? 0;
              void onGitDirtyRef.current?.();
              gitTimer = null;
            }, gitDebounceMs);
          })
        : undefined;

    return () => {
      clearFsTimer();
      clearGitTimer();
      unsubscribeFs?.();
      unsubscribeGit?.();
    };
  }, [
    active,
    fsDebounceMs,
    gitDebounceMs,
    normalizedFilePathSet,
    normalizedFilePaths,
    normalizedProjectPath,
    watchFs,
    watchGit,
  ]);

  useEffect(() => {
    const wasActive = previousActiveRef.current;
    previousActiveRef.current = active;

    if (!active || wasActive || !normalizedProjectPath || !explorerRuntime) {
      return;
    }

    if (watchFs && onFsChangeRef.current) {
      const dirtyPaths = Array.from(new Set(explorerRuntime.dirtyPaths.map(normalizeWorkspacePath).filter(Boolean)));
      const matchedDirtyPaths =
        normalizedFilePathSet.size === 0
          ? dirtyPaths
          : dirtyPaths.filter((path) => normalizedFilePathSet.has(path));

      if (
        matchedDirtyPaths.length > 0
        && (explorerRuntime.lastFsChangeAt ?? 0) > lastHandledFsChangeAtRef.current
      ) {
        lastHandledFsChangeAtRef.current = explorerRuntime.lastFsChangeAt ?? Date.now();
        void onFsChangeRef.current(buildSyntheticFsEvents(normalizedProjectPath, matchedDirtyPaths));
      }
    }

    if (
      watchGit
      && onGitDirtyRef.current
      && explorerRuntime.gitDirtyToken > lastHandledGitDirtyTokenRef.current
    ) {
      lastHandledGitDirtyTokenRef.current = explorerRuntime.gitDirtyToken;
      void onGitDirtyRef.current();
    }
  }, [
    active,
    explorerRuntime,
    normalizedFilePathSet,
    normalizedProjectPath,
    watchFs,
    watchGit,
  ]);
}
