import { useEffect, useMemo, useState, type WheelEvent } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { invoke } from '@tauri-apps/api/core';
import { PreviewNotice } from './PreviewNotice';
import { ToolbarTextButton } from './controls';
import type { PreviewRenderContext } from './types';
import { decodeBase64ToUint8Array } from '../../utils/binaryPreview';
import { useSecondaryButtonPan } from './useSecondaryButtonPan';

const MIN_SCALE = 0.6;
const MAX_SCALE = 2.5;
const SCALE_STEP = 0.1;

function clampScale(value: number) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(value.toFixed(2))));
}

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

export default function PdfPreviewRenderer({ contentVersion, filePath, projectPath, result }: PreviewRenderContext) {
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale] = useState(1);
  const [loadError, setLoadError] = useState('');
  const [documentBytes, setDocumentBytes] = useState<Uint8Array | null>(null);
  const [loadingDocument, setLoadingDocument] = useState(true);
  const { dragging, onMouseDown, onContextMenu } = useSecondaryButtonPan();
  const documentFile = useMemo(
    () => (documentBytes ? { data: documentBytes.slice() } : null),
    [documentBytes],
  );
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
    let cancelled = false;

    setPageCount(null);
    setPageNumber(1);
    setScale(1);
    setLoadError('');
    setDocumentBytes(null);
    setLoadingDocument(true);

    void invoke<string>('read_binary_preview_base64', {
      projectRoot: projectPath ?? filePath,
      path: filePath,
    })
      .then((payload) => {
        if (cancelled) {
          return;
        }
        setDocumentBytes(decodeBase64ToUint8Array(payload));
        setLoadingDocument(false);
      })
      .catch((reason) => {
        if (cancelled) {
          return;
        }
        setLoadError(String(reason));
        setLoadingDocument(false);
      });

    return () => {
      cancelled = true;
    };
  }, [contentVersion, filePath, projectPath]);

  if (result.tooLarge) {
    return (
      <PreviewNotice
        title="PDF Preview Unavailable"
        message="This PDF file is too large for Mini-Term's in-app preview."
        filePath={filePath}
        warning={result.warning}
        testId="pdf-preview-too-large"
      />
    );
  }

  if (loadError) {
    return (
      <PreviewNotice
        title="PDF Preview Failed"
        message="Mini-Term could not render this PDF in-app."
        filePath={filePath}
        warning={loadError}
        testId="pdf-preview-error"
      />
    );
  }

  if (loadingDocument || !documentFile) {
    return (
      <div className="flex h-full items-center justify-center text-[var(--text-muted)]">
        Loading PDF preview...
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div
        className="flex items-center justify-between gap-2 border-b px-3 py-2"
        style={{ borderColor: 'var(--viewer-border)', backgroundColor: 'var(--viewer-panel-elevated)' }}
      >
        <div className="text-[10px] font-semibold tracking-[0.08em]" style={{ color: 'var(--text-secondary)' }}>
          PAGE {pageCount ? `${pageNumber} / ${pageCount}` : pageNumber}
        </div>
        <div className="text-[10px] font-semibold tracking-[0.08em]" style={{ color: 'var(--text-secondary)' }}>
          CTRL+WHEEL ZOOM | RIGHT-DRAG PAN
        </div>
        <div className="flex items-center gap-2">
          <ToolbarTextButton
            label="Previous PDF page"
            disabled={pageNumber <= 1}
            onClick={() => setPageNumber((value) => Math.max(1, value - 1))}
            testId="pdf-preview-prev-page"
          >
            PREV
          </ToolbarTextButton>
          <ToolbarTextButton
            label="Next PDF page"
            disabled={pageCount == null || pageNumber >= pageCount}
            onClick={() => setPageNumber((value) => (pageCount == null ? value : Math.min(pageCount, value + 1)))}
            testId="pdf-preview-next-page"
          >
            NEXT
          </ToolbarTextButton>
          <ToolbarTextButton
            label="Zoom out PDF"
            onClick={zoomOut}
            testId="pdf-preview-zoom-out"
          >
            -
          </ToolbarTextButton>
          <div className="min-w-[48px] text-center text-[10px] font-semibold tracking-[0.08em]" style={{ color: 'var(--text-secondary)' }}>
            {Math.round(scale * 100)}%
          </div>
          <ToolbarTextButton
            label="Zoom in PDF"
            onClick={zoomIn}
            testId="pdf-preview-zoom-in"
          >
            +
          </ToolbarTextButton>
        </div>
      </div>
      <div
        data-testid="pdf-preview-viewport"
        className="flex flex-1 justify-center overflow-auto p-5"
        style={{
          backgroundColor: 'var(--viewer-panel)',
          cursor: dragging ? 'grabbing' : 'grab',
          userSelect: 'none',
        }}
        onWheel={handleWheel}
        onMouseDown={onMouseDown}
        onContextMenu={onContextMenu}
      >
        <Document
          file={documentFile}
          loading={<div className="text-[var(--text-muted)]">Loading PDF preview...</div>}
          onLoadSuccess={({ numPages }) => {
            setPageCount(numPages);
            setPageNumber((value) => Math.min(value, numPages));
            setLoadError('');
          }}
          onLoadError={(error) => {
            setLoadError(String(error));
          }}
        >
          <Page pageNumber={pageNumber} scale={scale} renderAnnotationLayer={false} renderTextLayer={false} />
        </Document>
      </div>
    </div>
  );
}
