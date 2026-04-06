import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalArea } from './TerminalArea';
import { useAppStore } from '../store';
import type {
  FileViewerTab,
  GitFileStatus,
  TerminalTab,
  WorkspaceConfig,
  WorkspaceState,
  WorktreeDiffTab,
} from '../types';

const hostSpies = vi.hoisted(() => ({
  documentTabHost: vi.fn(),
  worktreeDiffTabHost: vi.fn(),
}));

vi.mock('./TabBar', () => ({
  TabBar: () => <div data-testid="mock-tab-bar">tab bar</div>,
}));

vi.mock('./TerminalTabHost', () => ({
  TerminalTabHost: ({ tab, isActive }: { tab: { id: string }; isActive: boolean }) => (
    <div data-testid={`terminal-host-${tab.id}`} data-active={String(isActive)}>
      terminal host
    </div>
  ),
}));

vi.mock('./DocumentTabHost', () => ({
  DocumentTabHost: ({ tab, isActive }: { tab: { id: string }; isActive: boolean }) => {
    hostSpies.documentTabHost(tab.id, isActive);
    return (
      <div data-testid={`document-host-${tab.id}`} data-active={String(isActive)}>
        document host
      </div>
    );
  },
}));

vi.mock('./DiffTabHost', () => ({
  WorktreeDiffTabHost: ({ tab, isActive }: { tab: { id: string }; isActive: boolean }) => {
    hostSpies.worktreeDiffTabHost(tab.id, isActive);
    return (
      <div data-testid={`worktree-diff-host-${tab.id}`} data-active={String(isActive)}>
        worktree diff host
      </div>
    );
  },
  FileHistoryViewTabHost: ({ tab, isActive }: { tab: { id: string }; isActive: boolean }) => (
    <div data-testid={`file-history-host-${tab.id}`} data-active={String(isActive)}>
      file history host
    </div>
  ),
  CommitDiffTabHost: ({ tab, isActive }: { tab: { id: string }; isActive: boolean }) => (
    <div data-testid={`commit-diff-host-${tab.id}`} data-active={String(isActive)}>
      commit diff host
    </div>
  ),
}));

vi.mock('./AgentTaskPanelTabHost', () => ({
  AgentTaskPanelTabHost: ({ tab, isActive }: { tab: { id: string }; isActive: boolean }) => (
    <div data-testid={`agent-task-host-${tab.id}`} data-active={String(isActive)}>
      agent task host
    </div>
  ),
}));

const workspace: WorkspaceConfig = {
  id: 'workspace-1',
  name: 'mini-term',
  roots: [
    {
      id: 'root-1',
      name: 'mini-term',
      path: 'D:/code/JavaScript/mini-term',
      role: 'primary',
    },
  ],
  pinned: true,
  createdAt: 1,
  lastOpenedAt: 1,
};

const terminalTab: TerminalTab = {
  kind: 'terminal',
  id: 'terminal-1',
  status: 'idle',
  splitLayout: {
    type: 'leaf',
    pane: {
      id: 'pane-1',
      sessionId: 'session-1',
      shellName: 'PowerShell',
      mode: 'human',
      ptyId: 1,
      status: 'idle',
      phase: 'ready',
    },
  },
};

function buildFileViewerTab(): FileViewerTab {
  return {
    kind: 'file-viewer',
    id: 'file-1',
    filePath: 'D:/code/JavaScript/mini-term/README.md',
    mode: 'preview',
    status: 'idle',
  };
}

function buildWorktreeDiffTab(): WorktreeDiffTab {
  const status: GitFileStatus = {
    path: 'src/components/TerminalArea.tsx',
    status: 'modified',
    statusLabel: 'M',
  };

  return {
    kind: 'worktree-diff',
    id: 'diff-1',
    projectPath: 'D:/code/JavaScript/mini-term',
    status,
  };
}

function applyWorkspaceState(tabs: WorkspaceState['tabs'], activeTabId: string) {
  const workspaceStates = new Map<string, WorkspaceState>([
    [
      workspace.id,
      {
        id: workspace.id,
        tabs,
        activeTabId,
      },
    ],
  ]);

  useAppStore.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      workspaces: [workspace],
      availableShells: [
        {
          name: 'PowerShell',
          command: 'pwsh.exe',
        },
      ],
      defaultShell: 'PowerShell',
    },
    activeWorkspaceId: workspace.id,
    workspaceStates,
    projectStates: workspaceStates,
  }));
}

describe('TerminalArea deferred tabs', () => {
  beforeEach(() => {
    hostSpies.documentTabHost.mockClear();
    hostSpies.worktreeDiffTabHost.mockClear();
  });

  it('does not render hidden file viewer tabs until first activation, then keeps them mounted', async () => {
    applyWorkspaceState([terminalTab, buildFileViewerTab()], terminalTab.id);

    render(
      <TerminalArea
        workspaceId={workspace.id}
        workspacePath="D:/code/JavaScript/mini-term"
        isVisible
      />,
    );

    expect(screen.getByTestId('terminal-host-terminal-1')).not.toBeNull();
    expect(screen.queryByTestId('document-host-file-1')).toBeNull();
    expect(hostSpies.documentTabHost).not.toHaveBeenCalled();

    act(() => {
      useAppStore.getState().setActiveTab(workspace.id, 'file-1');
    });

    await waitFor(() => {
      expect(screen.getByTestId('document-host-file-1')).not.toBeNull();
    });
    expect(hostSpies.documentTabHost).toHaveBeenCalled();

    act(() => {
      useAppStore.getState().setActiveTab(workspace.id, terminalTab.id);
    });

    await waitFor(() => {
      expect(screen.getByTestId('document-host-file-1').getAttribute('data-active')).toBe('false');
    });
  });

  it('does not resolve hidden diff tabs until first activation, then preserves them off-screen', async () => {
    applyWorkspaceState([terminalTab, buildWorktreeDiffTab()], terminalTab.id);

    render(
      <TerminalArea
        workspaceId={workspace.id}
        workspacePath="D:/code/JavaScript/mini-term"
        isVisible
      />,
    );

    expect(screen.queryByTestId('worktree-diff-host-diff-1')).toBeNull();
    expect(hostSpies.worktreeDiffTabHost).not.toHaveBeenCalled();

    act(() => {
      useAppStore.getState().setActiveTab(workspace.id, 'diff-1');
    });

    await waitFor(() => {
      expect(screen.getByTestId('worktree-diff-host-diff-1')).not.toBeNull();
    });
    expect(hostSpies.worktreeDiffTabHost).toHaveBeenCalled();

    act(() => {
      useAppStore.getState().setActiveTab(workspace.id, terminalTab.id);
    });

    await waitFor(() => {
      expect(screen.getByTestId('worktree-diff-host-diff-1').getAttribute('data-active')).toBe('false');
    });
  });
});
