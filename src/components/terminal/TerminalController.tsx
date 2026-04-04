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
import { getCurrentWindow, UserAttentionType } from '@tauri-apps/api/window';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import {
  runManagedTerminalCommand,
  writeManagedTerminalInput,
} from '../../runtime/terminalOrchestrator';
import { isTauriRuntime } from '../../runtime/tauriRuntime';
import { useAppStore, selectPaneRuntimeBySessionId, selectSessionById } from '../../store';
import { useTerminalCompletions } from '../../hooks/useTerminalCompletions';
import { resolveTheme } from '../../theme';
import type { PaneStatus, RunProfile } from '../../types';
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
import { RunProfileInspector } from './RunProfileInspector';
import { TerminalViewport } from './TerminalViewport';

const appWindow = isTauriRuntime() ? getCurrentWindow() : null;

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
  workspaceId: string;
  tabId: string;
  projectPath: string;
  sessionId: string;
  ptyId: number;
  paneId?: string;
  shellName?: string;
  runCommand?: string;
  runProfile?: RunProfile;
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
  workspaceId,
  tabId,
  projectPath,
  sessionId,
  ptyId,
  paneId,
  shellName,
  runCommand,
  runProfile,
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
  const openRunProfileInspector = useAppStore((state) => state.openRunProfileInspector);
  const closeRunProfileInspector = useAppStore((state) => state.closeRunProfileInspector);
  const runProfileInspectorPaneId = useAppStore((state) => state.terminalUi.runProfileInspectorPaneId);
  const session = useAppStore(selectSessionById(sessionId, isVisible));
  const paneRuntime = useAppStore(selectPaneRuntimeBySessionId(sessionId, isVisible));
  const terminalFontSize = useAppStore((state) => state.config.terminalFontSize);
  const themePreset = useAppStore((state) => state.config.theme.preset);
  const themeWindowEffect = useAppStore((state) => state.config.theme.windowEffect);
  const completions = useTerminalCompletions(sessionId, projectPath, completionEnabled);
  const {
    items: completionItems,
    selectedIndex: completionIndex,
    menuOpen,
    ghostText,
    acceptItem,
    acceptSelected,
    handleTab,
    canHandleTab,
    closeMenu,
    setSelectedIndex,
  } = completions;
  const resolvedTheme = useMemo(
    () => resolveTheme({ preset: themePreset, windowEffect: themeWindowEffect }),
    [themePreset, themeWindowEffect],
  );
  const paneStatus = paneRuntime?.status ?? status;
  const effectiveRunProfile = useMemo(
    () => ({
      ...session?.runProfile,
      ...runProfile,
      savedCommand: runProfile?.savedCommand ?? session?.runProfile?.savedCommand ?? runCommand?.trim(),
    }),
    [runCommand, runProfile, session?.runProfile],
  );
  const savedRunCommand = effectiveRunProfile.savedCommand;
  const isRunProfileInspectorOpen = Boolean(paneId && runProfileInspectorPaneId === paneId);

  const focusTerminal = useCallback(() => {
    getCachedTerminal(sessionId)?.term.focus();
  }, [sessionId]);

  useEffect(() => {
    if (
      appWindow &&
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
        mirrorTerminalInput(sessionId, filePath);
        void writeManagedTerminalInput(sessionId, filePath);
        focusTerminal();
      }
    },
    [clearDragState, dragKind, focusTerminal, onTabDrop, paneId, sessionId],
  );

  const handleCopy = useCallback(() => {
    const selection = getCachedTerminal(sessionId)?.term.getSelection();
    if (selection) {
      void writeText(selection);
    }
    focusTerminal();
  }, [focusTerminal, sessionId]);

  const handlePaste = useCallback(() => {
    void readText().then((text) => {
      if (text) {
        mirrorTerminalInput(sessionId, text);
        void writeManagedTerminalInput(sessionId, text);
      }
      focusTerminal();
    });
  }, [focusTerminal, sessionId]);

  const handleClearScreen = useCallback(() => {
    getCachedTerminal(sessionId)?.term.clear();
    focusTerminal();
  }, [focusTerminal, sessionId]);

  const handleRunCommand = useCallback(async () => {
    const currentCommand = savedRunCommand?.trim();
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
      mirrorTerminalInput(sessionId, updated.endsWith('\n') || updated.endsWith('\r') ? updated : `${updated}\r`);
      await runManagedTerminalCommand(sessionId, updated);
      focusTerminal();
      return;
    }

    mirrorTerminalInput(
      sessionId,
      currentCommand.endsWith('\n') || currentCommand.endsWith('\r') ? currentCommand : `${currentCommand}\r`,
    );
    await runManagedTerminalCommand(sessionId, currentCommand);
    focusTerminal();
  }, [focusTerminal, paneId, savedRunCommand, session?.lastCommand, sessionId, setPaneRunCommand, tabId]);

  const handleEditRunCommand = useCallback(async () => {
    if (!paneId) return;
    const nextCommand = await showPrompt('编辑运行命令', '输入要执行的命令', savedRunCommand ?? '');
    if (nextCommand === null) {
      return;
    }

    const updated = nextCommand.trim();
    if (!updated) {
      setPaneRunCommand(tabId, paneId, undefined);
      return;
    }

    setPaneRunCommand(tabId, paneId, updated);
  }, [paneId, savedRunCommand, setPaneRunCommand, tabId]);

  const handleViewRunCommand = useCallback(async () => {
    if (!savedRunCommand || !paneId) return;
    openRunProfileInspector(paneId);
  }, [openRunProfileInspector, paneId, savedRunCommand]);

  const handleDeleteRunCommand = useCallback(() => {
    if (!paneId) return;
    setPaneRunCommand(tabId, paneId, undefined);
    closeRunProfileInspector();
  }, [closeRunProfileInspector, paneId, setPaneRunCommand, tabId]);

  const openTerminalContextMenu = useCallback(
    async (clientX: number, clientY: number) => {
      const isWindowMaximized = appWindow ? await appWindow.isMaximized().catch(() => false) : false;
      const hasSelection = Boolean(getCachedTerminal(sessionId)?.term.getSelection());
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
            if (appWindow) {
              void appWindow.minimize();
            }
          },
          onWindowToggleMaximize: () => {
            if (appWindow) {
              void appWindow.toggleMaximize();
            }
          },
          onWindowClose: () => {
            if (appWindow) {
              void appWindow.close();
            }
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
      sessionId,
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

    const unregister = registerTerminalKeyHandler(sessionId, (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) {
        return true;
      }

      if (event.key === 'Escape' && menuOpen) {
        event.preventDefault();
        closeMenu();
        return false;
      }

      if (event.key === 'Enter' && menuOpen) {
        event.preventDefault();
        void acceptSelected();
        return false;
      }

      if (event.key === 'Tab') {
        if (!canHandleTab(event.shiftKey)) {
          markTerminalInputUnsafe(sessionId);
          return true;
        }

        event.preventDefault();
        void handleTab(event.shiftKey);
        return false;
      }

      return true;
    });

    return unregister;
  }, [acceptSelected, canHandleTab, closeMenu, completionEnabled, handleTab, menuOpen, sessionId]);

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
          disabled: !savedRunCommand,
          onClick: () => {
            void handleViewRunCommand();
          },
        },
        {
          label: '删除',
          danger: true,
          disabled: !savedRunCommand,
          onClick: () => handleDeleteRunCommand(),
        },
      ]);
    },
    [handleDeleteRunCommand, handleEditRunCommand, handleViewRunCommand, paneId, savedRunCommand],
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
      <>
        {isRunProfileInspectorOpen && paneId && (
          <RunProfileInspector
            runProfile={effectiveRunProfile}
            fallbackCommand={savedRunCommand}
            onClose={closeRunProfileInspector}
          />
        )}
        <TerminalViewport
          workspaceId={workspaceId}
          tabId={tabId}
          sessionId={sessionId}
          paneId={paneId}
          ptyId={ptyId}
          fontSize={terminalFontSize}
          terminalTheme={resolvedTheme.preset.terminal}
          isActive={isActive}
          isVisible={isVisible}
          onContextMenuRequest={handleViewportContextMenuRequest}
        />
      </>
    </TerminalChrome>
  );
});
