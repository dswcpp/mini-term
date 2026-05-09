import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from './store';
import type {
  CommitFileInfo,
  GitFileStatus,
  ProjectState,
  SplitNode,
  TerminalTab,
  WorkspacePane,
} from './types';

function collectPanes(node: SplitNode): WorkspacePane[] {
  if (node.type === 'leaf') {
    return [node.pane];
  }
  return node.children.flatMap(collectPanes);
}

function getWorkspaceTabs() {
  return useAppStore.getState().projectStates.get('project-1')?.tabs ?? [];
}

function getSingleCanvasTab() {
  const [tab] = getWorkspaceTabs();
  expect(tab?.kind).toBe('terminal');
  if (!tab || tab.kind !== 'terminal') {
    throw new Error('expected a terminal canvas tab');
  }
  return tab;
}

function getCanvasPanes() {
  return collectPanes(getSingleCanvasTab().splitLayout);
}

function createTerminalTab(id: string, panes: WorkspacePane[], direction: 'horizontal' | 'vertical' = 'horizontal'): TerminalTab {
  return {
    kind: 'terminal',
    id,
    status: 'idle',
    splitLayout:
      panes.length === 1
        ? {
            type: 'leaf',
            pane: panes[0],
          }
        : {
            type: 'split',
            direction,
            children: panes.map((pane) => ({
              type: 'leaf',
              pane,
            })),
            sizes: panes.map(() => 100 / panes.length),
          },
  };
}

function findCanvasPane<T extends WorkspacePane['kind']>(
  kind: T,
  predicate?: (pane: Extract<WorkspacePane, { kind: T }>) => boolean,
) {
  const pane = getCanvasPanes().find((candidate) => (
    candidate.kind === kind
    && (!predicate || predicate(candidate as Extract<WorkspacePane, { kind: T }>))
  ));
  expect(pane).toBeDefined();
  return pane as Extract<WorkspacePane, { kind: T }>;
}

describe('ui dialog store', () => {
  const sampleStatus: GitFileStatus = {
    path: 'src/main.ts',
    oldPath: undefined,
    status: 'modified',
    statusLabel: 'M',
  };
  const sampleFiles: CommitFileInfo[] = [
    {
      path: 'src/main.ts',
      status: 'modified',
    },
  ];

  beforeEach(() => {
    useAppStore.setState((state) => ({
      ...state,
      projectStates: new Map<string, ProjectState>([
        [
          'project-1',
          {
            id: 'project-1',
            tabs: [],
            activeTabId: '',
          },
        ],
      ]),
      activePaneByTab: new Map(),
      ui: {
        activeDialog: null,
        activeNotice: null,
      },
    }));
  });

  it('opens settings dialog with default page', () => {
    useAppStore.getState().openSettings();

    expect(useAppStore.getState().ui.activeDialog).toEqual({
      kind: 'settings',
      page: 'terminal',
    });
  });

  it('opens file viewer as a workspace tab', () => {
    useAppStore.getState().openSettings('theme');
    useAppStore.getState().openFileViewer('project-1', 'D:/code/JavaScript/mini-term/README.md', {
      initialMode: 'preview',
    });

    expect(useAppStore.getState().ui.activeDialog).toEqual({
      kind: 'settings',
      page: 'theme',
    });
    expect(getWorkspaceTabs()).toHaveLength(1);
    expect(findCanvasPane('file-viewer', (pane) => pane.filePath === 'D:/code/JavaScript/mini-term/README.md')).toMatchObject({
      kind: 'file-viewer',
      filePath: 'D:/code/JavaScript/mini-term/README.md',
      mode: 'preview',
      status: 'idle',
    });
  });

  it('reuses an existing file viewer tab for the same path', () => {
    useAppStore.getState().openFileViewer('project-1', 'D:/code/JavaScript/mini-term/README.md');
    const firstTabId = getWorkspaceTabs()[0]?.id;
    const firstPaneId = findCanvasPane('file-viewer', (pane) => pane.filePath === 'D:/code/JavaScript/mini-term/README.md').id;

    useAppStore.getState().openFileViewer('project-1', 'D:/code/JavaScript/mini-term/README.md', {
      initialMode: 'preview',
    });

    const tabs = getWorkspaceTabs();
    const pane = findCanvasPane('file-viewer', (candidate) => candidate.filePath === 'D:/code/JavaScript/mini-term/README.md');
    expect(tabs).toHaveLength(1);
    expect(pane).toEqual({
      kind: 'file-viewer',
      id: firstPaneId,
      filePath: 'D:/code/JavaScript/mini-term/README.md',
      mode: 'preview',
      status: 'idle',
    });
    expect(useAppStore.getState().projectStates.get('project-1')?.activeTabId).toBe(firstTabId);
  });

  it('treats Windows slash variants of the same file as already open', () => {
    useAppStore.getState().openFileViewer('project-1', 'D:/code/JavaScript/mini-term/src/App.tsx');
    const firstTabId = getWorkspaceTabs()[0]?.id;
    const firstPaneId = findCanvasPane('file-viewer', (pane) => pane.filePath === 'D:/code/JavaScript/mini-term/src/App.tsx').id;

    useAppStore.getState().openFileViewer('project-1', 'D:\\code\\JavaScript\\mini-term\\src\\App.tsx');

    const tabs = getWorkspaceTabs();
    expect(tabs).toHaveLength(1);
    expect(useAppStore.getState().projectStates.get('project-1')?.activeTabId).toBe(firstTabId);
    expect(findCanvasPane('file-viewer', (pane) => pane.filePath === 'D:/code/JavaScript/mini-term/src/App.tsx')).toMatchObject({
      id: firstPaneId,
      mode: 'source',
    });
  });

  it('stores terminal navigation targets on file viewer tabs', () => {
    useAppStore.getState().openFileViewer('project-1', 'D:/code/JavaScript/mini-term/src/App.tsx', {
      initialMode: 'source',
      navigationTarget: {
        line: 12,
        column: 3,
        requestId: 1,
      },
    });

    expect(findCanvasPane('file-viewer', (pane) => pane.filePath === 'D:/code/JavaScript/mini-term/src/App.tsx')).toEqual({
      kind: 'file-viewer',
      id: expect.any(String),
      filePath: 'D:/code/JavaScript/mini-term/src/App.tsx',
      mode: 'source',
      navigationTarget: {
        line: 12,
        column: 3,
        requestId: 1,
      },
      status: 'idle',
    });
  });

  it('reuses the same file viewer tab and updates navigation request ids', () => {
    useAppStore.getState().openFileViewer('project-1', 'D:/code/JavaScript/mini-term/src/App.tsx', {
      navigationTarget: {
        line: 18,
        requestId: 1,
      },
    });
    const firstPaneId = findCanvasPane('file-viewer', (pane) => pane.filePath === 'D:/code/JavaScript/mini-term/src/App.tsx').id;

    useAppStore.getState().openFileViewer('project-1', 'D:/code/JavaScript/mini-term/src/App.tsx', {
      navigationTarget: {
        line: 18,
        requestId: 2,
      },
    });

    expect(findCanvasPane('file-viewer', (pane) => pane.filePath === 'D:/code/JavaScript/mini-term/src/App.tsx')).toEqual({
      kind: 'file-viewer',
      id: firstPaneId,
      filePath: 'D:/code/JavaScript/mini-term/src/App.tsx',
      mode: 'source',
      navigationTarget: {
        line: 18,
        requestId: 2,
      },
      status: 'idle',
    });
  });

  it('clears a prior navigation target when reopening without navigation', () => {
    useAppStore.getState().openFileViewer('project-1', 'D:/code/JavaScript/mini-term/src/App.tsx', {
      navigationTarget: {
        line: 24,
        requestId: 1,
      },
    });
    const firstPaneId = findCanvasPane('file-viewer', (pane) => pane.filePath === 'D:/code/JavaScript/mini-term/src/App.tsx').id;

    useAppStore.getState().openFileViewer('project-1', 'D:/code/JavaScript/mini-term/src/App.tsx', {
      initialMode: 'source',
    });

    expect(findCanvasPane('file-viewer', (pane) => pane.filePath === 'D:/code/JavaScript/mini-term/src/App.tsx')).toEqual({
      kind: 'file-viewer',
      id: firstPaneId,
      filePath: 'D:/code/JavaScript/mini-term/src/App.tsx',
      mode: 'source',
      status: 'idle',
    });
  });

  it('updates file viewer tab mode in place', () => {
    useAppStore.getState().openFileViewer('project-1', 'D:/code/JavaScript/mini-term/README.md');
    const paneId = findCanvasPane('file-viewer', (pane) => pane.filePath === 'D:/code/JavaScript/mini-term/README.md').id;

    expect(paneId).toBeTruthy();

    useAppStore.getState().setFileViewerTabMode('project-1', paneId!, 'preview');

    expect(findCanvasPane('file-viewer', (pane) => pane.filePath === 'D:/code/JavaScript/mini-term/README.md')).toEqual({
      kind: 'file-viewer',
      id: paneId,
      filePath: 'D:/code/JavaScript/mini-term/README.md',
      mode: 'preview',
      status: 'idle',
    });
  });

  it('defaults svg and document preview types to preview mode', () => {
    useAppStore.getState().openFileViewer('project-1', 'D:/code/JavaScript/mini-term/docs/diagram.svg');
    useAppStore.getState().openFileViewer('project-1', 'D:/code/JavaScript/mini-term/docs/guide.pdf');
    useAppStore.getState().openFileViewer('project-1', 'D:/code/JavaScript/mini-term/docs/guide.docx');

    expect(getWorkspaceTabs()).toHaveLength(1);
    expect(getCanvasPanes()).toHaveLength(3);
    expect(findCanvasPane('file-viewer', (pane) => pane.filePath === 'D:/code/JavaScript/mini-term/docs/diagram.svg')).toMatchObject({
      filePath: 'D:/code/JavaScript/mini-term/docs/diagram.svg',
      mode: 'preview',
    });
    expect(findCanvasPane('file-viewer', (pane) => pane.filePath === 'D:/code/JavaScript/mini-term/docs/guide.pdf')).toMatchObject({
      filePath: 'D:/code/JavaScript/mini-term/docs/guide.pdf',
      mode: 'preview',
    });
    expect(findCanvasPane('file-viewer', (pane) => pane.filePath === 'D:/code/JavaScript/mini-term/docs/guide.docx')).toMatchObject({
      filePath: 'D:/code/JavaScript/mini-term/docs/guide.docx',
      mode: 'preview',
    });
  });

  it('keeps source mode for regular code files', () => {
    useAppStore.getState().openFileViewer('project-1', 'D:/code/JavaScript/mini-term/src/main.ts');

    expect(findCanvasPane('file-viewer', (pane) => pane.filePath === 'D:/code/JavaScript/mini-term/src/main.ts')).toMatchObject({
      filePath: 'D:/code/JavaScript/mini-term/src/main.ts',
      mode: 'source',
    });
  });

  it('opens worktree diff as a workspace tab', () => {
    useAppStore.getState().openWorktreeDiff('project-1', 'D:/code/JavaScript/mini-term', sampleStatus);

    expect(findCanvasPane('worktree-diff', (pane) => pane.projectPath === 'D:/code/JavaScript/mini-term')).toEqual({
      kind: 'worktree-diff',
      id: expect.any(String),
      projectPath: 'D:/code/JavaScript/mini-term',
      gitStatus: sampleStatus,
      status: 'idle',
    });
  });

  it('reuses an existing worktree diff tab for the same file', () => {
    useAppStore.getState().openWorktreeDiff('project-1', 'D:/code/JavaScript/mini-term', sampleStatus);
    const firstPaneId = findCanvasPane(
      'worktree-diff',
      (pane) => pane.projectPath === 'D:/code/JavaScript/mini-term' && pane.gitStatus.path === sampleStatus.path,
    ).id;

    useAppStore.getState().openWorktreeDiff('project-1', 'D:/code/JavaScript/mini-term', sampleStatus);

    const tabs = getWorkspaceTabs();
    expect(tabs).toHaveLength(1);
    expect(findCanvasPane('worktree-diff', (pane) => pane.projectPath === 'D:/code/JavaScript/mini-term')).toEqual({
      kind: 'worktree-diff',
      id: firstPaneId,
      projectPath: 'D:/code/JavaScript/mini-term',
      gitStatus: sampleStatus,
      status: 'idle',
    });
  });

  it('treats Windows slash variants as the same worktree diff target', () => {
    useAppStore.getState().openWorktreeDiff('project-1', 'D:/code/JavaScript/mini-term', sampleStatus);
    const firstPaneId = findCanvasPane(
      'worktree-diff',
      (pane) => pane.projectPath === 'D:/code/JavaScript/mini-term' && pane.gitStatus.path === sampleStatus.path,
    ).id;

    useAppStore.getState().openWorktreeDiff('project-1', 'D:\\code\\JavaScript\\mini-term', {
      ...sampleStatus,
      path: 'src\\main.ts',
    });

    const tabs = getWorkspaceTabs();
    expect(tabs).toHaveLength(1);
    expect(findCanvasPane('worktree-diff', (pane) => pane.projectPath === 'D:/code/JavaScript/mini-term')).toEqual({
      kind: 'worktree-diff',
      id: firstPaneId,
      projectPath: 'D:/code/JavaScript/mini-term',
      gitStatus: {
        ...sampleStatus,
        path: 'src\\main.ts',
      },
      status: 'idle',
    });
  });

  it('stores confirm dialog payloads', () => {
    useAppStore.getState().openInteractionDialog({
      dialogId: 'message-box-1',
      mode: 'confirm',
      title: '关闭确认',
      message: '确定要关闭 Mini-Term 吗？',
      detail: '当前布局会先保存。',
      confirmLabel: '关闭应用',
      cancelLabel: '取消',
      tone: 'warning',
    });

    expect(useAppStore.getState().ui.activeDialog).toEqual({
      kind: 'interaction-dialog',
      dialogId: 'message-box-1',
      mode: 'confirm',
      title: '关闭确认',
      message: '确定要关闭 Mini-Term 吗？',
      detail: '当前布局会先保存。',
      confirmLabel: '关闭应用',
      cancelLabel: '取消',
      tone: 'warning',
    });
  });

  it('opens commit diff as a workspace tab', () => {
    useAppStore.getState().openCommitDiff({
      projectId: 'project-1',
      repoPath: 'D:/code/JavaScript/mini-term',
      commitHash: 'abc1234',
      commitMessage: 'test commit',
      files: sampleFiles,
    });

    expect(findCanvasPane('commit-diff', (pane) => pane.repoPath === 'D:/code/JavaScript/mini-term')).toEqual({
      kind: 'commit-diff',
      id: expect.any(String),
      repoPath: 'D:/code/JavaScript/mini-term',
      commitHash: 'abc1234',
      commitMessage: 'test commit',
      files: sampleFiles,
      status: 'idle',
    });
  });

  it('reuses an existing commit diff tab for the same commit', () => {
    useAppStore.getState().openCommitDiff({
      projectId: 'project-1',
      repoPath: 'D:/code/JavaScript/mini-term',
      commitHash: 'abc1234',
      commitMessage: 'test commit',
      files: sampleFiles,
    });
    const firstPaneId = findCanvasPane(
      'commit-diff',
      (pane) => pane.repoPath === 'D:/code/JavaScript/mini-term' && pane.commitHash === 'abc1234',
    ).id;

    useAppStore.getState().openCommitDiff({
      projectId: 'project-1',
      repoPath: 'D:/code/JavaScript/mini-term',
      commitHash: 'abc1234',
      commitMessage: 'test commit',
      files: sampleFiles,
    });

    const tabs = getWorkspaceTabs();
    expect(tabs).toHaveLength(1);
    expect(findCanvasPane('commit-diff', (pane) => pane.repoPath === 'D:/code/JavaScript/mini-term')).toEqual({
      kind: 'commit-diff',
      id: firstPaneId,
      repoPath: 'D:/code/JavaScript/mini-term',
      commitHash: 'abc1234',
      commitMessage: 'test commit',
      files: sampleFiles,
      status: 'idle',
    });
  });

  it('treats Windows slash variants as the same file history target', () => {
    useAppStore.getState().openFileHistory('project-1', 'D:/code/JavaScript/mini-term', 'D:/code/JavaScript/mini-term/src/main.ts');
    const firstPaneId = findCanvasPane(
      'file-history',
      (pane) => pane.projectPath === 'D:/code/JavaScript/mini-term' && pane.filePath === 'D:/code/JavaScript/mini-term/src/main.ts',
    ).id;

    useAppStore.getState().openFileHistory(
      'project-1',
      'D:\\code\\JavaScript\\mini-term',
      'D:\\code\\JavaScript\\mini-term\\src\\main.ts',
    );

    const tabs = getWorkspaceTabs();
    expect(tabs).toHaveLength(1);
    expect(findCanvasPane('file-history', (pane) => pane.projectPath === 'D:/code/JavaScript/mini-term')).toEqual({
      kind: 'file-history',
      id: firstPaneId,
      projectPath: 'D:/code/JavaScript/mini-term',
      filePath: 'D:/code/JavaScript/mini-term/src/main.ts',
      status: 'idle',
    });
  });

  it('treats Windows slash variants as the same commit diff repo target', () => {
    useAppStore.getState().openCommitDiff({
      projectId: 'project-1',
      repoPath: 'D:/code/JavaScript/mini-term',
      commitHash: 'abc1234',
      commitMessage: 'test commit',
      files: sampleFiles,
    });
    const firstPaneId = findCanvasPane(
      'commit-diff',
      (pane) => pane.repoPath === 'D:/code/JavaScript/mini-term' && pane.commitHash === 'abc1234',
    ).id;

    useAppStore.getState().openCommitDiff({
      projectId: 'project-1',
      repoPath: 'D:\\code\\JavaScript\\mini-term',
      commitHash: 'abc1234',
      commitMessage: 'test commit updated',
      files: sampleFiles,
    });

    const tabs = getWorkspaceTabs();
    expect(tabs).toHaveLength(1);
    expect(findCanvasPane('commit-diff', (pane) => pane.repoPath === 'D:/code/JavaScript/mini-term')).toEqual({
      kind: 'commit-diff',
      id: firstPaneId,
      repoPath: 'D:/code/JavaScript/mini-term',
      commitHash: 'abc1234',
      commitMessage: 'test commit updated',
      files: sampleFiles,
      status: 'idle',
    });
  });

  it('stores prompt dialog payloads', () => {
    useAppStore.getState().openInteractionDialog({
      dialogId: 'prompt-1',
      mode: 'prompt',
      title: '新建文件',
      message: 'Enter 确认，Esc 取消',
      detail: '输入内容后按 Enter 提交',
      placeholder: '请输入文件名',
      initialValue: 'README.md',
      confirmLabel: '确定',
      cancelLabel: '取消',
      readOnly: false,
    });

    expect(useAppStore.getState().ui.activeDialog).toEqual({
      kind: 'interaction-dialog',
      dialogId: 'prompt-1',
      mode: 'prompt',
      title: '新建文件',
      message: 'Enter 确认，Esc 取消',
      detail: '输入内容后按 Enter 提交',
      placeholder: '请输入文件名',
      initialValue: 'README.md',
      confirmLabel: '确定',
      cancelLabel: '取消',
      readOnly: false,
    });
  });

  it('clears the active dialog on close', () => {
    useAppStore.getState().openSettings();
    useAppStore.getState().closeDialog();

    expect(useAppStore.getState().ui.activeDialog).toBeNull();
  });

  it('stores a global notice without clearing the active dialog', () => {
    useAppStore.getState().openSettings('theme');
    useAppStore.getState().showNotice({
      message: '该文件已无差异，已关闭 diff',
      tone: 'success',
    });

    expect(useAppStore.getState().ui.activeDialog).toEqual({
      kind: 'settings',
      page: 'theme',
    });
    expect(useAppStore.getState().ui.activeNotice).toEqual({
      id: expect.any(String),
      message: '该文件已无差异，已关闭 diff',
      tone: 'success',
      durationMs: 1500,
      createdAt: expect.any(Number),
    });
  });

  it('preserves the active pane when moving a split terminal tab into another tab', () => {
    const paneA: WorkspacePane = {
      kind: 'terminal',
      id: 'pane-a',
      sessionId: 'session-a',
      shellName: 'PowerShell',
      mode: 'human',
      ptyId: 101,
      status: 'idle',
      phase: 'ready',
    };
    const paneB: WorkspacePane = {
      kind: 'terminal',
      id: 'pane-b',
      sessionId: 'session-b',
      shellName: 'PowerShell',
      mode: 'human',
      ptyId: 102,
      status: 'idle',
      phase: 'ready',
    };

    useAppStore.setState((state) => ({
      ...state,
      projectStates: new Map<string, ProjectState>([
        [
          'project-1',
          {
            id: 'project-1',
            activeTabId: 'source-tab',
            tabs: [
              createTerminalTab('source-tab', [paneA, paneB]),
              {
                kind: 'file-viewer',
                id: 'target-tab',
                filePath: 'D:/code/JavaScript/mini-term/README.md',
                mode: 'preview',
                status: 'idle',
              },
            ],
          },
        ],
      ]),
      activePaneByTab: new Map([
        ['source-tab', 'pane-b'],
      ]),
    }));

    useAppStore.getState().moveWorkspaceTabToPane(
      'project-1',
      'source-tab',
      'target-tab',
      undefined,
      'horizontal',
      'after',
    );

    const workspaceState = useAppStore.getState().projectStates.get('project-1');
    expect(workspaceState?.activeTabId).toBe('target-tab');
    expect(workspaceState?.tabs).toHaveLength(1);
    expect(workspaceState?.tabs[0]?.id).toBe('target-tab');
    expect(workspaceState?.tabs[0]?.kind).toBe('terminal');
    expect(useAppStore.getState().activePaneByTab.get('target-tab')).toBe('pane-b');

    if (!workspaceState || workspaceState.tabs[0]?.kind !== 'terminal') {
      throw new Error('expected target tab to become a terminal canvas');
    }

    const paneIds = collectPanes(workspaceState.tabs[0].splitLayout).map((pane) => pane.id);
    expect(paneIds).toEqual(expect.arrayContaining(['pane-a', 'pane-b']));
  });

  it('promotes a split pane to a sibling top-level tab beside its source tab', () => {
    const terminalPane: WorkspacePane = {
      kind: 'terminal',
      id: 'pane-terminal',
      sessionId: 'session-terminal',
      shellName: 'PowerShell',
      mode: 'human',
      ptyId: 201,
      status: 'idle',
      phase: 'ready',
    };
    const filePane: WorkspacePane = {
      kind: 'file-viewer',
      id: 'pane-file',
      filePath: 'D:/code/JavaScript/mini-term/README.md',
      mode: 'preview',
      status: 'idle',
    };

    useAppStore.setState((state) => ({
      ...state,
      projectStates: new Map<string, ProjectState>([
        [
          'project-1',
          {
            id: 'project-1',
            activeTabId: 'source-tab',
            tabs: [
              createTerminalTab('source-tab', [terminalPane, filePane]),
            ],
          },
        ],
      ]),
      activePaneByTab: new Map([
        ['source-tab', 'pane-file'],
      ]),
    }));

    useAppStore.getState().moveWorkspacePaneToTab(
      'project-1',
      'source-tab',
      'pane-file',
      'source-tab',
      'after',
    );

    const workspaceState = useAppStore.getState().projectStates.get('project-1');
    expect(workspaceState?.tabs).toHaveLength(2);
    expect(workspaceState?.tabs[0]?.id).toBe('source-tab');
    expect(workspaceState?.activeTabId).toBe(workspaceState?.tabs[1]?.id);
    expect(useAppStore.getState().activePaneByTab.get('source-tab')).toBe('pane-terminal');

    const promotedTab = workspaceState?.tabs[1];
    expect(promotedTab?.kind).toBe('terminal');
    if (!promotedTab || promotedTab.kind !== 'terminal') {
      throw new Error('expected promoted tab to be a terminal canvas');
    }

    expect(promotedTab.splitLayout).toMatchObject({
      type: 'leaf',
      pane: {
        kind: 'file-viewer',
        id: 'pane-file',
        filePath: 'D:/code/JavaScript/mini-term/README.md',
      },
    });
    expect(useAppStore.getState().activePaneByTab.get(promotedTab.id)).toBe('pane-file');
  });

  it('promotes a split pane to a sibling top-level tab beside another tab', () => {
    const terminalPane: WorkspacePane = {
      kind: 'terminal',
      id: 'pane-terminal',
      sessionId: 'session-terminal',
      shellName: 'PowerShell',
      mode: 'human',
      ptyId: 301,
      status: 'idle',
      phase: 'ready',
    };
    const historyPane: WorkspacePane = {
      kind: 'file-history',
      id: 'pane-history',
      projectPath: 'D:/code/JavaScript/mini-term',
      filePath: 'D:/code/JavaScript/mini-term/src/main.ts',
      status: 'idle',
    };
    const targetPane: WorkspacePane = {
      kind: 'terminal',
      id: 'pane-target',
      sessionId: 'session-target',
      shellName: 'cmd',
      mode: 'human',
      ptyId: 302,
      status: 'idle',
      phase: 'ready',
    };

    useAppStore.setState((state) => ({
      ...state,
      projectStates: new Map<string, ProjectState>([
        [
          'project-1',
          {
            id: 'project-1',
            activeTabId: 'target-tab',
            tabs: [
              createTerminalTab('source-tab', [terminalPane, historyPane]),
              createTerminalTab('target-tab', [targetPane]),
            ],
          },
        ],
      ]),
      activePaneByTab: new Map([
        ['source-tab', 'pane-history'],
        ['target-tab', 'pane-target'],
      ]),
    }));

    useAppStore.getState().moveWorkspacePaneToTab(
      'project-1',
      'source-tab',
      'pane-history',
      'target-tab',
      'before',
    );

    const workspaceState = useAppStore.getState().projectStates.get('project-1');
    expect(workspaceState?.tabs).toHaveLength(3);
    expect(workspaceState?.tabs[0]?.id).toBe('source-tab');
    expect(workspaceState?.tabs[2]?.id).toBe('target-tab');
    expect(workspaceState?.activeTabId).toBe(workspaceState?.tabs[1]?.id);
    expect(useAppStore.getState().activePaneByTab.get('source-tab')).toBe('pane-terminal');

    const promotedTab = workspaceState?.tabs[1];
    expect(promotedTab?.kind).toBe('terminal');
    if (!promotedTab || promotedTab.kind !== 'terminal') {
      throw new Error('expected promoted tab to be a terminal canvas');
    }

    expect(promotedTab.splitLayout).toMatchObject({
      type: 'leaf',
      pane: {
        kind: 'file-history',
        id: 'pane-history',
        projectPath: 'D:/code/JavaScript/mini-term',
        filePath: 'D:/code/JavaScript/mini-term/src/main.ts',
      },
    });
    expect(useAppStore.getState().activePaneByTab.get(promotedTab.id)).toBe('pane-history');
  });

  it('does not clear a newer notice when given a stale notice id', () => {
    useAppStore.getState().showNotice({
      message: '第一条提示',
      tone: 'info',
    });
    const firstNoticeId = useAppStore.getState().ui.activeNotice?.id;

    useAppStore.getState().showNotice({
      message: '第二条提示',
      tone: 'success',
    });
    const secondNotice = useAppStore.getState().ui.activeNotice;

    expect(firstNoticeId).toBeTruthy();
    expect(secondNotice?.message).toBe('第二条提示');

    useAppStore.getState().clearNotice(firstNoticeId);

    expect(useAppStore.getState().ui.activeNotice).toEqual(secondNotice);
  });
});
