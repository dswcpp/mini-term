import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';

type DragState = {
  active: boolean;
  moved: boolean;
  startX: number;
  startY: number;
  scrollLeft: number;
  scrollTop: number;
  element: HTMLDivElement | null;
};

export function useSecondaryButtonPan() {
  const dragStateRef = useRef<DragState>({
    active: false,
    moved: false,
    startX: 0,
    startY: 0,
    scrollLeft: 0,
    scrollTop: 0,
    element: null,
  });
  const suppressContextMenuRef = useRef(false);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      const state = dragStateRef.current;
      if (!state.active || !state.element) {
        return;
      }

      if ((event.buttons & 2) !== 2) {
        state.active = false;
        state.element = null;
        setDragging(false);
        return;
      }

      const deltaX = event.clientX - state.startX;
      const deltaY = event.clientY - state.startY;
      state.element.scrollLeft = state.scrollLeft - deltaX;
      state.element.scrollTop = state.scrollTop - deltaY;

      if (deltaX !== 0 || deltaY !== 0) {
        state.moved = true;
        suppressContextMenuRef.current = true;
      }

      event.preventDefault();
    };

    const handleMouseUp = () => {
      if (!dragStateRef.current.active) {
        return;
      }

      dragStateRef.current.active = false;
      dragStateRef.current.element = null;
      setDragging(false);
    };

    const handleWindowBlur = () => {
      dragStateRef.current.active = false;
      dragStateRef.current.element = null;
      setDragging(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('blur', handleWindowBlur);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, []);

  const onMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 2) {
      return;
    }

    dragStateRef.current = {
      active: true,
      moved: false,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: event.currentTarget.scrollLeft,
      scrollTop: event.currentTarget.scrollTop,
      element: event.currentTarget,
    };
    setDragging(true);
    event.preventDefault();
  };

  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!dragStateRef.current.moved && !suppressContextMenuRef.current) {
      return;
    }

    dragStateRef.current.moved = false;
    suppressContextMenuRef.current = false;
    event.preventDefault();
  };

  return { dragging, onMouseDown, onContextMenu };
}
