import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore, genId } from '../store';
import { TerminalInstance } from './TerminalInstance';
import { StatusDot } from './StatusDot';
import { MarkerList } from './MarkerList';
import { showContextMenu, type MenuEntry } from '../utils/contextMenu';
import { showAlert, showConfirm, showPrompt } from '../utils/prompt';
import { disposeTerminal } from '../utils/terminalCache';
import { getProjectEnvs } from '../utils/projectEnv';
import { formatError } from '../utils/appConfigPersistence';
import { createTerminalPty, killPty, killPtyQuietly, resolveTerminalShell, setPtyEncoding } from '../utils/terminalApi';
import {
  TERMINAL_LAYOUT_PRESETS,
  type TerminalLayoutPreset,
} from '../utils/terminalLayoutPresets';
import { normalizeTerminalEncoding, TERMINAL_ENCODING_OPTIONS } from '../utils/terminalEncoding';
import { MOD_LABEL } from '../utils/platform';
import { useT } from '../i18n';
import type { SplitNode, PaneState, ShellConfig, AiMarker, TerminalEncoding } from '../types';

const EMPTY_MARKERS: AiMarker[] = [];
const hydratingPaneIds = new Set<string>();
type LayoutActionId = TerminalLayoutPreset | 'split-horizontal' | 'split-vertical';

function findPaneById(node: SplitNode, paneId: string): PaneState | null {
  if (node.type === 'leaf') {
    return node.panes.find((pane) => pane.id === paneId) ?? null;
  }
  for (const child of node.children) {
    const found = findPaneById(child, paneId);
    if (found) return found;
  }
  return null;
}

interface Props {
  projectId: string;
  node: SplitNode & { type: 'leaf' };
  projectPath: string;
  onSplit: (paneId: string, direction: 'horizontal' | 'vertical') => void | Promise<void>;
  onLayoutPreset: (paneId: string, preset: TerminalLayoutPreset) => void | Promise<void>;
  onClosePane: () => void;
  onUpdateNode: (updated: SplitNode) => void;
}

function LayoutPreviewIcon({ preset }: { preset: TerminalLayoutPreset }) {
  const cellCount = preset === 'quad' ? 4 : 2;
  return (
    <span className={`layout-preview layout-preview--${preset}`} aria-hidden="true">
      {Array.from({ length: cellCount }, (_, index) => <span key={index} />)}
    </span>
  );
}

export function PaneGroup({ projectId, node, projectPath, onSplit, onLayoutPreset, onClosePane, onUpdateNode }: Props) {
  const t = useT();
  const config = useAppStore((s) => s.config);
  const setPanePty = useAppStore((s) => s.setPanePty);
  const updatePaneStatusByPaneId = useAppStore((s) => s.updatePaneStatusByPaneId);
  const [headerHover, setHeaderHover] = useState(false);
  const [hasPaneFocus, setHasPaneFocus] = useState(false);
  const [pendingLayoutAction, setPendingLayoutAction] = useState<LayoutActionId | null>(null);

  const activePane = node.panes.find((p) => p.id === node.activePaneId) ?? node.panes[0];

  useEffect(() => {
    if (!activePane || activePane.ptyId !== undefined || activePane.status === 'error') return;
    if (hydratingPaneIds.has(activePane.id)) return;

    const shell = resolveTerminalShell(config, undefined, activePane.shellName);
    if (!shell) {
      updatePaneStatusByPaneId(projectId, activePane.id, 'error');
      return;
    }

    hydratingPaneIds.add(activePane.id);
    createTerminalPty({
      shell,
      cwd: projectPath,
      envs: getProjectEnvs(projectId),
      encoding: normalizeTerminalEncoding(activePane.terminalEncoding ?? config.terminalEncoding),
    })
      .then((ptyId) => {
        const ps = useAppStore.getState().projectStates.get(projectId);
        const pane = ps?.tabs
          .map((tab) => findPaneById(tab.splitLayout, activePane.id))
          .find(Boolean);
        if (pane && pane.ptyId === undefined) {
          setPanePty(projectId, activePane.id, ptyId);
        } else {
          killPtyQuietly(ptyId);
        }
      })
      .catch(() => updatePaneStatusByPaneId(projectId, activePane.id, 'error'))
      .finally(() => {
        hydratingPaneIds.delete(activePane.id);
      });
  }, [
    activePane?.id,
    activePane?.ptyId,
    activePane?.shellName,
    activePane?.status,
    activePane?.terminalEncoding,
    config.availableShells,
    config.defaultShell,
    config.terminalEncoding,
    projectId,
    projectPath,
    setPanePty,
    updatePaneStatusByPaneId,
  ]);

  const handleNewTab = useCallback(async (selectedShell?: ShellConfig) => {
    const shell = resolveTerminalShell(config, selectedShell);
    if (!shell) {
      await showAlert(t('paneGroup.startFailed'), t('paneGroup.noShellConfigured'));
      return;
    }

    let ptyId: number;
    const encoding = normalizeTerminalEncoding(config.terminalEncoding);
    try {
      ptyId = await createTerminalPty({
        shell,
        cwd: projectPath,
        envs: getProjectEnvs(projectId),
        encoding,
      });
    } catch (error) {
      await showAlert(t('paneGroup.startFailed'), formatError(error));
      return;
    }

    const newPane: PaneState = {
      id: genId(),
      shellName: shell.name,
      terminalEncoding: encoding,
      status: 'idle',
      ptyId,
    };

    onUpdateNode({
      ...node,
      panes: [...node.panes, newPane],
      activePaneId: newPane.id,
    });
  }, [config, projectId, projectPath, node, onUpdateNode, t]);

  const handleNewTabClick = useCallback((e: React.MouseEvent) => {
    if (config.availableShells.length <= 1) {
      handleNewTab();
      return;
    }
    showContextMenu(
      e.clientX,
      e.clientY,
      config.availableShells.map((shell) => ({
        label: shell.name,
        onClick: () => handleNewTab(shell),
      })),
    );
  }, [config.availableShells, handleNewTab]);

  const handleCloseTab = useCallback(async (paneId: string) => {
    const pane = node.panes.find((p) => p.id === paneId);
    if (!pane) return;

    const label = pane.customTitle || pane.shellName;
    const hasAi = pane.status === 'ai-working' || pane.status === 'ai-idle';
    const title = hasAi ? t('paneGroup.closeAiTitle') : t('paneGroup.closeTerminalTitle');
    const message = hasAi
      ? t('paneGroup.closeTabAiMessage', { label })
      : t('paneGroup.closeTabMessage', { label });

    const confirmed = await showConfirm(title, message);
    if (!confirmed) return;

    if (pane.ptyId !== undefined) {
      try {
        await killPty(pane.ptyId);
      } catch {
        // The PTY may already have exited; UI cleanup should still proceed.
      }
      disposeTerminal(pane.ptyId);
      useAppStore.getState().clearMarkersForPty(pane.ptyId);
    }

    const remaining = node.panes.filter((p) => p.id !== paneId);
    if (remaining.length === 0) {
      onClosePane();
      return;
    }

    const newActive = node.activePaneId === paneId
      ? (remaining[remaining.length - 1]?.id ?? remaining[0].id)
      : node.activePaneId;

    onUpdateNode({
      ...node,
      panes: remaining,
      activePaneId: newActive,
    });
  }, [node, onClosePane, onUpdateNode]);

  const updatePaneNickname = useCallback((paneId: string, customTitle?: string) => {
    onUpdateNode({
      ...node,
      panes: node.panes.map((p) =>
        p.id === paneId ? { ...p, customTitle } : p
      ),
    });
  }, [node, onUpdateNode]);

  const handleRenamePane = useCallback(async (paneId: string) => {
    const pane = node.panes.find((p) => p.id === paneId);
    if (!pane) return;
    const newTitle = await showPrompt(
      t('paneGroup.renameTerminal'),
      t('paneGroup.renamePlaceholder'),
      pane.customTitle || pane.shellName,
    );
    if (newTitle === null) return;
    updatePaneNickname(paneId, newTitle.trim() || undefined);
  }, [node.panes, t, updatePaneNickname]);

  const handleClearNickname = useCallback((paneId: string) => {
    updatePaneNickname(paneId, undefined);
  }, [updatePaneNickname]);

  const updatePaneEncoding = useCallback(async (pane: PaneState, encoding: TerminalEncoding) => {
    const normalized = normalizeTerminalEncoding(encoding);
    if (pane.ptyId !== undefined) {
      try {
        await setPtyEncoding(pane.ptyId, normalized);
      } catch (error) {
        await showAlert(t('paneGroup.encodingUpdateFailed'), formatError(error));
        return;
      }
    }
    onUpdateNode({
      ...node,
      panes: node.panes.map((p) =>
        p.id === pane.id ? { ...p, terminalEncoding: normalized } : p
      ),
    });
  }, [node, onUpdateNode, t]);

  const handleSetActive = useCallback((paneId: string) => {
    if (paneId !== node.activePaneId) {
      onUpdateNode({ ...node, activePaneId: paneId });
    }
  }, [node, onUpdateNode]);

  const handleClosePaneGroup = useCallback(async () => {
    const aiCount = node.panes.filter(
      (p) => p.status === 'ai-working' || p.status === 'ai-idle'
    ).length;
    const title = aiCount > 0 ? t('paneGroup.closeAiTitle') : t('paneGroup.closeTerminalTitle');
    const message = aiCount > 0
      ? t('paneGroup.closeGroupAiMessage', { count: aiCount })
      : t('paneGroup.closeGroupMessage');

    const confirmed = await showConfirm(title, message);
    if (!confirmed) return;

    for (const pane of node.panes) {
      if (pane.ptyId !== undefined) {
        try {
          await killPty(pane.ptyId);
        } catch {
          // Continue closing the remaining panes even if one PTY is already gone.
        }
        disposeTerminal(pane.ptyId);
        useAppStore.getState().clearMarkersForPty(pane.ptyId);
      }
    }
    onClosePane();
  }, [node.panes, onClosePane]);

  const [markerOpen, setMarkerOpen] = useState(false);
  const [markerAnchor, setMarkerAnchor] = useState<{ top: number; right: number } | null>(null);
  const markers = useAppStore(
    (s) => (activePane?.ptyId !== undefined && s.markersByPty.get(activePane.ptyId)) || EMPTY_MARKERS,
  );
  const markerBtnRef = useRef<HTMLButtonElement>(null);
  const markerPopoverRef = useRef<HTMLDivElement>(null);

  const openMarkerPopover = useCallback(() => {
    const rect = markerBtnRef.current?.getBoundingClientRect();
    if (!rect) return;
    setMarkerAnchor({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    setMarkerOpen(true);
  }, []);

  useEffect(() => {
    if (!markerOpen) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (markerPopoverRef.current?.contains(target)) return;
      if (markerBtnRef.current?.contains(target)) return;
      setMarkerOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [markerOpen]);

  useEffect(() => {
    setMarkerOpen(false);
  }, [activePane?.ptyId]);

  const handleRetryCreatePty = useCallback(() => {
    if (!activePane) return;
    updatePaneStatusByPaneId(projectId, activePane.id, 'idle');
  }, [activePane, projectId, updatePaneStatusByPaneId]);

  const runLayoutAction = useCallback((actionId: LayoutActionId, action: () => void | Promise<void>) => {
    if (pendingLayoutAction) return;
    setPendingLayoutAction(actionId);
    void Promise.resolve()
      .then(action)
      .catch(() => {})
      .finally(() => {
        setPendingLayoutAction((current) => (current === actionId ? null : current));
      });
  }, [pendingLayoutAction]);

  const runSplitAction = useCallback((pane: PaneState, direction: 'horizontal' | 'vertical') => {
    runLayoutAction(`split-${direction}`, () => onSplit(pane.id, direction));
  }, [onSplit, runLayoutAction]);

  const runPresetAction = useCallback((pane: PaneState, preset: TerminalLayoutPreset) => {
    runLayoutAction(preset, () => onLayoutPreset(pane.id, preset));
  }, [onLayoutPreset, runLayoutAction]);

  const buildEncodingMenu = useCallback((pane: PaneState): MenuEntry[] => {
    const currentEncoding = normalizeTerminalEncoding(pane.terminalEncoding ?? config.terminalEncoding);
    return [
      { header: t('paneGroup.encoding') },
      ...TERMINAL_ENCODING_OPTIONS.map((option) => ({
        icon: option.value === currentEncoding ? '✓' : '',
        label: option.label,
        onClick: () => {
          void updatePaneEncoding(pane, option.value);
        },
      })),
    ];
  }, [config.terminalEncoding, t, updatePaneEncoding]);

  const buildPaneActionsMenu = useCallback((pane: PaneState): MenuEntry[] => [
      {
        label: t('paneGroup.encoding'),
        description: TERMINAL_ENCODING_OPTIONS.find(
          (option) => option.value === normalizeTerminalEncoding(pane.terminalEncoding ?? config.terminalEncoding),
        )?.label,
        submenu: buildEncodingMenu(pane),
      },
      { separator: true },
      { header: t('paneGroup.splitActions') },
      {
        icon: '┃',
        label: t('paneGroup.splitRight'),
        disabled: pendingLayoutAction !== null,
        onClick: () => runSplitAction(pane, 'horizontal'),
      },
      {
        icon: '━',
        label: t('paneGroup.splitDown'),
        disabled: pendingLayoutAction !== null,
        onClick: () => runSplitAction(pane, 'vertical'),
      },
      { separator: true },
      { header: t('paneGroup.gridPresets') },
      ...TERMINAL_LAYOUT_PRESETS.map((definition) => ({
        label: t(definition.labelKey),
        preview: definition.preview,
        description: t('paneGroup.gridPresetDescription', { count: definition.requiredPaneCount }),
        disabled: pendingLayoutAction !== null,
        onClick: () => runPresetAction(pane, definition.preset),
      })),
    ], [buildEncodingMenu, config.terminalEncoding, pendingLayoutAction, runPresetAction, runSplitAction, t]);

  const showPaneActionsMenu = useCallback((x: number, y: number, pane: PaneState) => {
    showContextMenu(x, y, buildPaneActionsMenu(pane));
  }, [buildPaneActionsMenu]);

  const handleLayoutMenu = useCallback((e: React.MouseEvent) => {
    if (!activePane) return;
    showPaneActionsMenu(e.clientX, e.clientY, activePane);
  }, [activePane, showPaneActionsMenu]);

  if (!activePane) return null;

  return (
    <div
      className={`terminal-pane-frame w-full h-full flex flex-col ${hasPaneFocus ? 'is-focused' : ''}`}
      data-pty-id={activePane.ptyId}
      data-layout-pending={pendingLayoutAction ? 'true' : 'false'}
      onFocusCapture={() => setHasPaneFocus(true)}
      onBlurCapture={(e) => {
        const nextTarget = e.relatedTarget instanceof Node ? e.relatedTarget : null;
        if (!nextTarget || !e.currentTarget.contains(nextTarget)) setHasPaneFocus(false);
      }}
    >
      {/* Tab bar */}
      <div
        data-panel-header
        className="flex bg-[var(--bg-elevated)] border-b border-[var(--border-subtle)] text-[11px] overflow-x-auto select-none shrink-0"
        onMouseEnter={() => setHeaderHover(true)}
        onMouseLeave={() => setHeaderHover(false)}
      >
        {node.panes.map((pane) => {
          const isActive = pane.id === activePane.id;
          return (
            <div
              key={pane.id}
              data-pane-tab
              className={`flex items-center gap-1.5 px-3 py-[3px] cursor-pointer whitespace-nowrap transition-all duration-100 relative ${
                isActive
                  ? 'bg-[var(--bg-terminal)] text-[var(--text-primary)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--border-subtle)]'
              }`}
              onClick={() => handleSetActive(pane.id)}
              onDoubleClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                void handleRenamePane(pane.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                showContextMenu(e.clientX, e.clientY, [
                  { label: t('paneGroup.rename'), onClick: () => handleRenamePane(pane.id) },
                  ...(pane.customTitle
                    ? [{ label: t('paneGroup.clearNickname'), onClick: () => handleClearNickname(pane.id) }]
                    : []),
                  { separator: true },
                  ...buildPaneActionsMenu(pane),
                ]);
              }}
            >
              {isActive && (
                <span className="absolute bottom-0 left-2 right-2 h-[2px] rounded-full bg-[var(--accent)]" />
              )}
              <StatusDot status={pane.status} />
              <span className="font-medium">{pane.customTitle || pane.shellName}</span>
              <span
                className="ml-0.5 text-[var(--text-muted)] hover:text-[var(--color-error)] text-[12px] transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCloseTab(pane.id);
                }}
              >
                ✕
              </span>
            </div>
          );
        })}

        {/* "+" button */}
        <div
          className="px-2 py-[3px] text-[var(--text-muted)] cursor-pointer hover:text-[var(--accent)] transition-colors text-[12px]"
          onClick={handleNewTabClick}
        >
          +
        </div>

        {/* Right-aligned split/close controls (on hover) */}
        <div
          className="ml-auto flex items-center gap-0.5 px-2 text-[12px]"
        >
          {activePane.ptyId !== undefined && markers.length > 0 && (
            <button
              ref={markerBtnRef}
              type="button"
              className="mr-1 px-1.5 py-0.5 text-[11px] rounded text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--border-subtle)] flex items-center gap-1 transition-colors"
              onClick={() => (markerOpen ? setMarkerOpen(false) : openMarkerPopover())}
              title={t('paneGroup.markerTooltip', { mod: MOD_LABEL })}
            >
              <span>⚑</span>
              <span className="tabular-nums">{markers.length}</span>
            </button>
          )}
          <div
            className="pane-action-strip flex items-center gap-0.5 transition-opacity duration-150"
            style={{ opacity: headerHover ? 1 : 0.55 }}
          >
            <button
              type="button"
              className="pane-action-button"
              title={t('paneGroup.layoutPresets')}
              onClick={handleLayoutMenu}
              disabled={pendingLayoutAction !== null}
            >
              {pendingLayoutAction ? <span className="pane-action-spinner" aria-hidden="true" /> : <LayoutPreviewIcon preset="quad" />}
            </button>
            <button
              type="button"
              className="pane-action-button"
              title={t('paneGroup.splitRight')}
              onClick={() => runSplitAction(activePane, 'horizontal')}
              disabled={pendingLayoutAction !== null}
            >
              ┃
            </button>
            <button
              type="button"
              className="pane-action-button"
              title={t('paneGroup.splitDown')}
              onClick={() => runSplitAction(activePane, 'vertical')}
              disabled={pendingLayoutAction !== null}
            >
              ━
            </button>
            <button
              type="button"
              className="pane-action-button pane-action-button--danger"
              title={t('paneGroup.closePane')}
              onClick={handleClosePaneGroup}
              disabled={pendingLayoutAction !== null}
            >
              ✕
            </button>
          </div>
        </div>
      </div>

      {/* Active terminal */}
      <div
        className="flex-1 overflow-hidden relative"
        onContextMenu={(e) => {
          if (activePane.ptyId !== undefined) return;
          e.preventDefault();
          e.stopPropagation();
          showPaneActionsMenu(e.clientX, e.clientY, activePane);
        }}
      >
        <div className="absolute inset-0">
          {activePane.ptyId !== undefined ? (
            <TerminalInstance
              ptyId={activePane.ptyId}
              contextMenuExtraItems={buildPaneActionsMenu(activePane)}
            />
          ) : activePane.status === 'error' ? (
            <div className="h-full flex flex-col items-center justify-center gap-2 text-[var(--text-muted)] text-sm">
              <div>{t('paneGroup.startFailed')}</div>
              <button
                type="button"
                className="px-3 py-1.5 rounded-[var(--radius-sm)] border border-[var(--border-default)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors"
                onClick={handleRetryCreatePty}
              >
                {t('paneGroup.retry')}
              </button>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center text-[var(--text-muted)] text-sm">
              {t('paneGroup.starting')}
            </div>
          )}
        </div>
      </div>

      {activePane.ptyId !== undefined && markerOpen && markerAnchor && createPortal(
        <div
          ref={markerPopoverRef}
          className="fixed z-50 rounded-md border shadow-lg"
          style={{
            top: markerAnchor.top,
            right: markerAnchor.right,
            background: 'var(--bg-elevated)',
            borderColor: 'var(--border-subtle)',
          }}
        >
          <MarkerList
            ptyId={activePane.ptyId}
            markers={markers}
            onClose={() => setMarkerOpen(false)}
          />
        </div>,
        document.body,
      )}
    </div>
  );
}
