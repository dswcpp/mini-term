import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { useAppStore, selectWorkspaceConfig } from '../store';
import { subscribeProjectGitDirty } from '../runtime/workspaceRuntime';
import { showContextMenu } from '../utils/contextMenu';
import { formatRelativeTime } from '../utils/timeFormat';
import type { GitRepoInfo, GitCommitInfo, CommitFileInfo, WorkspaceRootConfig } from '../types';

interface RepoState {
  commits: GitCommitInfo[];
  loading: boolean;
  hasMore: boolean;
}

interface RootRepoGroup {
  root: WorkspaceRootConfig;
  repos: GitRepoInfo[];
}

export function GitHistory() {
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId);
  const openCommitDiff = useAppStore((s) => s.openCommitDiff);
  const workspace = useAppStore(selectWorkspaceConfig(activeWorkspaceId));

  const [reposByRoot, setReposByRoot] = useState<Map<string, GitRepoInfo[]>>(new Map());
  const [expandedRepos, setExpandedRepos] = useState<Set<string>>(new Set());
  const [repoStates, setRepoStates] = useState<Map<string, RepoState>>(new Map());

  const scrollRef = useRef<HTMLDivElement>(null);
  const repoStatesRef = useRef(repoStates);
  repoStatesRef.current = repoStates;

  const loadRepos = useCallback(() => {
    if (!workspace) return;

    void Promise.all(
      workspace.roots.map(async (root) => {
        try {
          const repos = await invoke<GitRepoInfo[]>('discover_git_repos', { projectPath: root.path });
          return [root.id, repos] as const;
        } catch {
          return [root.id, []] as const;
        }
      }),
    ).then((entries) => {
      setReposByRoot(new Map(entries));
    });
  }, [workspace]);

  useEffect(() => {
    loadRepos();
  }, [loadRepos]);

  const loadCommits = useCallback(
    async (repoPath: string, beforeCommit?: string) => {
      const existing = repoStatesRef.current.get(repoPath);
      if (existing?.loading) return;

      setRepoStates((prev) => {
        const next = new Map(prev);
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
        setRepoStates((prev) => {
          const next = new Map(prev);
          const current = next.get(repoPath) ?? { commits: [], loading: false, hasMore: true };
          next.set(repoPath, {
            commits: beforeCommit ? [...current.commits, ...commits].slice(-120) : commits,
            loading: false,
            hasMore: commits.length >= 30,
          });
          return next;
        });
      } catch {
        setRepoStates((prev) => {
          const next = new Map(prev);
          const current = next.get(repoPath) ?? { commits: [], loading: false, hasMore: true };
          next.set(repoPath, { ...current, loading: false });
          return next;
        });
      }
    },
    [],
  );

  const toggleRepo = useCallback(
    (repoPath: string) => {
      setExpandedRepos((prev) => {
        const next = new Set(prev);
        if (next.has(repoPath)) {
          next.delete(repoPath);
        } else {
          next.add(repoPath);
          if (!repoStatesRef.current.has(repoPath)) {
            void loadCommits(repoPath);
          }
        }
        return next;
      });
    },
    [loadCommits],
  );

  const expandedReposRef = useRef(expandedRepos);
  expandedReposRef.current = expandedRepos;

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop + el.clientHeight < el.scrollHeight - 50) return;

    for (const repoPath of expandedReposRef.current) {
      const state = repoStatesRef.current.get(repoPath);
      if (state && state.hasMore && !state.loading && state.commits.length > 0) {
        const lastHash = state.commits[state.commits.length - 1].hash;
        void loadCommits(repoPath, lastHash);
        break;
      }
    }
  }, [loadCommits]);

  const handleViewDiff = useCallback(async (repoPath: string, commit: GitCommitInfo) => {
    if (!workspace) return;
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
  }, [openCommitDiff, workspace]);

  const handleCommitContextMenu = useCallback(
    (e: React.MouseEvent, repoPath: string, commit: GitCommitInfo) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
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

  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedRefresh = useCallback(() => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      loadRepos();
      for (const repoPath of expandedReposRef.current) {
        void loadCommits(repoPath);
      }
    }, 500);
  }, [loadCommits, loadRepos]);

  useEffect(() => {
    if (!workspace) {
      return;
    }

    const unsubscribers = workspace.roots.map((root) => subscribeProjectGitDirty(root.path, debouncedRefresh));
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [debouncedRefresh, workspace]);

  const repoGroups = useMemo<RootRepoGroup[]>(() => {
    if (!workspace) return [];
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
        <span className="text-sm font-medium uppercase tracking-[0.12em] text-[var(--text-muted)] select-none">
          Git History
        </span>
        <button
          className="text-sm text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
          onClick={() => {
            loadRepos();
            for (const repoPath of expandedRepos) {
              void loadCommits(repoPath);
            }
          }}
          title="Refresh"
        >
          ↻
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
                  return (
                    <div key={repo.path}>
                      <div
                        className="flex cursor-pointer items-center gap-1 rounded-[var(--radius-sm)] px-2 py-[5px] text-base text-[var(--color-folder)] transition-colors duration-100 hover:bg-[var(--border-subtle)]"
                        onClick={() => toggleRepo(repo.path)}
                      >
                        <span
                          className="w-3 text-center text-[13px] text-[var(--text-muted)] transition-transform duration-150"
                          style={{ transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)', display: 'inline-block' }}
                        >
                          ▾
                        </span>
                        <span className="truncate font-medium">{repo.name}</span>
                      </div>

                      {isExpanded ? (
                        <div>
                          {state?.commits.map((commit) => (
                            <div
                              key={commit.hash}
                              className="cursor-pointer rounded-[var(--radius-sm)] px-6 py-1.5 transition-colors duration-100 hover:bg-[var(--border-subtle)]"
                              onContextMenu={(event) => handleCommitContextMenu(event, repo.path, commit)}
                              onDoubleClick={() => {
                                void handleViewDiff(repo.path, commit);
                              }}
                            >
                              <div className="truncate text-sm text-[var(--text-primary)]">{commit.message}</div>
                              <div className="mt-0.5 flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
                                <span>{commit.author}</span>
                                <span>·</span>
                                <span>{formatRelativeTime(commit.timestamp)}</span>
                                <span>·</span>
                                <span className="font-mono">{commit.shortHash}</span>
                              </div>
                            </div>
                          ))}

                          {state?.loading ? (
                            <div className="py-2 text-center text-xs text-[var(--text-muted)]">Loading…</div>
                          ) : null}
                          {state && !state.loading && state.commits.length === 0 ? (
                            <div className="py-2 text-center text-xs text-[var(--text-muted)]">No commits</div>
                          ) : null}
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
