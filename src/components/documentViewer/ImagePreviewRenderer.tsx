import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { useEffect, useMemo, useState } from 'react';
import { openPath } from '@tauri-apps/plugin-opener';
import { ToolbarTextButton } from './controls';
import { PreviewNotice } from './PreviewNotice';
import { normalizePathSeparators } from './path';
import type { PreviewRenderContext } from './types';

function withContentVersion(source: string, version: number) {
  return `${source}${source.includes('?') ? '&' : '?'}v=${version}`;
}

export default function ImagePreviewRenderer({ filePath, fileName, contentVersion, result }: PreviewRenderContext) {
  const [fallbackSource, setFallbackSource] = useState<string | null>(null);
  const [loadError, setLoadError] = useState('');
  const [recovering, setRecovering] = useState(false);

  useEffect(() => {
    setFallbackSource(null);
    setLoadError('');
    setRecovering(false);
  }, [filePath]);

  if (result.tooLarge) {
    return (
      <PreviewNotice
        title="Image Preview Unavailable"
        message="This image is too large for Mini-Term's in-app preview."
        filePath={filePath}
        warning={result.warning}
        testId="image-preview-too-large"
      />
    );
  }

  const source = useMemo(
    () => fallbackSource ?? withContentVersion(convertFileSrc(normalizePathSeparators(filePath)), contentVersion),
    [contentVersion, fallbackSource, filePath],
  );

  if (loadError) {
    return (
      <PreviewNotice
        title="Image Preview Failed"
        message="Mini-Term could not render this image in-app."
        filePath={filePath}
        warning={loadError}
        testId="image-preview-error"
      />
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div
        className="flex flex-1 items-center justify-center overflow-auto p-6"
        style={{ backgroundColor: 'var(--viewer-panel)' }}
      >
        <img
          data-testid="image-preview-renderer"
          src={source}
          alt={fileName}
          className="max-h-full max-w-full object-contain"
          onError={() => {
            if (fallbackSource || recovering) {
              if (!fallbackSource) {
                setLoadError('Mini-Term could not load this image through the desktop asset bridge.');
              }
              return;
            }

            setRecovering(true);
            void invoke<string>('read_image_data_url', { path: filePath })
              .then((dataUrl) => {
                setFallbackSource(dataUrl);
                setLoadError('');
              })
              .catch((reason) => {
                setLoadError(String(reason));
              })
              .finally(() => {
                setRecovering(false);
              });
          }}
        />
      </div>
      <div className="border-t px-3 py-2" style={{ borderColor: 'var(--viewer-border)' }}>
        <ToolbarTextButton
          label="Open image externally"
          onClick={() => {
            void openPath(filePath);
          }}
          testId="image-preview-open-external"
        >
          OPEN EXTERNALLY
        </ToolbarTextButton>
      </div>
    </div>
  );
}
