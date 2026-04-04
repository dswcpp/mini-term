import { Allotment } from 'allotment';
import { useAppStore, selectSessionByPty } from '../store';
import { SplitLayout } from './SplitLayout';
import { SessionInspector } from './terminal/SessionInspector';
import { findPane } from './terminal/splitTree';
import type { PaneState, SplitNode, TerminalTab } from '../types';

function getFirstPane(node: SplitNode): PaneState {
  if (node.type === 'leaf') return node.pane;
  return getFirstPane(node.children[0]);
}

interface TerminalTabHostProps {
  tab: TerminalTab;
  projectPath: string;
  isActive: boolean;
  onActivatePane: (paneId: string) => void;
  onSplit: (paneId: string, direction: 'horizontal' | 'vertical') => void;
  onClosePane: (paneId: string) => void;
  onRestartPane: (paneId: string) => void;
  onNewTab: () => void;
  onRenameTab: () => void;
  onCloseTab: () => void;
  onOpenSettings?: () => void;
  onTabDrop: (
    sourceTabId: string,
    targetPaneId: string,
    direction: 'horizontal' | 'vertical',
    position: 'before' | 'after',
  ) => void;
  onLayoutChange: (updatedNode: SplitNode) => void;
}

export function TerminalTabHost({
  tab,
  projectPath,
  isActive,
  onActivatePane,
  onSplit,
  onClosePane,
  onRestartPane,
  onNewTab,
  onRenameTab,
  onCloseTab,
  onOpenSettings,
  onTabDrop,
  onLayoutChange,
}: TerminalTabHostProps) {
  const activePaneId = useAppStore((state) => state.activePaneByTab.get(tab.id));
  const activePane = (activePaneId ? findPane(tab.splitLayout, activePaneId) : null) ?? getFirstPane(tab.splitLayout);
  const session = useAppStore(selectSessionByPty(activePane?.ptyId, isActive));

  return (
    <Allotment defaultSizes={[1000, 320]}>
      <Allotment.Pane minSize={320}>
        <SplitLayout
          node={tab.splitLayout}
          tabId={tab.id}
          projectPath={projectPath}
          activePaneId={activePane.id}
          isTabActive={isActive}
          onActivatePane={onActivatePane}
          onSplit={onSplit}
          onClose={onClosePane}
          onRestart={onRestartPane}
          onNewTab={onNewTab}
          onRenameTab={onRenameTab}
          onCloseTab={onCloseTab}
          onOpenSettings={onOpenSettings}
          onTabDrop={onTabDrop}
          onLayoutChange={onLayoutChange}
        />
      </Allotment.Pane>
      <Allotment.Pane minSize={260} preferredSize={320} maxSize={420}>
        <SessionInspector pane={activePane} session={session} />
      </Allotment.Pane>
    </Allotment>
  );
}
