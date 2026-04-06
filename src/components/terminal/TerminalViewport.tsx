import { memo, useEffect, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { TerminalThemeDefinition } from '../../theme';
import { resizeTerminalSession } from '../../runtime/terminalApi';
import { clearTerminalResize, scheduleTerminalResize } from '../../runtime/terminalResizeScheduler';
import {
  selectSessionById,
  useAppStore,
} from '../../store';
import { getOrCreateTerminal } from '../../utils/terminalCache';
import {
  collectWrappedBufferText,
  createBufferRangeFromOffsets,
  doesBufferRangeIntersectLine,
  extractTerminalFileLinks,
  resolveTerminalFileLink,
  shouldActivateTerminalFileLink,
  type TerminalFileLinkMatch,
} from '../../utils/terminalFileLinks';
import { getDefaultPreviewMode } from '../../utils/documentPreview';
import type { WorkspaceRootConfig } from '../../types';
import '@xterm/xterm/css/xterm.css';

let terminalFileNavigationRequestId = 0;
const EMPTY_WORKSPACE_ROOTS: WorkspaceRootConfig[] = [];

const isMacPlatform = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

async function probeTerminalFilePath(path: string) {
  try {
    await invoke('read_file_content', { path });
    return true;
  } catch {
    return false;
  }
}

function isSameTerminalFileLinkMatch(
  left: TerminalFileLinkMatch | null,
  right: TerminalFileLinkMatch,
) {
  return Boolean(
    left
    && left.startIndex === right.startIndex
    && left.endIndex === right.endIndex
    && left.path === right.path
    && left.line === right.line
    && left.column === right.column,
  );
}

export interface TerminalViewportContextLink {
  text: string;
  open: () => void;
}

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
  onContextMenuRequest: (clientX: number, clientY: number, link?: TerminalViewportContextLink) => void;
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
  const hoveredLinkRef = useRef<TerminalFileLinkMatch | null>(null);
  const session = useAppStore(selectSessionById(sessionId));
  const workspaces = useAppStore((state) => state.config.workspaces);
  const recentWorkspaces = useAppStore((state) => state.config.recentWorkspaces);
  const workspaceRoots = useAppStore((state) => state.workspaceById.get(workspaceId)?.roots ?? EMPTY_WORKSPACE_ROOTS);
  const workspaceRootPaths = useMemo(
    () =>
      Array.from(
        new Set([
          ...workspaceRoots.map((root) => root.path),
          ...workspaces.flatMap((workspace) => workspace.roots.map((root) => root.path)),
          ...recentWorkspaces.flatMap((workspace) => workspace.rootPaths),
        ]),
      ),
    [recentWorkspaces, workspaceRoots, workspaces],
  );
  const linkContextRef = useRef({
    workspaceId,
    cwd: session?.cwd,
    workspaceRootPaths,
  });

  useEffect(() => {
    contextMenuRequestRef.current = onContextMenuRequest;
  }, [onContextMenuRequest]);

  const openTerminalFileLink = (match: TerminalFileLinkMatch) => {
    const { cwd, workspaceId: currentWorkspaceId, workspaceRootPaths: currentWorkspaceRootPaths } = linkContextRef.current;

    void resolveTerminalFileLink(match, {
      cwd,
      workspaceRootPaths: currentWorkspaceRootPaths,
      probeFile: probeTerminalFilePath,
    }).then((resolved) => {
      if (!resolved) {
        return;
      }

      const nextRequestId = ++terminalFileNavigationRequestId;
      useAppStore.getState().openFileViewer(currentWorkspaceId, resolved.path, {
        initialMode: getDefaultPreviewMode(resolved.path),
        ...(resolved.line
          ? {
              navigationTarget: {
                line: resolved.line,
                ...(resolved.column ? { column: resolved.column } : {}),
                requestId: nextRequestId,
              },
            }
          : {}),
      });
    });
  };

  useEffect(() => {
    linkContextRef.current = {
      workspaceId,
      cwd: session?.cwd,
      workspaceRootPaths,
    };
  }, [session?.cwd, workspaceId, workspaceRootPaths]);

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
      const hoveredLink = hoveredLinkRef.current;
      contextMenuRequestRef.current(
        mouseEvent.clientX,
        mouseEvent.clientY,
        hoveredLink
          ? {
              text: hoveredLink.text,
              open: () => openTerminalFileLink(hoveredLink),
            }
          : undefined,
      );
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
    const term = termRef.current;
    if (!term || typeof term.registerLinkProvider !== 'function') {
      return;
    }

    const linkProviderDisposable = term.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        const wrappedText = collectWrappedBufferText(term.buffer.active, bufferLineNumber);
        if (!wrappedText) {
          callback(undefined);
          return;
        }

        const links = extractTerminalFileLinks(wrappedText.text)
          .map((match) => {
            const range = createBufferRangeFromOffsets(wrappedText, match.startIndex, match.endIndex);
            if (!range || !doesBufferRangeIntersectLine(range, bufferLineNumber)) {
              return null;
            }

            return {
              range,
              text: match.text,
              decorations: {
                pointerCursor: true,
                underline: true,
              },
              activate(event: MouseEvent) {
                if (
                  !shouldActivateTerminalFileLink({
                    ctrlKey: event.ctrlKey,
                    metaKey: event.metaKey,
                    isMac: isMacPlatform,
                  })
                ) {
                  return;
                }

                event.preventDefault();
                event.stopPropagation();
                openTerminalFileLink(match);
              },
              hover() {
                hoveredLinkRef.current = match;
              },
              leave() {
                if (isSameTerminalFileLinkMatch(hoveredLinkRef.current, match)) {
                  hoveredLinkRef.current = null;
                }
              },
            };
          })
          .filter((link): link is NonNullable<typeof link> => link != null);

        callback(links.length > 0 ? links : undefined);
      },
    });

    return () => {
      hoveredLinkRef.current = null;
      linkProviderDisposable.dispose();
    };
  }, [ptyId, sessionId, workspaceId]);

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
