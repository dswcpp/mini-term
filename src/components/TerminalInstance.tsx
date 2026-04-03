import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow, UserAttentionType } from '@tauri-apps/api/window';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { useAppStore } from '../store';
import { resolveTheme } from '../theme';
import type { PaneStatus } from '../types';
import { getDraggingTabId } from '../utils/dragState';
import { showContextMenu } from '../utils/contextMenu';
import { showPrompt } from '../utils/prompt';
import { getOrCreateTerminal } from '../utils/terminalCache';
import { SessionCommandTimeline } from './terminal/SessionCommandTimeline';
import { SessionMetaStrip } from './terminal/SessionMetaStrip';
import { buildTerminalContextMenu } from './terminal/terminalContextMenu';
import { StatusDot } from './StatusDot';
import '@xterm/xterm/css/xterm.css';

type DropZone = 'top' | 'bottom' | 'left' | 'right';
type DragKind = 'file' | 'tab';

const appWindow = getCurrentWindow();
const noDragStyle = { WebkitAppRegion: 'no-drag' } as CSSProperties;

function getDropZone(rect: DOMRect, clientX: number, clientY: number): DropZone {
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  const aboveMain = y < x;
  const aboveAnti = y < 1 - x;
  if (aboveMain && aboveAnti) return 'top';
  if (!aboveMain && !aboveAnti) return 'bottom';
  if (!aboveMain && aboveAnti) return 'left';
  return 'right';
}

const dropZoneOverlay: Record<DropZone, CSSProperties> = {
  top: { top: 0, left: 0, right: 0, height: '50%' },
  bottom: { bottom: 0, left: 0, right: 0, height: '50%' },
  left: { top: 0, left: 0, bottom: 0, width: '50%' },
  right: { top: 0, right: 0, bottom: 0, width: '50%' },
};

interface Props {
  tabId: string;
  ptyId: number;
  paneId?: string;
  shellName?: string;
  runCommand?: string;
  status?: PaneStatus;
  onActivatePane?: (paneId: string) => void;
  onSplit?: (paneId: string, direction: 'horizontal' | 'vertical') => void;
  onClose?: (paneId: string) => void;
  onRestart?: (paneId: string) => void;
  onNewTab?: () => void;
  onRenameTab?: () => void;
  onCloseTab?: () => void;
  onOpenSettings?: () => void;
  onTabDrop?: (
    sourceTabId: string,
    targetPaneId: string,
    direction: 'horizontal' | 'vertical',
    position: 'before' | 'after',
  ) => void;
}

function PaneActionButton({
  title,
  children,
  onClick,
  onContextMenu,
}: {
  title: string;
  children: ReactNode;
  onClick: () => void;
  onContextMenu?: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      title={title}
      className="inline-flex h-[18px] w-[18px] items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-muted)] transition-colors hover:bg-[var(--border-subtle)] hover:text-[var(--text-primary)]"
      style={noDragStyle}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      {children}
    </button>
  );
}

export const TerminalInstance = memo(function TerminalInstance({
  tabId,
  ptyId,
  paneId,
  shellName,
  runCommand,
  status,
  onActivatePane,
  onSplit,
  onClose,
  onRestart,
  onNewTab,
  onRenameTab,
  onCloseTab,
  onOpenSettings,
  onTabDrop,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const previousStatusRef = useRef<PaneStatus | undefined>(status);
  const [dragKind, setDragKind] = useState<DragKind | null>(null);
  const [tabDropZone, setTabDropZone] = useState<DropZone | null>(null);
  const [notifyOnCompletion, setNotifyOnCompletion] = useState(false);
  const setPaneRunCommand = useAppStore((state) => state.setPaneRunCommand);
  const terminalFontSize = useAppStore((state) => state.config.terminalFontSize);
  const themePreset = useAppStore((state) => state.config.theme.preset);
  const themeWindowEffect = useAppStore((state) => state.config.theme.windowEffect);
  const session = useAppStore((state) => state.sessions.get(ptyId));
  const resolvedTheme = useMemo(
    () => resolveTheme({ preset: themePreset, windowEffect: themeWindowEffect }),
    [themePreset, themeWindowEffect],
  );

  useEffect(() => {
    const term = termRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon || !terminalFontSize) return;

    term.options.fontSize = terminalFontSize;
    fitAddon.fit();
    term.refresh(0, term.rows - 1);
  }, [terminalFontSize, ptyId]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    term.options.theme = resolvedTheme.preset.terminal;
    term.refresh(0, term.rows - 1);
  }, [resolvedTheme, ptyId]);

  useEffect(() => {
    if (
      notifyOnCompletion &&
      previousStatusRef.current === 'ai-working' &&
      status &&
      status !== 'ai-working'
    ) {
      void appWindow.requestUserAttention(UserAttentionType.Informational).catch(() => {});
      setNotifyOnCompletion(false);
    }

    previousStatusRef.current = status;
  }, [notifyOnCompletion, status]);

  useEffect(() => {
    setNotifyOnCompletion(false);
  }, [ptyId]);

  const isTabDrag = (event: DragEvent<HTMLDivElement>) =>
    event.dataTransfer.types.includes('application/tab-id');

  const clearDragState = () => {
    setDragKind(null);
    setTabDropZone(null);
  };

  const handleDragMove = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();

    if (isTabDrag(event)) {
      const rect = event.currentTarget.getBoundingClientRect();
      setDragKind('tab');
      setTabDropZone(getDropZone(rect, event.clientX, event.clientY));
      return;
    }

    setDragKind('file');
    setTabDropZone(null);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();

    const currentDragKind = dragKind ?? (isTabDrag(event) ? 'tab' : 'file');
    clearDragState();

    if (currentDragKind === 'tab' && paneId && onTabDrop) {
      const sourceTabId = getDraggingTabId();
      if (sourceTabId) {
        const rect = event.currentTarget.getBoundingClientRect();
        const zone = getDropZone(rect, event.clientX, event.clientY);
        const direction = zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical';
        const position = zone === 'left' || zone === 'top' ? 'before' : 'after';
        onTabDrop(sourceTabId, paneId, direction, position);
        return;
      }
    }

    const filePath = event.dataTransfer.getData('text/plain').trim();
    if (filePath) {
      void invoke('write_pty', { ptyId, data: filePath });
      termRef.current?.focus();
    }
  };

  const handleCopy = useCallback(() => {
    const selection = termRef.current?.getSelection();
    if (selection) {
      void writeText(selection);
    }
    termRef.current?.focus();
  }, []);

  const handlePaste = useCallback(() => {
    void readText().then((text) => {
      if (text) {
        void invoke('write_pty', { ptyId, data: text });
      }
      termRef.current?.focus();
    });
  }, [ptyId]);

  const handleClearScreen = useCallback(() => {
    termRef.current?.clear();
    termRef.current?.focus();
  }, []);

  const handleRunCommand = useCallback(async () => {
    const currentCommand = runCommand?.trim();
    if (!currentCommand) {
      const nextCommand = await showPrompt('设置运行命令', '输入要执行的命令', session?.lastCommand ?? '');
      const updated = nextCommand?.trim();
      if (!updated || !paneId) {
        termRef.current?.focus();
        return;
      }
      setPaneRunCommand(tabId, paneId, updated);
      const suffix = updated.endsWith('\n') || updated.endsWith('\r') ? '' : '\r';
      await invoke('write_pty', { ptyId, data: `${updated}${suffix}` });
      termRef.current?.focus();
      return;
    }

    const suffix = currentCommand.endsWith('\n') || currentCommand.endsWith('\r') ? '' : '\r';
    await invoke('write_pty', { ptyId, data: `${currentCommand}${suffix}` });
    termRef.current?.focus();
  }, [paneId, ptyId, runCommand, session?.lastCommand, setPaneRunCommand, tabId]);

  const handleEditRunCommand = useCallback(async () => {
    if (!paneId) return;
    const nextCommand = await showPrompt('编辑运行命令', '输入要执行的命令', runCommand ?? '');
    const updated = nextCommand?.trim();
    if (!updated) {
      setPaneRunCommand(tabId, paneId, undefined);
      return;
    }
    setPaneRunCommand(tabId, paneId, updated);
  }, [paneId, runCommand, setPaneRunCommand, tabId]);

  const handleViewRunCommand = useCallback(async () => {
    if (!runCommand) return;
    await showPrompt('查看运行命令', '仅查看，不会自动执行', runCommand);
  }, [runCommand]);

  const handleDeleteRunCommand = useCallback(() => {
    if (!paneId) return;
    setPaneRunCommand(tabId, paneId, undefined);
  }, [paneId, setPaneRunCommand, tabId]);

  const openTerminalContextMenu = useCallback(
    async (clientX: number, clientY: number) => {
      const isWindowMaximized = await appWindow.isMaximized().catch(() => false);
      const hasSelection = Boolean(termRef.current?.getSelection());
      const canNotifyOnCompletion = status === 'ai-working';

      showContextMenu(
        clientX,
        clientY,
        buildTerminalContextMenu({
          hasSelection,
          canSplit: Boolean(paneId && onSplit),
          canClosePane: Boolean(paneId && onClose),
          canRenameTab: Boolean(onRenameTab),
          canNotifyOnCompletion,
          notifyOnCompletion,
          isWindowMaximized,
          onCopy: handleCopy,
          onPaste: handlePaste,
          onToggleNotifyOnCompletion: () => setNotifyOnCompletion((value) => !value),
          onClearScreen: handleClearScreen,
          onRunCommand: () => {
            void handleRunCommand();
          },
          onRestartTerminal: () => {
            if (paneId && onRestart) onRestart(paneId);
          },
          onSplitRight: () => {
            if (paneId && onSplit) onSplit(paneId, 'horizontal');
          },
          onSplitDown: () => {
            if (paneId && onSplit) onSplit(paneId, 'vertical');
          },
          onClosePane: () => {
            if (paneId && onClose) onClose(paneId);
          },
          onNewTab: () => onNewTab?.(),
          onRenameTab: () => onRenameTab?.(),
          onCloseTab: () => onCloseTab?.(),
          onWindowMinimize: () => {
            void appWindow.minimize();
          },
          onWindowToggleMaximize: () => {
            void appWindow.toggleMaximize();
          },
          onWindowClose: () => {
            void appWindow.close();
          },
          onOpenSettings: () => onOpenSettings?.(),
        }),
      );
    },
    [
      handleClearScreen,
      handleCopy,
      handlePaste,
      handleRunCommand,
      notifyOnCompletion,
      onClose,
      onCloseTab,
      onNewTab,
      onOpenSettings,
      onRenameTab,
      onRestart,
      onSplit,
      paneId,
      status,
    ],
  );

  const openTerminalContextMenuRef = useRef(openTerminalContextMenu);
  useEffect(() => {
    openTerminalContextMenuRef.current = openTerminalContextMenu;
  }, [openTerminalContextMenu]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const { term, fitAddon, wrapper } = getOrCreateTerminal(ptyId);
    termRef.current = term;
    fitAddonRef.current = fitAddon;
    container.appendChild(wrapper);

    requestAnimationFrame(() => {
      if (container.clientWidth > 0 && container.clientHeight > 0) {
        const previousCols = term.cols;
        const previousRows = term.rows;
        fitAddon.fit();
        if (term.cols !== previousCols || term.rows !== previousRows) {
          void invoke('resize_pty', { ptyId, cols: term.cols, rows: term.rows });
        }
        term.refresh(0, term.rows - 1);
      }
    });

    let rafId = 0;
    const scheduleFit = (forceRefresh = false) => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        if (container.clientWidth <= 0 || container.clientHeight <= 0) return;

        const previousCols = term.cols;
        const previousRows = term.rows;
        fitAddon.fit();

        const sizeChanged = term.cols !== previousCols || term.rows !== previousRows;
        if (sizeChanged || forceRefresh) {
          term.refresh(0, term.rows - 1);
        }
      });
    };

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

    const handleNativeContextMenu = (event: Event) => {
      const mouseEvent = event as globalThis.MouseEvent;
      mouseEvent.preventDefault();
      mouseEvent.stopPropagation();
      void openTerminalContextMenuRef.current(mouseEvent.clientX, mouseEvent.clientY);
    };

    container.addEventListener('contextmenu', handleNativeContextMenu, true);
    wrapper.addEventListener('contextmenu', handleNativeContextMenu, true);

    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
      visibilityObserver.disconnect();
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

  const handleContextMenu = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      void openTerminalContextMenu(event.clientX, event.clientY);
    },
    [openTerminalContextMenu],
  );

  const handleActivatePane = useCallback(() => {
    if (paneId && onActivatePane) {
      onActivatePane(paneId);
    }
  }, [onActivatePane, paneId]);

  const handleRunCommandContextMenu = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      showContextMenu(event.clientX, event.clientY, [
        {
          label: '编辑',
          disabled: !paneId,
          onClick: () => {
            void handleEditRunCommand();
          },
        },
        {
          label: '查看',
          disabled: !runCommand,
          onClick: () => {
            void handleViewRunCommand();
          },
        },
        {
          label: '删除',
          danger: true,
          disabled: !runCommand,
          onClick: () => handleDeleteRunCommand(),
        },
      ]);
    },
    [handleDeleteRunCommand, handleEditRunCommand, handleViewRunCommand, runCommand],
  );

  return (
    <div
      className="flex h-full w-full flex-col"
      data-tab-id={tabId}
      onContextMenu={handleContextMenu}
      onMouseDownCapture={handleActivatePane}
    >
      <div
        className="flex shrink-0 items-center gap-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2 py-[3px] text-[10px] select-none"
        style={noDragStyle}
      >
        {status && <StatusDot status={status} />}
        <SessionMetaStrip shellName={shellName} session={session} />

        <PaneActionButton
          title="运行命令（右键管理）"
          onClick={() => void handleRunCommand()}
          onContextMenu={handleRunCommandContextMenu}
        >
          <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden="true">
            <path d="M3 2.5v7l6-3.5-6-3.5Z" fill="currentColor" />
          </svg>
        </PaneActionButton>

        {paneId && onSplit && (
          <>
            <PaneActionButton title="向右分屏" onClick={() => onSplit(paneId, 'horizontal')}>
              <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden="true">
                <path d="M2 2.5h8v7H2z" fill="none" stroke="currentColor" strokeWidth="1" />
                <path d="M6 2.5v7" fill="none" stroke="currentColor" strokeWidth="1" />
              </svg>
            </PaneActionButton>
            <PaneActionButton title="向下分屏" onClick={() => onSplit(paneId, 'vertical')}>
              <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden="true">
                <path d="M2 2.5h8v7H2z" fill="none" stroke="currentColor" strokeWidth="1" />
                <path d="M2 6h8" fill="none" stroke="currentColor" strokeWidth="1" />
              </svg>
            </PaneActionButton>
          </>
        )}

        {paneId && onRestart && (
          <PaneActionButton title="重置终端" onClick={() => onRestart(paneId)}>
            <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden="true">
              <path d="M3 4V2.5H1.5" fill="none" stroke="currentColor" strokeWidth="1" />
              <path
                d="M3 2.5A4 4 0 1 1 2.3 7.8"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="1"
              />
            </svg>
          </PaneActionButton>
        )}

        {paneId && onClose && (
          <PaneActionButton title="关闭分屏" onClick={() => onClose(paneId)}>
            <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden="true">
              <path d="M3 3l6 6" fill="none" stroke="currentColor" strokeWidth="1" />
              <path d="M9 3 3 9" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          </PaneActionButton>
        )}
      </div>

      <SessionCommandTimeline session={session} />

      <div
        className="relative flex-1 bg-[var(--bg-terminal)]"
        onDragEnterCapture={handleDragMove}
        onDragOverCapture={(event) => {
          handleDragMove(event);
          event.dataTransfer.dropEffect = isTabDrag(event) ? 'move' : 'copy';
        }}
        onDragLeaveCapture={(event) => {
          const nextTarget = event.relatedTarget as Node | null;
          if (!nextTarget || !event.currentTarget.contains(nextTarget)) {
            clearDragState();
          }
        }}
        onDropCapture={handleDrop}
      >
        <div ref={containerRef} className="absolute top-1.5 right-0 bottom-0 left-2.5 cursor-none" />

        {dragKind === 'file' && (
          <div
            className="pointer-events-none absolute inset-1 z-10 flex items-center justify-center rounded-[var(--radius-md)]"
            style={{ background: 'rgba(200, 128, 90, 0.06)', border: '2px dashed var(--accent)' }}
          >
            <span
              className="rounded-[var(--radius-md)] px-3 py-1.5 text-xs text-[var(--accent)]"
              style={{ background: 'var(--bg-overlay)' }}
            >
              释放以插入路径
            </span>
          </div>
        )}

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
});
