import { PreviewNotice } from './PreviewNotice';
import type { PreviewRenderContext } from './types';

export default function UnsupportedPreviewRenderer({ filePath, result }: PreviewRenderContext) {
  if (result.tooLarge) {
    return (
      <PreviewNotice
        title="Preview Unavailable"
        message="This file is too large for Mini-Term's in-app preview."
        filePath={filePath}
        warning={result.warning}
        testId="unsupported-preview-too-large"
      />
    );
  }

  return (
    <PreviewNotice
      title="Preview Unsupported"
      message="Mini-Term does not support previewing this file type yet."
      filePath={result.openExternallyRecommended ? filePath : undefined}
      warning={result.warning}
      testId="unsupported-preview-renderer"
    />
  );
}
