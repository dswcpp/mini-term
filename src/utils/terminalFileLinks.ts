import type { IBufferRange } from '@xterm/xterm';

const PYTHON_TRACEBACK_RE = /File\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)')\s*,\s*line\s+(\d+)/g;
const DOUBLE_QUOTED_PATH_RE = /"([^"\r\n]+)"(?::\d+(?::\d+)?|\(\d+(?:\s*,\s*\d+)?\))?/g;
const SINGLE_QUOTED_PATH_RE = /'([^'\r\n]+)'(?::\d+(?::\d+)?|\(\d+(?:\s*,\s*\d+)?\))?/g;
const BACKTICK_QUOTED_PATH_RE = /`([^`\r\n]+)`(?::\d+(?::\d+)?|\(\d+(?:\s*,\s*\d+)?\))?/g;
const PAREN_WRAPPED_PATH_RE =
  /\(((?:file:\/\/[^\s'"`\])]+|[A-Za-z]:\\[^\s'"`\])]+|\\\\[^\s'"`\])]+|\/[^\s'"`\])]+|\.\.?[\\/][^\s'"`\])]+|(?:[A-Za-z0-9_.-]+[\\/])+[^\s'"`\])]+|[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+(?::\d+(?::\d+)?)?)(?:\(\d+(?:\s*,\s*\d+)?\))?)\)/g;
const PLAIN_PATH_RE =
  /(?:^|[\s\[])(?:at\s+)?((?:file:\/\/[^\s'"`\])]+|[A-Za-z]:\\[^\s'"`\])]+|\\\\[^\s'"`\])]+|\/[^\s'"`\])]+|\.\.?[\\/][^\s'"`\])]+|(?:[A-Za-z0-9_.-]+[\\/])+[^\s'"`\])]+|[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+(?::\d+(?::\d+)?)?)(?:\(\d+(?:\s*,\s*\d+)?\))?)/g;

type PathStyle = 'windows' | 'posix';
const COMMON_DOMAIN_TLDS = new Set([
  'ai',
  'app',
  'cn',
  'com',
  'dev',
  'edu',
  'gov',
  'info',
  'io',
  'local',
  'me',
  'mil',
  'net',
  'org',
]);

export interface TerminalLinkModifierState {
  ctrlKey: boolean;
  metaKey: boolean;
  isMac: boolean;
}

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

export interface ResolveTerminalFileLinkOptions {
  cwd?: string;
  workspaceRootPaths: string[];
  probeFile: (path: string) => Promise<boolean>;
}

export interface ResolvedTerminalFileLink {
  path: string;
  line?: number;
  column?: number;
}

interface ParsedPathLocation {
  path: string;
  line?: number;
  column?: number;
}

function isFileUri(value: string) {
  return /^file:\/\//i.test(value);
}

function isWindowsDrivePath(value: string) {
  return /^[A-Za-z]:[\\/]/.test(value);
}

function isUncPath(value: string) {
  return /^\\\\[^\\]+\\[^\\]+/.test(value);
}

function isPosixPath(value: string) {
  return value.startsWith('/');
}

function isAbsolutePathLike(value: string) {
  return isWindowsDrivePath(value) || isUncPath(value) || isPosixPath(value);
}

function isDotRelativePath(value: string) {
  return /^\.{1,2}(?:[\\/]|$)/.test(value);
}

function isBareFileName(value: string) {
  return /^[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+$/.test(value);
}

function looksLikeIpv4Address(value: string) {
  return /^\d+(?:\.\d+){3}$/.test(value);
}

function looksLikeVersionNumber(value: string) {
  return /^\d+(?:\.\d+){1,}$/.test(value);
}

function looksLikeDomainName(value: string) {
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(value)) {
    return false;
  }

  const parts = value.split('.');
  const extension = parts[parts.length - 1]?.toLowerCase();
  return Boolean(extension && COMMON_DOMAIN_TLDS.has(extension));
}

function looksLikeTerminalPath(value: string) {
  const trimmed = value.trim();
  if (looksLikeIpv4Address(trimmed) || looksLikeVersionNumber(trimmed)) {
    return false;
  }

  if (
    !trimmed.includes('/')
    && !trimmed.includes('\\')
    && !isAbsolutePathLike(trimmed)
    && !isDotRelativePath(trimmed)
    && !isFileUri(trimmed)
    && looksLikeDomainName(trimmed)
  ) {
    return false;
  }

  return trimmed.length > 0 && (
    isFileUri(trimmed)
    || isAbsolutePathLike(trimmed)
    || isDotRelativePath(trimmed)
    || trimmed.includes('/')
    || trimmed.includes('\\')
    || isBareFileName(trimmed)
  );
}

function parsePositiveInteger(value: string | undefined) {
  if (!value || !/^\d+$/.test(value)) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function stripTrailingPunctuation(value: string) {
  return value.replace(/[>,;.!，。！？；：、）】》]+$/g, '');
}

function stripTrailingNoise(value: string) {
  let current = value.trim();

  while (current) {
    const next = stripTrailingPunctuation(current).replace(/[^A-Za-z0-9_./\\:#(),\-%[\]-]+$/g, '');
    if (next === current) {
      return next;
    }
    current = next;
  }

  return current;
}

function parseAnchorLocation(value: string): ParsedPathLocation | null {
  const match = /^(.*)#L(\d+)(?:C(\d+))?(?:-L\d+(?:C\d+)?)?$/.exec(value);
  if (!match) {
    return null;
  }

  const path = match[1]?.trim();
  const line = parsePositiveInteger(match[2]);
  const column = parsePositiveInteger(match[3]);
  if (!path || !line || !looksLikeTerminalPath(path)) {
    return null;
  }

  return {
    path,
    line,
    ...(column ? { column } : {}),
  };
}

function parseRangeLocation(value: string): ParsedPathLocation | null {
  const match = /^(.*):(\d+)(?:(?::|,)(\d+))?(?:-\d+(?::\d+)?|-L\d+(?:C\d+)?)$/.exec(value);
  if (!match) {
    return null;
  }

  const path = match[1]?.trim();
  const line = parsePositiveInteger(match[2]);
  const column = parsePositiveInteger(match[3]);
  if (!path || !line || !looksLikeTerminalPath(path)) {
    return null;
  }

  return {
    path,
    line,
    ...(column ? { column } : {}),
  };
}

function stripEnclosingWrappers(value: string) {
  let current = value.trim();
  let changed = true;

  while (changed && current.length > 1) {
    changed = false;
    if (
      (current.startsWith('"') && current.endsWith('"'))
      || (current.startsWith('\'') && current.endsWith('\''))
      || (current.startsWith('(') && current.endsWith(')'))
    ) {
      current = current.slice(1, -1).trim();
      changed = true;
    }
  }

  return current;
}

function parseColonLocation(value: string): ParsedPathLocation | null {
  const lastColonIndex = value.lastIndexOf(':');
  if (lastColonIndex <= 0 || lastColonIndex >= value.length - 1) {
    return null;
  }

  const trailingNumber = parsePositiveInteger(value.slice(lastColonIndex + 1));
  if (!trailingNumber) {
    return null;
  }

  const beforeLastColon = value.slice(0, lastColonIndex);
  const secondColonIndex = beforeLastColon.lastIndexOf(':');
  if (secondColonIndex > 0) {
    const middleNumber = parsePositiveInteger(beforeLastColon.slice(secondColonIndex + 1));
    const pathWithPotentialDrive = beforeLastColon.slice(0, secondColonIndex);
    if (middleNumber && looksLikeTerminalPath(pathWithPotentialDrive)) {
      return {
        path: pathWithPotentialDrive,
        line: middleNumber,
        column: trailingNumber,
      };
    }
  }

  if (!looksLikeTerminalPath(beforeLastColon)) {
    return null;
  }

  return {
    path: beforeLastColon,
    line: trailingNumber,
  };
}

function parsePathLocation(rawValue: string): ParsedPathLocation | null {
  const trimmed = stripTrailingNoise(stripEnclosingWrappers(rawValue.replace(/^at\s+/, '').trim()));
  if (!trimmed) {
    return null;
  }

  const anchorMatch = parseAnchorLocation(trimmed);
  if (anchorMatch) {
    return anchorMatch;
  }

  const rangeMatch = parseRangeLocation(trimmed);
  if (rangeMatch) {
    return rangeMatch;
  }

  const parenMatch = /^(.*)\((\d+)(?:\s*,\s*(\d+))?\)$/.exec(trimmed);
  if (parenMatch) {
    const path = parenMatch[1]?.trim();
    const line = parsePositiveInteger(parenMatch[2]);
    const column = parsePositiveInteger(parenMatch[3]);
    if (path && line && looksLikeTerminalPath(path)) {
      return {
        path,
        line,
        ...(column ? { column } : {}),
      };
    }
  }

  const colonMatch = parseColonLocation(trimmed);
  if (colonMatch) {
    return colonMatch;
  }

  return looksLikeTerminalPath(trimmed) ? { path: trimmed } : null;
}

function pushUniqueMatch(matches: TerminalFileLinkMatch[], match: TerminalFileLinkMatch | null) {
  if (!match) {
    return;
  }

  const overlaps = matches.some((existing) => (
    match.startIndex < existing.endIndex && match.endIndex > existing.startIndex
  ));
  if (!overlaps) {
    matches.push(match);
  }
}

function buildMatch(
  text: string,
  startIndex: number,
  endIndex: number,
  parsed: ParsedPathLocation | null,
): TerminalFileLinkMatch | null {
  if (!parsed || endIndex <= startIndex) {
    return null;
  }

  const normalizedText = parsed.line
    ? `${parsed.path}:${parsed.line}${parsed.column ? `:${parsed.column}` : ''}`
    : parsed.path;

  return {
    text: normalizedText || text,
    startIndex,
    endIndex,
    path: parsed.path,
    ...(parsed.line ? { line: parsed.line } : {}),
    ...(parsed.column ? { column: parsed.column } : {}),
  };
}

function normalizeSegments(parts: string[], allowLeadingParent: boolean) {
  const normalized: string[] = [];

  for (const part of parts) {
    if (!part || part === '.') {
      continue;
    }

    if (part === '..') {
      if (normalized.length > 0 && normalized[normalized.length - 1] !== '..') {
        normalized.pop();
      } else if (allowLeadingParent) {
        normalized.push(part);
      }
      continue;
    }

    normalized.push(part);
  }

  return normalized;
}

function normalizePathString(path: string, preferredStyle?: PathStyle) {
  if (isUncPath(path)) {
    const parts = path.replace(/^[\\/]+/, '').split(/[\\/]+/).filter(Boolean);
    const server = parts.shift();
    const share = parts.shift();
    if (!server || !share) {
      return path;
    }
    const segments = normalizeSegments(parts, false);
    return `\\\\${server}\\${share}${segments.length > 0 ? `\\${segments.join('\\')}` : ''}`;
  }

  if (isWindowsDrivePath(path)) {
    const drive = path.slice(0, 2);
    const segments = normalizeSegments(path.slice(2).split(/[\\/]+/), false);
    return segments.length > 0 ? `${drive}\\${segments.join('\\')}` : `${drive}\\`;
  }

  if (isPosixPath(path)) {
    const segments = normalizeSegments(path.split(/[\\/]+/).slice(1), false);
    return `/${segments.join('/')}`.replace(/\/$/, '') || '/';
  }

  const style = preferredStyle ?? (path.includes('\\') ? 'windows' : 'posix');
  const segments = normalizeSegments(path.split(/[\\/]+/), true);
  return segments.join(style === 'windows' ? '\\' : '/');
}

function joinPath(basePath: string, relativePath: string) {
  const preferredStyle: PathStyle = isWindowsDrivePath(basePath) || isUncPath(basePath) ? 'windows' : 'posix';
  const separator = preferredStyle === 'windows' ? '\\' : '/';
  const normalizedBase = normalizePathString(basePath, preferredStyle).replace(/[\\/]+$/, '');
  return normalizePathString(`${normalizedBase}${separator}${relativePath}`, preferredStyle);
}

function getParentPath(path: string) {
  const normalized = normalizePathString(path);
  if (isWindowsDrivePath(normalized)) {
    const lastSlashIndex = normalized.lastIndexOf('\\');
    return lastSlashIndex > 2 ? normalized.slice(0, lastSlashIndex) : null;
  }

  if (isUncPath(normalized)) {
    const lastSlashIndex = normalized.lastIndexOf('\\');
    return lastSlashIndex > 1 ? normalized.slice(0, lastSlashIndex) : null;
  }

  if (isPosixPath(normalized)) {
    const lastSlashIndex = normalized.lastIndexOf('/');
    return lastSlashIndex > 0 ? normalized.slice(0, lastSlashIndex) : null;
  }

  return null;
}

function collectAncestorBases(basePath: string) {
  const bases: string[] = [];
  let current = getParentPath(basePath);

  while (current) {
    bases.push(current);
    current = getParentPath(current);
  }

  return bases;
}

function decodeFileUriPath(fileUri: string) {
  try {
    const url = new URL(fileUri);
    if (url.protocol !== 'file:') {
      return null;
    }

    const pathname = decodeURIComponent(url.pathname);
    if (url.hostname) {
      const uncPath = `\\\\${url.hostname}${pathname.replace(/\//g, '\\')}`;
      return normalizePathString(uncPath, 'windows');
    }

    if (/^\/[A-Za-z]:/.test(pathname)) {
      return normalizePathString(pathname.slice(1).replace(/\//g, '\\'), 'windows');
    }

    return normalizePathString(pathname, 'posix');
  } catch {
    return null;
  }
}

function buildResolutionCandidates(path: string, cwd: string | undefined, workspaceRootPaths: string[]) {
  const candidates: string[] = [];
  const pushCandidate = (candidate: string | null | undefined) => {
    if (!candidate) {
      return;
    }

    const normalized = normalizePathString(candidate);
    const dedupeKey = (isWindowsDrivePath(normalized) || isUncPath(normalized))
      ? normalized.toLowerCase()
      : normalized;
    if (!candidates.some((existing) => (
      ((isWindowsDrivePath(existing) || isUncPath(existing)) ? existing.toLowerCase() : existing) === dedupeKey
    ))) {
      candidates.push(normalized);
    }
  };

  if (isFileUri(path)) {
    pushCandidate(decodeFileUriPath(path));
    return candidates;
  }

  if (isAbsolutePathLike(path)) {
    pushCandidate(path);
    return candidates;
  }

  if (cwd) {
    pushCandidate(joinPath(cwd, path));
  }

  if (!isDotRelativePath(path)) {
    workspaceRootPaths.forEach((rootPath) => {
      pushCandidate(joinPath(rootPath, path));
    });

    const ancestorBases = new Set<string>();
    if (cwd) {
      collectAncestorBases(cwd).forEach((basePath) => ancestorBases.add(basePath));
    }
    workspaceRootPaths.forEach((rootPath) => {
      collectAncestorBases(rootPath).forEach((basePath) => ancestorBases.add(basePath));
    });
    ancestorBases.forEach((basePath) => {
      pushCandidate(joinPath(basePath, path));
    });
  }

  return candidates;
}

export function shouldActivateTerminalFileLink({ ctrlKey, metaKey, isMac }: TerminalLinkModifierState) {
  return isMac ? metaKey : ctrlKey;
}

export function getWrappedBufferText(buffer: BufferLike, bufferLineNumber: number): WrappedBufferText | null {
  const targetIndex = bufferLineNumber - 1;
  const initialLine = buffer.getLine(targetIndex);
  if (!initialLine) {
    return null;
  }

  let startIndex = targetIndex;
  while (startIndex > 0 && buffer.getLine(startIndex)?.isWrapped) {
    startIndex -= 1;
  }

  const segments: WrappedBufferSegment[] = [];
  let text = '';
  let currentIndex = startIndex;

  while (currentIndex < buffer.length) {
    const line = buffer.getLine(currentIndex);
    if (!line) {
      break;
    }

    const nextLine = buffer.getLine(currentIndex + 1);
    const segmentText = line.translateToString(nextLine?.isWrapped !== true);
    const startOffset = text.length;
    text += segmentText;
    segments.push({
      lineNumber: currentIndex + 1,
      text: segmentText,
      startOffset,
      endOffset: text.length,
    });

    if (nextLine?.isWrapped !== true) {
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

export const collectWrappedBufferText = getWrappedBufferText;

function findSegmentForOffset(wrapped: WrappedBufferText, offset: number) {
  return wrapped.segments.find((segment) => offset >= segment.startOffset && offset < segment.endOffset);
}

export function rangeIntersectsBufferLine(range: IBufferRange, bufferLineNumber: number) {
  return range.start.y <= bufferLineNumber && range.end.y >= bufferLineNumber;
}

export const doesBufferRangeIntersectLine = rangeIntersectsBufferLine;

export function getBufferRangeForOffsets(
  wrapped: WrappedBufferText,
  startOffset: number,
  endOffset: number,
): IBufferRange | null {
  if (endOffset <= startOffset || startOffset < 0 || endOffset > wrapped.text.length) {
    return null;
  }

  const startSegment = findSegmentForOffset(wrapped, startOffset);
  const endSegment = findSegmentForOffset(wrapped, endOffset - 1);
  if (!startSegment || !endSegment) {
    return null;
  }

  return {
    start: {
      x: startOffset - startSegment.startOffset + 1,
      y: startSegment.lineNumber,
    },
    end: {
      x: endOffset - endSegment.startOffset,
      y: endSegment.lineNumber,
    },
  };
}

export const createBufferRangeFromOffsets = getBufferRangeForOffsets;

export function extractTerminalFileLinks(lineText: string) {
  const matches: TerminalFileLinkMatch[] = [];

  for (const match of lineText.matchAll(PYTHON_TRACEBACK_RE)) {
    const fullText = match[0];
    const path = match[1] ?? match[2];
    const line = parsePositiveInteger(match[3]);
    const startIndex = match.index ?? -1;
    if (!path || !line || startIndex < 0) {
      continue;
    }

    pushUniqueMatch(matches, buildMatch(fullText, startIndex, startIndex + fullText.length, { path, line }));
  }

  for (const match of lineText.matchAll(DOUBLE_QUOTED_PATH_RE)) {
    const fullText = match[0];
    const rawPath = match[1];
    const startIndex = match.index ?? -1;
    if (!rawPath || startIndex < 0 || !looksLikeTerminalPath(rawPath)) {
      continue;
    }

    const suffix = fullText.slice(rawPath.length + 2);
    const parsed = parsePathLocation(`${rawPath}${suffix}`);
    pushUniqueMatch(matches, buildMatch(fullText, startIndex, startIndex + fullText.length, parsed));
  }

  for (const match of lineText.matchAll(SINGLE_QUOTED_PATH_RE)) {
    const fullText = match[0];
    const rawPath = match[1];
    const startIndex = match.index ?? -1;
    if (!rawPath || startIndex < 0 || !looksLikeTerminalPath(rawPath)) {
      continue;
    }

    const suffix = fullText.slice(rawPath.length + 2);
    const parsed = parsePathLocation(`${rawPath}${suffix}`);
    pushUniqueMatch(matches, buildMatch(fullText, startIndex, startIndex + fullText.length, parsed));
  }

  for (const match of lineText.matchAll(BACKTICK_QUOTED_PATH_RE)) {
    const fullText = match[0];
    const rawPath = match[1];
    const startIndex = match.index ?? -1;
    if (!rawPath || startIndex < 0 || !looksLikeTerminalPath(rawPath)) {
      continue;
    }

    const suffix = fullText.slice(rawPath.length + 2);
    const parsed = parsePathLocation(`${rawPath}${suffix}`);
    pushUniqueMatch(matches, buildMatch(fullText, startIndex, startIndex + fullText.length, parsed));
  }

  for (const match of lineText.matchAll(PAREN_WRAPPED_PATH_RE)) {
    const fullText = match[0];
    const body = match[1];
    const startIndex = match.index ?? -1;
    if (!body || startIndex < 0) {
      continue;
    }

    pushUniqueMatch(matches, buildMatch(fullText, startIndex, startIndex + fullText.length, parsePathLocation(body)));
  }

  for (const match of lineText.matchAll(PLAIN_PATH_RE)) {
    const fullText = match[0];
    const body = match[1];
    const startIndex = match.index ?? -1;
    if (!body || startIndex < 0) {
      continue;
    }

    const bodyOffset = fullText.lastIndexOf(body);
    const normalizedStart = startIndex + (bodyOffset >= 0 ? bodyOffset : 0);
    const parsed = parsePathLocation(body);
    if (parsed && isBareFileName(parsed.path) && !parsed.line && !parsed.column) {
      continue;
    }
    pushUniqueMatch(
      matches,
      buildMatch(body, normalizedStart, normalizedStart + body.length, parsed),
    );
  }

  return matches.sort((left, right) => left.startIndex - right.startIndex);
}

export async function resolveTerminalFileLink(
  match: Pick<TerminalFileLinkMatch, 'text' | 'startIndex' | 'endIndex' | 'path' | 'line' | 'column'>,
  options: ResolveTerminalFileLinkOptions,
): Promise<ResolvedTerminalFileLink | null> {
  const candidates = buildResolutionCandidates(match.path, options.cwd, options.workspaceRootPaths);

  for (const candidate of candidates) {
    if (await options.probeFile(candidate)) {
      return {
        path: candidate,
        ...(match.line ? { line: match.line } : {}),
        ...(match.column ? { column: match.column } : {}),
      };
    }
  }

  return null;
}
