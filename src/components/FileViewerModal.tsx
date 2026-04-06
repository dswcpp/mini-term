import { Suspense, lazy } from 'react';

const LazyDocumentViewerDialog = lazy(() => import('./documentViewer/DocumentViewerDialog').then((module) => ({
  default: module.DocumentViewerDialog,
})));

interface FileViewerModalProps {
  open: boolean;
  onClose: () => void;
  filePath: string;
  initialPreview?: boolean;
}

export function FileViewerModal({
  open,
  onClose,
  filePath,
  initialPreview = false,
}: FileViewerModalProps) {
  return (
    <Suspense fallback={open ? (
      <div className="flex h-full min-h-[240px] items-center justify-center text-[var(--text-muted)]">
        Loading file viewer...
      </div>
    ) : null}
    >
      <LazyDocumentViewerDialog
        open={open}
        onClose={onClose}
        filePath={filePath}
        initialMode={initialPreview ? 'preview' : undefined}
      />
    </Suspense>
  );
}
