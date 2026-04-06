import { PreviewNotice } from './PreviewNotice';
import type { PreviewRenderContext } from './types';

export default function DocFallbackRenderer({ filePath, result }: PreviewRenderContext) {
  return (
    <PreviewNotice
      title="DOC Preview Not Available"
      message="Mini-Term does not provide in-app layout preview for legacy .doc files yet."
      filePath={filePath}
      warning={result.warning ?? 'Use your system default application for the full document view.'}
      testId="doc-preview-fallback"
    />
  );
}
