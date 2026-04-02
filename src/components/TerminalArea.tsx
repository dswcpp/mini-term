import { useCallback, type MouseEvent as ReactMouseEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore, genId, collectPtyIds, saveLayoutToConfig } from '../store';
import { TabBar } from './TabBar';
import { SplitLayout } from './SplitLayout';
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

export function TerminalArea({ projectId, projectPath, onOpenSettings }: Props) {
  const config = useAppStore((state) => state.config);
  const projectStates = useAppStore((state) => state.projectStates);
  const addTab = useAppStore((state) => state.addTab);
  const updateTabLayout = useAppStore((state) => state.updateTabLayout);
  const removeTab = useAppStore((state) => state.removeTab);
  const setTabCustomTitle = useAppStore((state) => state.setTabCustomTitle);
  const ps = projectStates.get(projectId);

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
        }
      }

      removeTab(projectId, tabId);
      saveLayoutToConfig(projectId);
    },
    [projectId, removeTab],
  );

  const handleNewTab = useCallback(
    async (selectedShell?: ShellConfig) => {
      const shell =
        selectedShell ??
        config.availableShells.find((item) => item.name === config.defaultShell) ??
        config.availableShells[0];
      if (!shell) return;

      const ptyId = await invoke<number>('create_pty', {
        shell: shell.command,
        args: shell.args ?? [],
        cwd: projectPath,
      });

      const tab: TerminalTab = {
        id: genId(),
        status: 'idle',
        splitLayout: {
          type: 'leaf',
          pane: {
            id: genId(),
            shellName: shell.name,
            status: 'idle',
            ptyId,
          },
        },
      };

      addTab(projectId, tab);
      saveLayoutToConfig(projectId);
    },
    [addTab, config.availableShells, config.defaultShell, projectId, projectPath],
  );

  const handleNewTabClick = useCallback(
    (event: ReactMouseEvent) => {
      if (config.availableShells.length === 0) {
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
        config.availableShells.map((shell) => ({
          label: shell.name,
          onClick: () => handleNewTab(shell),
        })),
      );
    },
    [config.availableShells, handleNewTab, onOpenSettings],
  );

  const handleSplitPane = useCallback(
    async (tabId: string, paneId: string, direction: 'horizontal' | 'vertical') => {
      const tab = useAppStore
        .getState()
        .projectStates.get(projectId)
        ?.tabs.find((item) => item.id === tabId);
      if (!tab) return;

      const shell =
        config.availableShells.find((item) => item.name === config.defaultShell) ??
        config.availableShells[0];
      if (!shell) return;

      const ptyId = await invoke<number>('create_pty', {
        shell: shell.command,
        args: shell.args ?? [],
        cwd: projectPath,
      });

      const newPane: PaneState = {
        id: genId(),
        shellName: shell.name,
        status: 'idle',
        ptyId,
      };

      const latestTab = useAppStore
        .getState()
        .projectStates.get(projectId)
        ?.tabs.find((item) => item.id === tabId);
      if (!latestTab) return;

      const nextLayout = insertSplit(latestTab.splitLayout, paneId, direction, newPane);
      updateTabLayout(projectId, tabId, nextLayout);
      saveLayoutToConfig(projectId);
    },
    [config.availableShells, config.defaultShell, projectId, projectPath, updateTabLayout],
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
      removeTab(projectId, sourceTabId);
      saveLayoutToConfig(projectId);
    },
    [projectId, removeTab, updateTabLayout],
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

      const latestTab = useAppStore
        .getState()
        .projectStates.get(projectId)
        ?.tabs.find((item) => item.id === tabId);
      if (!latestTab) return;

      const nextLayout = removePane(latestTab.splitLayout, paneId);
      if (nextLayout) {
        updateTabLayout(projectId, tabId, nextLayout);
        saveLayoutToConfig(projectId);
      } else {
        await handleCloseTab(tabId);
      }
    },
    [handleCloseTab, projectId, updateTabLayout],
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
        config.availableShells.find((item) => item.name === pane.shellName) ??
        config.availableShells.find((item) => item.name === config.defaultShell) ??
        config.availableShells[0];
      if (!shell) return;

      await invoke('kill_pty', { ptyId: pane.ptyId });
      disposeTerminal(pane.ptyId);

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

      const nextLayout = replacePane(latestTab.splitLayout, paneId, {
        ...latestPane,
        shellName: shell.name,
        status: 'idle',
        ptyId,
      });

      updateTabLayout(projectId, tabId, nextLayout);
      saveLayoutToConfig(projectId);
    },
    [config.availableShells, config.defaultShell, projectId, projectPath, updateTabLayout],
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
      saveLayoutToConfig(projectId);
    },
    [projectId, updateTabLayout],
  );

  return (
    <div className="flex h-full flex-col bg-[var(--bg-terminal)]">
      <TabBar projectId={projectId} onNewTab={handleNewTabClick} onCloseTab={handleCloseTab} />

      <div className="relative flex-1 overflow-hidden">
        {ps?.tabs.map((tab) => (
          <div
            key={tab.id}
            className="absolute inset-0"
            style={{ display: tab.id === ps.activeTabId ? 'block' : 'none' }}
          >
            <SplitLayout
              node={tab.splitLayout}
              tabId={tab.id}
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
          </div>
        ))}

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
