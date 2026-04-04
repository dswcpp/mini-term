import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store';
import type { FsChangePayload, PtySessionCommandPayload } from '../types';
import { subscribeFsChange, subscribePtySessionCommandStarted } from './tauriEventHub';

type ProjectFsListener = (events: FsChangePayload[]) => void;
type ProjectGitDirtyListener = () => void;

const WATCH_DEBOUNCE_MS = 180;
const GIT_DIRTY_DEBOUNCE_MS = 320;

const projectFsListeners = new Map<string, Set<ProjectFsListener>>();
const projectGitDirtyListeners = new Map<string, Set<ProjectGitDirtyListener>>();
const projectWatchRefs = new Map<string, number>();
const queuedFsChanges = new Map<string, FsChangePayload[]>();
const fsFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
const gitDirtyTimers = new Map<string, ReturnType<typeof setTimeout>>();

let runtimeStarted = false;
let disposeFsSubscription: (() => void) | undefined;
let disposeCommandSubscription: (() => void) | undefined;

function normalizePath(value: string) {
  return value.replace(/\\/g, '/').replace(/\/+$/, '');
}

function resolveProjectPathForScope(scope: string): string | undefined {
  const normalizedScope = normalizePath(scope);
  const projects = useAppStore.getState().config.projects;

  let bestMatch: string | undefined;
  for (const project of projects) {
    const normalizedProjectPath = normalizePath(project.path);
    if (
      normalizedScope === normalizedProjectPath
      || normalizedScope.startsWith(`${normalizedProjectPath}/`)
      || normalizedProjectPath.startsWith(`${normalizedScope}/`)
    ) {
      if (!bestMatch || normalizedProjectPath.length > bestMatch.length) {
        bestMatch = normalizedProjectPath;
      }
    }
  }

  return bestMatch;
}

function scheduleFsFlush(projectPath: string) {
  const existing = fsFlushTimers.get(projectPath);
  if (existing) {
    clearTimeout(existing);
  }

  fsFlushTimers.set(
    projectPath,
    setTimeout(() => {
      fsFlushTimers.delete(projectPath);
      const events = queuedFsChanges.get(projectPath);
      queuedFsChanges.delete(projectPath);
      if (!events || events.length === 0) {
        return;
      }

      useAppStore.getState().recordProjectFsChanges(projectPath, events);
      projectFsListeners.get(projectPath)?.forEach((listener) => listener(events));
      scheduleGitDirty(projectPath);
    }, WATCH_DEBOUNCE_MS),
  );
}

function scheduleGitDirty(projectPath: string) {
  const existing = gitDirtyTimers.get(projectPath);
  if (existing) {
    clearTimeout(existing);
  }

  gitDirtyTimers.set(
    projectPath,
    setTimeout(() => {
      gitDirtyTimers.delete(projectPath);
      useAppStore.getState().markProjectGitDirty(projectPath);
      projectGitDirtyListeners.get(projectPath)?.forEach((listener) => listener());
    }, GIT_DIRTY_DEBOUNCE_MS),
  );
}

function shouldInvalidateGitFromCommand(payload: PtySessionCommandPayload) {
  const command = payload.command.trim().toLowerCase();
  if (!command) {
    return false;
  }

  const [first, second = ''] = command.split(/\s+/, 3);
  if (first !== 'git') {
    return false;
  }

  if (['status', 'diff', 'show', 'log', 'grep', 'config'].includes(second)) {
    return false;
  }

  return true;
}

function ensureWorkspaceRuntimeStarted() {
  if (runtimeStarted) {
    return;
  }

  runtimeStarted = true;
  disposeFsSubscription = subscribeFsChange((payload) => {
    const projectPath = normalizePath(payload.projectPath);
    const events = queuedFsChanges.get(projectPath) ?? [];
    events.push({
      ...payload,
      projectPath,
      path: normalizePath(payload.path),
    });
    queuedFsChanges.set(projectPath, events);
    scheduleFsFlush(projectPath);
  });

  disposeCommandSubscription = subscribePtySessionCommandStarted((payload) => {
    if (!shouldInvalidateGitFromCommand(payload)) {
      return;
    }

    const scopeProjectPath = payload.usageScope ? resolveProjectPathForScope(payload.usageScope) : undefined;
    if (!scopeProjectPath) {
      return;
    }

    scheduleGitDirty(scopeProjectPath);
  });
}

export function subscribeProjectFs(projectPath: string, listener: ProjectFsListener) {
  ensureWorkspaceRuntimeStarted();
  const normalizedProjectPath = normalizePath(projectPath);
  const listeners = projectFsListeners.get(normalizedProjectPath) ?? new Set<ProjectFsListener>();
  listeners.add(listener);
  projectFsListeners.set(normalizedProjectPath, listeners);

  return () => {
    const current = projectFsListeners.get(normalizedProjectPath);
    if (!current) {
      return;
    }
    current.delete(listener);
    if (current.size === 0) {
      projectFsListeners.delete(normalizedProjectPath);
    }
  };
}

export function subscribeProjectGitDirty(projectPath: string, listener: ProjectGitDirtyListener) {
  ensureWorkspaceRuntimeStarted();
  const normalizedProjectPath = normalizePath(projectPath);
  const listeners = projectGitDirtyListeners.get(normalizedProjectPath) ?? new Set<ProjectGitDirtyListener>();
  listeners.add(listener);
  projectGitDirtyListeners.set(normalizedProjectPath, listeners);

  return () => {
    const current = projectGitDirtyListeners.get(normalizedProjectPath);
    if (!current) {
      return;
    }
    current.delete(listener);
    if (current.size === 0) {
      projectGitDirtyListeners.delete(normalizedProjectPath);
    }
  };
}

export function retainProjectTreeWatch(projectPath: string) {
  ensureWorkspaceRuntimeStarted();
  const normalizedProjectPath = normalizePath(projectPath);
  const nextRefCount = (projectWatchRefs.get(normalizedProjectPath) ?? 0) + 1;
  projectWatchRefs.set(normalizedProjectPath, nextRefCount);

  if (nextRefCount === 1) {
    void invoke('watch_directory', {
      path: projectPath,
      projectPath,
      recursive: true,
    }).catch(() => undefined);
  }

  return () => {
    const currentRefCount = projectWatchRefs.get(normalizedProjectPath);
    if (!currentRefCount) {
      return;
    }

    if (currentRefCount <= 1) {
      projectWatchRefs.delete(normalizedProjectPath);
      void invoke('unwatch_directory', { path: projectPath }).catch(() => undefined);
      return;
    }

    projectWatchRefs.set(normalizedProjectPath, currentRefCount - 1);
  };
}

export async function stopWorkspaceRuntimeForTests() {
  disposeFsSubscription?.();
  disposeCommandSubscription?.();
  disposeFsSubscription = undefined;
  disposeCommandSubscription = undefined;
  runtimeStarted = false;

  projectFsListeners.clear();
  projectGitDirtyListeners.clear();
  projectWatchRefs.clear();
  queuedFsChanges.clear();

  for (const timer of fsFlushTimers.values()) {
    clearTimeout(timer);
  }
  fsFlushTimers.clear();

  for (const timer of gitDirtyTimers.values()) {
    clearTimeout(timer);
  }
  gitDirtyTimers.clear();
}
