import { memo, useRef } from 'react';
import { Allotment } from 'allotment';
import { TerminalInstance } from './TerminalInstance';
import type { SplitNode } from '../types';
import {
  areSplitNodesEquivalent,
  areSplitSizesEquivalent,
  getSplitNodeStructureKey,
} from '../utils/splitLayout';

interface Props {
  node: SplitNode;
  workspaceId: string;
  tabId: string;
  projectPath: string;
  activePaneId?: string;
  isTabActive?: boolean;
  onActivatePane?: (paneId: string) => void;
  onSplit?: (paneId: string, direction: 'horizontal' | 'vertical') => void;
  onClose?: (paneId: string) => void;
  onRestart?: (paneId: string) => void;
  onNewTab?: () => void;
  onRenameTab?: () => void;
  onCloseTab?: () => void;
  onOpenSettings?: () => void;
  onTabDrop?: (
    sourceTabId: string,
    targetPaneId: string,
    direction: 'horizontal' | 'vertical',
    position: 'before' | 'after',
  ) => void;
  onLayoutChange?: (updatedNode: SplitNode) => void;
}

function getNodeKey(node: SplitNode): string {
  if (node.type === 'leaf') return node.pane.id;
  return node.children.map(getNodeKey).join('-');
}

export const SplitLayout = memo(function SplitLayout({
  node,
  workspaceId,
  tabId,
  projectPath,
  activePaneId,
  isTabActive = false,
  onActivatePane,
  onSplit,
  onClose,
  onRestart,
  onNewTab,
  onRenameTab,
  onCloseTab,
  onOpenSettings,
  onTabDrop,
  onLayoutChange,
}: Props) {
  const rafRef = useRef<number>(0);
  const nodeRef = useRef(node);
  const ignoreInitialSizesRef = useRef(true);
  const allotmentKeyRef = useRef<string | null>(null);
  const initialSizesRef = useRef<number[] | null>(node.type === 'split' ? [...node.sizes] : null);
  nodeRef.current = node;

  if (node.type === 'leaf') {
    return (
      <TerminalInstance
        workspaceId={workspaceId}
        tabId={tabId}
        projectPath={projectPath}
        sessionId={node.pane.sessionId}
        ptyId={node.pane.ptyId}
        paneId={node.pane.id}
        shellName={node.pane.shellName}
        status={node.pane.status}
        runCommand={node.pane.runCommand}
        runProfile={node.pane.runProfile}
        isActive={isTabActive && activePaneId === node.pane.id}
        isVisible={isTabActive}
        onActivatePane={onActivatePane}
        onSplit={onSplit}
        onClose={onClose}
        onRestart={onRestart}
        onNewTab={onNewTab}
        onRenameTab={onRenameTab}
        onCloseTab={onCloseTab}
        onOpenSettings={onOpenSettings}
        onTabDrop={onTabDrop}
      />
    );
  }

  const handleSizesChange = (sizes: number[]) => {
    if (!onLayoutChange) return;

    if (ignoreInitialSizesRef.current) {
      ignoreInitialSizesRef.current = false;
      return;
    }

    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const currentNode = nodeRef.current;
      if (currentNode.type !== 'split' || sizes.length !== currentNode.children.length) return;

      const total = sizes.reduce((sum, value) => sum + value, 0);
      const proportional = total > 0 ? sizes.map((value) => (value / total) * 100) : sizes;
      if (areSplitSizesEquivalent(currentNode.sizes, proportional)) {
        return;
      }
      onLayoutChange({ ...currentNode, sizes: proportional });
    });
  };

  const handleChildLayoutChange = (index: number, updatedChild: SplitNode) => {
    if (!onLayoutChange) return;

    const currentNode = nodeRef.current;
    if (currentNode.type !== 'split') return;

    const newChildren = [...currentNode.children];
    newChildren[index] = updatedChild;
    const nextNode = { ...currentNode, children: newChildren };
    if (areSplitNodesEquivalent(currentNode, nextNode)) {
      return;
    }
    onLayoutChange(nextNode);
  };

  const nextAllotmentKey = getSplitNodeStructureKey(node);
  if (allotmentKeyRef.current !== nextAllotmentKey) {
    allotmentKeyRef.current = nextAllotmentKey;
    initialSizesRef.current = [...node.sizes];
    ignoreInitialSizesRef.current = true;
  }

  return (
    <Allotment
      key={nextAllotmentKey}
      vertical={node.direction === 'vertical'}
      defaultSizes={initialSizesRef.current ?? node.sizes}
      onChange={handleSizesChange}
    >
      {node.children.map((child, index) => (
        <Allotment.Pane key={getNodeKey(child)}>
          <SplitLayout
            node={child}
            workspaceId={workspaceId}
            tabId={tabId}
            projectPath={projectPath}
            activePaneId={activePaneId}
            isTabActive={isTabActive}
            onActivatePane={onActivatePane}
            onSplit={onSplit}
            onClose={onClose}
            onRestart={onRestart}
            onNewTab={onNewTab}
            onRenameTab={onRenameTab}
            onCloseTab={onCloseTab}
            onOpenSettings={onOpenSettings}
            onTabDrop={onTabDrop}
            onLayoutChange={(updated) => handleChildLayoutChange(index, updated)}
          />
        </Allotment.Pane>
      ))}
    </Allotment>
  );
});
