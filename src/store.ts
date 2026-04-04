import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { getDefaultThemeConfig } from './theme';
import { createTerminalPane, createTerminalSessionMeta, getSessionIdForPty } from './utils/session';
import {
  buildRecentWorkspaceEntry,
  createWorkspaceConfig,
  ensureSinglePrimaryRoot,
  getPathBaseName,
  getWorkspaceLookupByRootPath,
  getWorkspacePrimaryRootPath,
  normalizeWorkspacePath,
  restoreWorkspaceFromRecent,
} from './utils/workspace';
import type {
  AppConfig,
  CommandBlock,
  CommitFileInfo,
  GitFileStatus,
  PaneRuntimeState,
  PaneStatus,
  PreviewMode,
  SavedProjectLayout,
  SavedSplitNode,
  SavedTab,
  SessionPhase,
  SettingsPage,
  SplitNode,
  TerminalSessionMeta,
  TerminalTab,
  UiDialog,
  WorkspaceConfig,
  WorkspaceExplorerRuntime,
  WorkspaceState,
  WorkspaceTab,
} from './types';
import { createEmptyCompletionUsage, recordCompletionUsage } from './utils/terminalCompletion/usage';
import { isMarkdownFilePath } from './utils/markdownPreview';
import { disposeTerminal } from './utils/terminalCache';

let idCounter = 0;
export const genId = () => `id-${Date.now()}-${++idCounter}`;

const STATUS_PRIORITY: Record<PaneStatus, number> = {
  error: 3,
  'ai-working': 2,
  'ai-idle': 1,
  idle: 0,
};

export interface PtyPaneIndexEntry {
  workspaceId: string;
  tabId: string;
  paneId: string;
}

function buildConfigIndexes(workspaces: WorkspaceConfig[]) {
  return {
    workspaceById: new Map(workspaces.map((workspace) => [workspace.id, workspace])),
    workspaceIdByRootPath: getWorkspaceLookupByRootPath(workspaces),
  };
}

function withConfigIndexes(config: AppConfig) {
  return {
    config,
    ...buildConfigIndexes(config.workspaces),
  };
}

function createExplorerRuntimeState(): WorkspaceExplorerRuntime {
  return {
    dirtyPaths: [],
    gitDirtyToken: 0,
  };
}

function isTerminalTab(tab: WorkspaceTab): tab is TerminalTab {
  return tab.kind === 'terminal';
}

function normalizeFileViewerMode(filePath: string, mode?: PreviewMode): PreviewMode {
  return mode === 'preview' && isMarkdownFilePath(filePath) ? 'preview' : 'source';
}

function getHighestStatusFromEntries(entries: Iterable<PaneRuntimeState>): PaneStatus {
  let highestStatus: PaneStatus = 'idle';
  for (const entry of entries) {
    if (STATUS_PRIORITY[entry.status] > STATUS_PRIORITY[highestStatus]) {
      highestStatus = entry.status;
    }
  }
  return highestStatus;
}

function updatePaneRunCommand(node: SplitNode, paneId: string, runCommand?: string): SplitNode {
  if (node.type === 'leaf') {
    if (node.pane.id !== paneId) {
      return node;
    }
    if (node.pane.runCommand === runCommand) {
      return node;
    }
    return { ...node, pane: { ...node.pane, runCommand } };
  }

  let changed = false;
  const children = node.children.map((child) => {
    const nextChild = updatePaneRunCommand(child, paneId, runCommand);
    if (nextChild !== child) {
      changed = true;
    }
    return nextChild;
  });

  return changed ? { ...node, children } : node;
}

function indexSplitNode(
  workspaceId: string,
  tabId: string,
  node: SplitNode,
  ptyToPaneIndex: Map<number, PtyPaneIndexEntry>,
  paneIdToPty: Map<string, number>,
  paneRuntimeByPty: Map<number, PaneRuntimeState>,
  existingPaneRuntime?: Map<number, PaneRuntimeState>,
) {
  if (node.type === 'leaf') {
    ptyToPaneIndex.set(node.pane.ptyId, {
      workspaceId,
      tabId,
      paneId: node.pane.id,
    });
    paneIdToPty.set(node.pane.id, node.pane.ptyId);
    const existingRuntime = existingPaneRuntime?.get(node.pane.ptyId);
    paneRuntimeByPty.set(node.pane.ptyId, {
      ptyId: node.pane.ptyId,
      paneId: node.pane.id,
      tabId,
      workspaceId,
      status: existingRuntime?.status ?? node.pane.status,
      phase: existingRuntime?.phase ?? node.pane.phase,
      isFocused: existingRuntime?.isFocused ?? false,
    });
    return;
  }

  node.children.forEach((child) =>
    indexSplitNode(workspaceId, tabId, child, ptyToPaneIndex, paneIdToPty, paneRuntimeByPty, existingPaneRuntime),
  );
}

export function rebuildWorkspaceIndexes(
  workspaceStates: Map<string, WorkspaceState>,
  existingPaneRuntime?: Map<number, PaneRuntimeState>,
  activePaneByTab?: Map<string, string>,
) {
  const ptyToPaneIndex = new Map<number, PtyPaneIndexEntry>();
  const paneIdToPty = new Map<string, number>();
  const paneRuntimeByPty = new Map<number, PaneRuntimeState>();
  const tabKindIndex = new Map<string, WorkspaceTab['kind']>();
  const tabRuntimeAggregate = new Map<string, PaneStatus>();

  for (const [workspaceId, workspaceState] of workspaceStates) {
    for (const tab of workspaceState.tabs) {
      tabKindIndex.set(tab.id, tab.kind);
      if (isTerminalTab(tab)) {
        indexSplitNode(
          workspaceId,
          tab.id,
          tab.splitLayout,
          ptyToPaneIndex,
          paneIdToPty,
          paneRuntimeByPty,
          existingPaneRuntime,
        );
      }
    }
  }

  for (const runtime of paneRuntimeByPty.values()) {
    runtime.isFocused = activePaneByTab?.get(runtime.tabId) === runtime.paneId;
  }

  const paneRuntimeByTab = new Map<string, PaneRuntimeState[]>();
  for (const runtime of paneRuntimeByPty.values()) {
    const current = paneRuntimeByTab.get(runtime.tabId) ?? [];
    current.push(runtime);
    paneRuntimeByTab.set(runtime.tabId, current);
  }

  for (const [tabId, entries] of paneRuntimeByTab) {
    tabRuntimeAggregate.set(tabId, getHighestStatusFromEntries(entries));
  }

  return {
    ptyToPaneIndex,
    paneIdToPty,
    paneRuntimeByPty,
    tabKindIndex,
    tabRuntimeAggregate,
  };
}

export function buildWorkspaceStatePatch(
  workspaceStates: Map<string, WorkspaceState>,
  existingPaneRuntime?: Map<number, PaneRuntimeState>,
  activePaneByTab?: Map<string, string>,
) {
  return {
    workspaceStates,
    ...rebuildWorkspaceIndexes(workspaceStates, existingPaneRuntime, activePaneByTab),
  };
}

export const buildProjectStatePatch = buildWorkspaceStatePatch;

export function collectPtyIds(node: SplitNode): number[] {
  if (node.type === 'leaf') {
    return [node.pane.ptyId];
  }
  return node.children.flatMap(collectPtyIds);
}

function serializeSplitNode(node: SplitNode): SavedSplitNode {
  if (node.type === 'leaf') {
    return {
      type: 'leaf',
      pane: {
        shellName: node.pane.shellName,
        runCommand: node.pane.runCommand,
      },
    };
  }

  return {
    type: 'split',
    direction: node.direction,
    children: node.children.map(serializeSplitNode),
    sizes: [...node.sizes],
  };
}

export function serializeLayout(workspaceState: WorkspaceState): SavedProjectLayout {
  const terminalTabs = workspaceState.tabs.filter(isTerminalTab);
  const tabs: SavedTab[] = terminalTabs.map((tab) => ({
    customTitle: tab.customTitle,
    splitLayout: serializeSplitNode(tab.splitLayout),
  }));
  const activeTabIndex = terminalTabs.findIndex((tab) => tab.id === workspaceState.activeTabId);
  return {
    tabs,
    activeTabIndex: activeTabIndex >= 0 ? activeTabIndex : 0,
  };
}

async function restoreSplitNode(saved: SavedSplitNode, cwd: string, config: AppConfig): Promise<SplitNode | null> {
  if (saved.type === 'leaf') {
    const shell =
      config.availableShells.find((item) => item.name === saved.pane.shellName)
      ?? config.availableShells.find((item) => item.name === config.defaultShell)
      ?? config.availableShells[0];
    if (!shell) {
      return null;
    }

    try {
      const ptyId = await invoke<number>('create_pty', {
        shell: shell.command,
        args: shell.args ?? [],
        cwd,
      });
      useAppStore.getState().upsertSession(createTerminalSessionMeta(shell.name, ptyId, cwd));
      return {
        type: 'leaf',
        pane: {
          id: genId(),
          sessionId: getSessionIdForPty(ptyId),
          shellName: shell.name,
          runCommand: saved.pane.runCommand,
          status: 'idle',
          mode: 'human',
          phase: 'starting',
          ptyId,
        },
      };
    } catch {
      return null;
    }
  }

  const children: SplitNode[] = [];
  for (const child of saved.children) {
    const restored = await restoreSplitNode(child, cwd, config);
    if (restored) {
      children.push(restored);
    }
  }

  if (children.length === 0) {
    return null;
  }

  if (children.length === 1) {
    return children[0];
  }

  return {
    type: 'split',
    direction: saved.direction,
    children,
    sizes: children.length === saved.sizes.length ? [...saved.sizes] : children.map(() => 100 / children.length),
  };
}

export async function restoreLayout(
  workspaceId: string,
  savedLayout: SavedProjectLayout,
  cwd: string,
  config: AppConfig,
): Promise<void> {
  const tabs: TerminalTab[] = [];
  for (const savedTab of savedLayout.tabs) {
    const layout = await restoreSplitNode(savedTab.splitLayout, cwd, config);
    if (layout) {
      tabs.push({
        kind: 'terminal',
        id: genId(),
        customTitle: savedTab.customTitle,
        splitLayout: layout,
        status: 'idle',
      });
    }
  }

  if (tabs.length === 0) {
    return;
  }

  const activeTabId = tabs[savedLayout.activeTabIndex]?.id ?? tabs[0]?.id ?? '';
  useAppStore.setState((state) => {
    const workspaceStates = new Map(state.workspaceStates);
    workspaceStates.set(workspaceId, { id: workspaceId, tabs, activeTabId });
    return buildWorkspaceStatePatch(workspaceStates, state.paneRuntimeByPty, state.activePaneByTab);
  });
}

function getExpandedKey(workspaceId: string, rootId: string) {
  return `${workspaceId}::${rootId}`;
}

const expandedDirsMap = new Map<string, Set<string>>();
const saveExpandedTimers = new Map<string, ReturnType<typeof setTimeout>>();
const saveLayoutTimers = new Map<string, ReturnType<typeof setTimeout>>();
const completionUsageSaveTimerKey = '__completion_usage__';
const saveCompletionUsageTimers = new Map<string, ReturnType<typeof setTimeout>>();

function collectWorkspaceExpandedDirs(workspaceId: string, workspace: WorkspaceConfig) {
  const next: Record<string, string[]> = {};
  for (const root of workspace.roots) {
    next[root.id] = Array.from(expandedDirsMap.get(getExpandedKey(workspaceId, root.id)) ?? []);
  }
  return next;
}

export function initExpandedDirs(workspaceId: string, rootId: string, dirs: string[]) {
  expandedDirsMap.set(getExpandedKey(workspaceId, rootId), new Set(dirs));
}

export function isExpanded(workspaceId: string, rootId: string, path: string) {
  return expandedDirsMap.get(getExpandedKey(workspaceId, rootId))?.has(path) ?? false;
}

function doSaveExpandedDirs(workspaceId: string) {
  const { config } = useAppStore.getState();
  const workspace = config.workspaces.find((item) => item.id === workspaceId);
  if (!workspace) {
    return;
  }

  const nextConfig: AppConfig = {
    ...config,
    workspaces: config.workspaces.map((item) =>
      item.id === workspaceId
        ? {
            ...item,
            expandedDirsByRoot: collectWorkspaceExpandedDirs(workspaceId, workspace),
          }
        : item,
    ),
  };

  useAppStore.getState().setConfig(nextConfig);
  void invoke('save_config', { config: nextConfig });
}

function saveExpandedDirsToConfig(workspaceId: string) {
  const existing = saveExpandedTimers.get(workspaceId);
  if (existing) {
    clearTimeout(existing);
  }
  saveExpandedTimers.set(
    workspaceId,
    setTimeout(() => {
      saveExpandedTimers.delete(workspaceId);
      doSaveExpandedDirs(workspaceId);
    }, 500),
  );
}

export function toggleExpandedDir(workspaceId: string, rootId: string, path: string, expanded: boolean) {
  const key = getExpandedKey(workspaceId, rootId);
  let paths = expandedDirsMap.get(key);
  if (!paths) {
    paths = new Set<string>();
    expandedDirsMap.set(key, paths);
  }

  if (expanded) {
    paths.add(path);
  } else {
    paths.delete(path);
  }
  saveExpandedDirsToConfig(workspaceId);
}

export function flushExpandedDirsToConfig(workspaceId: string) {
  const existing = saveExpandedTimers.get(workspaceId);
  if (existing) {
    clearTimeout(existing);
    saveExpandedTimers.delete(workspaceId);
  }
  doSaveExpandedDirs(workspaceId);
}

function doSaveLayout(workspaceId: string) {
  const { config, workspaceStates } = useAppStore.getState();
  const workspaceState = workspaceStates.get(workspaceId);
  if (!workspaceState) {
    return;
  }

  const savedLayout = serializeLayout(workspaceState);
  const nextConfig: AppConfig = {
    ...config,
    workspaces: config.workspaces.map((workspace) =>
      workspace.id === workspaceId
        ? {
            ...workspace,
            savedLayout,
          }
        : workspace,
    ),
  };

  useAppStore.getState().setConfig(nextConfig);
  void invoke('save_config', { config: nextConfig });
}

export function saveLayoutToConfig(workspaceId: string) {
  const existing = saveLayoutTimers.get(workspaceId);
  if (existing) {
    clearTimeout(existing);
  }
  saveLayoutTimers.set(
    workspaceId,
    setTimeout(() => {
      saveLayoutTimers.delete(workspaceId);
      doSaveLayout(workspaceId);
    }, 500),
  );
}

export function flushLayoutToConfig(workspaceId: string) {
  const existing = saveLayoutTimers.get(workspaceId);
  if (existing) {
    clearTimeout(existing);
    saveLayoutTimers.delete(workspaceId);
  }
  doSaveLayout(workspaceId);
}

function doSaveCompletionUsage() {
  const { config } = useAppStore.getState();
  void invoke('save_config', { config });
}

function saveCompletionUsageToConfig() {
  const existing = saveCompletionUsageTimers.get(completionUsageSaveTimerKey);
  if (existing) {
    clearTimeout(existing);
  }
  saveCompletionUsageTimers.set(
    completionUsageSaveTimerKey,
    setTimeout(() => {
      saveCompletionUsageTimers.delete(completionUsageSaveTimerKey);
      doSaveCompletionUsage();
    }, 800),
  );
}

export function flushCompletionUsageToConfig() {
  const existing = saveCompletionUsageTimers.get(completionUsageSaveTimerKey);
  if (existing) {
    clearTimeout(existing);
    saveCompletionUsageTimers.delete(completionUsageSaveTimerKey);
  }
  doSaveCompletionUsage();
}

function moveArrayItem<T>(items: T[], fromIndex: number, toIndex: number) {
  const next = [...items];
  const [item] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, item);
  return next;
}

function removeWorkspaceRootState(workspaceId: string, rootId: string) {
  expandedDirsMap.delete(getExpandedKey(workspaceId, rootId));
}

function upsertRecentEntry(recent: AppConfig['recentWorkspaces'], entry: AppConfig['recentWorkspaces'][number]) {
  return [entry, ...recent.filter((item) => item.id !== entry.id)]
    .sort((left, right) => right.lastOpenedAt - left.lastOpenedAt)
    .slice(0, 24);
}

function normalizeWorkspaceStoreConfig(config: AppConfig): AppConfig {
  const now = Date.now();
  return {
    ...config,
    workspaces: (config.workspaces ?? []).map((workspace) => ({
      ...workspace,
      roots: ensureSinglePrimaryRoot(workspace.roots),
      expandedDirsByRoot: workspace.expandedDirsByRoot ?? {},
      pinned: workspace.pinned ?? false,
      createdAt: workspace.createdAt ?? now,
      lastOpenedAt: workspace.lastOpenedAt ?? now,
    })),
    recentWorkspaces: config.recentWorkspaces ?? [],
    lastWorkspaceId: config.lastWorkspaceId ?? config.workspaces?.[0]?.id,
    completionUsage: config.completionUsage ?? createEmptyCompletionUsage(),
  };
}

interface AppStore {
  config: AppConfig;
  workspaceById: Map<string, WorkspaceConfig>;
  workspaceIdByRootPath: Map<string, string>;
  setConfig: (config: AppConfig) => void;

  sessions: Map<number, TerminalSessionMeta>;
  activePaneByTab: Map<string, string>;
  ptyToPaneIndex: Map<number, PtyPaneIndexEntry>;
  paneIdToPty: Map<string, number>;
  paneRuntimeByPty: Map<number, PaneRuntimeState>;
  tabKindIndex: Map<string, WorkspaceTab['kind']>;
  tabRuntimeAggregate: Map<string, PaneStatus>;
  workspaceExplorerRuntime: Map<string, WorkspaceExplorerRuntime>;

  upsertSession: (session: TerminalSessionMeta) => void;
  updateSessionCwd: (ptyId: number, cwd: string, updatedAt?: number) => void;
  updateSessionPhase: (ptyId: number, phase: SessionPhase, patch?: Partial<TerminalSessionMeta>) => void;
  recordSessionCommand: (ptyId: number, command: string, updatedAt?: number, usageScope?: string) => void;
  finishSessionCommand: (ptyId: number, exitCode: number | undefined, phase: SessionPhase, updatedAt?: number) => void;
  removeSession: (ptyId: number) => void;

  setPaneRunCommand: (tabId: string, paneId: string, runCommand?: string) => void;
  setActivePaneForTab: (tabId: string, paneId: string) => void;
  clearActivePaneForTab: (tabId: string) => void;

  activeWorkspaceId: string | null;
  workspaceStates: Map<string, WorkspaceState>;
  setActiveWorkspace: (id: string) => void;
  createWorkspaceFromFolder: (path: string, options?: { name?: string; pinned?: boolean }) => string | null;
  createWorkspaceFromFolders: (paths: string[], options?: { name?: string; pinned?: boolean }) => string | null;
  renameWorkspace: (workspaceId: string, name: string) => void;
  pinWorkspace: (workspaceId: string, pinned?: boolean) => void;
  moveWorkspace: (workspaceId: string, direction: 'up' | 'down') => void;
  removeWorkspace: (workspaceId: string) => Promise<void>;
  reopenRecentWorkspace: (workspaceId: string) => string | null;
  forgetRecentWorkspace: (workspaceId: string) => void;
  addRootToWorkspace: (workspaceId: string, rootPath: string) => void;
  removeRootFromWorkspace: (workspaceId: string, rootId: string) => void;
  setPrimaryWorkspaceRoot: (workspaceId: string, rootId: string) => void;
  createTerminalTab: (workspaceId: string, options?: { cwd?: string; shellName?: string }) => Promise<string | null>;

  addTab: (workspaceId: string, tab: WorkspaceTab) => void;
  removeTab: (workspaceId: string, tabId: string) => void;
  setActiveTab: (workspaceId: string, tabId: string) => void;
  setTabCustomTitle: (workspaceId: string, tabId: string, customTitle?: string) => void;
  updateTabLayout: (workspaceId: string, tabId: string, layout: SplitNode) => void;

  updatePaneStatusByPty: (ptyId: number, status: PaneStatus) => void;
  updatePaneStatusesByPty: (updates: Array<{ ptyId: number; status: PaneStatus }>) => void;
  recordWorkspaceFsChanges: (rootPath: string, changes: { path: string; kind: string }[]) => void;
  markWorkspaceGitDirty: (rootPath: string) => void;

  ui: {
    activeDialog: UiDialog | null;
  };
  openSettings: (page?: SettingsPage) => void;
  openFileViewer: (workspaceId: string, filePath: string, options?: { initialMode?: PreviewMode }) => void;
  setFileViewerTabMode: (workspaceId: string, tabId: string, mode: PreviewMode) => void;
  openInteractionDialog: (payload: {
    dialogId: string;
    mode: 'alert' | 'confirm' | 'prompt';
    title: string;
    message?: string;
    detail?: string;
    placeholder?: string;
    initialValue?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    tone?: 'neutral' | 'warning' | 'danger';
    readOnly?: boolean;
  }) => void;
  openWorktreeDiff: (workspaceId: string, projectPath: string, status: GitFileStatus) => void;
  openCommitDiff: (payload: {
    workspaceId: string;
    repoPath: string;
    commitHash: string;
    commitMessage: string;
    files: CommitFileInfo[];
  }) => void;
  closeDialog: () => void;
}

export const selectWorkspaceState =
  (workspaceId: string) =>
  (state: AppStore): WorkspaceState | undefined =>
    state.workspaceStates.get(workspaceId);

export const selectWorkspaceConfig =
  (workspaceId: string | null | undefined) =>
  (state: AppStore): WorkspaceConfig | undefined =>
    workspaceId ? state.workspaceById.get(workspaceId) : undefined;

export const selectWorkspacePrimaryRootPath =
  (workspaceId: string | null | undefined) =>
  (state: AppStore): string | undefined =>
    getWorkspacePrimaryRootPath(workspaceId ? state.workspaceById.get(workspaceId) : undefined);

export const selectWorkspaceRootPaths =
  (workspaceId: string | null | undefined) =>
  (state: AppStore): string[] =>
    workspaceId ? (state.workspaceById.get(workspaceId)?.roots.map((root) => root.path) ?? []) : [];

export const selectSessionByPty =
  (ptyId: number | undefined, enabled = true) =>
  (state: AppStore): TerminalSessionMeta | undefined =>
    enabled && ptyId != null ? state.sessions.get(ptyId) : undefined;

export const selectPaneRuntimeByPty =
  (ptyId: number | undefined, enabled = true) =>
  (state: AppStore): PaneRuntimeState | undefined =>
    enabled && ptyId != null ? state.paneRuntimeByPty.get(ptyId) : undefined;

export const selectWorkspaceSections = (state: AppStore) => ({
  pinned: state.config.workspaces.filter((workspace) => workspace.pinned),
  open: state.config.workspaces.filter((workspace) => !workspace.pinned),
  recent: [...state.config.recentWorkspaces].sort((left, right) => right.lastOpenedAt - left.lastOpenedAt),
});

export const selectWorkspaces = (state: AppStore) => state.config.workspaces;
export const selectRecentWorkspaces = (state: AppStore) => state.config.recentWorkspaces;
export const selectActiveWorkspace = (state: AppStore) =>
  state.activeWorkspaceId ? state.workspaceById.get(state.activeWorkspaceId) : undefined;

export const selectWorkspaceRuntimeSummary =
  (workspaceId: string) =>
  (state: AppStore) => {
    const workspaceState = state.workspaceStates.get(workspaceId);
    const terminalTabs = workspaceState?.tabs.filter(isTerminalTab) ?? [];
    const status = terminalTabs.length > 0
      ? getHighestStatusFromEntries(
          terminalTabs.map((tab) => ({
            ptyId: -1,
            paneId: '',
            tabId: tab.id,
            workspaceId,
            status: state.tabRuntimeAggregate.get(tab.id) ?? tab.status,
            phase: 'ready',
            isFocused: false,
          })),
        )
      : 'idle';
    return {
      status,
      terminalTabCount: terminalTabs.length,
      totalTabCount: workspaceState?.tabs.length ?? 0,
    };
  };

export const selectTabRuntimeStatus =
  (tabId: string) =>
  (state: AppStore): PaneStatus =>
    state.tabRuntimeAggregate.get(tabId) ?? 'idle';

export const selectThemeConfig = (state: AppStore) => state.config.theme;
export const selectThemePreset = (state: AppStore) => state.config.theme.preset;
export const selectWorkspaceGitDirtyToken =
  (rootPath: string | undefined) =>
  (state: AppStore): number =>
    (rootPath ? state.workspaceExplorerRuntime.get(normalizeWorkspacePath(rootPath))?.gitDirtyToken : undefined) ?? 0;

const defaultConfig: AppConfig = normalizeWorkspaceStoreConfig({
  workspaces: [],
  recentWorkspaces: [],
  defaultShell: '',
  availableShells: [],
  uiFontSize: 13,
  terminalFontSize: 14,
  theme: getDefaultThemeConfig(),
  completionUsage: createEmptyCompletionUsage(),
});

export const useAppStore = create<AppStore>((set, get) => ({
  ...withConfigIndexes(defaultConfig),
  setConfig: (config) => set(withConfigIndexes(normalizeWorkspaceStoreConfig(config))),

  sessions: new Map(),
  activePaneByTab: new Map(),
  ptyToPaneIndex: new Map(),
  paneIdToPty: new Map(),
  paneRuntimeByPty: new Map(),
  tabKindIndex: new Map(),
  tabRuntimeAggregate: new Map(),
  workspaceExplorerRuntime: new Map(),
  activeWorkspaceId: null,
  workspaceStates: new Map(),
  ui: {
    activeDialog: null,
  },

  upsertSession: (session) =>
    set((state) => {
      const sessions = new Map(state.sessions);
      const existing = sessions.get(session.ptyId);
      sessions.set(
        session.ptyId,
        existing
          ? {
              ...existing,
              ...session,
              commands: session.commands.length > 0 ? session.commands : existing.commands,
            }
          : session,
      );

      const paneRuntime = state.paneRuntimeByPty.get(session.ptyId);
      if (!paneRuntime) {
        return { sessions };
      }

      const paneRuntimeByPty = new Map(state.paneRuntimeByPty);
      paneRuntimeByPty.set(session.ptyId, {
        ...paneRuntime,
        phase: session.phase,
      });
      return { sessions, paneRuntimeByPty };
    }),

  updateSessionCwd: (ptyId, cwd, updatedAt) =>
    set((state) => {
      const existing = state.sessions.get(ptyId);
      if (!existing || existing.cwd === cwd) {
        return state;
      }

      const sessions = new Map(state.sessions);
      sessions.set(ptyId, {
        ...existing,
        cwd,
        updatedAt: updatedAt ?? Date.now(),
      });
      return { sessions };
    }),

  updateSessionPhase: (ptyId, phase, patch) =>
    set((state) => {
      const existing = state.sessions.get(ptyId);
      if (!existing) {
        return state;
      }

      const updatedAt = patch?.updatedAt ?? Date.now();
      const sessions = new Map(state.sessions);
      sessions.set(ptyId, {
        ...existing,
        ...patch,
        phase,
        updatedAt,
      });

      const paneRuntime = state.paneRuntimeByPty.get(ptyId);
      if (!paneRuntime) {
        return { sessions };
      }

      const paneRuntimeByPty = new Map(state.paneRuntimeByPty);
      paneRuntimeByPty.set(ptyId, {
        ...paneRuntime,
        phase,
      });
      return { sessions, paneRuntimeByPty };
    }),

  recordSessionCommand: (ptyId, command, updatedAt, usageScope) => {
    let shouldPersistUsage = false;
    set((state) => {
      const existing = state.sessions.get(ptyId);
      if (!existing) {
        return state;
      }

      const now = updatedAt ?? Date.now();
      const settledCommands = existing.activeCommand
        ? existing.commands.map((item) =>
            item.id === existing.activeCommand?.id
              ? { ...item, finishedAt: now, status: 'completed' as const }
              : item,
          )
        : existing.commands;

      const nextCommand: CommandBlock = {
        id: genId(),
        command,
        startedAt: now,
        status: 'running',
      };

      const nextCompletionUsage = recordCompletionUsage(
        state.config.completionUsage ?? createEmptyCompletionUsage(),
        command,
        existing.shellKind,
        usageScope ?? existing.cwd,
      );

      const sessions = new Map(state.sessions);
      sessions.set(ptyId, {
        ...existing,
        commands: [...settledCommands, nextCommand].slice(-12),
        lastCommand: command,
        phase: 'running',
        updatedAt: now,
        activeCommand: nextCommand,
      });

      shouldPersistUsage = true;
      return {
        sessions,
        config: {
          ...state.config,
          completionUsage: nextCompletionUsage,
        },
      };
    });

    if (shouldPersistUsage) {
      saveCompletionUsageToConfig();
    }
  },

  finishSessionCommand: (ptyId, exitCode, phase, updatedAt) =>
    set((state) => {
      const existing = state.sessions.get(ptyId);
      if (!existing) {
        return state;
      }

      const now = updatedAt ?? Date.now();
      const finishedStatus: CommandBlock['status'] =
        exitCode == null ? 'interrupted' : exitCode === 0 ? 'success' : 'error';
      const nextActiveCommand = existing.activeCommand
        ? {
            ...existing.activeCommand,
            finishedAt: now,
            exitCode,
            status: finishedStatus,
          }
        : existing.activeCommand;

      const sessions = new Map(state.sessions);
      sessions.set(ptyId, {
        ...existing,
        commands: existing.activeCommand
          ? existing.commands.map((command) =>
              command.id === existing.activeCommand?.id ? (nextActiveCommand as CommandBlock) : command,
            )
          : existing.commands,
        phase,
        lastExitCode: exitCode,
        updatedAt: now,
        activeCommand: nextActiveCommand,
      });

      const paneRuntime = state.paneRuntimeByPty.get(ptyId);
      if (!paneRuntime) {
        return { sessions };
      }

      const paneRuntimeByPty = new Map(state.paneRuntimeByPty);
      paneRuntimeByPty.set(ptyId, {
        ...paneRuntime,
        phase,
      });
      return { sessions, paneRuntimeByPty };
    }),

  removeSession: (ptyId) =>
    set((state) => {
      if (!state.sessions.has(ptyId)) {
        return state;
      }

      const sessions = new Map(state.sessions);
      sessions.delete(ptyId);
      if (!state.paneRuntimeByPty.has(ptyId)) {
        return { sessions };
      }

      const paneRuntimeByPty = new Map(state.paneRuntimeByPty);
      paneRuntimeByPty.delete(ptyId);
      return { sessions, paneRuntimeByPty };
    }),

  setPaneRunCommand: (tabId, paneId, runCommand) =>
    set((state) => {
      let changed = false;
      const workspaceStates = new Map(state.workspaceStates);

      for (const [workspaceId, workspaceState] of workspaceStates) {
        const tabIndex = workspaceState.tabs.findIndex((tab) => tab.id === tabId);
        if (tabIndex < 0) {
          continue;
        }
        const tabs = workspaceState.tabs.map((tab) => {
          if (tab.id !== tabId || !isTerminalTab(tab)) {
            return tab;
          }
          const nextLayout = updatePaneRunCommand(tab.splitLayout, paneId, runCommand);
          if (nextLayout === tab.splitLayout) {
            return tab;
          }
          changed = true;
          return { ...tab, splitLayout: nextLayout };
        });
        workspaceStates.set(workspaceId, { ...workspaceState, tabs });
        break;
      }

      if (!changed) {
        return state;
      }
      return { workspaceStates };
    }),

  setActivePaneForTab: (tabId, paneId) =>
    set((state) => {
      if (state.activePaneByTab.get(tabId) === paneId) {
        return state;
      }
      const activePaneByTab = new Map(state.activePaneByTab);
      activePaneByTab.set(tabId, paneId);

      const paneRuntimeByPty = new Map(state.paneRuntimeByPty);
      for (const [ptyId, runtime] of paneRuntimeByPty) {
        if (runtime.tabId !== tabId) {
          continue;
        }
        const nextFocused = runtime.paneId === paneId;
        if (runtime.isFocused !== nextFocused) {
          paneRuntimeByPty.set(ptyId, {
            ...runtime,
            isFocused: nextFocused,
          });
        }
      }

      return { activePaneByTab, paneRuntimeByPty };
    }),

  clearActivePaneForTab: (tabId) =>
    set((state) => {
      if (!state.activePaneByTab.has(tabId)) {
        return state;
      }
      const activePaneByTab = new Map(state.activePaneByTab);
      activePaneByTab.delete(tabId);

      const paneRuntimeByPty = new Map(state.paneRuntimeByPty);
      for (const [ptyId, runtime] of paneRuntimeByPty) {
        if (runtime.tabId !== tabId || !runtime.isFocused) {
          continue;
        }
        paneRuntimeByPty.set(ptyId, {
          ...runtime,
          isFocused: false,
        });
      }
      return { activePaneByTab, paneRuntimeByPty };
    }),

  setActiveWorkspace: (id) =>
    set((state) => ({
      activeWorkspaceId: id,
      config: {
        ...state.config,
        lastWorkspaceId: id,
        workspaces: state.config.workspaces.map((workspace) =>
          workspace.id === id
            ? {
                ...workspace,
                lastOpenedAt: Date.now(),
              }
            : workspace,
        ),
      },
    })),

  createWorkspaceFromFolder: (path, options) => {
    const normalizedPath = normalizeWorkspacePath(path);
    if (!normalizedPath) {
      return null;
    }

    const state = get();
    const existingWorkspaceId = state.workspaceIdByRootPath.get(normalizedPath);
    if (existingWorkspaceId) {
      state.setActiveWorkspace(existingWorkspaceId);
      return existingWorkspaceId;
    }

    const recent = state.config.recentWorkspaces.find(
      (item) => item.rootPaths.length === 1 && normalizeWorkspacePath(item.rootPaths[0]) === normalizedPath,
    );
    if (recent) {
      return state.reopenRecentWorkspace(recent.id);
    }

    const workspaceId = genId();
    const workspace = createWorkspaceConfig({
      id: workspaceId,
      paths: [path],
      name: options?.name,
      pinned: options?.pinned,
    });

    set((current) => {
      const nextConfig: AppConfig = {
        ...current.config,
        workspaces: [...current.config.workspaces, workspace],
        recentWorkspaces: current.config.recentWorkspaces.filter((item) => item.id !== workspaceId),
        lastWorkspaceId: workspace.id,
      };

      const workspaceStates = new Map(current.workspaceStates);
      workspaceStates.set(workspace.id, { id: workspace.id, tabs: [], activeTabId: '' });
      return {
        activeWorkspaceId: workspace.id,
        ...withConfigIndexes(nextConfig),
        ...buildWorkspaceStatePatch(workspaceStates, current.paneRuntimeByPty, current.activePaneByTab),
      };
    });

    return workspaceId;
  },

  createWorkspaceFromFolders: (paths, options) => {
    const uniquePaths = Array.from(new Set(paths.map(normalizeWorkspacePath).filter(Boolean)));
    if (uniquePaths.length === 0) {
      return null;
    }

    const state = get();
    const normalizedSignature = [...uniquePaths].sort().join('::');
    const existing = state.config.workspaces.find((workspace) => {
      const signature = [...workspace.roots.map((root) => normalizeWorkspacePath(root.path))].sort().join('::');
      return signature === normalizedSignature;
    });
    if (existing) {
      state.setActiveWorkspace(existing.id);
      return existing.id;
    }

    const recent = state.config.recentWorkspaces.find(
      (item) => [...item.rootPaths.map(normalizeWorkspacePath)].sort().join('::') === normalizedSignature,
    );
    if (recent) {
      return state.reopenRecentWorkspace(recent.id);
    }

    const workspaceId = genId();
    const workspace = createWorkspaceConfig({
      id: workspaceId,
      paths,
      name: options?.name,
      pinned: options?.pinned,
    });

    set((current) => {
      const nextConfig: AppConfig = {
        ...current.config,
        workspaces: [...current.config.workspaces, workspace],
        recentWorkspaces: current.config.recentWorkspaces.filter((item) => item.id !== workspaceId),
        lastWorkspaceId: workspace.id,
      };

      const workspaceStates = new Map(current.workspaceStates);
      workspaceStates.set(workspace.id, { id: workspace.id, tabs: [], activeTabId: '' });
      return {
        activeWorkspaceId: workspace.id,
        ...withConfigIndexes(nextConfig),
        ...buildWorkspaceStatePatch(workspaceStates, current.paneRuntimeByPty, current.activePaneByTab),
      };
    });

    return workspaceId;
  },

  renameWorkspace: (workspaceId, name) =>
    set((state) => {
      const trimmed = name.trim();
      if (!trimmed) {
        return state;
      }

      const nextConfig: AppConfig = {
        ...state.config,
        workspaces: state.config.workspaces.map((workspace) =>
          workspace.id === workspaceId ? { ...workspace, name: trimmed } : workspace,
        ),
        recentWorkspaces: state.config.recentWorkspaces.map((workspace) =>
          workspace.id === workspaceId ? { ...workspace, name: trimmed } : workspace,
        ),
      };
      return withConfigIndexes(nextConfig);
    }),

  pinWorkspace: (workspaceId, pinned) =>
    set((state) =>
      withConfigIndexes({
        ...state.config,
        workspaces: state.config.workspaces.map((workspace) =>
          workspace.id === workspaceId
            ? {
                ...workspace,
                pinned: pinned ?? !workspace.pinned,
              }
            : workspace,
        ),
      })),

  moveWorkspace: (workspaceId, direction) =>
    set((state) => {
      const target = state.config.workspaces.find((workspace) => workspace.id === workspaceId);
      if (!target) {
        return state;
      }

      const sectionItems = state.config.workspaces.filter((workspace) => workspace.pinned === target.pinned);
      const sectionIndex = sectionItems.findIndex((workspace) => workspace.id === workspaceId);
      const nextSectionIndex = direction === 'up' ? sectionIndex - 1 : sectionIndex + 1;
      if (sectionIndex < 0 || nextSectionIndex < 0 || nextSectionIndex >= sectionItems.length) {
        return state;
      }

      const movedSection = moveArrayItem(sectionItems, sectionIndex, nextSectionIndex);
      const movedIds = movedSection.map((workspace) => workspace.id);
      let cursor = 0;
      const nextWorkspaces = state.config.workspaces.map((workspace) => {
        if (workspace.pinned !== target.pinned) {
          return workspace;
        }
        const replacement = movedSection[cursor];
        cursor += 1;
        return replacement;
      });

      if (movedIds.length !== movedSection.length) {
        return state;
      }

      return withConfigIndexes({
        ...state.config,
        workspaces: nextWorkspaces,
      });
    }),

  removeWorkspace: async (workspaceId) => {
    flushLayoutToConfig(workspaceId);
    flushExpandedDirsToConfig(workspaceId);

    const stateBefore = get();
    const workspace = stateBefore.workspaceById.get(workspaceId);
    if (!workspace) {
      return;
    }

    const workspaceState = stateBefore.workspaceStates.get(workspaceId);
    const ptyIds = workspaceState?.tabs.flatMap((tab) => (isTerminalTab(tab) ? collectPtyIds(tab.splitLayout) : [])) ?? [];
    for (const ptyId of ptyIds) {
      await invoke('kill_pty', { ptyId }).catch(() => undefined);
      disposeTerminal(ptyId);
    }

    set((state) => {
      const nextConfig: AppConfig = {
        ...state.config,
        workspaces: state.config.workspaces.filter((item) => item.id !== workspaceId),
        recentWorkspaces: upsertRecentEntry(state.config.recentWorkspaces, buildRecentWorkspaceEntry(workspace)),
        lastWorkspaceId:
          state.activeWorkspaceId === workspaceId
            ? state.config.workspaces.find((item) => item.id !== workspaceId)?.id
            : state.config.lastWorkspaceId,
      };

      const workspaceStates = new Map(state.workspaceStates);
      workspaceStates.delete(workspaceId);

      const sessions = new Map(state.sessions);
      ptyIds.forEach((ptyId) => sessions.delete(ptyId));

      const activePaneByTab = new Map(state.activePaneByTab);
      workspaceState?.tabs.forEach((tab) => activePaneByTab.delete(tab.id));

      const workspaceExplorerRuntime = new Map(state.workspaceExplorerRuntime);
      workspace.roots.forEach((root) => {
        workspaceExplorerRuntime.delete(normalizeWorkspacePath(root.path));
        removeWorkspaceRootState(workspaceId, root.id);
      });

      return {
        sessions,
        activePaneByTab,
        activeWorkspaceId:
          state.activeWorkspaceId === workspaceId
            ? nextConfig.workspaces[0]?.id ?? null
            : state.activeWorkspaceId,
        workspaceExplorerRuntime,
        ...withConfigIndexes(nextConfig),
        ...buildWorkspaceStatePatch(workspaceStates, state.paneRuntimeByPty, activePaneByTab),
      };
    });

    await invoke('save_config', { config: get().config }).catch(() => undefined);
  },

  reopenRecentWorkspace: (workspaceId) => {
    const state = get();
    const recent = state.config.recentWorkspaces.find((item) => item.id === workspaceId);
    if (!recent) {
      return null;
    }

    const workspace = restoreWorkspaceFromRecent({ recent });
    set((current) => {
      const nextConfig: AppConfig = {
        ...current.config,
        workspaces: [...current.config.workspaces, workspace],
        recentWorkspaces: current.config.recentWorkspaces.filter((item) => item.id !== workspaceId),
        lastWorkspaceId: workspace.id,
      };
      const workspaceStates = new Map(current.workspaceStates);
      workspaceStates.set(workspace.id, { id: workspace.id, tabs: [], activeTabId: '' });
      return {
        activeWorkspaceId: workspace.id,
        ...withConfigIndexes(nextConfig),
        ...buildWorkspaceStatePatch(workspaceStates, current.paneRuntimeByPty, current.activePaneByTab),
      };
    });
    return workspace.id;
  },

  forgetRecentWorkspace: (workspaceId) =>
    set((state) =>
      withConfigIndexes({
        ...state.config,
        recentWorkspaces: state.config.recentWorkspaces.filter((item) => item.id !== workspaceId),
      })),

  addRootToWorkspace: (workspaceId, rootPath) =>
    set((state) => {
      const workspace = state.workspaceById.get(workspaceId);
      const normalizedRootPath = normalizeWorkspacePath(rootPath);
      if (!workspace || !normalizedRootPath) {
        return state;
      }
      if (workspace.roots.some((root) => normalizeWorkspacePath(root.path) === normalizedRootPath)) {
        return state;
      }

      const nextConfig: AppConfig = {
        ...state.config,
        workspaces: state.config.workspaces.map((item) =>
          item.id === workspaceId
            ? {
                ...item,
                roots: ensureSinglePrimaryRoot([
                  ...item.roots,
                  {
                    id: genId(),
                    name: getPathBaseName(rootPath),
                    path: rootPath,
                    role: 'member',
                  },
                ]),
              }
            : item,
        ),
      };
      return withConfigIndexes(nextConfig);
    }),

  removeRootFromWorkspace: (workspaceId, rootId) =>
    set((state) => {
      const workspace = state.workspaceById.get(workspaceId);
      if (!workspace || workspace.roots.length <= 1) {
        return state;
      }

      removeWorkspaceRootState(workspaceId, rootId);
      const nextConfig: AppConfig = {
        ...state.config,
        workspaces: state.config.workspaces.map((item) =>
          item.id === workspaceId
            ? {
                ...item,
                roots: ensureSinglePrimaryRoot(item.roots.filter((root) => root.id !== rootId)),
                expandedDirsByRoot: Object.fromEntries(
                  Object.entries(item.expandedDirsByRoot ?? {}).filter(([key]) => key !== rootId),
                ),
              }
            : item,
        ),
      };
      return withConfigIndexes(nextConfig);
    }),

  setPrimaryWorkspaceRoot: (workspaceId, rootId) =>
    set((state) => {
      const workspace = state.workspaceById.get(workspaceId);
      if (!workspace || !workspace.roots.some((root) => root.id === rootId)) {
        return state;
      }

      return withConfigIndexes({
        ...state.config,
        workspaces: state.config.workspaces.map((item) =>
          item.id === workspaceId
            ? {
                ...item,
                roots: item.roots.map((root) => ({
                  ...root,
                  role: root.id === rootId ? 'primary' : 'member',
                })),
              }
            : item,
        ),
      });
    }),

  createTerminalTab: async (workspaceId, options) => {
    const workspace = get().workspaceById.get(workspaceId);
    if (!workspace) {
      return null;
    }

    const shell =
      get().config.availableShells.find((item) => item.name === (options?.shellName ?? get().config.defaultShell))
      ?? get().config.availableShells[0];
    const cwd = options?.cwd ?? getWorkspacePrimaryRootPath(workspace);
    if (!shell || !cwd) {
      return null;
    }

    const ptyId = await invoke<number>('create_pty', {
      shell: shell.command,
      args: shell.args ?? [],
      cwd,
    });
    get().upsertSession(createTerminalSessionMeta(shell.name, ptyId, cwd));

    const pane = createTerminalPane(shell.name, ptyId, genId());
    const tab: TerminalTab = {
      kind: 'terminal',
      id: genId(),
      status: 'idle',
      splitLayout: { type: 'leaf', pane },
    };

    set((state) => {
      const workspaceStates = new Map(state.workspaceStates);
      const workspaceState = workspaceStates.get(workspaceId) ?? { id: workspaceId, tabs: [], activeTabId: '' };
      workspaceStates.set(workspaceId, {
        ...workspaceState,
        tabs: [...workspaceState.tabs, tab],
        activeTabId: tab.id,
      });
      const activePaneByTab = new Map(state.activePaneByTab);
      activePaneByTab.set(tab.id, pane.id);
      return {
        activeWorkspaceId: workspaceId,
        activePaneByTab,
        ...buildWorkspaceStatePatch(workspaceStates, state.paneRuntimeByPty, activePaneByTab),
      };
    });

    saveLayoutToConfig(workspaceId);
    return tab.id;
  },

  addTab: (workspaceId, tab) =>
    set((state) => {
      const workspaceStates = new Map(state.workspaceStates);
      const workspaceState = workspaceStates.get(workspaceId);
      if (!workspaceState) {
        return state;
      }
      workspaceStates.set(workspaceId, {
        ...workspaceState,
        tabs: [...workspaceState.tabs, tab],
        activeTabId: tab.id,
      });
      return buildWorkspaceStatePatch(workspaceStates, state.paneRuntimeByPty, state.activePaneByTab);
    }),

  removeTab: (workspaceId, tabId) =>
    set((state) => {
      const workspaceStates = new Map(state.workspaceStates);
      const workspaceState = workspaceStates.get(workspaceId);
      if (!workspaceState) {
        return state;
      }

      const removedTab = workspaceState.tabs.find((tab) => tab.id === tabId);
      const removedPtyIds = removedTab && isTerminalTab(removedTab) ? collectPtyIds(removedTab.splitLayout) : [];
      const newTabs = workspaceState.tabs.filter((tab) => tab.id !== tabId);
      const nextActiveTabId =
        workspaceState.activeTabId === tabId ? (newTabs[newTabs.length - 1]?.id ?? '') : workspaceState.activeTabId;
      workspaceStates.set(workspaceId, {
        ...workspaceState,
        tabs: newTabs,
        activeTabId: nextActiveTabId,
      });

      const sessions = new Map(state.sessions);
      removedPtyIds.forEach((ptyId) => sessions.delete(ptyId));

      const activePaneByTab = new Map(state.activePaneByTab);
      activePaneByTab.delete(tabId);

      return {
        sessions,
        activePaneByTab,
        ...buildWorkspaceStatePatch(workspaceStates, state.paneRuntimeByPty, activePaneByTab),
      };
    }),

  setActiveTab: (workspaceId, tabId) =>
    set((state) => {
      const workspaceStates = new Map(state.workspaceStates);
      const workspaceState = workspaceStates.get(workspaceId);
      if (!workspaceState) {
        return state;
      }
      workspaceStates.set(workspaceId, {
        ...workspaceState,
        activeTabId: tabId,
      });
      return { workspaceStates };
    }),

  setTabCustomTitle: (workspaceId, tabId, customTitle) =>
    set((state) => {
      const workspaceStates = new Map(state.workspaceStates);
      const workspaceState = workspaceStates.get(workspaceId);
      if (!workspaceState) {
        return state;
      }
      workspaceStates.set(workspaceId, {
        ...workspaceState,
        tabs: workspaceState.tabs.map((tab) =>
          tab.id === tabId && isTerminalTab(tab)
            ? { ...tab, customTitle: customTitle?.trim() ? customTitle.trim() : undefined }
            : tab,
        ),
      });
      return { workspaceStates };
    }),

  updateTabLayout: (workspaceId, tabId, layout) =>
    set((state) => {
      const workspaceStates = new Map(state.workspaceStates);
      const workspaceState = workspaceStates.get(workspaceId);
      if (!workspaceState) {
        return state;
      }
      workspaceStates.set(workspaceId, {
        ...workspaceState,
        tabs: workspaceState.tabs.map((tab) =>
          tab.id === tabId && isTerminalTab(tab) ? { ...tab, splitLayout: layout } : tab,
        ),
      });
      return buildWorkspaceStatePatch(workspaceStates, state.paneRuntimeByPty, state.activePaneByTab);
    }),

  updatePaneStatusByPty: (ptyId, status) =>
    set((state) => {
      const existingRuntime = state.paneRuntimeByPty.get(ptyId);
      if (!existingRuntime || existingRuntime.status === status) {
        return state;
      }

      const paneRuntimeByPty = new Map(state.paneRuntimeByPty);
      paneRuntimeByPty.set(ptyId, {
        ...existingRuntime,
        status,
      });

      const tabRuntimeAggregate = new Map(state.tabRuntimeAggregate);
      tabRuntimeAggregate.set(
        existingRuntime.tabId,
        getHighestStatusFromEntries(
          [...paneRuntimeByPty.values()].filter((runtime) => runtime.tabId === existingRuntime.tabId),
        ),
      );

      return { paneRuntimeByPty, tabRuntimeAggregate };
    }),

  updatePaneStatusesByPty: (updates) =>
    set((state) => {
      if (updates.length === 0) {
        return state;
      }

      const paneRuntimeByPty = new Map(state.paneRuntimeByPty);
      const updatedTabs = new Set<string>();
      let changed = false;

      for (const update of updates) {
        const existingRuntime = paneRuntimeByPty.get(update.ptyId);
        if (!existingRuntime || existingRuntime.status === update.status) {
          continue;
        }

        paneRuntimeByPty.set(update.ptyId, {
          ...existingRuntime,
          status: update.status,
        });
        updatedTabs.add(existingRuntime.tabId);
        changed = true;
      }

      if (!changed) {
        return state;
      }

      const tabRuntimeAggregate = new Map(state.tabRuntimeAggregate);
      for (const tabId of updatedTabs) {
        tabRuntimeAggregate.set(
          tabId,
          getHighestStatusFromEntries(
            [...paneRuntimeByPty.values()].filter((runtime) => runtime.tabId === tabId),
          ),
        );
      }
      return { paneRuntimeByPty, tabRuntimeAggregate };
    }),

  recordWorkspaceFsChanges: (rootPath, changes) =>
    set((state) => {
      const normalizedRootPath = normalizeWorkspacePath(rootPath);
      const workspaceExplorerRuntime = new Map(state.workspaceExplorerRuntime);
      const current = workspaceExplorerRuntime.get(normalizedRootPath) ?? createExplorerRuntimeState();
      workspaceExplorerRuntime.set(normalizedRootPath, {
        ...current,
        dirtyPaths: Array.from(new Set([...current.dirtyPaths, ...changes.map((change) => change.path)])).slice(-200),
        lastFsChangeAt: Date.now(),
      });
      return { workspaceExplorerRuntime };
    }),

  markWorkspaceGitDirty: (rootPath) =>
    set((state) => {
      const normalizedRootPath = normalizeWorkspacePath(rootPath);
      const workspaceExplorerRuntime = new Map(state.workspaceExplorerRuntime);
      const current = workspaceExplorerRuntime.get(normalizedRootPath) ?? createExplorerRuntimeState();
      workspaceExplorerRuntime.set(normalizedRootPath, {
        ...current,
        dirtyPaths: [],
        lastGitDirtyAt: Date.now(),
        gitDirtyToken: current.gitDirtyToken + 1,
      });
      return { workspaceExplorerRuntime };
    }),

  openSettings: (page = 'terminal') =>
    set({
      ui: {
        activeDialog: {
          kind: 'settings',
          page,
        },
      },
    }),

  openFileViewer: (workspaceId, filePath, options) =>
    set((state) => {
      const workspaceState = state.workspaceStates.get(workspaceId);
      if (!workspaceState) {
        return state;
      }
      const nextMode = normalizeFileViewerMode(filePath, options?.initialMode);
      const existing = workspaceState.tabs.find((tab) => tab.kind === 'file-viewer' && tab.filePath === filePath);
      const workspaceStates = new Map(state.workspaceStates);

      if (existing) {
        workspaceStates.set(workspaceId, {
          ...workspaceState,
          activeTabId: existing.id,
          tabs: workspaceState.tabs.map((tab) =>
            tab.id === existing.id && tab.kind === 'file-viewer' ? { ...tab, mode: nextMode } : tab,
          ),
        });
      } else {
        const tab: WorkspaceTab = {
          kind: 'file-viewer',
          id: genId(),
          filePath,
          mode: nextMode,
          status: 'idle',
        };
        workspaceStates.set(workspaceId, {
          ...workspaceState,
          tabs: [...workspaceState.tabs, tab],
          activeTabId: tab.id,
        });
      }

      return buildWorkspaceStatePatch(workspaceStates, state.paneRuntimeByPty, state.activePaneByTab);
    }),

  setFileViewerTabMode: (workspaceId, tabId, mode) =>
    set((state) => {
      const workspaceState = state.workspaceStates.get(workspaceId);
      if (!workspaceState) {
        return state;
      }

      let changed = false;
      const tabs = workspaceState.tabs.map((tab) => {
        if (tab.id !== tabId || tab.kind !== 'file-viewer') {
          return tab;
        }
        const nextMode = normalizeFileViewerMode(tab.filePath, mode);
        if (tab.mode === nextMode) {
          return tab;
        }
        changed = true;
        return { ...tab, mode: nextMode };
      });

      if (!changed) {
        return state;
      }

      const workspaceStates = new Map(state.workspaceStates);
      workspaceStates.set(workspaceId, { ...workspaceState, tabs });
      return buildWorkspaceStatePatch(workspaceStates, state.paneRuntimeByPty, state.activePaneByTab);
    }),

  openInteractionDialog: (payload) =>
    set({
      ui: {
        activeDialog: {
          kind: 'interaction-dialog',
          ...payload,
        },
      },
    }),

  openWorktreeDiff: (workspaceId, projectPath, status) =>
    set((state) => {
      const workspaceState = state.workspaceStates.get(workspaceId);
      if (!workspaceState) {
        return state;
      }
      const existing = workspaceState.tabs.find(
        (tab) => tab.kind === 'worktree-diff' && tab.projectPath === projectPath && tab.status.path === status.path,
      );
      const workspaceStates = new Map(state.workspaceStates);

      if (existing) {
        workspaceStates.set(workspaceId, {
          ...workspaceState,
          activeTabId: existing.id,
          tabs: workspaceState.tabs.map((tab) =>
            tab.id === existing.id && tab.kind === 'worktree-diff' ? { ...tab, status } : tab,
          ),
        });
      } else {
        const tab: WorkspaceTab = {
          kind: 'worktree-diff',
          id: genId(),
          projectPath,
          status,
        };
        workspaceStates.set(workspaceId, {
          ...workspaceState,
          tabs: [...workspaceState.tabs, tab],
          activeTabId: tab.id,
        });
      }

      return buildWorkspaceStatePatch(workspaceStates, state.paneRuntimeByPty, state.activePaneByTab);
    }),

  openCommitDiff: ({ workspaceId, repoPath, commitHash, commitMessage, files }) =>
    set((state) => {
      const workspaceState = state.workspaceStates.get(workspaceId);
      if (!workspaceState) {
        return state;
      }
      const existing = workspaceState.tabs.find(
        (tab) => tab.kind === 'commit-diff' && tab.repoPath === repoPath && tab.commitHash === commitHash,
      );
      const workspaceStates = new Map(state.workspaceStates);

      if (existing) {
        workspaceStates.set(workspaceId, {
          ...workspaceState,
          activeTabId: existing.id,
          tabs: workspaceState.tabs.map((tab) =>
            tab.id === existing.id && tab.kind === 'commit-diff'
              ? { ...tab, commitMessage, files }
              : tab,
          ),
        });
      } else {
        const tab: WorkspaceTab = {
          kind: 'commit-diff',
          id: genId(),
          repoPath,
          commitHash,
          commitMessage,
          files,
        };
        workspaceStates.set(workspaceId, {
          ...workspaceState,
          tabs: [...workspaceState.tabs, tab],
          activeTabId: tab.id,
        });
      }

      return buildWorkspaceStatePatch(workspaceStates, state.paneRuntimeByPty, state.activePaneByTab);
    }),

  closeDialog: () =>
    set({
      ui: {
        activeDialog: null,
      },
    }),
}));

export const selectProjectState = selectWorkspaceState;
export const selectProjects = selectWorkspaces;
export const selectProjectGitDirtyToken = selectWorkspaceGitDirtyToken;
export const selectProjectPath =
  (workspaceId: string) =>
  (state: AppStore): string | undefined =>
    getWorkspacePrimaryRootPath(state.workspaceById.get(workspaceId));
