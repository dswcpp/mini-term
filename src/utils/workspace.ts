import type {
  RecentWorkspaceEntry,
  WorkspaceConfig,
  WorkspaceRootConfig,
  WorkspaceRootRole,
} from '../types';

function now() {
  return Date.now();
}

export function normalizeWorkspacePath(value: string) {
  return value.replace(/[\\/]+/g, '/').replace(/\/$/, '');
}

export function getPathBaseName(path: string) {
  const normalized = normalizeWorkspacePath(path);
  const segments = normalized.split('/');
  return segments[segments.length - 1] || path;
}

export function createWorkspaceRoot(path: string, id: string, role: WorkspaceRootRole = 'member'): WorkspaceRootConfig {
  return {
    id,
    name: getPathBaseName(path),
    path,
    role,
  };
}

export function ensureSinglePrimaryRoot(roots: WorkspaceRootConfig[]) {
  let primarySeen = false;
  return roots.map((root, index) => {
    const shouldBePrimary = root.role === 'primary' && !primarySeen;
    if (shouldBePrimary) {
      primarySeen = true;
      return root;
    }
    if (!primarySeen && index === 0) {
      primarySeen = true;
      return { ...root, role: 'primary' };
    }
    return { ...root, role: 'member' };
  });
}

export function getWorkspacePrimaryRoot(workspace: WorkspaceConfig | undefined | null) {
  if (!workspace) {
    return undefined;
  }
  return workspace.roots.find((root) => root.role === 'primary') ?? workspace.roots[0];
}

export function getWorkspacePrimaryRootPath(workspace: WorkspaceConfig | undefined | null) {
  return getWorkspacePrimaryRoot(workspace)?.path;
}

export function getWorkspaceDisplayName(paths: string[], explicitName?: string) {
  if (explicitName?.trim()) {
    return explicitName.trim();
  }

  if (paths.length === 0) {
    return 'Workspace';
  }

  if (paths.length === 1) {
    return getPathBaseName(paths[0]);
  }

  return `${getPathBaseName(paths[0])} +${paths.length - 1}`;
}

export function createWorkspaceConfig(args: {
  id: string;
  paths: string[];
  rootIds?: string[];
  name?: string;
  pinned?: boolean;
  accent?: string;
  savedLayout?: WorkspaceConfig['savedLayout'];
  expandedDirsByRoot?: WorkspaceConfig['expandedDirsByRoot'];
  createdAt?: number;
  lastOpenedAt?: number;
}): WorkspaceConfig {
  const uniquePaths = Array.from(new Set(args.paths.map(normalizeWorkspacePath)));
  const roots = ensureSinglePrimaryRoot(
    uniquePaths.map((path, index) =>
      createWorkspaceRoot(path, args.rootIds?.[index] ?? `${args.id}-root-${index + 1}`, index === 0 ? 'primary' : 'member'),
    ),
  );
  const timestamp = args.createdAt ?? now();

  return {
    id: args.id,
    name: getWorkspaceDisplayName(uniquePaths, args.name),
    roots,
    pinned: args.pinned ?? false,
    accent: args.accent,
    savedLayout: args.savedLayout,
    expandedDirsByRoot: args.expandedDirsByRoot ?? {},
    createdAt: timestamp,
    lastOpenedAt: args.lastOpenedAt ?? timestamp,
  };
}

export function buildRecentWorkspaceEntry(workspace: WorkspaceConfig): RecentWorkspaceEntry {
  return {
    id: workspace.id,
    name: workspace.name,
    rootPaths: workspace.roots.map((root) => root.path),
    accent: workspace.accent,
    lastOpenedAt: workspace.lastOpenedAt,
    savedLayout: workspace.savedLayout,
    expandedDirsByRoot: workspace.expandedDirsByRoot,
  };
}

export function restoreWorkspaceFromRecent(args: {
  recent: RecentWorkspaceEntry;
  rootIds?: string[];
}): WorkspaceConfig {
  return createWorkspaceConfig({
    id: args.recent.id,
    name: args.recent.name,
    paths: args.recent.rootPaths,
    rootIds: args.rootIds,
    accent: args.recent.accent,
    savedLayout: args.recent.savedLayout,
    expandedDirsByRoot: args.recent.expandedDirsByRoot,
    createdAt: args.recent.lastOpenedAt,
    lastOpenedAt: now(),
  });
}

export function getWorkspaceMatch(workspace: WorkspaceConfig, fullPath: string) {
  const normalizedTarget = normalizeWorkspacePath(fullPath);
  let matchedRoot: WorkspaceRootConfig | undefined;

  for (const root of workspace.roots) {
    const normalizedRoot = normalizeWorkspacePath(root.path);
    if (
      normalizedTarget === normalizedRoot ||
      normalizedTarget.startsWith(`${normalizedRoot}/`)
    ) {
      if (!matchedRoot || normalizedRoot.length > normalizeWorkspacePath(matchedRoot.path).length) {
        matchedRoot = root;
      }
    }
  }

  if (!matchedRoot) {
    return null;
  }

  const normalizedRoot = normalizeWorkspacePath(matchedRoot.path);
  const relativePath =
    normalizedTarget === normalizedRoot
      ? '.'
      : normalizedTarget.slice(normalizedRoot.length + 1);

  return {
    root: matchedRoot,
    relativePath,
  };
}

export function getWorkspaceLookupByRootPath(workspaces: WorkspaceConfig[]) {
  const index = new Map<string, string>();
  for (const workspace of workspaces) {
    for (const root of workspace.roots) {
      index.set(normalizeWorkspacePath(root.path), workspace.id);
    }
  }
  return index;
}
