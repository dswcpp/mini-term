import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import {
  genId,
  saveLayoutToConfig,
  useAppStore,
} from '../store';
import {
  closeManagedTerminalSession,
  openManagedTerminalSession,
} from '../runtime/terminalOrchestrator';
import { createTerminalPane } from '../utils/session';
import { getWorkspacePrimaryRootPath } from '../utils/workspace';
import { collectPaneIds, findPane, insertSplit } from '../components/terminal/splitTree';
import type { PaneState, ShellConfig, TerminalTab, UiNoticeTone, WorkspaceTab } from '../types';

interface HostControlRequest {
  requestId: string;
  action: string;
  payload: Record<string, unknown>;
}

function isTerminalTab(tab: WorkspaceTab): tab is TerminalTab {
  return tab.kind === 'terminal';
}

function getTerminalTab(workspaceId: string, tabId: string): TerminalTab | null {
  const workspaceState = useAppStore.getState().workspaceStates.get(workspaceId);
  const tab = workspaceState?.tabs.find((item) => item.id === tabId);
  return tab && isTerminalTab(tab) ? tab : null;
}

function getFirstPane(node: TerminalTab['splitLayout']): PaneState {
  if (node.type === 'leaf') {
    return node.pane;
  }
  return getFirstPane(node.children[0]);
}

async function persistConfig() {
  await invoke('save_config', { config: useAppStore.getState().config });
}

async function resolveRequest(requestId: string, success: boolean, data?: unknown, error?: string) {
  await invoke('resolve_host_control_request', {
    requestId,
    success,
    data,
    error,
  });
}

async function handleCreateTab(payload: Record<string, unknown>) {
  const workspaceId = String(payload.workspaceId ?? '');
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : undefined;
  const shellName = typeof payload.shellName === 'string' ? payload.shellName : undefined;
  const activate = payload.activate !== false;
  const store = useAppStore.getState();
  const previousWorkspaceId = store.activeWorkspaceId;
  const previousWorkspaceState = previousWorkspaceId
    ? useAppStore.getState().workspaceStates.get(previousWorkspaceId)
    : undefined;
  const previousTabId = previousWorkspaceState?.activeTabId;
  const previousPaneId = previousTabId ? useAppStore.getState().activePaneByTab.get(previousTabId) : undefined;

  const tabId = await useAppStore.getState().createTerminalTab(workspaceId, { cwd, shellName });
  if (!tabId) {
    throw new Error('failed to create tab');
  }

  const tab = getTerminalTab(workspaceId, tabId);
  if (!tab) {
    throw new Error('tab not found');
  }
  const pane = getFirstPane(tab.splitLayout);

  if (activate) {
    useAppStore.getState().setActiveWorkspace(workspaceId);
    useAppStore.getState().setActiveTab(workspaceId, tabId);
    useAppStore.getState().setActivePaneForTab(tabId, pane.id);
    await persistConfig();
  } else if (previousWorkspaceId) {
    useAppStore.getState().setActiveWorkspace(previousWorkspaceId);
    if (previousTabId) {
      useAppStore.getState().setActiveTab(previousWorkspaceId, previousTabId);
    }
    if (previousPaneId) {
      useAppStore.getState().setActivePaneForTab(previousTabId!, previousPaneId);
    }
    await persistConfig();
  }

  return {
    workspaceId,
    tabId,
    paneId: pane.id,
    sessionId: pane.sessionId,
    ptyId: pane.ptyId,
  };
}

async function handleCloseTab(payload: Record<string, unknown>) {
  const workspaceId = String(payload.workspaceId ?? '');
  const tabId = String(payload.tabId ?? '');
  const workspaceState = useAppStore.getState().workspaceStates.get(workspaceId);
  const tab = workspaceState?.tabs.find((item) => item.id === tabId);
  if (!workspaceState || !tab) {
    throw new Error('tab not found');
  }

  if (isTerminalTab(tab)) {
    const panes = collectPaneIds(tab.splitLayout)
      .map((paneId) => findPane(tab.splitLayout, paneId))
      .filter((pane): pane is PaneState => Boolean(pane));
    for (const pane of panes) {
      await closeManagedTerminalSession(pane.sessionId).catch(() => undefined);
    }
  }

  useAppStore.getState().clearActivePaneForTab(tabId);
  useAppStore.getState().removeTab(workspaceId, tabId);
  saveLayoutToConfig(workspaceId);
  return { workspaceId, tabId, closed: true };
}

async function handleSplitPane(payload: Record<string, unknown>) {
  const workspaceId = String(payload.workspaceId ?? '');
  const tabId = String(payload.tabId ?? '');
  const paneId = String(payload.paneId ?? '');
  const direction = payload.direction === 'vertical' ? 'vertical' : 'horizontal';
  const requestedCwd = typeof payload.cwd === 'string' ? payload.cwd : undefined;
  const shellName = typeof payload.shellName === 'string' ? payload.shellName : undefined;
  const activate = payload.activate !== false;

  const store = useAppStore.getState();
  const workspace = store.workspaceById.get(workspaceId);
  const tab = getTerminalTab(workspaceId, tabId);
  if (!workspace || !tab) {
    throw new Error('tab not found');
  }
  if (!findPane(tab.splitLayout, paneId)) {
    throw new Error('pane not found');
  }

  const shell: ShellConfig | undefined =
    store.config.availableShells.find((item) => item.name === (shellName ?? store.config.defaultShell))
    ?? store.config.availableShells[0];
  const cwd = requestedCwd ?? getWorkspacePrimaryRootPath(workspace);
  if (!shell || !cwd) {
    throw new Error('shell not found');
  }

  const payloadSession = await openManagedTerminalSession({
    shell: shell.command,
    args: shell.args ?? [],
    cwd,
  });
  const newPane = createTerminalPane(
    shell.name,
    payloadSession.ptyId,
    genId(),
    'human',
    undefined,
    undefined,
    payloadSession.sessionId,
  );

  const latestTab = getTerminalTab(workspaceId, tabId);
  if (!latestTab) {
    throw new Error('tab not found');
  }
  const nextLayout = insertSplit(latestTab.splitLayout, paneId, direction, newPane);
  useAppStore.getState().updateTabLayout(workspaceId, tabId, nextLayout);

  if (activate) {
    useAppStore.getState().setActiveWorkspace(workspaceId);
    useAppStore.getState().setActiveTab(workspaceId, tabId);
    useAppStore.getState().setActivePaneForTab(tabId, newPane.id);
    await persistConfig();
  }

  saveLayoutToConfig(workspaceId);
  return {
    workspaceId,
    tabId,
    paneId: newPane.id,
    sessionId: newPane.sessionId,
    ptyId: newPane.ptyId,
  };
}

async function handleRequest(request: HostControlRequest) {
  switch (request.action) {
    case 'focus_workspace': {
      const workspaceId = String(request.payload.workspaceId ?? '');
      useAppStore.getState().setActiveWorkspace(workspaceId);
      await persistConfig();
      return { workspaceId, focused: true };
    }
    case 'create_tab':
      return handleCreateTab(request.payload);
    case 'close_tab':
      return handleCloseTab(request.payload);
    case 'split_pane':
      return handleSplitPane(request.payload);
    case 'notify_user': {
      const message = String(request.payload.message ?? '');
      const tone = (request.payload.tone as UiNoticeTone | undefined) ?? 'info';
      const durationMs =
        typeof request.payload.durationMs === 'number' ? request.payload.durationMs : undefined;
      useAppStore.getState().showNotice({ message, tone, durationMs });
      return { shown: true };
    }
    default:
      throw new Error(`unsupported host control action: ${request.action}`);
  }
}

export function useHostControlBridge() {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listen<HostControlRequest>('host-control-request', async (event) => {
      if (disposed) {
        return;
      }

      try {
        const data = await handleRequest(event.payload);
        await resolveRequest(event.payload.requestId, true, data);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await resolveRequest(event.payload.requestId, false, undefined, message);
      }
    })
      .then((cleanup) => {
        if (disposed) {
          cleanup();
        } else {
          unlisten = cleanup;
        }
      })
      .catch(console.error);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
