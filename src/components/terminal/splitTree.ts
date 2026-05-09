import type { SplitNode, WorkspacePane } from '../../types';

function normalizeSizes(sizes: number[]): number[] {
  const total = sizes.reduce((sum, value) => sum + value, 0);
  if (total <= 0 || sizes.length === 0) {
    return sizes.map(() => 100 / Math.max(1, sizes.length));
  }
  return sizes.map((value) => (value / total) * 100);
}

export function rebalanceSizesProportionally(sizes: number[], removedIndex: number): number[] {
  return normalizeSizes(sizes.filter((_, index) => index !== removedIndex));
}

export function collectPaneIds(node: SplitNode): string[] {
  if (node.type === 'leaf') return [node.pane.id];
  return node.children.flatMap(collectPaneIds);
}

export function collectPanes(node: SplitNode): WorkspacePane[] {
  if (node.type === 'leaf') return [node.pane];
  return node.children.flatMap(collectPanes);
}

export function removePane(node: SplitNode, targetPaneId: string): SplitNode | null {
  const { nextNode } = extractPane(node, targetPaneId);
  return nextNode;
}

export function extractPane(
  node: SplitNode,
  targetPaneId: string,
): { nextNode: SplitNode | null; extractedPane: WorkspacePane | null } {
  if (node.type === 'leaf') {
    return node.pane.id === targetPaneId
      ? { nextNode: null, extractedPane: node.pane }
      : { nextNode: node, extractedPane: null };
  }

  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index];
    const result = extractPane(child, targetPaneId);
    if (!result.extractedPane) {
      continue;
    }

    if (!result.nextNode) {
      const remainingChildren = node.children.filter((_, childIndex) => childIndex !== index);
      if (remainingChildren.length === 0) {
        return { nextNode: null, extractedPane: result.extractedPane };
      }
      if (remainingChildren.length === 1) {
        return { nextNode: remainingChildren[0], extractedPane: result.extractedPane };
      }
      return {
        nextNode: {
          ...node,
          children: remainingChildren,
          sizes: rebalanceSizesProportionally(node.sizes, index),
        },
        extractedPane: result.extractedPane,
      };
    }

    const children = [...node.children];
    children[index] = result.nextNode;
    return {
      nextNode: {
        ...node,
        children,
      },
      extractedPane: result.extractedPane,
    };
  }

  return {
    nextNode: node,
    extractedPane: null,
  };
}

export function insertNodeAtPane(
  node: SplitNode,
  targetPaneId: string,
  direction: 'horizontal' | 'vertical',
  newNode: SplitNode,
  position: 'before' | 'after',
): SplitNode {
  if (node.type === 'leaf') {
    if (node.pane.id !== targetPaneId) {
      return node;
    }

    return {
      type: 'split',
      direction,
      children: position === 'before' ? [newNode, node] : [node, newNode],
      sizes: [50, 50],
    };
  }

  let changed = false;
  const children = node.children.map((child) => {
    const nextChild = insertNodeAtPane(child, targetPaneId, direction, newNode, position);
    if (nextChild !== child) {
      changed = true;
    }
    return nextChild;
  });

  return changed
    ? {
        ...node,
        children,
      }
    : node;
}

export function insertSplit(
  node: SplitNode,
  targetPaneId: string,
  direction: 'horizontal' | 'vertical',
  newPane: WorkspacePane,
): SplitNode {
  return insertNodeAtPane(node, targetPaneId, direction, { type: 'leaf', pane: newPane }, 'after');
}

export function insertSplitNode(
  node: SplitNode,
  targetPaneId: string,
  direction: 'horizontal' | 'vertical',
  newNode: SplitNode,
  position: 'before' | 'after',
): SplitNode {
  return insertNodeAtPane(node, targetPaneId, direction, newNode, position);
}

export function findPane(node: SplitNode, targetPaneId: string): WorkspacePane | null {
  if (node.type === 'leaf') {
    return node.pane.id === targetPaneId ? node.pane : null;
  }

  for (const child of node.children) {
    const found = findPane(child, targetPaneId);
    if (found) return found;
  }

  return null;
}

export function findPaneBy(
  node: SplitNode,
  predicate: (pane: WorkspacePane) => boolean,
): WorkspacePane | null {
  if (node.type === 'leaf') {
    return predicate(node.pane) ? node.pane : null;
  }

  for (const child of node.children) {
    const found = findPaneBy(child, predicate);
    if (found) return found;
  }

  return null;
}

export function replacePane(
  node: SplitNode,
  targetPaneId: string,
  nextPane: WorkspacePane,
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
