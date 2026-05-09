import { useEffect, useMemo, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { useAppStore, selectWorkspaceConfig } from '../store';
import type {
  AgentTaskPanelPaneState,
  CommitDiffPaneState,
  FileHistoryPaneState,
  FileViewerPaneState,
  LayoutDragPayload,
  LayoutDropZone,
  PaneStatus,
  WorktreeDiffPaneState,
  WorkspacePane,
} from '../types';
import {
  beginLayoutDrag,
  getLayoutDragPayload,
  getLayoutDropTarget,
  isLayoutDragging,
  onLayoutDragEnd,
  setLayoutDropTarget,
} from '../utils/dragState';
import { getWorkspaceMatch } from '../utils/workspace';
import { DocumentViewerPanel } from './documentViewer/DocumentViewerPanel';
import { DiffModal } from './DiffModal';
import { CommitDiffModal } from './CommitDiffModal';
import { FileHistoryTabHost } from './FileHistoryTabHost';
import { AgentTaskPanelTabHost } from './AgentTaskPanelTabHost';
import { StatusDot } from './StatusDot';

function normalizePath(path: string) {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
}

function getFileName(path: string) {
  const normalized = normalizePath(path);
  const segments = normalized.split('/');
  return segments[segments.length - 1] ?? path;
}

function getDropZone(rect: DOMRect, clientX: number, clientY: number): LayoutDropZone {
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  const aboveMain = y < x;
  const aboveAnti = y < 1 - x;
  if (aboveMain && aboveAnti) return 'top';
  if (!aboveMain && !aboveAnti) return 'bottom';
  if (!aboveMain && aboveAnti) return 'left';
  return 'right';
}

const dropZoneOverlay: Record<LayoutDropZone, CSSProperties> = {
  top: { top: 0, left: 0, right: 0, height: '50%' },
  bottom: { bottom: 0, left: 0, right: 0, height: '50%' },
  left: { top: 0, left: 0, bottom: 0, width: '50%' },
  right: { top: 0, right: 0, bottom: 0, width: '50%' },
};

function getPaneTitle(pane: WorkspacePane) {
  switch (pane.kind) {
    case 'terminal':
      return pane.shellName;
    case 'file-viewer':
      return getFileName(pane.filePath);
    case 'worktree-diff':
      return getFileName(pane.gitStatus.path);
    case 'commit-diff':
      return pane.commitMessage || pane.commitHash.slice(0, 7);
    case 'file-history':
      return getFileName(pane.filePath);
    case 'agent-tasks':
      return 'Tasks';
  }
}

interface WorkspacePaneHostProps {
  workspaceId: string;
  tabId: string;
  pane: Exclude<WorkspacePane, { kind: 'terminal' }>;
  isActive: boolean;
  onActivatePane?: (paneId: string) => void;
  onSplit?: (paneId: string, direction: 'horizontal' | 'vertical') => void;
  onClose?: (paneId: string) => void;
  onLayoutDrop?: (
    payload: LayoutDragPayload,
    targetPaneId: string,
    direction: 'horizontal' | 'vertical',
    position: 'before' | 'after',
  ) => void;
}

function PaneChromeButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      className="inline-flex h-[18px] w-[18px] items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-muted)] transition-[background-color,color] hover:bg-[color-mix(in_srgb,var(--bg-overlay)_72%,transparent)] hover:text-[var(--text-primary)]"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function FileViewerPaneBody({
  workspaceId,
  pane,
  isActive,
  onClose,
}: {
  workspaceId: string;
  pane: FileViewerPaneState;
  isActive: boolean;
  onClose: () => void;
}) {
  const workspace = useAppStore(selectWorkspaceConfig(workspaceId));
  const projectPath = workspace ? getWorkspaceMatch(workspace, pane.filePath)?.root.path : undefined;
  const setFileViewerTabMode = useAppStore((state) => state.setFileViewerTabMode);

  return (
    <DocumentViewerPanel
      filePath={pane.filePath}
      projectPath={projectPath}
      mode={pane.mode}
      navigationTarget={pane.navigationTarget}
      active={isActive}
      onModeChange={(mode) => setFileViewerTabMode(workspaceId, pane.id, mode)}
      onClose={onClose}
      variant="panel"
    />
  );
}

function WorktreeDiffPaneBody({
  pane,
  isActive,
  onClose,
}: {
  pane: WorktreeDiffPaneState;
  isActive: boolean;
  onClose: () => void;
}) {
  return (
    <DiffModal
      variant="tab"
      active={isActive}
      onClose={onClose}
      projectPath={pane.projectPath}
      status={pane.gitStatus}
    />
  );
}

function CommitDiffPaneBody({
  pane,
  isActive,
  onClose,
}: {
  pane: CommitDiffPaneState;
  isActive: boolean;
  onClose: () => void;
}) {
  return (
    <CommitDiffModal
      variant="tab"
      active={isActive}
      onClose={onClose}
      repoPath={pane.repoPath}
      commitHash={pane.commitHash}
      commitMessage={pane.commitMessage}
      files={pane.files}
    />
  );
}

function FileHistoryPaneBody({
  pane,
  isActive,
  onClose,
}: {
  pane: FileHistoryPaneState;
  isActive: boolean;
  onClose: () => void;
}) {
  return (
    <FileHistoryTabHost
      tab={{
        kind: 'file-history',
        id: pane.id,
        projectPath: pane.projectPath,
        filePath: pane.filePath,
      }}
      isActive={isActive}
      onClose={onClose}
    />
  );
}

function AgentTasksPaneBody({
  workspaceId,
  pane,
  isActive,
}: {
  workspaceId: string;
  pane: AgentTaskPanelPaneState;
  isActive: boolean;
}) {
  return (
    <AgentTaskPanelTabHost
      tab={{
        kind: 'agent-tasks',
        id: pane.id,
        filter: pane.filter,
        selectedTaskId: pane.selectedTaskId,
        status: pane.status,
      }}
      workspaceId={workspaceId}
      isActive={isActive}
    />
  );
}

export function WorkspacePaneHost({
  workspaceId,
  tabId,
  pane,
  isActive,
  onActivatePane,
  onSplit,
  onClose,
  onLayoutDrop,
}: WorkspacePaneHostProps) {
  const [tabDropZone, setTabDropZone] = useState<LayoutDropZone | null>(null);

  const content = useMemo(() => {
    const close = () => onClose?.(pane.id);
    switch (pane.kind) {
      case 'file-viewer':
        return <FileViewerPaneBody workspaceId={workspaceId} pane={pane} isActive={isActive} onClose={close} />;
      case 'worktree-diff':
        return <WorktreeDiffPaneBody pane={pane} isActive={isActive} onClose={close} />;
      case 'commit-diff':
        return <CommitDiffPaneBody pane={pane} isActive={isActive} onClose={close} />;
      case 'file-history':
        return <FileHistoryPaneBody pane={pane} isActive={isActive} onClose={close} />;
      case 'agent-tasks':
        return <AgentTasksPaneBody workspaceId={workspaceId} pane={pane} isActive={isActive} />;
    }
  }, [isActive, onClose, pane, workspaceId]);

  useEffect(() => onLayoutDragEnd((result) => {
    setTabDropZone(null);
    if (
      result.payload.workspaceId !== workspaceId
      || result.dropTarget?.kind !== 'pane'
      || result.dropTarget.tabId !== tabId
      || result.dropTarget.paneId !== pane.id
      || !result.dropTarget.zone
    ) {
      return;
    }

    const direction = result.dropTarget.zone === 'left' || result.dropTarget.zone === 'right'
      ? 'horizontal'
      : 'vertical';
    const position = result.dropTarget.zone === 'left' || result.dropTarget.zone === 'top'
      ? 'before'
      : 'after';
    onLayoutDrop?.(result.payload, pane.id, direction, position);
  }), [onLayoutDrop, pane.id, tabId, workspaceId]);

  const handlePointerMove = (event: MouseEvent<HTMLDivElement>) => {
    const payload = getLayoutDragPayload();
    if (!isLayoutDragging() || !payload || payload.workspaceId !== workspaceId) {
      if (tabDropZone) {
        setTabDropZone(null);
      }
      return;
    }

    const zone = getDropZone(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY);
    if (tabDropZone !== zone) {
      setTabDropZone(zone);
    }
    setLayoutDropTarget({
      workspaceId,
      tabId,
      paneId: pane.id,
      kind: 'pane',
      zone,
    });
  };

  const clearDragState = () => {
    setTabDropZone(null);
    const currentTarget = getLayoutDropTarget();
    if (
      currentTarget?.kind === 'pane'
      && currentTarget.workspaceId === workspaceId
      && currentTarget.tabId === tabId
      && currentTarget.paneId === pane.id
    ) {
      setLayoutDropTarget(null);
    }
  };

  const handleDragHandleMouseDown = (event: MouseEvent<HTMLButtonElement>) => {
    if (event.button !== 0) {
      return;
    }
    onActivatePane?.(pane.id);
    beginLayoutDrag(
      {
        kind: 'pane',
        workspaceId,
        tabId,
        paneId: pane.id,
      },
      event.clientX,
      event.clientY,
      event.currentTarget.closest('[data-layout-drag-root="true"]') as HTMLElement | null,
    );
  };

  return (
    <div
      data-layout-drag-root="true"
      className="flex h-full min-h-0 w-full flex-col bg-[var(--bg-terminal)]"
      onMouseDownCapture={() => onActivatePane?.(pane.id)}
      onMouseEnter={handlePointerMove}
      onMouseMove={handlePointerMove}
      onMouseLeave={clearDragState}
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2 py-[3px] text-[10px]">
        <StatusDot status={pane.status as PaneStatus} />
        <button
          type="button"
          title="Move Pane"
          className="inline-flex h-[18px] w-[18px] cursor-grab items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-muted)] transition-[background-color,color] hover:bg-[color-mix(in_srgb,var(--bg-overlay)_72%,transparent)] hover:text-[var(--text-primary)] active:cursor-grabbing"
          onMouseDown={handleDragHandleMouseDown}
        >
          <svg viewBox="0 0 12 12" className="h-2.5 w-2.5 fill-current" aria-hidden="true">
            <circle cx="4" cy="3" r="0.8" />
            <circle cx="8" cy="3" r="0.8" />
            <circle cx="4" cy="6" r="0.8" />
            <circle cx="8" cy="6" r="0.8" />
            <circle cx="4" cy="9" r="0.8" />
            <circle cx="8" cy="9" r="0.8" />
          </svg>
        </button>
        <div className="truncate text-[var(--text-primary)]">{getPaneTitle(pane)}</div>
        <div className="ml-auto flex items-center gap-1">
          {onSplit && (
            <>
              <PaneChromeButton title="Split Right" onClick={() => onSplit(pane.id, 'horizontal')}>
                <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden="true">
                  <path d="M2 2.5h8v7H2z" fill="none" stroke="currentColor" strokeWidth="1" />
                  <path d="M6 2.5v7" fill="none" stroke="currentColor" strokeWidth="1" />
                </svg>
              </PaneChromeButton>
              <PaneChromeButton title="Split Down" onClick={() => onSplit(pane.id, 'vertical')}>
                <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden="true">
                  <path d="M2 2.5h8v7H2z" fill="none" stroke="currentColor" strokeWidth="1" />
                  <path d="M2 6h8" fill="none" stroke="currentColor" strokeWidth="1" />
                </svg>
              </PaneChromeButton>
            </>
          )}
          {onClose && (
            <PaneChromeButton title="Close Pane" onClick={() => onClose(pane.id)}>
              <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden="true">
                <path d="M3 3l6 6" fill="none" stroke="currentColor" strokeWidth="1" />
                <path d="M9 3 3 9" fill="none" stroke="currentColor" strokeWidth="1" />
              </svg>
            </PaneChromeButton>
          )}
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {content}
        {tabDropZone && (
          <div
            className="pointer-events-none absolute z-10"
            style={{
              ...dropZoneOverlay[tabDropZone],
              background: 'rgba(200, 128, 90, 0.12)',
              borderRadius: '4px',
            }}
          />
        )}
      </div>
    </div>
  );
}
