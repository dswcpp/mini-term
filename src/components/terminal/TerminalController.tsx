import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow, UserAttentionType } from '@tauri-apps/api/window';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { useAppStore, selectPaneRuntimeByPty, selectSessionByPty } from '../../store';
import { useTerminalCompletions } from '../../hooks/useTerminalCompletions';
import { resolveTheme } from '../../theme';
import type { PaneStatus } from '../../types';
import { getDraggingTabId } from '../../utils/dragState';
import { showContextMenu } from '../../utils/contextMenu';
import { showPrompt } from '../../utils/prompt';
import {
  getCachedTerminal,
  markTerminalInputUnsafe,
  mirrorTerminalInput,
  registerTerminalKeyHandler,
} from '../../utils/terminalCache';
import { buildTerminalContextMenu } from './terminalContextMenu';
import { TerminalChrome, type TerminalDragKind, type TerminalDropZone } from './TerminalChrome';
import { TerminalViewport } from './TerminalViewport';

const appWindow = getCurrentWindow();

function getDropZone(rect: DOMRect, clientX: number, clientY: number): TerminalDropZone {
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  const aboveMain = y < x;
  const aboveAnti = y < 1 - x;
  if (aboveMain && aboveAnti) return 'top';
  if (!aboveMain && !aboveAnti) return 'bottom';
  if (!aboveMain && aboveAnti) return 'left';
  return 'right';
}

interface TerminalControllerProps {
  tabId: string;
  projectPath: string;
  ptyId: number;
  paneId?: string;
  shellName?: string;
  runCommand?: string;
  status?: PaneStatus;
  isActive: boolean;
  isVisible: boolean;
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

export const TerminalController = memo(function TerminalController({
  tabId,
  projectPath,
  ptyId,
  paneId,
  shellName,
  runCommand,
  status,
  isActive,
  isVisible,
  onActivatePane,
  onSplit,
  onClose,
  onRestart,
  onNewTab,
  onRenameTab,
  onCloseTab,
  onOpenSettings,
  onTabDrop,
}: TerminalControllerProps) {
  const previousStatusRef = useRef<PaneStatus | undefined>(status);
  const [dragKind, setDragKind] = useState<TerminalDragKind | null>(null);
  const [tabDropZone, setTabDropZone] = useState<TerminalDropZone | null>(null);
  const [notifyOnCompletion, setNotifyOnCompletion] = useState(false);
  const completionEnabled = isActive && isVisible;
  const setPaneRunCommand = useAppStore((state) => state.setPaneRunCommand);
  const session = useAppStore(selectSessionByPty(ptyId, isVisible));
  const paneRuntime = useAppStore(selectPaneRuntimeByPty(ptyId, isVisible));
  const terminalFontSize = useAppStore((state) => state.config.terminalFontSize);
  const themePreset = useAppStore((state) => state.config.theme.preset);
  const themeWindowEffect = useAppStore((state) => state.config.theme.windowEffect);
  const completions = useTerminalCompletions(ptyId, projectPath, completionEnabled);
  const {
    items: completionItems,
    selectedIndex: completionIndex,
    menuOpen,
    ghostText,
    acceptItem,
    handleTab,
    selectNext,
    selectPrevious,
    closeMenu,
    setSelectedIndex,
  } = completions;
  const resolvedTheme = useMemo(
    () => resolveTheme({ preset: themePreset, windowEffect: themeWindowEffect }),
    [themePreset, themeWindowEffect],
  );
  const paneStatus = paneRuntime?.status ?? status;

  const focusTerminal = useCallback(() => {
    getCachedTerminal(ptyId)?.term.focus();
  }, [ptyId]);

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

  const clearDragState = useCallback(() => {
    setDragKind(null);
    setTabDropZone(null);
  }, []);

  const handleDragMove = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();

    if (isTabDrag(event)) {
      const rect = event.currentTarget.getBoundingClientRect();
      setDragKind('tab');
      setTabDropZone(getDropZone(rect, event.clientX, event.clientY));
      return;
    }

    setDragKind('file');
    setTabDropZone(null);
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
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
        mirrorTerminalInput(ptyId, filePath);
        void invoke('write_pty', { ptyId, data: filePath });
        focusTerminal();
      }
    },
    [clearDragState, dragKind, focusTerminal, onTabDrop, paneId, ptyId],
  );

  const handleCopy = useCallback(() => {
    const selection = getCachedTerminal(ptyId)?.term.getSelection();
    if (selection) {
      void writeText(selection);
    }
    focusTerminal();
  }, [focusTerminal, ptyId]);

  const handlePaste = useCallback(() => {
    void readText().then((text) => {
      if (text) {
        mirrorTerminalInput(ptyId, text);
        void invoke('write_pty', { ptyId, data: text });
      }
      focusTerminal();
    });
  }, [focusTerminal, ptyId]);

  const handleClearScreen = useCallback(() => {
    getCachedTerminal(ptyId)?.term.clear();
    focusTerminal();
  }, [focusTerminal, ptyId]);

  const handleRunCommand = useCallback(async () => {
    const currentCommand = runCommand?.trim();
    if (!currentCommand) {
      const nextCommand = await showPrompt('设置运行命令', '输入要执行的命令', session?.lastCommand ?? '');
      if (nextCommand === null || !paneId) {
        focusTerminal();
        return;
      }

      const updated = nextCommand.trim();
      if (!updated) {
        focusTerminal();
        return;
      }

      setPaneRunCommand(tabId, paneId, updated);
      const suffix = updated.endsWith('\n') || updated.endsWith('\r') ? '' : '\r';
      mirrorTerminalInput(ptyId, `${updated}${suffix}`);
      await invoke('write_pty', { ptyId, data: `${updated}${suffix}` });
      focusTerminal();
      return;
    }

    const suffix = currentCommand.endsWith('\n') || currentCommand.endsWith('\r') ? '' : '\r';
    mirrorTerminalInput(ptyId, `${currentCommand}${suffix}`);
    await invoke('write_pty', { ptyId, data: `${currentCommand}${suffix}` });
    focusTerminal();
  }, [focusTerminal, paneId, ptyId, runCommand, session?.lastCommand, setPaneRunCommand, tabId]);

  const handleEditRunCommand = useCallback(async () => {
    if (!paneId) return;
    const nextCommand = await showPrompt('编辑运行命令', '输入要执行的命令', runCommand ?? '');
    if (nextCommand === null) {
      return;
    }

    const updated = nextCommand.trim();
    if (!updated) {
      setPaneRunCommand(tabId, paneId, undefined);
      return;
    }

    setPaneRunCommand(tabId, paneId, updated);
  }, [paneId, runCommand, setPaneRunCommand, tabId]);

  const handleViewRunCommand = useCallback(async () => {
    if (!runCommand) return;
    await showPrompt('查看运行命令', '仅查看，不会自动执行', runCommand, {
      hint: '这是只读内容，不会自动执行。',
      confirmLabel: '关闭',
      readOnly: true,
    });
  }, [runCommand]);

  const handleDeleteRunCommand = useCallback(() => {
    if (!paneId) return;
    setPaneRunCommand(tabId, paneId, undefined);
  }, [paneId, setPaneRunCommand, tabId]);

  const openTerminalContextMenu = useCallback(
    async (clientX: number, clientY: number) => {
      const isWindowMaximized = await appWindow.isMaximized().catch(() => false);
      const hasSelection = Boolean(getCachedTerminal(ptyId)?.term.getSelection());
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
      ptyId,
      status,
    ],
  );

  const openTerminalContextMenuRef = useRef(openTerminalContextMenu);
  useEffect(() => {
    openTerminalContextMenuRef.current = openTerminalContextMenu;
  }, [openTerminalContextMenu]);

  const handleViewportContextMenuRequest = useCallback((clientX: number, clientY: number) => {
    void openTerminalContextMenuRef.current(clientX, clientY);
  }, []);

  useEffect(() => {
    if (!completionEnabled) {
      return;
    }

    const unregister = registerTerminalKeyHandler(ptyId, (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) {
        return true;
      }

      if (event.key === 'Escape' && menuOpen) {
        event.preventDefault();
        closeMenu();
        return false;
      }

      if (event.key === 'Tab') {
        event.preventDefault();
        void handleTab(event.shiftKey).then((handled) => {
          if (!handled) {
            markTerminalInputUnsafe(ptyId);
            void invoke('write_pty', { ptyId, data: '\t' });
          }
        });
        return false;
      }

      if (event.key === 'ArrowDown' && menuOpen && completionItems.length > 1) {
        event.preventDefault();
        selectNext();
        return false;
      }

      if (event.key === 'ArrowUp' && menuOpen && completionItems.length > 1) {
        event.preventDefault();
        selectPrevious();
        return false;
      }

      return true;
    });

    return unregister;
  }, [closeMenu, completionEnabled, completionItems.length, handleTab, menuOpen, ptyId, selectNext, selectPrevious]);

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
    focusTerminal();
  }, [focusTerminal, onActivatePane, paneId]);

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
    [handleDeleteRunCommand, handleEditRunCommand, handleViewRunCommand, paneId, runCommand],
  );

  return (
    <TerminalChrome
      tabId={tabId}
      paneId={paneId}
      shellName={shellName}
      status={paneStatus}
      session={session}
      dragKind={dragKind}
      tabDropZone={tabDropZone}
      completionItems={completionItems}
      completionIndex={completionIndex}
      menuOpen={menuOpen}
      ghostText={ghostText}
      onContextMenu={handleContextMenu}
      onActivatePane={handleActivatePane}
      onRunCommand={() => {
        void handleRunCommand();
      }}
      onRunCommandContextMenu={handleRunCommandContextMenu}
      onSplitRight={paneId && onSplit ? () => onSplit(paneId, 'horizontal') : undefined}
      onSplitDown={paneId && onSplit ? () => onSplit(paneId, 'vertical') : undefined}
      onRestart={paneId && onRestart ? () => onRestart(paneId) : undefined}
      onClosePane={paneId && onClose ? () => onClose(paneId) : undefined}
      onAcceptCompletion={acceptItem}
      onSetCompletionIndex={setSelectedIndex}
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
      <TerminalViewport
        ptyId={ptyId}
        fontSize={terminalFontSize}
        terminalTheme={resolvedTheme.preset.terminal}
        isActive={isActive}
        isVisible={isVisible}
        onContextMenuRequest={handleViewportContextMenuRequest}
      />
    </TerminalChrome>
  );
});
