import { useCallback, type MouseEvent as ReactMouseEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore, genId, collectPtyIds, saveLayoutToConfig, selectWorkspaceState } from '../store';
import { createTerminalPane, createTerminalSessionMeta } from '../utils/session';
import { TabBar } from './TabBar';
import { TerminalTabHost } from './TerminalTabHost';
import { DocumentTabHost } from './DocumentTabHost';
import { CommitDiffTabHost, WorktreeDiffTabHost } from './DiffTabHost';
import {
  collectPaneIds,
  findPane,
  insertSplit,
  insertSplitNode,
  removePane,
  replacePane,
} from './terminal/splitTree';
import { showContextMenu } from '../utils/contextMenu';
import { showPrompt } from '../utils/prompt';
import { disposeTerminal } from '../utils/terminalCache';
import type { PaneState, ShellConfig, SplitNode, TerminalTab, WorkspaceTab } from '../types';

interface Props {
  workspaceId: string;
  workspacePath: string;
  isVisible: boolean;
  onOpenSettings?: () => void;
}

function isTerminalTab(tab: WorkspaceTab): tab is TerminalTab {
  return tab.kind === 'terminal';
}

function getTerminalTabById(ps: { tabs: WorkspaceTab[] } | undefined, tabId: string): TerminalTab | null {
  const tab = ps?.tabs.find((item) => item.id === tabId);
  return tab && isTerminalTab(tab) ? tab : null;
}

function getDefaultTerminalTitle(tab: TerminalTab): string {
  if (tab.customTitle) return tab.customTitle;
  if (tab.splitLayout.type === 'leaf') return tab.splitLayout.pane.shellName;
  return '分屏终端';
}

function getFirstPane(node: SplitNode): PaneState {
  if (node.type === 'leaf') return node.pane;
  return getFirstPane(node.children[0]);
}

export function TerminalArea({ workspaceId, workspacePath, isVisible, onOpenSettings }: Props) {
  const availableShells = useAppStore((state) => state.config.availableShells);
  const defaultShell = useAppStore((state) => state.config.defaultShell);
  const addTab = useAppStore((state) => state.addTab);
  const updateTabLayout = useAppStore((state) => state.updateTabLayout);
  const removeTab = useAppStore((state) => state.removeTab);
  const removeSession = useAppStore((state) => state.removeSession);
  const setFileViewerTabMode = useAppStore((state) => state.setFileViewerTabMode);
  const setActivePaneForTab = useAppStore((state) => state.setActivePaneForTab);
  const clearActivePaneForTab = useAppStore((state) => state.clearActivePaneForTab);
  const upsertSession = useAppStore((state) => state.upsertSession);
  const setTabCustomTitle = useAppStore((state) => state.setTabCustomTitle);
  const ps = useAppStore(selectWorkspaceState(workspaceId));

  const handleCloseTab = useCallback(
    async (tabId: string) => {
      const tab = getTerminalTabById(useAppStore.getState().workspaceStates.get(workspaceId), tabId);

      if (tab) {
        const ptyIds = collectPtyIds(tab.splitLayout);
        for (const id of ptyIds) {
          await invoke('kill_pty', { ptyId: id });
          disposeTerminal(id);
          removeSession(id);
        }
      }

      clearActivePaneForTab(tabId);
      removeTab(workspaceId, tabId);
      saveLayoutToConfig(workspaceId);
    },
    [clearActivePaneForTab, removeSession, removeTab, workspaceId],
  );

  const handleNewTab = useCallback(
    async (selectedShell?: ShellConfig) => {
      const shell =
        selectedShell ??
        availableShells.find((item) => item.name === defaultShell) ??
        availableShells[0];
      if (!shell) return;

      const ptyId = await invoke<number>('create_pty', {
        shell: shell.command,
        args: shell.args ?? [],
        cwd: workspacePath,
      });
      upsertSession(createTerminalSessionMeta(shell.name, ptyId, workspacePath));

      const pane = createTerminalPane(shell.name, ptyId, genId());
      const tab: TerminalTab = {
        kind: 'terminal',
        id: genId(),
        status: 'idle',
        splitLayout: {
          type: 'leaf',
          pane,
        },
      };

      addTab(workspaceId, tab);
      setActivePaneForTab(tab.id, pane.id);
      saveLayoutToConfig(workspaceId);
    },
    [addTab, availableShells, defaultShell, setActivePaneForTab, upsertSession, workspaceId, workspacePath],
  );

  const handleNewTabClick = useCallback(
    (event: ReactMouseEvent) => {
      if (availableShells.length === 0) {
        showContextMenu(event.clientX, event.clientY, [
          {
            label: '没有可用终端，打开设置',
            onClick: () => onOpenSettings?.(),
          },
        ]);
        return;
      }

      showContextMenu(
        event.clientX,
        event.clientY,
        availableShells.map((shell) => ({
          label: shell.name,
          onClick: () => handleNewTab(shell),
        })),
      );
    },
    [availableShells, handleNewTab, onOpenSettings],
  );

  const handleSplitPane = useCallback(
    async (tabId: string, paneId: string, direction: 'horizontal' | 'vertical') => {
      const workspaceState = useAppStore.getState().workspaceStates.get(workspaceId);
      if (!getTerminalTabById(workspaceState, tabId)) return;

      const shell =
        availableShells.find((item) => item.name === defaultShell) ??
        availableShells[0];
      if (!shell) return;

      const ptyId = await invoke<number>('create_pty', {
        shell: shell.command,
        args: shell.args ?? [],
        cwd: workspacePath,
      });
      upsertSession(createTerminalSessionMeta(shell.name, ptyId, workspacePath));

      const newPane: PaneState = createTerminalPane(shell.name, ptyId, genId());

      const latestTab = getTerminalTabById(useAppStore.getState().workspaceStates.get(workspaceId), tabId);
      if (!latestTab) return;

      const nextLayout = insertSplit(latestTab.splitLayout, paneId, direction, newPane);
      updateTabLayout(workspaceId, tabId, nextLayout);
      setActivePaneForTab(tabId, newPane.id);
      saveLayoutToConfig(workspaceId);
    },
    [availableShells, defaultShell, setActivePaneForTab, updateTabLayout, upsertSession, workspaceId, workspacePath],
  );

  const handleTabDrop = useCallback(
    (
      targetTabId: string,
      sourceTabId: string,
      targetPaneId: string,
      direction: 'horizontal' | 'vertical',
      position: 'before' | 'after',
    ) => {
      const currentWorkspaceState = useAppStore.getState().workspaceStates.get(workspaceId);
      const targetTab = getTerminalTabById(currentWorkspaceState, targetTabId);
      if (!currentWorkspaceState || !targetTab || sourceTabId === targetTabId) return;

      const sourceTab = getTerminalTabById(currentWorkspaceState, sourceTabId);
      if (!sourceTab) return;

      const nextLayout = insertSplitNode(
        targetTab.splitLayout,
        targetPaneId,
        direction,
        sourceTab.splitLayout,
        position,
      );

      updateTabLayout(workspaceId, targetTabId, nextLayout);
      setActivePaneForTab(targetTabId, getFirstPane(sourceTab.splitLayout).id);
      clearActivePaneForTab(sourceTabId);
      removeTab(workspaceId, sourceTabId);
      saveLayoutToConfig(workspaceId);
    },
    [clearActivePaneForTab, removeTab, setActivePaneForTab, updateTabLayout, workspaceId],
  );

  const handleClosePane = useCallback(
    async (tabId: string, paneId: string) => {
      const currentTab = getTerminalTabById(useAppStore.getState().workspaceStates.get(workspaceId), tabId);
      if (!currentTab) return;

      const pane = findPane(currentTab.splitLayout, paneId);
      if (!pane) return;

      await invoke('kill_pty', { ptyId: pane.ptyId });
      disposeTerminal(pane.ptyId);
      removeSession(pane.ptyId);

      const latestTab = getTerminalTabById(useAppStore.getState().workspaceStates.get(workspaceId), tabId);
      if (!latestTab) return;

      const nextLayout = removePane(latestTab.splitLayout, paneId);
      if (nextLayout) {
        updateTabLayout(workspaceId, tabId, nextLayout);
        setActivePaneForTab(tabId, getFirstPane(nextLayout).id);
        saveLayoutToConfig(workspaceId);
      } else {
        await handleCloseTab(tabId);
      }
    },
    [handleCloseTab, removeSession, setActivePaneForTab, updateTabLayout, workspaceId],
  );

  const handleRestartPane = useCallback(
    async (tabId: string, paneId: string) => {
      const currentTab = getTerminalTabById(useAppStore.getState().workspaceStates.get(workspaceId), tabId);
      if (!currentTab) return;

      const pane = findPane(currentTab.splitLayout, paneId);
      if (!pane) return;

      const shell =
        availableShells.find((item) => item.name === pane.shellName) ??
        availableShells.find((item) => item.name === defaultShell) ??
        availableShells[0];
      if (!shell) return;

      await invoke('kill_pty', { ptyId: pane.ptyId });
      disposeTerminal(pane.ptyId);
      removeSession(pane.ptyId);

      const ptyId = await invoke<number>('create_pty', {
        shell: shell.command,
        args: shell.args ?? [],
        cwd: workspacePath,
      });

      const latestTab = getTerminalTabById(useAppStore.getState().workspaceStates.get(workspaceId), tabId);
      if (!latestTab) return;

      const latestPane = findPane(latestTab.splitLayout, paneId);
      if (!latestPane) return;
      upsertSession(createTerminalSessionMeta(shell.name, ptyId, workspacePath, latestPane.mode));

      const nextLayout = replacePane(
        latestTab.splitLayout,
        paneId,
        createTerminalPane(shell.name, ptyId, latestPane.id, latestPane.mode, latestPane.runCommand),
      );

      updateTabLayout(workspaceId, tabId, nextLayout);
      setActivePaneForTab(tabId, latestPane.id);
      saveLayoutToConfig(workspaceId);
    },
    [availableShells, defaultShell, removeSession, setActivePaneForTab, updateTabLayout, upsertSession, workspaceId, workspacePath],
  );

  const handleRenameTab = useCallback(
    async (tabId: string) => {
      const tab = getTerminalTabById(useAppStore.getState().workspaceStates.get(workspaceId), tabId);
      if (!tab) return;

      const nextTitle = await showPrompt(
        '重命名标签页',
        `当前：${getDefaultTerminalTitle(tab)}，留空则恢复默认标题`,
        tab.customTitle ?? '',
      );
      if (nextTitle === null) return;

      setTabCustomTitle(workspaceId, tabId, nextTitle);
      saveLayoutToConfig(workspaceId);
    },
    [setTabCustomTitle, workspaceId],
  );

  const handleLayoutChange = useCallback(
    (tabId: string, updatedNode: SplitNode) => {
      const currentTab = getTerminalTabById(useAppStore.getState().workspaceStates.get(workspaceId), tabId);
      if (!currentTab) return;

      const currentIds = collectPaneIds(currentTab.splitLayout).sort().join(',');
      const updatedIds = collectPaneIds(updatedNode).sort().join(',');
      if (currentIds !== updatedIds) {
        return;
      }

      updateTabLayout(workspaceId, tabId, updatedNode);
      const currentActivePaneId = useAppStore.getState().activePaneByTab.get(tabId);
      if (!currentActivePaneId || !findPane(updatedNode, currentActivePaneId)) {
        setActivePaneForTab(tabId, getFirstPane(updatedNode).id);
      }
      saveLayoutToConfig(workspaceId);
    },
    [setActivePaneForTab, updateTabLayout, workspaceId],
  );

  return (
    <div className="flex h-full flex-col bg-[var(--bg-terminal)]">
      <TabBar workspaceId={workspaceId} onNewTab={handleNewTabClick} onCloseTab={handleCloseTab} />

      <div className="relative flex-1 overflow-hidden">
        {ps?.tabs.map((tab) => {
          const tabIsActive = isVisible && tab.id === ps.activeTabId;

          return (
            <div
              key={tab.id}
              className="absolute inset-0"
              style={{ display: tabIsActive ? 'block' : 'none' }}
            >
              {isTerminalTab(tab) ? (
                <TerminalTabHost
                  tab={tab}
                  projectPath={workspacePath}
                  isActive={tabIsActive}
                  onActivatePane={(paneId) => setActivePaneForTab(tab.id, paneId)}
                  onSplit={(paneId, direction) => handleSplitPane(tab.id, paneId, direction)}
                  onClosePane={(paneId) => handleClosePane(tab.id, paneId)}
                  onRestartPane={(paneId) => handleRestartPane(tab.id, paneId)}
                  onNewTab={() => {
                    void handleNewTab();
                  }}
                  onRenameTab={() => {
                    void handleRenameTab(tab.id);
                  }}
                  onCloseTab={() => {
                    void handleCloseTab(tab.id);
                  }}
                  onOpenSettings={onOpenSettings}
                  onTabDrop={(sourceTabId, targetPaneId, direction, position) =>
                    handleTabDrop(tab.id, sourceTabId, targetPaneId, direction, position)
                  }
                  onLayoutChange={(updatedNode) => handleLayoutChange(tab.id, updatedNode)}
                />
              ) : tab.kind === 'file-viewer' ? (
                <DocumentTabHost
                  tab={tab}
                  workspaceId={workspaceId}
                  isActive={tabIsActive}
                  onModeChange={(mode) => setFileViewerTabMode(workspaceId, tab.id, mode)}
                  onClose={() => {
                    void handleCloseTab(tab.id);
                  }}
                />
              ) : tab.kind === 'worktree-diff' ? (
                <WorktreeDiffTabHost
                  tab={tab}
                  isActive={tabIsActive}
                  onClose={() => {
                    void handleCloseTab(tab.id);
                  }}
                />
              ) : (
                <CommitDiffTabHost
                  tab={tab}
                  isActive={tabIsActive}
                  onClose={() => {
                    void handleCloseTab(tab.id);
                  }}
                />
              )}
            </div>
          );
        })}

        {(!ps || ps.tabs.length === 0) && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-[var(--text-muted)]">
            <div className="text-3xl opacity-20">⌁</div>
            <button
              type="button"
              className="rounded-[var(--radius-md)] border border-dashed border-[var(--border-default)] px-5 py-2.5 text-sm transition-all duration-200 hover:border-[var(--accent)] hover:text-[var(--accent)]"
              onClick={handleNewTabClick}
            >
              + 新建终端
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
