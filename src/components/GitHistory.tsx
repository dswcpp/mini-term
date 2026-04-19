import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { useAppStore, selectWorkspaceConfig } from '../store';
import { subscribeProjectGitDirty } from '../runtime/workspaceRuntime';
import { showContextMenu } from '../utils/contextMenu';
import { getDefaultRepoGitView, summarizeGitChanges, type GitChangeSummary, type RepoGitView } from '../utils/gitChangesSummary';
import { formatRelativeTime } from '../utils/timeFormat';
import { GitChanges } from './GitChanges';
import type {
  BranchInfo,
  ChangeFileStatus,
  CommitFileInfo,
  GitCommitInfo,
  GitRepoInfo,
  WorkspaceConfig,
  WorkspaceRootConfig,
} from '../types';

interface GitHistoryProps {
  workspaceId: string | null | undefined;
  isVisible?: boolean;
}

interface RepoState {
  commits: GitCommitInfo[];
  loading: boolean;
  hasMore: boolean;
}

interface RepoActionState {
  status: 'loading' | 'success' | 'error';
  error?: string;
}

interface RootRepoGroup {
  root: WorkspaceRootConfig;
  repos: GitRepoInfo[];
}

const GIT_ACTION_RESET_MS = 1500;
const CHANGE_PANEL_HEIGHT_PX = 380;
const EMPTY_GIT_CHANGE_SUMMARY: GitChangeSummary = {
  changedFiles: 0,
  stagedFiles: 0,
  unstagedFiles: 0,
  untrackedFiles: 0,
};

function buildWorkspaceHistoryKey(workspace: WorkspaceConfig) {
  return [workspace.id, ...workspace.roots.map((root) => `${root.id}:${root.path}`)].join('|');
}

function GitActionButton({
  action,
  state,
  disabled,
  onClick,
}: {
  action: 'pull' | 'push';
  state?: RepoActionState;
  disabled: boolean;
  onClick: () => void;
}) {
  const loading = state?.status === 'loading';
  const success = state?.status === 'success';
  const error = state?.status === 'error';

  let label = action === 'pull' ? 'D' : 'U';
  let toneClass = 'text-[var(--text-muted)] hover:text-[var(--text-primary)]';
  if (loading) {
    label = '...';
    toneClass = 'text-[var(--text-muted)]';
  } else if (success) {
    label = 'OK';
    toneClass = 'text-[var(--color-success)]';
  } else if (error) {
    label = '!';
    toneClass = 'text-[var(--color-error)]';
  }

  return (
    <button
      type="button"
      className={`flex h-5 w-5 items-center justify-center rounded text-sm transition-colors ${
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
      } ${toneClass} ${loading ? 'animate-pulse' : ''}`}
      title={error ? state?.error : action === 'pull' ? 'Git Pull' : 'Git Push'}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        if (!disabled) {
          onClick();
        }
      }}
    >
      {label}
    </button>
  );
}

function renderBranchBadge(branch: BranchInfo) {
  return (
    <span
      key={branch.name}
      className="inline-flex shrink-0 items-center rounded px-1.5 text-[11px] leading-[18px] font-medium"
      style={{
        backgroundColor: branch.isHead
          ? 'var(--accent)'
          : branch.isRemote
            ? 'var(--border-subtle)'
            : 'rgba(63, 185, 80, 0.16)',
        color: branch.isHead
          ? '#ffffff'
          : branch.isRemote
            ? 'var(--text-muted)'
            : 'var(--color-success)',
      }}
      title={
        branch.isRemote
          ? `Remote branch: ${branch.name}`
          : branch.isHead
            ? `Current branch: ${branch.name}`
            : `Local branch: ${branch.name}`
      }
    >
      {branch.name}
    </span>
  );
}

export function GitHistory({ workspaceId, isVisible = true }: GitHistoryProps) {
  const openCommitDiff = useAppStore((state) => state.openCommitDiff);
  const workspace = useAppStore(selectWorkspaceConfig(workspaceId));

  const [reposByRoot, setReposByRoot] = useState<Map<string, GitRepoInfo[]>>(new Map());
  const [expandedRepos, setExpandedRepos] = useState<Set<string>>(new Set());
  const [repoStates, setRepoStates] = useState<Map<string, RepoState>>(new Map());
  const [repoBranches, setRepoBranches] = useState<Map<string, BranchInfo[]>>(new Map());
  const [repoChangeSummaries, setRepoChangeSummaries] = useState<Map<string, GitChangeSummary>>(new Map());
  const [repoContentModes, setRepoContentModes] = useState<Map<string, RepoGitView>>(new Map());
  const [pullState, setPullState] = useState<Map<string, RepoActionState>>(new Map());
  const [pushState, setPushState] = useState<Map<string, RepoActionState>>(new Map());

  const scrollRef = useRef<HTMLDivElement>(null);
  const repoStatesRef = useRef(repoStates);
  const expandedReposRef = useRef(expandedRepos);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initializedRef = useRef(false);
  const initializedWorkspaceKeyRef = useRef<string | null>(null);
  const autoExpandedWorkspaceKeyRef = useRef<string | null>(null);

  repoStatesRef.current = repoStates;
  expandedReposRef.current = expandedRepos;

  const clearRefreshTimer = useCallback(() => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  const loadChangeSummary = useCallback(async (repoPath: string) => {
    try {
      const changes = await invoke<ChangeFileStatus[]>('get_changes_status', { repoPath });
      const summary = summarizeGitChanges(changes);

      setRepoChangeSummaries((previous) => {
        const next = new Map(previous);
        next.set(repoPath, summary);
        return next;
      });

      setRepoContentModes((previous) => {
        if (previous.has(repoPath)) {
          return previous;
        }

        const next = new Map(previous);
        next.set(repoPath, getDefaultRepoGitView(summary));
        return next;
      });
    } catch {
      setRepoChangeSummaries((previous) => {
        const next = new Map(previous);
        next.set(repoPath, EMPTY_GIT_CHANGE_SUMMARY);
        return next;
      });

      setRepoContentModes((previous) => {
        if (previous.has(repoPath)) {
          return previous;
        }

        const next = new Map(previous);
        next.set(repoPath, 'history');
        return next;
      });
    }
  }, []);

  const loadRepos = useCallback(async () => {
    if (!workspace) {
      return;
    }

    const entries = await Promise.all(
      workspace.roots.map(async (root) => {
        try {
          const repos = await invoke<GitRepoInfo[]>('discover_git_repos', { projectPath: root.path });
          return [root.id, repos] as const;
        } catch {
          return [root.id, [] as GitRepoInfo[]] as const;
        }
      }),
    );

    const liveRepoPaths = new Set(entries.flatMap(([, repos]) => repos.map((repo) => repo.path)));
    const repoPaths = Array.from(liveRepoPaths);
    setReposByRoot(new Map(entries));
    setExpandedRepos((previous) => {
      const next = new Set(Array.from(previous).filter((repoPath) => liveRepoPaths.has(repoPath)));
      return next.size === previous.size ? previous : next;
    });
    setRepoStates((previous) => {
      let changed = false;
      const next = new Map<string, RepoState>();
      for (const [repoPath, state] of previous) {
        if (!liveRepoPaths.has(repoPath)) {
          changed = true;
          continue;
        }
        next.set(repoPath, state);
      }
      return changed ? next : previous;
    });
    setRepoChangeSummaries((previous) => {
      let changed = false;
      const next = new Map<string, GitChangeSummary>();
      for (const [repoPath, summary] of previous) {
        if (!liveRepoPaths.has(repoPath)) {
          changed = true;
          continue;
        }
        next.set(repoPath, summary);
      }
      return changed ? next : previous;
    });
    setRepoContentModes((previous) => {
      let changed = false;
      const next = new Map<string, RepoGitView>();
      for (const [repoPath, mode] of previous) {
        if (!liveRepoPaths.has(repoPath)) {
          changed = true;
          continue;
        }
        next.set(repoPath, mode);
      }
      return changed ? next : previous;
    });
    setRepoBranches((previous) => {
      let changed = false;
      const next = new Map<string, BranchInfo[]>();
      for (const [repoPath, branches] of previous) {
        if (!liveRepoPaths.has(repoPath)) {
          changed = true;
          continue;
        }
        next.set(repoPath, branches);
      }
      return changed ? next : previous;
    });

    await Promise.all(repoPaths.map((repoPath) => loadChangeSummary(repoPath)));
  }, [loadChangeSummary, workspace]);

  const loadBranches = useCallback(async (repoPath: string) => {
    try {
      const branches = await invoke<BranchInfo[]>('get_repo_branches', { repoPath });
      setRepoBranches((previous) => {
        const next = new Map(previous);
        next.set(repoPath, branches);
        return next;
      });
    } catch {
      setRepoBranches((previous) => {
        const next = new Map(previous);
        next.set(repoPath, []);
        return next;
      });
    }
  }, []);

  const loadCommits = useCallback(async (repoPath: string, beforeCommit?: string) => {
    const existing = repoStatesRef.current.get(repoPath);
    if (existing?.loading) {
      return;
    }

    setRepoStates((previous) => {
      const next = new Map(previous);
      const current = next.get(repoPath) ?? { commits: [], loading: false, hasMore: true };
      next.set(repoPath, { ...current, loading: true });
      return next;
    });

    try {
      const commits = await invoke<GitCommitInfo[]>('get_git_log', {
        repoPath,
        beforeCommit: beforeCommit ?? null,
        limit: 30,
      });

      setRepoStates((previous) => {
        const next = new Map(previous);
        const current = next.get(repoPath) ?? { commits: [], loading: false, hasMore: true };
        next.set(repoPath, {
          commits: beforeCommit ? [...current.commits, ...commits].slice(-120) : commits,
          loading: false,
          hasMore: commits.length >= 30,
        });
        return next;
      });
    } catch {
      setRepoStates((previous) => {
        const next = new Map(previous);
        const current = next.get(repoPath) ?? { commits: [], loading: false, hasMore: true };
        next.set(repoPath, { ...current, loading: false });
        return next;
      });
    }
  }, []);

  useEffect(() => {
    if (!workspace) {
      initializedRef.current = false;
      initializedWorkspaceKeyRef.current = null;
      autoExpandedWorkspaceKeyRef.current = null;
      clearRefreshTimer();
      setReposByRoot(new Map());
      setExpandedRepos(new Set());
      setRepoStates(new Map());
      setRepoBranches(new Map());
      setRepoChangeSummaries(new Map());
      setRepoContentModes(new Map());
      setPullState(new Map());
      setPushState(new Map());
      return;
    }

    if (!isVisible) {
      clearRefreshTimer();
      return;
    }

    const nextWorkspaceKey = buildWorkspaceHistoryKey(workspace);
    const shouldReset = !initializedRef.current || initializedWorkspaceKeyRef.current !== nextWorkspaceKey;

    initializedRef.current = true;
    initializedWorkspaceKeyRef.current = nextWorkspaceKey;

    if (shouldReset) {
      autoExpandedWorkspaceKeyRef.current = null;
      setReposByRoot(new Map());
      setExpandedRepos(new Set());
      setRepoStates(new Map());
      setRepoBranches(new Map());
      setRepoChangeSummaries(new Map());
      setRepoContentModes(new Map());
      setPullState(new Map());
      setPushState(new Map());
      scrollRef.current?.scrollTo({ top: 0 });
    }

    void loadRepos();
    if (!shouldReset) {
      for (const repoPath of expandedReposRef.current) {
        void loadCommits(repoPath);
        void loadBranches(repoPath);
        void loadChangeSummary(repoPath);
      }
    }
  }, [clearRefreshTimer, isVisible, loadBranches, loadChangeSummary, loadCommits, loadRepos, workspace]);

  useEffect(
    () => () => {
      clearRefreshTimer();
    },
    [clearRefreshTimer],
  );

  useEffect(() => {
    if (!workspace) {
      autoExpandedWorkspaceKeyRef.current = null;
      return;
    }

    const repos = Array.from(reposByRoot.values()).flat();
    if (repos.length !== 1) {
      return;
    }

    const workspaceKey = buildWorkspaceHistoryKey(workspace);
    if (autoExpandedWorkspaceKeyRef.current === workspaceKey) {
      return;
    }

    autoExpandedWorkspaceKeyRef.current = workspaceKey;
    const repoPath = repos[0].path;

    setExpandedRepos((previous) => {
      if (previous.has(repoPath)) {
        return previous;
      }
      const next = new Set(previous);
      next.add(repoPath);
      return next;
    });
    void loadCommits(repoPath);
    void loadBranches(repoPath);
    void loadChangeSummary(repoPath);
  }, [loadBranches, loadChangeSummary, loadCommits, reposByRoot, workspace]);

  const toggleRepo = useCallback(
    (repoPath: string) => {
      setExpandedRepos((previous) => {
        const next = new Set(previous);
        if (next.has(repoPath)) {
          next.delete(repoPath);
          return next;
        }

        next.add(repoPath);
        if (!repoStatesRef.current.has(repoPath)) {
          void loadCommits(repoPath);
        }
        void loadBranches(repoPath);
        void loadChangeSummary(repoPath);
        return next;
      });
    },
    [loadBranches, loadChangeSummary, loadCommits],
  );

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    if (element.scrollTop + element.clientHeight < element.scrollHeight - 50) {
      return;
    }

    for (const repoPath of expandedReposRef.current) {
      const state = repoStatesRef.current.get(repoPath);
      if (state && state.hasMore && !state.loading && state.commits.length > 0) {
        const lastHash = state.commits[state.commits.length - 1].hash;
        void loadCommits(repoPath, lastHash);
        break;
      }
    }
  }, [loadCommits]);

  const handleViewDiff = useCallback(
    async (repoPath: string, commit: GitCommitInfo) => {
      if (!workspace) {
        return;
      }

      try {
        const files = await invoke<CommitFileInfo[]>('get_commit_files', {
          repoPath,
          commitHash: commit.hash,
        });
        openCommitDiff({
          workspaceId: workspace.id,
          repoPath,
          commitHash: commit.hash,
          commitMessage: commit.message,
          files,
        });
      } catch (error) {
        console.error('get_commit_files failed:', error);
      }
    },
    [openCommitDiff, workspace],
  );

  const handleCommitContextMenu = useCallback(
    (event: React.MouseEvent, repoPath: string, commit: GitCommitInfo) => {
      event.preventDefault();
      showContextMenu(event.clientX, event.clientY, [
        {
          label: 'Copy Commit Hash',
          onClick: () => writeText(commit.hash),
        },
        { separator: true },
        {
          label: 'View Diff',
          onClick: () => {
            void handleViewDiff(repoPath, commit);
          },
        },
      ]);
    },
    [handleViewDiff],
  );

  const debouncedRefresh = useCallback(() => {
    clearRefreshTimer();
    refreshTimerRef.current = setTimeout(() => {
      void loadRepos();
      for (const repoPath of expandedReposRef.current) {
        void loadCommits(repoPath);
        void loadBranches(repoPath);
        void loadChangeSummary(repoPath);
      }
    }, 500);
  }, [clearRefreshTimer, loadBranches, loadChangeSummary, loadCommits, loadRepos]);

  const handlePull = useCallback(
    async (repoPath: string) => {
      setPullState((previous) => new Map(previous).set(repoPath, { status: 'loading' }));
      setPushState((previous) => {
        const next = new Map(previous);
        next.delete(repoPath);
        return next;
      });

      try {
        await invoke('git_pull', { repoPath });
        setPullState((previous) => new Map(previous).set(repoPath, { status: 'success' }));
        await loadRepos();
        await loadCommits(repoPath);
        await loadBranches(repoPath);
        await loadChangeSummary(repoPath);
      } catch (error) {
        setPullState((previous) =>
          new Map(previous).set(repoPath, { status: 'error', error: String(error) }),
        );
      }

      window.setTimeout(() => {
        setPullState((previous) => {
          const next = new Map(previous);
          next.delete(repoPath);
          return next;
        });
      }, GIT_ACTION_RESET_MS);
    },
    [loadBranches, loadChangeSummary, loadCommits, loadRepos],
  );

  const handlePush = useCallback(
    async (repoPath: string) => {
      setPushState((previous) => new Map(previous).set(repoPath, { status: 'loading' }));
      setPullState((previous) => {
        const next = new Map(previous);
        next.delete(repoPath);
        return next;
      });

      try {
        await invoke('git_push', { repoPath });
        setPushState((previous) => new Map(previous).set(repoPath, { status: 'success' }));
        await loadRepos();
        await loadBranches(repoPath);
        await loadChangeSummary(repoPath);
      } catch (error) {
        setPushState((previous) =>
          new Map(previous).set(repoPath, { status: 'error', error: String(error) }),
        );
      }

      window.setTimeout(() => {
        setPushState((previous) => {
          const next = new Map(previous);
          next.delete(repoPath);
          return next;
        });
      }, GIT_ACTION_RESET_MS);
    },
    [loadBranches, loadChangeSummary, loadRepos],
  );

  const setRepoContentMode = useCallback((repoPath: string, mode: RepoGitView) => {
    setRepoContentModes((previous) => {
      if (previous.get(repoPath) === mode) {
        return previous;
      }

      const next = new Map(previous);
      next.set(repoPath, mode);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!workspace || !isVisible) {
      return;
    }

    const unsubscribers = workspace.roots.map((root) => subscribeProjectGitDirty(root.path, debouncedRefresh));
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [debouncedRefresh, isVisible, workspace]);

  const repoGroups = useMemo<RootRepoGroup[]>(() => {
    if (!workspace) {
      return [];
    }

    return workspace.roots.map((root) => ({
      root,
      repos: reposByRoot.get(root.id) ?? [],
    }));
  }, [reposByRoot, workspace]);

  if (!workspace) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--bg-surface)] text-base text-[var(--text-muted)]">
        Select a workspace
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col border-t border-[var(--border-subtle)] bg-[var(--bg-surface)]">
      <div className="flex flex-shrink-0 items-center justify-between px-3 pt-3 pb-1.5">
        <span className="select-none text-sm font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]">
          Git
        </span>
        <button
          type="button"
          className="text-sm text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
          onClick={() => {
            void loadRepos();
            for (const repoPath of expandedReposRef.current) {
              void loadCommits(repoPath);
              void loadBranches(repoPath);
            }
          }}
          title="Refresh"
        >
          R
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-1" ref={scrollRef} onScroll={handleScroll}>
        {repoGroups.every((group) => group.repos.length === 0) ? (
          <div className="py-6 text-center text-sm text-[var(--text-muted)]">No Git repositories found</div>
        ) : (
          repoGroups.map((group) => (
            <div key={group.root.id} className="pb-2">
              <div className="sticky top-0 z-10 border-y border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2.5 py-1 text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)]">
                {group.root.name}
              </div>
              {group.repos.length === 0 ? (
                <div className="px-3 py-2 text-xs text-[var(--text-muted)]">No repositories under this root</div>
              ) : (
                group.repos.map((repo) => {
                  const isExpanded = expandedRepos.has(repo.path);
                  const state = repoStates.get(repo.path);
                  const branches = repoBranches.get(repo.path) ?? [];
                  const changeSummary = repoChangeSummaries.get(repo.path) ?? EMPTY_GIT_CHANGE_SUMMARY;
                  const contentMode = repoContentModes.get(repo.path) ?? getDefaultRepoGitView(changeSummary);
                  const pull = pullState.get(repo.path);
                  const push = pushState.get(repo.path);
                  const actionsDisabled = pull?.status === 'loading' || push?.status === 'loading';

                  return (
                    <div key={repo.path}>
                      <div
                        className="group flex cursor-pointer items-center justify-between gap-2 rounded-[var(--radius-sm)] px-2 py-[5px] text-base text-[var(--color-folder)] transition-colors duration-100 hover:bg-[var(--border-subtle)]"
                        onClick={() => toggleRepo(repo.path)}
                      >
                        <div className="flex min-w-0 items-center gap-1">
                          <span
                            className="w-3 text-center text-[13px] text-[var(--text-muted)] transition-transform duration-150"
                            style={{
                              transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)',
                              display: 'inline-block',
                            }}
                          >
                            {'>'}
                          </span>
                          <span className="truncate font-medium">{repo.name}</span>
                          {repo.currentBranch ? (
                            <span className="shrink-0 rounded bg-[var(--border-subtle)] px-1.5 font-mono text-[11px] leading-[18px] text-[var(--text-muted)]">
                              {repo.currentBranch}
                            </span>
                          ) : null}
                          {changeSummary.stagedFiles > 0 ? (
                            <span className="shrink-0 rounded border border-emerald-500/30 bg-emerald-500/12 px-1.5 text-[10px] leading-[18px] text-emerald-300">
                              S {changeSummary.stagedFiles}
                            </span>
                          ) : null}
                          {changeSummary.unstagedFiles > 0 ? (
                            <span className="shrink-0 rounded border border-amber-500/30 bg-amber-500/12 px-1.5 text-[10px] leading-[18px] text-amber-300">
                              M {changeSummary.unstagedFiles}
                            </span>
                          ) : null}
                          {changeSummary.untrackedFiles > 0 ? (
                            <span className="shrink-0 rounded border border-sky-500/30 bg-sky-500/12 px-1.5 text-[10px] leading-[18px] text-sky-300">
                              ? {changeSummary.untrackedFiles}
                            </span>
                          ) : null}
                        </div>

                        <div className="flex flex-shrink-0 items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                          <GitActionButton
                            action="pull"
                            state={pull}
                            disabled={actionsDisabled}
                            onClick={() => {
                              void handlePull(repo.path);
                            }}
                          />
                          <GitActionButton
                            action="push"
                            state={push}
                            disabled={actionsDisabled}
                            onClick={() => {
                              void handlePush(repo.path);
                            }}
                          />
                        </div>
                      </div>

                      {isExpanded ? (
                        <div>
                          <div className="flex items-center gap-1 px-6 pb-1 pt-1.5">
                            <button
                              type="button"
                              className={`rounded px-2 py-1 text-[11px] uppercase tracking-[0.08em] transition-colors ${
                                contentMode === 'changes'
                                  ? 'bg-[var(--accent-subtle)] text-[var(--accent)]'
                                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                              }`}
                              onClick={() => setRepoContentMode(repo.path, 'changes')}
                            >
                              Changes{changeSummary.changedFiles > 0 ? ` (${changeSummary.changedFiles})` : ''}
                            </button>
                            <button
                              type="button"
                              className={`rounded px-2 py-1 text-[11px] uppercase tracking-[0.08em] transition-colors ${
                                contentMode === 'history'
                                  ? 'bg-[var(--accent-subtle)] text-[var(--accent)]'
                                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                              }`}
                              onClick={() => setRepoContentMode(repo.path, 'history')}
                            >
                              History
                            </button>
                          </div>

                          {contentMode === 'changes' ? (
                            <div className="px-4 pb-3">
                              <div
                                className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)]"
                                style={{ height: `${CHANGE_PANEL_HEIGHT_PX}px` }}
                              >
                                <GitChanges
                                  projectPath={repo.path}
                                  repoPath={repo.path}
                                  onCommitSuccess={() => {
                                    void loadRepos();
                                    void loadChangeSummary(repo.path);
                                    void loadCommits(repo.path);
                                    void loadBranches(repo.path);
                                  }}
                                />
                              </div>
                            </div>
                          ) : (
                            <div>
                              {state?.commits.map((commit) => {
                                const commitBranches = branches.filter((branch) => branch.commitHash === commit.hash);
                                const commitTitle = commit.body ? `${commit.message}\n\n${commit.body}` : commit.message;

                                return (
                                  <div
                                    key={commit.hash}
                                    className="cursor-pointer rounded-[var(--radius-sm)] px-6 py-1.5 transition-colors duration-100 hover:bg-[var(--border-subtle)]"
                                    title={commitTitle}
                                    onContextMenu={(event) => handleCommitContextMenu(event, repo.path, commit)}
                                    onDoubleClick={() => {
                                      void handleViewDiff(repo.path, commit);
                                    }}
                                  >
                                    <div className="flex min-w-0 items-center gap-1 text-sm text-[var(--text-primary)]">
                                      {commitBranches.map(renderBranchBadge)}
                                      <span className="truncate">{commit.message}</span>
                                    </div>
                                    <div className="mt-0.5 flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
                                      <span>{commit.author}</span>
                                      <span>|</span>
                                      <span>{formatRelativeTime(commit.timestamp)}</span>
                                      <span>|</span>
                                      <span className="font-mono">{commit.shortHash}</span>
                                    </div>
                                  </div>
                                );
                              })}

                              {state?.loading ? (
                                <div className="py-2 text-center text-xs text-[var(--text-muted)]">Loading...</div>
                              ) : null}
                              {state && !state.loading && state.commits.length === 0 ? (
                                <div className="py-2 text-center text-xs text-[var(--text-muted)]">No commits</div>
                              ) : null}
                            </div>
                          )}
                        </div>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
