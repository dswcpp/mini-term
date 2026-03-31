import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { Allotment } from 'allotment';
import { invoke } from '@tauri-apps/api/core';
import { Effect, getCurrentWindow } from '@tauri-apps/api/window';
import { useAppStore, restoreLayout, flushLayoutToConfig } from './store';
import { TerminalArea } from './components/TerminalArea';
import { ProjectList } from './components/ProjectList';
import { FileTree } from './components/FileTree';
import { SettingsModal } from './components/SettingsModal';
import { useTauriEvent } from './hooks/useTauriEvent';
import { applyDocumentTheme, resolveTheme } from './theme';
import type { AppConfig, PaneStatus, PtyExitPayload, PtyStatusChangePayload } from './types';

const appWindow = getCurrentWindow();
const isWindows = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows');
const dragRegionStyle = { WebkitAppRegion: 'drag' } as CSSProperties;
const noDragRegionStyle = { WebkitAppRegion: 'no-drag' } as CSSProperties;

function TitleBarButton({
  title,
  danger = false,
  onClick,
  children,
}: {
  title: string;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      className={`titlebar-control ${danger ? 'titlebar-control-danger' : ''}`}
      onClick={onClick}
      style={noDragRegionStyle}
    >
      {children}
    </button>
  );
}

export function App() {
  const [configOpen, setConfigOpen] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [isFocused, setIsFocused] = useState(true);
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const config = useAppStore((s) => s.config);
  const setConfig = useAppStore((s) => s.setConfig);
  const updatePaneStatusByPty = useAppStore((s) => s.updatePaneStatusByPty);
  const activeProjectName = config.projects.find((project) => project.id === activeProjectId)?.name ?? 'Workspace';
  const resolvedTheme = resolveTheme(config.theme);

  useEffect(() => {
    invoke<AppConfig>('load_config').then((cfg) => {
      setConfig(cfg);
      if (cfg.uiFontSize) {
        document.documentElement.style.fontSize = `${cfg.uiFontSize}px`;
      }

      const { projectStates } = useAppStore.getState();
      const nextStates = new Map(projectStates);
      for (const project of cfg.projects) {
        if (!nextStates.has(project.id)) {
          nextStates.set(project.id, { id: project.id, tabs: [], activeTabId: '' });
        }
      }

      useAppStore.setState({
        projectStates: nextStates,
        activeProjectId: cfg.projects[0]?.id ?? null,
      });

      Promise.all(
        cfg.projects
          .filter((project) => project.savedLayout && project.savedLayout.tabs.length > 0)
          .map((project) => restoreLayout(project.id, project.savedLayout!, project.path, cfg))
      ).catch(console.error);
    });
  }, [setConfig]);

  useTauriEvent<PtyStatusChangePayload>(
    'pty-status-change',
    useCallback((payload) => {
      updatePaneStatusByPty(payload.ptyId, payload.status as PaneStatus);
    }, [updatePaneStatusByPty])
  );

  useTauriEvent<PtyExitPayload>(
    'pty-exit',
    useCallback((payload) => {
      if (payload.exitCode !== 0) {
        updatePaneStatusByPty(payload.ptyId, 'error');
      }
    }, [updatePaneStatusByPty])
  );

  useEffect(() => {
    const handleBeforeUnload = () => {
      const { activeProjectId: currentProjectId } = useAppStore.getState();
      if (currentProjectId) {
        flushLayoutToConfig(currentProjectId);
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  const prevProjectRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevProjectRef.current && prevProjectRef.current !== activeProjectId) {
      flushLayoutToConfig(prevProjectRef.current);
    }
    prevProjectRef.current = activeProjectId;
  }, [activeProjectId]);

  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const saveLayoutSizes = useCallback((sizes: number[]) => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const currentConfig = useAppStore.getState().config;
      const nextConfig = { ...currentConfig, layoutSizes: sizes };
      setConfig(nextConfig);
      void invoke('save_config', { config: nextConfig });
    }, 500);
  }, [setConfig]);

  useEffect(() => {
    let disposed = false;
    let unlistenResize: (() => void) | undefined;
    let unlistenFocus: (() => void) | undefined;

    const syncMaximizedState = async () => {
      const maximized = await appWindow.isMaximized();
      if (!disposed) {
        setIsMaximized(maximized);
      }
    };

    const syncFocusedState = async () => {
      const focused = await appWindow.isFocused();
      if (!disposed) {
        setIsFocused(focused);
      }
    };

    void syncMaximizedState();
    void syncFocusedState();

    appWindow.onResized(() => {
      void syncMaximizedState();
    }).then((fn) => {
      if (disposed) {
        fn();
      } else {
        unlistenResize = fn;
      }
    }).catch(console.error);

    appWindow.onFocusChanged(({ payload }) => {
      if (!disposed) {
        setIsFocused(payload);
      }
    }).then((fn) => {
      if (disposed) {
        fn();
      } else {
        unlistenFocus = fn;
      }
    }).catch(console.error);

    return () => {
      disposed = true;
      unlistenResize?.();
      unlistenFocus?.();
    };
  }, []);

  useEffect(() => {
    applyDocumentTheme(resolvedTheme);
  }, [config.theme.preset, config.theme.windowEffect]);

  useEffect(() => {
    if (!isWindows) {
      return;
    }

    const applyWindowMaterial = async () => {
      const effectMap = {
        mica: Effect.Mica,
        acrylic: Effect.Acrylic,
        blur: Effect.Blur,
      } as const;

      if (resolvedTheme.windowEffect === 'none') {
        await appWindow.clearEffects();
        await appWindow.setShadow(true);
        return;
      }

      const effectCandidates: Effect[][] =
        resolvedTheme.windowEffect === 'auto'
          ? [
              [effectMap[resolvedTheme.preset.windowEffect]],
              [Effect.Mica],
              [Effect.Acrylic],
              [Effect.Blur],
            ]
          : [[effectMap[resolvedTheme.windowEffect]]];

      for (const effects of effectCandidates) {
        try {
          await appWindow.setEffects({
            effects,
            color: effects[0] === Effect.Acrylic ? [24, 22, 20, 180] : undefined,
          });
          await appWindow.setShadow(true);
          return;
        } catch {
          // Try the next effect supported by the current Windows build.
        }
      }
    };

    void applyWindowMaterial();
  }, [config.theme.preset, config.theme.windowEffect]);

  const handleWindowMinimize = useCallback(() => {
    void appWindow.minimize();
  }, []);

  const handleWindowToggleMaximize = useCallback(() => {
    void appWindow.toggleMaximize()
      .then(async () => {
        setIsMaximized(await appWindow.isMaximized());
      })
      .catch(console.error);
  }, []);

  const handleWindowClose = useCallback(() => {
    void appWindow.close();
  }, []);

  const handleTitleBarDoubleClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('.no-drag-region')) {
      return;
    }

    void appWindow.toggleMaximize()
      .then(async () => {
        setIsMaximized(await appWindow.isMaximized());
      })
      .catch(console.error);
  }, []);

  const handleTitleBarMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!isWindows || event.button !== 0) {
      return;
    }

    const target = event.target as HTMLElement;
    if (target.closest('.no-drag-region')) {
      return;
    }

    void appWindow.startDragging().catch(() => {
      // Keep the declarative drag region as the primary path.
    });
  }, []);

  return (
    <div
      className={[
        'app-shell flex flex-col h-full',
        isMaximized ? 'app-shell-maximized' : '',
        isFocused ? 'app-shell-focused' : 'app-shell-unfocused',
      ].filter(Boolean).join(' ')}
    >
      <div
        className="app-titlebar flex items-center gap-4 px-4 py-1.5 border-b border-[var(--border-subtle)] text-xs select-none"
        onDoubleClick={handleTitleBarDoubleClick}
        onMouseDown={handleTitleBarMouseDown}
        style={dragRegionStyle}
      >
        <div className="flex items-center gap-4 min-w-0" data-tauri-drag-region style={dragRegionStyle}>
          <span
            className="font-semibold tracking-wide text-[var(--accent)] text-sm"
            data-tauri-drag-region
            style={{ ...dragRegionStyle, fontFamily: "'DM Sans', sans-serif", letterSpacing: '0.05em' }}
          >
            MINI-TERM
          </span>
          <div
            className="titlebar-divider w-px h-3.5 bg-[var(--border-default)]"
            data-tauri-drag-region
            style={dragRegionStyle}
          />
          <span
            className="app-titlemeta truncate text-[10px] uppercase tracking-[0.18em]"
            data-tauri-drag-region
            style={dragRegionStyle}
          >
            {activeProjectName}
          </span>
        </div>

        <div className="no-drag-region flex items-center gap-3 text-[var(--text-muted)]" style={noDragRegionStyle}>
          <button
            type="button"
            className="cursor-pointer bg-transparent border-0 p-0 text-inherit hover:text-[var(--text-primary)] transition-colors duration-150"
            onClick={() => setConfigOpen(true)}
            style={noDragRegionStyle}
          >
            Settings
          </button>
        </div>

        <div className="flex-1 self-stretch" data-tauri-drag-region style={dragRegionStyle} />

        {isWindows && (
          <div className="no-drag-region flex items-stretch self-stretch -mr-4" style={noDragRegionStyle}>
            <TitleBarButton title="Minimize" onClick={handleWindowMinimize}>
              <svg viewBox="0 0 10 10" className="titlebar-icon" aria-hidden="true">
                <path d="M1 5h8" />
              </svg>
            </TitleBarButton>

            <TitleBarButton
              title={isMaximized ? 'Restore' : 'Maximize'}
              onClick={handleWindowToggleMaximize}
            >
              {isMaximized ? (
                <svg viewBox="0 0 10 10" className="titlebar-icon" aria-hidden="true">
                  <path d="M2 3h5v5H2z" />
                  <path d="M3 1h5v5" />
                </svg>
              ) : (
                <svg viewBox="0 0 10 10" className="titlebar-icon" aria-hidden="true">
                  <path d="M2 2h6v6H2z" />
                </svg>
              )}
            </TitleBarButton>

            <TitleBarButton title="Close" danger onClick={handleWindowClose}>
              <svg viewBox="0 0 10 10" className="titlebar-icon" aria-hidden="true">
                <path d="M2 2l6 6" />
                <path d="M8 2L2 8" />
              </svg>
            </TitleBarButton>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-hidden">
        <Allotment
          defaultSizes={config.layoutSizes ?? [200, 280, 1000]}
          onChange={saveLayoutSizes}
        >
          <Allotment.Pane minSize={140} maxSize={350}>
            <ProjectList />
          </Allotment.Pane>

          <Allotment.Pane minSize={180}>
            <FileTree />
          </Allotment.Pane>

          <Allotment.Pane>
            <div className="relative h-full">
              {config.projects.map((project) => (
                <div
                  key={project.id}
                  className="absolute inset-0"
                  style={{ display: project.id === activeProjectId ? 'block' : 'none' }}
                >
                  <TerminalArea
                    projectId={project.id}
                    projectPath={project.path}
                    onOpenSettings={() => setConfigOpen(true)}
                  />
                </div>
              ))}

              {config.projects.length === 0 && (
                <div className="h-full bg-[var(--bg-terminal)] flex items-center justify-center text-[var(--text-muted)] text-sm">
                  Add a project from the left panel first.
                </div>
              )}
            </div>
          </Allotment.Pane>
        </Allotment>
      </div>

      <SettingsModal open={configOpen} onClose={() => setConfigOpen(false)} />
    </div>
  );
}
