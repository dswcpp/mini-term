import { memo, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { TerminalThemeDefinition } from '../../theme';
import { getOrCreateTerminal } from '../../utils/terminalCache';
import '@xterm/xterm/css/xterm.css';

export interface TerminalViewportProps {
  ptyId: number;
  fontSize: number;
  terminalTheme: TerminalThemeDefinition;
  isActive: boolean;
  isVisible: boolean;
  onContextMenuRequest: (clientX: number, clientY: number) => void;
}

export const TerminalViewport = memo(function TerminalViewport({
  ptyId,
  fontSize,
  terminalTheme,
  isActive,
  isVisible,
  onContextMenuRequest,
}: TerminalViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<ReturnType<typeof getOrCreateTerminal>['term'] | null>(null);
  const fitAddonRef = useRef<ReturnType<typeof getOrCreateTerminal>['fitAddon'] | null>(null);
  const contextMenuRequestRef = useRef(onContextMenuRequest);

  useEffect(() => {
    contextMenuRequestRef.current = onContextMenuRequest;
  }, [onContextMenuRequest]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const { term, fitAddon, wrapper } = getOrCreateTerminal(ptyId);
    termRef.current = term;
    fitAddonRef.current = fitAddon;
    container.appendChild(wrapper);

    const handleNativeContextMenu = (event: Event) => {
      const mouseEvent = event as globalThis.MouseEvent;
      mouseEvent.preventDefault();
      mouseEvent.stopPropagation();
      contextMenuRequestRef.current(mouseEvent.clientX, mouseEvent.clientY);
    };

    container.addEventListener('contextmenu', handleNativeContextMenu, true);
    wrapper.addEventListener('contextmenu', handleNativeContextMenu, true);

    return () => {
      container.removeEventListener('contextmenu', handleNativeContextMenu, true);
      wrapper.removeEventListener('contextmenu', handleNativeContextMenu, true);
      wrapper.remove();
      if (termRef.current === term) {
        termRef.current = null;
      }
      if (fitAddonRef.current === fitAddon) {
        fitAddonRef.current = null;
      }
    };
  }, [ptyId]);

  useEffect(() => {
    const term = termRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon || !fontSize) {
      return;
    }

    term.options.fontSize = fontSize;
    if (isVisible) {
      fitAddon.fit();
      term.refresh(0, term.rows - 1);
    }
  }, [fontSize, isVisible]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) {
      return;
    }

    term.options.theme = terminalTheme;
    if (isVisible) {
      term.refresh(0, term.rows - 1);
    }
  }, [isVisible, terminalTheme]);

  useEffect(() => {
    const term = termRef.current;
    if (!term || !isActive || !isVisible) {
      return;
    }

    const rafId = requestAnimationFrame(() => {
      term.focus();
    });

    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [isActive, isVisible, ptyId]);

  useEffect(() => {
    const container = containerRef.current;
    const term = termRef.current;
    const fitAddon = fitAddonRef.current;
    if (!container || !term || !fitAddon || !isVisible) {
      return;
    }

    let rafId = 0;
    const scheduleFit = (forceRefresh = false) => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        if (container.clientWidth <= 0 || container.clientHeight <= 0) {
          return;
        }

        const previousCols = term.cols;
        const previousRows = term.rows;
        fitAddon.fit();

        const sizeChanged = term.cols !== previousCols || term.rows !== previousRows;
        if (sizeChanged) {
          void invoke('resize_pty', { ptyId, cols: term.cols, rows: term.rows });
        }

        if (sizeChanged || forceRefresh) {
          term.refresh(0, term.rows - 1);
        }
      });
    };

    scheduleFit(true);

    const observer = new ResizeObserver(() => {
      scheduleFit(false);
    });
    observer.observe(container);

    const visibilityObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        scheduleFit(true);
      }
    });
    visibilityObserver.observe(container);

    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
      visibilityObserver.disconnect();
    };
  }, [isActive, isVisible, ptyId]);

  return <div ref={containerRef} className="absolute top-1.5 right-0 bottom-0 left-2.5 cursor-text" />;
});
