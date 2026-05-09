import type { LayoutDragPayload, LayoutDropTarget } from '../types';

const DRAG_THRESHOLD = 5;

export interface LayoutDragResult {
  payload: LayoutDragPayload;
  dropTarget: LayoutDropTarget | null;
}

type LayoutDragEndListener = (result: LayoutDragResult) => void;

let _payload: LayoutDragPayload | null = null;
let _dropTarget: LayoutDropTarget | null = null;
let _dragging = false;
let _sourceElement: HTMLElement | null = null;
let _pointerStart: { x: number; y: number } | null = null;
let _listeners = new Set<LayoutDragEndListener>();
let _detach: (() => void) | null = null;

function suppressNextClick() {
  window.addEventListener(
    'click',
    (event) => {
      event.stopPropagation();
      event.preventDefault();
    },
    { capture: true, once: true },
  );
}

function setSourceDraggingVisual(active: boolean) {
  if (!_sourceElement) {
    return;
  }

  if (active) {
    _sourceElement.style.opacity = '0.45';
    return;
  }

  _sourceElement.style.opacity = '';
}

function resetDragState() {
  setSourceDraggingVisual(false);
  document.body.classList.remove('layout-dragging');
  _payload = null;
  _dropTarget = null;
  _dragging = false;
  _sourceElement = null;
  _pointerStart = null;
  _detach?.();
  _detach = null;
}

export function beginLayoutDrag(
  payload: LayoutDragPayload,
  startX: number,
  startY: number,
  sourceElement?: HTMLElement | null,
) {
  resetDragState();

  _payload = payload;
  _sourceElement = sourceElement ?? null;
  _pointerStart = { x: startX, y: startY };

  const onMove = (event: MouseEvent) => {
    if (_dragging || !_pointerStart) {
      return;
    }

    const distance =
      Math.abs(event.clientX - _pointerStart.x) + Math.abs(event.clientY - _pointerStart.y);
    if (distance < DRAG_THRESHOLD) {
      return;
    }

    _dragging = true;
    document.body.classList.add('layout-dragging');
    setSourceDraggingVisual(true);
  };

  const onUp = () => {
    const result = _dragging && _payload
      ? {
          payload: _payload,
          dropTarget: _dropTarget,
        }
      : null;

    if (_dragging) {
      suppressNextClick();
    }

    resetDragState();

    if (!result) {
      return;
    }

    _listeners.forEach((listener) => {
      listener(result);
    });
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  _detach = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
}

export function isLayoutDragging() {
  return _dragging;
}

export function getLayoutDragPayload() {
  return _dragging ? _payload : null;
}

export function setLayoutDropTarget(target: LayoutDropTarget | null) {
  if (!_dragging) {
    return;
  }
  _dropTarget = target;
}

export function getLayoutDropTarget() {
  return _dropTarget;
}

export function onLayoutDragEnd(listener: LayoutDragEndListener) {
  _listeners.add(listener);
  return () => {
    _listeners.delete(listener);
  };
}
