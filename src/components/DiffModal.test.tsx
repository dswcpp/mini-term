import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../store';
import { GlobalNoticeHost } from './GlobalNoticeHost';
import { WorkspaceDialogHost } from './WorkspaceDialogHost';
import { CommitDiffModal } from './CommitDiffModal';
import { DiffModal } from './DiffModal';

const invokeMock = vi.fn();
const showContextMenuMock = vi.fn();
const useWorkspaceAutoRefreshMock = vi.fn();
const autoRefreshOptions: Array<Record<string, unknown>> = [];
const expectedBlameTime = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
}).format(new Date(1712304000 * 1000));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: unknown) => invokeMock(command, args),
}));

vi.mock('../utils/contextMenu', () => ({
  showContextMenu: (x: number, y: number, items: unknown[]) => showContextMenuMock(x, y, items),
}));

vi.mock('../hooks/useWorkspaceAutoRefresh', () => ({
  useWorkspaceAutoRefresh: (options: Record<string, unknown>) => {
    autoRefreshOptions.push(options);
    useWorkspaceAutoRefreshMock(options);
  },
}));

function createDiffResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    oldContent: 'before 1\nstable context\nbefore 2\n',
    newContent: 'after 1\nstable context\nafter 2\n',
    hunks: [
      {
        hunkKey: 'hunk-1',
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        lines: [
          {
            kind: 'delete',
            content: 'before 1',
            oldLineno: 1,
          },
          {
            kind: 'add',
            content: 'after 1',
            newLineno: 1,
          },
          {
            kind: 'context',
            content: 'stable context',
            oldLineno: 2,
            newLineno: 2,
          },
          {
            kind: 'delete',
            content: 'before 2',
            oldLineno: 3,
          },
          {
            kind: 'add',
            content: 'after 2',
            newLineno: 3,
          },
        ],
        changeBlocks: [
          {
            blockIndex: 0,
            lineStartIndex: 0,
            lineEndIndex: 1,
            blame: {
              authorName: 'Alice',
              authorTime: 1712304000,
              commitId: 'abc123',
              summary: 'Update before 1',
              isUncommitted: false,
            },
          },
          {
            blockIndex: 1,
            lineStartIndex: 3,
            lineEndIndex: 4,
            blame: {
              authorName: 'Bob',
              authorTime: 1712390400,
              commitId: 'def456',
              summary: 'Update before 2',
              isUncommitted: false,
            },
          },
        ],
      },
    ],
    isBinary: false,
    tooLarge: false,
    canRestoreFile: true,
    canRestorePartial: true,
    restoreMode: 'file-and-hunk',
    diffCleared: false,
    ...overrides,
  };
}

describe('DiffModal window controls', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    showContextMenuMock.mockReset();
    useWorkspaceAutoRefreshMock.mockClear();
    autoRefreshOptions.length = 0;
    useAppStore.setState((state) => ({
      ...state,
      ui: {
        activeDialog: null,
        activeNotice: null,
      },
    }));
    invokeMock.mockResolvedValue(createDiffResult());
  });

  it('supports maximize toggle for worktree diff', async () => {
    render(
      <DiffModal
        open
        onClose={vi.fn()}
        projectPath="D:\\code\\JavaScript\\mini-term"
        status={{
          path: 'src/main.ts',
          oldPath: undefined,
          status: 'modified',
          statusLabel: 'M',
        }}
      />,
    );

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalled();
    });
    expect(invokeMock.mock.calls[0]?.[0]).toBe('get_git_diff');
    expect(invokeMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        filePath: 'src/main.ts',
        oldFilePath: null,
        status: 'modified',
      }),
    );

    const dialog = screen.getByRole('dialog');
    const maximizeToggle = screen.getByTestId('diff-modal-maximize-toggle');

    expect(dialog.getAttribute('data-language-family')).toBe('web');
    expect(dialog.getAttribute('data-language-id')).toBe('typescript');
    expect(dialog.getAttribute('data-layout-mode')).toBe('windowed');

    fireEvent.click(maximizeToggle);
    expect(dialog.getAttribute('data-layout-mode')).toBe('maximized');

    fireEvent.click(maximizeToggle);
    expect(dialog.getAttribute('data-layout-mode')).toBe('windowed');
  });

  it('supports maximize toggle for commit diff', async () => {
    render(
      <CommitDiffModal
        open
        onClose={vi.fn()}
        repoPath="D:\\code\\JavaScript\\mini-term"
        commitHash="abcdef123456"
        commitMessage="feat: update diff"
        files={[
          {
            path: 'src/main.ts',
            status: 'modified',
          },
          {
            path: 'src-tauri/src/lib.rs',
            status: 'modified',
          },
        ]}
      />,
    );

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalled();
    });
    expect(invokeMock.mock.calls[0]?.[0]).toBe('get_commit_file_diff');
    expect(invokeMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        commitHash: 'abcdef123456',
        filePath: 'src/main.ts',
        oldFilePath: null,
      }),
    );

    const dialog = screen.getByRole('dialog');
    const maximizeToggle = screen.getByTestId('commit-diff-modal-maximize-toggle');

    expect(dialog.getAttribute('data-language-family')).toBe('web');
    expect(dialog.getAttribute('data-language-id')).toBe('typescript');
    expect(dialog.getAttribute('data-layout-mode')).toBe('windowed');

    fireEvent.click(maximizeToggle);
    expect(dialog.getAttribute('data-layout-mode')).toBe('maximized');

    fireEvent.click(maximizeToggle);
    expect(dialog.getAttribute('data-layout-mode')).toBe('windowed');

    fireEvent.click(screen.getByRole('button', { name: 'lib.rs' }));

    await waitFor(() => {
      expect(dialog.getAttribute('data-language-family')).toBe('rust');
      expect(dialog.getAttribute('data-language-id')).toBe('rust');
    });
  });

  it('keeps tab variants mounted but skips loading work while inactive', () => {
    render(
      <DiffModal
        variant="tab"
        active={false}
        onClose={vi.fn()}
        projectPath="D:\\code\\JavaScript\\mini-term"
        status={{
          path: 'src/main.ts',
          oldPath: undefined,
          status: 'modified',
          statusLabel: 'M',
        }}
      />,
    );

    expect(screen.getByRole('region', { name: 'worktree-diff:src/main.ts' })).not.toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('auto refreshes active worktree diff tabs when git becomes dirty', async () => {
    render(
      <DiffModal
        variant="tab"
        active
        onClose={vi.fn()}
        projectPath="D:\\code\\JavaScript\\mini-term"
        status={{
          path: 'src/main.ts',
          oldPath: undefined,
          status: 'modified',
          statusLabel: 'M',
        }}
      />,
    );

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledTimes(1);
    });

    const gitRefreshHook = autoRefreshOptions.find((item) => item.watchGit && item.active);
    expect(gitRefreshHook).toBeDefined();

    await act(async () => {
      await (gitRefreshHook?.onGitDirty as (() => Promise<void>) | undefined)?.();
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByTestId('diff-feedback')).not.toBeNull();
  });

  it('shows a global notice when auto refresh clears the diff and closes the tab', async () => {
    const onClose = vi.fn();
    let diffReadCount = 0;

    invokeMock.mockImplementation((command: string) => {
      if (command !== 'get_git_diff') {
        return Promise.reject(new Error(`unexpected command: ${command}`));
      }

      diffReadCount += 1;
      if (diffReadCount === 1) {
        return Promise.resolve(createDiffResult());
      }

      return Promise.resolve(createDiffResult({
        oldContent: '',
        newContent: '',
        hunks: [],
        canRestorePartial: false,
        restoreMode: 'file-only',
        diffCleared: true,
      }));
    });

    render(
      <>
        <DiffModal
          variant="tab"
          active
          onClose={onClose}
          projectPath="D:\\code\\JavaScript\\mini-term"
          status={{
            path: 'src/main.ts',
            oldPath: undefined,
            status: 'modified',
            statusLabel: 'M',
          }}
        />
        <GlobalNoticeHost />
      </>,
    );

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledTimes(1);
    });

    const gitRefreshHook = autoRefreshOptions.find((item) => item.watchGit && item.active);
    expect(gitRefreshHook).toBeDefined();

    await act(async () => {
      await (gitRefreshHook?.onGitDirty as (() => Promise<void>) | undefined)?.();
    });

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByTestId('global-notice')).not.toBeNull();
    expect(screen.getByText('该文件已无差异，已关闭 diff')).not.toBeNull();
  });

  it('confirms whole-file restore and closes when the diff is cleared', async () => {
    const onClose = vi.fn();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_git_diff') {
        return Promise.resolve(createDiffResult());
      }
      if (command === 'restore_git_file') {
        return Promise.resolve(createDiffResult({
          oldContent: '',
          newContent: '',
          hunks: [],
          canRestorePartial: false,
          restoreMode: 'file-only',
          diffCleared: true,
        }));
      }
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });

    render(
      <>
        <DiffModal
          open
          onClose={onClose}
          projectPath="D:\\code\\JavaScript\\mini-term"
          status={{
            path: 'src/main.ts',
            oldPath: undefined,
            status: 'modified',
            statusLabel: 'M',
          }}
        />
        <WorkspaceDialogHost />
      </>,
    );

    await screen.findByTestId('restore-file-button');
    fireEvent.click(screen.getByTestId('restore-file-button'));

    const dialog = await screen.findByTestId('message-box-dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '还原此文件' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'restore_git_file',
        expect.objectContaining({
          filePath: 'src/main.ts',
          status: 'modified',
        }),
      );
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('only opens the custom menu on changed rows and restores the targeted change block', async () => {
    const onClose = vi.fn();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'get_git_diff') {
        return Promise.resolve(createDiffResult());
      }
      if (command === 'restore_git_change_block') {
        return Promise.resolve(createDiffResult({
          oldContent: 'before 2\n',
          newContent: 'after 2 still dirty\n',
          hunks: [
            {
              hunkKey: 'hunk-2',
              oldStart: 3,
              oldLines: 1,
              newStart: 3,
              newLines: 1,
              lines: [
                { kind: 'delete', content: 'before 2', oldLineno: 3 },
                { kind: 'add', content: 'after 2 still dirty', newLineno: 3 },
              ],
              changeBlocks: [
                {
                  blockIndex: 0,
                  lineStartIndex: 0,
                  lineEndIndex: 1,
                  blame: {
                    authorName: 'Bob',
                    authorTime: 1712390400,
                    commitId: 'def456',
                    summary: 'Update before 2',
                    isUncommitted: false,
                  },
                },
              ],
            },
          ],
          diffCleared: false,
        }));
      }
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });

    render(
      <DiffModal
        open
        onClose={onClose}
        projectPath="D:\\code\\JavaScript\\mini-term"
        status={{
          path: 'src/main.ts',
          oldPath: undefined,
          status: 'modified',
          statusLabel: 'M',
        }}
      />,
    );

    const contextLine = await screen.findByTestId('right-diff-line-2');
    const changedGutter = screen.getByTestId('right-diff-gutter-4');
    const changedContent = screen.getByTestId('right-diff-content-4');

    fireEvent.contextMenu(contextLine);
    expect(showContextMenuMock).not.toHaveBeenCalled();

    fireEvent.contextMenu(changedGutter);
    expect(showContextMenuMock).not.toHaveBeenCalled();

    fireEvent.contextMenu(changedContent);
    expect(showContextMenuMock).toHaveBeenCalledTimes(1);

    const menuItems = showContextMenuMock.mock.calls[0]?.[2] as Array<{ label: string; onClick?: () => void }>;
    expect(menuItems[0]?.label).toBe('还原此修改块');

    menuItems[0]?.onClick?.();

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        'restore_git_change_block',
        expect.objectContaining({
          filePath: 'src/main.ts',
          hunkKey: 'hunk-1',
          blockIndex: 1,
          status: 'modified',
        }),
      );
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(await screen.findByText('已还原此修改块')).not.toBeNull();
  });

  it('shows a disabled context menu item when partial restore is unsupported', async () => {
    invokeMock.mockResolvedValue(createDiffResult({
      canRestorePartial: false,
      restoreMode: 'file-only',
    }));

    render(
      <DiffModal
        open
        onClose={vi.fn()}
        projectPath="D:\\code\\JavaScript\\mini-term"
        status={{
          path: 'src/new-file.ts',
          oldPath: undefined,
          status: 'added',
          statusLabel: 'A',
        }}
      />,
    );

    const diffLine = await screen.findByTestId('right-diff-content-1');
    fireEvent.contextMenu(diffLine);

    const menuItems = showContextMenuMock.mock.calls[0]?.[2] as Array<{ label: string; disabled?: boolean }>;
    expect(menuItems[0]?.label).toContain('新增文件不支持按修改块还原');
    expect(menuItems[0]?.disabled).toBe(true);
  });

  it('highlights the hovered change block and blame metadata together', async () => {
    render(
      <DiffModal
        open
        onClose={vi.fn()}
        projectPath="D:\\code\\JavaScript\\mini-term"
        status={{
          path: 'src/main.ts',
          oldPath: undefined,
          status: 'modified',
          statusLabel: 'M',
        }}
      />,
    );

    const changedContent = await screen.findByTestId('right-diff-content-4');
    const meta = screen.getByTestId('change-block-meta-1');

    expect(meta.getAttribute('data-active')).toBe('false');

    fireEvent.mouseEnter(changedContent);
    expect(meta.getAttribute('data-active')).toBe('true');

    fireEvent.mouseLeave(changedContent);
    expect(meta.getAttribute('data-active')).toBe('false');
  });

  it('renders blame metadata below changed blocks', async () => {
    render(
      <DiffModal
        open
        onClose={vi.fn()}
        projectPath="D:\\code\\JavaScript\\mini-term"
        status={{
          path: 'src/main.ts',
          oldPath: undefined,
          status: 'modified',
          statusLabel: 'M',
        }}
      />,
    );

    expect(await screen.findByText('Alice')).not.toBeNull();
    expect(screen.getByText(expectedBlameTime)).not.toBeNull();
  });
});
