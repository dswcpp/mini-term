import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
const listenMock = vi.fn();
const eventHandlers = new Map<string, (event: { payload: unknown }) => void>();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

describe('workspaceRuntime', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    eventHandlers.clear();
    listenMock.mockReset();
    listenMock.mockImplementation((event: string, handler: (event: { payload: unknown }) => void) => {
      eventHandlers.set(event, handler);
      return Promise.resolve(() => {
        eventHandlers.delete(event);
      });
    });
  });

  afterEach(async () => {
    const runtime = await import('./workspaceRuntime');
    const hub = await import('./tauriEventHub');
    await runtime.stopWorkspaceRuntimeForTests();
    await hub.stopTauriEventHubForTests();
    vi.useRealTimers();
  });

  it('retains a single recursive watcher per project and dispatches batched fs changes', async () => {
    const runtime = await import('./workspaceRuntime');
    const { useAppStore } = await import('../store');
    useAppStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        projects: [
          {
            id: 'project-1',
            name: 'Project 1',
            path: '/workspace/project',
          },
        ],
      },
      projectExplorerRuntime: new Map(),
    }));
    const listener = vi.fn();

    const releaseWatch = runtime.retainProjectTreeWatch('/workspace/project');
    const unsubscribe = runtime.subscribeProjectFs('/workspace/project', listener);

    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledWith('watch_directory', {
      path: '/workspace/project',
      projectPath: '/workspace/project',
      recursive: true,
    });

    eventHandlers.get('fs-change')?.({
      payload: {
        projectPath: '/workspace/project',
        path: '/workspace/project/src/main.ts',
        kind: 'Modify',
      },
    });

    await vi.advanceTimersByTimeAsync(220);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toEqual([
      {
        projectPath: '/workspace/project',
        path: '/workspace/project/src/main.ts',
        kind: 'Modify',
      },
    ]);
    expect(useAppStore.getState().projectExplorerRuntime.get('/workspace/project')?.dirtyPaths).toContain(
      '/workspace/project/src/main.ts',
    );

    unsubscribe();
    releaseWatch();
    expect(invokeMock).toHaveBeenLastCalledWith('unwatch_directory', { path: '/workspace/project' });
  });

  it('marks git dirty from workspace commands scoped to a project', async () => {
    const runtime = await import('./workspaceRuntime');
    const { useAppStore } = await import('../store');
    useAppStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        projects: [
          {
            id: 'project-1',
            name: 'Project 1',
            path: '/workspace/project',
          },
        ],
      },
      projectExplorerRuntime: new Map(),
    }));
    const onDirty = vi.fn();

    const unsubscribe = runtime.subscribeProjectGitDirty('/workspace/project', onDirty);
    await Promise.resolve();

    eventHandlers.get('pty-session-command-started')?.({
      payload: {
        ptyId: 7,
        command: 'git checkout main',
        usageScope: '/workspace/project',
        updatedAt: 1,
      },
    });

    await vi.advanceTimersByTimeAsync(400);

    expect(onDirty).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().projectExplorerRuntime.get('/workspace/project')?.gitDirtyToken).toBe(1);

    unsubscribe();
  });
});
