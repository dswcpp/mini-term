import { Suspense, lazy } from 'react';
import { useAppStore, selectWorkspaceConfig } from '../store';
import type { FileViewerTab, PreviewMode } from '../types';
import { getWorkspaceMatch } from '../utils/workspace';

const LazyDocumentViewerPanel = lazy(() => import('./documentViewer/DocumentViewerPanel').then((module) => ({
  default: module.DocumentViewerPanel,
})));

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
    <Suspense
      fallback={(
        <div className="flex h-full min-h-0 items-center justify-center bg-[var(--viewer-shell-bg,var(--bg-surface))] text-[var(--text-muted)]">
          Loading document viewer...
        </div>
      )}
    >
      <LazyDocumentViewerPanel
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
    </Suspense>
  );
}
