import { useState } from 'react';
import { Allotment } from 'allotment';
import { useAppStore, selectSessionById } from '../store';
import { SplitLayout } from './SplitLayout';
import { SessionInspector } from './terminal/SessionInspector';
import { findPane } from './terminal/splitTree';
import type { LayoutDragPayload, PaneState, SplitNode, TerminalTab, WorkspacePane } from '../types';

function getFirstPane(node: SplitNode): WorkspacePane {
  if (node.type === 'leaf') return node.pane;
  return getFirstPane(node.children[0]);
}

function isTerminalPane(pane: WorkspacePane | null | undefined): pane is PaneState {
  return pane?.kind === 'terminal';
}

interface TerminalTabHostProps {
  workspaceId: string;
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
  onLayoutDrop: (
    payload: LayoutDragPayload,
    targetPaneId: string,
    direction: 'horizontal' | 'vertical',
    position: 'before' | 'after',
  ) => void;
  onLayoutChange: (updatedNode: SplitNode) => void;
}

export function TerminalTabHost({
  workspaceId,
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
  onLayoutDrop,
  onLayoutChange,
}: TerminalTabHostProps) {
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const activePaneId = useAppStore((state) => state.activePaneByTab.get(tab.id));
  const activePane = (activePaneId ? findPane(tab.splitLayout, activePaneId) : null) ?? getFirstPane(tab.splitLayout);
  const activeTerminalPane = isTerminalPane(activePane) ? activePane : null;
  const session = useAppStore(selectSessionById(activeTerminalPane?.sessionId, isActive));

  return (
    <div className="relative h-full">
      <Allotment defaultSizes={[1000, 320]}>
        <Allotment.Pane minSize={320}>
          <SplitLayout
            node={tab.splitLayout}
            workspaceId={workspaceId}
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
            onLayoutDrop={onLayoutDrop}
            onLayoutChange={onLayoutChange}
          />
        </Allotment.Pane>
        <Allotment.Pane visible={inspectorOpen} minSize={260} preferredSize={320} maxSize={420}>
          <SessionInspector
            pane={activeTerminalPane}
            session={session}
            onClose={() => setInspectorOpen(false)}
          />
        </Allotment.Pane>
      </Allotment>

      <button
        type="button"
        title={inspectorOpen ? '关闭 Inspector' : '打开 Inspector'}
        className={`absolute top-[3px] right-2 z-10 inline-flex h-[18px] w-[18px] items-center justify-center rounded-[var(--radius-sm)] transition-[background-color,color] ${
          inspectorOpen
            ? 'bg-[var(--accent-subtle)] text-[var(--accent)]'
            : 'text-[var(--text-muted)] hover:bg-[color-mix(in_srgb,var(--bg-overlay)_72%,transparent)] hover:text-[var(--text-primary)]'
        }`}
        onClick={() => setInspectorOpen((v) => !v)}
      >
        <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1">
          <rect x="1.5" y="2" width="9" height="8" rx="1" />
          <path d="M7.5 2v8" />
        </svg>
      </button>
    </div>
  );
}
