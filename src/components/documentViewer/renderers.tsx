import { Suspense, lazy } from 'react';
import type { PreviewMode } from '../../types';
import { isMarkdownFilePath } from '../../utils/markdownPreview';
import { TextPreviewRenderer } from './TextPreviewRenderer';
import type { PreviewRenderContext, PreviewRenderer } from './types';

const LazyCodePreviewRenderer = lazy(() => import('./CodePreviewRenderer'));
const LazyMarkdownPreviewRenderer = lazy(() => import('./MarkdownPreviewRenderer'));

const codeRenderer: PreviewRenderer = {
  id: 'code',
  supports: () => true,
  render: (context) => (
    <Suspense
      fallback={
        <div className={getPreviewBodyClass(context.layoutMode)}>
          <TextPreviewRenderer {...context} />
        </div>
      }
    >
      <LazyCodePreviewRenderer {...context} />
    </Suspense>
  ),
};

const markdownRenderer: PreviewRenderer = {
  id: 'markdown',
  supports: (filePath, result) => isMarkdownFilePath(filePath) && !result.isBinary && !result.tooLarge,
  render: (context) => (
    <div className={getPreviewBodyClass(context.layoutMode)}>
      <Suspense
        fallback={
          <div className="flex min-h-[240px] items-center justify-center text-[var(--text-muted)]">
            Loading Markdown preview...
          </div>
        }
      >
        <LazyMarkdownPreviewRenderer {...context} />
      </Suspense>
    </div>
  ),
};

const orderedPreviewRenderers = [markdownRenderer, codeRenderer];

export function resolvePreviewRenderer(context: PreviewRenderContext, mode: PreviewMode) {
  if (mode === 'source') {
    return codeRenderer;
  }

  return orderedPreviewRenderers.find((renderer) => renderer.supports(context.filePath, context.result)) ?? codeRenderer;
}

export function getPreviewBodyClass(layoutMode: PreviewRenderContext['layoutMode']) {
  return layoutMode === 'fullscreen'
    ? 'mx-auto w-full max-w-none px-8 py-7'
    : layoutMode === 'maximized'
      ? 'mx-auto w-full max-w-[1440px] px-8 py-7'
      : 'mx-auto w-full max-w-[1200px] px-8 py-7';
}
