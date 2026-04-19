import type { ChangeFileStatus } from '../types';

export interface GitChangeSummary {
  changedFiles: number;
  stagedFiles: number;
  unstagedFiles: number;
  untrackedFiles: number;
}

export type RepoGitView = 'changes' | 'history';

export function summarizeGitChanges(changes: ChangeFileStatus[]): GitChangeSummary {
  let stagedFiles = 0;
  let unstagedFiles = 0;
  let untrackedFiles = 0;

  for (const change of changes) {
    if (change.stagedStatus) {
      stagedFiles += 1;
    }

    if (change.unstagedStatus) {
      if (change.unstagedStatus === 'untracked') {
        untrackedFiles += 1;
      } else {
        unstagedFiles += 1;
      }
    }
  }

  return {
    changedFiles: changes.length,
    stagedFiles,
    unstagedFiles,
    untrackedFiles,
  };
}

export function getDefaultRepoGitView(summary?: GitChangeSummary | null): RepoGitView {
  return summary && summary.changedFiles > 0 ? 'changes' : 'history';
}
