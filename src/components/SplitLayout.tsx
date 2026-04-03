import { memo, useRef } from 'react';
import { Allotment } from 'allotment';
import { TerminalInstance } from './TerminalInstance';
import type { SplitNode } from '../types';

interface Props {
  node: SplitNode;
  tabId: string;
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
  tabId,
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
  nodeRef.current = node;

  if (node.type === 'leaf') {
    return (
      <TerminalInstance
        tabId={tabId}
        ptyId={node.pane.ptyId}
        paneId={node.pane.id}
        shellName={node.pane.shellName}
        status={node.pane.status}
        runCommand={node.pane.runCommand}
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

    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const currentNode = nodeRef.current;
      if (currentNode.type !== 'split' || sizes.length !== currentNode.children.length) return;

      const total = sizes.reduce((sum, value) => sum + value, 0);
      const proportional = total > 0 ? sizes.map((value) => (value / total) * 100) : sizes;
      onLayoutChange({ ...currentNode, sizes: proportional });
    });
  };

  const handleChildLayoutChange = (index: number, updatedChild: SplitNode) => {
    if (!onLayoutChange) return;

    const currentNode = nodeRef.current;
    if (currentNode.type !== 'split') return;

    const newChildren = [...currentNode.children];
    newChildren[index] = updatedChild;
    onLayoutChange({ ...currentNode, children: newChildren });
  };

  return (
    <Allotment
      vertical={node.direction === 'vertical'}
      defaultSizes={node.sizes}
      onChange={handleSizesChange}
    >
      {node.children.map((child, index) => (
        <Allotment.Pane key={getNodeKey(child)}>
          <SplitLayout
            node={child}
            tabId={tabId}
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
