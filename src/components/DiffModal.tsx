import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store';
import type { DiffLine, GitDiffResult, GitFileStatus } from '../types';
import { buildInlineEntries, buildSideBySideRows, type DiffTextSegment } from '../utils/diffHighlight';
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

type ViewMode = 'side-by-side' | 'inline';
type DiffDialogLayoutMode = 'windowed' | 'maximized';

export function InlineView({ hunks }: { hunks: GitDiffResult['hunks'] }) {
  const entries = buildInlineEntries(hunks);

  return (
    <div className="font-mono text-[12px] leading-[1.1]" style={{ fontFamily: 'var(--viewer-code-font)' }}>
      {entries.map((entry, index) => (
        <div
          key={`${entry.line.kind}-${entry.line.oldLineno ?? 'n'}-${entry.line.newLineno ?? 'n'}-${index}`}
          className={`flex ${
            entry.line.kind === 'add'
              ? 'bg-[var(--diff-add-bg)]'
              : entry.line.kind === 'delete'
                ? 'bg-[var(--diff-del-bg)]'
                : ''
          }`}
        >
          <span
            className="w-7 flex-shrink-0 select-none pr-0.5 text-right text-[var(--text-muted)] opacity-60"
            style={{
              backgroundColor: 'var(--viewer-gutter)',
              borderRight: '1px solid var(--viewer-border)',
            }}
          >
            {entry.line.kind === 'add' ? '+' : entry.line.kind === 'delete' ? '-' : (entry.line.oldLineno ?? '')}
          </span>
          <span
            className={`flex-1 whitespace-pre px-1 ${
              entry.line.kind === 'add'
                ? 'text-[var(--diff-add-text)]'
                : entry.line.kind === 'delete'
                  ? 'text-[var(--diff-del-text)]'
                  : 'text-[var(--text-primary)]'
            }`}
          >
            <DiffSegmentText segments={entry.segments} fallback={entry.line.content} />
          </span>
        </div>
      ))}
    </div>
  );
}

export function SideBySideView({ hunks }: { hunks: GitDiffResult['hunks'] }) {
  const rows = buildSideBySideRows(hunks);

  const renderCell = (line: DiffLine | undefined, side: 'left' | 'right', segments: DiffTextSegment[]) => {
    if (!line) {
      return (
        <div className="flex h-full bg-[var(--bg-base)] opacity-30">
          <span className="w-7 flex-shrink-0 border-r border-[var(--viewer-border)] bg-[var(--viewer-gutter)]" />
          <span className="flex-1" />
        </div>
      );
    }

    const isAdd = line.kind === 'add';
    const isDelete = line.kind === 'delete';
    return (
      <div className={`flex ${isAdd ? 'bg-[var(--diff-add-bg)]' : isDelete ? 'bg-[var(--diff-del-bg)]' : ''}`}>
        <span
          className="w-7 flex-shrink-0 select-none pr-0.5 text-right text-[var(--text-muted)] opacity-60"
          style={{
            backgroundColor: 'var(--viewer-gutter)',
            borderRight: '1px solid var(--viewer-border)',
          }}
        >
          {side === 'left' ? (line.oldLineno ?? '') : (line.newLineno ?? '')}
        </span>
        <span
          className={`flex-1 whitespace-pre px-1 ${
            isAdd ? 'text-[var(--diff-add-text)]' : isDelete ? 'text-[var(--diff-del-text)]' : 'text-[var(--text-primary)]'
          }`}
        >
          <DiffSegmentText segments={segments} fallback={line.content} />
        </span>
      </div>
    );
  };

  return (
    <div className="flex h-full font-mono text-[12px] leading-[1.1]" style={{ fontFamily: 'var(--viewer-code-font)' }}>
      <div className="flex-1 overflow-auto border-r border-[var(--viewer-border)]">
        {rows.map((row, index) => (
          <div key={index}>{renderCell(row.left, 'left', row.leftSegments)}</div>
        ))}
      </div>
      <div className="flex-1 overflow-auto">
        {rows.map((row, index) => (
          <div key={index}>{renderCell(row.right, 'right', row.rightSegments)}</div>
        ))}
      </div>
    </div>
  );
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

export function DiffModal({
  open = true,
  onClose,
  projectPath,
  status,
  variant = 'dialog',
  active: activeOverride,
}: DiffModalProps) {
  const themePreset = useAppStore((state) => state.config.theme.preset);
  const [viewMode, setViewMode] = useState<ViewMode>('side-by-side');
  const [layoutMode, setLayoutMode] = useState<DiffDialogLayoutMode>('windowed');
  const [diffResult, setDiffResult] = useState<GitDiffResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const active = variant === 'tab' ? activeOverride ?? true : open;
  const maximized = layoutMode === 'maximized';
  const fileName = status.path.split('/').pop() ?? status.path;
  const language = resolveDocumentLanguage(status.path);
  const skin = resolveViewerSkin(language.family, themePreset);
  const viewerStyle = toViewerCssVars(skin);

  useEffect(() => {
    if (!active) return;

    setLoading(true);
    setError('');
    setDiffResult(null);

    invoke<GitDiffResult>('get_git_diff', {
      projectPath,
      filePath: status.path,
    })
      .then(setDiffResult)
      .catch((reason) => setError(String(reason)))
      .finally(() => setLoading(false));
  }, [active, projectPath, status.path]);

  useEffect(() => {
    if (active) {
      setLayoutMode('windowed');
    }
  }, [active, status.path]);

  if (variant === 'dialog' && !active) {
    return null;
  }

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
              className={`px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] transition-colors ${
                viewMode === 'side-by-side'
                  ? 'bg-[var(--accent-subtle)] text-[var(--accent)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
              onClick={() => setViewMode('side-by-side')}
            >
              Side
            </button>
            <button
              className={`px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] transition-colors ${
                viewMode === 'inline'
                  ? 'bg-[var(--accent-subtle)] text-[var(--accent)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
              onClick={() => setViewMode('inline')}
            >
              Inline
            </button>
          </div>
          {variant === 'dialog' && (
            <ToolbarButton
              active={maximized}
              compact
              label={maximized ? 'Restore diff window size' : 'Maximize diff window'}
              onClick={() => setLayoutMode((value) => (value === 'maximized' ? 'windowed' : 'maximized'))}
              testId="diff-modal-maximize-toggle"
            >
              {maximized ? <RestoreIcon /> : <MaximizeIcon />}
            </ToolbarButton>
          )}
          <ToolbarButton compact label="Close diff" onClick={onClose}>
            <CloseIcon />
          </ToolbarButton>
        </div>
      </div>

      <div className="flex-1 overflow-auto bg-[var(--viewer-panel)]" data-testid="worktree-diff-body">
        {loading && (
          <div className="flex h-full items-center justify-center text-[var(--text-muted)]">
            Loading diff...
          </div>
        )}
        {error && (
          <div className="flex h-full items-center justify-center text-[var(--color-error)]">
            {error}
          </div>
        )}
        {diffResult && diffResult.isBinary && (
          <div className="flex h-full items-center justify-center text-[var(--text-muted)]">
            Binary file, diff preview is not available.
          </div>
        )}
        {diffResult && diffResult.tooLarge && (
          <div className="flex h-full items-center justify-center text-[var(--text-muted)]">
            File is too large to preview as diff.
          </div>
        )}
        {diffResult && !diffResult.isBinary && !diffResult.tooLarge && (
          viewMode === 'side-by-side' ? <SideBySideView hunks={diffResult.hunks} /> : <InlineView hunks={diffResult.hunks} />
        )}
      </div>
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
        className="flex h-full min-w-0 flex-col overflow-hidden bg-[var(--bg-surface)]"
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
