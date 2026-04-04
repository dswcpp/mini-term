import type { FileEntry, ShellKind } from '../../types';
import type { ActiveToken } from './types';

export interface PathQuery {
  basenamePrefix: string;
  directoryPath: string;
  displayPrefix: string;
  separator: '/' | '\\';
}

function preferredSeparator(cwd: string, rawPrefix: string): '/' | '\\' {
  if (rawPrefix.includes('\\')) return '\\';
  if (rawPrefix.includes('/')) return '/';
  if (cwd.includes('\\') || /^[A-Za-z]:/.test(cwd)) return '\\';
  return '/';
}

function normalizeSlashes(value: string) {
  return value.replace(/\\/g, '/');
}

function extractRoot(path: string): { root: string; rest: string } {
  if (/^\/\/[^/]+\/[^/]+/.test(path)) {
    const [, server = '', share = ''] = path.match(/^\/\/([^/]+)\/([^/]+)/) ?? [];
    const root = `//${server}/${share}`;
    return { root, rest: path.slice(root.length).replace(/^\/+/, '') };
  }

  if (/^[A-Za-z]:\//.test(path)) {
    return { root: path.slice(0, 3), rest: path.slice(3) };
  }

  if (/^[A-Za-z]:$/.test(path)) {
    return { root: `${path}/`, rest: '' };
  }

  if (path.startsWith('/')) {
    return { root: '/', rest: path.slice(1) };
  }

  return { root: '', rest: path };
}

export function normalizePath(value: string) {
  const normalized = normalizeSlashes(value);
  const { root, rest } = extractRoot(normalized);
  const segments = rest.split('/').filter(Boolean);
  const resolved: string[] = [];

  for (const segment of segments) {
    if (segment === '.') continue;
    if (segment === '..') {
      if (resolved.length > 0 && resolved[resolved.length - 1] !== '..') {
        resolved.pop();
      } else if (!root) {
        resolved.push(segment);
      }
      continue;
    }

    resolved.push(segment);
  }

  if (!root) {
    return resolved.join('/');
  }

  return resolved.length > 0 ? `${root}${resolved.join('/')}` : root.replace(/\/$/, '');
}

export function isAbsolutePath(value: string) {
  return /^([A-Za-z]:[\\/]|\\\\|\/\/|\/)/.test(value);
}

export function joinPath(basePath: string, nextPath: string) {
  if (!nextPath) return normalizePath(basePath);
  if (isAbsolutePath(nextPath)) return normalizePath(nextPath);
  return normalizePath(`${normalizePath(basePath).replace(/\/+$/, '')}/${nextPath}`);
}

export function createPathQuery(cwd: string, activeToken: ActiveToken): PathQuery {
  const fragment = activeToken.valuePrefix;
  const separator = preferredSeparator(cwd, activeToken.rawPrefix);
  const normalizedFragment = normalizeSlashes(fragment);
  const slashIndex = normalizedFragment.lastIndexOf('/');
  const directoryFragment = slashIndex >= 0 ? normalizedFragment.slice(0, slashIndex + 1) : '';
  const basenamePrefix = slashIndex >= 0 ? normalizedFragment.slice(slashIndex + 1) : normalizedFragment;

  return {
    basenamePrefix,
    directoryPath: directoryFragment ? joinPath(cwd, directoryFragment) : normalizePath(cwd),
    displayPrefix: directoryFragment.replace(/\//g, separator),
    separator,
  };
}

function escapeInsideDoubleQuotes(value: string, shellKind: ShellKind) {
  switch (shellKind) {
    case 'powershell':
    case 'pwsh':
      return value.replace(/`/g, '``').replace(/"/g, '`"');
    case 'cmd':
      return value.replace(/"/g, '""');
    default:
      return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }
}

function escapeUnquoted(value: string, shellKind: ShellKind) {
  if (!/\s/.test(value)) {
    return value;
  }

  switch (shellKind) {
    case 'bash':
    case 'zsh':
      return value.replace(/([\\\s])/g, '\\$1');
    case 'cmd':
    case 'powershell':
    case 'pwsh':
      return `"${escapeInsideDoubleQuotes(value, shellKind)}"`;
    default:
      return `"${escapeInsideDoubleQuotes(value, 'cmd')}"`;
  }
}

function buildDisplayPath(displayPrefix: string, entry: FileEntry, separator: '/' | '\\') {
  return `${displayPrefix}${entry.name}${entry.isDir ? separator : ''}`;
}

export function buildPathCandidateText(args: {
  activeToken: ActiveToken;
  entry: FileEntry;
  shellKind: ShellKind;
  displayPrefix: string;
  separator: '/' | '\\';
}): { insertText: string; label: string; commitSuffix: string } {
  const displayPath = buildDisplayPath(args.displayPrefix, args.entry, args.separator);
  const tokenHasLeadingQuote = Boolean(args.activeToken.leadingQuote && args.activeToken.raw.startsWith(args.activeToken.leadingQuote));
  const quoteChar = tokenHasLeadingQuote ? args.activeToken.leadingQuote : undefined;
  const keepClosingQuote =
    Boolean(quoteChar) &&
    args.activeToken.closedQuote &&
    args.activeToken.raw.endsWith(quoteChar as '"' | "'");

  if (quoteChar) {
    const encoded = quoteChar === '"' ? escapeInsideDoubleQuotes(displayPath, args.shellKind) : displayPath;
    return {
      insertText: `${quoteChar}${encoded}${keepClosingQuote ? quoteChar : ''}`,
      label: `${quoteChar}${displayPath}${keepClosingQuote ? quoteChar : ''}`,
      commitSuffix: args.entry.isDir || args.activeToken.openQuote ? '' : ' ',
    };
  }

  const insertText = escapeUnquoted(displayPath, args.shellKind);
  return {
    insertText,
    label: displayPath,
    commitSuffix: args.entry.isDir ? '' : ' ',
  };
}
