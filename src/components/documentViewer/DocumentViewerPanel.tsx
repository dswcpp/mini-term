import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../store';
import type { PreviewMode } from '../../types';
import { isMarkdownFilePath } from '../../utils/markdownPreview';
import { resolveDocumentLanguage } from './language';
import {
  CloseIcon,
  EyeIcon,
  ExitFullscreenIcon,
  FullscreenIcon,
  ToolbarButton,
} from './controls';
import { resolvePreviewRenderer } from './renderers';
import type { PreviewRenderContext, ViewerLayoutMode } from './types';
import { useDocumentContent } from './useDocumentContent';
import { resolveViewerSkin, toViewerCssVars } from './viewerSkin';

interface DocumentViewerPanelProps {
  filePath: string;
  mode?: PreviewMode;
  active?: boolean;
  onModeChange?: (mode: PreviewMode) => void;
  onClose: () => void;
  variant?: 'panel' | 'tab';
}

export function DocumentViewerPanel({
  filePath,
  mode,
  active = true,
  onModeChange,
  onClose,
  variant = 'panel',
}: DocumentViewerPanelProps) {
  const themePreset = useAppStore((state) => state.config.theme.preset);
  const [internalMode, setInternalMode] = useState<PreviewMode>(mode === 'preview' ? 'preview' : 'source');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const fullscreenHostRef = useRef<HTMLDivElement | null>(null);

  const { result, loading, error } = useDocumentContent(filePath, active);
  const fileName = useMemo(
    () => filePath.replace(/\\/g, '/').split('/').pop() ?? filePath,
    [filePath],
  );
  const language = useMemo(() => resolveDocumentLanguage(filePath), [filePath]);
  const skin = useMemo(() => resolveViewerSkin(language.family, themePreset), [language.family, themePreset]);
  const viewerStyle = useMemo(() => toViewerCssVars(skin), [skin]);
  const markdownFile = useMemo(() => isMarkdownFilePath(filePath), [filePath]);
  const previewMode = markdownFile && (mode ?? internalMode) === 'preview' ? 'preview' : 'source';
  const previewReady = markdownFile && !!result && !result.isBinary && !result.tooLarge && !error;
  const layoutMode: ViewerLayoutMode = isFullscreen ? 'fullscreen' : 'windowed';

  useEffect(() => {
    setInternalMode(mode === 'preview' && markdownFile ? 'preview' : 'source');
  }, [filePath, mode, markdownFile]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === fullscreenHostRef.current);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (document.fullscreenElement === fullscreenHostRef.current) {
        void document.exitFullscreen().catch(() => undefined);
      }
    };
  }, []);

  const handleTogglePreview = () => {
    if (!previewReady) return;
    const nextMode = previewMode === 'preview' ? 'source' : 'preview';
    setInternalMode(nextMode);
    onModeChange?.(nextMode);
  };

  const handleToggleFullscreen = async () => {
    if (!fullscreenHostRef.current) return;

    if (document.fullscreenElement === fullscreenHostRef.current) {
      await document.exitFullscreen();
      return;
    }

    await fullscreenHostRef.current.requestFullscreen();
  };

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

    if (result.isBinary) {
      return (
        <div className="flex h-full items-center justify-center text-[var(--text-muted)]">
          Binary file, preview is not available.
        </div>
      );
    }

    if (result.tooLarge) {
      return (
        <div className="flex h-full items-center justify-center text-[var(--text-muted)]">
          File is too large to preview.
        </div>
      );
    }

    const context: PreviewRenderContext = {
      filePath,
      fileName,
      mode: previewMode,
      layoutMode,
      active,
      result,
      language,
      skin,
    };
    const renderer = resolvePreviewRenderer(context, previewMode);
    return renderer.render(context);
  };

  return (
    <div
      ref={fullscreenHostRef}
      role="region"
      aria-label={`File viewer: ${fileName}`}
      data-layout-mode={layoutMode}
      data-language-family={language.family}
      data-language-id={language.languageId}
      data-viewer-variant={language.viewerVariant}
      style={viewerStyle}
      className={`flex min-w-0 flex-col overflow-hidden ${
        isFullscreen
          ? 'h-screen w-screen rounded-none border-none'
          : variant === 'panel'
            ? 'h-full border-l bg-[var(--viewer-shell-bg)]'
            : 'h-full bg-[var(--viewer-shell-bg)]'
      }`}
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
            {previewMode === 'preview' ? 'PREVIEW' : language.badge}
          </span>
        </div>
        <div className="ml-1 flex items-center gap-px">
          {markdownFile && (
            <ToolbarButton
              active={previewMode === 'preview'}
              disabled={!previewReady}
              compact
              label={previewMode === 'preview' ? 'Close Markdown preview' : 'Open Markdown preview'}
              onClick={handleTogglePreview}
              testId="embedded-file-viewer-preview-toggle"
            >
              <EyeIcon />
            </ToolbarButton>
          )}
          <ToolbarButton
            active={isFullscreen}
            compact
            label={isFullscreen ? 'Exit fullscreen preview' : 'Enter fullscreen preview'}
            onClick={() => {
              void handleToggleFullscreen();
            }}
            testId="embedded-file-viewer-fullscreen-toggle"
          >
            {isFullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
          </ToolbarButton>
          <ToolbarButton compact label="Close preview" onClick={onClose} testId="embedded-file-viewer-close">
            <CloseIcon />
          </ToolbarButton>
        </div>
      </div>

      <div className="flex-1 overflow-auto" style={{ backgroundColor: 'var(--viewer-panel)' }}>
        {renderContent()}
      </div>
    </div>
  );
}
