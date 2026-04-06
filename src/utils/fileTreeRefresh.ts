import type { FsChangePayload } from '../types';

function normalizePath(value: string) {
  return value.replace(/[\\/]+/g, '/').replace(/\/$/, '');
}

function belongsToRoot(path: string, rootPath: string) {
  const normalizedRoot = normalizePath(rootPath);
  const normalizedPath = normalizePath(path);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function listPathAncestorsWithinRoot(path: string, rootPath: string) {
  const normalizedRoot = normalizePath(rootPath);
  const normalizedPath = normalizePath(path);

  if (!belongsToRoot(normalizedPath, normalizedRoot)) {
    return [];
  }

  const ancestors = [normalizedRoot];
  if (normalizedPath === normalizedRoot) {
    return ancestors;
  }

  const relativePath = normalizedPath.slice(normalizedRoot.length + 1);
  const segments = relativePath.split('/');
  let current = normalizedRoot;

  for (const segment of segments) {
    current = `${current}/${segment}`;
    ancestors.push(current);
  }

  return ancestors;
}

export function collectAffectedLoadedDirectories(
  rootPath: string,
  loadedDirectoryPaths: Iterable<string>,
  events: FsChangePayload[],
) {
  const normalizedLoadedDirectories = Array.from(
    new Set(Array.from(loadedDirectoryPaths, (path) => normalizePath(path)).filter((path) => belongsToRoot(path, rootPath))),
  );

  if (normalizedLoadedDirectories.length === 0 || events.length === 0) {
    return [];
  }

  const loadedDirectorySet = new Set(normalizedLoadedDirectories);
  const affectedDirectorySet = new Set<string>();

  for (const event of events) {
    const normalizedEventPath = normalizePath(event.path);

    for (const candidatePath of listPathAncestorsWithinRoot(normalizedEventPath, rootPath)) {
      if (loadedDirectorySet.has(candidatePath)) {
        affectedDirectorySet.add(candidatePath);
      }
    }

    if (event.kind === 'Modify') {
      continue;
    }

    const descendantPrefix = `${normalizedEventPath}/`;
    for (const directoryPath of normalizedLoadedDirectories) {
      if (directoryPath.startsWith(descendantPrefix)) {
        affectedDirectorySet.add(directoryPath);
      }
    }
  }

  return normalizedLoadedDirectories.filter((directoryPath) => affectedDirectorySet.has(directoryPath));
}
