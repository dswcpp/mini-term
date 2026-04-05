import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store';
import { useAutoRefreshFeedback } from '../hooks/useAutoRefreshFeedback';
import { useWorkspaceAutoRefresh } from '../hooks/useWorkspaceAutoRefresh';
import { AutoRefreshFeedbackBar } from './AutoRefreshFeedback';
import type {
  DiffChangeBlockInfo,
  DiffHunk,
  DiffLine,
  GitBlameInfo,
  GitDiffResult,
  GitFileStatus,
} from '../types';
import { buildInlineEntries, buildSideBySideRows, type DiffTextSegment } from '../utils/diffHighlight';
import { showConfirm } from '../utils/interactionDialog';
import { showContextMenu } from '../utils/contextMenu';
import { OverlaySurface } from './OverlaySurface';
import { CloseIcon, MaximizeIcon, RestoreIcon, ToolbarButton } from './documentViewer/controls';
import { resolveDocumentLanguage } from './documentViewer/language';
import { resolveViewerSkin, toViewerCssVars } from './documentViewer/viewerSkin';

interface DiffModalProps {
  open?: boolean;
  onClose: () => void;
  projectPath: string;
  status: GitFileStatus;
  variant?: 'dialog' | 'tab';
  active?: boolean;
}

interface DiffViewProps {
  hunks: GitDiffResult['hunks'];
  canRestorePartial?: boolean;
  partialRestoreReason?: string;
  hoveredChangeBlockKey?: string | null;
  onChangeBlockHover?: (key: string | null) => void;
  onRestoreChangeBlock?: (hunkKey: string, blockIndex: number) => void;
}

type ViewMode = 'side-by-side' | 'inline';
type DiffDialogLayoutMode = 'windowed' | 'maximized';
type FeedbackState = { tone: 'success' | 'error'; message: string } | null;

function createChangeBlockKey(hunkKey: string, blockIndex: number) {
  return `${hunkKey}:${blockIndex}`;
}

function formatBlameTimestamp(timestamp?: number) {
  if (!timestamp) {
    return '';
  }

  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp * 1000));
}

function findChangeBlockForLineIndex(hunk: DiffHunk, lineIndex: number) {
  return hunk.changeBlocks.find(
    (block) => lineIndex >= block.lineStartIndex && lineIndex <= block.lineEndIndex,
  );
}

function findChangeBlockEndingAtLineIndex(hunk: DiffHunk, lineIndex?: number) {
  if (lineIndex == null) {
    return undefined;
  }

  return hunk.changeBlocks.find((block) => block.lineEndIndex === lineIndex);
}

function isChangedLine(line?: DiffLine) {
  return line?.kind === 'add' || line?.kind === 'delete';
}

function DiffSegmentText({ segments, fallback }: { segments: DiffTextSegment[]; fallback: string }) {
  if (segments.length === 0) {
    return fallback;
  }

  return (
    <>
      {segments.map((segment, index) => (
        <span
          key={`${segment.kind}-${index}`}
          className={
            segment.kind === 'added'
              ? 'bg-[var(--diff-add-inline-bg)] text-[var(--diff-add-inline-text)]'
              : segment.kind === 'removed'
                ? 'bg-[var(--diff-del-inline-bg)] text-[var(--diff-del-inline-text)]'
                : undefined
          }
        >
          {segment.value}
        </span>
      ))}
    </>
  );
}

function ChangeBlockMeta({
  blame,
  active = false,
  testId,
}: {
  blame?: GitBlameInfo;
  active?: boolean;
  testId?: string;
}) {
  if (!blame) {
    return null;
  }

  return (
    <div
      data-testid={testId}
      data-active={active ? 'true' : 'false'}
      className={`mx-3 mb-1 mt-1 flex items-center gap-2 rounded-md border px-2.5 py-1 text-[10px] transition-colors ${
        active
          ? 'border-[var(--viewer-accent)]/40 bg-[var(--viewer-accent-subtle)] text-[var(--text-primary)]'
          : 'border-[var(--viewer-border-subtle)] bg-[var(--bg-elevated)]/35 text-[var(--text-muted)]'
      }`}
    >
      <span className="font-medium text-[var(--text-secondary)]">{blame.authorName}</span>
      <span>{formatBlameTimestamp(blame.authorTime)}</span>
      {blame.summary ? <span className="truncate">· {blame.summary}</span> : null}
      {blame.isUncommitted ? <span className="ml-auto text-[var(--viewer-accent)]">未提交</span> : null}
    </div>
  );
}

function openRestoreContextMenu(
  event: MouseEvent,
  item: {
    enabled: boolean;
    label: string;
    onClick?: () => void;
  },
) {
  event.preventDefault();
  event.stopPropagation();
  showContextMenu(event.clientX, event.clientY, [
    {
      label: item.label,
      disabled: !item.enabled,
      onClick: item.enabled ? item.onClick : undefined,
    },
  ]);
}

function renderChangeBlockMetaRow(
  hunk: DiffHunk,
  block: DiffChangeBlockInfo | undefined,
  hoveredChangeBlockKey?: string | null,
) {
  if (!block) {
    return null;
  }

  const blockKey = createChangeBlockKey(hunk.hunkKey, block.blockIndex);
  return (
    <ChangeBlockMeta
      blame={block.blame}
      active={hoveredChangeBlockKey === blockKey}
      testId={`change-block-meta-${block.blockIndex}`}
    />
  );
}

export function InlineView({
  hunks,
  canRestorePartial = false,
  partialRestoreReason,
  hoveredChangeBlockKey,
  onChangeBlockHover,
  onRestoreChangeBlock,
}: DiffViewProps) {
  return (
    <div className="font-mono text-[12px] leading-[1.1]" style={{ fontFamily: 'var(--viewer-code-font)' }}>
      {hunks.map((hunk) => {
        const entries = buildInlineEntries([hunk]);

        return (
          <div key={hunk.hunkKey} className="border-b border-[var(--viewer-border-subtle)] last:border-b-0">
            {entries.map((entry) => {
              const changeBlock = findChangeBlockForLineIndex(hunk, entry.lineIndex);
              const changeBlockKey = changeBlock
                ? createChangeBlockKey(hunk.hunkKey, changeBlock.blockIndex)
                : null;
              const active = changeBlockKey != null && hoveredChangeBlockKey === changeBlockKey;
              const endingBlock = findChangeBlockEndingAtLineIndex(hunk, entry.lineIndex);
              const canInteract = isChangedLine(entry.line) && changeBlock && canRestorePartial && onRestoreChangeBlock;
              const menuLabel = canInteract ? '还原此修改块' : (partialRestoreReason ?? '当前修改暂不支持按修改块还原');

              return (
                <div key={`${hunk.hunkKey}-${entry.lineIndex}`}>
                  <div
                    data-testid={`inline-diff-line-${entry.lineIndex}`}
                    className={`flex ${
                      entry.line.kind === 'add'
                        ? 'bg-[var(--diff-add-bg)]'
                        : entry.line.kind === 'delete'
                          ? 'bg-[var(--diff-del-bg)]'
                          : ''
                    }`}
                  >
                    <span
                      data-testid={`inline-diff-gutter-${entry.lineIndex}`}
                      className="w-10 flex-shrink-0 select-none pr-1 text-right text-[var(--text-muted)] opacity-60"
                      style={{
                        backgroundColor: 'var(--viewer-gutter)',
                        borderRight: '1px solid var(--viewer-border)',
                      }}
                    >
                      {entry.line.kind === 'add'
                        ? `+ ${entry.line.newLineno ?? ''}`
                        : entry.line.kind === 'delete'
                          ? `- ${entry.line.oldLineno ?? ''}`
                          : entry.line.oldLineno ?? ''}
                    </span>
                    <span
                      data-testid={`inline-diff-content-${entry.lineIndex}`}
                      className={`flex-1 whitespace-pre px-2 py-[2px] transition-colors ${
                        entry.line.kind === 'add'
                          ? 'text-[var(--diff-add-text)]'
                          : entry.line.kind === 'delete'
                            ? 'text-[var(--diff-del-text)]'
                            : 'text-[var(--text-primary)]'
                      } ${active ? 'bg-white/8' : ''}`}
                      onContextMenu={
                        isChangedLine(entry.line)
                          ? (event) =>
                              openRestoreContextMenu(event, {
                                enabled: Boolean(canInteract),
                                label: menuLabel,
                                onClick: changeBlock
                                  ? () => onRestoreChangeBlock?.(hunk.hunkKey, changeBlock.blockIndex)
                                  : undefined,
                              })
                          : undefined
                      }
                      onMouseEnter={() => {
                        if (changeBlockKey) {
                          onChangeBlockHover?.(changeBlockKey);
                        }
                      }}
                      onMouseLeave={() => {
                        if (changeBlockKey) {
                          onChangeBlockHover?.(null);
                        }
                      }}
                    >
                      <DiffSegmentText segments={entry.segments} fallback={entry.line.content} />
                    </span>
                  </div>
                  {renderChangeBlockMetaRow(hunk, endingBlock, hoveredChangeBlockKey)}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

export function SideBySideView({
  hunks,
  canRestorePartial = false,
  partialRestoreReason,
  hoveredChangeBlockKey,
  onChangeBlockHover,
  onRestoreChangeBlock,
}: DiffViewProps) {
  const renderCell = (
    hunk: DiffHunk,
    side: 'left' | 'right',
    line: DiffLine | undefined,
    lineIndex: number | undefined,
    segments: DiffTextSegment[],
  ) => {
    if (!line) {
      return (
        <div className="flex h-full bg-[var(--bg-base)] opacity-30">
          <span className="w-10 flex-shrink-0 border-r border-[var(--viewer-border)] bg-[var(--viewer-gutter)]" />
          <span className="flex-1" />
        </div>
      );
    }

    const isAdd = line.kind === 'add';
    const isDelete = line.kind === 'delete';
    const changeBlock = lineIndex == null ? undefined : findChangeBlockForLineIndex(hunk, lineIndex);
    const changeBlockKey = changeBlock ? createChangeBlockKey(hunk.hunkKey, changeBlock.blockIndex) : null;
    const active = changeBlockKey != null && hoveredChangeBlockKey === changeBlockKey;
    const canInteract = isChangedLine(line) && changeBlock && canRestorePartial && onRestoreChangeBlock;
    const menuLabel = canInteract ? '还原此修改块' : (partialRestoreReason ?? '当前修改暂不支持按修改块还原');

    return (
      <div className={`flex ${isAdd ? 'bg-[var(--diff-add-bg)]' : isDelete ? 'bg-[var(--diff-del-bg)]' : ''}`}>
        <span
          data-testid={lineIndex == null ? undefined : `${side}-diff-gutter-${lineIndex}`}
          className="w-10 flex-shrink-0 select-none pr-1 text-right text-[var(--text-muted)] opacity-60"
          style={{
            backgroundColor: 'var(--viewer-gutter)',
            borderRight: '1px solid var(--viewer-border)',
          }}
        >
          {side === 'left' ? (line.oldLineno ?? '') : (line.newLineno ?? '')}
        </span>
        <span
          data-testid={lineIndex == null ? undefined : `${side}-diff-content-${lineIndex}`}
          className={`flex-1 whitespace-pre px-2 py-[2px] transition-colors ${
            isAdd ? 'text-[var(--diff-add-text)]' : isDelete ? 'text-[var(--diff-del-text)]' : 'text-[var(--text-primary)]'
          } ${active ? 'bg-white/8' : ''}`}
          onContextMenu={
            isChangedLine(line)
              ? (event) =>
                  openRestoreContextMenu(event, {
                    enabled: Boolean(canInteract),
                    label: menuLabel,
                    onClick: changeBlock
                      ? () => onRestoreChangeBlock?.(hunk.hunkKey, changeBlock.blockIndex)
                      : undefined,
                  })
              : undefined
          }
          onMouseEnter={() => {
            if (changeBlockKey) {
              onChangeBlockHover?.(changeBlockKey);
            }
          }}
          onMouseLeave={() => {
            if (changeBlockKey) {
              onChangeBlockHover?.(null);
            }
          }}
        >
          <DiffSegmentText segments={segments} fallback={line.content} />
        </span>
      </div>
    );
  };

  return (
    <div className="font-mono text-[12px] leading-[1.1]" style={{ fontFamily: 'var(--viewer-code-font)' }}>
      {hunks.map((hunk) => {
        const rows = buildSideBySideRows([hunk]);

        return (
          <div key={hunk.hunkKey} className="border-b border-[var(--viewer-border-subtle)] last:border-b-0">
            {rows.map((row, index) => {
              const endingBlock =
                findChangeBlockEndingAtLineIndex(hunk, row.leftLineIndex) ??
                findChangeBlockEndingAtLineIndex(hunk, row.rightLineIndex);

              return (
                <div key={`${hunk.hunkKey}-${index}`}>
                  <div className="grid grid-cols-2">
                    <div
                      data-testid={row.leftLineIndex == null ? undefined : `left-diff-line-${row.leftLineIndex}`}
                      className="border-r border-[var(--viewer-border)]"
                    >
                      {renderCell(hunk, 'left', row.left, row.leftLineIndex, row.leftSegments)}
                    </div>
                    <div
                      data-testid={row.rightLineIndex == null ? undefined : `right-diff-line-${row.rightLineIndex}`}
                    >
                      {renderCell(hunk, 'right', row.right, row.rightLineIndex, row.rightSegments)}
                    </div>
                  </div>
                  {renderChangeBlockMetaRow(hunk, endingBlock, hoveredChangeBlockKey)}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function getPartialRestoreReason(status: GitFileStatus, diffResult: GitDiffResult | null) {
  if (diffResult?.isBinary) {
    return '二进制文件不支持按修改块还原';
  }

  if (diffResult?.tooLarge) {
    return '超大文件不支持按修改块还原';
  }

  switch (status.status) {
    case 'added':
    case 'untracked':
      return '新增文件不支持按修改块还原';
    case 'deleted':
      return '删除文件不支持按修改块还原';
    case 'conflicted':
      return '冲突文件暂不支持还原';
    case 'renamed':
      return '当前重命名状态不支持按修改块还原';
    default:
      return '当前修改暂不支持按修改块还原';
  }
}

function getRestoreFileLabel(status: GitFileStatus) {
  switch (status.status) {
    case 'added':
    case 'untracked':
      return '删除并还原此新增文件';
    case 'deleted':
      return '恢复此已删除文件';
    default:
      return '还原此文件';
  }
}

function getRestoreFileMessage(status: GitFileStatus) {
  switch (status.status) {
    case 'added':
    case 'untracked':
      return '这会删除工作区中的这个新增文件。';
    case 'deleted':
      return '这会恢复该文件在工作区中的删除。';
    default:
      return '这会撤销该文件在工作区中的所有未提交修改。';
  }
}

function getRestoreFileDisabledReason(status: GitFileStatus) {
  if (status.status === 'conflicted') {
    return '冲突文件请先手动解决';
  }
  return '当前文件暂不支持还原';
}

export function DiffModal({
  open = true,
  onClose,
  projectPath,
  status,
  variant = 'dialog',
  active: activeOverride,
}: DiffModalProps) {
  const themePreset = useAppStore((state) => state.config.theme.preset);
  const showNotice = useAppStore((state) => state.showNotice);
  const [viewMode, setViewMode] = useState<ViewMode>('side-by-side');
  const [layoutMode, setLayoutMode] = useState<DiffDialogLayoutMode>('windowed');
  const [diffResult, setDiffResult] = useState<GitDiffResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState<FeedbackState>(null);
  const [hoveredChangeBlockKey, setHoveredChangeBlockKey] = useState<string | null>(null);
  const {
    feedback: refreshFeedback,
    clearFeedback: clearRefreshFeedback,
    showRefreshing,
    showSuccess,
    showError,
  } = useAutoRefreshFeedback();

  const active = variant === 'tab' ? activeOverride ?? true : open;
  const maximized = layoutMode === 'maximized';
  const fileName = status.path.split('/').pop() ?? status.path;
  const language = useMemo(() => resolveDocumentLanguage(status.path), [status.path]);
  const skin = useMemo(() => resolveViewerSkin(language.family, themePreset), [language.family, themePreset]);
  const viewerStyle = useMemo(() => toViewerCssVars(skin), [skin]);

  const loadDiff = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent ?? false;

    if (silent) {
      setFeedback(null);
    } else {
      setLoading(true);
      setError('');
      setFeedback(null);
      setHoveredChangeBlockKey(null);
      setDiffResult(null);
    }

    try {
      const result = await invoke<GitDiffResult>('get_git_diff', {
        projectPath,
        filePath: status.path,
        oldFilePath: status.oldPath ?? null,
        status: status.status,
      });
      setError('');
      setDiffResult(result);
      setHoveredChangeBlockKey(null);
      return result;
    } catch (reason) {
      if (!silent) {
        setError(String(reason));
      }
      return null;
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }, [projectPath, status.oldPath, status.path, status.status]);

  const closeDiffWithNotice = useCallback(() => {
    showNotice({
      tone: 'success',
      message: '该文件已无差异，已关闭 diff',
    });
    onClose();
  }, [onClose, showNotice]);

  useEffect(() => {
    if (!active) {
      return;
    }

    void loadDiff();
  }, [active, loadDiff]);

  useEffect(() => {
    if (active) {
      setLayoutMode('windowed');
      setFeedback(null);
      setHoveredChangeBlockKey(null);
      clearRefreshFeedback();
    }
  }, [active, clearRefreshFeedback, status.path]);

  useWorkspaceAutoRefresh({
    active: variant === 'tab' && active,
    projectPath,
    watchGit: true,
    onGitDirty: async () => {
      showRefreshing('正在同步最新内容');
      const result = await loadDiff({ silent: true });
      if (!result) {
        showError('差异刷新失败');
        return;
      }

      if (result.diffCleared) {
        closeDiffWithNotice();
        return;
      }

      showSuccess('已自动刷新差异');
    },
  });

  const handleRestoreFile = useCallback(async () => {
    if (!diffResult?.canRestoreFile) {
      setFeedback({
        tone: 'error',
        message: getRestoreFileDisabledReason(status),
      });
      return;
    }

    const confirmLabel = getRestoreFileLabel(status);
    const confirmed = await showConfirm('还原此文件', getRestoreFileMessage(status), {
      detail: '此操作不可在 Mini-Term 中逐步撤回，请确认继续。',
      confirmLabel,
      cancelLabel: '取消',
      tone: 'danger',
    });

    if (!confirmed) {
      return;
    }

    setFeedback(null);

    try {
      const result = await invoke<GitDiffResult>('restore_git_file', {
        projectPath,
        filePath: status.path,
        oldFilePath: status.oldPath ?? null,
        status: status.status,
      });

      setDiffResult(result);
      setHoveredChangeBlockKey(null);

      if (result.diffCleared) {
        closeDiffWithNotice();
        return;
      }

      setFeedback({
        tone: 'success',
        message: '已还原此文件',
      });
    } catch (reason) {
      setFeedback({
        tone: 'error',
        message: String(reason),
      });
    }
  }, [closeDiffWithNotice, diffResult?.canRestoreFile, projectPath, status]);

  const handleRestoreChangeBlock = useCallback(
    async (hunkKey: string, blockIndex: number) => {
      try {
        const result = await invoke<GitDiffResult>('restore_git_change_block', {
          projectPath,
          filePath: status.path,
          oldFilePath: status.oldPath ?? null,
          hunkKey,
          blockIndex,
          status: status.status,
        });

        setDiffResult(result);
        setHoveredChangeBlockKey(null);

        if (result.diffCleared) {
          closeDiffWithNotice();
          return;
        }

        setFeedback({
          tone: 'success',
          message: '已还原此修改块',
        });
      } catch (reason) {
        setFeedback({
          tone: 'error',
          message: String(reason),
        });
      }
    },
    [closeDiffWithNotice, projectPath, status],
  );

  if (variant === 'dialog' && !active) {
    return null;
  }

  const partialRestoreReason = getPartialRestoreReason(status, diffResult);
  const restoreFileLabel = getRestoreFileLabel(status);
  const showRestoreBar = Boolean(diffResult) && !loading && !error && !diffResult?.isBinary && !diffResult?.tooLarge;
  const showPartialHint = diffResult?.canRestorePartial;

  const statusFeedback = refreshFeedback ?? feedback;
  const normalizedStatusFeedback = statusFeedback
    ? {
        tone:
          statusFeedback.tone === 'success'
            ? 'refresh-success'
            : statusFeedback.tone === 'error'
              ? 'refresh-error'
              : statusFeedback.tone,
        message: statusFeedback.message,
      }
    : null;

  const content = (
    <>
      <div
        className="flex flex-shrink-0 items-center justify-between border-b px-1 py-[3px]"
        style={{
          borderColor: 'var(--viewer-border)',
          background: 'var(--viewer-header-bg)',
          backgroundColor: 'var(--viewer-header-bg)',
        }}
      >
        <div className="flex min-w-0 items-center gap-1">
          <span className="truncate text-[10px] font-semibold tracking-[0.01em] text-[var(--accent)]" title={status.path}>
            {fileName}
          </span>
          <span
            className="border px-1 py-0 text-[7px] font-semibold tracking-[0.08em]"
            style={{
              color: 'var(--viewer-accent)',
              borderColor: 'var(--viewer-border)',
              backgroundColor: 'var(--viewer-accent-subtle)',
            }}
          >
            {language.badge}
          </span>
          <span className="border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-1 py-0 text-[7px] text-[var(--text-muted)]">
            {status.statusLabel}
          </span>
        </div>
        <div className="flex items-center gap-px">
          <div className="flex overflow-hidden border border-[var(--viewer-border)]">
            <button
              type="button"
              className={`px-2 py-0.5 text-[10px] font-semibold tracking-[0.08em] transition-colors ${
                viewMode === 'side-by-side'
                  ? 'bg-[var(--accent-subtle)] text-[var(--accent)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
              onClick={() => setViewMode('side-by-side')}
            >
              并排
            </button>
            <button
              type="button"
              className={`px-2 py-0.5 text-[10px] font-semibold tracking-[0.08em] transition-colors ${
                viewMode === 'inline'
                  ? 'bg-[var(--accent-subtle)] text-[var(--accent)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
              onClick={() => setViewMode('inline')}
            >
              内联
            </button>
          </div>
          {variant === 'dialog' && (
            <ToolbarButton
              active={maximized}
              compact
              label={maximized ? '恢复 diff 窗口大小' : '最大化 diff 窗口'}
              onClick={() => setLayoutMode((value) => (value === 'maximized' ? 'windowed' : 'maximized'))}
              testId="diff-modal-maximize-toggle"
            >
              {maximized ? <RestoreIcon /> : <MaximizeIcon />}
            </ToolbarButton>
          )}
          <ToolbarButton compact label="关闭 diff" onClick={onClose}>
            <CloseIcon />
          </ToolbarButton>
        </div>
      </div>

      <AutoRefreshFeedbackBar feedback={normalizedStatusFeedback} testId="diff-feedback" />

      <div className="flex-1 overflow-auto bg-[var(--viewer-panel)]" data-testid="worktree-diff-body">
        {loading && (
          <div className="flex h-full items-center justify-center text-[var(--text-muted)]">
            正在加载 diff...
          </div>
        )}
        {error && (
          <div className="flex h-full items-center justify-center text-[var(--color-error)]">
            {error}
          </div>
        )}
        {diffResult && diffResult.isBinary && (
          <div className="flex h-full items-center justify-center text-[var(--text-muted)]">
            二进制文件暂不支持 diff 预览。
          </div>
        )}
        {diffResult && diffResult.tooLarge && (
          <div className="flex h-full items-center justify-center text-[var(--text-muted)]">
            文件过大，暂不支持 diff 预览。
          </div>
        )}
        {diffResult && !diffResult.isBinary && !diffResult.tooLarge && (
          <div className="flex min-h-full flex-col">
            {showPartialHint ? (
              <div className="border-b border-[var(--viewer-border-subtle)] px-3 py-1 text-[10px] text-[var(--text-muted)]">
                右击红色或绿色修改块可局部还原
              </div>
            ) : null}
            {viewMode === 'side-by-side' ? (
              <SideBySideView
                hunks={diffResult.hunks}
                canRestorePartial={diffResult.canRestorePartial}
                partialRestoreReason={partialRestoreReason}
                hoveredChangeBlockKey={hoveredChangeBlockKey}
                onChangeBlockHover={setHoveredChangeBlockKey}
                onRestoreChangeBlock={handleRestoreChangeBlock}
              />
            ) : (
              <InlineView
                hunks={diffResult.hunks}
                canRestorePartial={diffResult.canRestorePartial}
                partialRestoreReason={partialRestoreReason}
                hoveredChangeBlockKey={hoveredChangeBlockKey}
                onChangeBlockHover={setHoveredChangeBlockKey}
                onRestoreChangeBlock={handleRestoreChangeBlock}
              />
            )}
          </div>
        )}
      </div>

      {showRestoreBar ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-[var(--viewer-border)] bg-[var(--bg-elevated)]/95 px-4 py-2 shadow-[var(--shadow-overlay)] backdrop-blur-md">
            <div className="text-[10px] text-[var(--text-muted)]">
              {diffResult?.canRestoreFile ? '整文件还原会撤销当前文件的工作区改动' : getRestoreFileDisabledReason(status)}
            </div>
            <button
              type="button"
              data-testid="restore-file-button"
              className="inline-flex items-center justify-center rounded-full border border-rose-500/35 bg-rose-500/10 px-3 py-1 text-[11px] font-semibold text-rose-200 transition-colors hover:bg-rose-500/18 disabled:cursor-not-allowed disabled:opacity-45"
              disabled={!diffResult?.canRestoreFile}
              onClick={() => {
                void handleRestoreFile();
              }}
            >
              {restoreFileLabel}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );

  if (variant === 'tab') {
    return (
      <div
        role="region"
        aria-label={`worktree-diff:${status.path}`}
        data-language-family={language.family}
        data-language-id={language.languageId}
        style={viewerStyle}
        className="relative flex h-full min-w-0 flex-col overflow-hidden bg-[var(--bg-surface)]"
      >
        {content}
      </div>
    );
  }

  return (
    <OverlaySurface
      open={open}
      onClose={onClose}
      rootClassName={maximized ? 'p-1' : ''}
      panelProps={{
        role: 'dialog',
        'aria-modal': true,
        'aria-label': `worktree-diff:${status.path}`,
        'data-layout-mode': layoutMode,
        'data-language-family': language.family,
        'data-language-id': language.languageId,
      }}
      panelStyle={viewerStyle}
      panelClassName={
        maximized
          ? 'relative flex h-[calc(100vh-8px)] w-[calc(100vw-8px)] flex-col overflow-hidden rounded-none border border-[var(--border-strong)] bg-[var(--bg-surface)] shadow-none animate-slide-in'
          : 'relative flex h-[80vh] w-[90vw] flex-col overflow-hidden rounded-none border border-[var(--border-strong)] bg-[var(--bg-surface)] shadow-none animate-slide-in'
      }
    >
      {content}
    </OverlaySurface>
  );
}
