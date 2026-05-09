import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../store';
import type { ProjectState } from '../types';

const dragState = vi.hoisted(() => ({
  beginLayoutDrag: vi.fn(),
  getLayoutDragPayload: vi.fn<() => unknown>(() => null),
  getLayoutDropTarget: vi.fn(() => null),
  isLayoutDragging: vi.fn(() => false),
  onLayoutDragEnd: vi.fn(() => () => {}),
  setLayoutDropTarget: vi.fn(),
}));

vi.mock('../utils/dragState', () => dragState);

import { TabBar } from './TabBar';

describe('TabBar', () => {
  beforeEach(() => {
    dragState.beginLayoutDrag.mockReset();
    dragState.getLayoutDragPayload.mockReset();
    dragState.getLayoutDragPayload.mockReturnValue(null);
    dragState.getLayoutDropTarget.mockReset();
    dragState.getLayoutDropTarget.mockReturnValue(null);
    dragState.isLayoutDragging.mockReset();
    dragState.isLayoutDragging.mockReturnValue(false);
    dragState.onLayoutDragEnd.mockReset();
    dragState.onLayoutDragEnd.mockImplementation(() => () => {});
    dragState.setLayoutDropTarget.mockReset();

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
                id: 'file-mermaid',
                filePath: 'D:/code/JavaScript/mini-term/docs/flow.mmd',
                mode: 'preview',
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
                kind: 'file-history',
                id: 'file-history',
                projectPath: 'D:/code/JavaScript/mini-term',
                filePath: 'D:/code/JavaScript/mini-term/src/components/FileTree.tsx',
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
              {
                kind: 'agent-tasks',
                id: 'agent-tasks',
                filter: {
                  scope: 'workspace',
                  attention: 'all',
                  target: 'all',
                },
                selectedTaskId: 'task-1',
                status: 'idle',
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
    const mermaidTab = screen.getByTestId('workspace-tab-file-mermaid');

    expect(previewTab.textContent).toContain('README.md');
    expect(within(previewTab).getByText('PREVIEW')).not.toBeNull();

    expect(sourceTab.textContent).toContain('guide.md');
    expect(within(sourceTab).getByText('MD')).not.toBeNull();

    expect(mermaidTab.textContent).toContain('flow.mmd');
    expect(within(mermaidTab).getByText('PREVIEW')).not.toBeNull();
  });

  it('shows relative path context for file and worktree tabs', () => {
    render(<TabBar projectId="project-1" onNewTab={vi.fn()} onCloseTab={vi.fn()} />);

    expect(screen.getByTestId('workspace-tab-detail-file-source').textContent).toBe('docs');
    expect(screen.getByTestId('workspace-tab-detail-file-text').textContent).toBe('src');
    expect(screen.getByTestId('workspace-tab-detail-worktree-diff').textContent).toBe('src/components');
    expect(screen.getByTestId('workspace-tab-detail-file-history').textContent).toBe('src/components');
  });

  it('shows language badges for source and diff tabs', () => {
    render(<TabBar projectId="project-1" onNewTab={vi.fn()} onCloseTab={vi.fn()} />);

    const textTab = screen.getByTestId('workspace-tab-file-text');
    const worktreeTab = screen.getByTestId('workspace-tab-worktree-diff');
    const historyTab = screen.getByTestId('workspace-tab-file-history');
    const commitTab = screen.getByTestId('workspace-tab-commit-diff');

    expect(textTab.textContent).toContain('main.ts');
    expect(within(textTab).queryByText('PREVIEW')).toBeNull();
    expect(within(textTab).getByText('WEB')).not.toBeNull();

    expect(worktreeTab.textContent).toContain('TabBar.tsx');
    expect(within(worktreeTab).getByText('WEB')).not.toBeNull();

    expect(historyTab.textContent).toContain('FileTree.tsx');
    expect(within(historyTab).getByText('WEB')).not.toBeNull();

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

  it('renders agent task tabs with workspace context', () => {
    render(<TabBar projectId="project-1" onNewTab={vi.fn()} onCloseTab={vi.fn()} />);

    const taskTab = screen.getByTestId('workspace-tab-agent-tasks');
    expect(taskTab.textContent).toContain('Tasks');
    expect(screen.getByTestId('workspace-tab-detail-agent-tasks').textContent).toBe('mini-term');
  });

  it('shows sibling-page hint when a pane hovers over a tab drop target', () => {
    dragState.isLayoutDragging.mockReturnValue(true);
    dragState.getLayoutDragPayload.mockReturnValue({
      kind: 'pane',
      workspaceId: 'project-1',
      tabId: 'terminal-tab',
      paneId: 'pane-1',
    });

    render(<TabBar projectId="project-1" onNewTab={vi.fn()} onCloseTab={vi.fn()} />);

    const targetTab = screen.getByTestId('workspace-tab-file-source');
    Object.defineProperty(targetTab, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 100,
        right: 240,
        top: 0,
        bottom: 32,
        width: 140,
        height: 32,
        x: 100,
        y: 0,
        toJSON: () => ({}),
      }),
    });

    fireEvent.mouseEnter(targetTab, { clientX: 120, clientY: 10 });

    expect(screen.getByTestId('workspace-tab-bar-pane-lift-hint').textContent).toContain('???????');
    expect(targetTab.getAttribute('data-lift-target')).toBe('true');
    expect(screen.getByTestId('workspace-tab-pane-lift-file-source').textContent).toContain('同级页面');
    expect(dragState.setLayoutDropTarget).toHaveBeenCalledWith({
      workspaceId: 'project-1',
      tabId: 'file-source',
      kind: 'tab-bar',
      position: 'before',
    });
  });
});
