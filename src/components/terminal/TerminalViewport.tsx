import { memo, useEffect, useRef } from 'react';
import type { TerminalThemeDefinition } from '../../theme';
import { resizeTerminalSession } from '../../runtime/terminalApi';
import { clearTerminalResize, scheduleTerminalResize } from '../../runtime/terminalResizeScheduler';
import { useAppStore } from '../../store';
import { getOrCreateTerminal } from '../../utils/terminalCache';
import '@xterm/xterm/css/xterm.css';

export interface TerminalViewportProps {
  workspaceId: string;
  tabId: string;
  sessionId: string;
  paneId?: string;
  ptyId: number;
  fontSize: number;
  terminalTheme: TerminalThemeDefinition;
  isActive: boolean;
  isVisible: boolean;
  onContextMenuRequest: (clientX: number, clientY: number) => void;
}

export const TerminalViewport = memo(function TerminalViewport({
  workspaceId,
  tabId,
  sessionId,
  paneId,
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
    if (!paneId) {
      return;
    }

    const { upsertTerminalView, removeTerminalView } = useAppStore.getState();
    upsertTerminalView({
      viewId: paneId,
      paneId,
      tabId,
      workspaceId,
      sessionId,
      isVisible,
      isFocused: isActive,
      mountedAt: Date.now(),
      updatedAt: Date.now(),
    });

    return () => {
      removeTerminalView(paneId);
    };
  }, [isActive, isVisible, paneId, sessionId, tabId, workspaceId]);

  useEffect(() => {
    if (!paneId) {
      return;
    }

    useAppStore.getState().updateTerminalView(paneId, {
      tabId,
      workspaceId,
      isVisible,
      isFocused: isActive,
      sessionId,
    });
  }, [isActive, isVisible, paneId, sessionId, tabId, workspaceId]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const { term, fitAddon, wrapper } = getOrCreateTerminal(sessionId, ptyId);
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
  }, [ptyId, sessionId]);

  useEffect(() => {
    const term = termRef.current;
    if (!term || !fontSize) {
      return;
    }

    term.options.fontSize = fontSize;
    if (isVisible) {
      scheduleTerminalResize(sessionId, () => {
        fitAddonRef.current?.fit();
        term.refresh(0, term.rows - 1);
      });
    }
  }, [fontSize, isVisible, sessionId]);

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
  }, [isActive, isVisible, sessionId]);

  useEffect(() => {
    const container = containerRef.current;
    const term = termRef.current;
    const fitAddon = fitAddonRef.current;
    if (!container || !term || !fitAddon || !isVisible) {
      return;
    }

    const scheduleFit = (forceRefresh = false) => {
      scheduleTerminalResize(sessionId, () => {
        if (container.clientWidth <= 0 || container.clientHeight <= 0) {
          return;
        }

        const previousCols = term.cols;
        const previousRows = term.rows;
        fitAddon.fit();

        const sizeChanged = term.cols !== previousCols || term.rows !== previousRows;
        if (paneId) {
          useAppStore.getState().updateTerminalView(paneId, {
            cols: term.cols,
            rows: term.rows,
          });
        }

        if (sizeChanged) {
          void resizeTerminalSession(sessionId, term.cols, term.rows);
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
      clearTerminalResize(sessionId);
      observer.disconnect();
      visibilityObserver.disconnect();
    };
  }, [isVisible, paneId, sessionId]);

  return <div ref={containerRef} className="absolute top-1.5 right-0 bottom-0 left-2.5 cursor-text" />;
});
