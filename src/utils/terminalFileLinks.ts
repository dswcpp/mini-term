import type { IBufferRange } from '@xterm/xterm';

export interface BufferLineLike {
  readonly isWrapped: boolean;
  readonly length: number;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

export interface BufferLike {
  readonly length: number;
  getLine(y: number): BufferLineLike | undefined;
}

export interface WrappedBufferSegment {
  lineNumber: number;
  text: string;
  startOffset: number;
  endOffset: number;
}

export interface WrappedBufferText {
  text: string;
  startLineNumber: number;
  endLineNumber: number;
  segments: WrappedBufferSegment[];
}

export interface TerminalFileLinkMatch {
  text: string;
  startIndex: number;
  endIndex: number;
  path: string;
  line?: number;
  column?: number;
}

export interface TerminalFileLinkResolutionOptions {
  cwd?: string;
  workspaceRootPaths: string[];
  probeFile: (path: string) => Promise<boolean>;
}

export interface ResolvedTerminalFileLink {
  path: string;
  line?: number;
  column?: number;
}

export interface TerminalLinkModifierState {
  ctrlKey: boolean;
  metaKey: boolean;
  isMac: boolean;
}

interface ParsedPathLocation {
  path: string;
  line?: number;
  column?: number;
}

interface ParsePathLocationOptions {
  allowBareFile: boolean;
}

const QUOTED_PATH_SOURCE =
  '(?:file:\\/\\/[^\\r\\n"\']+|[A-Za-z]:\\\\[^\\r\\n"\']+|\\\\\\\\[^\\r\\n"\']+|\\/[^\\r\\n"\']+|\\.\\.?[\\\\/][^\\r\\n"\']+|(?:[A-Za-z0-9_.-]+[\\\\/])+[^\\r\\n"\']+|[A-Za-z0-9_.-]+\\.[A-Za-z0-9_.-]+(?::\\d+(?::\\d+)?)?)';
const UNQUOTED_PATH_SOURCE =
  '(?:file:\\/\\/[^\\s"`\\])]+|[A-Za-z]:\\\\[^\\s"`\\])]+|\\\\\\\\[^\\s"`\\])]+|\\/[^\\s"`\\])]+|\\.\\.?[\\\\/][^\\s"`\\])]+|(?:[A-Za-z0-9_.-]+[\\\\/])+[^\\s"`\\])]+|[A-Za-z0-9_.-]+\\.[A-Za-z0-9_.-]+(?::\\d+(?::\\d+)?)?)';
const PAREN_LOCATION_SOURCE = '(?:\\(\\d+(?:\\s*,\\s*\\d+)?\\))?';

const PYTHON_TRACEBACK_RE = /File\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)')\s*,\s*line\s+(\d+)/g;
const DOUBLE_QUOTED_PATH_RE = new RegExp(`"(${QUOTED_PATH_SOURCE})"((?::\\d+(?::\\d+)?)|\\(\\d+(?:\\s*,\\s*\\d+)?\\))?`, 'g');
const SINGLE_QUOTED_PATH_RE = new RegExp(`'(${QUOTED_PATH_SOURCE})'((?::\\d+(?::\\d+)?)|\\(\\d+(?:\\s*,\\s*\\d+)?\\))?`, 'g');
const BACKTICK_QUOTED_PATH_RE = new RegExp('`(' + QUOTED_PATH_SOURCE + ')`((?::\\d+(?::\\d+)?)|\\(\\d+(?:\\s*,\\s*\\d+)?\\))?', 'g');
const PAREN_WRAPPED_PATH_RE = new RegExp(`\\((${UNQUOTED_PATH_SOURCE}${PAREN_LOCATION_SOURCE})\\)`, 'g');
const PLAIN_PATH_RE = new RegExp(`(?:^|[\\s\\[])(?:at\\s+)?(${UNQUOTED_PATH_SOURCE}${PAREN_LOCATION_SOURCE})`, 'g');
const COMMON_DOMAIN_SUFFIXES = new Set([
  'app',
  'biz',
  'cn',
  'com',
  'dev',
  'edu',
  'gov',
  'info',
  'io',
  'local',
  'me',
  'net',
  'org',
  'site',
]);

export function shouldActivateTerminalFileLink({ ctrlKey, metaKey, isMac }: TerminalLinkModifierState) {
  return isMac ? metaKey : ctrlKey;
}

export function collectWrappedBufferText(buffer: BufferLike, bufferLineNumber: number): WrappedBufferText | null {
  const requestedIndex = bufferLineNumber - 1;
  const requestedLine = buffer.getLine(requestedIndex);
  if (!requestedLine) {
    return null;
  }

  let startIndex = requestedIndex;
  while (startIndex > 0) {
    const current = buffer.getLine(startIndex);
    if (!current?.isWrapped) {
      break;
    }
    startIndex -= 1;
  }

  const segments: WrappedBufferSegment[] = [];
  let text = '';
  let currentIndex = startIndex;

  while (currentIndex < buffer.length) {
    const current = buffer.getLine(currentIndex);
    if (!current) {
      break;
    }

    const next = buffer.getLine(currentIndex + 1);
    const segmentText = current.translateToString(next?.isWrapped !== true);
    segments.push({
      lineNumber: currentIndex + 1,
      text: segmentText,
      startOffset: text.length,
      endOffset: text.length + segmentText.length,
    });
    text += segmentText;

    if (next?.isWrapped !== true) {
      break;
    }

    currentIndex += 1;
  }

  return {
    text,
    startLineNumber: startIndex + 1,
    endLineNumber: currentIndex + 1,
    segments,
  };
}

export function createBufferRangeFromOffsets(
  wrappedText: WrappedBufferText,
  startIndex: number,
  endIndex: number,
): IBufferRange | null {
  if (startIndex < 0 || endIndex <= startIndex || endIndex > wrappedText.text.length) {
    return null;
  }

  const startPosition = locateWrappedOffset(wrappedText, startIndex);
  const endPosition = locateWrappedOffset(wrappedText, endIndex - 1);
  if (!startPosition || !endPosition) {
    return null;
  }

  return {
    start: {
      x: startPosition.column + 1,
      y: startPosition.lineNumber,
    },
    end: {
      x: endPosition.column + 1,
      y: endPosition.lineNumber,
    },
  };
}

export function doesBufferRangeIntersectLine(range: IBufferRange, bufferLineNumber: number) {
  return range.start.y <= bufferLineNumber && range.end.y >= bufferLineNumber;
}

export function extractTerminalFileLinks(text: string): TerminalFileLinkMatch[] {
  const matches: TerminalFileLinkMatch[] = [];

  for (const match of text.matchAll(PYTHON_TRACEBACK_RE)) {
    const fullText = match[0];
    const path = match[1] ?? match[2];
    const line = parsePositiveInteger(match[3]);
    if (path && line != null && match.index != null) {
      pushTerminalFileLinkMatch(matches, {
        text: fullText,
        startIndex: match.index,
        endIndex: match.index + fullText.length,
        path,
        line,
      });
    }
  }

  for (const match of text.matchAll(DOUBLE_QUOTED_PATH_RE)) {
    const fullText = match[0];
    const path = match[1];
    if (!path || match.index == null || !looksLikeTerminalPath(path, { allowBareFile: true })) {
      continue;
    }

    const parsed = parsePathLocation(`${path}${match[2] ?? ''}`, { allowBareFile: true });
    if (!parsed) {
      continue;
    }

    pushTerminalFileLinkMatch(matches, {
      text: fullText,
      startIndex: match.index,
      endIndex: match.index + fullText.length,
      path: parsed.path,
      line: parsed.line,
      column: parsed.column,
    });
  }

  for (const match of text.matchAll(SINGLE_QUOTED_PATH_RE)) {
    const fullText = match[0];
    const path = match[1];
    if (!path || match.index == null || !looksLikeTerminalPath(path, { allowBareFile: true })) {
      continue;
    }

    const parsed = parsePathLocation(`${path}${match[2] ?? ''}`, { allowBareFile: true });
    if (!parsed) {
      continue;
    }

    pushTerminalFileLinkMatch(matches, {
      text: fullText,
      startIndex: match.index,
      endIndex: match.index + fullText.length,
      path: parsed.path,
      line: parsed.line,
      column: parsed.column,
    });
  }

  for (const match of text.matchAll(BACKTICK_QUOTED_PATH_RE)) {
    const fullText = match[0];
    const path = match[1];
    if (!path || match.index == null || !looksLikeTerminalPath(path, { allowBareFile: true })) {
      continue;
    }

    const parsed = parsePathLocation(`${path}${match[2] ?? ''}`, { allowBareFile: true });
    if (!parsed) {
      continue;
    }

    pushTerminalFileLinkMatch(matches, {
      text: fullText,
      startIndex: match.index,
      endIndex: match.index + fullText.length,
      path: parsed.path,
      line: parsed.line,
      column: parsed.column,
    });
  }

  for (const match of text.matchAll(PAREN_WRAPPED_PATH_RE)) {
    const fullText = match[0];
    const body = match[1];
    if (!body || match.index == null) {
      continue;
    }

    const parsed = parsePathLocation(body, { allowBareFile: false });
    if (!parsed) {
      continue;
    }

    pushTerminalFileLinkMatch(matches, {
      text: fullText,
      startIndex: match.index,
      endIndex: match.index + fullText.length,
      path: parsed.path,
      line: parsed.line,
      column: parsed.column,
    });
  }

  for (const match of text.matchAll(PLAIN_PATH_RE)) {
    const fullText = match[0];
    const body = match[1];
    if (!body || match.index == null) {
      continue;
    }

    const parsed = parsePathLocation(body, { allowBareFile: false });
    if (!parsed) {
      continue;
    }

    const offsetInMatch = fullText.lastIndexOf(body);
    const startIndex = match.index + Math.max(offsetInMatch, 0);
    const normalizedBody = sanitizeEmbeddedPathCandidate(trimMatchedLinkText(body));
    pushTerminalFileLinkMatch(matches, {
      text: normalizedBody,
      startIndex,
      endIndex: startIndex + normalizedBody.length,
      path: parsed.path,
      line: parsed.line,
      column: parsed.column,
    });
  }

  return matches.sort((left, right) => left.startIndex - right.startIndex);
}

export async function resolveTerminalFileLink(
  match: TerminalFileLinkMatch,
  options: TerminalFileLinkResolutionOptions,
): Promise<ResolvedTerminalFileLink | null> {
  const candidates = buildResolutionCandidates(match.path, options.cwd, options.workspaceRootPaths);
  for (const candidate of candidates) {
    if (await options.probeFile(candidate)) {
      return {
        path: candidate,
        line: match.line,
        column: match.column,
      };
    }
  }

  return null;
}

function pushTerminalFileLinkMatch(matches: TerminalFileLinkMatch[], nextMatch: TerminalFileLinkMatch) {
  if (
    matches.some(
      (existing) =>
        nextMatch.startIndex < existing.endIndex
        && nextMatch.endIndex > existing.startIndex,
    )
  ) {
    return;
  }

  matches.push(nextMatch);
}

function locateWrappedOffset(wrappedText: WrappedBufferText, offset: number) {
  return wrappedText.segments.reduce<{ lineNumber: number; column: number } | null>((result, segment) => {
    if (result) {
      return result;
    }

    if (offset < segment.startOffset || offset >= segment.endOffset) {
      return null;
    }

    return {
      lineNumber: segment.lineNumber,
      column: offset - segment.startOffset,
    };
  }, null);
}

function parsePathLocation(value: string, options: ParsePathLocationOptions): ParsedPathLocation | null {
  const strippedValue = sanitizeEmbeddedPathCandidate(
    stripTerminalWrappers(stripTrailingPunctuation(value.trim())),
  );
  if (!strippedValue) {
    return null;
  }

  const hashLocation = parseHashLocation(strippedValue);
  if (hashLocation) {
    return hashLocation;
  }

  const parenLocationMatch = strippedValue.match(/^(.*)\((\d+)(?:\s*,\s*(\d+))?\)$/);
  if (parenLocationMatch) {
    const path = stripTrailingPunctuation(parenLocationMatch[1].trim());
    const line = parsePositiveInteger(parenLocationMatch[2]);
    const column = parsePositiveInteger(parenLocationMatch[3]);
    if (path && looksLikeTerminalPath(path, { allowBareFile: true }) && line != null) {
      return column != null ? { path, line, column } : { path, line };
    }
  }

  const colonLocation = parseColonLocation(strippedValue);
  if (colonLocation) {
    return colonLocation;
  }

  return looksLikeTerminalPath(strippedValue, options) ? { path: strippedValue } : null;
}

function parseColonLocation(value: string): ParsedPathLocation | null {
  const extendedLocation = parseExtendedColonLocation(value);
  if (extendedLocation) {
    return extendedLocation;
  }

  const lastColonIndex = value.lastIndexOf(':');
  if (lastColonIndex <= 0 || lastColonIndex === value.length - 1) {
    return null;
  }

  const trailingNumber = parsePositiveInteger(value.slice(lastColonIndex + 1));
  if (trailingNumber == null) {
    return null;
  }

  const beforeLastColon = value.slice(0, lastColonIndex);
  const secondColonIndex = beforeLastColon.lastIndexOf(':');
  if (secondColonIndex > 0) {
    const maybeLine = parsePositiveInteger(beforeLastColon.slice(secondColonIndex + 1));
    const path = beforeLastColon.slice(0, secondColonIndex);
    if (maybeLine != null && looksLikeTerminalPath(path, { allowBareFile: true })) {
      return {
        path,
        line: maybeLine,
        column: trailingNumber,
      };
    }
  }

  if (!looksLikeTerminalPath(beforeLastColon, { allowBareFile: true })) {
    return null;
  }

  return {
    path: beforeLastColon,
    line: trailingNumber,
  };
}

function parseHashLocation(value: string): ParsedPathLocation | null {
  const match = value.match(/^(.*)#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/i);
  if (!match) {
    return null;
  }

  const path = stripTrailingPunctuation(match[1].trim());
  const line = parsePositiveInteger(match[2]);
  const column = parsePositiveInteger(match[3]);
  if (!path || line == null || !looksLikeTerminalPath(path, { allowBareFile: true })) {
    return null;
  }

  return column != null ? { path, line, column } : { path, line };
}

function parseExtendedColonLocation(value: string): ParsedPathLocation | null {
  const match = value.match(/^(.*?):(\d+)(?::(\d+))?(?:[-,].*)$/);
  if (!match) {
    return null;
  }

  const path = match[1];
  const line = parsePositiveInteger(match[2]);
  const column = parsePositiveInteger(match[3]);
  if (!path || line == null || !looksLikeTerminalPath(path, { allowBareFile: true })) {
    return null;
  }

  return column != null ? { path, line, column } : { path, line };
}

function stripTerminalWrappers(value: string) {
  let current = value;

  while (current.length > 1) {
    if (
      (current.startsWith('"') && current.endsWith('"'))
      || (current.startsWith('\'') && current.endsWith('\''))
      || (current.startsWith('(') && current.endsWith(')'))
    ) {
      current = current.slice(1, -1).trim();
      continue;
    }

    if (current.startsWith('at ')) {
      current = current.slice(3).trim();
      continue;
    }

    break;
  }

  return current;
}

function stripTrailingPunctuation(value: string) {
  return value.replace(/[.,;:!?。，、；：！？）】》」』】]+$/gu, '');
}

function trimMatchedLinkText(value: string) {
  return stripTrailingPunctuation(value.trimEnd());
}

function sanitizeEmbeddedPathCandidate(value: string) {
  const embeddedPathMatch = value.match(
    /^(.*?\.[A-Za-z0-9_-]+(?:(?::\d+(?::\d+)?)|(?:\(\d+(?:\s*,\s*\d+)?\))|(?:#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?))?)(?=[，。！？；：、\s]|$)/u,
  );
  if (!embeddedPathMatch) {
    return value;
  }

  const candidate = embeddedPathMatch[1] ?? value;
  return hasPathSeparator(candidate) || isLikelyBareFile(candidate) ? candidate : value;
}

function looksLikeTerminalPath(value: string, options: ParsePathLocationOptions) {
  return value.length > 0 && (
    isFileUri(value)
    || isNonFileUrl(value) === false && (
      isAbsolutePathLike(value)
      || isDotRelativePath(value)
      || hasPathSeparator(value)
      || (options.allowBareFile && isLikelyBareFile(value))
    )
  );
}

function hasPathSeparator(value: string) {
  return value.includes('/') || value.includes('\\');
}

function isLikelyBareFile(value: string) {
  if (hasPathSeparator(value) || isNonFileUrl(value) || value.includes('@')) {
    return false;
  }

  const normalizedValue = value.trim();
  if (!normalizedValue || /^\d+(?:\.\d+)+$/.test(normalizedValue)) {
    return false;
  }

  if (isLikelyDomainName(normalizedValue)) {
    return false;
  }

  const parts = normalizedValue.split('.').filter(Boolean);
  if (parts.length < 2) {
    return false;
  }

  const extension = parts[parts.length - 1]?.toLowerCase() ?? '';
  if (!extension || !/[a-z]/.test(extension)) {
    return false;
  }

  return parts.slice(0, -1).some((part) => /[A-Za-z_]/.test(part));
}

function isLikelyDomainName(value: string) {
  const parts = value.split('.').filter(Boolean);
  if (parts.length !== 2) {
    return false;
  }

  const [host, suffix] = parts;
  if (!host || !suffix) {
    return false;
  }

  return /^[A-Za-z0-9-]+$/.test(host) && COMMON_DOMAIN_SUFFIXES.has(suffix.toLowerCase());
}

function isNonFileUrl(value: string) {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) && !isFileUri(value);
}

function isFileUri(value: string) {
  return /^file:\/\//i.test(value);
}

function isAbsolutePathLike(value: string) {
  return isWindowsDrivePath(value) || isUncPath(value) || value.startsWith('/');
}

function isWindowsDrivePath(value: string) {
  return /^[A-Za-z]:[\\/]/.test(value);
}

function isUncPath(value: string) {
  return /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(value);
}

function isDotRelativePath(value: string) {
  return /^\.{1,2}[\\/]/.test(value);
}

function buildResolutionCandidates(path: string, cwd: string | undefined, workspaceRootPaths: string[]) {
  const candidates: string[] = [];
  const directPath = isFileUri(path) ? decodeFileUriTarget(path) : path;

  if (directPath && isAbsolutePathLike(directPath)) {
    pushResolutionCandidate(candidates, normalizePathString(directPath));
    return candidates;
  }

  if (!directPath) {
    return candidates;
  }

  const candidateBases = cwd ? [cwd, ...workspaceRootPaths] : [...workspaceRootPaths];
  candidateBases.forEach((basePath) => {
    pushResolutionCandidate(candidates, joinDirectoryAndRelativePath(basePath, directPath));
  });

  if (!isDotRelativePath(directPath)) {
    candidateBases.forEach((basePath) => {
      collectAncestorDirectories(basePath).forEach((ancestorPath) => {
        pushResolutionCandidate(candidates, joinDirectoryAndRelativePath(ancestorPath, directPath));
      });
    });
  }

  return candidates;
}

function collectAncestorDirectories(basePath: string, maxDepth = 4) {
  const ancestors: string[] = [];
  let currentPath = normalizePathString(basePath).replace(/[\\/]+$/, '');

  for (let depth = 0; depth < maxDepth; depth += 1) {
    const parentPath = getParentDirectory(currentPath);
    if (!parentPath || parentPath === currentPath) {
      break;
    }
    ancestors.push(parentPath);
    currentPath = parentPath;
  }

  return ancestors;
}

function getParentDirectory(path: string) {
  if (isUncPath(path)) {
    const parts = path.replace(/^[\\/]+/, '').split(/[\\/]+/).filter(Boolean);
    if (parts.length <= 2) {
      return null;
    }
    return `\\\\${parts.slice(0, -1).join('\\')}`;
  }

  if (isWindowsDrivePath(path)) {
    const parts = path.split(/[\\/]+/).filter(Boolean);
    if (parts.length <= 1) {
      return null;
    }
    if (parts.length === 2) {
      return `${parts[0]}\\`;
    }
    return `${parts.slice(0, -1).join('\\')}`;
  }

  if (path.startsWith('/')) {
    const parts = path.split(/[\\/]+/).filter(Boolean);
    if (parts.length === 0) {
      return null;
    }
    if (parts.length === 1) {
      return '/';
    }
    return `/${parts.slice(0, -1).join('/')}`;
  }

  const separator = path.includes('\\') ? '\\' : '/';
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 1) {
    return null;
  }
  return parts.slice(0, -1).join(separator);
}

function pushResolutionCandidate(candidates: string[], nextPath: string) {
  const nextKey = getPathKey(nextPath);
  if (candidates.some((candidate) => getPathKey(candidate) === nextKey)) {
    return;
  }
  candidates.push(nextPath);
}

function decodeFileUriTarget(uri: string) {
  try {
    const url = new URL(uri);
    if (url.protocol !== 'file:') {
      return null;
    }

    const decodedPath = decodeURIComponent(url.pathname);
    if (url.hostname) {
      const sharePath = decodedPath.replace(/\//g, '\\');
      return normalizePathString(`\\\\${url.hostname}${sharePath}`);
    }

    if (/^\/[A-Za-z]:/.test(decodedPath)) {
      return normalizePathString(decodedPath.slice(1).replace(/\//g, '\\'));
    }

    return normalizePathString(decodedPath);
  } catch {
    return null;
  }
}

function joinDirectoryAndRelativePath(basePath: string, relativePath: string) {
  const separator = isWindowsDrivePath(basePath) || isUncPath(basePath) ? '\\' : '/';
  const normalizedBase = normalizePathString(basePath).replace(/[\\/]+$/, '');
  return normalizePathString(`${normalizedBase}${separator}${relativePath}`);
}

function normalizePathString(value: string) {
  if (isUncPath(value)) {
    const parts = value.replace(/^[\\/]+/, '').split(/[\\/]+/).filter(Boolean);
    const [server, share, ...rest] = parts;
    const normalizedRest = normalizePathSegments(rest, true);
    return `\\\\${server}\\${share}${normalizedRest.length > 0 ? `\\${normalizedRest.join('\\')}` : ''}`;
  }

  if (isWindowsDrivePath(value)) {
    const drive = value.slice(0, 2);
    const rest = value.slice(2);
    const normalizedRest = normalizePathSegments(rest.split(/[\\/]+/), true);
    return `${drive}\\${normalizedRest.join('\\')}`.replace(/\\$/, '\\');
  }

  if (value.startsWith('/')) {
    const normalizedRest = normalizePathSegments(value.split(/[\\/]+/).slice(1), true);
    return `/${normalizedRest.join('/')}`.replace(/\/$/, '/');
  }

  const preferredSeparator = value.includes('\\') ? '\\' : '/';
  return normalizePathSegments(value.split(/[\\/]+/), false).join(preferredSeparator);
}

function normalizePathSegments(parts: string[], absolute: boolean) {
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') {
      continue;
    }

    if (part === '..') {
      if (normalized.length > 0 && normalized[normalized.length - 1] !== '..') {
        normalized.pop();
      } else if (!absolute) {
        normalized.push(part);
      }
      continue;
    }

    normalized.push(part);
  }

  return normalized;
}

function getPathKey(value: string) {
  const normalizedValue = normalizePathString(value);
  return (isWindowsDrivePath(normalizedValue) || isUncPath(normalizedValue))
    ? normalizedValue.toLowerCase()
    : normalizedValue;
}

function parsePositiveInteger(value: string | undefined) {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
