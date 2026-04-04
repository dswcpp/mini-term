import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommitDiffModal } from './CommitDiffModal';
import { DiffModal } from './DiffModal';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: unknown) => invokeMock(command, args),
}));

describe('DiffModal window controls', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({
      oldContent: '',
      newContent: '',
      hunks: [],
      isBinary: false,
      tooLarge: false,
    });
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
});
