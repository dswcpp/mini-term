import { invoke } from '@tauri-apps/api/core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store';
import { useAutoRefreshFeedback } from '../hooks/useAutoRefreshFeedback';
import { useWorkspaceAutoRefresh } from '../hooks/useWorkspaceAutoRefresh';
import { AutoRefreshFeedbackBar } from './AutoRefreshFeedback';
import type {
  DiffHunk,
  FileHistoryTab,
  GitBlameInfo,
  GitDiffResult,
  GitFileBlameResult,
  GitFileHistoryEntry,
  GitFileHistoryResult,
  ThemePresetId,
} from '../types';
import { InlineView, SideBySideView } from './DiffModal';
import { CloseIcon, ToolbarButton } from './documentViewer/controls';
import { resolveDocumentLanguage } from './documentViewer/language';
import { highlightCodeToHtml } from './documentViewer/shiki';
import { resolveViewerSkin, toViewerCssVars } from './documentViewer/viewerSkin';

interface FileHistoryTabHostProps {
  tab: FileHistoryTab;
  isActive: boolean;
  onClose: () => void;
}

type HistoryViewMode = 'timeline' | 'blame';
type DiffViewMode = 'side-by-side' | 'inline';

const HISTORY_PAGE_SIZE = 30;
const BLAME_AUTO_REFRESH_COOLDOWN_MS = 450;

function normalizePath(path: string) {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
}

function getFileName(path: string) {
  const normalized = normalizePath(path);
  const segments = normalized.split('/');
  return segments[segments.length - 1] ?? path;
}

function getDirectoryDetail(path: string) {
  const normalized = normalizePath(path);
  const segments = normalized.split('/');
  segments.pop();
  return segments.join('/');
}

function formatAbsoluteTime(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp * 1000));
}

function formatBlameLineRange(startLine: number, endLine: number) {
  if (startLine === endLine) {
    return `第 ${startLine} 行`;
  }

  return `第 ${startLine}-${endLine} 行`;
}

function getShikiTheme(themePreset: ThemePresetId) {
  return themePreset === 'ghostty-light' ? 'github-light' : 'github-dark';
}

function extractHighlightedLines(html: string) {
  if (typeof DOMParser === 'undefined') {
    return [];
  }

  const document = new DOMParser().parseFromString(html, 'text/html');
  return Array.from(document.querySelectorAll('.line')).map((line) => line.innerHTML);
}

function buildCommitMeta(entry: GitFileHistoryEntry): GitBlameInfo {
  return {
    authorName: entry.author,
    authorTime: entry.timestamp,
    commitId: entry.commitHash,
    summary: entry.message,
    isUncommitted: false,
  };
}

function buildHistoryChangeBlocks(hunk: DiffHunk, blame: GitBlameInfo) {
  const blocks = [];
  let blockStart: number | null = null;

  for (let index = 0; index < hunk.lines.length; index += 1) {
    if (hunk.lines[index].kind === 'context') {
      if (blockStart != null) {
        blocks.push({
          blockIndex: blocks.length,
          lineStartIndex: blockStart,
          lineEndIndex: index - 1,
          blame,
        });
        blockStart = null;
      }
      continue;
    }

    if (blockStart == null) {
      blockStart = index;
    }
  }

  if (blockStart != null) {
    blocks.push({
      blockIndex: blocks.length,
      lineStartIndex: blockStart,
      lineEndIndex: hunk.lines.length - 1,
      blame,
    });
  }

  return blocks;
}

function attachCommitMetadata(result: GitDiffResult, entry: GitFileHistoryEntry): GitDiffResult {
  const blame = buildCommitMeta(entry);
  return {
    ...result,
    hunks: result.hunks.map((hunk) => ({
      ...hunk,
      changeBlocks:
        hunk.changeBlocks.length > 0
          ? hunk.changeBlocks.map((block) => ({
              ...block,
              blame: block.blame ?? blame,
            }))
          : buildHistoryChangeBlocks(hunk, blame),
    })),
  };
}

interface BlameCodeSnippetProps {
  lines: string[];
  startLine: number;
  active: boolean;
  languageBadge: string;
  languageKey: string;
  themePreset: ThemePresetId;
}

function BlameCodeSnippet({
  lines,
  startLine,
  active,
  languageBadge,
  languageKey,
  themePreset,
}: BlameCodeSnippetProps) {
  const [highlightedLines, setHighlightedLines] = useState<string[]>([]);
  const source = useMemo(() => lines.join('\n'), [lines]);
  const shikiTheme = useMemo(() => getShikiTheme(themePreset), [themePreset]);
  const canHighlight = languageKey !== 'text';

  useEffect(() => {
    let cancelled = false;

    setHighlightedLines([]);
    if (!canHighlight || !source) {
      return () => {
        cancelled = true;
      };
    }

    void highlightCodeToHtml(source, languageKey, shikiTheme)
      .then((html) => {
        if (cancelled) {
          return;
        }
        const nextLines = extractHighlightedLines(html);
        setHighlightedLines(nextLines.length === lines.length ? nextLines : []);
      })
      .catch(() => {
        if (!cancelled) {
          setHighlightedLines([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [canHighlight, languageKey, lines.length, shikiTheme, source]);

  return (
    <div className="overflow-hidden">
      <div
        className="flex items-center justify-between border-b px-3 py-2 text-[10px] uppercase tracking-[0.12em]"
        style={{
          borderColor: 'var(--viewer-border-subtle)',
          background:
            'linear-gradient(180deg, color-mix(in srgb, var(--viewer-header-bg) 92%, transparent), color-mix(in srgb, var(--viewer-panel) 90%, transparent))',
          color: 'var(--text-muted)',
        }}
      >
        <span>代码片段</span>
        <span>{languageBadge}</span>
      </div>
      <div
        className="overflow-hidden"
        style={{
          background:
            'linear-gradient(180deg, color-mix(in srgb, var(--viewer-panel) 94%, transparent), color-mix(in srgb, var(--viewer-gutter) 68%, transparent))',
        }}
      >
        {lines.map((line, index) => {
          const lineNumber = startLine + index;
          const highlightedLine = highlightedLines[index];

          return (
            <div
              key={`${startLine}:${lineNumber}`}
              className={`grid grid-cols-[4.5rem_minmax(0,1fr)] ${
                active ? 'bg-white/5' : 'odd:bg-white/[0.015]'
              }`}
            >
              <span
                className="select-none border-r px-3 py-1.5 text-right text-[11px] text-[var(--text-muted)] opacity-80"
                style={{
                  borderColor: 'var(--viewer-border)',
                  backgroundColor: 'var(--viewer-gutter)',
                }}
              >
                {lineNumber}
              </span>
              {highlightedLine ? (
                <code
                  className="min-w-0 whitespace-pre-wrap break-all px-3 py-1.5 text-[var(--text-primary)]"
                  dangerouslySetInnerHTML={{ __html: highlightedLine }}
                />
              ) : (
                <code className="min-w-0 whitespace-pre-wrap break-all px-3 py-1.5 text-[var(--text-primary)]">
                  {line}
                </code>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface HistoryActionButtonProps {
  label: string;
  copiedLabel?: string;
  copied?: boolean;
  accent?: boolean;
  testId?: string;
  onClick: () => void;
}

function HistoryActionButton({
  label,
  copiedLabel,
  copied = false,
  accent = false,
  testId,
  onClick,
}: HistoryActionButtonProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      className="rounded-full border px-3 py-1 text-[11px] font-medium transition-colors"
      style={{
        color: copied ? 'var(--accent)' : 'var(--text-primary)',
        borderColor: accent
          ? 'color-mix(in srgb, var(--accent) 35%, var(--viewer-border))'
          : copied
            ? 'color-mix(in srgb, var(--accent) 45%, var(--viewer-border))'
            : 'var(--viewer-border)',
        backgroundColor: copied
          ? 'color-mix(in srgb, var(--accent-subtle) 70%, var(--viewer-panel))'
          : 'color-mix(in srgb, var(--viewer-panel) 90%, transparent)',
      }}
      onClick={onClick}
    >
      {copied ? copiedLabel ?? label : label}
    </button>
  );
}

export function FileHistoryTabHost({ tab, isActive, onClose }: FileHistoryTabHostProps) {
  const themePreset = useAppStore((state) => state.config.theme.preset);
  const [viewMode, setViewMode] = useState<HistoryViewMode>('timeline');
  const [diffViewMode, setDiffViewMode] = useState<DiffViewMode>('side-by-side');
  const [repoPath, setRepoPath] = useState('');
  const [historyEntries, setHistoryEntries] = useState<GitFileHistoryEntry[]>([]);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyCursor, setHistoryCursor] = useState<string>();
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [selectedCommitHash, setSelectedCommitHash] = useState<string>();
  const [diffResult, setDiffResult] = useState<GitDiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState('');
  const [blameResult, setBlameResult] = useState<GitFileBlameResult | null>(null);
  const [blameLoading, setBlameLoading] = useState(false);
  const [blameError, setBlameError] = useState('');
  const [selectedBlameRangeKey, setSelectedBlameRangeKey] = useState<string>();
  const [copyFeedback, setCopyFeedback] = useState<{ target: string; label: string } | null>(null);
  const copyFeedbackTimerRef = useRef<number | null>(null);
  const blameAutoRefreshRef = useRef<{
    inFlight: Promise<void> | null;
    lastSettledAt: number;
  }>({
    inFlight: null,
    lastSettledAt: 0,
  });
  const { feedback: refreshFeedback, clearFeedback, showRefreshing, showSuccess, showError } = useAutoRefreshFeedback();

  const language = useMemo(() => resolveDocumentLanguage(tab.filePath), [tab.filePath]);
  const skin = useMemo(() => resolveViewerSkin(language.family, themePreset), [language.family, themePreset]);
  const viewerStyle = useMemo(() => toViewerCssVars(skin), [skin]);
  const fileName = useMemo(() => getFileName(tab.filePath), [tab.filePath]);
  const fileDetail = useMemo(() => getDirectoryDetail(tab.filePath), [tab.filePath]);

  const handleCopyValue = useCallback(async (target: string, label: string, value: string) => {
    if (!value) {
      return;
    }
    await writeText(value);
    setCopyFeedback({ target, label });
    if (copyFeedbackTimerRef.current != null) {
      window.clearTimeout(copyFeedbackTimerRef.current);
    }
    copyFeedbackTimerRef.current = window.setTimeout(() => {
      setCopyFeedback(null);
      copyFeedbackTimerRef.current = null;
    }, 1600);
  }, []);

  const isCopied = useCallback(
    (target: string) => copyFeedback?.target === target,
    [copyFeedback?.target],
  );

  useEffect(() => {
    return () => {
      if (copyFeedbackTimerRef.current != null) {
        window.clearTimeout(copyFeedbackTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    blameAutoRefreshRef.current = {
      inFlight: null,
      lastSettledAt: 0,
    };
  }, [tab.filePath]);

  const loadHistory = useCallback(
    async (beforeCommit?: string, append = false, options?: { silent?: boolean }) => {
      const silent = options?.silent ?? false;
      if (!silent) {
        setHistoryLoading(true);
        setHistoryError('');
      }

      try {
        const result = await invoke<GitFileHistoryResult>('get_file_git_history', {
          projectPath: tab.projectPath,
          filePath: tab.filePath,
          beforeCommit: beforeCommit ?? null,
          limit: HISTORY_PAGE_SIZE,
        });

        setRepoPath(result.repoPath);
        setHistoryHasMore(result.hasMore);
        setHistoryCursor(result.nextCursor);
        setHistoryEntries((current) => {
          const merged = append ? [...current, ...result.entries] : result.entries;
          return merged.filter(
            (entry, index, all) =>
              all.findIndex((candidate) => candidate.commitHash === entry.commitHash) === index,
          );
        });
        setHistoryError('');

        if (!append && result.entries.length > 0) {
          setSelectedCommitHash((current) =>
            current && result.entries.some((entry) => entry.commitHash === current)
              ? current
              : result.entries[0].commitHash,
          );
        }

        return result;
      } catch (reason) {
        const message = String(reason);
        if (!silent) {
          setHistoryError(message);
        }
        return null;
      } finally {
        if (!silent) {
          setHistoryLoading(false);
        }
      }
    },
    [tab.filePath, tab.projectPath],
  );

  const loadBlame = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent ?? false;
    if (!silent) {
      setBlameLoading(true);
      setBlameError('');
    }

    try {
      const result = await invoke<GitFileBlameResult>('get_file_git_blame', {
        projectPath: tab.projectPath,
        filePath: tab.filePath,
      });
      setBlameResult(result);
      setRepoPath((current) => current || result.repoPath);
      setSelectedBlameRangeKey((current) =>
        current && result.ranges.some((range) => `${range.startLine}:${range.endLine}` === current)
          ? current
          : result.ranges[0]
            ? `${result.ranges[0].startLine}:${result.ranges[0].endLine}`
            : undefined,
      );
      setBlameError('');
      return result;
    } catch (reason) {
      const message = String(reason);
      setBlameError(message);
      return null;
    } finally {
      if (!silent) {
        setBlameLoading(false);
      }
    }
  }, [tab.filePath, tab.projectPath]);

  useEffect(() => {
    if (!isActive) {
      return;
    }

    setHistoryEntries([]);
    setHistoryHasMore(false);
    setHistoryCursor(undefined);
    setHistoryError('');
    setSelectedCommitHash(undefined);
    setDiffResult(null);
    setDiffError('');
    setBlameResult(null);
    setBlameError('');
    setSelectedBlameRangeKey(undefined);
    setViewMode('timeline');
    clearFeedback();

    void loadHistory();
  }, [clearFeedback, isActive, loadHistory, tab.filePath]);

  const selectedEntry = useMemo(
    () => historyEntries.find((entry) => entry.commitHash === selectedCommitHash) ?? historyEntries[0],
    [historyEntries, selectedCommitHash],
  );

  const selectedBlameRange = useMemo(
    () =>
      blameResult?.ranges.find(
        (range) => `${range.startLine}:${range.endLine}` === selectedBlameRangeKey,
      ) ?? blameResult?.ranges[0],
    [blameResult?.ranges, selectedBlameRangeKey],
  );

  const selectedCommitHashForDiff = selectedEntry?.commitHash;
  const selectedCommitPathForDiff = selectedEntry?.path;
  const selectedCommitOldPathForDiff = selectedEntry?.oldPath ?? null;

  useEffect(() => {
    if (!isActive || !selectedCommitHashForDiff || !selectedCommitPathForDiff || !repoPath) {
      return;
    }

    setDiffLoading(true);
    setDiffError('');

    void invoke<GitDiffResult>('get_commit_file_diff', {
      repoPath,
      commitHash: selectedCommitHashForDiff,
      filePath: selectedCommitPathForDiff,
      oldFilePath: selectedCommitOldPathForDiff,
    })
      .then(setDiffResult)
      .catch((reason) => setDiffError(String(reason)))
      .finally(() => setDiffLoading(false));
  }, [isActive, repoPath, selectedCommitHashForDiff, selectedCommitOldPathForDiff, selectedCommitPathForDiff]);

  useEffect(() => {
    if (!isActive || viewMode !== 'blame' || blameResult || blameLoading) {
      return;
    }

    void loadBlame();
  }, [blameLoading, blameResult, isActive, loadBlame, viewMode]);

  const decoratedDiffResult = useMemo(
    () => (diffResult && selectedEntry ? attachCommitMetadata(diffResult, selectedEntry) : diffResult),
    [diffResult, selectedEntry],
  );

  const handleLoadMore = useCallback(async () => {
    if (!historyHasMore || !historyCursor) {
      return;
    }

    await loadHistory(historyCursor, true);
  }, [historyCursor, historyHasMore, loadHistory]);

  const handleJumpToCommit = useCallback(
    async (commitHash: string) => {
      if (!commitHash) {
        return;
      }

      setViewMode('timeline');
      if (historyEntries.some((entry) => entry.commitHash === commitHash)) {
        setSelectedCommitHash(commitHash);
        return;
      }

      let cursor = historyCursor;
      let hasMore = historyHasMore;
      while (hasMore && cursor) {
        const result = await loadHistory(cursor, true);
        if (!result) {
          return;
        }
        if (result.entries.some((entry) => entry.commitHash === commitHash)) {
          setSelectedCommitHash(commitHash);
          return;
        }
        cursor = result.nextCursor;
        hasMore = result.hasMore;
      }
    },
    [historyCursor, historyEntries, historyHasMore, loadHistory],
  );

  const refreshTimeline = useCallback(async () => {
    showRefreshing('正在同步最新内容');
    const result = await loadHistory(undefined, false, { silent: true });
    if (!result) {
      showError('自动刷新失败');
      return;
    }
    showSuccess('已自动刷新');
  }, [loadHistory, showError, showRefreshing, showSuccess]);

  const refreshBlame = useCallback(async () => {
    const now = Date.now();
    if (blameAutoRefreshRef.current.inFlight) {
      return blameAutoRefreshRef.current.inFlight;
    }
    if (now - blameAutoRefreshRef.current.lastSettledAt < BLAME_AUTO_REFRESH_COOLDOWN_MS) {
      return;
    }

    const refreshPromise = (async () => {
      showRefreshing('正在同步最新内容');
      const result = await loadBlame({ silent: true });
      if (!result) {
        showError('自动刷新失败');
        return;
      }
      showSuccess('已自动刷新 Blame');
    })();

    blameAutoRefreshRef.current.inFlight = refreshPromise;

    return refreshPromise.finally(() => {
      blameAutoRefreshRef.current.inFlight = null;
      blameAutoRefreshRef.current.lastSettledAt = Date.now();
    });
  }, [loadBlame, showError, showRefreshing, showSuccess]);

  useWorkspaceAutoRefresh({
    active: isActive && viewMode === 'timeline',
    projectPath: tab.projectPath,
    watchGit: true,
    onGitDirty: refreshTimeline,
  });

  useWorkspaceAutoRefresh({
    active: isActive && viewMode === 'blame',
    projectPath: tab.projectPath,
    filePaths: [tab.filePath],
    watchFs: true,
    watchGit: true,
    onFsChange: refreshBlame,
    onGitDirty: refreshBlame,
  });

  return (
    <div
      role="region"
      aria-label={`file-history:${tab.filePath}`}
      data-language-family={language.family}
      data-language-id={language.languageId}
      style={viewerStyle}
      className="flex h-full min-w-0 flex-col overflow-hidden bg-[var(--bg-surface)]"
    >
      <div
        className="flex items-center justify-between border-b px-3 py-2"
        style={{ borderColor: 'var(--viewer-border)', backgroundColor: 'var(--viewer-header-bg)' }}
      >
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold text-[var(--text-primary)]">{fileName}</span>
            <span
              className="rounded-full border px-1.5 py-px text-[8px] font-semibold tracking-[0.08em]"
              style={{
                color: skin.accent,
                borderColor: skin.border,
                backgroundColor: skin.accentSubtle,
              }}
            >
              {language.badge}
            </span>
          </div>
          <div className="truncate text-[11px] text-[var(--text-muted)]">{fileDetail || tab.filePath}</div>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex overflow-hidden rounded-full border border-[var(--viewer-border)]">
            <button
              type="button"
              data-testid="file-history-timeline-toggle"
              className={`px-3 py-1 text-[11px] font-medium transition-colors ${
                viewMode === 'timeline'
                  ? 'bg-[var(--accent-subtle)] text-[var(--accent)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
              onClick={() => setViewMode('timeline')}
            >
              历史时间线
            </button>
            <button
              type="button"
              data-testid="file-history-blame-toggle"
              className={`px-3 py-1 text-[11px] font-medium transition-colors ${
                viewMode === 'blame'
                  ? 'bg-[var(--accent-subtle)] text-[var(--accent)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
              onClick={() => setViewMode('blame')}
            >
              当前 Blame
            </button>
          </div>

          {viewMode === 'timeline' ? (
            <div className="flex overflow-hidden rounded-full border border-[var(--viewer-border)]">
              <button
                type="button"
                className={`px-3 py-1 text-[11px] font-medium transition-colors ${
                  diffViewMode === 'side-by-side'
                    ? 'bg-[var(--accent-subtle)] text-[var(--accent)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                }`}
                onClick={() => setDiffViewMode('side-by-side')}
              >
                并排
              </button>
              <button
                type="button"
                className={`px-3 py-1 text-[11px] font-medium transition-colors ${
                  diffViewMode === 'inline'
                    ? 'bg-[var(--accent-subtle)] text-[var(--accent)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                }`}
                onClick={() => setDiffViewMode('inline')}
              >
                内联
              </button>
            </div>
          ) : null}
          <ToolbarButton compact label="关闭文件历史" onClick={onClose}>
            <CloseIcon />
          </ToolbarButton>
        </div>
      </div>

      <AutoRefreshFeedbackBar feedback={refreshFeedback} testId="file-history-refresh-feedback" />

      {viewMode === 'timeline' ? (
        <div className="grid h-full min-h-0 grid-cols-[20rem_minmax(0,1fr)]">
          <div className="border-r border-[var(--viewer-border)] bg-[var(--viewer-panel-elevated)]">
            <div className="border-b border-[var(--viewer-border-subtle)] px-3 py-2 text-[11px] text-[var(--text-muted)]">
              按时间倒序显示该文件的提交记录，默认跨重命名追踪
            </div>
            <div className="h-[calc(100%-41px)] overflow-auto">
              {historyLoading && historyEntries.length === 0 ? (
                <div className="px-3 py-4 text-sm text-[var(--text-muted)]">正在加载文件历史...</div>
              ) : historyError ? (
                <div className="px-3 py-4 text-sm text-[var(--color-error)]">{historyError}</div>
              ) : historyEntries.length === 0 ? (
                <div className="px-3 py-4 text-sm text-[var(--text-muted)]">该文件暂无可显示的提交历史</div>
              ) : (
                <>
                  {historyEntries.map((entry) => {
                    const selected = entry.commitHash === selectedEntry?.commitHash;
                    return (
                      <button
                        key={entry.commitHash}
                        type="button"
                        data-testid={`file-history-entry-${entry.shortHash}`}
                        className={`block w-full border-b px-3 py-3 text-left transition-colors ${
                          selected
                            ? 'bg-[var(--viewer-accent-subtle)] text-[var(--text-primary)]'
                            : 'text-[var(--text-secondary)] hover:bg-[var(--viewer-border-subtle)]'
                        }`}
                        style={{ borderColor: 'var(--viewer-border-subtle)' }}
                        onClick={() => setSelectedCommitHash(entry.commitHash)}
                      >
                        <div className="truncate text-sm font-medium">{entry.message || '(无提交信息)'}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-muted)]">
                          <span>{entry.author}</span>
                          <span>{formatAbsoluteTime(entry.timestamp)}</span>
                          <span className="font-mono">{entry.shortHash}</span>
                        </div>
                        {entry.oldPath && entry.oldPath !== entry.path ? (
                          <div className="mt-1 truncate text-[11px] text-[var(--text-muted)]">
                            {entry.oldPath} → {entry.path}
                          </div>
                        ) : (
                          <div className="mt-1 truncate text-[11px] text-[var(--text-muted)]">{entry.path}</div>
                        )}
                      </button>
                    );
                  })}

                  {historyHasMore ? (
                    <div className="px-3 py-3">
                      <button
                        type="button"
                        className="w-full rounded-lg border border-[var(--viewer-border)] px-3 py-2 text-sm text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                        onClick={() => {
                          void handleLoadMore();
                        }}
                      >
                        {historyLoading ? '正在加载更多...' : '加载更多'}
                      </button>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </div>

          <div className="min-h-0 overflow-auto bg-[var(--viewer-panel)]">
            {selectedEntry ? (
              <div className="border-b border-[var(--viewer-border-subtle)] px-3 py-2">
                <div className="text-sm font-medium text-[var(--text-primary)]">{selectedEntry.message || '(无提交信息)'}</div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-muted)]">
                  <span>{selectedEntry.author}</span>
                  <span>{formatAbsoluteTime(selectedEntry.timestamp)}</span>
                  <span className="font-mono">{selectedEntry.shortHash}</span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <HistoryActionButton
                    testId="timeline-copy-author"
                    label="复制作者"
                    copiedLabel="已复制作者"
                    copied={isCopied('timeline-author')}
                    onClick={() => {
                      void handleCopyValue('timeline-author', '作者', selectedEntry.author);
                    }}
                  />
                  <HistoryActionButton
                    testId="timeline-copy-time"
                    label="复制时间"
                    copiedLabel="已复制时间"
                    copied={isCopied('timeline-time')}
                    onClick={() => {
                      void handleCopyValue('timeline-time', '时间', formatAbsoluteTime(selectedEntry.timestamp));
                    }}
                  />
                  <HistoryActionButton
                    testId="timeline-copy-commit"
                    label="复制 Commit"
                    copiedLabel="已复制Commit"
                    copied={isCopied('timeline-commit')}
                    onClick={() => {
                      void handleCopyValue('timeline-commit', 'Commit', selectedEntry.commitHash);
                    }}
                  />
                  {copyFeedback ? (
                    <span
                      data-testid="file-history-copy-feedback"
                      className="text-[11px] font-medium text-[var(--accent)]"
                      aria-live="polite"
                    >
                      {`已复制${copyFeedback.label}`}
                    </span>
                  ) : null}
                </div>
              </div>
            ) : null}

            {diffLoading ? (
              <div className="px-3 py-4 text-sm text-[var(--text-muted)]">正在加载该次提交的文件差异...</div>
            ) : diffError ? (
              <div className="px-3 py-4 text-sm text-[var(--color-error)]">{diffError}</div>
            ) : decoratedDiffResult?.isBinary ? (
              <div className="px-3 py-4 text-sm text-[var(--text-muted)]">二进制文件暂不支持历史 diff 预览。</div>
            ) : decoratedDiffResult?.tooLarge ? (
              <div className="px-3 py-4 text-sm text-[var(--text-muted)]">文件过大，暂不支持历史 diff 预览。</div>
            ) : decoratedDiffResult ? (
              diffViewMode === 'side-by-side' ? (
                <SideBySideView hunks={decoratedDiffResult.hunks} />
              ) : (
                <InlineView hunks={decoratedDiffResult.hunks} />
              )
            ) : (
              <div className="px-3 py-4 text-sm text-[var(--text-muted)]">请选择左侧的一次提交以查看具体修改</div>
            )}
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto bg-[var(--viewer-panel)]">
          {blameLoading ? (
            <div className="px-3 py-4 text-sm text-[var(--text-muted)]">正在加载当前文件的 Blame 信息...</div>
          ) : blameError ? (
            <div className="px-3 py-4 text-sm text-[var(--color-error)]">{blameError}</div>
          ) : blameResult?.isBinary ? (
            <div className="px-3 py-4 text-sm text-[var(--text-muted)]">二进制文件暂不支持 Blame 视图。</div>
          ) : blameResult?.tooLarge ? (
            <div className="px-3 py-4 text-sm text-[var(--text-muted)]">文件过大，暂不支持 Blame 视图。</div>
          ) : blameResult && blameResult.ranges.length > 0 ? (
            <div className="px-4 py-4">
              <div
                className="mb-4 rounded-2xl border px-4 py-3"
                style={{
                  borderColor: 'var(--viewer-border)',
                  backgroundColor: 'var(--viewer-header-bg)',
                }}
              >
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-muted)]">
                  <span className="rounded-full border border-[var(--viewer-border)] bg-[var(--viewer-panel)] px-2 py-1 text-[var(--text-secondary)]">
                    当前文件
                  </span>
                  <span className="font-medium text-[var(--text-primary)]">{fileName}</span>
                  <span className="truncate">{fileDetail || tab.filePath}</span>
                  <span className="rounded-full border border-[var(--viewer-border)] bg-[var(--viewer-panel)] px-2 py-1">
                    {blameResult.ranges.length} 个标注区段
                  </span>
                </div>
              </div>

              {selectedBlameRange ? (
                <div
                  className="mb-4 rounded-2xl border px-4 py-3"
                  style={{
                    borderColor: 'color-mix(in srgb, var(--accent) 38%, var(--viewer-border))',
                    background:
                      'linear-gradient(135deg, color-mix(in srgb, var(--accent-subtle) 92%, transparent), transparent 58%), var(--viewer-panel-elevated)',
                  }}
                >
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-muted)]">
                    <span className="rounded-full border border-[var(--viewer-border)] bg-[var(--viewer-panel)] px-2 py-1 text-[var(--accent)]">
                      当前选中区段
                    </span>
                    <span className="font-medium text-[var(--text-primary)]">{selectedBlameRange.author}</span>
                    <span>{formatBlameLineRange(selectedBlameRange.startLine, selectedBlameRange.endLine)}</span>
                    {selectedBlameRange.shortHash ? (
                      <span className="rounded-full border border-[var(--viewer-border)] bg-[var(--viewer-panel)] px-2 py-1 font-mono">
                        {selectedBlameRange.shortHash}
                      </span>
                    ) : null}
                    <span>{selectedBlameRange.lines.length} 行代码</span>
                  </div>
                  <div className="mt-2 text-sm font-semibold text-[var(--text-primary)]">
                    {selectedBlameRange.message || (selectedBlameRange.isUncommitted ? '未提交修改' : '(无提交信息)')}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <div className="text-[11px] text-[var(--text-muted)]">
                      {selectedBlameRange.isUncommitted
                        ? '点击下方区段头部可切换选中；当前区段属于工作区未提交修改'
                        : `${formatAbsoluteTime(selectedBlameRange.timestamp)} · 可先选中区段，再在时间线中查看对应提交`}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <HistoryActionButton
                        testId="blame-copy-author"
                        label="复制作者"
                        copiedLabel="已复制作者"
                        copied={isCopied('blame-author')}
                        onClick={() => {
                          void handleCopyValue('blame-author', '作者', selectedBlameRange.author);
                        }}
                      />
                      <HistoryActionButton
                        testId="blame-copy-time"
                        label="复制时间"
                        copiedLabel="已复制时间"
                        copied={isCopied('blame-time')}
                        onClick={() => {
                          void handleCopyValue('blame-time', '时间', formatAbsoluteTime(selectedBlameRange.timestamp));
                        }}
                      />
                      {selectedBlameRange.commitHash ? (
                        <HistoryActionButton
                          testId="blame-copy-commit"
                          label="复制 Commit"
                          copiedLabel="已复制Commit"
                          copied={isCopied('blame-commit')}
                          onClick={() => {
                            void handleCopyValue('blame-commit', 'Commit', selectedBlameRange.commitHash);
                          }}
                        />
                      ) : null}
                    </div>
                    {!selectedBlameRange.isUncommitted && selectedBlameRange.commitHash ? (
                      <HistoryActionButton
                        testId="blame-jump-commit"
                        label="在时间线中查看提交"
                        accent
                        onClick={() => {
                          void handleJumpToCommit(selectedBlameRange.commitHash);
                        }}
                      />
                    ) : null}
                    {copyFeedback ? (
                      <span
                        data-testid="file-history-copy-feedback"
                        className="text-[11px] font-medium text-[var(--accent)]"
                        aria-live="polite"
                      >
                        {`已复制${copyFeedback.label}`}
                      </span>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <div className="font-mono text-[12px] leading-[1.55]" style={{ fontFamily: 'var(--viewer-code-font)' }}>
                {blameResult.ranges.map((range) => {
                  const rangeKey = `${range.startLine}:${range.endLine}`;
                  const active = rangeKey === selectedBlameRangeKey;
                  const summary = range.message || (range.isUncommitted ? '未提交修改' : '(无提交信息)');

                  return (
                    <div
                      key={rangeKey}
                      className={`mb-4 overflow-hidden rounded-2xl border transition-all ${
                        active ? 'shadow-sm ring-1 ring-[var(--accent)]/35' : ''
                      }`}
                      style={{
                        borderColor: active
                          ? 'color-mix(in srgb, var(--accent) 45%, var(--viewer-border))'
                          : 'var(--viewer-border)',
                        backgroundColor: active
                          ? 'color-mix(in srgb, var(--viewer-accent-subtle) 72%, var(--viewer-panel))'
                          : 'var(--viewer-panel-elevated)',
                      }}
                    >
                      <button
                        type="button"
                        data-testid={`blame-range-${range.startLine}`}
                        className="block w-full border-b px-4 py-3 text-left transition-colors hover:bg-white/5"
                        style={{ borderColor: 'var(--viewer-border-subtle)' }}
                        onClick={() => {
                          setSelectedBlameRangeKey(rangeKey);
                        }}
                      >
                        <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-muted)]">
                          <span className="rounded-full border border-[var(--viewer-border)] bg-[var(--viewer-panel)] px-2 py-1 font-medium text-[var(--text-primary)]">
                            {range.author}
                          </span>
                          <span className="rounded-full border border-[var(--viewer-border)] bg-[var(--viewer-panel)] px-2 py-1">
                            {formatBlameLineRange(range.startLine, range.endLine)}
                          </span>
                          {range.shortHash ? (
                            <span className="rounded-full border border-[var(--viewer-border)] bg-[var(--viewer-panel)] px-2 py-1 font-mono">
                              {range.shortHash}
                            </span>
                          ) : null}
                          {range.isUncommitted ? (
                            <span className="rounded-full border border-[var(--viewer-border)] bg-[var(--viewer-panel)] px-2 py-1 text-[var(--accent)]">
                              未提交
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-2 text-sm font-semibold text-[var(--text-primary)]">{summary}</div>
                        <div className="mt-1 text-[11px] text-[var(--text-muted)]">
                          {range.isUncommitted ? '当前工作区中的未提交修改' : formatAbsoluteTime(range.timestamp)}
                        </div>
                      </button>

                      <BlameCodeSnippet
                        lines={range.lines}
                        startLine={range.startLine}
                        active={active}
                        languageBadge={language.badge}
                        languageKey={language.highlighterKey}
                        themePreset={themePreset}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="px-3 py-4 text-sm text-[var(--text-muted)]">该文件暂无可显示的 Blame 信息</div>
          )}
        </div>
      )}
    </div>
  );
}

