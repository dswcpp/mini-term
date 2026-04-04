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
import { getVersion } from '@tauri-apps/api/app';
import { Effect, getCurrentWindow } from '@tauri-apps/api/window';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  useAppStore,
  buildWorkspaceStatePatch,
  restoreLayout,
  flushLayoutToConfig,
  initExpandedDirs,
  flushExpandedDirsToConfig,
  flushCompletionUsageToConfig,
  selectWorkspaces,
  selectThemeConfig,
} from './store';
import { TerminalArea } from './components/TerminalArea';
import { WorkspaceSidebar } from './components/WorkspaceSidebar';
import { FileTree } from './components/FileTree';
import { GitHistory } from './components/GitHistory';
import { WorkspaceDialogHost } from './components/WorkspaceDialogHost';
import { useSessionRuntimeBridge } from './hooks/useSessionRuntimeBridge';
import { applyDocumentTheme, resolveTheme } from './theme';
import { showConfirm } from './utils/messageBox';
import { checkForUpdate, type ReleaseInfo } from './utils/updateChecker';
import { getWorkspacePrimaryRootPath } from './utils/workspace';
import type { AppConfig } from './types';

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
  const [configLoaded, setConfigLoaded] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [isFocused, setIsFocused] = useState(true);
  const [currentVersion, setCurrentVersion] = useState('');
  const [updateInfo, setUpdateInfo] = useState<ReleaseInfo | null>(null);

  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId);
  const workspaces = useAppStore(selectWorkspaces);
  const themeConfig = useAppStore(selectThemeConfig);
  const layoutSizes = useAppStore((state) => state.config.layoutSizes);
  const middleColumnSizes = useAppStore((state) => state.config.middleColumnSizes);
  const setConfig = useAppStore((state) => state.setConfig);
  const openSettings = useAppStore((state) => state.openSettings);

  const activeWorkspaceName =
    workspaces.find((workspace) => workspace.id === activeWorkspaceId)?.name ?? 'Workspace';
  const resolvedTheme = resolveTheme(themeConfig);

  useSessionRuntimeBridge();

  useEffect(() => {
    void invoke<AppConfig>('load_config').then((loadedConfig) => {
      setConfig(loadedConfig);

      if (loadedConfig.uiFontSize) {
        document.documentElement.style.fontSize = `${loadedConfig.uiFontSize}px`;
      }

      const { workspaceStates } = useAppStore.getState();
      const nextStates = new Map(workspaceStates);
      for (const workspace of loadedConfig.workspaces) {
        if (!nextStates.has(workspace.id)) {
          nextStates.set(workspace.id, { id: workspace.id, tabs: [], activeTabId: '' });
        }
        for (const root of workspace.roots) {
          initExpandedDirs(workspace.id, root.id, workspace.expandedDirsByRoot?.[root.id] ?? []);
        }
      }

      useAppStore.setState({
        activeWorkspaceId: loadedConfig.lastWorkspaceId ?? loadedConfig.workspaces[0]?.id ?? null,
        ...buildWorkspaceStatePatch(nextStates),
      });

      void Promise.all(
        loadedConfig.workspaces
          .filter((workspace) => workspace.savedLayout && workspace.savedLayout.tabs.length > 0)
          .map((workspace) => {
            const primaryRootPath = getWorkspacePrimaryRootPath(workspace);
            if (!primaryRootPath) {
              return Promise.resolve();
            }
            return restoreLayout(workspace.id, workspace.savedLayout!, primaryRootPath, loadedConfig);
          }),
      ).catch(console.error);

      setConfigLoaded(true);
    });
  }, [setConfig]);

  useEffect(() => {
    void getVersion()
      .then((version) => {
        setCurrentVersion(version);
        return checkForUpdate(version);
      })
      .then((release) => {
        if (release) {
          setUpdateInfo(release);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const handleBeforeUnload = () => {
      const { workspaceStates } = useAppStore.getState();
      for (const workspaceId of workspaceStates.keys()) {
        flushLayoutToConfig(workspaceId);
        flushExpandedDirsToConfig(workspaceId);
      }
      flushCompletionUsageToConfig();
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  useEffect(() => {
    const unlistenPromise = appWindow.onCloseRequested(async (event) => {
      event.preventDefault();

      const confirmed = await showConfirm('关闭确认', '确定要关闭 Mini-Term 吗？', {
        detail: '当前布局、目录展开状态和补全习惯会先回填保存。',
        confirmLabel: '关闭应用',
        cancelLabel: '取消',
        tone: 'warning',
      });
      if (!confirmed) {
        return;
      }

      const { workspaceStates } = useAppStore.getState();
      for (const workspaceId of workspaceStates.keys()) {
        flushLayoutToConfig(workspaceId);
        flushExpandedDirsToConfig(workspaceId);
      }
      flushCompletionUsageToConfig();

      void appWindow.destroy();
    });

    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  const prevWorkspaceRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevWorkspaceRef.current && prevWorkspaceRef.current !== activeWorkspaceId) {
      flushLayoutToConfig(prevWorkspaceRef.current);
      flushExpandedDirsToConfig(prevWorkspaceRef.current);
    }
    prevWorkspaceRef.current = activeWorkspaceId;
  }, [activeWorkspaceId]);

  const saveLayoutTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const saveLayoutSizes = useCallback(
    (sizes: number[]) => {
      clearTimeout(saveLayoutTimerRef.current);
      saveLayoutTimerRef.current = setTimeout(() => {
        const currentConfig = useAppStore.getState().config;
        const nextConfig = { ...currentConfig, layoutSizes: sizes };
        setConfig(nextConfig);
        void invoke('save_config', { config: nextConfig });
      }, 500);
    },
    [setConfig],
  );

  const saveMiddleTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const saveMiddleColumnSizes = useCallback(
    (sizes: number[]) => {
      clearTimeout(saveMiddleTimerRef.current);
      saveMiddleTimerRef.current = setTimeout(() => {
        const currentConfig = useAppStore.getState().config;
        const nextConfig = { ...currentConfig, middleColumnSizes: sizes };
        setConfig(nextConfig);
        void invoke('save_config', { config: nextConfig });
      }, 500);
    },
    [setConfig],
  );

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

    void appWindow
      .onResized(() => {
        void syncMaximizedState();
      })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          unlistenResize = unlisten;
        }
      })
      .catch(console.error);

    void appWindow
      .onFocusChanged(({ payload }) => {
        if (!disposed) {
          setIsFocused(payload);
        }
      })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          unlistenFocus = unlisten;
        }
      })
      .catch(console.error);

    return () => {
      disposed = true;
      unlistenResize?.();
      unlistenFocus?.();
    };
  }, []);

  useEffect(() => {
    applyDocumentTheme(resolvedTheme);
  }, [themeConfig.preset, themeConfig.windowEffect]);

  useEffect(() => {
    if (!isWindows) {
      return;
    }

    const effectMap = {
      mica: Effect.Mica,
      acrylic: Effect.Acrylic,
      blur: Effect.Blur,
    } as const;

    const applyWindowMaterial = async () => {
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
  }, [themeConfig.preset, themeConfig.windowEffect]);

  const handleWindowMinimize = useCallback(() => {
    void appWindow.minimize();
  }, []);

  const handleWindowToggleMaximize = useCallback(() => {
    void appWindow
      .toggleMaximize()
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

    void appWindow
      .toggleMaximize()
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

    void appWindow.startDragging().catch(() => {});
  }, []);

  return (
    <div
      className={[
        'app-shell flex h-full flex-col',
        isMaximized ? 'app-shell-maximized' : '',
        isFocused ? 'app-shell-focused' : 'app-shell-unfocused',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div
        className="app-titlebar flex items-center gap-4 border-b border-[var(--border-subtle)] px-4 py-1.5 text-xs select-none"
        onDoubleClick={handleTitleBarDoubleClick}
        onMouseDown={handleTitleBarMouseDown}
        style={dragRegionStyle}
      >
        <div className="flex min-w-0 items-center gap-4" data-tauri-drag-region style={dragRegionStyle}>
          <span
            className="text-sm font-semibold tracking-wide text-[var(--accent)]"
            data-tauri-drag-region
            style={{ ...dragRegionStyle, fontFamily: "'DM Sans', sans-serif", letterSpacing: '0.05em' }}
          >
            MINI-TERM
          </span>

          {currentVersion && (
            <span
              className="text-[10px] font-mono text-[var(--text-muted)]"
              data-tauri-drag-region
              style={dragRegionStyle}
            >
              v{currentVersion}
            </span>
          )}

          {updateInfo && (
            <button
              type="button"
              className="no-drag-region rounded-full bg-[var(--accent)]/15 px-1.5 py-0.5 text-[10px] text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/25"
              style={noDragRegionStyle}
              onClick={() => openUrl(updateInfo.url)}
              title={`发现新版本 ${updateInfo.version}，点击前往下载`}
            >
              新版本 {updateInfo.version}
            </button>
          )}

          <div
            className="titlebar-divider h-3.5 w-px bg-[var(--border-default)]"
            data-tauri-drag-region
            style={dragRegionStyle}
          />

          <span
            className="app-titlemeta truncate text-[10px] uppercase tracking-[0.18em]"
            data-tauri-drag-region
            style={dragRegionStyle}
          >
            {activeWorkspaceName}
          </span>
        </div>

        <div className="no-drag-region flex items-center gap-3 text-[var(--text-muted)]" style={noDragRegionStyle}>
          <button
            type="button"
            className="cursor-pointer bg-transparent p-0 text-inherit transition-colors duration-150 hover:text-[var(--text-primary)]"
            onClick={() => openSettings()}
            style={noDragRegionStyle}
          >
            设置
          </button>
        </div>

        <div className="flex-1 self-stretch" data-tauri-drag-region style={dragRegionStyle} />

        {isWindows && (
          <div className="no-drag-region -mr-4 flex self-stretch items-stretch" style={noDragRegionStyle}>
            <TitleBarButton title="最小化" onClick={handleWindowMinimize}>
              <svg viewBox="0 0 10 10" className="titlebar-icon" aria-hidden="true">
                <path d="M1 5h8" />
              </svg>
            </TitleBarButton>

            <TitleBarButton title={isMaximized ? '还原' : '最大化'} onClick={handleWindowToggleMaximize}>
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

            <TitleBarButton title="关闭" danger onClick={handleWindowClose}>
              <svg viewBox="0 0 10 10" className="titlebar-icon" aria-hidden="true">
                <path d="M2 2l6 6" />
                <path d="M8 2L2 8" />
              </svg>
            </TitleBarButton>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-hidden">
        {configLoaded ? (
          <Allotment defaultSizes={layoutSizes ?? [200, 280, 1000]} onChange={saveLayoutSizes}>
            <Allotment.Pane minSize={140} maxSize={350}>
              <WorkspaceSidebar />
            </Allotment.Pane>

            <Allotment.Pane minSize={180}>
              <Allotment
                vertical
                defaultSizes={middleColumnSizes ?? [300, 200]}
                onChange={saveMiddleColumnSizes}
              >
                <Allotment.Pane minSize={150}>
                  <FileTree key={activeWorkspaceId} />
                </Allotment.Pane>
                <Allotment.Pane minSize={36}>
                  <GitHistory key={activeWorkspaceId} />
                </Allotment.Pane>
              </Allotment>
            </Allotment.Pane>

            <Allotment.Pane>
              <div className="relative h-full">
                {workspaces.map((workspace) => {
                  const primaryRootPath = getWorkspacePrimaryRootPath(workspace);
                  if (!primaryRootPath) {
                    return null;
                  }
                  return (
                  <div
                    key={workspace.id}
                    className="absolute inset-0"
                    style={{ display: workspace.id === activeWorkspaceId ? 'block' : 'none' }}
                  >
                    <TerminalArea
                      workspaceId={workspace.id}
                      workspacePath={primaryRootPath}
                      isVisible={workspace.id === activeWorkspaceId}
                      onOpenSettings={() => openSettings()}
                    />
                  </div>
                  );
                })}

                {workspaces.length === 0 && (
                  <div className="flex h-full items-center justify-center bg-[var(--bg-terminal)] text-sm text-[var(--text-muted)]">
                    请先在左侧添加一个项目。
                  </div>
                )}
              </div>
            </Allotment.Pane>
          </Allotment>
        ) : null}
      </div>

      <WorkspaceDialogHost />
    </div>
  );
}
