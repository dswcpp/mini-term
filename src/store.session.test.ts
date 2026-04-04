import { beforeEach, describe, expect, it } from 'vitest';
import { getDefaultThemeConfig } from './theme';
import {
  buildWorkspaceStatePatch,
  selectPaneRuntimeBySessionId,
  useAppStore,
} from './store';
import type {
  AppConfig,
  TerminalSessionMeta,
  TerminalTab,
  WorkspaceConfig,
  WorkspaceState,
} from './types';

function createWorkspaceConfig(overrides: Partial<WorkspaceConfig> = {}): WorkspaceConfig {
  return {
    id: overrides.id ?? 'workspace-1',
    name: overrides.name ?? 'mini-term',
    roots: overrides.roots ?? [
      {
        id: 'root-1',
        name: 'mini-term',
        path: 'D:/code/JavaScript/mini-term',
        role: 'primary',
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

function createSession(sessionId: string, ptyId: number): TerminalSessionMeta {
  return {
    sessionId,
    ptyId,
    shellKind: 'powershell',
    mode: 'human',
    phase: 'ready',
    cwd: 'D:/code/JavaScript/mini-term',
    title: 'powershell',
    commands: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

function createTerminalTab(id: string, session: TerminalSessionMeta): TerminalTab {
  return {
    kind: 'terminal',
    id,
    status: 'idle',
    splitLayout: {
      type: 'leaf',
      pane: {
        id: `${id}-pane`,
        sessionId: session.sessionId,
        shellName: 'powershell',
        runCommand: undefined,
        status: 'idle',
        mode: session.mode,
        phase: session.phase,
        ptyId: session.ptyId,
      },
    },
  };
}

describe('session-backed terminal layout state', () => {
  beforeEach(() => {
    const workspace = createWorkspaceConfig();
    const sessionA = createSession('session-a', 101);
    const sessionB = createSession('session-b', 202);
    const tabA = createTerminalTab('tab-a', sessionA);
    const tabB = createTerminalTab('tab-b', sessionB);
    const workspaceStates = new Map<string, WorkspaceState>([
      [
        workspace.id,
        {
          id: workspace.id,
          tabs: [tabA, tabB],
          activeTabId: tabB.id,
        },
      ],
    ]);
    const activePaneByTab = new Map([
      [tabA.id, 'tab-a-pane'],
      [tabB.id, 'tab-b-pane'],
    ]);

    useAppStore.getState().setConfig(createConfig([workspace]));
    useAppStore.setState((state) => ({
      ...state,
      ...buildWorkspaceStatePatch(workspaceStates, undefined, activePaneByTab),
      activePaneByTab,
      sessions: new Map([
        [sessionA.ptyId, sessionA],
        [sessionB.ptyId, sessionB],
      ]),
      terminalSessions: new Map([
        [sessionA.sessionId, sessionA],
        [sessionB.sessionId, sessionB],
      ]),
      sessionIdByPty: new Map([
        [sessionA.ptyId, sessionA.sessionId],
        [sessionB.ptyId, sessionB.sessionId],
      ]),
      ptyBySessionId: new Map([
        [sessionA.sessionId, sessionA.ptyId],
        [sessionB.sessionId, sessionB.ptyId],
      ]),
    }));
  });

  it('keeps session state when a tab layout is moved into another tab', () => {
    const state = useAppStore.getState();
    const workspaceState = state.workspaceStates.get('workspace-1');
    const sourceTab = workspaceState?.tabs.find((tab) => tab.id === 'tab-a');
    const targetTab = workspaceState?.tabs.find((tab) => tab.id === 'tab-b');

    expect(sourceTab?.kind).toBe('terminal');
    expect(targetTab?.kind).toBe('terminal');
    if (!sourceTab || !targetTab || sourceTab.kind !== 'terminal' || targetTab.kind !== 'terminal') {
      return;
    }

    useAppStore.getState().updateTabLayout('workspace-1', 'tab-b', {
      type: 'split',
      direction: 'horizontal',
      children: [targetTab.splitLayout, sourceTab.splitLayout],
      sizes: [55, 45],
    });
    useAppStore.getState().removeTab('workspace-1', 'tab-a');

    const nextState = useAppStore.getState();
    expect(nextState.terminalSessions.get('session-a')?.ptyId).toBe(101);
    expect(nextState.sessions.get(101)?.sessionId).toBe('session-a');
    expect(nextState.ptyToPaneIndex.get(101)).toEqual({
      projectId: 'workspace-1',
      tabId: 'tab-b',
      paneId: 'tab-a-pane',
    });
  });

  it('resolves pane runtime through the stable session id', () => {
    const paneRuntime = selectPaneRuntimeBySessionId('session-b')(useAppStore.getState());

    expect(paneRuntime).toMatchObject({
      ptyId: 202,
      paneId: 'tab-b-pane',
      tabId: 'tab-b',
      workspaceId: 'workspace-1',
    });
  });

  it('skips layout updates when the split tree is unchanged', () => {
    const beforeWorkspaceStates = useAppStore.getState().workspaceStates;
    const currentTab = beforeWorkspaceStates.get('workspace-1')?.tabs.find((tab) => tab.id === 'tab-b');

    expect(currentTab?.kind).toBe('terminal');
    if (!currentTab || currentTab.kind !== 'terminal') {
      return;
    }

    useAppStore.getState().updateTabLayout('workspace-1', 'tab-b', {
      ...currentTab.splitLayout,
    });

    expect(useAppStore.getState().workspaceStates).toBe(beforeWorkspaceStates);
  });
});
