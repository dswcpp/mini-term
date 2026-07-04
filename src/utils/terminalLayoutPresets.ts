import type { PaneState, SplitNode } from '../types';

export type TerminalLayoutPreset = 'two-columns' | 'two-rows' | 'quad';

export interface TerminalLayoutPresetDefinition {
  preset: TerminalLayoutPreset;
  requiredPaneCount: number;
  icon: string;
  labelKey: string;
  preview: TerminalLayoutPreset;
}

export const TERMINAL_LAYOUT_PRESETS: readonly TerminalLayoutPresetDefinition[] = [
  {
    preset: 'two-columns',
    requiredPaneCount: 2,
    icon: '▥',
    labelKey: 'paneGroup.twoColumnGrid',
    preview: 'two-columns',
  },
  {
    preset: 'two-rows',
    requiredPaneCount: 2,
    icon: '▤',
    labelKey: 'paneGroup.twoRowGrid',
    preview: 'two-rows',
  },
  {
    preset: 'quad',
    requiredPaneCount: 4,
    icon: '▦',
    labelKey: 'paneGroup.fourGrid',
    preview: 'quad',
  },
] as const;

export function getTerminalLayoutPresetDefinition(
  preset: TerminalLayoutPreset,
): TerminalLayoutPresetDefinition {
  const definition = TERMINAL_LAYOUT_PRESETS.find((item) => item.preset === preset);
  if (!definition) {
    throw new Error(`Unknown terminal layout preset: ${preset}`);
  }
  return definition;
}

export function collectPanesFromLayout(node: SplitNode): PaneState[] {
  if (node.type === 'leaf') return node.panes;
  return node.children.flatMap(collectPanesFromLayout);
}

function orderPanesByAnchor(panes: PaneState[], anchorPaneId: string): PaneState[] {
  const activeIndex = panes.findIndex((pane) => pane.id === anchorPaneId);
  if (activeIndex <= 0) return [...panes];
  return [
    panes[activeIndex],
    ...panes.slice(0, activeIndex),
    ...panes.slice(activeIndex + 1),
  ];
}

function distributePanes(panes: PaneState[], cellCount: number): PaneState[][] {
  const cells = Array.from({ length: cellCount }, () => [] as PaneState[]);
  panes.forEach((pane, index) => {
    cells[index % cellCount].push(pane);
  });
  return cells;
}

function leaf(panes: PaneState[], anchorPaneId: string): SplitNode {
  return {
    type: 'leaf',
    panes,
    activePaneId: panes.some((pane) => pane.id === anchorPaneId) ? anchorPaneId : panes[0].id,
  };
}

function twoPaneSplit(
  direction: 'horizontal' | 'vertical',
  cells: PaneState[][],
  anchorPaneId: string,
): SplitNode {
  return {
    type: 'split',
    direction,
    children: [
      leaf(cells[0], anchorPaneId),
      leaf(cells[1], anchorPaneId),
    ],
    sizes: [50, 50],
  };
}

export function getTerminalLayoutPresetPaneCount(preset: TerminalLayoutPreset): number {
  return getTerminalLayoutPresetDefinition(preset).requiredPaneCount;
}

export function buildTerminalLayoutPreset(
  preset: TerminalLayoutPreset,
  panes: PaneState[],
  anchorPaneId: string,
): SplitNode {
  const requiredPaneCount = getTerminalLayoutPresetPaneCount(preset);
  if (panes.length < requiredPaneCount) {
    throw new Error(`Layout preset ${preset} requires at least ${requiredPaneCount} panes`);
  }

  const orderedPanes = orderPanesByAnchor(panes, anchorPaneId);

  if (preset === 'two-columns') {
    return twoPaneSplit('horizontal', distributePanes(orderedPanes, 2), anchorPaneId);
  }

  if (preset === 'two-rows') {
    return twoPaneSplit('vertical', distributePanes(orderedPanes, 2), anchorPaneId);
  }

  const cells = distributePanes(orderedPanes, 4);
  return {
    type: 'split',
    direction: 'vertical',
    children: [
      twoPaneSplit('horizontal', [cells[0], cells[1]], anchorPaneId),
      twoPaneSplit('horizontal', [cells[2], cells[3]], anchorPaneId),
    ],
    sizes: [50, 50],
  };
}
