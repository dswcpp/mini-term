import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from './store';
import type { CommitFileInfo, GitFileStatus, ProjectState } from './types';

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
      ui: {
        activeDialog: null,
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
    expect(useAppStore.getState().projectStates.get('project-1')?.tabs).toEqual([
      {
        kind: 'file-viewer',
        id: expect.any(String),
        filePath: 'D:/code/JavaScript/mini-term/README.md',
        mode: 'preview',
        status: 'idle',
      },
    ]);
  });

  it('reuses an existing file viewer tab for the same path', () => {
    useAppStore.getState().openFileViewer('project-1', 'D:/code/JavaScript/mini-term/README.md');
    const firstTabId = useAppStore.getState().projectStates.get('project-1')?.tabs[0]?.id;

    useAppStore.getState().openFileViewer('project-1', 'D:/code/JavaScript/mini-term/README.md', {
      initialMode: 'preview',
    });

    const tabs = useAppStore.getState().projectStates.get('project-1')?.tabs ?? [];
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toEqual({
      kind: 'file-viewer',
      id: firstTabId,
      filePath: 'D:/code/JavaScript/mini-term/README.md',
      mode: 'preview',
      status: 'idle',
    });
    expect(useAppStore.getState().projectStates.get('project-1')?.activeTabId).toBe(firstTabId);
  });

  it('updates file viewer tab mode in place', () => {
    useAppStore.getState().openFileViewer('project-1', 'D:/code/JavaScript/mini-term/README.md');
    const tabId = useAppStore.getState().projectStates.get('project-1')?.tabs[0]?.id;

    expect(tabId).toBeTruthy();

    useAppStore.getState().setFileViewerTabMode('project-1', tabId!, 'preview');

    expect(useAppStore.getState().projectStates.get('project-1')?.tabs[0]).toEqual({
      kind: 'file-viewer',
      id: tabId,
      filePath: 'D:/code/JavaScript/mini-term/README.md',
      mode: 'preview',
      status: 'idle',
    });
  });

  it('opens worktree diff as a workspace tab', () => {
    useAppStore.getState().openWorktreeDiff('project-1', 'D:/code/JavaScript/mini-term', sampleStatus);

    expect(useAppStore.getState().projectStates.get('project-1')?.tabs[0]).toEqual({
      kind: 'worktree-diff',
      id: expect.any(String),
      projectPath: 'D:/code/JavaScript/mini-term',
      status: sampleStatus,
    });
  });

  it('reuses an existing worktree diff tab for the same file', () => {
    useAppStore.getState().openWorktreeDiff('project-1', 'D:/code/JavaScript/mini-term', sampleStatus);
    const firstTabId = useAppStore.getState().projectStates.get('project-1')?.tabs[0]?.id;

    useAppStore.getState().openWorktreeDiff('project-1', 'D:/code/JavaScript/mini-term', sampleStatus);

    const tabs = useAppStore.getState().projectStates.get('project-1')?.tabs ?? [];
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toEqual({
      kind: 'worktree-diff',
      id: firstTabId,
      projectPath: 'D:/code/JavaScript/mini-term',
      status: sampleStatus,
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

    expect(useAppStore.getState().projectStates.get('project-1')?.tabs[0]).toEqual({
      kind: 'commit-diff',
      id: expect.any(String),
      repoPath: 'D:/code/JavaScript/mini-term',
      commitHash: 'abc1234',
      commitMessage: 'test commit',
      files: sampleFiles,
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
    const firstTabId = useAppStore.getState().projectStates.get('project-1')?.tabs[0]?.id;

    useAppStore.getState().openCommitDiff({
      projectId: 'project-1',
      repoPath: 'D:/code/JavaScript/mini-term',
      commitHash: 'abc1234',
      commitMessage: 'test commit',
      files: sampleFiles,
    });

    const tabs = useAppStore.getState().projectStates.get('project-1')?.tabs ?? [];
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toEqual({
      kind: 'commit-diff',
      id: firstTabId,
      repoPath: 'D:/code/JavaScript/mini-term',
      commitHash: 'abc1234',
      commitMessage: 'test commit',
      files: sampleFiles,
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
});
