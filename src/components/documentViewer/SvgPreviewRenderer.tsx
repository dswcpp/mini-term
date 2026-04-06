import { convertFileSrc } from '@tauri-apps/api/core';
import { PreviewNotice } from './PreviewNotice';
import { normalizePathSeparators } from './path';
import type { PreviewRenderContext } from './types';

function withContentVersion(source: string, version: number) {
  return `${source}${source.includes('?') ? '&' : '?'}v=${version}`;
}

export default function SvgPreviewRenderer({ filePath, fileName, contentVersion, result }: PreviewRenderContext) {
  if (result.tooLarge) {
    return (
      <PreviewNotice
        title="SVG Preview Unavailable"
        message="This SVG file is too large for Mini-Term's in-app preview."
        filePath={filePath}
        warning={result.warning}
        testId="svg-preview-too-large"
      />
    );
  }

  return (
    <div
      className="flex h-full items-center justify-center overflow-auto p-6"
      style={{ backgroundColor: 'var(--viewer-panel)' }}
    >
      <img
        data-testid="svg-preview-renderer"
        src={withContentVersion(convertFileSrc(normalizePathSeparators(filePath)), contentVersion)}
        alt={fileName}
        className="max-h-full max-w-full object-contain"
      />
    </div>
  );
}
