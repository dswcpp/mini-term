import type { PaneState, SplitNode } from '../../types';

export function collectPaneIds(node: SplitNode): string[] {
  if (node.type === 'leaf') return [node.pane.id];
  return node.children.flatMap(collectPaneIds);
}

export function removePane(node: SplitNode, targetPaneId: string): SplitNode | null {
  if (node.type === 'leaf') {
    return node.pane.id === targetPaneId ? null : node;
  }

  const remaining = node.children
    .map((child) => removePane(child, targetPaneId))
    .filter((child): child is SplitNode => child !== null);

  if (remaining.length === 0) return null;
  if (remaining.length === 1) return remaining[0];

  return {
    ...node,
    children: remaining,
    sizes: remaining.map(() => 100 / remaining.length),
  };
}

export function insertSplit(
  node: SplitNode,
  targetPaneId: string,
  direction: 'horizontal' | 'vertical',
  newPane: PaneState,
): SplitNode {
  if (node.type === 'leaf') {
    if (node.pane.id === targetPaneId) {
      return {
        type: 'split',
        direction,
        children: [node, { type: 'leaf', pane: newPane }],
        sizes: [50, 50],
      };
    }

    return node;
  }

  return {
    ...node,
    children: node.children.map((child) => insertSplit(child, targetPaneId, direction, newPane)),
  };
}

export function insertSplitNode(
  node: SplitNode,
  targetPaneId: string,
  direction: 'horizontal' | 'vertical',
  newNode: SplitNode,
  position: 'before' | 'after',
): SplitNode {
  if (node.type === 'leaf') {
    if (node.pane.id === targetPaneId) {
      const children = position === 'before' ? [newNode, node] : [node, newNode];
      return { type: 'split', direction, children, sizes: [50, 50] };
    }

    return node;
  }

  return {
    ...node,
    children: node.children.map((child) =>
      insertSplitNode(child, targetPaneId, direction, newNode, position),
    ),
  };
}

export function findPane(node: SplitNode, targetPaneId: string): PaneState | null {
  if (node.type === 'leaf') {
    return node.pane.id === targetPaneId ? node.pane : null;
  }

  for (const child of node.children) {
    const found = findPane(child, targetPaneId);
    if (found) return found;
  }

  return null;
}

export function replacePane(
  node: SplitNode,
  targetPaneId: string,
  nextPane: PaneState,
): SplitNode {
  if (node.type === 'leaf') {
    if (node.pane.id === targetPaneId) {
      return {
        type: 'leaf',
        pane: nextPane,
      };
    }

    return node;
  }

  return {
    ...node,
    children: node.children.map((child) => replacePane(child, targetPaneId, nextPane)),
  };
}
