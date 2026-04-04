const URL_SCHEME_RE = /^[a-z][a-z\d+.-]*:/i;
const WINDOWS_DRIVE_RE = /^[a-z]:[\\/]/i;
const UNC_PATH_RE = /^[/\\]{2}/;

export function normalizePathSeparators(path: string) {
  return path.replace(/\\/g, '/');
}

export function isAbsoluteLocalPath(path: string) {
  return WINDOWS_DRIVE_RE.test(path) || UNC_PATH_RE.test(path) || path.startsWith('/');
}

export function dirname(path: string) {
  const normalized = normalizePathSeparators(path);
  const lastSeparatorIndex = normalized.lastIndexOf('/');
  if (lastSeparatorIndex < 0) return '';
  if (lastSeparatorIndex === 0) return '/';
  return normalized.slice(0, lastSeparatorIndex);
}

export function splitTarget(target: string) {
  const queryIndex = target.indexOf('?');
  const hashIndex = target.indexOf('#');
  const stopIndex = [queryIndex, hashIndex]
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];

  if (stopIndex === undefined) {
    return { pathname: target, suffix: '' };
  }

  return {
    pathname: target.slice(0, stopIndex),
    suffix: target.slice(stopIndex),
  };
}

export function resolveRelativePath(baseDir: string, relativePath: string) {
  const normalizedBase = normalizePathSeparators(baseDir);
  const normalizedRelative = normalizePathSeparators(relativePath);
  const prefix = normalizedBase.startsWith('//') ? '//' : normalizedBase.startsWith('/') ? '/' : '';
  const baseSegments = normalizedBase.replace(/^\/+/, '').split('/').filter(Boolean);
  const relativeSegments = normalizedRelative.split('/').filter(Boolean);
  const minSegments =
    prefix === '//'
      ? 2
      : WINDOWS_DRIVE_RE.test(`${baseSegments[0] ?? ''}/`)
        ? 1
        : 0;
  const resolvedSegments = [...baseSegments];

  for (const segment of relativeSegments) {
    if (segment === '.') continue;
    if (segment === '..') {
      if (resolvedSegments.length > minSegments) {
        resolvedSegments.pop();
      }
      continue;
    }
    resolvedSegments.push(segment);
  }

  return `${prefix}${resolvedSegments.join('/')}`;
}

export function resolveLocalPath(baseFilePath: string, target: string) {
  const trimmedTarget = target.trim();
  if (!trimmedTarget || trimmedTarget.startsWith('#')) {
    return null;
  }

  const { pathname } = splitTarget(trimmedTarget);
  if (!pathname) {
    return null;
  }

  if (isAbsoluteLocalPath(pathname)) {
    return normalizePathSeparators(pathname);
  }

  if (URL_SCHEME_RE.test(pathname)) {
    return null;
  }

  return resolveRelativePath(dirname(baseFilePath), pathname);
}

export function isExternalHref(href: string) {
  return (URL_SCHEME_RE.test(href) && !isAbsoluteLocalPath(href)) || href.startsWith('mailto:') || href.startsWith('tel:');
}
