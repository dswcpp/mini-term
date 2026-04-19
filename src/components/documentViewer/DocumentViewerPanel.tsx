import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../store';
import { useAutoRefreshFeedback } from '../../hooks/useAutoRefreshFeedback';
import { useWorkspaceAutoRefresh } from '../../hooks/useWorkspaceAutoRefresh';
import type { FileNavigationTarget, PreviewMode } from '../../types';
import {
  isMermaidPreviewFilePath,
  isSvgPreviewFilePath,
  normalizePreviewModeForFile,
  supportsModeToggle,
} from '../../utils/documentPreview';
import { AutoRefreshFeedbackBadge } from '../AutoRefreshFeedback';
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

const SOURCE_ACTIVE_LINE_SELECTOR = '[data-source-active-line="true"]';
const SOURCE_NAVIGATION_CSS = `
[data-source-navigation-host] [data-source-line] {
  scroll-margin-block: 96px;
}

[data-source-navigation-host] [data-source-active-line="true"] {
  background: var(--viewer-accent-subtle) !important;
  box-shadow: inset 2px 0 0 var(--viewer-accent);
}

[data-source-navigation-host] [data-source-active-line="true"] [data-source-gutter="true"],
[data-source-navigation-host] [data-source-active-line="true"]::before {
  background: var(--viewer-accent-subtle) !important;
  color: var(--viewer-accent) !important;
}
`;

function clearActiveSourceLine(host: ParentNode | null) {
  host?.querySelectorAll<HTMLElement>(SOURCE_ACTIVE_LINE_SELECTOR).forEach((element) => {
    element.removeAttribute('data-source-active-line');
  });
}

function applySourceNavigation(host: HTMLElement, navigationTarget: FileNavigationTarget) {
  clearActiveSourceLine(host);
  const lineElement = host.querySelector<HTMLElement>(`[data-source-line="${navigationTarget.line}"]`);
  if (!lineElement) {
    return false;
  }

  lineElement.setAttribute('data-source-active-line', 'true');
  lineElement.scrollIntoView({
    block: 'center',
    inline: 'nearest',
  });
  return true;
}

interface DocumentViewerPanelProps {
  filePath: string;
  projectPath?: string;
  mode?: PreviewMode;
  navigationTarget?: FileNavigationTarget;
  active?: boolean;
  onModeChange?: (mode: PreviewMode) => void;
  onClose: () => void;
  variant?: 'panel' | 'tab';
}

export function DocumentViewerPanel({
  filePath,
  projectPath,
  mode,
  navigationTarget,
  active = true,
  onModeChange,
  onClose,
  variant = 'panel',
}: DocumentViewerPanelProps) {
  const themePreset = useAppStore((state) => state.config.theme.preset);
  const [internalMode, setInternalMode] = useState<PreviewMode>(() => normalizePreviewModeForFile(filePath, mode));
  const [isFullscreen, setIsFullscreen] = useState(false);
  const fullscreenHostRef = useRef<HTMLDivElement | null>(null);
  const navigationHostRef = useRef<HTMLDivElement | null>(null);

  const { result, loading, refreshing, error, reload, version } = useDocumentContent(filePath, projectPath, active);
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
  const previewMode = normalizePreviewModeForFile(filePath, mode ?? internalMode);
  const previewToggleInteractive = previewToggleEnabled && !error;
  const layoutMode: ViewerLayoutMode = isFullscreen ? 'fullscreen' : 'windowed';

  useWorkspaceAutoRefresh({
    active,
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
    setInternalMode(normalizePreviewModeForFile(filePath, mode));
  }, [filePath, mode]);

  useEffect(() => {
    clearFeedback();
  }, [clearFeedback, filePath]);

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

  useEffect(() => {
    const host = navigationHostRef.current;
    if (!host) {
      return;
    }

    clearActiveSourceLine(host);

    if (!active || previewMode !== 'source' || !navigationTarget || !result?.textContent) {
      return;
    }

    applySourceNavigation(host, navigationTarget);

    const observer = new MutationObserver(() => {
      applySourceNavigation(host, navigationTarget);
    });
    observer.observe(host, {
      childList: true,
      subtree: true,
    });

    return () => {
      observer.disconnect();
      clearActiveSourceLine(host);
    };
  }, [
    active,
    filePath,
    navigationTarget?.column,
    navigationTarget?.line,
    navigationTarget?.requestId,
    previewMode,
    result?.textContent,
  ]);

  const handleTogglePreview = () => {
    if (!previewToggleInteractive) return;
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

    if (!result) return null;

    const context: PreviewRenderContext = {
      filePath,
      projectPath,
      fileName,
      mode: previewMode,
      layoutMode,
      active,
      contentVersion: version,
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
      <style>{SOURCE_NAVIGATION_CSS}</style>
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
            {previewMode === 'preview' && previewToggleEnabled ? 'PREVIEW' : language.badge}
          </span>
        </div>
        <div className="ml-1 flex items-center gap-px">
          <AutoRefreshFeedbackBadge feedback={feedback} testId="document-refresh-feedback" />
          {previewToggleEnabled && (
            <ToolbarButton
              active={previewMode === 'preview'}
              disabled={!previewToggleInteractive}
              compact
              label={previewMode === 'preview' ? `Close ${previewKindLabel} preview` : `Open ${previewKindLabel} preview`}
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

      <div
        ref={navigationHostRef}
        data-source-navigation-host="true"
        className="flex-1 overflow-auto"
        style={{ backgroundColor: 'var(--viewer-panel)' }}
        data-refreshing={refreshing ? 'true' : 'false'}
      >
        {renderContent()}
      </div>
    </div>
  );
}
