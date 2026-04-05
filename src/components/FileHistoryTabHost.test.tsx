import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileHistoryTabHost } from './FileHistoryTabHost';

const invokeMock = vi.fn();
const writeTextMock = vi.fn();
const useWorkspaceAutoRefreshMock = vi.fn();
const autoRefreshOptions: Array<Record<string, unknown>> = [];

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: unknown) => invokeMock(command, args),
}));

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  writeText: (value: string) => writeTextMock(value),
}));

vi.mock('../hooks/useWorkspaceAutoRefresh', () => ({
  useWorkspaceAutoRefresh: (options: Record<string, unknown>) => {
    autoRefreshOptions.push(options);
    useWorkspaceAutoRefreshMock(options);
  },
}));

vi.mock('./documentViewer/shiki', () => ({
  highlightCodeToHtml: vi.fn(async (source: string) => {
    const lines = source.split('\n').map((line) => `<span class="line">${line}</span>`).join('');
    return `<pre class="shiki"><code>${lines}</code></pre>`;
  }),
}));

function createHistoryEntry(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    commitHash: 'abc1234567',
    shortHash: 'abc1234',
    message: 'feat: update file history',
    author: 'Alice',
    timestamp: 1712304000,
    path: 'src/components/FileTree.tsx',
    oldPath: undefined,
    status: 'modified',
    ...overrides,
  };
}

function createDiffResult() {
  return {
    oldContent: 'before line\nstable line\n',
    newContent: 'after line\nstable line\n',
    hunks: [
      {
        hunkKey: 'hunk-1',
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        lines: [
          { kind: 'delete', content: 'before line', oldLineno: 1 },
          { kind: 'add', content: 'after line', newLineno: 1 },
          { kind: 'context', content: 'stable line', oldLineno: 2, newLineno: 2 },
        ],
        changeBlocks: [],
      },
    ],
    isBinary: false,
    tooLarge: false,
    canRestoreFile: false,
    canRestorePartial: false,
    restoreMode: 'unsupported',
    diffCleared: false,
  };
}

describe('FileHistoryTabHost', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    writeTextMock.mockReset();
    useWorkspaceAutoRefreshMock.mockClear();
    autoRefreshOptions.length = 0;
  });

  it('loads file history, supports blame view, and jumps from blame back to timeline commit', async () => {
    const firstEntry = createHistoryEntry();
    const secondEntry = createHistoryEntry({
      commitHash: 'def5678901',
      shortHash: 'def5678',
      message: 'refactor: rename helpers',
      author: 'Bob',
      timestamp: 1712390400,
    });

    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === 'get_file_git_history') {
        return Promise.resolve({
          repoPath: 'D:/code/JavaScript/mini-term',
          filePath: 'src/components/FileTree.tsx',
          entries: [firstEntry, secondEntry],
          hasMore: false,
        });
      }

      if (command === 'get_commit_file_diff') {
        const commitHash = args?.commitHash;
        if (commitHash === secondEntry.commitHash) {
          return Promise.resolve({
            ...createDiffResult(),
            newContent: 'renamed line\nstable line\n',
          });
        }
        return Promise.resolve(createDiffResult());
      }

      if (command === 'get_file_git_blame') {
        return Promise.resolve({
          repoPath: 'D:/code/JavaScript/mini-term',
          filePath: 'src/components/FileTree.tsx',
          ranges: [
            {
              startLine: 1,
              endLine: 2,
              lines: ['after line', 'stable line'],
              author: 'Bob',
              timestamp: 1712390400,
              commitHash: secondEntry.commitHash,
              shortHash: secondEntry.shortHash,
              message: secondEntry.message,
              isUncommitted: false,
            },
          ],
          isBinary: false,
          tooLarge: false,
        });
      }

      return Promise.reject(new Error(`unexpected command: ${command}`));
    });

    render(
      <FileHistoryTabHost
        tab={{
          kind: 'file-history',
          id: 'file-history-1',
          projectPath: 'D:/code/JavaScript/mini-term',
          filePath: 'D:/code/JavaScript/mini-term/src/components/FileTree.tsx',
        }}
        isActive
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByTestId('file-history-entry-abc1234')).not.toBeNull();

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'get_commit_file_diff',
        expect.objectContaining({
          commitHash: firstEntry.commitHash,
          filePath: firstEntry.path,
        }),
      );
    });

    fireEvent.click(screen.getByTestId('timeline-copy-author'));

    expect(writeTextMock).toHaveBeenCalledWith(firstEntry.author);
    await waitFor(() => {
      expect(screen.getByTestId('timeline-copy-author').textContent).toContain('已复制作者');
    });
    expect((await screen.findByTestId('file-history-copy-feedback')).textContent).toContain('已复制作者');

    fireEvent.click(screen.getByTestId('file-history-blame-toggle'));

    expect(await screen.findByTestId('blame-range-1')).not.toBeNull();
    expect(invokeMock).toHaveBeenCalledWith(
      'get_file_git_blame',
      expect.objectContaining({
        filePath: 'D:/code/JavaScript/mini-term/src/components/FileTree.tsx',
      }),
    );

    expect(await screen.findByTestId('blame-copy-author')).not.toBeNull();
    expect(screen.getByTestId('blame-copy-time')).not.toBeNull();
    expect(screen.getByTestId('blame-copy-commit')).not.toBeNull();
    expect(await screen.findByTestId('blame-jump-commit')).not.toBeNull();

    fireEvent.click(screen.getByTestId('blame-copy-commit'));

    expect(writeTextMock).toHaveBeenCalledWith(secondEntry.commitHash);
    expect(await screen.findByTestId('file-history-copy-feedback')).not.toBeNull();
    await waitFor(() => {
      expect(screen.getByTestId('blame-copy-commit').textContent).toContain('已复制Commit');
    });

    fireEvent.click(screen.getByTestId('blame-range-1'));
    expect(screen.getByTestId('file-history-blame-toggle')).not.toBeNull();

    fireEvent.click(screen.getByTestId('blame-jump-commit'));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'get_commit_file_diff',
        expect.objectContaining({
          commitHash: secondEntry.commitHash,
          filePath: secondEntry.path,
        }),
      );
    });

    expect(screen.getByTestId('timeline-copy-commit')).not.toBeNull();
  });

  it('renders blame loading errors without throwing unhandled rejections', async () => {
    const firstEntry = createHistoryEntry();

    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_file_git_history') {
        return Promise.resolve({
          repoPath: 'D:/code/JavaScript/mini-term',
          filePath: 'src/components/FileTree.tsx',
          entries: [firstEntry],
          hasMore: false,
        });
      }

      if (command === 'get_commit_file_diff') {
        return Promise.resolve(createDiffResult());
      }

      if (command === 'get_file_git_blame') {
        return Promise.reject(new Error('unable to resolve blame hunk'));
      }

      return Promise.reject(new Error(`unexpected command: ${command}`));
    });

    render(
      <FileHistoryTabHost
        tab={{
          kind: 'file-history',
          id: 'file-history-2',
          projectPath: 'D:/code/JavaScript/mini-term',
          filePath: 'D:/code/JavaScript/mini-term/src/components/FileTree.tsx',
        }}
        isActive
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByTestId('file-history-entry-abc1234')).not.toBeNull();

    fireEvent.click(screen.getByTestId('file-history-blame-toggle'));

    expect(await screen.findByText('Error: unable to resolve blame hunk')).not.toBeNull();
  });

  it('auto refreshes current blame when the file changes', async () => {
    const firstEntry = createHistoryEntry();
    let blameCallCount = 0;

    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_file_git_history') {
        return Promise.resolve({
          repoPath: 'D:/code/JavaScript/mini-term',
          filePath: 'src/components/FileTree.tsx',
          entries: [firstEntry],
          hasMore: false,
        });
      }

      if (command === 'get_commit_file_diff') {
        return Promise.resolve(createDiffResult());
      }

      if (command === 'get_file_git_blame') {
        blameCallCount += 1;
        return Promise.resolve({
          repoPath: 'D:/code/JavaScript/mini-term',
          filePath: 'src/components/FileTree.tsx',
          ranges: [
            {
              startLine: 1,
              endLine: 2,
              lines: ['after line', 'stable line'],
              author: blameCallCount > 1 ? 'Carol' : 'Bob',
              timestamp: 1712390400,
              commitHash: firstEntry.commitHash,
              shortHash: firstEntry.shortHash,
              message: blameCallCount > 1 ? 'refactor: update blame' : firstEntry.message,
              isUncommitted: false,
            },
          ],
          isBinary: false,
          tooLarge: false,
        });
      }

      return Promise.reject(new Error(`unexpected command: ${command}`));
    });

    render(
      <FileHistoryTabHost
        tab={{
          kind: 'file-history',
          id: 'file-history-3',
          projectPath: 'D:/code/JavaScript/mini-term',
          filePath: 'D:/code/JavaScript/mini-term/src/components/FileTree.tsx',
        }}
        isActive
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByTestId('file-history-blame-toggle'));
    expect(await screen.findByTestId('blame-range-1')).not.toBeNull();

    const blameRefreshHook = autoRefreshOptions.find((item) => item.watchFs && item.active);
    expect(blameRefreshHook).toBeDefined();

    await act(async () => {
      await (blameRefreshHook?.onFsChange as (() => Promise<void>) | undefined)?.();
    });

    await waitFor(() => {
      expect(blameCallCount).toBe(2);
    });
    expect(await screen.findByTestId('file-history-refresh-feedback')).not.toBeNull();
  });

  it('coalesces immediate blame fs and git auto refresh triggers for the same change', async () => {
    let currentTime = 1_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => currentTime);
    try {
      const firstEntry = createHistoryEntry();
      let blameCallCount = 0;

      invokeMock.mockImplementation((command: string) => {
        if (command === 'get_file_git_history') {
          return Promise.resolve({
            repoPath: 'D:/code/JavaScript/mini-term',
            filePath: 'src/components/FileTree.tsx',
            entries: [firstEntry],
            hasMore: false,
          });
        }

        if (command === 'get_commit_file_diff') {
          return Promise.resolve(createDiffResult());
        }

        if (command === 'get_file_git_blame') {
          blameCallCount += 1;
          return Promise.resolve({
            repoPath: 'D:/code/JavaScript/mini-term',
            filePath: 'src/components/FileTree.tsx',
            ranges: [
              {
                startLine: 1,
                endLine: 2,
                lines: ['after line', 'stable line'],
                author: blameCallCount > 1 ? 'Carol' : 'Bob',
                timestamp: 1712390400,
                commitHash: firstEntry.commitHash,
                shortHash: firstEntry.shortHash,
                message: blameCallCount > 1 ? 'refactor: update blame' : firstEntry.message,
                isUncommitted: false,
              },
            ],
            isBinary: false,
            tooLarge: false,
          });
        }

        return Promise.reject(new Error(`unexpected command: ${command}`));
      });

      render(
        <FileHistoryTabHost
          tab={{
            kind: 'file-history',
            id: 'file-history-4',
            projectPath: 'D:/code/JavaScript/mini-term',
            filePath: 'D:/code/JavaScript/mini-term/src/components/FileTree.tsx',
          }}
          isActive
          onClose={vi.fn()}
        />,
      );

      fireEvent.click(await screen.findByTestId('file-history-blame-toggle'));
      expect(await screen.findByTestId('blame-range-1')).not.toBeNull();

      const blameRefreshHook = autoRefreshOptions.find((item) => item.watchFs && item.watchGit && item.active);
      expect(blameRefreshHook).toBeDefined();

      await act(async () => {
        await (blameRefreshHook?.onFsChange as (() => Promise<void>) | undefined)?.();
        await (blameRefreshHook?.onGitDirty as (() => Promise<void>) | undefined)?.();
      });

      expect(blameCallCount).toBe(2);

      currentTime += 500;
      await act(async () => {
        await (blameRefreshHook?.onGitDirty as (() => Promise<void>) | undefined)?.();
      });

      expect(blameCallCount).toBe(3);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
