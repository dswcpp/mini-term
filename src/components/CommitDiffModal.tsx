import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store';
import type { CommitFileInfo, GitDiffResult } from '../types';
import { OverlaySurface } from './OverlaySurface';
import { InlineView, SideBySideView } from './DiffModal';
import { CloseIcon, MaximizeIcon, RestoreIcon, ToolbarButton } from './documentViewer/controls';
import { resolveDocumentLanguage } from './documentViewer/language';
import { resolveViewerSkin, toViewerCssVars } from './documentViewer/viewerSkin';

interface CommitDiffModalProps {
  open?: boolean;
  onClose: () => void;
  repoPath: string;
  commitHash: string;
  commitMessage: string;
  files: CommitFileInfo[];
  variant?: 'dialog' | 'tab';
  active?: boolean;
}

type ViewMode = 'side-by-side' | 'inline';
type DiffDialogLayoutMode = 'windowed' | 'maximized';

const STATUS_LABELS: Record<string, { text: string; color: string }> = {
  added: { text: 'A', color: 'text-[var(--color-success)]' },
  modified: { text: 'M', color: 'text-[var(--color-warning)]' },
  deleted: { text: 'D', color: 'text-[var(--color-error)]' },
  renamed: { text: 'R', color: 'text-[var(--color-info)]' },
};

export function CommitDiffModal({
  open = true,
  onClose,
  repoPath,
  commitHash,
  commitMessage,
  files,
  variant = 'dialog',
  active: activeOverride,
}: CommitDiffModalProps) {
  const themePreset = useAppStore((state) => state.config.theme.preset);
  const [viewMode, setViewMode] = useState<ViewMode>('side-by-side');
  const [layoutMode, setLayoutMode] = useState<DiffDialogLayoutMode>('windowed');
  const [selectedFile, setSelectedFile] = useState<string>(files[0]?.path ?? '');
  const [diffResult, setDiffResult] = useState<GitDiffResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const active = variant === 'tab' ? activeOverride ?? true : open;
  const maximized = layoutMode === 'maximized';
  const activeFilePath = selectedFile || files[0]?.path || '';
  const language = useMemo(() => resolveDocumentLanguage(activeFilePath), [activeFilePath]);
  const skin = useMemo(() => resolveViewerSkin(language.family, themePreset), [language.family, themePreset]);
  const viewerStyle = useMemo(() => toViewerCssVars(skin), [skin]);

  const loadDiff = useCallback(async (filePath: string) => {
    if (!filePath) return;

    setLoading(true);
    setError('');
    setDiffResult(null);

    const fileInfo = files.find((file) => file.path === filePath);
    try {
      const result = await invoke<GitDiffResult>('get_commit_file_diff', {
        repoPath,
        commitHash,
        filePath,
        oldFilePath: fileInfo?.oldPath ?? null,
      });
      setDiffResult(result);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  }, [commitHash, files, repoPath]);

  useEffect(() => {
    if (active && selectedFile) {
      void loadDiff(selectedFile);
    }
  }, [active, loadDiff, selectedFile]);

  useEffect(() => {
    if (active && files.length > 0 && !files.find((file) => file.path === selectedFile)) {
      setSelectedFile(files[0].path);
    }
  }, [active, files, selectedFile]);

  useEffect(() => {
    if (active) {
      setLayoutMode('windowed');
    }
  }, [active, commitHash]);

  if (variant === 'dialog' && !active) {
    return null;
  }

  const content = (
    <>
      <div
        className="flex w-[10rem] flex-shrink-0 flex-col border-r"
        style={{
          borderColor: 'var(--viewer-border)',
          backgroundColor: 'var(--viewer-panel-elevated)',
        }}
      >
        <div className="border-b px-1 py-[3px]" style={{ borderColor: 'var(--viewer-border)' }}>
          <div className="truncate text-[9px] font-semibold" style={{ color: 'var(--viewer-accent)' }} title={commitMessage}>
            {commitMessage}
          </div>
          <div className="font-mono text-[8px]" style={{ color: 'var(--text-muted)' }}>
            {commitHash.slice(0, 7)}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {files.map((file) => {
            const label = STATUS_LABELS[file.status] ?? { text: '?', color: 'text-[var(--text-muted)]' };
            const fileName = file.path.split('/').pop() ?? file.path;
            const isSelected = file.path === selectedFile;
            const fileLanguage = resolveDocumentLanguage(file.path);

            return (
              <button
                key={file.path}
                type="button"
                aria-label={fileName}
                className="flex w-full items-center gap-1 px-1 py-[3px] text-left text-[10px] transition-colors hover:bg-[var(--viewer-border-subtle)]"
                style={
                  isSelected
                    ? {
                        backgroundColor: 'var(--viewer-accent-subtle)',
                        color: 'var(--viewer-accent)',
                      }
                    : {
                        color: 'var(--text-primary)',
                      }
                }
                onClick={() => setSelectedFile(file.path)}
                title={file.path}
              >
                <span className={`flex-shrink-0 text-xs font-bold ${label.color}`}>{label.text}</span>
                <span className="min-w-0 flex-1 truncate">{fileName}</span>
                <span
                  className="border px-1 py-0 text-[8px] font-semibold tracking-[0.08em]"
                  style={{
                    color: isSelected ? 'var(--viewer-accent)' : 'var(--text-muted)',
                    borderColor: isSelected ? 'var(--viewer-border)' : 'var(--viewer-border-subtle)',
                    backgroundColor: isSelected ? 'var(--viewer-accent-subtle)' : 'transparent',
                  }}
                >
                  {fileLanguage.badge}
                </span>
              </button>
            );
          })}
        </div>
        <div className="border-t px-1 py-[3px] text-[8px]" style={{ borderColor: 'var(--viewer-border)', color: 'var(--text-muted)' }}>
          共 {files.length} 个变更文件
        </div>
      </div>

      <div className="flex flex-1 flex-col">
        <div
          className="flex flex-shrink-0 items-center justify-between border-b px-1 py-[3px]"
          style={{
            borderColor: 'var(--viewer-border)',
            background: 'var(--viewer-header-bg)',
            backgroundColor: 'var(--viewer-header-bg)',
          }}
        >
        <div className="flex min-w-0 items-center gap-1">
            <span
              className="max-w-[280px] truncate text-[10px] font-semibold"
              style={{ color: 'var(--text-primary)' }}
              title={selectedFile}
            >
              {selectedFile.split('/').pop() ?? selectedFile}
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
                并排
              </button>
              <button
                className={`px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] transition-colors ${
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
                label={maximized ? '还原提交 diff 窗口大小' : '最大化提交 diff 窗口'}
                onClick={() => setLayoutMode((value) => (value === 'maximized' ? 'windowed' : 'maximized'))}
                testId="commit-diff-modal-maximize-toggle"
              >
                {maximized ? <RestoreIcon /> : <MaximizeIcon />}
              </ToolbarButton>
            )}
            <ToolbarButton compact label="关闭提交 diff" onClick={onClose}>
              <CloseIcon />
            </ToolbarButton>
          </div>
        </div>

        <div className="flex-1 overflow-auto" style={{ backgroundColor: 'var(--viewer-panel)' }} data-testid="commit-diff-body">
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
            viewMode === 'side-by-side' ? <SideBySideView hunks={diffResult.hunks} /> : <InlineView hunks={diffResult.hunks} />
          )}
          {!loading && !error && !diffResult && files.length === 0 && (
            <div className="flex h-full items-center justify-center text-[var(--text-muted)]">
              这个提交没有文件变更。
            </div>
          )}
        </div>
      </div>
    </>
  );

  if (variant === 'tab') {
    return (
      <div
        role="region"
        aria-label={`commit-diff:${commitHash.slice(0, 7)}`}
        data-language-family={language.family}
        data-language-id={language.languageId}
        style={viewerStyle}
        className="flex h-full min-w-0 overflow-hidden bg-[var(--bg-surface)]"
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
        'aria-label': `commit-diff:${commitHash.slice(0, 7)}`,
        'data-layout-mode': layoutMode,
        'data-language-family': language.family,
        'data-language-id': language.languageId,
      }}
      panelStyle={viewerStyle}
      panelClassName={
        maximized
          ? 'relative flex h-[calc(100vh-8px)] w-[calc(100vw-8px)] overflow-hidden rounded-none border border-[var(--border-strong)] bg-[var(--bg-surface)] shadow-none animate-slide-in'
          : 'relative flex h-[85vh] w-[92vw] overflow-hidden rounded-none border border-[var(--border-strong)] bg-[var(--bg-surface)] shadow-none animate-slide-in'
      }
    >
      {content}
    </OverlaySurface>
  );
}
