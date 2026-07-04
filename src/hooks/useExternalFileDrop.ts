import { useEffect } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { writePtyInput, getCachedTerminal } from '../utils/terminalCache';

function findTerminalPtyId(position: { x: number; y: number }): number | null {
  const scale = window.devicePixelRatio || 1;
  const el = document.elementFromPoint(position.x / scale, position.y / scale);
  const dropZone = el?.closest('[data-pty-id]');
  if (!dropZone) return null;
  const id = Number(dropZone.getAttribute('data-pty-id'));
  return Number.isFinite(id) ? id : null;
}

export function useExternalFileDrop(): void {
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let hoveredPtyId: number | null = null;

    const setHover = (ptyId: number | null) => {
      if (hoveredPtyId === ptyId) return;
      hoveredPtyId = ptyId;
      window.dispatchEvent(new CustomEvent('external-file-drag', { detail: ptyId }));
    };

    let lastDropTime = 0;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (cancelled) return;
        const { payload } = event;
        if (payload.type === 'enter' || payload.type === 'over') {
          setHover(findTerminalPtyId(payload.position));
        } else if (payload.type === 'drop') {
          const now = Date.now();
          if (now - lastDropTime < 100) return;
          lastDropTime = now;
          const ptyId = findTerminalPtyId(payload.position);
          setHover(null);
          if (ptyId != null && payload.paths.length > 0) {
            const formatted = payload.paths.map((p) => `'${p}'`).join(' ');
            void writePtyInput(ptyId, formatted);
            getCachedTerminal(ptyId)?.term.focus();
          }
        } else {
          setHover(null);
        }
      })
      .then((fn) => {
        if (cancelled) { fn(); } else { unlisten = fn; }
      });

    return () => {
      cancelled = true;
      unlisten?.();
      setHover(null);
    };
  }, []);
}
