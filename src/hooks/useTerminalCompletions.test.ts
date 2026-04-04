import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../store';
import { resetTerminalCompletionCaches, useTerminalCompletions } from './useTerminalCompletions';
import {
  applyCompletionEditToState,
  createTerminalInputState,
  type TerminalInputState,
} from '../utils/terminalInputState';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('../utils/terminalCache', async () => {
  const listeners = new Map<number, Set<(state: TerminalInputState) => void>>();
  const states = new Map<number, TerminalInputState>();
  const appliedEdits: Array<{ ptyId: number; edit: { replaceStart: number; replaceEnd: number; newText: string } }> = [];

  const getState = (ptyId: number) => states.get(ptyId) ?? createTerminalInputState();
  const notify = (ptyId: number) => {
    const next = getState(ptyId);
    listeners.get(ptyId)?.forEach((listener) => listener(next));
  };

  return {
    subscribeTerminalInputState: (ptyId: number, listener: (state: TerminalInputState) => void) => {
      const set = listeners.get(ptyId) ?? new Set();
      set.add(listener);
      listeners.set(ptyId, set);
      listener(getState(ptyId));
      return () => {
        set.delete(listener);
      };
    },
    getTerminalInputState: (ptyId: number) => getState(ptyId),
    applyCompletionEdit: vi.fn(async (ptyId: number, edit: { replaceStart: number; replaceEnd: number; newText: string }) => {
      appliedEdits.push({ ptyId, edit });
      const next = applyCompletionEditToState(getState(ptyId), edit);
      states.set(ptyId, next);
      notify(ptyId);
      return true;
    }),
    __setMockInputState: (ptyId: number, state: TerminalInputState) => {
      states.set(ptyId, state);
      notify(ptyId);
    },
    __getAppliedEdits: () => appliedEdits.slice(),
    __resetTerminalCacheMock: () => {
      listeners.clear();
      states.clear();
      appliedEdits.length = 0;
    },
  };
});

type TerminalCacheMock = {
  __setMockInputState: (ptyId: number, state: TerminalInputState) => void;
  __getAppliedEdits: () => Array<{ ptyId: number; edit: { replaceStart: number; replaceEnd: number; newText: string } }>;
  __resetTerminalCacheMock: () => void;
};

async function flushCompletion() {
  await act(async () => {
    vi.advanceTimersByTime(120);
    await Promise.resolve();
  });
}

let inputVersion = 0;

async function setInput(mock: TerminalCacheMock, ptyId: number, state: Partial<TerminalInputState> & { text: string }) {
  const base = createTerminalInputState();
  await act(async () => {
    mock.__setMockInputState(ptyId, {
      ...base,
      cursor: state.cursor ?? state.text.length,
      version: state.version ?? ++inputVersion,
      unsafe: state.unsafe ?? false,
      text: state.text,
    });
  });
}

describe('useTerminalCompletions', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    inputVersion = 0;
    invokeMock.mockReset();
    resetTerminalCompletionCaches();
    const terminalCache = (await import('../utils/terminalCache')) as unknown as TerminalCacheMock;
    terminalCache.__resetTerminalCacheMock();
    useAppStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        completionUsage: undefined,
      },
      sessions: new Map([
        [
          1,
          {
            sessionId: 'session-1',
            ptyId: 1,
            shellKind: 'bash',
            mode: 'human',
            phase: 'ready',
            cwd: '/workspace/project',
            title: 'bash',
            commands: [],
            createdAt: 0,
            updatedAt: 0,
          },
        ],
      ]),
    }));
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('completes commands with a trailing space when the candidate is unique', async () => {
    const terminalCache = (await import('../utils/terminalCache')) as unknown as TerminalCacheMock;
    const { result } = renderHook(() => useTerminalCompletions(1, '/workspace/project'));

    await setInput(terminalCache, 1, { text: 'gi' });
    await flushCompletion();

    await act(async () => {
      await result.current.handleTab(false);
    });

    expect(terminalCache.__getAppliedEdits()).toEqual([
      {
        ptyId: 1,
        edit: { replaceStart: 0, replaceEnd: 2, newText: 'git ' },
      },
    ]);
  });

  it('shows git subcommands after a trailing space', async () => {
    const terminalCache = (await import('../utils/terminalCache')) as unknown as TerminalCacheMock;
    const { result } = renderHook(() => useTerminalCompletions(1, '/workspace/project'));

    await setInput(terminalCache, 1, { text: 'git ' });
    await flushCompletion();

    expect(result.current.items.length).toBeGreaterThan(0);
    expect(result.current.items.map((item) => item.label)).toContain('add');
  });

  it('includes fetch in git subcommand suggestions', async () => {
    const terminalCache = (await import('../utils/terminalCache')) as unknown as TerminalCacheMock;
    const { result } = renderHook(() => useTerminalCompletions(1, '/workspace/project'));

    await setInput(terminalCache, 1, { text: 'git fe' });
    await flushCompletion();

    expect(result.current.items.map((item) => item.label)).toContain('fetch');
  });

  it('includes fetch-specific git options', async () => {
    const terminalCache = (await import('../utils/terminalCache')) as unknown as TerminalCacheMock;
    const { result } = renderHook(() => useTerminalCompletions(1, '/workspace/project'));

    await setInput(terminalCache, 1, { text: 'git fetch --a' });
    await flushCompletion();

    expect(result.current.items.map((item) => item.label)).toContain('--all');
  });

  it('records completion usage when a command is executed', async () => {
    useAppStore.getState().recordSessionCommand(1, 'git fetch --all', 123);

    const usage = useAppStore.getState().config.completionUsage;
    expect(usage?.scopes?.['/workspace/project']?.commands.git).toBe(1);
    expect(usage?.scopes?.['/workspace/project']?.subcommands['git fetch']).toBe(1);
    expect(usage?.scopes?.['/workspace/project']?.options['git fetch --all']).toBe(1);
  });

  it('promotes frequently used git subcommands into the visible suggestions', async () => {
    useAppStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        completionUsage: {
          commands: {},
          subcommands: { 'git fetch': 3 },
          options: {},
          arguments: {},
          scopes: {
            '/workspace/project': {
              commands: {},
              subcommands: { 'git fetch': 3 },
              options: {},
              arguments: {},
            },
          },
        },
      },
    }));

    const terminalCache = (await import('../utils/terminalCache')) as unknown as TerminalCacheMock;
    const { result } = renderHook(() => useTerminalCompletions(1, '/workspace/project'));

    await setInput(terminalCache, 1, { text: 'git ' });
    await flushCompletion();

    expect(result.current.items[0]?.label).toBe('fetch');
  });

  it('promotes frequently used git options ahead of alphabetical order', async () => {
    useAppStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        completionUsage: {
          commands: {},
          subcommands: {},
          options: { 'git fetch --all': 2 },
          arguments: {},
          scopes: {
            '/workspace/project': {
              commands: {},
              subcommands: {},
              options: { 'git fetch --all': 2 },
              arguments: {},
            },
          },
        },
      },
    }));

    const terminalCache = (await import('../utils/terminalCache')) as unknown as TerminalCacheMock;
    const { result } = renderHook(() => useTerminalCompletions(1, '/workspace/project'));

    await setInput(terminalCache, 1, { text: 'git fetch --' });
    await flushCompletion();

    expect(result.current.items[0]?.label).toBe('--all');
  });

  it('suggests git argument targets from recorded user habits', async () => {
    useAppStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        completionUsage: {
          commands: {},
          subcommands: {},
          options: {},
          arguments: {
            'git fetch origin': 3,
            'git fetch upstream': 1,
          },
          scopes: {
            '/workspace/project': {
              commands: {},
              subcommands: {},
              options: {},
              arguments: {
                'git fetch origin': 3,
                'git fetch upstream': 1,
              },
            },
          },
        },
      },
    }));

    const terminalCache = (await import('../utils/terminalCache')) as unknown as TerminalCacheMock;
    const { result } = renderHook(() => useTerminalCompletions(1, '/workspace/project'));

    await setInput(terminalCache, 1, { text: 'git fetch o' });
    await flushCompletion();

    expect(result.current.items.map((item) => item.label)).toContain('origin');
    expect(result.current.items[0]?.label).toBe('origin');
  });

  it('does not leak learned ordering across projects', async () => {
    useAppStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        completionUsage: {
          commands: {},
          subcommands: {},
          options: {},
          arguments: {},
          scopes: {
            '/workspace/other-project': {
              commands: {},
              subcommands: { 'git fetch': 4 },
              options: {},
              arguments: {},
            },
          },
        },
      },
    }));

    const terminalCache = (await import('../utils/terminalCache')) as unknown as TerminalCacheMock;
    const { result } = renderHook(() => useTerminalCompletions(1, '/workspace/project'));

    await setInput(terminalCache, 1, { text: 'git ' });
    await flushCompletion();

    expect(result.current.items[0]?.label).not.toBe('fetch');
  });

  it('suggests git remotes from repository metadata', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'get_git_completion_data') {
        return {
          repoRoot: '/workspace/project',
          currentBranch: 'main',
          localBranches: ['main', 'feature/auth'],
          remoteBranches: ['origin/main', 'upstream/release'],
          remotes: ['origin', 'upstream'],
          tags: ['v1.0.0'],
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const terminalCache = (await import('../utils/terminalCache')) as unknown as TerminalCacheMock;
    const { result } = renderHook(() => useTerminalCompletions(1, '/workspace/project'));

    await setInput(terminalCache, 1, { text: 'git fetch u' });
    await flushCompletion();

    expect(result.current.items[0]?.label).toBe('upstream');
  });

  it('suggests git branch targets from repository metadata', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'get_git_completion_data') {
        return {
          repoRoot: '/workspace/project',
          currentBranch: 'main',
          localBranches: ['main', 'feature/auth'],
          remoteBranches: ['origin/main', 'origin/release'],
          remotes: ['origin'],
          tags: ['v1.0.0'],
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const terminalCache = (await import('../utils/terminalCache')) as unknown as TerminalCacheMock;
    const { result } = renderHook(() => useTerminalCompletions(1, '/workspace/project'));

    await setInput(terminalCache, 1, { text: 'git switch fe' });
    await flushCompletion();

    expect(result.current.items.map((item) => item.label)).toContain('feature/auth');
  });

  it('suggests nested git remote actions', async () => {
    const terminalCache = (await import('../utils/terminalCache')) as unknown as TerminalCacheMock;
    const { result } = renderHook(() => useTerminalCompletions(1, '/workspace/project'));

    await setInput(terminalCache, 1, { text: 'git remote re' });
    await flushCompletion();

    expect(result.current.items.map((item) => item.label)).toEqual(
      expect.arrayContaining(['remove', 'rename']),
    );
  });

  it('completes a unique directory by appending a separator', async () => {
    invokeMock.mockImplementation(async (command: string, args: { path: string }) => {
      if (command === 'complete_path_entries') {
        if (args.path === '/workspace/project') {
          return [{ name: 'src', path: '/workspace/project/src', isDir: true }];
        }

        if (args.path === '/workspace/project/src') {
          return [];
        }
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const terminalCache = (await import('../utils/terminalCache')) as unknown as TerminalCacheMock;
    const { result } = renderHook(() => useTerminalCompletions(1, '/workspace/project'));

    await setInput(terminalCache, 1, { text: 'cd sr' });
    await flushCompletion();

    await act(async () => {
      await result.current.handleTab(false);
    });

    expect(terminalCache.__getAppliedEdits()[0]?.edit).toEqual({
      replaceStart: 3,
      replaceEnd: 5,
      newText: 'src/',
    });
  });

  it('uses the updated session cwd for relative path completion', async () => {
    useAppStore.setState((state) => ({
      ...state,
      sessions: new Map([
        [
          1,
          {
            ...(state.sessions.get(1) ?? {
              sessionId: 'session-1',
              ptyId: 1,
              shellKind: 'bash',
              mode: 'human',
              phase: 'ready',
              title: 'bash',
              commands: [],
              createdAt: 0,
              updatedAt: 0,
            }),
            cwd: '/workspace/project/packages/app',
          },
        ],
      ]),
    }));

    invokeMock.mockImplementation(async (command: string, args: { path: string }) => {
      if (command === 'complete_path_entries') {
        expect(args.path).toBe('/workspace/project/packages/app/src');
        return [{ name: 'main.tsx', path: '/workspace/project/packages/app/src/main.tsx', isDir: false }];
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const terminalCache = (await import('../utils/terminalCache')) as unknown as TerminalCacheMock;
    const { result } = renderHook(() => useTerminalCompletions(1, '/workspace/project'));

    await setInput(terminalCache, 1, { text: 'cd src/ma' });
    await flushCompletion();

    expect(result.current.items[0]?.label).toBe('src/main.tsx');
  });

  it('opens the menu first when multiple candidates share no longer prefix', async () => {
    const terminalCache = (await import('../utils/terminalCache')) as unknown as TerminalCacheMock;
    const { result } = renderHook(() => useTerminalCompletions(1, '/workspace/project'));

    await setInput(terminalCache, 1, { text: 'git c' });
    await flushCompletion();

    await act(async () => {
      await result.current.handleTab(false);
    });

    expect(result.current.menuOpen).toBe(true);
    expect(terminalCache.__getAppliedEdits()).toEqual([]);

    await act(async () => {
      await result.current.handleTab(false);
    });

    expect(result.current.selectedIndex).toBe(1);
    expect(terminalCache.__getAppliedEdits()).toEqual([]);

    await act(async () => {
      await result.current.acceptSelected();
    });

    expect(terminalCache.__getAppliedEdits()).toHaveLength(1);
  });

  it('ignores stale async directory responses', async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    let resolveSecond: ((value: unknown) => void) | undefined;

    invokeMock.mockImplementation((command: string, args: { path: string }) => {
      if (command !== 'complete_path_entries') {
        throw new Error(`Unexpected command: ${command}`);
      }

      if (args.path.endsWith('/src')) {
        return new Promise((resolve) => {
          resolveSecond = resolve;
        });
      }

      return new Promise((resolve) => {
        resolveFirst = resolve;
      });
    });

    const terminalCache = (await import('../utils/terminalCache')) as unknown as TerminalCacheMock;
    const { result } = renderHook(() => useTerminalCompletions(1, '/workspace/project'));

    await setInput(terminalCache, 1, { text: 'cd s' });
    await flushCompletion();

    await setInput(terminalCache, 1, { text: 'cd src/ma' });
    await flushCompletion();

    await act(async () => {
      resolveSecond?.([{ name: 'main.tsx', path: '/workspace/project/src/main.tsx', isDir: false }]);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.items[0]?.label).toBe('src/main.tsx');

    await act(async () => {
      resolveFirst?.([{ name: 'scripts', path: '/workspace/project/scripts', isDir: true }]);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.items[0]?.label).toBe('src/main.tsx');
  });

  it('does not offer completions when the input state is unsafe', async () => {
    const terminalCache = (await import('../utils/terminalCache')) as unknown as TerminalCacheMock;
    const { result } = renderHook(() => useTerminalCompletions(1, '/workspace/project'));

    await setInput(terminalCache, 1, { text: '', unsafe: true, version: 5 });
    await flushCompletion();

    expect(result.current.items).toEqual([]);
  });

  it('suspends completion work when the pane is inactive', async () => {
    const terminalCache = (await import('../utils/terminalCache')) as unknown as TerminalCacheMock;
    const { result } = renderHook(() => useTerminalCompletions(1, '/workspace/project', false));

    await setInput(terminalCache, 1, { text: 'git ' });
    await flushCompletion();

    expect(result.current.items).toEqual([]);

    await act(async () => {
      const handled = await result.current.handleTab(false);
      expect(handled).toBe(false);
    });

    expect(terminalCache.__getAppliedEdits()).toEqual([]);
  });

  it('falls back to the shell when the session phase is not trusted', async () => {
    useAppStore.setState((state) => ({
      ...state,
      sessions: new Map([
        [
          1,
          {
            ...(state.sessions.get(1) ?? {
              sessionId: 'session-1',
              ptyId: 1,
              shellKind: 'bash',
              mode: 'human',
              title: 'bash',
              commands: [],
              createdAt: 0,
              updatedAt: 0,
            }),
            phase: 'running',
          },
        ],
      ]),
    }));

    const terminalCache = (await import('../utils/terminalCache')) as unknown as TerminalCacheMock;
    const { result } = renderHook(() => useTerminalCompletions(1, '/workspace/project'));

    await setInput(terminalCache, 1, { text: 'git ' });
    await flushCompletion();

    expect(result.current.items).toEqual([]);
    expect(result.current.canHandleTab(false)).toBe(false);
  });

  it('replaces the active token when the cursor is in the middle of the line', async () => {
    const terminalCache = (await import('../utils/terminalCache')) as unknown as TerminalCacheMock;
    const { result } = renderHook(() => useTerminalCompletions(1, '/workspace/project'));

    await setInput(terminalCache, 1, {
      text: 'git stats --short',
      cursor: 'git stat'.length,
    });
    await flushCompletion();

    await act(async () => {
      await result.current.handleTab(false);
    });

    expect(terminalCache.__getAppliedEdits()[0]?.edit).toEqual({
      replaceStart: 4,
      replaceEnd: 9,
      newText: 'status ',
    });
  });
});
