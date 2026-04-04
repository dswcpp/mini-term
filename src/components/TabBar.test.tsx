import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../store';
import type { ProjectState } from '../types';
import { TabBar } from './TabBar';

describe('TabBar', () => {
  beforeEach(() => {
    useAppStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        projects: [
          {
            id: 'project-1',
            name: 'mini-term',
            path: 'D:/code/JavaScript/mini-term',
          },
        ],
      },
      projectStates: new Map<string, ProjectState>([
        [
          'project-1',
          {
            id: 'project-1',
            activeTabId: 'file-preview',
            tabs: [
              {
                kind: 'file-viewer',
                id: 'file-preview',
                filePath: 'D:/code/JavaScript/mini-term/README.md',
                mode: 'preview',
                status: 'idle',
              },
              {
                kind: 'file-viewer',
                id: 'file-source',
                filePath: 'D:/code/JavaScript/mini-term/docs/guide.md',
                mode: 'source',
                status: 'idle',
              },
              {
                kind: 'file-viewer',
                id: 'file-text',
                filePath: 'D:/code/JavaScript/mini-term/src/main.ts',
                mode: 'source',
                status: 'idle',
              },
              {
                kind: 'worktree-diff',
                id: 'worktree-diff',
                projectPath: 'D:/code/JavaScript/mini-term',
                status: {
                  path: 'src/components/TabBar.tsx',
                  status: 'modified',
                  statusLabel: 'M',
                },
              },
              {
                kind: 'commit-diff',
                id: 'commit-diff',
                repoPath: 'D:/code/JavaScript/mini-term',
                commitHash: 'abc1234def5678',
                commitMessage: 'feat: improve diff tabs',
                files: [
                  {
                    path: 'src/components/TabBar.tsx',
                    status: 'modified',
                  },
                ],
              },
            ],
          },
        ],
      ]),
    }));
  });

  it('shows markdown preview and source badges for file viewer tabs', () => {
    render(<TabBar projectId="project-1" onNewTab={vi.fn()} onCloseTab={vi.fn()} />);

    const previewTab = screen.getByTestId('workspace-tab-file-preview');
    const sourceTab = screen.getByTestId('workspace-tab-file-source');

    expect(previewTab.textContent).toContain('README.md');
    expect(within(previewTab).getByText('PREVIEW')).not.toBeNull();

    expect(sourceTab.textContent).toContain('guide.md');
    expect(within(sourceTab).getByText('MD')).not.toBeNull();
  });

  it('shows relative path context for file and worktree tabs', () => {
    render(<TabBar projectId="project-1" onNewTab={vi.fn()} onCloseTab={vi.fn()} />);

    expect(screen.getByTestId('workspace-tab-detail-file-source').textContent).toBe('docs');
    expect(screen.getByTestId('workspace-tab-detail-file-text').textContent).toBe('src');
    expect(screen.getByTestId('workspace-tab-detail-worktree-diff').textContent).toBe('src/components');
  });

  it('shows language badges for source and diff tabs', () => {
    render(<TabBar projectId="project-1" onNewTab={vi.fn()} onCloseTab={vi.fn()} />);

    const textTab = screen.getByTestId('workspace-tab-file-text');
    const worktreeTab = screen.getByTestId('workspace-tab-worktree-diff');
    const commitTab = screen.getByTestId('workspace-tab-commit-diff');

    expect(textTab.textContent).toContain('main.ts');
    expect(within(textTab).queryByText('PREVIEW')).toBeNull();
    expect(within(textTab).getByText('WEB')).not.toBeNull();

    expect(worktreeTab.textContent).toContain('TabBar.tsx');
    expect(within(worktreeTab).getByText('WEB')).not.toBeNull();

    expect(commitTab.textContent).toContain('feat: improve diff tabs');
    expect(screen.getByTestId('workspace-tab-detail-commit-diff').textContent).toBe('abc1234');
    expect(within(commitTab).getByText('WEB')).not.toBeNull();
  });

  it('shows MIX badge for commit diff tabs with multiple language families', () => {
    useAppStore.setState((state) => ({
      ...state,
      projectStates: new Map<string, ProjectState>([
        [
          'project-1',
          {
            ...(state.projectStates.get('project-1') as ProjectState),
            activeTabId: 'commit-diff',
            tabs: (state.projectStates.get('project-1') as ProjectState).tabs.map((tab) =>
              tab.kind === 'commit-diff'
                ? {
                    ...tab,
                    files: [
                      {
                        path: 'src/components/TabBar.tsx',
                        status: 'modified',
                      },
                      {
                        path: 'src-tauri/src/lib.rs',
                        status: 'modified',
                      },
                    ],
                  }
                : tab,
            ),
          },
        ],
      ]),
    }));

    render(<TabBar projectId="project-1" onNewTab={vi.fn()} onCloseTab={vi.fn()} />);

    expect(within(screen.getByTestId('workspace-tab-commit-diff')).getByText('MIX')).not.toBeNull();
  });
});
