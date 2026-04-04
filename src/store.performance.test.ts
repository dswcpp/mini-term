import { beforeEach, describe, expect, it } from 'vitest';
import { buildProjectStatePatch, useAppStore } from './store';
import type { ProjectState, TerminalTab } from './types';

function createTerminalTab(id: string, ptyId: number): TerminalTab {
  return {
    kind: 'terminal',
    id,
    status: 'idle',
    splitLayout: {
      type: 'leaf',
      pane: {
        id: `${id}-pane`,
        sessionId: `${id}-session`,
        shellName: 'bash',
        runCommand: undefined,
        status: 'idle',
        mode: 'human',
        phase: 'ready',
        ptyId,
      },
    },
  };
}

describe('store performance indexes', () => {
  beforeEach(() => {
    const projectStates = new Map<string, ProjectState>([
      [
        'project-1',
        {
          id: 'project-1',
          tabs: [createTerminalTab('tab-1', 101), createTerminalTab('tab-2', 202)],
          activeTabId: 'tab-1',
        },
      ],
    ]);

    useAppStore.setState((state) => ({
      ...state,
      ...buildProjectStatePatch(projectStates),
      sessions: new Map(),
      activePaneByTab: new Map([
        ['tab-1', 'tab-1-pane'],
        ['tab-2', 'tab-2-pane'],
      ]),
    }));
  });

  it('builds a pty to pane index for terminal tabs', () => {
    const state = useAppStore.getState();

    expect(state.ptyToPaneIndex.get(101)).toEqual({
      projectId: 'project-1',
      tabId: 'tab-1',
      paneId: 'tab-1-pane',
    });
    expect(state.ptyToPaneIndex.get(202)).toEqual({
      projectId: 'project-1',
      tabId: 'tab-2',
      paneId: 'tab-2-pane',
    });
    expect(state.tabKindIndex.get('tab-1')).toBe('terminal');
    expect(state.tabKindIndex.get('tab-2')).toBe('terminal');
  });

  it('updates only the targeted terminal tab when a pane status changes', () => {
    const before = useAppStore.getState().projectStates.get('project-1');
    const beforeFirstTab = before?.tabs[0];
    const beforeSecondTab = before?.tabs[1];
    const beforeRuntime = useAppStore.getState().paneRuntimeByPty.get(101);

    useAppStore.getState().updatePaneStatusByPty(101, 'ai-working');

    const after = useAppStore.getState().projectStates.get('project-1');
    expect(after?.tabs[0]).toBe(beforeFirstTab);
    expect(after?.tabs[1]).toBe(beforeSecondTab);
    expect(useAppStore.getState().paneRuntimeByPty.get(101)).toEqual({
      ...beforeRuntime,
      status: 'ai-working',
    });
    expect(useAppStore.getState().tabRuntimeAggregate.get('tab-1')).toBe('ai-working');
  });

  it('skips redundant updates when the pane status is unchanged', () => {
    useAppStore.getState().updatePaneStatusByPty(101, 'ai-working');
    const before = useAppStore.getState().projectStates;

    useAppStore.getState().updatePaneStatusByPty(101, 'ai-working');

    expect(useAppStore.getState().projectStates).toBe(before);
  });

  it('batches multiple pane status updates into targeted tab writes', () => {
    useAppStore.getState().updatePaneStatusesByPty([
      { ptyId: 101, status: 'ai-working' },
      { ptyId: 202, status: 'error' },
    ]);

    expect(useAppStore.getState().paneRuntimeByPty.get(101)?.status).toBe('ai-working');
    expect(useAppStore.getState().paneRuntimeByPty.get(202)?.status).toBe('error');
    expect(useAppStore.getState().tabRuntimeAggregate.get('tab-1')).toBe('ai-working');
    expect(useAppStore.getState().tabRuntimeAggregate.get('tab-2')).toBe('error');
  });
});
