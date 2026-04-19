import { useEffect, useMemo, useRef, useState, type WheelEvent } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { renderAsync } from 'docx-preview';
import { PreviewNotice } from './PreviewNotice';
import { ToolbarTextButton } from './controls';
import { normalizePathSeparators } from './path';
import type { PreviewRenderContext } from './types';
import { decodeBase64ToUint8Array } from '../../utils/binaryPreview';
import { useSecondaryButtonPan } from './useSecondaryButtonPan';

const MIN_SCALE = 0.6;
const MAX_SCALE = 2.5;
const SCALE_STEP = 0.1;

function clampScale(value: number) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(value.toFixed(2))));
}

const DOCX_CSS = `
.mini-term-docx {
  color: var(--text-primary);
}

.mini-term-docx .docx-wrapper {
  background: transparent !important;
  padding: 0 !important;
}

.mini-term-docx .docx {
  margin: 0 auto !important;
  box-shadow: none !important;
}
`;

export default function DocxPreviewRenderer({ active, contentVersion, filePath, projectPath, result }: PreviewRenderContext) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const styleRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [scale, setScale] = useState(1);
  const { dragging, onMouseDown, onContextMenu } = useSecondaryButtonPan();
  const source = useMemo(() => convertFileSrc(normalizePathSeparators(filePath)), [filePath]);
  const zoomOut = () => setScale((value) => clampScale(value - SCALE_STEP));
  const zoomIn = () => setScale((value) => clampScale(value + SCALE_STEP));
  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey) {
      return;
    }
    event.preventDefault();
    setScale((value) => clampScale(value + (event.deltaY < 0 ? SCALE_STEP : -SCALE_STEP)));
  };

  useEffect(() => {
    if (!active || !bodyRef.current || !styleRef.current || result.tooLarge) {
      return;
    }

    let cancelled = false;
    const bodyHost = bodyRef.current;
    const styleHost = styleRef.current;
    bodyHost.innerHTML = '';
    styleHost.innerHTML = '';
    setLoading(true);
    setError('');
    setScale(1);

    const loadBuffer = async () => {
      try {
        const response = await fetch(source);
        if (!response.ok) {
          throw new Error(`Failed to load DOCX asset (${response.status})`);
        }
        return await response.arrayBuffer();
      } catch (_reason) {
        const payload = await invoke<string>('read_binary_preview_base64', {
          projectRoot: projectPath ?? filePath,
          path: filePath,
        });
        return decodeBase64ToUint8Array(payload);
      }
    };

    void loadBuffer()
      .then((buffer) =>
        renderAsync(buffer, bodyHost, styleHost, {
          className: 'mini-term-docx',
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          breakPages: true,
        }))
      .then(() => {
        if (!cancelled) {
          setLoading(false);
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setLoading(false);
          setError(String(reason));
        }
      });

    return () => {
      cancelled = true;
      bodyHost.innerHTML = '';
      styleHost.innerHTML = '';
    };
  }, [active, contentVersion, filePath, projectPath, result.tooLarge, source]);

  if (result.tooLarge) {
    return (
      <PreviewNotice
        title="DOCX Preview Unavailable"
        message="This DOCX file is too large for Mini-Term's in-app preview."
        filePath={filePath}
        warning={result.warning}
        testId="docx-preview-too-large"
      />
    );
  }

  if (error) {
    return (
      <PreviewNotice
        title="DOCX Preview Failed"
        message="Mini-Term could not render this DOCX file in-app."
        filePath={filePath}
        warning={error}
        testId="docx-preview-error"
      />
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      <style>{DOCX_CSS}</style>
      <div ref={styleRef} className="hidden" />
      <div
        className="flex items-center justify-end gap-2 border-b px-3 py-2"
        style={{ borderColor: 'var(--viewer-border)', backgroundColor: 'var(--viewer-panel-elevated)' }}
      >
        <div className="mr-auto text-[10px] font-semibold tracking-[0.08em]" style={{ color: 'var(--text-secondary)' }}>
          CTRL+WHEEL ZOOM | RIGHT-DRAG PAN
        </div>
        <ToolbarTextButton
          label="Zoom out DOCX"
          onClick={zoomOut}
          testId="docx-preview-zoom-out"
        >
          -
        </ToolbarTextButton>
        <div
          className="min-w-[48px] text-center text-[10px] font-semibold tracking-[0.08em]"
          style={{ color: 'var(--text-secondary)' }}
          data-testid="docx-preview-scale"
        >
          {Math.round(scale * 100)}%
        </div>
        <ToolbarTextButton
          label="Zoom in DOCX"
          onClick={zoomIn}
          testId="docx-preview-zoom-in"
        >
          +
        </ToolbarTextButton>
      </div>
      <div
        data-testid="docx-preview-viewport"
        className="flex-1 overflow-auto px-4 py-5"
        style={{
          backgroundColor: 'var(--viewer-panel)',
          cursor: dragging ? 'grabbing' : 'grab',
          userSelect: 'none',
        }}
        onWheel={handleWheel}
        onMouseDown={onMouseDown}
        onContextMenu={onContextMenu}
      >
        {loading ? (
          <div className="flex min-h-[240px] items-center justify-center text-[var(--text-muted)]">
            Loading DOCX preview...
          </div>
        ) : null}
        <div
          className={`flex justify-center ${loading ? 'hidden' : ''}`}
          style={{ transform: `scale(${scale})`, transformOrigin: 'top center' }}
          data-testid="docx-preview-scale-frame"
        >
          <div ref={bodyRef} data-testid="docx-preview-renderer" />
        </div>
      </div>
    </div>
  );
}
