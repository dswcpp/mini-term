import { useEffect, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import type { LayoutDragPayload, LayoutDropZone } from '../types';
import {
  getLayoutDragPayload,
  getLayoutDropTarget,
  isLayoutDragging,
  onLayoutDragEnd,
  setLayoutDropTarget,
} from '../utils/dragState';

const dropZoneOverlay: Record<LayoutDropZone, CSSProperties> = {
  top: { top: 0, left: 0, right: 0, height: '50%' },
  bottom: { bottom: 0, left: 0, right: 0, height: '50%' },
  left: { top: 0, left: 0, bottom: 0, width: '50%' },
  right: { top: 0, right: 0, bottom: 0, width: '50%' },
};

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

interface WorkspaceTabDropSurfaceProps {
  workspaceId: string;
  tabId: string;
  children: ReactNode;
  onLayoutDrop: (
    payload: LayoutDragPayload,
    direction: 'horizontal' | 'vertical',
    position: 'before' | 'after',
  ) => void;
}

export function WorkspaceTabDropSurface({
  workspaceId,
  tabId,
  children,
  onLayoutDrop,
}: WorkspaceTabDropSurfaceProps) {
  const [dropZone, setDropZone] = useState<LayoutDropZone | null>(null);

  useEffect(() => onLayoutDragEnd((result) => {
    setDropZone(null);
    if (
      result.payload.workspaceId !== workspaceId
      || result.dropTarget?.kind !== 'tab-surface'
      || result.dropTarget.tabId !== tabId
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
    onLayoutDrop(result.payload, direction, position);
  }), [onLayoutDrop, tabId, workspaceId]);

  const updateDropZone = (event: MouseEvent<HTMLDivElement>) => {
    const payload = getLayoutDragPayload();
    if (!isLayoutDragging() || !payload || payload.workspaceId !== workspaceId) {
      if (dropZone) {
        setDropZone(null);
      }
      return;
    }

    const nextZone = getDropZone(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY);
    if (dropZone !== nextZone) {
      setDropZone(nextZone);
    }
    setLayoutDropTarget({
      workspaceId,
      tabId,
      kind: 'tab-surface',
      zone: nextZone,
    });
  };

  const clearDropZone = () => {
    setDropZone(null);
    const currentTarget = getLayoutDropTarget();
    if (currentTarget?.kind === 'tab-surface' && currentTarget.workspaceId === workspaceId && currentTarget.tabId === tabId) {
      setLayoutDropTarget(null);
    }
  };

  return (
    <div
      className="relative h-full"
      onMouseEnter={updateDropZone}
      onMouseMove={updateDropZone}
      onMouseLeave={clearDropZone}
    >
      {children}
      {dropZone && (
        <div
          className="pointer-events-none absolute z-10"
          style={{
            ...dropZoneOverlay[dropZone],
            background: 'rgba(200, 128, 90, 0.12)',
            borderRadius: '4px',
          }}
        />
      )}
    </div>
  );
}
