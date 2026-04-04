import { beforeEach, describe, expect, it } from 'vitest';
import { getDefaultThemeConfig } from './theme';
import { buildWorkspaceStatePatch, useAppStore } from './store';
import type { AppConfig, WorkspaceConfig, WorkspaceState } from './types';

function createWorkspace(overrides: Partial<WorkspaceConfig> = {}): WorkspaceConfig {
  return {
    id: overrides.id ?? 'workspace-1',
    name: overrides.name ?? 'mini-term',
    roots: overrides.roots ?? [
      {
        id: 'root-a',
        name: 'mini-term',
        path: 'D:/code/JavaScript/mini-term',
        role: 'primary',
      },
      {
        id: 'root-b',
        name: 'shared',
        path: 'D:/code/shared',
        role: 'member',
      },
      {
        id: 'root-c',
        name: 'notes',
        path: 'D:/notes',
        role: 'member',
      },
    ],
    pinned: overrides.pinned ?? false,
    expandedDirsByRoot: overrides.expandedDirsByRoot ?? {},
    createdAt: overrides.createdAt ?? 1,
    lastOpenedAt: overrides.lastOpenedAt ?? 1,
    accent: overrides.accent,
    savedLayout: overrides.savedLayout,
  };
}

function createConfig(workspaces: WorkspaceConfig[]): AppConfig {
  return {
    workspaces,
    recentWorkspaces: [],
    projects: [],
    lastWorkspaceId: workspaces[0]?.id,
    defaultShell: 'powershell',
    availableShells: [{ name: 'powershell', command: 'powershell' }],
    uiFontSize: 13,
    terminalFontSize: 14,
    theme: getDefaultThemeConfig(),
    completionUsage: {
      commands: {},
      subcommands: {},
      options: {},
      arguments: {},
      scopes: {},
    },
  };
}

describe('workspace root management', () => {
  beforeEach(() => {
    const workspace = createWorkspace();
    useAppStore.getState().setConfig(createConfig([workspace]));
  });

  it('renames a workspace root in place', () => {
    useAppStore.getState().renameWorkspaceRoot('workspace-1', 'root-b', 'shared-tools');

    const workspace = useAppStore.getState().workspaceById.get('workspace-1');
    expect(workspace?.roots.find((root) => root.id === 'root-b')?.name).toBe('shared-tools');
  });

  it('moves workspace roots without dropping the primary marker', () => {
    useAppStore.getState().moveWorkspaceRoot('workspace-1', 'root-c', 'up');

    const workspace = useAppStore.getState().workspaceById.get('workspace-1');
    expect(workspace?.roots.map((root) => root.id)).toEqual(['root-a', 'root-c', 'root-b']);
    expect(workspace?.roots[0]?.role).toBe('primary');
  });

  it('can switch the primary root', () => {
    useAppStore.getState().setPrimaryWorkspaceRoot('workspace-1', 'root-b');

    const workspace = useAppStore.getState().workspaceById.get('workspace-1');
    expect(workspace?.roots.find((root) => root.id === 'root-b')?.role).toBe('primary');
    expect(workspace?.roots.find((root) => root.id === 'root-a')?.role).toBe('member');
  });

  it('promotes another root when the primary root is removed', () => {
    useAppStore.getState().removeRootFromWorkspace('workspace-1', 'root-a');

    const workspace = useAppStore.getState().workspaceById.get('workspace-1');
    expect(workspace?.roots.map((root) => root.id)).toEqual(['root-b', 'root-c']);
    expect(workspace?.roots[0]?.role).toBe('primary');
  });

  it('merges multi-root selections into an existing workspace when they overlap one workspace', () => {
    const workspace = createWorkspace({
      roots: [
        {
          id: 'root-a',
          name: 'mini-term',
          path: 'D:/code/JavaScript/mini-term',
          role: 'primary',
        },
      ],
    });
    useAppStore.getState().setConfig(createConfig([workspace]));

    const workspaceId = useAppStore.getState().createWorkspaceFromFolders([
      'D:/code/JavaScript/mini-term',
      'D:/code/shared',
    ]);

    const mergedWorkspace = useAppStore.getState().workspaceById.get('workspace-1');
    expect(workspaceId).toBe('workspace-1');
    expect(useAppStore.getState().config.workspaces).toHaveLength(1);
    expect(mergedWorkspace?.roots.map((root) => root.path)).toEqual([
      'D:/code/JavaScript/mini-term',
      'D:/code/shared',
    ]);
    expect(useAppStore.getState().activeWorkspaceId).toBe('workspace-1');
  });

  it('reuses an existing workspace when a subset of its roots is selected again', () => {
    const workspaceId = useAppStore.getState().createWorkspaceFromFolders([
      'D:/code/shared',
      'D:/code/JavaScript/mini-term',
    ]);

    expect(workspaceId).toBe('workspace-1');
    expect(useAppStore.getState().config.workspaces).toHaveLength(1);
    expect(useAppStore.getState().activeWorkspaceId).toBe('workspace-1');
  });

  it('rejects adding a root that already belongs to another workspace', () => {
    const primaryWorkspace = createWorkspace({
      id: 'workspace-1',
      roots: [
        {
          id: 'root-a',
          name: 'mini-term',
          path: 'D:/code/JavaScript/mini-term',
          role: 'primary',
        },
      ],
    });
    const otherWorkspace = createWorkspace({
      id: 'workspace-2',
      name: 'shared',
      roots: [
        {
          id: 'root-b',
          name: 'shared',
          path: 'D:/code/shared',
          role: 'primary',
        },
      ],
    });
    useAppStore.getState().setConfig(createConfig([primaryWorkspace, otherWorkspace]));

    useAppStore.getState().addRootToWorkspace('workspace-1', 'D:/code/shared');

    const workspace = useAppStore.getState().workspaceById.get('workspace-1');
    expect(workspace?.roots.map((root) => root.path)).toEqual(['D:/code/JavaScript/mini-term']);
  });

  it('does not create a duplicate workspace when selected roots already span multiple open workspaces', () => {
    const primaryWorkspace = createWorkspace({
      id: 'workspace-1',
      roots: [
        {
          id: 'root-a',
          name: 'mini-term',
          path: 'D:/code/JavaScript/mini-term',
          role: 'primary',
        },
      ],
    });
    const otherWorkspace = createWorkspace({
      id: 'workspace-2',
      name: 'shared',
      roots: [
        {
          id: 'root-b',
          name: 'shared',
          path: 'D:/code/shared',
          role: 'primary',
        },
      ],
    });
    useAppStore.getState().setConfig(createConfig([primaryWorkspace, otherWorkspace]));

    const workspaceId = useAppStore.getState().createWorkspaceFromFolders([
      'D:/code/JavaScript/mini-term',
      'D:/code/shared',
    ]);

    expect(workspaceId).toBeNull();
    expect(useAppStore.getState().config.workspaces).toHaveLength(2);
  });

  it('duplicates a workspace with remapped roots and a saved layout snapshot', async () => {
    const workspace = createWorkspace({
      roots: [
        {
          id: 'root-a',
          name: 'mini-term',
          path: 'D:/code/JavaScript/mini-term',
          role: 'primary',
        },
        {
          id: 'root-b',
          name: 'shared-tools',
          path: 'D:/code/shared',
          role: 'member',
        },
      ],
      expandedDirsByRoot: {
        'root-a': ['D:/code/JavaScript/mini-term/src'],
        'root-b': ['D:/code/shared/docs'],
      },
    });
    useAppStore.getState().setConfig(createConfig([workspace]));

    const workspaceStates = new Map<string, WorkspaceState>();
    workspaceStates.set('workspace-1', {
      id: 'workspace-1',
      activeTabId: 'tab-1',
      tabs: [
        {
          kind: 'terminal',
          id: 'tab-1',
          customTitle: 'Dev Shell',
          status: 'idle',
          splitLayout: {
            type: 'leaf',
            pane: {
              id: 'pane-1',
              sessionId: 'session-7',
              shellName: 'powershell',
              runCommand: 'npm run dev',
              runProfile: {
                savedCommand: 'npm run dev',
              },
              status: 'idle',
              mode: 'human',
              phase: 'ready',
              ptyId: 7,
            },
          },
        },
      ],
    });
    useAppStore.setState((state) => ({
      ...buildWorkspaceStatePatch(workspaceStates, state.paneRuntimeByPty, state.activePaneByTab),
    }));

    const duplicatedId = await useAppStore.getState().duplicateWorkspace('workspace-1', {
      name: 'mini-term copy',
      restoreTabs: false,
    });

    expect(duplicatedId).toBeTruthy();
    const duplicatedWorkspace = duplicatedId ? useAppStore.getState().workspaceById.get(duplicatedId) : undefined;
    expect(useAppStore.getState().config.workspaces.map((item) => item.id)).toEqual([
      'workspace-1',
      duplicatedId,
    ]);
    expect(duplicatedWorkspace?.name).toBe('mini-term copy');
    expect(duplicatedWorkspace?.roots.map((root) => root.name)).toEqual(['mini-term', 'shared-tools']);
    expect(duplicatedWorkspace?.roots.map((root) => root.id)).not.toEqual(['root-a', 'root-b']);
    expect(duplicatedWorkspace?.savedLayout?.tabs[0]?.customTitle).toBe('Dev Shell');
    expect(duplicatedWorkspace?.savedLayout?.tabs[0]?.splitLayout).toEqual({
      type: 'leaf',
      pane: {
        shellName: 'powershell',
        runCommand: 'npm run dev',
        runProfile: {
          savedCommand: 'npm run dev',
        },
      },
    });
    expect(duplicatedWorkspace?.expandedDirsByRoot).toEqual({
      [`${duplicatedId}-root-1`]: ['D:/code/JavaScript/mini-term/src'],
      [`${duplicatedId}-root-2`]: ['D:/code/shared/docs'],
    });
    expect(useAppStore.getState().activeWorkspaceId).toBe(duplicatedId);
    expect(useAppStore.getState().workspaceStates.get(duplicatedId ?? '')).toEqual({
      id: duplicatedId,
      tabs: [],
      activeTabId: '',
    });
  });
});
