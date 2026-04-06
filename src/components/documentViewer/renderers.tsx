import { Suspense, lazy } from 'react';
import type { PreviewMode } from '../../types';
import { isMermaidPreviewFilePath } from '../../utils/documentPreview';
import { TextPreviewRenderer } from './TextPreviewRenderer';
import type { PreviewRenderContext, PreviewRenderer } from './types';

const LazyCodePreviewRenderer = lazy(() => import('./CodePreviewRenderer'));
const LazyMarkdownPreviewRenderer = lazy(() => import('./MarkdownPreviewRenderer'));
const LazyMermaidPreviewRenderer = lazy(() => import('./MermaidPreviewRenderer'));
const LazySvgPreviewRenderer = lazy(() => import('./SvgPreviewRenderer'));
const LazyImagePreviewRenderer = lazy(() => import('./ImagePreviewRenderer'));
const LazyPdfPreviewRenderer = lazy(() => import('./PdfPreviewRenderer'));
const LazyDocxPreviewRenderer = lazy(() => import('./DocxPreviewRenderer'));
const LazyDocFallbackRenderer = lazy(() => import('./DocFallbackRenderer'));
const LazyUnsupportedPreviewRenderer = lazy(() => import('./UnsupportedPreviewRenderer'));

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
  supports: (_filePath, result) => result.kind === 'markdown' && !result.tooLarge,
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

const mermaidRenderer: PreviewRenderer = {
  id: 'mermaid',
  supports: (filePath, result) => isMermaidPreviewFilePath(filePath) && result.kind === 'text' && !result.tooLarge,
  render: (context) => (
    <div className="h-full w-full">
      <Suspense
        fallback={
          <div className="flex h-full min-h-[240px] items-center justify-center text-[var(--text-muted)]">
            Loading Mermaid preview...
          </div>
        }
      >
        <LazyMermaidPreviewRenderer {...context} />
      </Suspense>
    </div>
  ),
};

const svgRenderer: PreviewRenderer = {
  id: 'svg',
  supports: (_filePath, result) => result.kind === 'svg',
  render: (context) => (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-[var(--text-muted)]">
          Loading SVG preview...
        </div>
      }
    >
      <LazySvgPreviewRenderer {...context} />
    </Suspense>
  ),
};

const imageRenderer: PreviewRenderer = {
  id: 'image',
  supports: (_filePath, result) => result.kind === 'image',
  render: (context) => (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-[var(--text-muted)]">
          Loading image preview...
        </div>
      }
    >
      <LazyImagePreviewRenderer {...context} />
    </Suspense>
  ),
};

const pdfRenderer: PreviewRenderer = {
  id: 'pdf',
  supports: (_filePath, result) => result.kind === 'pdf',
  render: (context) => (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-[var(--text-muted)]">
          Loading PDF preview...
        </div>
      }
    >
      <LazyPdfPreviewRenderer {...context} />
    </Suspense>
  ),
};

const docxRenderer: PreviewRenderer = {
  id: 'docx',
  supports: (_filePath, result) => result.kind === 'docx',
  render: (context) => (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-[var(--text-muted)]">
          Loading DOCX preview...
        </div>
      }
    >
      <LazyDocxPreviewRenderer {...context} />
    </Suspense>
  ),
};

const docRenderer: PreviewRenderer = {
  id: 'doc',
  supports: (_filePath, result) => result.kind === 'doc',
  render: (context) => (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-[var(--text-muted)]">
          Preparing document fallback...
        </div>
      }
    >
      <LazyDocFallbackRenderer {...context} />
    </Suspense>
  ),
};

const unsupportedRenderer: PreviewRenderer = {
  id: 'unsupported',
  supports: (_filePath, result) => result.kind === 'unsupported' || result.tooLarge,
  render: (context) => (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-[var(--text-muted)]">
          Loading preview status...
        </div>
      }
    >
      <LazyUnsupportedPreviewRenderer {...context} />
    </Suspense>
  ),
};

const orderedPreviewRenderers = [
  unsupportedRenderer,
  markdownRenderer,
  mermaidRenderer,
  svgRenderer,
  imageRenderer,
  pdfRenderer,
  docxRenderer,
  docRenderer,
  codeRenderer,
];

export function resolvePreviewRenderer(context: PreviewRenderContext, mode: PreviewMode) {
  if (mode === 'source') {
    if (context.result.kind === 'unsupported' || context.result.tooLarge) {
      return unsupportedRenderer;
    }
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
