import { DocumentViewerPanel } from './documentViewer/DocumentViewerPanel';
import { useAppStore, selectWorkspaceConfig } from '../store';
import type { FileViewerTab, PreviewMode } from '../types';
import { getWorkspaceMatch } from '../utils/workspace';

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
  const workspace = useAppStore(selectWorkspaceConfig(workspaceId));
  const projectPath = workspace ? getWorkspaceMatch(workspace, tab.filePath)?.root.path : undefined;

  return (
    <DocumentViewerPanel
      filePath={tab.filePath}
      projectPath={projectPath}
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
