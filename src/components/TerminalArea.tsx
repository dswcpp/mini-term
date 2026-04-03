import { useCallback, type MouseEvent as ReactMouseEvent } from 'react';
import { Allotment } from 'allotment';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore, genId, collectPtyIds, saveLayoutToConfig } from '../store';
import { createTerminalPane, createTerminalSessionMeta } from '../utils/session';
import { TabBar } from './TabBar';
import { SplitLayout } from './SplitLayout';
import { SessionInspector } from './terminal/SessionInspector';
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
import type { PaneState, ShellConfig, SplitNode, TerminalTab } from '../types';

interface Props {
  projectId: string;
  projectPath: string;
  onOpenSettings?: () => void;
}

function getTabTitle(tab: TerminalTab): string {
  if (tab.customTitle) return tab.customTitle;
  if (tab.splitLayout.type === 'leaf') return tab.splitLayout.pane.shellName;
  return '分屏终端';
}

function getFirstPane(node: SplitNode): PaneState {
  if (node.type === 'leaf') return node.pane;
  return getFirstPane(node.children[0]);
}

export function TerminalArea({ projectId, projectPath, onOpenSettings }: Props) {
  const availableShells = useAppStore((state) => state.config.availableShells);
  const defaultShell = useAppStore((state) => state.config.defaultShell);
  const addTab = useAppStore((state) => state.addTab);
  const updateTabLayout = useAppStore((state) => state.updateTabLayout);
  const removeTab = useAppStore((state) => state.removeTab);
  const removeSession = useAppStore((state) => state.removeSession);
  const activePaneByTab = useAppStore((state) => state.activePaneByTab);
  const setActivePaneForTab = useAppStore((state) => state.setActivePaneForTab);
  const clearActivePaneForTab = useAppStore((state) => state.clearActivePaneForTab);
  const upsertSession = useAppStore((state) => state.upsertSession);
  const setTabCustomTitle = useAppStore((state) => state.setTabCustomTitle);
  const sessions = useAppStore((state) => state.sessions);
  const ps = useAppStore((state) => state.projectStates.get(projectId));

  const getActivePane = useCallback(
    (tab: TerminalTab) => {
      const paneId = activePaneByTab.get(tab.id);
      return (paneId ? findPane(tab.splitLayout, paneId) : null) ?? getFirstPane(tab.splitLayout);
    },
    [activePaneByTab],
  );

  const handleCloseTab = useCallback(
    async (tabId: string) => {
      const tab = useAppStore
        .getState()
        .projectStates.get(projectId)
        ?.tabs.find((item) => item.id === tabId);

      if (tab) {
        const ptyIds = collectPtyIds(tab.splitLayout);
        for (const id of ptyIds) {
          await invoke('kill_pty', { ptyId: id });
          disposeTerminal(id);
          removeSession(id);
        }
      }

      clearActivePaneForTab(tabId);
      removeTab(projectId, tabId);
      saveLayoutToConfig(projectId);
    },
    [clearActivePaneForTab, projectId, removeSession, removeTab],
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
        cwd: projectPath,
      });
      upsertSession(createTerminalSessionMeta(shell.name, ptyId, projectPath));

      const pane = createTerminalPane(shell.name, ptyId, genId());
      const tab: TerminalTab = {
        id: genId(),
        status: 'idle',
        splitLayout: {
          type: 'leaf',
          pane,
        },
      };

      addTab(projectId, tab);
      setActivePaneForTab(tab.id, pane.id);
      saveLayoutToConfig(projectId);
    },
    [addTab, availableShells, defaultShell, projectId, projectPath, setActivePaneForTab, upsertSession],
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
      const tab = useAppStore
        .getState()
        .projectStates.get(projectId)
        ?.tabs.find((item) => item.id === tabId);
      if (!tab) return;

      const shell =
        availableShells.find((item) => item.name === defaultShell) ??
        availableShells[0];
      if (!shell) return;

      const ptyId = await invoke<number>('create_pty', {
        shell: shell.command,
        args: shell.args ?? [],
        cwd: projectPath,
      });
      upsertSession(createTerminalSessionMeta(shell.name, ptyId, projectPath));

      const newPane: PaneState = createTerminalPane(shell.name, ptyId, genId());

      const latestTab = useAppStore
        .getState()
        .projectStates.get(projectId)
        ?.tabs.find((item) => item.id === tabId);
      if (!latestTab) return;

      const nextLayout = insertSplit(latestTab.splitLayout, paneId, direction, newPane);
      updateTabLayout(projectId, tabId, nextLayout);
      setActivePaneForTab(tabId, newPane.id);
      saveLayoutToConfig(projectId);
    },
    [availableShells, defaultShell, projectId, projectPath, setActivePaneForTab, updateTabLayout, upsertSession],
  );

  const handleTabDrop = useCallback(
    (
      targetTabId: string,
      sourceTabId: string,
      targetPaneId: string,
      direction: 'horizontal' | 'vertical',
      position: 'before' | 'after',
    ) => {
      const currentProjectState = useAppStore.getState().projectStates.get(projectId);
      const targetTab = currentProjectState?.tabs.find((item) => item.id === targetTabId);
      if (!currentProjectState || !targetTab || sourceTabId === targetTabId) return;

      const sourceTab = currentProjectState.tabs.find((item) => item.id === sourceTabId);
      if (!sourceTab) return;

      const nextLayout = insertSplitNode(
        targetTab.splitLayout,
        targetPaneId,
        direction,
        sourceTab.splitLayout,
        position,
      );

      updateTabLayout(projectId, targetTabId, nextLayout);
      setActivePaneForTab(targetTabId, getFirstPane(sourceTab.splitLayout).id);
      clearActivePaneForTab(sourceTabId);
      removeTab(projectId, sourceTabId);
      saveLayoutToConfig(projectId);
    },
    [clearActivePaneForTab, projectId, removeTab, setActivePaneForTab, updateTabLayout],
  );

  const handleClosePane = useCallback(
    async (tabId: string, paneId: string) => {
      const currentTab = useAppStore
        .getState()
        .projectStates.get(projectId)
        ?.tabs.find((item) => item.id === tabId);
      if (!currentTab) return;

      const pane = findPane(currentTab.splitLayout, paneId);
      if (!pane) return;

      await invoke('kill_pty', { ptyId: pane.ptyId });
      disposeTerminal(pane.ptyId);
      removeSession(pane.ptyId);

      const latestTab = useAppStore
        .getState()
        .projectStates.get(projectId)
        ?.tabs.find((item) => item.id === tabId);
      if (!latestTab) return;

      const nextLayout = removePane(latestTab.splitLayout, paneId);
      if (nextLayout) {
        updateTabLayout(projectId, tabId, nextLayout);
        setActivePaneForTab(tabId, getFirstPane(nextLayout).id);
        saveLayoutToConfig(projectId);
      } else {
        await handleCloseTab(tabId);
      }
    },
    [handleCloseTab, projectId, removeSession, setActivePaneForTab, updateTabLayout],
  );

  const handleRestartPane = useCallback(
    async (tabId: string, paneId: string) => {
      const currentTab = useAppStore
        .getState()
        .projectStates.get(projectId)
        ?.tabs.find((item) => item.id === tabId);
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
        cwd: projectPath,
      });

      const latestTab = useAppStore
        .getState()
        .projectStates.get(projectId)
        ?.tabs.find((item) => item.id === tabId);
      if (!latestTab) return;

      const latestPane = findPane(latestTab.splitLayout, paneId);
      if (!latestPane) return;
      upsertSession(createTerminalSessionMeta(shell.name, ptyId, projectPath, latestPane.mode));

      const nextLayout = replacePane(
        latestTab.splitLayout,
        paneId,
        createTerminalPane(shell.name, ptyId, latestPane.id, latestPane.mode, latestPane.runCommand),
      );

      updateTabLayout(projectId, tabId, nextLayout);
      setActivePaneForTab(tabId, latestPane.id);
      saveLayoutToConfig(projectId);
    },
    [availableShells, defaultShell, projectId, projectPath, removeSession, setActivePaneForTab, updateTabLayout, upsertSession],
  );

  const handleRenameTab = useCallback(
    async (tabId: string) => {
      const tab = useAppStore
        .getState()
        .projectStates.get(projectId)
        ?.tabs.find((item) => item.id === tabId);
      if (!tab) return;

      const nextTitle = await showPrompt(
        '重命名标签页',
        `当前：${getTabTitle(tab)}，留空则恢复默认标题`,
        tab.customTitle ?? '',
      );
      if (nextTitle === null) return;

      setTabCustomTitle(projectId, tabId, nextTitle);
      saveLayoutToConfig(projectId);
    },
    [projectId, setTabCustomTitle],
  );

  const handleLayoutChange = useCallback(
    (tabId: string, updatedNode: SplitNode) => {
      const currentTab = useAppStore
        .getState()
        .projectStates.get(projectId)
        ?.tabs.find((item) => item.id === tabId);
      if (!currentTab) return;

      const currentIds = collectPaneIds(currentTab.splitLayout).sort().join(',');
      const updatedIds = collectPaneIds(updatedNode).sort().join(',');
      if (currentIds !== updatedIds) {
        return;
      }

      updateTabLayout(projectId, tabId, updatedNode);
      const currentActivePaneId = activePaneByTab.get(tabId);
      if (!currentActivePaneId || !findPane(updatedNode, currentActivePaneId)) {
        setActivePaneForTab(tabId, getFirstPane(updatedNode).id);
      }
      saveLayoutToConfig(projectId);
    },
    [activePaneByTab, projectId, setActivePaneForTab, updateTabLayout],
  );

  return (
    <div className="flex h-full flex-col bg-[var(--bg-terminal)]">
      <TabBar projectId={projectId} onNewTab={handleNewTabClick} onCloseTab={handleCloseTab} />

      <div className="relative flex-1 overflow-hidden">
        {ps?.tabs.map((tab) => {
          const activePane = getActivePane(tab);
          const session = sessions.get(activePane.ptyId);

          return (
            <div
              key={tab.id}
              className="absolute inset-0"
              style={{ display: tab.id === ps.activeTabId ? 'block' : 'none' }}
            >
              <Allotment defaultSizes={[1000, 320]}>
                <Allotment.Pane minSize={320}>
                  <SplitLayout
                    node={tab.splitLayout}
                    tabId={tab.id}
                    onActivatePane={(paneId) => setActivePaneForTab(tab.id, paneId)}
                    onSplit={(paneId, direction) => handleSplitPane(tab.id, paneId, direction)}
                    onClose={(paneId) => handleClosePane(tab.id, paneId)}
                    onRestart={(paneId) => handleRestartPane(tab.id, paneId)}
                    onNewTab={() => handleNewTab()}
                    onRenameTab={() => handleRenameTab(tab.id)}
                    onCloseTab={() => handleCloseTab(tab.id)}
                    onOpenSettings={onOpenSettings}
                    onTabDrop={(sourceTabId, targetPaneId, direction, position) =>
                      handleTabDrop(tab.id, sourceTabId, targetPaneId, direction, position)
                    }
                    onLayoutChange={(updatedNode) => handleLayoutChange(tab.id, updatedNode)}
                  />
                </Allotment.Pane>
                <Allotment.Pane minSize={260} preferredSize={320} maxSize={420}>
                  <SessionInspector pane={activePane} session={session} />
                </Allotment.Pane>
              </Allotment>
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
