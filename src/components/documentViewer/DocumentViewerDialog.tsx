import { useEffect, useMemo, useRef, useState } from 'react';
import { selectWorkspaceConfig, useAppStore } from '../../store';
import { useAutoRefreshFeedback } from '../../hooks/useAutoRefreshFeedback';
import { useWorkspaceAutoRefresh } from '../../hooks/useWorkspaceAutoRefresh';
import type { PreviewMode } from '../../types';
import {
  isMermaidPreviewFilePath,
  isSvgPreviewFilePath,
  normalizePreviewModeForFile,
  supportsModeToggle,
} from '../../utils/documentPreview';
import { getWorkspaceMatch } from '../../utils/workspace';
import { AutoRefreshFeedbackBadge } from '../AutoRefreshFeedback';
import { OverlaySurface } from '../OverlaySurface';
import {
  CloseIcon,
  EyeIcon,
  ExitFullscreenIcon,
  FullscreenIcon,
  MaximizeIcon,
  RestoreIcon,
  ToolbarButton,
} from './controls';
import { resolveDocumentLanguage } from './language';
import { resolvePreviewRenderer } from './renderers';
import type { ViewerLayoutMode } from './types';
import { useDocumentContent } from './useDocumentContent';
import { resolveViewerSkin, toViewerCssVars } from './viewerSkin';

interface DocumentViewerDialogProps {
  open: boolean;
  onClose: () => void;
  filePath: string;
  initialMode?: PreviewMode;
}

export function DocumentViewerDialog({
  open,
  onClose,
  filePath,
  initialMode,
}: DocumentViewerDialogProps) {
  const themePreset = useAppStore((state) => state.config.theme.preset);
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId);
  const activeWorkspace = useAppStore(selectWorkspaceConfig(activeWorkspaceId));
  const [previewMode, setPreviewMode] = useState<PreviewMode>(() => normalizePreviewModeForFile(filePath, initialMode));
  const [maximized, setMaximized] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const fullscreenHostRef = useRef<HTMLDivElement | null>(null);

  const projectPath = activeWorkspace ? getWorkspaceMatch(activeWorkspace, filePath)?.root.path : undefined;
  const { result, loading, error, reload, version } = useDocumentContent(filePath, projectPath, open);
  const { feedback, clearFeedback, showRefreshing, showSuccess, showError } = useAutoRefreshFeedback();
  const fileName = useMemo(
    () => filePath.replace(/\\/g, '/').split('/').pop() ?? filePath,
    [filePath],
  );
  const language = useMemo(() => resolveDocumentLanguage(filePath), [filePath]);
  const skin = useMemo(() => resolveViewerSkin(language.family, themePreset), [language.family, themePreset]);
  const viewerStyle = useMemo(() => toViewerCssVars(skin), [skin]);
  const previewToggleEnabled = useMemo(() => supportsModeToggle(filePath), [filePath]);
  const previewKindLabel = useMemo(() => (
    isSvgPreviewFilePath(filePath) ? 'SVG' : isMermaidPreviewFilePath(filePath) ? 'Mermaid' : 'Markdown'
  ), [filePath]);
  const previewToggleInteractive = previewToggleEnabled && !error;
  const resolvedMode = normalizePreviewModeForFile(filePath, previewMode);
  const layoutMode: ViewerLayoutMode = isFullscreen ? 'fullscreen' : maximized ? 'maximized' : 'windowed';

  useWorkspaceAutoRefresh({
    active: open,
    projectPath,
    filePaths: [filePath],
    watchFs: true,
    onFsChange: async () => {
      showRefreshing('正在同步最新内容');
      const succeeded = await reload({ silent: true });
      if (succeeded) {
        showSuccess('已自动刷新');
      } else {
        showError('自动刷新失败');
      }
    },
  });

  useEffect(() => {
    setPreviewMode(normalizePreviewModeForFile(filePath, initialMode));
    setMaximized(false);
    clearFeedback();
  }, [clearFeedback, filePath, initialMode, open]);

  useEffect(() => {
    if (!open) return;

    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === fullscreenHostRef.current);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, [open]);

  useEffect(() => {
    return () => {
      if (document.fullscreenElement === fullscreenHostRef.current) {
        void document.exitFullscreen().catch(() => undefined);
      }
    };
  }, []);

  if (!open) return null;

  const handleTogglePreview = () => {
    if (!previewToggleInteractive) return;
    setPreviewMode((value) => (value === 'preview' ? 'source' : 'preview'));
  };

  const handleToggleMaximized = () => {
    setMaximized((value) => !value);
  };

  const handleToggleFullscreen = async () => {
    if (!fullscreenHostRef.current) return;

    if (document.fullscreenElement === fullscreenHostRef.current) {
      await document.exitFullscreen();
      return;
    }

    await fullscreenHostRef.current.requestFullscreen();
  };

  const dialogShellClass =
    layoutMode === 'fullscreen'
      ? 'h-screen w-screen rounded-none border-none'
      : layoutMode === 'maximized'
        ? 'h-[calc(100vh-24px)] w-[calc(100vw-24px)] rounded-none'
        : 'h-[82vh] w-[92vw] max-w-[1520px] rounded-none';

  const renderContent = () => {
    if (loading) {
      return (
        <div className="flex h-full items-center justify-center text-[var(--text-muted)]">
          Loading file...
        </div>
      );
    }

    if (error) {
      return (
        <div className="flex h-full items-center justify-center px-6 text-center text-[var(--color-error)]">
          {error}
        </div>
      );
    }

    if (!result) {
      return null;
    }

    const context = {
      filePath,
      projectPath,
      fileName,
      mode: resolvedMode,
      layoutMode,
      active: true,
      contentVersion: version,
      result,
      language,
      skin,
    };
    const renderer = resolvePreviewRenderer(context, resolvedMode);

    return renderer.render(context);
  };

  return (
    <OverlaySurface
      open={open}
      onClose={onClose}
      surfaceRef={fullscreenHostRef}
      rootClassName={layoutMode === 'fullscreen' ? 'p-0' : 'p-1'}
      panelProps={{
        role: 'dialog',
        'aria-modal': true,
        'aria-label': `File viewer: ${fileName}`,
        'data-layout-mode': layoutMode,
        'data-language-family': language.family,
        'data-language-id': language.languageId,
        'data-viewer-variant': language.viewerVariant,
      }}
      panelStyle={viewerStyle}
      panelClassName={`relative flex flex-col overflow-hidden border border-[var(--border-strong)] bg-[var(--bg-surface)] shadow-none animate-slide-in ${dialogShellClass}`}
      onEscapeKeyDown={(event) => {
        if (document.fullscreenElement === fullscreenHostRef.current) {
          event.preventDefault();
          void document.exitFullscreen();
        }
      }}
    >
      <div
        className="flex flex-shrink-0 items-center justify-between border-b px-1 py-[3px]"
        style={{
          borderColor: 'var(--viewer-border)',
          background: 'var(--viewer-header-bg)',
          backgroundColor: 'var(--viewer-header-bg)',
        }}
      >
        <div className="flex min-w-0 items-center gap-1">
          <div
            className="truncate text-[10px] font-semibold tracking-[0.01em]"
            style={{ color: 'var(--viewer-accent)' }}
            title={filePath}
          >
            {fileName}
          </div>
          <span
            className="border px-1 py-0 text-[7px] font-semibold tracking-[0.08em]"
            style={{
              color: 'var(--viewer-accent)',
              borderColor: 'var(--viewer-border)',
              backgroundColor: 'var(--viewer-accent-subtle)',
            }}
          >
            {resolvedMode === 'preview' && previewToggleEnabled ? 'PREVIEW' : language.badge}
          </span>
        </div>
        <div className="ml-1 flex items-center gap-px">
          <AutoRefreshFeedbackBadge feedback={feedback} testId="dialog-document-refresh-feedback" />
          {previewToggleEnabled && (
            <ToolbarButton
              active={resolvedMode === 'preview'}
              disabled={!previewToggleInteractive}
              compact
              label={resolvedMode === 'preview' ? `Close ${previewKindLabel} preview` : `Open ${previewKindLabel} preview`}
              onClick={handleTogglePreview}
              testId="file-viewer-preview-toggle"
            >
              <EyeIcon />
            </ToolbarButton>
          )}
          <ToolbarButton
            active={maximized && !isFullscreen}
            compact
            label={maximized ? 'Restore preview window size' : 'Maximize preview window'}
            onClick={handleToggleMaximized}
            testId="file-viewer-maximize-toggle"
          >
            {maximized && !isFullscreen ? <RestoreIcon /> : <MaximizeIcon />}
          </ToolbarButton>
          <ToolbarButton
            active={isFullscreen}
            compact
            label={isFullscreen ? 'Exit fullscreen preview' : 'Enter fullscreen preview'}
            onClick={() => {
              void handleToggleFullscreen();
            }}
            testId="file-viewer-fullscreen-toggle"
          >
            {isFullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
          </ToolbarButton>
          <ToolbarButton compact label="Close preview" onClick={onClose} testId="file-viewer-close">
            <CloseIcon />
          </ToolbarButton>
        </div>
      </div>

      <div className="flex-1 overflow-auto" style={{ backgroundColor: 'var(--viewer-panel)' }}>
        {renderContent()}
      </div>
    </OverlaySurface>
  );
}
