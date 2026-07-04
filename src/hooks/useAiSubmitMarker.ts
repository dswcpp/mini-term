import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useAppStore } from '../store';
import { registerAiMarker, isMarkerDisposed } from '../utils/terminalCache';
import type { AiUserSubmitPayload } from '../types';

export function useAiSubmitMarker() {
  const addMarker = useAppStore((s) => s.addMarker);
  const pruneDisposed = useAppStore((s) => s.pruneDisposed);

  useEffect(() => {
    let cancelled = false;

    const unlistenPromise = listen<AiUserSubmitPayload>('ai-user-submit', (event) => {
      if (cancelled) return;
      const payload = event.payload;

      const tryRegister = (retry: boolean) => {
        const marker = registerAiMarker(payload.ptyId);
        if (marker) {
          addMarker(payload, marker.id);
          pruneDisposed(payload.ptyId, (id) => isMarkerDisposed(payload.ptyId, id));
          return;
        }
        if (retry) {
          requestAnimationFrame(() => tryRegister(false));
        } else {
          console.warn('[ai-submit-marker] term not ready for pty', payload.ptyId);
        }
      };

      tryRegister(true);
    });

    return () => {
      cancelled = true;
      void unlistenPromise.then((fn) => fn());
    };
  }, [addMarker, pruneDisposed]);
}
