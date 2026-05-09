import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { getDefaultThemeConfig } from './theme';
import {
  createTerminalPane,
  getSavedRunCommand,
  normalizeRunProfile,
} from './utils/session';
import { closeTerminalSession, createTerminalSession } from './runtime/terminalApi';
import { mapCreatedTerminalSession } from './runtime/terminalSessionMeta';
import {
  buildRecentWorkspaceEntry,
  createWorkspaceConfig,
  ensureSinglePrimaryRoot,
  getPathBaseName,
  getWorkspacePrimaryRoot,
  getWorkspaceLookupByRootPath,
  getWorkspacePrimaryRootPath,
  normalizeWorkspacePath,
  restoreWorkspaceFromRecent,
} from './utils/workspace';
import type {
  AgentTaskPanelFilter,
  AgentTaskPanelPaneState,
  AgentTaskPanelTab,
  AppConfig,
  CommandBlock,
  CommitDiffPaneState,
  CommitFileInfo,
  FileNavigationTarget,
  FileViewerOpenOptions,
  FileViewerPaneState,
  FileHistoryPaneState,
  GitFileStatus,
  LegacyProjectConfig,
  PaneState,
  PaneRuntimeState,
  PaneStatus,
  PreviewMode,
  RunProfile,
  SavedProjectLayout,
  ShellConfig,
  SavedSplitNode,
  SavedTab,
  SessionPhase,
  SettingsPage,
  SplitNode,
  TerminalSessionMeta,
  TerminalSessionState,
  TerminalTab,
  TerminalUiState,
  TerminalViewState,
  WorktreeDiffPaneState,
  WorkspacePane,
  UiDialog,
  UiNoticeTone,
  WorkspaceConfig,
  WorkspaceExplorerRuntime,
  WorkspaceState,
  WorkspaceTab,
} from './types';
import { createEmptyCompletionUsage, recordCompletionUsage } from './utils/terminalCompletion/usage';
import { normalizePreviewModeForFile } from './utils/documentPreview';
import { areSplitNodesEquivalent } from './utils/splitLayout';
import { disposeTerminalBySession } from './utils/terminalCache';
import { extractPane, findPane, insertNodeAtPane, insertSplit } from './components/terminal/splitTree';
import {
  createDefaultAgentBackendsConfig,
  createDefaultExternalMcpInteropConfig,
} from './runtime/tauriRuntime';

let idCounter = 0;
export const genId = () => `id-${Date.now()}-${++idCounter}`;

// 文件系统变更追踪上限，防止内存膨胀
const DIRTY_PATHS_MAX = 200;

const STATUS_PRIORITY: Record<PaneStatus, number> = {
  error: 3,
  'ai-working': 2,
  'ai-idle': 1,
  idle: 0,
};

export interface PtyPaneIndexEntry {
  projectId: string;
  tabId: string;
  paneId: string;
}

function legacyProjectToWorkspace(project: LegacyProjectConfig): WorkspaceConfig {
  const workspace = createWorkspaceConfig({
    id: project.id,
    name: project.name,
    paths: [project.path],
    savedLayout: project.savedLayout,
  });

  const primaryRoot = workspace.roots[0];
  return {
    ...workspace,
    expandedDirsByRoot: primaryRoot
      ? {
          [primaryRoot.id]: project.expandedDirs ?? [],
        }
      : {},
  };
}

function workspaceToLegacyProject(workspace: WorkspaceConfig): LegacyProjectConfig {
  const primaryRoot = getWorkspacePrimaryRoot(workspace) ?? workspace.roots[0];
  return {
    id: workspace.id,
    name: workspace.name,
    path: primaryRoot?.path ?? '',
    savedLayout: workspace.savedLayout,
    expandedDirs: primaryRoot ? workspace.expandedDirsByRoot?.[primaryRoot.id] ?? [] : [],
  };
}

function getConfigWorkspaces(config: AppConfig): WorkspaceConfig[] {
  if (config.workspaces.length > 0) {
    return config.workspaces;
  }
  return (config.projects ?? []).map(legacyProjectToWorkspace);
}

function buildConfigIndexes(workspaces: WorkspaceConfig[]) {
  return {
    workspaceById: new Map(workspaces.map((workspace) => [workspace.id, workspace])),
    workspaceIdByRootPath: getWorkspaceLookupByRootPath(workspaces),
  };
}

function withConfigIndexes(config: AppConfig) {
  const normalizedConfig = normalizeWorkspaceStoreConfig(config);
  return {
    config: normalizedConfig,
    ...buildConfigIndexes(normalizedConfig.workspaces),
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

function isTerminalPane(pane: WorkspacePane): pane is PaneState {
  return pane.kind === 'terminal';
}

function isAgentTaskPanelTab(tab: WorkspaceTab): tab is AgentTaskPanelTab {
  return tab.kind === 'agent-tasks';
}

function createFileViewerPane(filePath: string, options?: FileViewerOpenOptions): FileViewerPaneState {
  return {
    kind: 'file-viewer',
    id: genId(),
    filePath,
    mode: normalizeFileViewerMode(filePath, options?.initialMode),
    ...(options?.navigationTarget ? { navigationTarget: options.navigationTarget } : {}),
    status: 'idle',
  };
}

function createWorktreeDiffPane(projectPath: string, gitStatus: GitFileStatus): WorktreeDiffPaneState {
  return {
    kind: 'worktree-diff',
    id: genId(),
    projectPath,
    gitStatus,
    status: 'idle',
  };
}

function createCommitDiffPane(
  repoPath: string,
  commitHash: string,
  commitMessage: string,
  files: CommitFileInfo[],
): CommitDiffPaneState {
  return {
    kind: 'commit-diff',
    id: genId(),
    repoPath,
    commitHash,
    commitMessage,
    files,
    status: 'idle',
  };
}

function createFileHistoryPane(projectPath: string, filePath: string): FileHistoryPaneState {
  return {
    kind: 'file-history',
    id: genId(),
    projectPath,
    filePath,
    status: 'idle',
  };
}

function createAgentTaskPanelPane(options?: {
  selectedTaskId?: string;
  scope?: AgentTaskPanelFilter['scope'];
}): AgentTaskPanelPaneState {
  return {
    kind: 'agent-tasks',
    id: genId(),
    selectedTaskId: options?.selectedTaskId,
    filter: {
      scope: options?.scope ?? 'workspace',
      attention: 'all',
      target: 'all',
    },
    status: 'idle',
  };
}

function normalizeFileViewerMode(filePath: string, mode?: PreviewMode): PreviewMode {
  return normalizePreviewModeForFile(filePath, mode);
}

function normalizePathIdentity(path: string): string {
  const normalized = normalizeWorkspacePath(path);
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized;
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

function updatePaneRunProfile(node: SplitNode, paneId: string, runProfile?: RunProfile): SplitNode {
  if (node.type === 'leaf') {
    const pane = node.pane;
    if (pane.id !== paneId || !isTerminalPane(pane)) {
      return node;
    }
    const nextRunProfile = normalizeRunProfile(runProfile, pane.runCommand);
    const nextRunCommand = nextRunProfile?.savedCommand;
    if (
      pane.runCommand === nextRunCommand
      && JSON.stringify(pane.runProfile ?? null) === JSON.stringify(nextRunProfile ?? null)
    ) {
      return node;
    }
    return {
      ...node,
      pane: {
        ...pane,
        runCommand: nextRunCommand,
        runProfile: nextRunProfile,
      },
    };
  }

  let changed = false;
  const children = node.children.map((child) => {
    const nextChild = updatePaneRunProfile(child, paneId, runProfile);
    if (nextChild !== child) {
      changed = true;
    }
    return nextChild;
  });

  return changed ? { ...node, children } : node;
}

function updatePaneSessionBinding(
  node: SplitNode,
  paneId: string,
  binding: Pick<TerminalSessionMeta, 'sessionId' | 'ptyId'> & Partial<Pick<TerminalSessionMeta, 'phase'>>,
): SplitNode {
  if (node.type === 'leaf') {
    const pane = node.pane;
    if (pane.id !== paneId || !isTerminalPane(pane)) {
      return node;
    }

    if (
      pane.sessionId === binding.sessionId
      && pane.ptyId === binding.ptyId
      && (!binding.phase || pane.phase === binding.phase)
    ) {
      return node;
    }

    return {
      ...node,
      pane: {
        ...pane,
        sessionId: binding.sessionId,
        ptyId: binding.ptyId,
        phase: binding.phase ?? pane.phase,
      },
    };
  }

  let changed = false;
  const children = node.children.map((child) => {
    const nextChild = updatePaneSessionBinding(child, paneId, binding);
    if (nextChild !== child) {
      changed = true;
    }
    return nextChild;
  });

  return changed ? { ...node, children } : node;
}

function updateWorkspacePane(
  node: SplitNode,
  paneId: string,
  updater: (pane: WorkspacePane) => WorkspacePane,
): SplitNode {
  if (node.type === 'leaf') {
    if (node.pane.id !== paneId) {
      return node;
    }
    const nextPane = updater(node.pane);
    return nextPane === node.pane ? node : { ...node, pane: nextPane };
  }

  let changed = false;
  const children = node.children.map((child) => {
    const nextChild = updateWorkspacePane(child, paneId, updater);
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
    if (!isTerminalPane(node.pane)) {
      return;
    }
    ptyToPaneIndex.set(node.pane.ptyId, {
      projectId: workspaceId,
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
    projectStates: workspaceStates,
    ...rebuildWorkspaceIndexes(workspaceStates, existingPaneRuntime, activePaneByTab),
  };
}

export const buildProjectStatePatch = buildWorkspaceStatePatch;

function buildExplorerRuntimePatch(workspaceExplorerRuntime: Map<string, WorkspaceExplorerRuntime>) {
  return {
    workspaceExplorerRuntime,
    projectExplorerRuntime: workspaceExplorerRuntime,
  };
}

export function collectPtyIds(node: SplitNode): number[] {
  if (node.type === 'leaf') {
    return isTerminalPane(node.pane) ? [node.pane.ptyId] : [];
  }
  return node.children.flatMap(collectPtyIds);
}

export function collectPaneBindings(node: SplitNode): Array<{ ptyId: number; sessionId: string }> {
  if (node.type === 'leaf') {
    return isTerminalPane(node.pane) ? [{ ptyId: node.pane.ptyId, sessionId: node.pane.sessionId }] : [];
  }
  return node.children.flatMap(collectPaneBindings);
}

function collectWorkspacePanes(node: SplitNode): WorkspacePane[] {
  if (node.type === 'leaf') {
    return [node.pane];
  }
  return node.children.flatMap(collectWorkspacePanes);
}

function createCanvasTabFromPane(pane: WorkspacePane, id: string = genId()): TerminalTab {
  return {
    kind: 'terminal',
    id,
    status: pane.status,
    splitLayout: {
      type: 'leaf',
      pane,
    },
  };
}

function getFirstPane(node: SplitNode): WorkspacePane {
  return node.type === 'leaf' ? node.pane : getFirstPane(node.children[0]);
}

function getFirstPaneId(node: SplitNode): string {
  return getFirstPane(node).id;
}

function resolvePreferredPaneId(node: SplitNode, preferredPaneId?: string): string {
  return preferredPaneId && findPane(node, preferredPaneId) ? preferredPaneId : getFirstPaneId(node);
}

function paneFromLegacyTab(tab: Exclude<WorkspaceTab, TerminalTab>): WorkspacePane {
  switch (tab.kind) {
    case 'file-viewer':
      return {
        kind: 'file-viewer',
        id: genId(),
        filePath: tab.filePath,
        mode: tab.mode,
        navigationTarget: tab.navigationTarget,
        status: tab.status,
      };
    case 'worktree-diff':
      return createWorktreeDiffPane(tab.projectPath, tab.status);
    case 'commit-diff':
      return createCommitDiffPane(tab.repoPath, tab.commitHash, tab.commitMessage, tab.files);
    case 'file-history':
      return createFileHistoryPane(tab.projectPath, tab.filePath);
    case 'agent-tasks':
      return {
        kind: 'agent-tasks',
        id: genId(),
        filter: tab.filter,
        selectedTaskId: tab.selectedTaskId,
        status: tab.status,
      };
  }
}

function nodeFromWorkspaceTab(tab: WorkspaceTab): SplitNode {
  return isTerminalTab(tab)
    ? tab.splitLayout
    : {
        type: 'leaf',
        pane: paneFromLegacyTab(tab),
      };
}

function findPaneLocation(
  workspaceState: WorkspaceState,
  predicate: (pane: WorkspacePane) => boolean,
): { tabId: string; paneId: string } | null {
  for (const tab of workspaceState.tabs) {
    if (!isTerminalTab(tab)) {
      continue;
    }

    const pane = collectWorkspacePanes(tab.splitLayout).find(predicate);
    if (pane) {
      return { tabId: tab.id, paneId: pane.id };
    }
  }

  return null;
}

function insertPaneIntoTabLayout(layout: SplitNode, targetPaneId: string, pane: WorkspacePane): SplitNode {
  return insertSplit(layout, targetPaneId, 'vertical', pane);
}

function insertPaneIntoWorkspaceState(
  workspaceState: WorkspaceState,
  activePaneByTab: Map<string, string>,
  pane: WorkspacePane,
): { nextWorkspaceState: WorkspaceState; nextActivePaneByTab: Map<string, string>; tabId: string } {
  const activeTab = workspaceState.tabs.find((tab) => tab.id === workspaceState.activeTabId);
  const nextActivePaneByTab = new Map(activePaneByTab);

  if (!activeTab) {
    const tab = createCanvasTabFromPane(pane);
    nextActivePaneByTab.set(tab.id, pane.id);
    return {
      nextWorkspaceState: {
        ...workspaceState,
        tabs: [...workspaceState.tabs, tab],
        activeTabId: tab.id,
      },
      nextActivePaneByTab,
      tabId: tab.id,
    };
  }

  if (isTerminalTab(activeTab)) {
    const targetPaneId = nextActivePaneByTab.get(activeTab.id) ?? getFirstPaneId(activeTab.splitLayout);
    const nextLayout = insertPaneIntoTabLayout(activeTab.splitLayout, targetPaneId, pane);
    nextActivePaneByTab.set(activeTab.id, pane.id);
    return {
      nextWorkspaceState: {
        ...workspaceState,
        activeTabId: activeTab.id,
        tabs: workspaceState.tabs.map((tab) =>
          tab.id === activeTab.id && isTerminalTab(tab)
            ? { ...tab, splitLayout: nextLayout }
            : tab,
        ),
      },
      nextActivePaneByTab,
      tabId: activeTab.id,
    };
  }

  const sourcePane = paneFromLegacyTab(activeTab);
  const canvasTab = createCanvasTabFromPane(sourcePane, activeTab.id);
  const nextLayout = insertPaneIntoTabLayout(canvasTab.splitLayout, sourcePane.id, pane);
  nextActivePaneByTab.set(activeTab.id, pane.id);
  return {
    nextWorkspaceState: {
      ...workspaceState,
      activeTabId: activeTab.id,
      tabs: workspaceState.tabs.map((tab) =>
        tab.id === activeTab.id
          ? { ...canvasTab, splitLayout: nextLayout }
          : tab,
      ),
    },
    nextActivePaneByTab,
    tabId: activeTab.id,
  };
}

function updatePaneLocationInWorkspaceState(
  workspaceState: WorkspaceState,
  location: { tabId: string; paneId: string },
  updater: (pane: WorkspacePane) => WorkspacePane,
): WorkspaceState {
  const tabs = workspaceState.tabs.map((tab) => {
    if (tab.id !== location.tabId || !isTerminalTab(tab)) {
      return tab;
    }

    const nextLayout = updateWorkspacePane(tab.splitLayout, location.paneId, updater);
    return nextLayout === tab.splitLayout ? tab : { ...tab, splitLayout: nextLayout };
  });

  return {
    ...workspaceState,
    activeTabId: location.tabId,
    tabs,
  };
}

function insertNodeIntoWorkspaceTab(
  tab: WorkspaceTab,
  targetPaneId: string | undefined,
  node: SplitNode,
  direction: 'horizontal' | 'vertical',
  position: 'before' | 'after',
): WorkspaceTab | null {
  if (isTerminalTab(tab)) {
    if (!targetPaneId || !findPane(tab.splitLayout, targetPaneId)) {
      return null;
    }

    const nextLayout = insertNodeAtPane(tab.splitLayout, targetPaneId, direction, node, position);
    return nextLayout === tab.splitLayout ? null : { ...tab, splitLayout: nextLayout };
  }

  const targetPane = paneFromLegacyTab(tab);
  const nextLayout = insertNodeAtPane(
    { type: 'leaf', pane: targetPane },
    targetPane.id,
    direction,
    node,
    position,
  );
  return {
    kind: 'terminal',
    id: tab.id,
    status: 'idle',
    splitLayout: nextLayout,
  };
}

function buildWorkspaceMutationPatch(
  state: AppStore,
  workspaceStates: Map<string, WorkspaceState>,
  activePaneByTab: Map<string, string>,
  removedPtyIds: number[],
) {
  const referencedPtyIds = collectReferencedPtyIds(workspaceStates);
  let sessionStatePatch: SessionMapState = {
    sessions: state.sessions,
    terminalSessions: state.terminalSessions,
    sessionIdByPty: state.sessionIdByPty,
    ptyBySessionId: state.ptyBySessionId,
  };

  removedPtyIds.forEach((ptyId) => {
    if (referencedPtyIds.has(ptyId)) {
      return;
    }
    sessionStatePatch = removeSessionStatePatch(sessionStatePatch, { ptyId });
  });

  return {
    ...sessionStatePatch,
    activePaneByTab,
    ...buildWorkspaceStatePatch(workspaceStates, state.paneRuntimeByPty, activePaneByTab),
  };
}

function moveWorkspaceTabList(
  tabs: WorkspaceTab[],
  sourceTabId: string,
  targetTabId: string,
  position: 'before' | 'after',
) {
  const sourceIndex = tabs.findIndex((tab) => tab.id === sourceTabId);
  const targetIndex = tabs.findIndex((tab) => tab.id === targetTabId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
    return null;
  }

  const nextTabs = [...tabs];
  const [movedTab] = nextTabs.splice(sourceIndex, 1);
  const nextTargetIndex = nextTabs.findIndex((tab) => tab.id === targetTabId);
  if (nextTargetIndex < 0) {
    return null;
  }

  const insertIndex = position === 'before' ? nextTargetIndex : nextTargetIndex + 1;
  nextTabs.splice(insertIndex, 0, movedTab);

  const unchanged = nextTabs.every((tab, index) => tab.id === tabs[index]?.id);
  return unchanged ? null : nextTabs;
}

function insertWorkspaceTabRelative(
  tabs: WorkspaceTab[],
  targetTabId: string,
  tab: WorkspaceTab,
  position: 'before' | 'after',
) {
  const targetIndex = tabs.findIndex((item) => item.id === targetTabId);
  if (targetIndex < 0) {
    return null;
  }

  const nextTabs = [...tabs];
  const insertIndex = position === 'before' ? targetIndex : targetIndex + 1;
  nextTabs.splice(insertIndex, 0, tab);
  return nextTabs;
}

function collectReferencedPtyIds(workspaceStates: Map<string, WorkspaceState>) {
  const referenced = new Set<number>();

  for (const workspaceState of workspaceStates.values()) {
    for (const tab of workspaceState.tabs) {
      if (!isTerminalTab(tab)) {
        continue;
      }

      for (const ptyId of collectPtyIds(tab.splitLayout)) {
        referenced.add(ptyId);
      }
    }
  }

  return referenced;
}

async function openTerminalPane(
  shell: ShellConfig,
  cwd: string,
  options?: {
    mode?: TerminalSessionMeta['mode'];
    runCommand?: string;
    runProfile?: RunProfile;
  },
): Promise<SplitNode | null> {
  try {
    const payload = await createTerminalSession({
      shell: shell.command,
      args: shell.args ?? [],
      cwd,
      mode: options?.mode,
    });
    useAppStore.getState().upsertSession(mapCreatedTerminalSession(payload));

    return {
      type: 'leaf',
      pane: createTerminalPane(
        shell.name,
        payload.ptyId,
        genId(),
        options?.mode ?? 'human',
        options?.runCommand,
        options?.runProfile,
        payload.sessionId,
      ),
    };
  } catch {
    return null;
  }
}

function serializeSplitNode(node: SplitNode): SavedSplitNode {
  if (node.type === 'leaf') {
    const pane = node.pane;
    if (isTerminalPane(pane)) {
      return {
        type: 'leaf',
        pane: {
          kind: 'terminal',
          shellName: pane.shellName,
          runCommand: pane.runCommand,
          runProfile: pane.runProfile,
        },
      };
    }

    switch (pane.kind) {
      case 'file-viewer':
        return {
          type: 'leaf',
          pane: {
            kind: 'file-viewer',
            filePath: pane.filePath,
            mode: pane.mode,
            ...(pane.navigationTarget ? { navigationTarget: pane.navigationTarget } : {}),
          },
        };
      case 'worktree-diff':
        return {
          type: 'leaf',
          pane: {
            kind: 'worktree-diff',
            projectPath: pane.projectPath,
            gitStatus: pane.gitStatus,
          },
        };
      case 'commit-diff':
        return {
          type: 'leaf',
          pane: {
            kind: 'commit-diff',
            repoPath: pane.repoPath,
            commitHash: pane.commitHash,
            commitMessage: pane.commitMessage,
            files: pane.files,
          },
        };
      case 'file-history':
        return {
          type: 'leaf',
          pane: {
            kind: 'file-history',
            projectPath: pane.projectPath,
            filePath: pane.filePath,
          },
        };
      case 'agent-tasks':
        return {
          type: 'leaf',
          pane: {
            kind: 'agent-tasks',
            filter: pane.filter,
            ...(pane.selectedTaskId ? { selectedTaskId: pane.selectedTaskId } : {}),
          },
        };
    }
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
    const savedPane = saved.pane;
    const paneKind = savedPane.kind ?? 'terminal';
    switch (paneKind) {
      case 'terminal': {
        const terminalPane = savedPane as Extract<SavedSplitNode, { type: 'leaf' }>['pane'] & {
          shellName: string;
          runCommand?: string;
          runProfile?: RunProfile;
        };
        const shell =
          config.availableShells.find((item) => item.name === terminalPane.shellName)
          ?? config.availableShells.find((item) => item.name === config.defaultShell)
          ?? config.availableShells[0];
        if (!shell) {
          return null;
        }

        return openTerminalPane(shell, cwd, {
          runCommand: getSavedRunCommand(terminalPane.runProfile, terminalPane.runCommand),
          runProfile: normalizeRunProfile(terminalPane.runProfile, terminalPane.runCommand),
        });
      }
      case 'file-viewer': {
        const fileViewerPane = savedPane as {
          filePath: string;
          mode?: PreviewMode;
          navigationTarget?: FileNavigationTarget;
        };
        return {
          type: 'leaf',
          pane: {
            kind: 'file-viewer',
            id: genId(),
            filePath: fileViewerPane.filePath,
            mode: normalizeFileViewerMode(fileViewerPane.filePath, fileViewerPane.mode),
            ...(fileViewerPane.navigationTarget ? { navigationTarget: fileViewerPane.navigationTarget } : {}),
            status: 'idle',
          },
        };
      }
      case 'worktree-diff': {
        const worktreeDiffPane = savedPane as {
          projectPath: string;
          gitStatus: GitFileStatus;
        };
        return {
          type: 'leaf',
          pane: createWorktreeDiffPane(worktreeDiffPane.projectPath, worktreeDiffPane.gitStatus),
        };
      }
      case 'commit-diff': {
        const commitDiffPane = savedPane as {
          repoPath: string;
          commitHash: string;
          commitMessage: string;
          files: CommitFileInfo[];
        };
        return {
          type: 'leaf',
          pane: createCommitDiffPane(
            commitDiffPane.repoPath,
            commitDiffPane.commitHash,
            commitDiffPane.commitMessage,
            commitDiffPane.files,
          ),
        };
      }
      case 'file-history': {
        const fileHistoryPane = savedPane as {
          projectPath: string;
          filePath: string;
        };
        return {
          type: 'leaf',
          pane: createFileHistoryPane(fileHistoryPane.projectPath, fileHistoryPane.filePath),
        };
      }
      case 'agent-tasks': {
        const tasksPane = savedPane as {
          filter: AgentTaskPanelFilter;
          selectedTaskId?: string;
        };
        return {
          type: 'leaf',
          pane: {
            ...createAgentTaskPanelPane({ scope: tasksPane.filter.scope }),
            filter: tasksPane.filter,
            selectedTaskId: tasksPane.selectedTaskId,
          },
        };
      }
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

  const normalizedConfig = normalizeWorkspaceStoreConfig(nextConfig);
  useAppStore.getState().setConfig(normalizedConfig);
  void invoke('save_config', { config: normalizedConfig });
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

  const normalizedConfig = normalizeWorkspaceStoreConfig(nextConfig);
  useAppStore.getState().setConfig(normalizedConfig);
  void invoke('save_config', { config: normalizedConfig });
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

function insertItemAfter<T>(items: T[], targetIndex: number, item: T) {
  return [...items.slice(0, targetIndex + 1), item, ...items.slice(targetIndex + 1)];
}

function buildWorkspacePathSignature(paths: string[]) {
  return [...new Set(paths.map(normalizeWorkspacePath).filter(Boolean))].sort().join('::');
}

function cloneWorkspaceConfig(
  workspace: WorkspaceConfig,
  nextWorkspaceId: string,
  name: string,
  savedLayout: SavedProjectLayout | undefined,
): WorkspaceConfig {
  const rootIdMap = new Map<string, string>();
  const roots = workspace.roots.map((root, index) => {
    const nextRootId = `${nextWorkspaceId}-root-${index + 1}`;
    rootIdMap.set(root.id, nextRootId);
    return {
      ...root,
      id: nextRootId,
    };
  });

  return {
    ...workspace,
    id: nextWorkspaceId,
    name,
    roots,
    savedLayout,
    expandedDirsByRoot: Object.fromEntries(
      Object.entries(workspace.expandedDirsByRoot ?? {}).flatMap(([rootId, dirs]) => {
        const nextRootId = rootIdMap.get(rootId);
        return nextRootId ? [[nextRootId, [...dirs]]] : [];
      }),
    ),
    createdAt: Date.now(),
    lastOpenedAt: Date.now(),
  };
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
  const defaultAgentBackends = createDefaultAgentBackendsConfig();
  const currentAgentBackends = config.agentBackends;
  const workspaces = getConfigWorkspaces(config).map((workspace) => ({
    ...workspace,
    roots: ensureSinglePrimaryRoot(workspace.roots),
    expandedDirsByRoot: workspace.expandedDirsByRoot ?? {},
    pinned: workspace.pinned ?? false,
    createdAt: workspace.createdAt ?? now,
    lastOpenedAt: workspace.lastOpenedAt ?? now,
  }));

  return {
    ...config,
    workspaces,
    projects: workspaces.map(workspaceToLegacyProject),
    recentWorkspaces: config.recentWorkspaces ?? [],
    lastWorkspaceId: config.lastWorkspaceId ?? workspaces[0]?.id,
    completionUsage: config.completionUsage ?? createEmptyCompletionUsage(),
    agentBackends: {
      ...defaultAgentBackends,
      ...currentAgentBackends,
      routing: {
        ...defaultAgentBackends.routing,
        ...(currentAgentBackends?.routing ?? {}),
        codex: {
          ...defaultAgentBackends.routing.codex,
          ...(currentAgentBackends?.routing?.codex ?? {}),
        },
        claude: {
          ...defaultAgentBackends.routing.claude,
          ...(currentAgentBackends?.routing?.claude ?? {}),
        },
      },
      claudeSidecar: {
        ...defaultAgentBackends.claudeSidecar,
        ...(currentAgentBackends?.claudeSidecar ?? {}),
        args: [
          ...(currentAgentBackends?.claudeSidecar?.args ??
            defaultAgentBackends.claudeSidecar.args),
        ],
        env: {
          ...defaultAgentBackends.claudeSidecar.env,
          ...(currentAgentBackends?.claudeSidecar?.env ?? {}),
        },
        provider: {
          ...defaultAgentBackends.claudeSidecar.provider,
          ...(currentAgentBackends?.claudeSidecar?.provider ?? {}),
        },
      },
    },
  };
}

function createDefaultTerminalUi(): TerminalUiState {
  return {
    runProfileInspectorPaneId: null,
  };
}

type SessionMapState = Pick<AppStore, 'sessions' | 'terminalSessions' | 'sessionIdByPty' | 'ptyBySessionId'>;

function buildSessionIndexes(
  sessions: Map<number, TerminalSessionMeta>,
  terminalSessions?: Map<string, TerminalSessionState>,
): SessionMapState {
  const nextTerminalSessions = terminalSessions ? new Map(terminalSessions) : new Map<string, TerminalSessionState>();
  const sessionIdByPty = new Map<number, string>();
  const ptyBySessionId = new Map<string, number>();

  for (const [ptyId, session] of sessions) {
    const nextSession = { ...session } as TerminalSessionState;
    nextTerminalSessions.set(nextSession.sessionId, nextSession);
    sessionIdByPty.set(ptyId, nextSession.sessionId);
    ptyBySessionId.set(nextSession.sessionId, ptyId);
  }

  return {
    sessions,
    terminalSessions: nextTerminalSessions,
    sessionIdByPty,
    ptyBySessionId,
  };
}

function buildSessionStatePatch(
  state: SessionMapState,
  session: TerminalSessionMeta,
): SessionMapState & { nextSession: TerminalSessionState; previousPtyId?: number } {
  const sessions = new Map(state.sessions);
  const terminalSessions = new Map(state.terminalSessions);
  const sessionIdByPty = new Map(state.sessionIdByPty);
  const ptyBySessionId = new Map(state.ptyBySessionId);

  const existingBySessionId = terminalSessions.get(session.sessionId);
  const existingByPty = sessions.get(session.ptyId);
  const existing = existingBySessionId ?? existingByPty;
  const previousPtyId = existingBySessionId?.ptyId;

  if (previousPtyId != null && previousPtyId !== session.ptyId) {
    sessions.delete(previousPtyId);
    sessionIdByPty.delete(previousPtyId);
  }

  const nextSession: TerminalSessionState = existing
    ? {
        ...existing,
        ...session,
        runProfile: normalizeRunProfile(session.runProfile, getSavedRunCommand(existing.runProfile)),
        commands: session.commands.length > 0 ? session.commands : existing.commands,
      }
    : {
        ...session,
        runProfile: normalizeRunProfile(session.runProfile, session.runProfile?.savedCommand),
      };

  sessions.set(session.ptyId, nextSession);
  terminalSessions.set(session.sessionId, nextSession);
  sessionIdByPty.set(session.ptyId, session.sessionId);
  ptyBySessionId.set(session.sessionId, session.ptyId);

  return {
    sessions,
    terminalSessions,
    sessionIdByPty,
    ptyBySessionId,
    nextSession,
    previousPtyId,
  };
}

function removeSessionStatePatch(
  state: SessionMapState,
  identifier: { ptyId?: number; sessionId?: string },
): SessionMapState {
  const sessions = new Map(state.sessions);
  const terminalSessions = new Map(state.terminalSessions);
  const sessionIdByPty = new Map(state.sessionIdByPty);
  const ptyBySessionId = new Map(state.ptyBySessionId);

  const sessionId = identifier.sessionId ?? (identifier.ptyId != null ? sessionIdByPty.get(identifier.ptyId) : undefined);
  const ptyId = identifier.ptyId ?? (sessionId ? ptyBySessionId.get(sessionId) : undefined);

  if (ptyId != null) {
    sessions.delete(ptyId);
    sessionIdByPty.delete(ptyId);
  }

  if (sessionId) {
    terminalSessions.delete(sessionId);
    ptyBySessionId.delete(sessionId);
  }

  return {
    sessions,
    terminalSessions,
    sessionIdByPty,
    ptyBySessionId,
  };
}

interface AppStore {
  config: AppConfig;
  workspaceById: Map<string, WorkspaceConfig>;
  workspaceIdByRootPath: Map<string, string>;
  setConfig: (config: AppConfig) => void;

  sessions: Map<number, TerminalSessionMeta>;
  terminalSessions: Map<string, TerminalSessionState>;
  sessionIdByPty: Map<number, string>;
  ptyBySessionId: Map<string, number>;
  terminalViews: Map<string, TerminalViewState>;
  activePaneByTab: Map<string, string>;
  ptyToPaneIndex: Map<number, PtyPaneIndexEntry>;
  paneIdToPty: Map<string, number>;
  paneRuntimeByPty: Map<number, PaneRuntimeState>;
  tabKindIndex: Map<string, WorkspaceTab['kind']>;
  tabRuntimeAggregate: Map<string, PaneStatus>;
  workspaceExplorerRuntime: Map<string, WorkspaceExplorerRuntime>;
  projectExplorerRuntime: Map<string, WorkspaceExplorerRuntime>;

  upsertSession: (session: TerminalSessionMeta) => void;
  updateSessionCwd: (ptyId: number, cwd: string, updatedAt?: number) => void;
  updateSessionPhase: (ptyId: number, phase: SessionPhase, patch?: Partial<TerminalSessionMeta>) => void;
  recordSessionCommand: (ptyId: number, command: string, updatedAt?: number, usageScope?: string) => void;
  finishSessionCommand: (ptyId: number, exitCode: number | undefined, phase: SessionPhase, updatedAt?: number) => void;
  removeSession: (ptyId: number) => void;
  removeSessionBySessionId: (sessionId: string) => void;

  setPaneRunCommand: (tabId: string, paneId: string, runCommand?: string) => void;
  setPaneRunProfile: (tabId: string, paneId: string, runProfile?: RunProfile) => void;
  updatePaneSessionBinding: (
    tabId: string,
    paneId: string,
    binding: Pick<TerminalSessionMeta, 'sessionId' | 'ptyId'> & Partial<Pick<TerminalSessionMeta, 'phase'>>,
  ) => void;
  setActivePaneForTab: (tabId: string, paneId: string) => void;
  clearActivePaneForTab: (tabId: string) => void;
  upsertTerminalView: (view: TerminalViewState) => void;
  updateTerminalView: (viewId: string, patch: Partial<TerminalViewState>) => void;
  removeTerminalView: (viewId: string) => void;

  activeWorkspaceId: string | null;
  workspaceStates: Map<string, WorkspaceState>;
  projectStates: Map<string, WorkspaceState>;
  setActiveWorkspace: (id: string) => void;
  createWorkspaceFromFolder: (path: string, options?: { name?: string; pinned?: boolean }) => string | null;
  createWorkspaceFromFolders: (paths: string[], options?: { name?: string; pinned?: boolean }) => string | null;
  duplicateWorkspace: (
    workspaceId: string,
    options?: { name?: string; restoreTabs?: boolean },
  ) => Promise<string | null>;
  renameWorkspace: (workspaceId: string, name: string) => void;
  pinWorkspace: (workspaceId: string, pinned?: boolean) => void;
  moveWorkspace: (workspaceId: string, direction: 'up' | 'down') => void;
  removeWorkspace: (workspaceId: string) => Promise<void>;
  reopenRecentWorkspace: (workspaceId: string) => string | null;
  forgetRecentWorkspace: (workspaceId: string) => void;
  addRootToWorkspace: (workspaceId: string, rootPath: string) => void;
  renameWorkspaceRoot: (workspaceId: string, rootId: string, name: string) => void;
  moveWorkspaceRoot: (workspaceId: string, rootId: string, direction: 'up' | 'down') => void;
  removeRootFromWorkspace: (workspaceId: string, rootId: string) => void;
  setPrimaryWorkspaceRoot: (workspaceId: string, rootId: string) => void;
  createTerminalTab: (workspaceId: string, options?: { cwd?: string; shellName?: string }) => Promise<string | null>;

  addTab: (workspaceId: string, tab: WorkspaceTab) => void;
  removeTab: (workspaceId: string, tabId: string) => void;
  setActiveTab: (workspaceId: string, tabId: string) => void;
  setTabCustomTitle: (workspaceId: string, tabId: string, customTitle?: string) => void;
  updateTabLayout: (workspaceId: string, tabId: string, layout: SplitNode) => void;
  reorderWorkspaceTab: (
    workspaceId: string,
    sourceTabId: string,
    targetTabId: string,
    position: 'before' | 'after',
  ) => void;
  moveWorkspaceTabToPane: (
    workspaceId: string,
    sourceTabId: string,
    targetTabId: string,
    targetPaneId: string | undefined,
    direction: 'horizontal' | 'vertical',
    position: 'before' | 'after',
  ) => void;
  moveWorkspacePaneToPane: (
    workspaceId: string,
    sourceTabId: string,
    sourcePaneId: string,
    targetTabId: string,
    targetPaneId: string | undefined,
    direction: 'horizontal' | 'vertical',
    position: 'before' | 'after',
  ) => void;
  moveWorkspacePaneToTab: (
    workspaceId: string,
    sourceTabId: string,
    sourcePaneId: string,
    targetTabId: string,
    position: 'before' | 'after',
  ) => void;

  updatePaneStatusByPty: (ptyId: number, status: PaneStatus) => void;
  updatePaneStatusesByPty: (updates: Array<{ ptyId: number; status: PaneStatus }>) => void;
  recordWorkspaceFsChanges: (rootPath: string, changes: { path: string; kind: string }[]) => void;
  recordProjectFsChanges: (rootPath: string, changes: { path: string; kind: string }[]) => void;
  markWorkspaceGitDirty: (rootPath: string) => void;
  markProjectGitDirty: (rootPath: string) => void;

  ui: {
    activeDialog: UiDialog | null;
    activeNotice: {
      id: string;
      message: string;
      tone: UiNoticeTone;
      durationMs: number;
      createdAt: number;
    } | null;
  };
  terminalUi: TerminalUiState;
  openSettings: (page?: SettingsPage) => void;
  showNotice: (payload: { message: string; tone?: UiNoticeTone; durationMs?: number }) => void;
  clearNotice: (noticeId?: string) => void;
  openRunProfileInspector: (paneId: string) => void;
  closeRunProfileInspector: () => void;
  openFileViewer: (workspaceId: string, filePath: string, options?: FileViewerOpenOptions) => void;
  setFileViewerTabMode: (workspaceId: string, tabId: string, mode: PreviewMode) => void;
  openAgentTaskPanel: (
    workspaceId: string,
    options?: {
      selectedTaskId?: string;
      scope?: AgentTaskPanelFilter['scope'];
    },
  ) => void;
  setAgentTaskPanelSelection: (workspaceId: string, tabId: string, taskId?: string) => void;
  setAgentTaskPanelFilter: (
    workspaceId: string,
    tabId: string,
    filterPatch: Partial<AgentTaskPanelFilter>,
  ) => void;
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
  openFileHistory: (workspaceId: string, projectPath: string, filePath: string) => void;
  openCommitDiff: (payload: {
    workspaceId?: string;
    projectId?: string;
    repoPath: string;
    commitHash: string;
    commitMessage: string;
    files: CommitFileInfo[];
  }) => void;
  closeDialog: () => void;
}

function getWorkspaceStateMap(state: {
  workspaceStates: Map<string, WorkspaceState>;
  projectStates: Map<string, WorkspaceState>;
}, workspaceId?: string) {
  if (workspaceId) {
    if (state.workspaceStates.has(workspaceId)) {
      return state.workspaceStates;
    }
    if (state.projectStates.has(workspaceId)) {
      return state.projectStates;
    }
  }

  return state.workspaceStates.size > 0 || state.projectStates.size === 0 ? state.workspaceStates : state.projectStates;
}

function getWorkspaceExplorerRuntimeMap(state: {
  workspaceExplorerRuntime: Map<string, WorkspaceExplorerRuntime>;
  projectExplorerRuntime: Map<string, WorkspaceExplorerRuntime>;
}) {
  return state.workspaceExplorerRuntime.size > 0 || state.projectExplorerRuntime.size === 0
    ? state.workspaceExplorerRuntime
    : state.projectExplorerRuntime;
}

function getWorkspaceConfigById(
  state: Pick<AppStore, 'config' | 'workspaceById'>,
  workspaceId: string | null | undefined,
): WorkspaceConfig | undefined {
  if (!workspaceId) {
    return undefined;
  }

  const workspace = state.workspaceById.get(workspaceId);
  if (workspace) {
    return workspace;
  }

  const legacyProject = state.config.projects?.find((project) => project.id === workspaceId);
  return legacyProject ? legacyProjectToWorkspace(legacyProject) : undefined;
}

export const selectWorkspaceState =
  (workspaceId: string) =>
  (state: AppStore): WorkspaceState | undefined =>
    getWorkspaceStateMap(state, workspaceId).get(workspaceId);

export const selectWorkspaceConfig =
  (workspaceId: string | null | undefined) =>
  (state: AppStore): WorkspaceConfig | undefined =>
    getWorkspaceConfigById(state, workspaceId);

export const selectWorkspacePrimaryRootPath =
  (workspaceId: string | null | undefined) =>
  (state: AppStore): string | undefined =>
    getWorkspacePrimaryRootPath(getWorkspaceConfigById(state, workspaceId));

export const selectWorkspaceRootPaths =
  (workspaceId: string | null | undefined) =>
  (state: AppStore): string[] =>
    workspaceId ? (getWorkspaceConfigById(state, workspaceId)?.roots.map((root) => root.path) ?? []) : [];

export const selectSessionByPty =
  (ptyId: number | undefined, enabled = true) =>
  (state: AppStore): TerminalSessionMeta | undefined =>
    enabled && ptyId != null ? state.sessions.get(ptyId) : undefined;

export const selectSessionById =
  (sessionId: string | undefined, enabled = true) =>
  (state: AppStore): TerminalSessionState | undefined =>
    enabled && sessionId ? state.terminalSessions.get(sessionId) : undefined;

export const selectPaneRuntimeByPty =
  (ptyId: number | undefined, enabled = true) =>
  (state: AppStore): PaneRuntimeState | undefined =>
    enabled && ptyId != null ? state.paneRuntimeByPty.get(ptyId) : undefined;

export const selectPaneRuntimeBySessionId =
  (sessionId: string | undefined, enabled = true) =>
  (state: AppStore): PaneRuntimeState | undefined => {
    if (!enabled || !sessionId) {
      return undefined;
    }

    const ptyId = state.ptyBySessionId.get(sessionId);
    return ptyId != null ? state.paneRuntimeByPty.get(ptyId) : undefined;
  };

export const selectWorkspaceSections = (state: AppStore) => ({
  pinned: getConfigWorkspaces(state.config).filter((workspace) => workspace.pinned),
  open: getConfigWorkspaces(state.config).filter((workspace) => !workspace.pinned),
  recent: [...state.config.recentWorkspaces].sort((left, right) => right.lastOpenedAt - left.lastOpenedAt),
});

export const selectWorkspaces = (state: AppStore) => getConfigWorkspaces(state.config);
export const selectRecentWorkspaces = (state: AppStore) => state.config.recentWorkspaces;
export const selectActiveWorkspace = (state: AppStore) =>
  getWorkspaceConfigById(state, state.activeWorkspaceId);

export const selectWorkspaceRuntimeSummary =
  (workspaceId: string) =>
  (state: AppStore) => {
    const workspaceState = getWorkspaceStateMap(state, workspaceId).get(workspaceId);
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
    (rootPath ? getWorkspaceExplorerRuntimeMap(state).get(normalizeWorkspacePath(rootPath))?.gitDirtyToken : undefined) ?? 0;

export const selectWorkspaceExplorerRuntime =
  (rootPath: string | undefined) =>
  (state: AppStore): WorkspaceExplorerRuntime | undefined =>
    rootPath ? getWorkspaceExplorerRuntimeMap(state).get(normalizeWorkspacePath(rootPath)) : undefined;

const defaultConfig: AppConfig = normalizeWorkspaceStoreConfig({
  workspaces: [],
  projects: [],
  recentWorkspaces: [],
  defaultShell: '',
  availableShells: [],
  uiFontSize: 13,
  terminalFontSize: 14,
  theme: getDefaultThemeConfig(),
  completionUsage: createEmptyCompletionUsage(),
  agentBackends: createDefaultAgentBackendsConfig(),
  externalMcp: createDefaultExternalMcpInteropConfig(),
});

export const useAppStore = create<AppStore>((set, get) => ({
  ...withConfigIndexes(defaultConfig),
  setConfig: (config) => set(withConfigIndexes(config)),

  sessions: new Map(),
  terminalSessions: new Map(),
  sessionIdByPty: new Map(),
  ptyBySessionId: new Map(),
  terminalViews: new Map(),
  activePaneByTab: new Map(),
  ptyToPaneIndex: new Map(),
  paneIdToPty: new Map(),
  paneRuntimeByPty: new Map(),
  tabKindIndex: new Map(),
  tabRuntimeAggregate: new Map(),
  workspaceExplorerRuntime: new Map(),
  projectExplorerRuntime: new Map(),
  activeWorkspaceId: null,
  workspaceStates: new Map(),
  projectStates: new Map(),
  ui: {
    activeDialog: null,
    activeNotice: null,
  },
  terminalUi: createDefaultTerminalUi(),

  upsertSession: (session) =>
    set((state) => {
      const {
        nextSession: _nextSession,
        previousPtyId,
        ...sessionPatch
      } = buildSessionStatePatch(state, session);

      const paneRuntime = state.paneRuntimeByPty.get(session.ptyId);
      if (!paneRuntime) {
        return sessionPatch;
      }

      const paneRuntimeByPty = new Map(state.paneRuntimeByPty);
      paneRuntimeByPty.set(session.ptyId, {
        ...paneRuntime,
        phase: session.phase,
      });
      if (
        previousPtyId != null
        && previousPtyId !== session.ptyId
        && paneRuntimeByPty.has(previousPtyId)
      ) {
        const previousRuntime = paneRuntimeByPty.get(previousPtyId);
        if (previousRuntime) {
          paneRuntimeByPty.delete(previousPtyId);
          paneRuntimeByPty.set(session.ptyId, {
            ...previousRuntime,
            ptyId: session.ptyId,
            phase: session.phase,
          });
        }
      }

      return { ...sessionPatch, paneRuntimeByPty };
    }),

  updateSessionCwd: (ptyId, cwd, updatedAt) =>
    set((state) => {
      const existing = state.sessions.get(ptyId);
      if (!existing || existing.cwd === cwd) {
        return state;
      }

      const nextSession = {
        ...existing,
        cwd,
        updatedAt: updatedAt ?? Date.now(),
      };
      const { nextSession: _nextSession, previousPtyId: _previousPtyId, ...sessionPatch } = buildSessionStatePatch(
        state,
        nextSession,
      );
      return sessionPatch;
    }),

  updateSessionPhase: (ptyId, phase, patch) =>
    set((state) => {
      const existing = state.sessions.get(ptyId);
      if (!existing) {
        return state;
      }

      const updatedAt = patch?.updatedAt ?? Date.now();
      const { nextSession: _nextSession, previousPtyId: _previousPtyId, ...sessionPatch } = buildSessionStatePatch(
        state,
        {
        ...existing,
        ...patch,
        phase,
        updatedAt,
        },
      );

      const paneRuntime = state.paneRuntimeByPty.get(ptyId);
      if (!paneRuntime) {
        return sessionPatch;
      }

      const paneRuntimeByPty = new Map(state.paneRuntimeByPty);
      paneRuntimeByPty.set(ptyId, {
        ...paneRuntime,
        phase,
      });
      return { ...sessionPatch, paneRuntimeByPty };
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

      const { nextSession: _nextSession, previousPtyId: _previousPtyId, ...sessionPatch } = buildSessionStatePatch(
        state,
        {
        ...existing,
        commands: [...settledCommands, nextCommand].slice(-12),
        lastCommand: command,
        runProfile: normalizeRunProfile(
          {
            ...existing.runProfile,
            lastRunAt: now,
            usageScope: usageScope ?? existing.runProfile?.usageScope,
          },
          existing.runProfile?.savedCommand,
        ),
        usageScope: usageScope ?? existing.usageScope,
        phase: 'running',
        updatedAt: now,
        activeCommand: nextCommand,
        },
      );

      shouldPersistUsage = true;
      return {
        ...sessionPatch,
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

      const { nextSession: _nextSession, previousPtyId: _previousPtyId, ...sessionPatch } = buildSessionStatePatch(
        state,
        {
        ...existing,
        commands: existing.activeCommand
          ? existing.commands.map((command) =>
              command.id === existing.activeCommand?.id ? (nextActiveCommand as CommandBlock) : command,
            )
          : existing.commands,
        phase,
        lastExitCode: exitCode,
        runProfile: normalizeRunProfile(
          {
            ...existing.runProfile,
            lastExitCode: exitCode,
          },
          existing.runProfile?.savedCommand,
        ),
        updatedAt: now,
        activeCommand: nextActiveCommand,
        },
      );

      const paneRuntime = state.paneRuntimeByPty.get(ptyId);
      if (!paneRuntime) {
        return sessionPatch;
      }

      const paneRuntimeByPty = new Map(state.paneRuntimeByPty);
      paneRuntimeByPty.set(ptyId, {
        ...paneRuntime,
        phase,
      });
      return { ...sessionPatch, paneRuntimeByPty };
    }),

  removeSession: (ptyId) =>
    set((state) => {
      if (!state.sessions.has(ptyId)) {
        return state;
      }

      const sessionPatch = removeSessionStatePatch(state, { ptyId });
      if (!state.paneRuntimeByPty.has(ptyId)) {
        return sessionPatch;
      }

      const paneRuntimeByPty = new Map(state.paneRuntimeByPty);
      paneRuntimeByPty.delete(ptyId);
      return { ...sessionPatch, paneRuntimeByPty };
    }),

  removeSessionBySessionId: (sessionId) =>
    set((state) => {
      if (!state.ptyBySessionId.has(sessionId) && !state.terminalSessions.has(sessionId)) {
        return state;
      }

      const ptyId = state.ptyBySessionId.get(sessionId);
      const sessionPatch = removeSessionStatePatch(state, { sessionId });
      if (ptyId == null || !state.paneRuntimeByPty.has(ptyId)) {
        return sessionPatch;
      }

      const paneRuntimeByPty = new Map(state.paneRuntimeByPty);
      paneRuntimeByPty.delete(ptyId);
      return { ...sessionPatch, paneRuntimeByPty };
    }),

  setPaneRunCommand: (tabId, paneId, runCommand) =>
    get().setPaneRunProfile(tabId, paneId, normalizeRunProfile(undefined, runCommand)),

  setPaneRunProfile: (tabId, paneId, runProfile) =>
    set((state) => {
      let changed = false;
      const workspaceStates = new Map(state.workspaceStates);
      const nextRunProfile = normalizeRunProfile(runProfile);

      for (const [workspaceId, workspaceState] of workspaceStates) {
        const tabIndex = workspaceState.tabs.findIndex((tab) => tab.id === tabId);
        if (tabIndex < 0) {
          continue;
        }
        const tabs = workspaceState.tabs.map((tab) => {
          if (tab.id !== tabId || !isTerminalTab(tab)) {
            return tab;
          }
          const nextLayout = updatePaneRunProfile(tab.splitLayout, paneId, nextRunProfile);
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
      return { workspaceStates, projectStates: workspaceStates };
    }),

  updatePaneSessionBinding: (tabId, paneId, binding) =>
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

          const nextLayout = updatePaneSessionBinding(tab.splitLayout, paneId, binding);
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

      return buildWorkspaceStatePatch(workspaceStates, state.paneRuntimeByPty, state.activePaneByTab);
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

  upsertTerminalView: (view) =>
    set((state) => {
      const existing = state.terminalViews.get(view.viewId);
      if (
        existing
        && existing.sessionId === view.sessionId
        && existing.tabId === view.tabId
        && existing.workspaceId === view.workspaceId
        && existing.isVisible === view.isVisible
        && existing.isFocused === view.isFocused
        && existing.cols === view.cols
        && existing.rows === view.rows
      ) {
        return state;
      }

      const terminalViews = new Map(state.terminalViews);
      terminalViews.set(view.viewId, existing ? { ...existing, ...view, updatedAt: Date.now() } : view);
      return { terminalViews };
    }),

  updateTerminalView: (viewId, patch) =>
    set((state) => {
      const existing = state.terminalViews.get(viewId);
      if (!existing) {
        return state;
      }

      const nextView = {
        ...existing,
        ...patch,
      };
      if (
        nextView.sessionId === existing.sessionId
        && nextView.paneId === existing.paneId
        && nextView.tabId === existing.tabId
        && nextView.workspaceId === existing.workspaceId
        && nextView.isVisible === existing.isVisible
        && nextView.isFocused === existing.isFocused
        && nextView.cols === existing.cols
        && nextView.rows === existing.rows
      ) {
        return state;
      }

      const terminalViews = new Map(state.terminalViews);
      terminalViews.set(viewId, { ...nextView, updatedAt: Date.now() });
      return { terminalViews };
    }),

  removeTerminalView: (viewId) =>
    set((state) => {
      if (!state.terminalViews.has(viewId)) {
        return state;
      }

      const terminalViews = new Map(state.terminalViews);
      terminalViews.delete(viewId);
      return { terminalViews };
    }),

  setActiveWorkspace: (id) =>
    set((state) => {
      const nextConfig: AppConfig = {
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
      };

      return {
        activeWorkspaceId: id,
        ...withConfigIndexes(nextConfig),
      };
    }),

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
    const normalizedSignature = buildWorkspacePathSignature(uniquePaths);
    const existing = state.config.workspaces.find((workspace) => {
      const signature = buildWorkspacePathSignature(workspace.roots.map((root) => root.path));
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

    const overlappingWorkspaceIds = Array.from(
      new Set(
        uniquePaths
          .map((path) => state.workspaceIdByRootPath.get(path))
          .filter((workspaceId): workspaceId is string => Boolean(workspaceId)),
      ),
    );
    if (overlappingWorkspaceIds.length > 1) {
      return null;
    }

    if (overlappingWorkspaceIds.length === 1) {
      const existingWorkspace = state.workspaceById.get(overlappingWorkspaceIds[0]);
      if (existingWorkspace) {
        const existingRootPaths = new Set(existingWorkspace.roots.map((root) => normalizeWorkspacePath(root.path)));
        const missingPaths = uniquePaths.filter((path) => !existingRootPaths.has(path));
        if (missingPaths.length === 0) {
          state.setActiveWorkspace(existingWorkspace.id);
          return existingWorkspace.id;
        }

        set((current) => {
          const now = Date.now();
          const nextConfig: AppConfig = {
            ...current.config,
            workspaces: current.config.workspaces.map((workspace) =>
              workspace.id === existingWorkspace.id
                ? {
                    ...workspace,
                    name: options?.name?.trim() ? options.name.trim() : workspace.name,
                    roots: ensureSinglePrimaryRoot([
                      ...workspace.roots,
                      ...missingPaths.map((path) => ({
                        id: genId(),
                        name: getPathBaseName(path),
                        path,
                        role: 'member' as const,
                      })),
                    ]),
                    lastOpenedAt: now,
                  }
                : workspace,
            ),
            lastWorkspaceId: existingWorkspace.id,
          };

          return {
            activeWorkspaceId: existingWorkspace.id,
            ...withConfigIndexes(nextConfig),
          };
        });

        return existingWorkspace.id;
      }
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

  duplicateWorkspace: async (workspaceId, options) => {
    const state = get();
    const workspace = state.workspaceById.get(workspaceId);
    if (!workspace) {
      return null;
    }

    const sourceWorkspaceState = state.workspaceStates.get(workspaceId);
    const savedLayout = sourceWorkspaceState ? serializeLayout(sourceWorkspaceState) : workspace.savedLayout;
    const nextWorkspaceId = genId();
    const nextWorkspaceName = options?.name?.trim() || workspace.name;
    const nextWorkspace = cloneWorkspaceConfig(workspace, nextWorkspaceId, nextWorkspaceName, savedLayout);
    const sourceWorkspaceIndex = state.config.workspaces.findIndex((item) => item.id === workspaceId);

    set((current) => {
      const nextWorkspaces =
        sourceWorkspaceIndex >= 0
          ? insertItemAfter(current.config.workspaces, sourceWorkspaceIndex, nextWorkspace)
          : [...current.config.workspaces, nextWorkspace];
      const nextConfig: AppConfig = {
        ...current.config,
        workspaces: nextWorkspaces,
        lastWorkspaceId: nextWorkspace.id,
      };

      const workspaceStates = new Map(current.workspaceStates);
      workspaceStates.set(nextWorkspace.id, { id: nextWorkspace.id, tabs: [], activeTabId: '' });
      return {
        activeWorkspaceId: nextWorkspace.id,
        ...withConfigIndexes(nextConfig),
        ...buildWorkspaceStatePatch(workspaceStates, current.paneRuntimeByPty, current.activePaneByTab),
      };
    });

    nextWorkspace.roots.forEach((root) => {
      initExpandedDirs(nextWorkspace.id, root.id, nextWorkspace.expandedDirsByRoot?.[root.id] ?? []);
    });

    if (options?.restoreTabs !== false && savedLayout?.tabs.length) {
      const primaryRootPath = getWorkspacePrimaryRootPath(nextWorkspace);
      if (primaryRootPath) {
        await restoreLayout(nextWorkspace.id, savedLayout, primaryRootPath, get().config);
      }
    }

    return nextWorkspace.id;
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

  // 注意：布局/展开目录先同步 flush，确保 beforeunload 时状态已保存。
  // 后续 PTY 会话清理是异步的，窗口关闭时可能不完整——此时由 process_monitor 兜底回收孤儿进程。
  removeWorkspace: async (workspaceId) => {
    flushLayoutToConfig(workspaceId);
    flushExpandedDirsToConfig(workspaceId);

    const stateBefore = get();
    const workspace = stateBefore.workspaceById.get(workspaceId);
    if (!workspace) {
      return;
    }

    const workspaceState = stateBefore.workspaceStates.get(workspaceId);
    const sessionBindings =
      workspaceState?.tabs.flatMap((tab) => (isTerminalTab(tab) ? collectPaneBindings(tab.splitLayout) : [])) ?? [];
    const uniqueSessionBindings = Array.from(
      new Map(sessionBindings.map((binding) => [binding.sessionId, binding])).values(),
    );

    for (const binding of uniqueSessionBindings) {
      await closeTerminalSession(binding.sessionId).catch(() => undefined);
      disposeTerminalBySession(binding.sessionId);
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

      let sessionStatePatch: SessionMapState = {
        sessions: state.sessions,
        terminalSessions: state.terminalSessions,
        sessionIdByPty: state.sessionIdByPty,
        ptyBySessionId: state.ptyBySessionId,
      };
      uniqueSessionBindings.forEach((binding) => {
        sessionStatePatch = removeSessionStatePatch(sessionStatePatch, { sessionId: binding.sessionId });
      });

      const activePaneByTab = new Map(state.activePaneByTab);
      workspaceState?.tabs.forEach((tab) => activePaneByTab.delete(tab.id));

      const workspaceExplorerRuntime = new Map(state.workspaceExplorerRuntime);
      workspace.roots.forEach((root) => {
        workspaceExplorerRuntime.delete(normalizeWorkspacePath(root.path));
        removeWorkspaceRootState(workspaceId, root.id);
      });

      return {
        ...sessionStatePatch,
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
      const existingWorkspaceId = state.workspaceIdByRootPath.get(normalizedRootPath);
      if (!workspace || !normalizedRootPath) {
        return state;
      }
      if (workspace.roots.some((root) => normalizeWorkspacePath(root.path) === normalizedRootPath)) {
        return state;
      }
      if (existingWorkspaceId && existingWorkspaceId !== workspaceId) {
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

  renameWorkspaceRoot: (workspaceId, rootId, name) =>
    set((state) => {
      const workspace = state.workspaceById.get(workspaceId);
      const trimmed = name.trim();
      if (!workspace || !trimmed) {
        return state;
      }

      const root = workspace.roots.find((item) => item.id === rootId);
      if (!root || root.name === trimmed) {
        return state;
      }

      const nextConfig: AppConfig = {
        ...state.config,
        workspaces: state.config.workspaces.map((item) =>
          item.id === workspaceId
            ? {
                ...item,
                roots: item.roots.map((currentRoot) =>
                  currentRoot.id === rootId ? { ...currentRoot, name: trimmed } : currentRoot,
                ),
              }
            : item,
        ),
      };
      return withConfigIndexes(nextConfig);
    }),

  moveWorkspaceRoot: (workspaceId, rootId, direction) =>
    set((state) => {
      const workspace = state.workspaceById.get(workspaceId);
      if (!workspace || workspace.roots.length <= 1) {
        return state;
      }

      const currentIndex = workspace.roots.findIndex((root) => root.id === rootId);
      if (currentIndex < 0) {
        return state;
      }

      const nextIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
      if (nextIndex < 0 || nextIndex >= workspace.roots.length) {
        return state;
      }

      const nextConfig: AppConfig = {
        ...state.config,
        workspaces: state.config.workspaces.map((item) =>
          item.id === workspaceId
            ? {
                ...item,
                roots: moveArrayItem(item.roots, currentIndex, nextIndex),
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

    const splitNode = await openTerminalPane(shell, cwd);
    if (!splitNode || splitNode.type !== 'leaf') {
      return null;
    }

    const pane = splitNode.pane;
    const tab: TerminalTab = {
      kind: 'terminal',
      id: genId(),
      status: 'idle',
      splitLayout: splitNode,
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

      const referencedPtyIds = collectReferencedPtyIds(workspaceStates);

      let sessionStatePatch: SessionMapState = {
        sessions: state.sessions,
        terminalSessions: state.terminalSessions,
        sessionIdByPty: state.sessionIdByPty,
        ptyBySessionId: state.ptyBySessionId,
      };
      removedPtyIds.forEach((ptyId) => {
        if (referencedPtyIds.has(ptyId)) {
          return;
        }
        sessionStatePatch = removeSessionStatePatch(sessionStatePatch, { ptyId });
      });

      const activePaneByTab = new Map(state.activePaneByTab);
      activePaneByTab.delete(tabId);

      return {
        ...sessionStatePatch,
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
      return { workspaceStates, projectStates: workspaceStates };
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
      return { workspaceStates, projectStates: workspaceStates };
    }),

  updateTabLayout: (workspaceId, tabId, layout) =>
    set((state) => {
      const workspaceStates = new Map(state.workspaceStates);
      const workspaceState = workspaceStates.get(workspaceId);
      if (!workspaceState) {
        return state;
      }

      const existingTab = workspaceState.tabs.find((tab) => tab.id === tabId);
      if (existingTab && isTerminalTab(existingTab) && areSplitNodesEquivalent(existingTab.splitLayout, layout)) {
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

  reorderWorkspaceTab: (workspaceId, sourceTabId, targetTabId, position) =>
    set((state) => {
      const sourceWorkspaceStates = getWorkspaceStateMap(state, workspaceId);
      const workspaceState = sourceWorkspaceStates.get(workspaceId);
      if (!workspaceState) {
        return state;
      }

      const nextTabs = moveWorkspaceTabList(workspaceState.tabs, sourceTabId, targetTabId, position);
      if (!nextTabs) {
        return state;
      }

      const workspaceStates = new Map(sourceWorkspaceStates);
      workspaceStates.set(workspaceId, {
        ...workspaceState,
        tabs: nextTabs,
      });
      return buildWorkspaceStatePatch(workspaceStates, state.paneRuntimeByPty, state.activePaneByTab);
    }),

  moveWorkspaceTabToPane: (workspaceId, sourceTabId, targetTabId, targetPaneId, direction, position) =>
    set((state) => {
      const sourceWorkspaceStates = getWorkspaceStateMap(state, workspaceId);
      const workspaceState = sourceWorkspaceStates.get(workspaceId);
      if (!workspaceState || sourceTabId === targetTabId) {
        return state;
      }

      const sourceTab = workspaceState.tabs.find((tab) => tab.id === sourceTabId);
      const targetTab = workspaceState.tabs.find((tab) => tab.id === targetTabId);
      if (!sourceTab || !targetTab) {
        return state;
      }

      const sourceNode = nodeFromWorkspaceTab(sourceTab);
      const sourceActivePaneId = resolvePreferredPaneId(
        sourceNode,
        isTerminalTab(sourceTab) ? state.activePaneByTab.get(sourceTabId) : undefined,
      );
      const nextTargetTab = insertNodeIntoWorkspaceTab(targetTab, targetPaneId, sourceNode, direction, position);
      if (!nextTargetTab) {
        return state;
      }

      const workspaceStates = new Map(sourceWorkspaceStates);
      workspaceStates.set(workspaceId, {
        ...workspaceState,
        activeTabId: targetTabId,
        tabs: workspaceState.tabs
          .map((tab) => (tab.id === targetTabId ? nextTargetTab : tab))
          .filter((tab) => tab.id !== sourceTabId),
      });

      const activePaneByTab = new Map(state.activePaneByTab);
      activePaneByTab.delete(sourceTabId);
      activePaneByTab.set(targetTabId, sourceActivePaneId);

      const removedPtyIds = isTerminalTab(sourceTab) ? collectPtyIds(sourceTab.splitLayout) : [];
      return buildWorkspaceMutationPatch(state, workspaceStates, activePaneByTab, removedPtyIds);
    }),

  moveWorkspacePaneToPane: (
    workspaceId,
    sourceTabId,
    sourcePaneId,
    targetTabId,
    targetPaneId,
    direction,
    position,
  ) =>
    set((state) => {
      const sourceWorkspaceStates = getWorkspaceStateMap(state, workspaceId);
      const workspaceState = sourceWorkspaceStates.get(workspaceId);
      if (!workspaceState) {
        return state;
      }

      const sourceTab = workspaceState.tabs.find((tab) => tab.id === sourceTabId);
      const targetTab = workspaceState.tabs.find((tab) => tab.id === targetTabId);
      if (!sourceTab || !targetTab || !isTerminalTab(sourceTab)) {
        return state;
      }

      const extraction = extractPane(sourceTab.splitLayout, sourcePaneId);
      if (!extraction.extractedPane) {
        return state;
      }

      const movedNode: SplitNode = {
        type: 'leaf',
        pane: extraction.extractedPane,
      };
      const removedPtyIds = extraction.extractedPane.kind === 'terminal' ? [extraction.extractedPane.ptyId] : [];

      if (sourceTabId === targetTabId) {
        if (!extraction.nextNode || !targetPaneId || !findPane(extraction.nextNode, targetPaneId)) {
          return state;
        }

        const nextLayout = insertNodeAtPane(extraction.nextNode, targetPaneId, direction, movedNode, position);
        if (areSplitNodesEquivalent(sourceTab.splitLayout, nextLayout)) {
          return state;
        }

        const workspaceStates = new Map(sourceWorkspaceStates);
        workspaceStates.set(workspaceId, {
          ...workspaceState,
          activeTabId: sourceTabId,
          tabs: workspaceState.tabs.map((tab) =>
            tab.id === sourceTabId && isTerminalTab(tab) ? { ...tab, splitLayout: nextLayout } : tab,
          ),
        });

        const activePaneByTab = new Map(state.activePaneByTab);
        activePaneByTab.set(sourceTabId, sourcePaneId);
        return buildWorkspaceMutationPatch(state, workspaceStates, activePaneByTab, removedPtyIds);
      }

      const nextTargetTab = insertNodeIntoWorkspaceTab(targetTab, targetPaneId, movedNode, direction, position);
      if (!nextTargetTab) {
        return state;
      }

      const currentSourceActivePaneId = state.activePaneByTab.get(sourceTabId);
      const nextSourceTab = extraction.nextNode ? { ...sourceTab, splitLayout: extraction.nextNode } : null;
      const nextSourceActivePaneId = nextSourceTab
        ? currentSourceActivePaneId && findPane(nextSourceTab.splitLayout, currentSourceActivePaneId)
          ? currentSourceActivePaneId
          : getFirstPaneId(nextSourceTab.splitLayout)
        : null;

      const workspaceStates = new Map(sourceWorkspaceStates);
      workspaceStates.set(workspaceId, {
        ...workspaceState,
        activeTabId: targetTabId,
        tabs: workspaceState.tabs.flatMap((tab) => {
          if (tab.id === sourceTabId) {
            return nextSourceTab ? [nextSourceTab] : [];
          }
          if (tab.id === targetTabId) {
            return [nextTargetTab];
          }
          return [tab];
        }),
      });

      const activePaneByTab = new Map(state.activePaneByTab);
      if (nextSourceActivePaneId) {
        activePaneByTab.set(sourceTabId, nextSourceActivePaneId);
      } else {
        activePaneByTab.delete(sourceTabId);
      }
      activePaneByTab.set(targetTabId, sourcePaneId);

      return buildWorkspaceMutationPatch(state, workspaceStates, activePaneByTab, removedPtyIds);
    }),

  moveWorkspacePaneToTab: (workspaceId, sourceTabId, sourcePaneId, targetTabId, position) =>
    set((state) => {
      const sourceWorkspaceStates = getWorkspaceStateMap(state, workspaceId);
      const workspaceState = sourceWorkspaceStates.get(workspaceId);
      if (!workspaceState) {
        return state;
      }

      const sourceTab = workspaceState.tabs.find((tab) => tab.id === sourceTabId);
      const targetTab = workspaceState.tabs.find((tab) => tab.id === targetTabId);
      if (!sourceTab || !targetTab || !isTerminalTab(sourceTab)) {
        return state;
      }

      const extraction = extractPane(sourceTab.splitLayout, sourcePaneId);
      if (!extraction.extractedPane) {
        return state;
      }

      if (sourceTabId === targetTabId && !extraction.nextNode) {
        return state;
      }

      const liftedTab = createCanvasTabFromPane(extraction.extractedPane);
      const removedPtyIds = extraction.extractedPane.kind === 'terminal' ? [extraction.extractedPane.ptyId] : [];
      const currentSourceActivePaneId = state.activePaneByTab.get(sourceTabId);
      const nextSourceTab = extraction.nextNode ? { ...sourceTab, splitLayout: extraction.nextNode } : null;
      const nextSourceActivePaneId = nextSourceTab
        ? currentSourceActivePaneId && findPane(nextSourceTab.splitLayout, currentSourceActivePaneId)
          ? currentSourceActivePaneId
          : getFirstPaneId(nextSourceTab.splitLayout)
        : null;

      const tabsWithoutSource = workspaceState.tabs.flatMap((tab) => {
        if (tab.id !== sourceTabId) {
          return [tab];
        }
        return nextSourceTab ? [nextSourceTab] : [];
      });
      const nextTabs = insertWorkspaceTabRelative(tabsWithoutSource, targetTabId, liftedTab, position);
      if (!nextTabs) {
        return state;
      }

      const workspaceStates = new Map(sourceWorkspaceStates);
      workspaceStates.set(workspaceId, {
        ...workspaceState,
        activeTabId: liftedTab.id,
        tabs: nextTabs,
      });

      const activePaneByTab = new Map(state.activePaneByTab);
      if (nextSourceActivePaneId) {
        activePaneByTab.set(sourceTabId, nextSourceActivePaneId);
      } else {
        activePaneByTab.delete(sourceTabId);
      }
      activePaneByTab.set(liftedTab.id, sourcePaneId);

      return buildWorkspaceMutationPatch(state, workspaceStates, activePaneByTab, removedPtyIds);
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
      const workspaceExplorerRuntime = new Map(getWorkspaceExplorerRuntimeMap(state));
      const current = workspaceExplorerRuntime.get(normalizedRootPath) ?? createExplorerRuntimeState();
      workspaceExplorerRuntime.set(normalizedRootPath, {
        ...current,
        dirtyPaths: Array.from(new Set([...current.dirtyPaths, ...changes.map((change) => change.path)])).slice(-DIRTY_PATHS_MAX),
        lastFsChangeAt: Date.now(),
      });
      return buildExplorerRuntimePatch(workspaceExplorerRuntime);
    }),

  recordProjectFsChanges: (rootPath, changes) => get().recordWorkspaceFsChanges(rootPath, changes),

  markWorkspaceGitDirty: (rootPath) =>
    set((state) => {
      const normalizedRootPath = normalizeWorkspacePath(rootPath);
      const workspaceExplorerRuntime = new Map(getWorkspaceExplorerRuntimeMap(state));
      const current = workspaceExplorerRuntime.get(normalizedRootPath) ?? createExplorerRuntimeState();
      workspaceExplorerRuntime.set(normalizedRootPath, {
        ...current,
        dirtyPaths: [],
        lastGitDirtyAt: Date.now(),
        gitDirtyToken: current.gitDirtyToken + 1,
      });
      return buildExplorerRuntimePatch(workspaceExplorerRuntime);
    }),

  markProjectGitDirty: (rootPath) => get().markWorkspaceGitDirty(rootPath),

  openSettings: (page = 'terminal') =>
    set((state) => ({
      ui: {
        ...state.ui,
        activeDialog: {
          kind: 'settings',
          page,
        },
      },
    })),

  showNotice: (payload) =>
    set((state) => ({
      ui: {
        ...state.ui,
        activeNotice: {
          id: genId(),
          message: payload.message,
          tone: payload.tone ?? 'info',
          durationMs: payload.durationMs ?? 1500,
          createdAt: Date.now(),
        },
      },
    })),

  clearNotice: (noticeId) =>
    set((state) => {
      const activeNotice = state.ui.activeNotice;
      if (!activeNotice) {
        return state;
      }
      if (noticeId && activeNotice.id !== noticeId) {
        return state;
      }
      return {
        ui: {
          ...state.ui,
          activeNotice: null,
        },
      };
    }),

  openRunProfileInspector: (paneId) =>
    set((state) => ({
      terminalUi:
        state.terminalUi.runProfileInspectorPaneId === paneId
          ? state.terminalUi
          : {
              ...state.terminalUi,
              runProfileInspectorPaneId: paneId,
            },
    })),

  closeRunProfileInspector: () =>
    set((state) => ({
      terminalUi:
        state.terminalUi.runProfileInspectorPaneId == null
          ? state.terminalUi
          : {
              ...state.terminalUi,
              runProfileInspectorPaneId: null,
            },
    })),

  openFileViewer: (workspaceId, filePath, options) =>
    set((state) => {
      const sourceWorkspaceStates = getWorkspaceStateMap(state, workspaceId);
      const workspaceState = sourceWorkspaceStates.get(workspaceId);
      if (!workspaceState) {
        return state;
      }
      const nextMode = normalizeFileViewerMode(filePath, options?.initialMode);
      const normalizedFilePath = normalizePathIdentity(filePath);
      const workspaceStates = new Map(sourceWorkspaceStates);
      const activePaneByTab = new Map(state.activePaneByTab);
      const existingPane = findPaneLocation(
        workspaceState,
        (pane) => pane.kind === 'file-viewer' && normalizePathIdentity(pane.filePath) === normalizedFilePath,
      );
      const existingLegacyTab = workspaceState.tabs.find(
        (tab) => tab.kind === 'file-viewer' && normalizePathIdentity(tab.filePath) === normalizedFilePath,
      );

      if (existingPane) {
        const nextWorkspaceState = updatePaneLocationInWorkspaceState(workspaceState, existingPane, (pane) => {
          if (pane.kind !== 'file-viewer') {
            return pane;
          }

          if (options?.navigationTarget) {
            return (
              pane.mode === nextMode
              && JSON.stringify(pane.navigationTarget ?? null) === JSON.stringify(options.navigationTarget)
            )
              ? pane
              : {
                  ...pane,
                  mode: nextMode,
                  navigationTarget: options.navigationTarget,
                };
          }

          if (pane.mode === nextMode && !pane.navigationTarget) {
            return pane;
          }

          const { navigationTarget: _navigationTarget, ...rest } = pane;
          return {
            ...rest,
            mode: nextMode,
          };
        });
        activePaneByTab.set(existingPane.tabId, existingPane.paneId);
        workspaceStates.set(workspaceId, nextWorkspaceState);
        return {
          activePaneByTab,
          ...buildWorkspaceStatePatch(workspaceStates, state.paneRuntimeByPty, activePaneByTab),
        };
      }

      if (existingLegacyTab) {
        workspaceStates.set(workspaceId, {
          ...workspaceState,
          activeTabId: existingLegacyTab.id,
          tabs: workspaceState.tabs.map((tab) =>
            tab.id === existingLegacyTab.id && tab.kind === 'file-viewer'
              ? (() => {
                  const { navigationTarget: _navigationTarget, ...rest } = tab;
                  return options?.navigationTarget
                    ? {
                        ...rest,
                        mode: nextMode,
                        navigationTarget: options.navigationTarget,
                      }
                    : {
                        ...rest,
                        mode: nextMode,
                      };
                })()
              : tab,
          ),
        });
        return {
          activePaneByTab,
          ...buildWorkspaceStatePatch(workspaceStates, state.paneRuntimeByPty, activePaneByTab),
        };
      }

      const pane = createFileViewerPane(filePath, options);
      const { nextWorkspaceState, nextActivePaneByTab } = insertPaneIntoWorkspaceState(
        workspaceState,
        activePaneByTab,
        { ...pane, mode: nextMode },
      );
      workspaceStates.set(workspaceId, nextWorkspaceState);

      return {
        activePaneByTab: nextActivePaneByTab,
        ...buildWorkspaceStatePatch(workspaceStates, state.paneRuntimeByPty, nextActivePaneByTab),
      };
    }),

  setFileViewerTabMode: (workspaceId, tabId, mode) =>
    set((state) => {
      const sourceWorkspaceStates = getWorkspaceStateMap(state, workspaceId);
      const workspaceState = sourceWorkspaceStates.get(workspaceId);
      if (!workspaceState) {
        return state;
      }

      let changed = false;
      const tabs = workspaceState.tabs.map((tab) => {
        if (tab.id === tabId && tab.kind === 'file-viewer') {
          const nextMode = normalizeFileViewerMode(tab.filePath, mode);
          if (tab.mode === nextMode) {
            return tab;
          }
          changed = true;
          return { ...tab, mode: nextMode };
        }

        if (!isTerminalTab(tab)) {
          return tab;
        }
        const nextLayout = updateWorkspacePane(tab.splitLayout, tabId, (pane) => {
          if (pane.kind !== 'file-viewer') {
            return pane;
          }
          const nextMode = normalizeFileViewerMode(pane.filePath, mode);
          return pane.mode === nextMode ? pane : { ...pane, mode: nextMode };
        });
        if (nextLayout === tab.splitLayout) {
          return tab;
        }
        changed = true;
        return { ...tab, splitLayout: nextLayout };
      });

      if (!changed) {
        return state;
      }

      const workspaceStates = new Map(sourceWorkspaceStates);
      workspaceStates.set(workspaceId, { ...workspaceState, tabs });
      return buildWorkspaceStatePatch(workspaceStates, state.paneRuntimeByPty, state.activePaneByTab);
    }),

  openAgentTaskPanel: (workspaceId, options) =>
    set((state) => {
      const sourceWorkspaceStates = getWorkspaceStateMap(state, workspaceId);
      const workspaceState = sourceWorkspaceStates.get(workspaceId);
      if (!workspaceState) {
        return state;
      }

      const workspaceStates = new Map(sourceWorkspaceStates);
      const existing = workspaceState.tabs.find((tab) => isAgentTaskPanelTab(tab));
      const nextScope = options?.scope ?? 'workspace';
      const activePaneByTab = new Map(state.activePaneByTab);
      const existingPane = findPaneLocation(workspaceState, (pane) => pane.kind === 'agent-tasks');

      if (existingPane) {
        const nextWorkspaceState = updatePaneLocationInWorkspaceState(workspaceState, existingPane, (pane) => {
          if (pane.kind !== 'agent-tasks') {
            return pane;
          }

          const nextSelectedTaskId = options?.selectedTaskId ?? pane.selectedTaskId;
          const nextFilter = {
            ...pane.filter,
            scope: nextScope,
          };
          return (
            nextSelectedTaskId === pane.selectedTaskId
            && JSON.stringify(nextFilter) === JSON.stringify(pane.filter)
          )
            ? pane
            : {
                ...pane,
                selectedTaskId: nextSelectedTaskId,
                filter: nextFilter,
              };
        });
        activePaneByTab.set(existingPane.tabId, existingPane.paneId);
        workspaceStates.set(workspaceId, nextWorkspaceState);
        return {
          activePaneByTab,
          ...buildWorkspaceStatePatch(workspaceStates, state.paneRuntimeByPty, activePaneByTab),
        };
      }

      if (existing && isAgentTaskPanelTab(existing)) {
        workspaceStates.set(workspaceId, {
          ...workspaceState,
          activeTabId: existing.id,
          tabs: workspaceState.tabs.map((tab) =>
            tab.id === existing.id && isAgentTaskPanelTab(tab)
              ? {
                  ...tab,
                  selectedTaskId: options?.selectedTaskId ?? tab.selectedTaskId,
                  filter: {
                    ...tab.filter,
                    scope: nextScope,
                  },
                }
              : tab,
          ),
        });
        return {
          activePaneByTab,
          ...buildWorkspaceStatePatch(workspaceStates, state.paneRuntimeByPty, activePaneByTab),
        };
      }

      const pane = createAgentTaskPanelPane(options);
      const { nextWorkspaceState, nextActivePaneByTab } = insertPaneIntoWorkspaceState(
        workspaceState,
        activePaneByTab,
        {
          ...pane,
          filter: {
            ...pane.filter,
            scope: nextScope,
          },
        },
      );
      workspaceStates.set(workspaceId, nextWorkspaceState);

      return {
        activePaneByTab: nextActivePaneByTab,
        ...buildWorkspaceStatePatch(workspaceStates, state.paneRuntimeByPty, nextActivePaneByTab),
      };
    }),

  setAgentTaskPanelSelection: (workspaceId, tabId, taskId) =>
    set((state) => {
      const sourceWorkspaceStates = getWorkspaceStateMap(state, workspaceId);
      const workspaceState = sourceWorkspaceStates.get(workspaceId);
      if (!workspaceState) {
        return state;
      }

      let changed = false;
      const tabs = workspaceState.tabs.map((tab) => {
        if (tab.id === tabId && isAgentTaskPanelTab(tab)) {
          if (tab.selectedTaskId === taskId) {
            return tab;
          }
          changed = true;
          return {
            ...tab,
            selectedTaskId: taskId,
          };
        }

        if (!isTerminalTab(tab)) {
          return tab;
        }

        const nextLayout = updateWorkspacePane(tab.splitLayout, tabId, (pane) => {
          if (pane.kind !== 'agent-tasks' || pane.selectedTaskId === taskId) {
            return pane;
          }
          return {
            ...pane,
            selectedTaskId: taskId,
          };
        });
        if (nextLayout === tab.splitLayout) {
          return tab;
        }
        changed = true;
        return { ...tab, splitLayout: nextLayout };
      });

      if (!changed) {
        return state;
      }

      const workspaceStates = new Map(sourceWorkspaceStates);
      workspaceStates.set(workspaceId, {
        ...workspaceState,
        tabs,
      });
      return buildWorkspaceStatePatch(workspaceStates, state.paneRuntimeByPty, state.activePaneByTab);
    }),

  setAgentTaskPanelFilter: (workspaceId, tabId, filterPatch) =>
    set((state) => {
      const sourceWorkspaceStates = getWorkspaceStateMap(state, workspaceId);
      const workspaceState = sourceWorkspaceStates.get(workspaceId);
      if (!workspaceState) {
        return state;
      }

      let changed = false;
      const tabs = workspaceState.tabs.map((tab) => {
        if (tab.id === tabId && isAgentTaskPanelTab(tab)) {
          const nextFilter = {
            ...tab.filter,
            ...filterPatch,
          };
          if (JSON.stringify(nextFilter) === JSON.stringify(tab.filter)) {
            return tab;
          }
          changed = true;
          return {
            ...tab,
            filter: nextFilter,
          };
        }

        if (!isTerminalTab(tab)) {
          return tab;
        }

        const nextLayout = updateWorkspacePane(tab.splitLayout, tabId, (pane) => {
          if (pane.kind !== 'agent-tasks') {
            return pane;
          }
          const nextFilter = {
            ...pane.filter,
            ...filterPatch,
          };
          if (JSON.stringify(nextFilter) === JSON.stringify(pane.filter)) {
            return pane;
          }
          return {
            ...pane,
            filter: nextFilter,
          };
        });
        if (nextLayout === tab.splitLayout) {
          return tab;
        }
        changed = true;
        return { ...tab, splitLayout: nextLayout };
      });

      if (!changed) {
        return state;
      }

      const workspaceStates = new Map(sourceWorkspaceStates);
      workspaceStates.set(workspaceId, {
        ...workspaceState,
        tabs,
      });
      return buildWorkspaceStatePatch(workspaceStates, state.paneRuntimeByPty, state.activePaneByTab);
    }),

  openInteractionDialog: (payload) =>
    set((state) => ({
      ui: {
        ...state.ui,
        activeDialog: {
          kind: 'interaction-dialog',
          ...payload,
        },
      },
    })),

  openWorktreeDiff: (workspaceId, projectPath, status) =>
    set((state) => {
      const sourceWorkspaceStates = getWorkspaceStateMap(state, workspaceId);
      const workspaceState = sourceWorkspaceStates.get(workspaceId);
      if (!workspaceState) {
        return state;
      }
      const normalizedProjectPath = normalizePathIdentity(projectPath);
      const normalizedStatusPath = normalizePathIdentity(status.path);
      const activePaneByTab = new Map(state.activePaneByTab);
      const existingPane = findPaneLocation(
        workspaceState,
        (pane) =>
          pane.kind === 'worktree-diff'
          && normalizePathIdentity(pane.projectPath) === normalizedProjectPath
          && normalizePathIdentity(pane.gitStatus.path) === normalizedStatusPath,
      );
      const existing = workspaceState.tabs.find(
        (tab) =>
          tab.kind === 'worktree-diff'
          && normalizePathIdentity(tab.projectPath) === normalizedProjectPath
          && normalizePathIdentity(tab.status.path) === normalizedStatusPath,
      );
      const workspaceStates = new Map(sourceWorkspaceStates);

      if (existingPane) {
        const nextWorkspaceState = updatePaneLocationInWorkspaceState(workspaceState, existingPane, (pane) =>
          pane.kind === 'worktree-diff' && JSON.stringify(pane.gitStatus) !== JSON.stringify(status)
            ? { ...pane, gitStatus: status }
            : pane,
        );
        activePaneByTab.set(existingPane.tabId, existingPane.paneId);
        workspaceStates.set(workspaceId, nextWorkspaceState);
        return {
          activePaneByTab,
          ...buildWorkspaceStatePatch(workspaceStates, state.paneRuntimeByPty, activePaneByTab),
        };
      }

      if (existing) {
        workspaceStates.set(workspaceId, {
          ...workspaceState,
          activeTabId: existing.id,
          tabs: workspaceState.tabs.map((tab) =>
            tab.id === existing.id && tab.kind === 'worktree-diff' ? { ...tab, status } : tab,
          ),
        });
        return {
          activePaneByTab,
          ...buildWorkspaceStatePatch(workspaceStates, state.paneRuntimeByPty, activePaneByTab),
        };
      }

      const pane = createWorktreeDiffPane(projectPath, status);
      const { nextWorkspaceState, nextActivePaneByTab } = insertPaneIntoWorkspaceState(
        workspaceState,
        activePaneByTab,
        pane,
      );
      workspaceStates.set(workspaceId, nextWorkspaceState);
      return {
        activePaneByTab: nextActivePaneByTab,
        ...buildWorkspaceStatePatch(workspaceStates, state.paneRuntimeByPty, nextActivePaneByTab),
      };
    }),

  openFileHistory: (workspaceId, projectPath, filePath) =>
    set((state) => {
      const sourceWorkspaceStates = getWorkspaceStateMap(state, workspaceId);
      const workspaceState = sourceWorkspaceStates.get(workspaceId);
      if (!workspaceState) {
        return state;
      }
      const normalizedProjectPath = normalizePathIdentity(projectPath);
      const normalizedFilePath = normalizePathIdentity(filePath);
      const activePaneByTab = new Map(state.activePaneByTab);
      const existingPane = findPaneLocation(
        workspaceState,
        (pane) =>
          pane.kind === 'file-history'
          && normalizePathIdentity(pane.projectPath) === normalizedProjectPath
          && normalizePathIdentity(pane.filePath) === normalizedFilePath,
      );
      const existing = workspaceState.tabs.find(
        (tab) =>
          tab.kind === 'file-history'
          && normalizePathIdentity(tab.projectPath) === normalizedProjectPath
          && normalizePathIdentity(tab.filePath) === normalizedFilePath,
      );
      const workspaceStates = new Map(sourceWorkspaceStates);

      if (existingPane) {
        activePaneByTab.set(existingPane.tabId, existingPane.paneId);
        workspaceStates.set(workspaceId, {
          ...workspaceState,
          activeTabId: existingPane.tabId,
        });
        return {
          activePaneByTab,
          ...buildWorkspaceStatePatch(workspaceStates, state.paneRuntimeByPty, activePaneByTab),
        };
      }

      if (existing) {
        workspaceStates.set(workspaceId, {
          ...workspaceState,
          activeTabId: existing.id,
        });
        return {
          activePaneByTab,
          ...buildWorkspaceStatePatch(workspaceStates, state.paneRuntimeByPty, activePaneByTab),
        };
      }

      const pane = createFileHistoryPane(projectPath, filePath);
      const { nextWorkspaceState, nextActivePaneByTab } = insertPaneIntoWorkspaceState(
        workspaceState,
        activePaneByTab,
        pane,
      );
      workspaceStates.set(workspaceId, nextWorkspaceState);
      return {
        activePaneByTab: nextActivePaneByTab,
        ...buildWorkspaceStatePatch(workspaceStates, state.paneRuntimeByPty, nextActivePaneByTab),
      };
    }),

  openCommitDiff: ({ workspaceId, projectId, repoPath, commitHash, commitMessage, files }) =>
    set((state) => {
      const resolvedWorkspaceId = workspaceId ?? projectId;
      if (!resolvedWorkspaceId) {
        return state;
      }
      const sourceWorkspaceStates = getWorkspaceStateMap(state, resolvedWorkspaceId);
      const workspaceState = sourceWorkspaceStates.get(resolvedWorkspaceId);
      if (!workspaceState) {
        return state;
      }
      const normalizedRepoPath = normalizePathIdentity(repoPath);
      const activePaneByTab = new Map(state.activePaneByTab);
      const existingPane = findPaneLocation(
        workspaceState,
        (pane) =>
          pane.kind === 'commit-diff'
          && normalizePathIdentity(pane.repoPath) === normalizedRepoPath
          && pane.commitHash === commitHash,
      );
      const existing = workspaceState.tabs.find(
        (tab) =>
          tab.kind === 'commit-diff'
          && normalizePathIdentity(tab.repoPath) === normalizedRepoPath
          && tab.commitHash === commitHash,
      );
      const workspaceStates = new Map(sourceWorkspaceStates);

      if (existingPane) {
        const nextWorkspaceState = updatePaneLocationInWorkspaceState(workspaceState, existingPane, (pane) =>
          pane.kind === 'commit-diff'
          && pane.commitMessage === commitMessage
          && JSON.stringify(pane.files) === JSON.stringify(files)
            ? pane
            : pane.kind === 'commit-diff'
              ? { ...pane, commitMessage, files }
              : pane,
        );
        activePaneByTab.set(existingPane.tabId, existingPane.paneId);
        workspaceStates.set(resolvedWorkspaceId, nextWorkspaceState);
        return {
          activePaneByTab,
          ...buildWorkspaceStatePatch(workspaceStates, state.paneRuntimeByPty, activePaneByTab),
        };
      }

      if (existing) {
        workspaceStates.set(resolvedWorkspaceId, {
          ...workspaceState,
          activeTabId: existing.id,
          tabs: workspaceState.tabs.map((tab) =>
            tab.id === existing.id && tab.kind === 'commit-diff'
              ? { ...tab, commitMessage, files }
              : tab,
          ),
        });
        return {
          activePaneByTab,
          ...buildWorkspaceStatePatch(workspaceStates, state.paneRuntimeByPty, activePaneByTab),
        };
      }

      const pane = createCommitDiffPane(repoPath, commitHash, commitMessage, files);
      const { nextWorkspaceState, nextActivePaneByTab } = insertPaneIntoWorkspaceState(
        workspaceState,
        activePaneByTab,
        pane,
      );
      workspaceStates.set(resolvedWorkspaceId, nextWorkspaceState);
      return {
        activePaneByTab: nextActivePaneByTab,
        ...buildWorkspaceStatePatch(workspaceStates, state.paneRuntimeByPty, nextActivePaneByTab),
      };
    }),

  closeDialog: () =>
    set((state) => ({
      ui: {
        ...state.ui,
        activeDialog: null,
      },
    })),
}));

function normalizeStoreStatePatch(patch: Partial<AppStore> | AppStore, previousState: AppStore) {
  const normalizedPatch: Partial<AppStore> = { ...patch };

  if (normalizedPatch.config) {
    const projectsChanged = normalizedPatch.config.projects !== previousState.config.projects;
    const workspacesChanged = normalizedPatch.config.workspaces !== previousState.config.workspaces;
    const configInput =
      projectsChanged && !workspacesChanged
        ? {
            ...normalizedPatch.config,
            workspaces: [],
          }
        : normalizedPatch.config;
    const normalizedConfig = normalizeWorkspaceStoreConfig(configInput);
    normalizedPatch.config = normalizedConfig;
    Object.assign(normalizedPatch, buildConfigIndexes(normalizedConfig.workspaces));
  }

  if (normalizedPatch.sessions && !normalizedPatch.terminalSessions) {
    Object.assign(normalizedPatch, buildSessionIndexes(normalizedPatch.sessions));
  } else if (normalizedPatch.terminalSessions && !normalizedPatch.sessions) {
    const sessions = new Map<number, TerminalSessionMeta>();
    for (const session of normalizedPatch.terminalSessions.values()) {
      sessions.set(session.ptyId, session);
    }
    Object.assign(normalizedPatch, buildSessionIndexes(sessions, normalizedPatch.terminalSessions));
  }

  const workspaceStatesChanged = normalizedPatch.workspaceStates !== previousState.workspaceStates;
  const projectStatesChanged = normalizedPatch.projectStates !== previousState.projectStates;
  const workspaceStates =
    projectStatesChanged && !workspaceStatesChanged
      ? normalizedPatch.projectStates
      : normalizedPatch.workspaceStates ?? normalizedPatch.projectStates;
  if (workspaceStates) {
    Object.assign(
      normalizedPatch,
      buildWorkspaceStatePatch(
        workspaceStates,
        normalizedPatch.paneRuntimeByPty ?? previousState.paneRuntimeByPty,
        normalizedPatch.activePaneByTab ?? previousState.activePaneByTab,
      ),
    );
  }

  const workspaceExplorerRuntimeChanged =
    normalizedPatch.workspaceExplorerRuntime !== previousState.workspaceExplorerRuntime;
  const projectExplorerRuntimeChanged =
    normalizedPatch.projectExplorerRuntime !== previousState.projectExplorerRuntime;
  const workspaceExplorerRuntime =
    projectExplorerRuntimeChanged && !workspaceExplorerRuntimeChanged
      ? normalizedPatch.projectExplorerRuntime
      : normalizedPatch.workspaceExplorerRuntime ?? normalizedPatch.projectExplorerRuntime;
  if (workspaceExplorerRuntime) {
    Object.assign(normalizedPatch, buildExplorerRuntimePatch(workspaceExplorerRuntime));
  }

  return normalizedPatch;
}

// 注意：此处通过猴子补丁拦截 setState，自动归一化 config/indexes 等派生字段。
// 风险：可能与 Zustand 中间件或 DevTools 冲突。后续应改用 Zustand middleware 链实现。
const rawSetAppStoreState = useAppStore.setState as (partial: unknown, replace?: boolean) => void;
useAppStore.setState = ((partial, replace) => {
  if (typeof partial === 'function') {
    return rawSetAppStoreState(
      (state: AppStore) => normalizeStoreStatePatch(partial(state), state),
      replace,
    );
  }
  return rawSetAppStoreState((state: AppStore) => normalizeStoreStatePatch(partial, state), replace);
}) as typeof useAppStore.setState;

export const selectProjectState = selectWorkspaceState;
export const selectProjects = selectWorkspaces;
export const selectProjectGitDirtyToken = selectWorkspaceGitDirtyToken;
export const selectProjectExplorerRuntime = selectWorkspaceExplorerRuntime;
export const selectProjectPath =
  (workspaceId: string) =>
  (state: AppStore): string | undefined =>
    getWorkspacePrimaryRootPath(getWorkspaceConfigById(state, workspaceId));
