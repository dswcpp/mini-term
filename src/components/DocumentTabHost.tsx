import { DocumentViewerPanel } from './documentViewer/DocumentViewerPanel';
import type { FileViewerTab, PreviewMode } from '../types';

interface DocumentTabHostProps {
  tab: FileViewerTab;
  workspaceId: string;
  isActive: boolean;
  onClose: () => void;
  onModeChange: (mode: PreviewMode) => void;
}

export function DocumentTabHost({
  tab,
  workspaceId,
  isActive,
  onClose,
  onModeChange,
}: DocumentTabHostProps) {
  return (
    <DocumentViewerPanel
      filePath={tab.filePath}
      mode={tab.mode}
      navigationTarget={tab.navigationTarget}
      active={isActive}
      onModeChange={onModeChange}
      onClose={onClose}
      variant="tab"
      key={`${workspaceId}:${tab.id}`}
    />
  );
}
