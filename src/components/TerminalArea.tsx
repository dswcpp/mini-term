import { useCallback } from 'react';
import { useAppStore, genId, saveLayoutToConfig } from '../store';
import { SplitLayout } from './SplitLayout';
import { showContextMenu } from '../utils/contextMenu';
import { getProjectEnvs } from '../utils/projectEnv';
import { showAlert } from '../utils/prompt';
import { formatError } from '../utils/appConfigPersistence';
import { createTerminalPty, killPtyQuietly, resolveTerminalShell } from '../utils/terminalApi';
import {
  buildTerminalLayoutPreset,
  collectPanesFromLayout,
  getTerminalLayoutPresetPaneCount,
  type TerminalLayoutPreset,
} from '../utils/terminalLayoutPresets';
import { normalizeTerminalEncoding } from '../utils/terminalEncoding';
import { useT } from '../i18n';
import type { TerminalTab, PaneState, SplitNode, ShellConfig } from '../types';

interface Props {
  projectId: string;
  projectPath: string;
}

// 收集 SplitNode 树中所有 pane ID
function collectPaneIds(node: SplitNode): string[] {
  if (node.type === 'leaf') return node.panes.map((p) => p.id);
  return node.children.flatMap(collectPaneIds);
}

function hasPaneId(node: SplitNode, paneId: string): boolean {
  if (node.type === 'leaf') return node.panes.some((pane) => pane.id === paneId);
  return node.children.some((child) => hasPaneId(child, paneId));
}

function disposeUnattachedPanes(panes: PaneState[]): void {
  panes.forEach((pane) => {
    if (pane.ptyId !== undefined) killPtyQuietly(pane.ptyId);
  });
}

function insertSplit(
  node: SplitNode,
  targetPaneId: string,
  direction: 'horizontal' | 'vertical',
  newLeaf: SplitNode
): SplitNode {
  if (node.type === 'leaf') {
    if (node.panes.some((p) => p.id === targetPaneId)) {
      return {
        type: 'split',
        direction,
        children: [node, newLeaf],
        sizes: [50, 50],
      };
    }
    return node;
  }
  return {
    ...node,
    children: node.children.map((c) => insertSplit(c, targetPaneId, direction, newLeaf)),
  };
}


export function TerminalArea({ projectId, projectPath }: Props) {
  const t = useT();
  const config = useAppStore((s) => s.config);
  const projectStates = useAppStore((s) => s.projectStates);
  const addTab = useAppStore((s) => s.addTab);
  const updateTabLayout = useAppStore((s) => s.updateTabLayout);
  const removeTab = useAppStore((s) => s.removeTab);
  const ps = projectStates.get(projectId);
  const activeTab = ps?.tabs.find((t) => t.id === ps.activeTabId);

  const createPane = useCallback(async (selectedShell?: ShellConfig): Promise<PaneState | null> => {
    const shell = resolveTerminalShell(config, selectedShell);
    if (!shell) {
      await showAlert(t('terminalArea.noShellConfiguredTitle'), t('terminalArea.noShellConfiguredMessage'));
      return null;
    }

    let ptyId: number;
    const encoding = normalizeTerminalEncoding(config.terminalEncoding);
    try {
      ptyId = await createTerminalPty({
        shell,
        cwd: projectPath,
        envs: getProjectEnvs(projectId),
        encoding,
      });
    } catch (error) {
      await showAlert(t('terminalArea.createFailedTitle'), formatError(error));
      return null;
    }

    return {
      id: genId(),
      shellName: shell.name,
      terminalEncoding: encoding,
      status: 'idle',
      ptyId,
    };
  }, [projectId, projectPath, config, t]);

  const handleNewTab = useCallback(async (selectedShell?: ShellConfig) => {
    const pane = await createPane(selectedShell);
    if (!pane) return;

    const tabId = genId();

    const tab: TerminalTab = {
      id: tabId,
      status: 'idle',
      splitLayout: {
        type: 'leaf',
        panes: [pane],
        activePaneId: pane.id,
      },
    };

    addTab(projectId, tab);
    saveLayoutToConfig(projectId);
  }, [projectId, addTab, createPane]);

  const handleNewTabClick = useCallback((e: React.MouseEvent) => {
    if (config.availableShells.length <= 1) {
      void handleNewTab();
      return;
    }
    showContextMenu(
      e.clientX,
      e.clientY,
      config.availableShells.map((shell) => ({
        label: shell.name,
        onClick: () => handleNewTab(shell),
      })),
    );
  }, [config.availableShells, handleNewTab]);

  const handleSplitPane = useCallback(
    async (paneId: string, direction: 'horizontal' | 'vertical') => {
      if (!ps || !activeTab) return;
      const targetTabId = activeTab.id;
      const newPane = await createPane();
      if (!newPane) return;

      const currentPs = useAppStore.getState().projectStates.get(projectId);
      const targetTab = currentPs?.tabs.find((tab) => tab.id === targetTabId);
      if (!targetTab) {
        disposeUnattachedPanes([newPane]);
        return;
      }

      const newLeaf: SplitNode = {
        type: 'leaf',
        panes: [newPane],
        activePaneId: newPane.id,
      };

      const newLayout = insertSplit(targetTab.splitLayout, paneId, direction, newLeaf);
      if (!hasPaneId(newLayout, newPane.id)) {
        disposeUnattachedPanes([newPane]);
        return;
      }

      updateTabLayout(projectId, targetTab.id, newLayout);
      saveLayoutToConfig(projectId);
    },
    [ps, activeTab, projectId, updateTabLayout, createPane]
  );

  const handleLayoutPreset = useCallback(
    async (activePaneId: string, preset: TerminalLayoutPreset) => {
      if (!ps || !activeTab) return;
      const targetTabId = activeTab.id;
      const readTargetTab = () => (
        useAppStore.getState().projectStates.get(projectId)?.tabs.find((tab) => tab.id === targetTabId)
      );

      const targetTab = readTargetTab();
      if (!targetTab || !hasPaneId(targetTab.splitLayout, activePaneId)) return;

      const panes = collectPanesFromLayout(targetTab.splitLayout);
      const requiredPaneCount = getTerminalLayoutPresetPaneCount(preset);
      const createdPanes: PaneState[] = [];

      while (panes.length < requiredPaneCount) {
        const pane = await createPane();
        if (!pane) {
          disposeUnattachedPanes(createdPanes);
          return;
        }
        createdPanes.push(pane);
        panes.push(pane);
      }

      const latestTargetTab = readTargetTab();
      if (!latestTargetTab || !hasPaneId(latestTargetTab.splitLayout, activePaneId)) {
        disposeUnattachedPanes(createdPanes);
        return;
      }

      const latestPanes = [
        ...collectPanesFromLayout(latestTargetTab.splitLayout),
        ...createdPanes,
      ];
      const newLayout = buildTerminalLayoutPreset(preset, latestPanes, activePaneId);
      updateTabLayout(projectId, latestTargetTab.id, newLayout);
      saveLayoutToConfig(projectId);
    },
    [ps, activeTab, projectId, updateTabLayout, createPane],
  );

  // Called when an entire leaf (pane group) is closed.
  // PTYs are already killed by PaneGroup before this is called.
  // For the root leaf case, we close the whole tab.
  const handleCloseLeaf = useCallback((_leafNode: SplitNode) => {
    const currentPs = useAppStore.getState().projectStates.get(projectId);
    const currentTab = currentPs?.tabs.find(t => t.id === currentPs.activeTabId);
    if (!currentTab) return;

    // PTYs are already killed by PaneGroup before this is called.
    // Remove the entire layout tab.
    removeTab(projectId, currentTab.id);
    saveLayoutToConfig(projectId);
  }, [projectId, removeTab]);

  const handleLayoutChange = useCallback((updatedNode: SplitNode) => {
    const currentPs = useAppStore.getState().projectStates.get(projectId);
    const currentActiveTab = currentPs?.tabs.find((t) => t.id === currentPs.activeTabId);
    if (!currentActiveTab) return;

    // Validate layout structure: if pane ID sets differ, discard stale RAF callback
    const currentIds = collectPaneIds(currentActiveTab.splitLayout).sort().join(',');
    const updatedIds = collectPaneIds(updatedNode).sort().join(',');
    if (currentIds !== updatedIds) return;

    updateTabLayout(projectId, currentActiveTab.id, updatedNode);
    saveLayoutToConfig(projectId);
  }, [projectId, updateTabLayout]);

  // Handler for structural changes: tabs added/removed/switched within a leaf,
  // or children removed from a split. Bypasses pane-ID validation since the
  // set of pane IDs is expected to change.
  const handleUpdateNode = useCallback((updatedNode: SplitNode) => {
    const currentPs = useAppStore.getState().projectStates.get(projectId);
    const currentActiveTab = currentPs?.tabs.find((t) => t.id === currentPs.activeTabId);
    if (!currentActiveTab) return;
    updateTabLayout(projectId, currentActiveTab.id, updatedNode);
    saveLayoutToConfig(projectId);
  }, [projectId, updateTabLayout]);

  return (
    <div data-panel className="flex flex-col h-full bg-[var(--bg-terminal)]">
      <div className="flex-1 overflow-hidden relative">
        {activeTab && (
          <div
            key={activeTab.id}
            className="absolute inset-0"
          >
            <SplitLayout
              projectId={projectId}
              node={activeTab.splitLayout}
              projectPath={projectPath}
              onSplit={handleSplitPane}
              onLayoutPreset={handleLayoutPreset}
              onCloseLeaf={handleCloseLeaf}
              onUpdateNode={handleUpdateNode}
              onLayoutChange={handleLayoutChange}
            />
          </div>
        )}

        {(!ps || ps.tabs.length === 0) && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-[var(--text-muted)]">
            <div className="text-3xl opacity-20">⌘</div>
            <button
              className="px-5 py-2.5 border border-dashed border-[var(--border-default)] rounded-[var(--radius-md)] text-sm hover:border-[var(--accent)] hover:text-[var(--accent)] transition-all duration-200"
              onClick={handleNewTabClick}
            >
              + {t("terminalArea.newTerminal")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
