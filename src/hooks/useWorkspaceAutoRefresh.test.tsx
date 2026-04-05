import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../store';
import type { FsChangePayload } from '../types';
import { useWorkspaceAutoRefresh } from './useWorkspaceAutoRefresh';

const subscribeProjectFsMock = vi.fn();
const subscribeProjectGitDirtyMock = vi.fn();

let fsListener: ((events: FsChangePayload[]) => void) | undefined;
let gitDirtyListener: (() => void) | undefined;

vi.mock('../runtime/workspaceRuntime', () => ({
  subscribeProjectFs: (projectPath: string, listener: (events: FsChangePayload[]) => void) => {
    subscribeProjectFsMock(projectPath);
    fsListener = listener;
    return () => {
      fsListener = undefined;
    };
  },
  subscribeProjectGitDirty: (projectPath: string, listener: () => void) => {
    subscribeProjectGitDirtyMock(projectPath);
    gitDirtyListener = listener;
    return () => {
      gitDirtyListener = undefined;
    };
  },
}));

function HookHarness(props: Parameters<typeof useWorkspaceAutoRefresh>[0]) {
  useWorkspaceAutoRefresh(props);
  return null;
}

describe('useWorkspaceAutoRefresh', () => {
  beforeEach(() => {
    subscribeProjectFsMock.mockClear();
    subscribeProjectGitDirtyMock.mockClear();
    fsListener = undefined;
    gitDirtyListener = undefined;
    useAppStore.setState((state) => ({
      ...state,
      workspaceExplorerRuntime: new Map(),
      projectExplorerRuntime: new Map(),
    }));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('filters fs events to the active file paths and debounces the callback', async () => {
    const onFsChange = vi.fn();

    render(
      <HookHarness
        active
        projectPath="D:/code/JavaScript/mini-term"
        filePaths={['D:/code/JavaScript/mini-term/README.md']}
        watchFs
        onFsChange={onFsChange}
      />,
    );

    act(() => {
      fsListener?.([
        {
          projectPath: 'D:/code/JavaScript/mini-term',
          path: 'D:/code/JavaScript/mini-term/src/App.tsx',
          kind: 'modify',
        },
        {
          projectPath: 'D:/code/JavaScript/mini-term',
          path: 'D:/code/JavaScript/mini-term/README.md',
          kind: 'modify',
        },
      ]);
      vi.advanceTimersByTime(199);
    });

    expect(onFsChange).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });

    expect(onFsChange).toHaveBeenCalledTimes(1);
    expect(onFsChange.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({
        path: 'D:/code/JavaScript/mini-term/README.md',
      }),
    ]);
  });

  it('debounces git dirty notifications and stops after the hook is disabled', async () => {
    const onGitDirty = vi.fn();

    const { rerender, unmount } = render(
      <HookHarness
        active
        projectPath="D:/code/JavaScript/mini-term"
        watchGit
        onGitDirty={onGitDirty}
      />,
    );

    act(() => {
      gitDirtyListener?.();
      gitDirtyListener?.();
      vi.advanceTimersByTime(299);
    });

    expect(onGitDirty).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });

    expect(onGitDirty).toHaveBeenCalledTimes(1);

    rerender(
      <HookHarness
        active={false}
        projectPath="D:/code/JavaScript/mini-term"
        watchGit
        onGitDirty={onGitDirty}
      />,
    );

    act(() => {
      gitDirtyListener?.();
      vi.advanceTimersByTime(300);
    });

    expect(onGitDirty).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('replays missed fs changes once when the page becomes active again', async () => {
    const onFsChange = vi.fn();
    const projectPath = 'D:/code/JavaScript/mini-term';
    const filePath = 'D:/code/JavaScript/mini-term/README.md';

    const { rerender } = render(
      <HookHarness
        active={false}
        projectPath={projectPath}
        filePaths={[filePath]}
        watchFs
        onFsChange={onFsChange}
      />,
    );

    act(() => {
      useAppStore.getState().recordWorkspaceFsChanges(projectPath, [
        {
          path: filePath,
          kind: 'modify',
        },
      ]);
    });

    rerender(
      <HookHarness
        active
        projectPath={projectPath}
        filePaths={[filePath]}
        watchFs
        onFsChange={onFsChange}
      />,
    );

    expect(onFsChange).toHaveBeenCalledTimes(1);
    expect(onFsChange.mock.calls[0]?.[0]).toEqual([
      {
        projectPath,
        path: filePath,
        kind: 'refresh',
      },
    ]);
  });

  it('replays one missed git dirty change when the page becomes active again', async () => {
    const onGitDirty = vi.fn();
    const projectPath = 'D:/code/JavaScript/mini-term';

    const { rerender } = render(
      <HookHarness
        active={false}
        projectPath={projectPath}
        watchGit
        onGitDirty={onGitDirty}
      />,
    );

    act(() => {
      useAppStore.getState().markWorkspaceGitDirty(projectPath);
      useAppStore.getState().markWorkspaceGitDirty(projectPath);
    });

    rerender(
      <HookHarness
        active
        projectPath={projectPath}
        watchGit
        onGitDirty={onGitDirty}
      />,
    );

    expect(onGitDirty).toHaveBeenCalledTimes(1);
  });
});
