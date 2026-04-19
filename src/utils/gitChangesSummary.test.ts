import { describe, expect, it } from 'vitest';
import { getDefaultRepoGitView, summarizeGitChanges } from './gitChangesSummary';

describe('gitChangesSummary', () => {
  it('counts staged, unstaged, and untracked files separately', () => {
    const summary = summarizeGitChanges([
      {
        path: 'src/app.ts',
        stagedStatus: 'modified',
        unstagedStatus: 'modified',
        statusLabel: 'M',
      },
      {
        path: 'src/new.ts',
        unstagedStatus: 'untracked',
        statusLabel: '?',
      },
      {
        path: 'README.md',
        stagedStatus: 'added',
        statusLabel: 'A',
      },
    ]);

    expect(summary).toEqual({
      changedFiles: 3,
      stagedFiles: 2,
      unstagedFiles: 1,
      untrackedFiles: 1,
    });
  });

  it('defaults to the changes view only when there are pending changes', () => {
    expect(
      getDefaultRepoGitView({
        changedFiles: 2,
        stagedFiles: 1,
        unstagedFiles: 1,
        untrackedFiles: 0,
      }),
    ).toBe('changes');

    expect(
      getDefaultRepoGitView({
        changedFiles: 0,
        stagedFiles: 0,
        unstagedFiles: 0,
        untrackedFiles: 0,
      }),
    ).toBe('history');

    expect(getDefaultRepoGitView()).toBe('history');
  });
});
