import { useState, useEffect, useCallback, useRef } from 'react';
import { Allotment } from 'allotment';
import { getVersion } from '@tauri-apps/api/app';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useAppStore, restoreLayout, flushLayoutToConfig, initExpandedDirs, flushExpandedDirsToConfig, flushProjectToConfig, persistConfig } from './store';
import { TerminalArea } from './components/TerminalArea';
import { ProjectList } from './components/ProjectList';
import { OverviewPanel } from './components/OverviewPanel';
import { FileTree } from './components/FileTree';
import { ActivityBar } from './components/ActivityBar';
import { RightDrawer } from './components/RightDrawer';
import { SettingsModal, type SettingsPage } from './components/SettingsModal';
import { SshModal } from './components/SshModal';
import { SearchModal } from './components/SearchModal';
import { ToastContainer } from './components/ToastContainer';
import { CcConnectModal } from './components/CcConnectModal';
import { CcConnectDashboard } from './components/CcConnectDashboard';
import { useTauriEvent } from './hooks/useTauriEvent';
import { useAiSubmitMarker } from './hooks/useAiSubmitMarker';
import { useMarkerHotkeys } from './hooks/useMarkerHotkeys';
import { useExternalFileDrop } from './hooks/useExternalFileDrop';
import { useCcConnectProbe } from './hooks/useCcConnectProbe';
import { useWorkspaceOverview } from './hooks/useWorkspaceOverview';
import { checkForUpdate, type ReleaseInfo } from './utils/updateChecker';
import { applyTheme } from './utils/themeManager';
import { applyUiFontFamily } from './utils/fontManager';
import { markAiPty, updateAllTerminalThemes } from './utils/terminalCache';
import { includeActiveProject } from './utils/projectKeepAlive';
import { normalizeCcConnectConfig } from './utils/ccConnectConfig';
import { probeCcConnect, startCcConnect } from './utils/ccConnectApi';
import { loadConfig, saveConfig } from './utils/configApi';
import { showConfirm } from './utils/prompt';
import { useT } from './i18n';
import type { PtyStatusChangePayload, PtyExitPayload, PaneStatus } from './types';

export function App() {
  const t = useT();
  const [configLoaded, setConfigLoaded] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [configPage, setConfigPage] = useState<SettingsPage | undefined>(undefined);
  const [sshOpen, setSshOpen] = useState(false);
  const [ccConnectOpen, setCcConnectOpen] = useState(false);
  const ccDashboardOpen = useAppStore((s) => s.ccDashboardOpen);
  const ccDashboardDeepLink = useAppStore((s) => s.ccDashboardDeepLink);
  const closeCcDashboard = useAppStore((s) => s.closeCcDashboard);
  const [currentVersion, setCurrentVersion] = useState('');
  const [updateInfo, setUpdateInfo] = useState<ReleaseInfo | null>(null);
  const [mountedProjectIds, setMountedProjectIds] = useState<string[]>([]);
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const config = useAppStore((s) => s.config);
  const setConfig = useAppStore((s) => s.setConfig);
  const updatePaneStatusByPty = useAppStore((s) => s.updatePaneStatusByPty);
  const searchModalOpen = useAppStore((s) => s.searchModalOpen);
  const setSearchModalOpen = useAppStore((s) => s.setSearchModalOpen);

  const openSettings = useCallback(() => {
    setConfigPage(undefined);
    setConfigOpen(true);
  }, []);
  const openSsh = useCallback(() => setSshOpen(true), []);
  const openCcConnect = useCallback(() => setCcConnectOpen(true), []);

  useEffect(() => {
    loadConfig().then((cfg) => {
      setConfig(cfg);
      // 应用 UI 字体大小
      if (cfg.uiFontSize) {
        document.documentElement.style.fontSize = `${cfg.uiFontSize}px`;
      }
      applyUiFontFamily(cfg.uiFontFamily);
      const { projectStates } = useAppStore.getState();
      const newStates = new Map(projectStates);
      for (const p of cfg.projects) {
        if (!newStates.has(p.id)) {
          newStates.set(p.id, { id: p.id, tabs: [], activeTabId: '' });
        }
      }
      const lastActive = cfg.lastActiveProjectId;
      const initialActive =
        lastActive && cfg.projects.some((p) => p.id === lastActive)
          ? lastActive
          : cfg.projects[0]?.id ?? null;
      useAppStore.setState({
        projectStates: newStates,
        activeProjectId: initialActive,
      });

      // 恢复各项目的展开目录状态
      for (const p of cfg.projects) {
        initExpandedDirs(p.id, p.expandedDirs ?? []);
      }

      applyTheme(cfg.theme ?? 'auto');

      for (const p of cfg.projects) {
        if (p.savedLayout && p.savedLayout.tabs.length > 0) {
          restoreLayout(p.id, p.savedLayout, cfg);
        }
      }

      setConfigLoaded(true);

      // 布局元数据恢复完成后显示窗口；终端进程由可见 pane 按需创建。
      const showWindow = () => {
        // 双 rAF 确保 React 首帧布局完成后再显示。
        requestAnimationFrame(() => requestAnimationFrame(() => {
          getCurrentWindow().show();
        }));
      };
      showWindow();

      // cc-connect autoStart:首次 probe 发现未运行时尝试 spawn(勾选了 autoStart 即可,
      // 未填写可执行文件时由后端优先使用内置 sidecar,找不到再回退 PATH 中的 cc-connect)
      const ccCfg = cfg.ccConnect ? normalizeCcConnectConfig(cfg.ccConnect) : undefined;
      if (ccCfg?.autoStart) {
        probeCcConnect(ccCfg.configPath).then((status) => {
          useAppStore.getState().setCcConnectStatus(status);
          if (!status.running) {
            return startCcConnect({
              exePath: ccCfg.exePath,
              configPath: ccCfg.configPath,
              extraArgs: ccCfg.extraArgs,
            }).then(() => {
              // spawn 后等 ~600ms 让 cc-connect 起监听端口再重新 probe
              setTimeout(() => {
                probeCcConnect(ccCfg.configPath)
                  .then((s) => useAppStore.getState().setCcConnectStatus(s))
                  .catch(() => {});
              }, 600);
            });
          }
        }).catch(() => {
          // autoStart 失败静默(用户可在设置面板手动启动 + 看错误诊断)
        });
      }
    });
  }, []);

  // cc-connect 状态 5s 轮询(失焦时暂停节省 CPU)、常驻探活:配置过用保存的 configPath,
  // 未配置则以默认 ~/.cc-connect/config.toml 探活 —— 这样零配置下也能识别 cc-connect 运行态,
  // 让项目列表的"导入到 cc-connect"右键菜单在 running 时直接可用。
  // 无 cc-connect 的用户:探活只是一次快速失败的文件读(不产生 HTTP),UI 也不展示任何状态。
  const ccProbeConfig = normalizeCcConnectConfig(config.ccConnect);
  useCcConnectProbe(configLoaded ? ccProbeConfig : undefined);
  useWorkspaceOverview(configLoaded);

  // 阻止浏览器默认的文件拖放行为（防止导航到拖入的文件）
  useEffect(() => {
    const prevent = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    };
    document.addEventListener('dragover', prevent);
    document.addEventListener('drop', prevent);
    return () => {
      document.removeEventListener('dragover', prevent);
      document.removeEventListener('drop', prevent);
    };
  }, []);

  // 防御输入法候选框把布局「顶开」(issue #34):WebView2 在 IME composition 时会把获得
  // 焦点的 xterm helper-textarea 滚进可视区,给某个 overflow:hidden 的布局祖先(Allotment
  // pane / 主内容区 / #root/body)设了非 0 的 scrollLeft,整页内容被横向推走、右侧露出桌面。
  // 这类布局容器本就不该横向滚动,监听到偏移即复位;合法横向滚动容器是 overflow-x:auto/scroll
  // (代码块、tab 栏、modal),scrollLeft 短路或 overflowX 非 hidden 而被放过,不受影响。
  useEffect(() => {
    const onScroll = (e: Event) => {
      const node = e.target instanceof HTMLElement ? e.target : document.scrollingElement;
      if (!(node instanceof HTMLElement) || node.scrollLeft === 0) return;
      if (getComputedStyle(node).overflowX === 'hidden') node.scrollLeft = 0;
    };
    window.addEventListener('scroll', onScroll, true);
    return () => window.removeEventListener('scroll', onScroll, true);
  }, []);

  // Ctrl+Shift+F 打开/关闭搜索弹窗(内容搜索是本地 ripgrep 链路,SSH 远程项目不支持)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'F') {
        e.preventDefault();
        const { searchModalOpen: isOpen, setSearchModalOpen: setOpen, config: cfg, activeProjectId: pid } = useAppStore.getState();
        const activeProject = cfg.projects.find((p) => p.id === pid);
        if (!isOpen && activeProject?.sshConnectionId) return; // 远程项目:不打开
        setOpen(!isOpen);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // 主题变化时应用新主题
  useEffect(() => {
    applyTheme(config.theme ?? 'auto');
  }, [config.theme]);

  // 皮肤变化时应用
  useEffect(() => {
    const skin = config.skin ?? 'none';
    document.documentElement.dataset.skin = skin === 'none' ? '' : skin;
    updateAllTerminalThemes(config.terminalFollowTheme);
  }, [config.skin]);

  // 启动时获取版本号并检查更新
  useEffect(() => {
    getVersion().then((ver) => {
      setCurrentVersion(ver);
      checkForUpdate(ver).then((release) => {
        if (release) setUpdateInfo(release);
      }).catch(() => {});
    });
  }, []);

  useTauriEvent<PtyStatusChangePayload>('pty-status-change', useCallback((payload) => {
    markAiPty(payload.ptyId, payload.status === 'ai-working' || payload.status === 'ai-idle');
    updatePaneStatusByPty(payload.ptyId, payload.status as PaneStatus);
  }, [updatePaneStatusByPty]));

  useTauriEvent<PtyExitPayload>('pty-exit', useCallback((payload) => {
    // 登记已退出的 PTY:远程项目 pane 据此叠加「连接已断开,点击重连」覆盖层
    // (不区分用户主动 exit 与异常断线);本地 pane 不消费该集合,登记无副作用。
    useAppStore.getState().markPtyExited(payload.ptyId);
    if (payload.exitCode !== 0) {
      updatePaneStatusByPty(payload.ptyId, 'error');
    }
  }, [updatePaneStatusByPty]));

  // WSL 启动器重写提示:后端检测到 cwd 是 WSL UNC 路径并强制改用 wsl.exe 启动时,
  // 弹一次性 toast(5s 自动消失)。projectId 仅作占位 (不参与跳转,kind='wsl-info' 已屏蔽点击跳转)。
  useTauriEvent<{ ptyId: number; distro: string; unixPath: string }>(
    'wsl-shell-override',
    useCallback((payload) => {
      useAppStore.getState().pushNotification({
        projectId: '__wsl_info__',
        projectName: `WSL: ${payload.distro}`,
        kind: 'wsl-info',
        message: t('app.wslOverride', { path: payload.unixPath }),
      });
    }, []),
  );

  useAiSubmitMarker();
  useMarkerHotkeys();
  useExternalFileDrop();

  // 关闭窗口时二次确认并保存布局
  useEffect(() => {
    const appWindow = getCurrentWindow();
    const unlisten = appWindow.onCloseRequested(async (event) => {
      event.preventDefault();
      const confirmed = await showConfirm(t('app.closeConfirm.title'), t('app.closeConfirm.message'));
      if (!confirmed) return;
      const { projectStates, activeProjectId: currentActive, config: currentConfig } = useAppStore.getState();
      for (const projectId of projectStates.keys()) {
        flushLayoutToConfig(projectId);
        flushExpandedDirsToConfig(projectId);
      }
      if (currentActive && currentConfig.lastActiveProjectId !== currentActive) {
        useAppStore.getState().setConfig({ ...useAppStore.getState().config, lastActiveProjectId: currentActive });
      }
      // flush 只更新 store，最后统一写一次磁盘
      await persistConfig().catch(() => {});
      appWindow.destroy();
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // 切换项目时保存前一个项目的布局（合并为一次 setConfig）
  const prevProjectRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevProjectRef.current && prevProjectRef.current !== activeProjectId) {
      flushProjectToConfig(prevProjectRef.current);
      persistConfig();
    }
    prevProjectRef.current = activeProjectId;
  }, [activeProjectId]);

  useEffect(() => {
    const existingIds = new Set(config.projects.map((p) => p.id));
    setMountedProjectIds((ids) =>
      includeActiveProject(ids.filter((id) => existingIds.has(id)), activeProjectId)
    );
  }, [activeProjectId, config.projects]);

  const terminalProjectIds = includeActiveProject(mountedProjectIds, activeProjectId);

  // 防抖保存布局尺寸
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const saveLayoutSizes = useCallback((sizes: number[]) => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const cfg = useAppStore.getState().config;
      const newConfig = { ...cfg, layoutSizes: sizes };
      setConfig(newConfig);
      void saveConfig(newConfig);
    }, 500);
  }, [setConfig]);

  const saveMidTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const saveMiddleColumnSizes = useCallback((sizes: number[]) => {
    clearTimeout(saveMidTimer.current);
    saveMidTimer.current = setTimeout(() => {
      const cfg = useAppStore.getState().config;
      const newConfig = { ...cfg, middleColumnSizes: sizes };
      setConfig(newConfig);
      void saveConfig(newConfig);
    }, 500);
  }, [setConfig]);

  // 右侧抽屉宽度：拖拽结束时持久化一次
  const persistRightDrawerWidth = useCallback((width: number) => {
    const cfg = useAppStore.getState().config;
    const newConfig = { ...cfg, rightDrawerWidth: width };
    setConfig(newConfig);
    void saveConfig(newConfig);
  }, [setConfig]);

  const handleMinimizeWindow = useCallback(() => {
    void getCurrentWindow().minimize().catch(() => {});
  }, []);

  const handleToggleMaximizeWindow = useCallback(() => {
    void getCurrentWindow().toggleMaximize().catch(() => {});
  }, []);

  const handleCloseWindow = useCallback(() => {
    void getCurrentWindow().close().catch(() => {});
  }, []);

  return (
    <div className="flex flex-col h-full">
      <div
        className="flex items-center gap-4 pl-4 pr-0 py-2 bg-[var(--bg-elevated)] border-b border-[var(--border-subtle)] text-xs select-none"
        onMouseDown={(e) => {
          // 用 Tauri API 拖拽替代 -webkit-app-region: drag，
          // 避免 WebView2 内部拖拽模态循环导致外部截图工具触发输入锁定
          if (e.button !== 0 || (e.target as HTMLElement).closest('[data-no-drag]')) return;
          e.preventDefault();
          if (e.detail === 2) {
            void getCurrentWindow().toggleMaximize().catch(() => {});
            return;
          }
          void getCurrentWindow().startDragging().catch(() => {});
        }}
      >
        <span className="font-semibold tracking-wide text-[var(--accent)] text-sm" style={{ fontFamily: "'DM Sans', sans-serif", letterSpacing: '0.05em' }}>
          MINI-TERM
        </span>
        {currentVersion && (
          <span className="text-[10px] text-[var(--text-muted)] font-mono">v{currentVersion}</span>
        )}
        {updateInfo && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--accent)]/15 text-[var(--accent)] cursor-pointer hover:bg-[var(--accent)]/25 transition-colors"
            data-no-drag
            onClick={() => openUrl(updateInfo.url)}
            title={t('app.update.title', { version: updateInfo.version })}
          >
            {t('app.update.badge', { version: updateInfo.version })}
          </span>
        )}
        <div className="flex-1" />
        <div className="flex items-stretch self-stretch" data-no-drag>
          <button
            type="button"
            className="w-11 flex items-center justify-center text-base leading-none text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--border-subtle)] transition-colors"
            onClick={handleMinimizeWindow}
            title={t('app.windowControls.minimize')}
            aria-label={t('app.windowControls.minimize')}
          >
            −
          </button>
          <button
            type="button"
            className="w-11 flex items-center justify-center text-sm leading-none text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--border-subtle)] transition-colors"
            onClick={handleToggleMaximizeWindow}
            title={t('app.windowControls.maximizeRestore')}
            aria-label={t('app.windowControls.maximizeRestore')}
          >
            □
          </button>
          <button
            type="button"
            className="w-11 flex items-center justify-center text-base leading-none text-[var(--text-muted)] hover:text-[var(--color-error)] hover:bg-[var(--color-error-muted)] transition-colors"
            onClick={handleCloseWindow}
            title={t('app.windowControls.close')}
            aria-label={t('app.windowControls.close')}
          >
            ×
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden flex">
        {configLoaded && (
          <ActivityBar
            settingsActive={configOpen}
            sshActive={sshOpen}
            connectActive={ccConnectOpen}
            onOpenSettings={openSettings}
            onOpenSsh={openSsh}
            onOpenConnect={openCcConnect}
          />
        )}

        {configLoaded ? (
          <div className="relative flex-1 overflow-hidden">
            <Allotment
              defaultSizes={config.layoutSizes?.length === 2 ? config.layoutSizes : [520, 1000]}
              onChange={saveLayoutSizes}
            >
              <Allotment.Pane minSize={180} maxSize={600} visible={config.middleColumnVisible}>
                <Allotment vertical defaultSizes={config.overviewVisible ? [220, 700] : undefined}>
                  <Allotment.Pane minSize={150} visible={config.overviewVisible}>
                    <OverviewPanel />
                  </Allotment.Pane>
                  <Allotment.Pane minSize={220}>
                    <Allotment
                      vertical
                      defaultSizes={config.middleColumnSizes?.length === 2 ? config.middleColumnSizes : [320, 380]}
                      onChange={saveMiddleColumnSizes}
                    >
                      <Allotment.Pane minSize={100}>
                        <ProjectList />
                      </Allotment.Pane>
                      <Allotment.Pane minSize={120}>
                        <FileTree />
                      </Allotment.Pane>
                    </Allotment>
                  </Allotment.Pane>
                </Allotment>
              </Allotment.Pane>

              <Allotment.Pane>
                <div className="relative h-full">
                  {terminalProjectIds.map((projectId) => {
                    const project = config.projects.find((p) => p.id === projectId);
                    if (!project) return null;
                    return (
                      <div
                        key={project.id}
                        className="absolute inset-0"
                        style={{ display: project.id === activeProjectId ? 'block' : 'none' }}
                      >
                        <TerminalArea projectId={project.id} projectPath={project.path} />
                      </div>
                    );
                  })}
                  {config.projects.length === 0 && (
                    <div className="h-full bg-[var(--bg-terminal)] flex items-center justify-center text-[var(--text-muted)] text-sm">
                      {t('app.emptyState')}
                    </div>
                  )}
                </div>
              </Allotment.Pane>
            </Allotment>

            <RightDrawer
              initialWidth={config.rightDrawerWidth ?? 340}
              onResizeEnd={persistRightDrawerWidth}
            />
          </div>
        ) : null}
      </div>
      <SettingsModal open={configOpen} onClose={() => setConfigOpen(false)} initialPage={configPage} />
      <SshModal open={sshOpen} onClose={() => setSshOpen(false)} />
      <CcConnectModal open={ccConnectOpen} onClose={() => setCcConnectOpen(false)} />
      <SearchModal open={searchModalOpen} onClose={() => setSearchModalOpen(false)} />
      <CcConnectDashboard
        open={ccDashboardOpen}
        onClose={closeCcDashboard}
        deepLink={ccDashboardDeepLink || undefined}
      />
      <ToastContainer />
    </div>
  );
}
