const STATUS_PRIORITY: Record<string, number> = {
  C: 6,
  D: 5,
  M: 4,
  A: 3,
  R: 2,
  '?': 1,
};

function normalizePath(value: string) {
  return value.replace(/[\\/]+/g, '/').replace(/\/$/, '');
}

export function getGitStatusLabelPriority(statusLabel: string) {
  return STATUS_PRIORITY[statusLabel] ?? 0;
}

export function listAncestorDirectories(path: string) {
  const normalizedPath = normalizePath(path);
  const directories = ['.'];

  if (!normalizedPath || normalizedPath === '.') {
    return directories;
  }

  const segments = normalizedPath.split('/');
  if (segments.length <= 1) {
    return directories;
  }

  segments.pop();
  let current = '';
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    directories.push(current);
  }

  return directories;
}

export function buildDirectoryStatusIndex(statuses: Iterable<{ path: string; statusLabel: string }>) {
  const directoryStatusIndex = new Map<string, string>();

  for (const status of statuses) {
    const priority = getGitStatusLabelPriority(status.statusLabel);
    if (priority === 0) {
      continue;
    }

    for (const directoryPath of listAncestorDirectories(status.path)) {
      const currentLabel = directoryStatusIndex.get(directoryPath);
      if (priority > getGitStatusLabelPriority(currentLabel ?? '')) {
        directoryStatusIndex.set(directoryPath, status.statusLabel);
      }
    }
  }

  return directoryStatusIndex;
}
