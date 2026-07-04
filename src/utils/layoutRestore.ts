import type {
  AppConfig,
  PaneState,
  ProjectState,
  SavedPane,
  SavedProjectLayout,
  SavedSplitNode,
  SplitNode,
  TerminalTab,
} from '../types';

function resolveShellName(savedPane: SavedPane, config: Pick<AppConfig, 'availableShells' | 'defaultShell'>): string | null {
  const shell =
    config.availableShells.find((s) => s.name === savedPane.shellName)
    ?? config.availableShells.find((s) => s.name === config.defaultShell)
    ?? config.availableShells[0];
  return shell?.name ?? null;
}

export function restoreSavedSplitNode(
  saved: SavedSplitNode,
  config: Pick<AppConfig, 'availableShells' | 'defaultShell'>,
  createId: () => string,
): SplitNode | null {
  if (saved.type === 'leaf') {
    const legacyPane = (saved as unknown as { pane?: SavedPane }).pane;
    const savedPanes = saved.panes ?? [legacyPane].filter(Boolean) as SavedPane[];
    const panes: PaneState[] = [];

    for (const savedPane of savedPanes) {
      const shellName = resolveShellName(savedPane, config);
      if (!shellName) continue;
      panes.push({
        id: createId(),
        shellName,
        status: 'idle',
      });
    }

    if (panes.length === 0) return null;
    return {
      type: 'leaf',
      panes,
      activePaneId: panes[0].id,
    };
  }

  const children: SplitNode[] = [];
  for (const child of saved.children) {
    const restored = restoreSavedSplitNode(child, config, createId);
    if (restored) children.push(restored);
  }

  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return {
    type: 'split',
    direction: saved.direction,
    children,
    sizes: children.length === saved.sizes.length
      ? [...saved.sizes]
      : children.map(() => 100 / children.length),
  };
}

export function restoreSavedProjectLayout(
  projectId: string,
  savedLayout: SavedProjectLayout,
  config: Pick<AppConfig, 'availableShells' | 'defaultShell'>,
  createId: () => string,
): ProjectState | null {
  const tabs: TerminalTab[] = [];

  for (const savedTab of savedLayout.tabs) {
    const layout = restoreSavedSplitNode(savedTab.splitLayout, config, createId);
    if (!layout) continue;
    tabs.push({
      id: createId(),
      customTitle: savedTab.customTitle,
      splitLayout: layout,
      status: 'idle',
    });
  }

  if (tabs.length === 0) return null;
  const activeTabId = tabs[savedLayout.activeTabIndex]?.id ?? tabs[0]?.id ?? '';
  return { id: projectId, tabs, activeTabId };
}
