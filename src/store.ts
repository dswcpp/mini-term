import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { getDefaultThemeConfig } from './theme';
import { createTerminalSessionMeta, getSessionIdForPty } from './utils/session';
import type {
  AppConfig,
  CommandBlock,
  SessionPhase,
  ProjectConfig,
  ProjectGroup,
  ProjectState,
  TerminalTab,
  TerminalSessionMeta,
  SplitNode,
  PaneStatus,
  SavedSplitNode,
  SavedTab,
  SavedProjectLayout,
} from './types';
import {
  deepCloneTree,
  removeFromTree,
  insertIntoTree,
  updateGroupInTree,
  removeGroupAndPromoteChildren,
  removeProjectFromTree,
  migrateToTree,
} from './utils/projectTree';

// 生成唯一 ID
let idCounter = 0;
export const genId = () => `id-${Date.now()}-${++idCounter}`;

// 计算 Tab 聚合状态
const STATUS_PRIORITY: Record<PaneStatus, number> = {
  error: 3,
  'ai-working': 2,
  'ai-idle': 1,
  idle: 0,
};

function getHighestStatus(node: SplitNode): PaneStatus {
  if (node.type === 'leaf') return node.pane.status;
  return node.children.reduce<PaneStatus>((acc, child) => {
    const s = getHighestStatus(child);
    return STATUS_PRIORITY[s] > STATUS_PRIORITY[acc] ? s : acc;
  }, 'idle');
}

// 在 SplitNode 中更新指定 pane 的状态
function updatePaneStatus(node: SplitNode, ptyId: number, status: PaneStatus): SplitNode {
  if (node.type === 'leaf') {
    if (node.pane.ptyId === ptyId) {
      return { ...node, pane: { ...node.pane, status } };
    }
    return node;
  }
  return {
    ...node,
    children: node.children.map((c) => updatePaneStatus(c, ptyId, status)),
  };
}

function updatePaneSessionPhase(node: SplitNode, ptyId: number, phase: SessionPhase): SplitNode {
  if (node.type === 'leaf') {
    if (node.pane.ptyId === ptyId) {
      return { ...node, pane: { ...node.pane, phase } };
    }
    return node;
  }

  return {
    ...node,
    children: node.children.map((child) => updatePaneSessionPhase(child, ptyId, phase)),
  };
}

function updatePaneRunCommand(node: SplitNode, paneId: string, runCommand?: string): SplitNode {
  if (node.type === 'leaf') {
    if (node.pane.id === paneId) {
      return { ...node, pane: { ...node.pane, runCommand } };
    }
    return node;
  }

  return {
    ...node,
    children: node.children.map((child) => updatePaneRunCommand(child, paneId, runCommand)),
  };
}

// 收集所有 pane 的 ptyId
export function collectPtyIds(node: SplitNode): number[] {
  if (node.type === 'leaf') return [node.pane.ptyId];
  return node.children.flatMap(collectPtyIds);
}

// 序列化 SplitNode 树（剥离运行时数据）
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

export function serializeLayout(ps: ProjectState): SavedProjectLayout {
  const tabs: SavedTab[] = ps.tabs.map((tab) => ({
    customTitle: tab.customTitle,
    splitLayout: serializeSplitNode(tab.splitLayout),
  }));
  const activeTabIndex = ps.tabs.findIndex((t) => t.id === ps.activeTabId);
  return { tabs, activeTabIndex: activeTabIndex >= 0 ? activeTabIndex : 0 };
}

// 反序列化：重建 SplitNode 树并创建 PTY
async function restoreSplitNode(
  saved: SavedSplitNode,
  projectPath: string,
  config: AppConfig,
): Promise<SplitNode | null> {
  if (saved.type === 'leaf') {
    const shell =
      config.availableShells.find((s) => s.name === saved.pane.shellName)
      ?? config.availableShells.find((s) => s.name === config.defaultShell)
      ?? config.availableShells[0];
    if (!shell) return null;
    try {
      const ptyId = await invoke<number>('create_pty', {
        shell: shell.command,
        args: shell.args ?? [],
        cwd: projectPath,
      });
      useAppStore.getState().upsertSession(createTerminalSessionMeta(shell.name, ptyId, projectPath));
      return {
        type: 'leaf',
        pane: {
          id: genId(),
          sessionId: getSessionIdForPty(ptyId),
          shellName: shell.name,
          runCommand: saved.pane.runCommand,
          status: 'idle' as PaneStatus,
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
    const restored = await restoreSplitNode(child, projectPath, config);
    if (restored) children.push(restored);
  }
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return {
    type: 'split',
    direction: saved.direction,
    children,
    sizes: children.length === saved.sizes.length ? [...saved.sizes] : children.map(() => 100 / children.length),
  };
}

export async function restoreLayout(
  projectId: string,
  savedLayout: SavedProjectLayout,
  projectPath: string,
  config: AppConfig,
): Promise<void> {
  const tabs: TerminalTab[] = [];
  for (const savedTab of savedLayout.tabs) {
    const layout = await restoreSplitNode(savedTab.splitLayout, projectPath, config);
    if (layout) {
      tabs.push({
        id: genId(),
        customTitle: savedTab.customTitle,
        splitLayout: layout,
        status: 'idle',
      });
    }
  }
  if (tabs.length === 0) return;
  const activeTabId = tabs[savedLayout.activeTabIndex]?.id ?? tabs[0]?.id ?? '';
  useAppStore.setState((state) => {
    const newStates = new Map(state.projectStates);
    newStates.set(projectId, { id: projectId, tabs, activeTabId });
    return { projectStates: newStates };
  });
}

// 每个项目的展开目录集合（运行时状态）
const expandedDirsMap = new Map<string, Set<string>>();

export function initExpandedDirs(projectId: string, dirs: string[]) {
  expandedDirsMap.set(projectId, new Set(dirs));
}

export function isExpanded(projectId: string, path: string): boolean {
  return expandedDirsMap.get(projectId)?.has(path) ?? false;
}

export function toggleExpandedDir(projectId: string, path: string, expanded: boolean) {
  let set = expandedDirsMap.get(projectId);
  if (!set) {
    set = new Set();
    expandedDirsMap.set(projectId, set);
  }
  if (expanded) {
    set.add(path);
  } else {
    set.delete(path);
  }
  saveExpandedDirsToConfig(projectId);
}

// 保存展开目录到配置（防抖）
const saveExpandedTimers = new Map<string, ReturnType<typeof setTimeout>>();

function doSaveExpandedDirs(projectId: string) {
  const { config } = useAppStore.getState();
  const dirs = Array.from(expandedDirsMap.get(projectId) ?? []);
  const newConfig = {
    ...config,
    projects: config.projects.map((p) =>
      p.id === projectId ? { ...p, expandedDirs: dirs } : p
    ),
  };
  useAppStore.getState().setConfig(newConfig);
  invoke('save_config', { config: newConfig });
}

function saveExpandedDirsToConfig(projectId: string) {
  const existing = saveExpandedTimers.get(projectId);
  if (existing) clearTimeout(existing);
  saveExpandedTimers.set(projectId, setTimeout(() => {
    saveExpandedTimers.delete(projectId);
    doSaveExpandedDirs(projectId);
  }, 500));
}

export function flushExpandedDirsToConfig(projectId: string) {
  const existing = saveExpandedTimers.get(projectId);
  if (existing) {
    clearTimeout(existing);
    saveExpandedTimers.delete(projectId);
  }
  doSaveExpandedDirs(projectId);
}

// 每个项目独立的防抖 timer
const saveLayoutTimers = new Map<string, ReturnType<typeof setTimeout>>();

function doSaveLayout(projectId: string) {
  const { config, projectStates } = useAppStore.getState();
  const ps = projectStates.get(projectId);
  if (!ps) return;
  const savedLayout = serializeLayout(ps);
  const newConfig = {
    ...config,
    projects: config.projects.map((p) =>
      p.id === projectId ? { ...p, savedLayout } : p
    ),
  };
  useAppStore.getState().setConfig(newConfig);
  invoke('save_config', { config: newConfig });
}

export function saveLayoutToConfig(projectId: string) {
  const existing = saveLayoutTimers.get(projectId);
  if (existing) clearTimeout(existing);
  saveLayoutTimers.set(projectId, setTimeout(() => {
    saveLayoutTimers.delete(projectId);
    doSaveLayout(projectId);
  }, 500));
}

// 立即保存（不防抖，用于 beforeunload / 项目切换）
export function flushLayoutToConfig(projectId: string) {
  const existing = saveLayoutTimers.get(projectId);
  if (existing) {
    clearTimeout(existing);
    saveLayoutTimers.delete(projectId);
  }
  doSaveLayout(projectId);
}

function ensureTree(config: AppConfig): AppConfig {
  if (config.projectTree && config.projectTree.length > 0) return config;
  if (config.projectOrdering || config.projectGroups) {
    return { ...config, projectTree: migrateToTree(config), projectGroups: undefined, projectOrdering: undefined };
  }
  return { ...config, projectTree: config.projects.map((p) => p.id) };
}

interface AppStore {
  // 配置
  config: AppConfig;
  setConfig: (config: AppConfig) => void;
  sessions: Map<number, TerminalSessionMeta>;
  activePaneByTab: Map<string, string>;
  upsertSession: (session: TerminalSessionMeta) => void;
  updateSessionPhase: (ptyId: number, phase: SessionPhase, patch?: Partial<TerminalSessionMeta>) => void;
  recordSessionCommand: (ptyId: number, command: string, updatedAt?: number) => void;
  finishSessionCommand: (ptyId: number, exitCode: number | undefined, phase: SessionPhase, updatedAt?: number) => void;
  removeSession: (ptyId: number) => void;
  setPaneRunCommand: (tabId: string, paneId: string, runCommand?: string) => void;
  setActivePaneForTab: (tabId: string, paneId: string) => void;
  clearActivePaneForTab: (tabId: string) => void;

  // 项目
  activeProjectId: string | null;
  projectStates: Map<string, ProjectState>;
  setActiveProject: (id: string) => void;
  addProject: (project: ProjectConfig) => void;
  removeProject: (id: string) => void;

  // Tab
  addTab: (projectId: string, tab: TerminalTab) => void;
  removeTab: (projectId: string, tabId: string) => void;
  setActiveTab: (projectId: string, tabId: string) => void;
  setTabCustomTitle: (projectId: string, tabId: string, customTitle?: string) => void;
  updateTabLayout: (projectId: string, tabId: string, layout: SplitNode) => void;

  // Pane 状态
  updatePaneStatusByPty: (ptyId: number, status: PaneStatus) => void;

  // 分组
  createGroup: (name: string, parentGroupId?: string) => void;
  removeGroup: (groupId: string) => void;
  renameGroup: (groupId: string, name: string) => void;
  toggleGroupCollapse: (groupId: string) => void;
  moveItem: (itemId: string, targetGroupId: string | null, index?: number) => void;
}

export const useAppStore = create<AppStore>((set) => ({
  config: {
    projects: [],
    defaultShell: '',
    availableShells: [],
    uiFontSize: 13,
    terminalFontSize: 14,
    theme: getDefaultThemeConfig(),
  },
  setConfig: (config) => set({ config }),
  sessions: new Map(),
  activePaneByTab: new Map(),
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
      return { sessions };
    }),
  updateSessionPhase: (ptyId, phase, patch) =>
    set((state) => {
      const existing = state.sessions.get(ptyId);
      if (!existing) return state;

      const now = patch?.updatedAt ?? Date.now();
      const shouldSettleActiveCommand =
        existing.activeCommand && existing.activeCommand.status === 'running' && (phase === 'ready' || phase === 'waiting-input');
      const settledActiveCommand: CommandBlock | undefined = shouldSettleActiveCommand && existing.activeCommand
        ? {
            ...existing.activeCommand,
            finishedAt: now,
            status: 'completed',
          }
        : existing.activeCommand;
      const commands = shouldSettleActiveCommand
        ? existing.commands.map((command) =>
            command.id === existing.activeCommand?.id
              ? { ...command, finishedAt: now, status: 'completed' as const }
              : command,
          )
        : existing.commands;

      const sessions = new Map(state.sessions);
      sessions.set(ptyId, {
        ...existing,
        ...patch,
        commands,
        phase,
        updatedAt: now,
        activeCommand: settledActiveCommand,
      });

      let projectStatesChanged = false;
      const projectStates = new Map(state.projectStates);
      for (const [projectId, projectState] of projectStates) {
        let tabsChanged = false;
        const tabs = projectState.tabs.map((tab) => {
          const nextLayout = updatePaneSessionPhase(tab.splitLayout, ptyId, phase);
          if (nextLayout === tab.splitLayout) return tab;
          tabsChanged = true;
          return { ...tab, splitLayout: nextLayout };
        });

        if (tabsChanged) {
          projectStates.set(projectId, { ...projectState, tabs });
          projectStatesChanged = true;
        }
      }

      return projectStatesChanged ? { sessions, projectStates } : { sessions };
    }),
  recordSessionCommand: (ptyId, command, updatedAt) =>
    set((state) => {
      const existing = state.sessions.get(ptyId);
      if (!existing) return state;

      const now = updatedAt ?? Date.now();
      const settledCommands = existing.activeCommand && existing.activeCommand.status === 'running'
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
      const sessions = new Map(state.sessions);
      sessions.set(ptyId, {
        ...existing,
        commands: [...settledCommands, nextCommand].slice(-12),
        lastCommand: command,
        phase: 'running',
        updatedAt: now,
        activeCommand: nextCommand,
      });
      return { sessions };
    }),
  finishSessionCommand: (ptyId, exitCode, phase, updatedAt) =>
    set((state) => {
      const existing = state.sessions.get(ptyId);
      if (!existing) return state;

      const now = updatedAt ?? Date.now();
      const finishedStatus: CommandBlock['status'] =
        exitCode == null
          ? 'interrupted'
          : exitCode === 0
            ? 'success'
            : 'error';
      const nextActiveCommand: CommandBlock | undefined = existing.activeCommand
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
      return { sessions };
    }),
  removeSession: (ptyId) =>
    set((state) => {
      if (!state.sessions.has(ptyId)) return state;
      const sessions = new Map(state.sessions);
      sessions.delete(ptyId);
      return { sessions };
    }),
  setPaneRunCommand: (tabId, paneId, runCommand) =>
    set((state) => {
      let changed = false;
      const projectStates = new Map(state.projectStates);

      for (const [projectId, projectState] of projectStates) {
        const tabIndex = projectState.tabs.findIndex((tab) => tab.id == tabId);
        if (tabIndex < 0) continue;
        const tabs = projectState.tabs.map((tab) => {
          if (tab.id != tabId) return tab;
          const nextLayout = updatePaneRunCommand(tab.splitLayout, paneId, runCommand);
          if (nextLayout === tab.splitLayout) return tab;
          changed = true;
          return { ...tab, splitLayout: nextLayout };
        });
        projectStates.set(projectId, { ...projectState, tabs });
        break;
      }

      if (!changed) return state;
      return { projectStates };
    }),
  setActivePaneForTab: (tabId, paneId) =>
    set((state) => {
      const activePaneByTab = new Map(state.activePaneByTab);
      activePaneByTab.set(tabId, paneId);
      return { activePaneByTab };
    }),
  clearActivePaneForTab: (tabId) =>
    set((state) => {
      if (!state.activePaneByTab.has(tabId)) return state;
      const activePaneByTab = new Map(state.activePaneByTab);
      activePaneByTab.delete(tabId);
      return { activePaneByTab };
    }),

  activeProjectId: null,
  projectStates: new Map(),

  setActiveProject: (id) => set({ activeProjectId: id }),

  addProject: (project) =>
    set((state) => {
      const config = ensureTree(state.config);
      const newTree = [...(config.projectTree ?? []), project.id];
      const newConfig = {
        ...config,
        projects: [...config.projects, project],
        projectTree: newTree,
      };
      const newStates = new Map(state.projectStates);
      newStates.set(project.id, { id: project.id, tabs: [], activeTabId: '' });
      return {
        config: newConfig,
        projectStates: newStates,
        activeProjectId: state.activeProjectId ?? project.id,
      };
    }),

  removeProject: (id) =>
    set((state) => {
      expandedDirsMap.delete(id);
      const timer = saveExpandedTimers.get(id);
      if (timer) { clearTimeout(timer); saveExpandedTimers.delete(id); }

      const removedProjectState = state.projectStates.get(id);
      const removedPtyIds = removedProjectState
        ? removedProjectState.tabs.flatMap((tab) => collectPtyIds(tab.splitLayout))
        : [];

      const newTree = deepCloneTree(state.config.projectTree ?? []);
      removeProjectFromTree(newTree, id);
      const newConfig = {
        ...state.config,
        projects: state.config.projects.filter((p) => p.id !== id),
        projectTree: newTree,
      };
      const newStates = new Map(state.projectStates);
      newStates.delete(id);
      const sessions = new Map(state.sessions);
      removedPtyIds.forEach((ptyId) => sessions.delete(ptyId));
      const activePaneByTab = new Map(state.activePaneByTab);
      removedProjectState?.tabs.forEach((tab) => activePaneByTab.delete(tab.id));
      const newActive =
        state.activeProjectId === id
          ? newConfig.projects[0]?.id ?? null
          : state.activeProjectId;
      return { config: newConfig, projectStates: newStates, activeProjectId: newActive, sessions, activePaneByTab };
    }),

  addTab: (projectId, tab) =>
    set((state) => {
      const newStates = new Map(state.projectStates);
      const ps = newStates.get(projectId);
      if (!ps) return state;
      newStates.set(projectId, {
        ...ps,
        tabs: [...ps.tabs, tab],
        activeTabId: tab.id,
      });
      return { projectStates: newStates };
    }),

  removeTab: (projectId, tabId) =>
    set((state) => {
      const newStates = new Map(state.projectStates);
      const ps = newStates.get(projectId);
      if (!ps) return state;
      const removedTab = ps.tabs.find((tab) => tab.id === tabId);
      const removedPtyIds = removedTab ? collectPtyIds(removedTab.splitLayout) : [];
      const newTabs = ps.tabs.filter((t) => t.id !== tabId);
      const newActive =
        ps.activeTabId === tabId ? (newTabs[newTabs.length - 1]?.id ?? '') : ps.activeTabId;
      newStates.set(projectId, { ...ps, tabs: newTabs, activeTabId: newActive });
      const sessions = new Map(state.sessions);
      removedPtyIds.forEach((ptyId) => sessions.delete(ptyId));
      const activePaneByTab = new Map(state.activePaneByTab);
      activePaneByTab.delete(tabId);
      return { projectStates: newStates, sessions, activePaneByTab };
    }),

  setActiveTab: (projectId, tabId) =>
    set((state) => {
      const newStates = new Map(state.projectStates);
      const ps = newStates.get(projectId);
      if (!ps) return state;
      newStates.set(projectId, { ...ps, activeTabId: tabId });
      return { projectStates: newStates };
    }),

  setTabCustomTitle: (projectId, tabId, customTitle) =>
    set((state) => {
      const newStates = new Map(state.projectStates);
      const ps = newStates.get(projectId);
      if (!ps) return state;
      newStates.set(projectId, {
        ...ps,
        tabs: ps.tabs.map((tab) =>
          tab.id === tabId
            ? { ...tab, customTitle: customTitle?.trim() ? customTitle.trim() : undefined }
            : tab,
        ),
      });
      return { projectStates: newStates };
    }),

  updateTabLayout: (projectId, tabId, layout) =>
    set((state) => {
      const newStates = new Map(state.projectStates);
      const ps = newStates.get(projectId);
      if (!ps) return state;
      newStates.set(projectId, {
        ...ps,
        tabs: ps.tabs.map((t) =>
          t.id === tabId ? { ...t, splitLayout: layout, status: getHighestStatus(layout) } : t
        ),
      });
      return { projectStates: newStates };
    }),

  updatePaneStatusByPty: (ptyId, status) =>
    set((state) => {
      // 快速检查：是否有任何 pane 包含此 ptyId
      let found = false;
      for (const ps of state.projectStates.values()) {
        if (found) break;
        for (const tab of ps.tabs) {
          if (collectPtyIds(tab.splitLayout).includes(ptyId)) { found = true; break; }
        }
      }
      if (!found) return state;

      const newStates = new Map(state.projectStates);
      let changed = false;
      for (const [pid, ps] of newStates) {
        let tabsChanged = false;
        const updatedTabs = ps.tabs.map((tab) => {
          const newLayout = updatePaneStatus(tab.splitLayout, ptyId, status);
          if (newLayout === tab.splitLayout) return tab;
          tabsChanged = true;
          return { ...tab, splitLayout: newLayout, status: getHighestStatus(newLayout) };
        });
        if (tabsChanged) {
          newStates.set(pid, { ...ps, tabs: updatedTabs });
          changed = true;
        }
      }
      return changed ? { projectStates: newStates } : state;
    }),

  createGroup: (name, parentGroupId) =>
    set((state) => {
      const config = ensureTree(state.config);
      const group: ProjectGroup = { id: genId(), name, collapsed: false, children: [] };
      const newTree = deepCloneTree(config.projectTree ?? []);
      insertIntoTree(newTree, parentGroupId ?? null, group);
      return { config: { ...config, projectTree: newTree } };
    }),

  removeGroup: (groupId) =>
    set((state) => {
      const newTree = deepCloneTree(state.config.projectTree ?? []);
      removeGroupAndPromoteChildren(newTree, groupId);
      return { config: { ...state.config, projectTree: newTree } };
    }),

  renameGroup: (groupId, name) =>
    set((state) => {
      const newTree = deepCloneTree(state.config.projectTree ?? []);
      updateGroupInTree(newTree, groupId, (g) => ({ ...g, name }));
      return { config: { ...state.config, projectTree: newTree } };
    }),

  toggleGroupCollapse: (groupId) =>
    set((state) => {
      const newTree = deepCloneTree(state.config.projectTree ?? []);
      updateGroupInTree(newTree, groupId, (g) => ({ ...g, collapsed: !g.collapsed }));
      return { config: { ...state.config, projectTree: newTree } };
    }),

  moveItem: (itemId, targetGroupId, index) =>
    set((state) => {
      const config = ensureTree(state.config);
      const newTree = deepCloneTree(config.projectTree ?? []);
      const removed = removeFromTree(newTree, itemId);
      if (!removed) return state;
      insertIntoTree(newTree, targetGroupId, removed, index);
      return { config: { ...config, projectTree: newTree } };
    }),

}));
