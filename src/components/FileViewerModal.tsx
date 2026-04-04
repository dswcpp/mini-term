import { DocumentViewerDialog } from './documentViewer/DocumentViewerDialog';

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
    <DocumentViewerDialog
      open={open}
      onClose={onClose}
      filePath={filePath}
      initialMode={initialPreview ? 'preview' : 'source'}
    />
  );
}
