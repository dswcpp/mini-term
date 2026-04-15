import { useState, useEffect, useCallback, useRef } from 'react';
import { Allotment } from 'allotment';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { openUrl } from '@tauri-apps/plugin-opener';
import { ask } from '@tauri-apps/plugin-dialog';
import { useAppStore, restoreLayout, flushLayoutToConfig, initExpandedDirs, flushExpandedDirsToConfig, persistConfig } from './store';
import { TerminalArea } from './components/TerminalArea';
import { ProjectList } from './components/ProjectList';
import { FileTree } from './components/FileTree';
import { GitHistory } from './components/GitHistory';
import { SettingsModal } from './components/SettingsModal';
import { ToastContainer } from './components/ToastContainer';
import { useTauriEvent } from './hooks/useTauriEvent';
import { checkForUpdate, type ReleaseInfo } from './utils/updateChecker';
import { applyTheme } from './utils/themeManager';
import type { AppConfig, PtyStatusChangePayload, PtyExitPayload, PaneStatus } from './types';

export function App() {
  const [configLoaded, setConfigLoaded] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [currentVersion, setCurrentVersion] = useState('');
  const [updateInfo, setUpdateInfo] = useState<ReleaseInfo | null>(null);
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const config = useAppStore((s) => s.config);
  const setConfig = useAppStore((s) => s.setConfig);
  const updatePaneStatusByPty = useAppStore((s) => s.updatePaneStatusByPty);

  useEffect(() => {
    invoke<AppConfig>('load_config').then((cfg) => {
      setConfig(cfg);
      // 应用 UI 字体大小
      if (cfg.uiFontSize) {
        document.documentElement.style.fontSize = `${cfg.uiFontSize}px`;
      }
      const { projectStates } = useAppStore.getState();
      const newStates = new Map(projectStates);
      for (const p of cfg.projects) {
        if (!newStates.has(p.id)) {
          newStates.set(p.id, { id: p.id, tabs: [], activeTabId: '' });
        }
      }
      useAppStore.setState({
        projectStates: newStates,
        activeProjectId: cfg.projects[0]?.id ?? null,
      });

      // 恢复各项目的展开目录状态
      for (const p of cfg.projects) {
        initExpandedDirs(p.id, p.expandedDirs ?? []);
      }

      applyTheme(cfg.theme ?? 'auto');
      setConfigLoaded(true);

      // 恢复各项目的终端布局，完成后再显示窗口，避免白屏闪烁
      const showWindow = () => {
        // 双 rAF 确保 React 渲染 + xterm.js canvas 绑定完成后再显示
        requestAnimationFrame(() => requestAnimationFrame(() => {
          getCurrentWindow().show();
        }));
      };
      const layoutProjects = cfg.projects.filter((p) => p.savedLayout && p.savedLayout.tabs.length > 0);
      if (layoutProjects.length > 0) {
        Promise.all(
          layoutProjects.map((p) => restoreLayout(p.id, p.savedLayout!, p.path, cfg))
        ).then(showWindow).catch(() => showWindow());
      } else {
        showWindow();
      }
    });
  }, []);

  // 主题变化时应用新主题
  useEffect(() => {
    applyTheme(config.theme ?? 'auto');
  }, [config.theme]);

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
    updatePaneStatusByPty(payload.ptyId, payload.status as PaneStatus);
  }, [updatePaneStatusByPty]));

  useTauriEvent<PtyExitPayload>('pty-exit', useCallback((payload) => {
    if (payload.exitCode !== 0) {
      updatePaneStatusByPty(payload.ptyId, 'error');
    }
  }, [updatePaneStatusByPty]));

  // 关闭窗口时二次确认并保存布局
  useEffect(() => {
    const appWindow = getCurrentWindow();
    const unlisten = appWindow.onCloseRequested(async (event) => {
      event.preventDefault();
      const confirmed = await ask('确定要关闭 Mini-Term 吗？', { title: '关闭确认', kind: 'warning' });
      if (!confirmed) return;
      const { projectStates } = useAppStore.getState();
      for (const projectId of projectStates.keys()) {
        flushLayoutToConfig(projectId);
        flushExpandedDirsToConfig(projectId);
      }
      // flush 只更新 store，最后统一写一次磁盘
      await persistConfig().catch(() => {});
      appWindow.destroy();
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // 切换项目时保存前一个项目的布局
  const prevProjectRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevProjectRef.current && prevProjectRef.current !== activeProjectId) {
      flushLayoutToConfig(prevProjectRef.current);
      flushExpandedDirsToConfig(prevProjectRef.current);
      persistConfig();
    }
    prevProjectRef.current = activeProjectId;
  }, [activeProjectId]);

  // 防抖保存布局尺寸
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const saveLayoutSizes = useCallback((sizes: number[]) => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const cfg = useAppStore.getState().config;
      const newConfig = { ...cfg, layoutSizes: sizes };
      setConfig(newConfig);
      invoke('save_config', { config: newConfig });
    }, 500);
  }, [setConfig]);

  const saveMidTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const saveMiddleColumnSizes = useCallback((sizes: number[]) => {
    clearTimeout(saveMidTimer.current);
    saveMidTimer.current = setTimeout(() => {
      const cfg = useAppStore.getState().config;
      const newConfig = { ...cfg, middleColumnSizes: sizes };
      setConfig(newConfig);
      invoke('save_config', { config: newConfig });
    }, 500);
  }, [setConfig]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-4 px-4 py-2 bg-[var(--bg-elevated)] border-b border-[var(--border-subtle)] text-xs select-none"
        onMouseDown={(e) => {
          // 用 Tauri API 拖拽替代 -webkit-app-region: drag，
          // 避免 WebView2 内部拖拽模态循环导致外部截图工具触发输入锁定
          if (e.button === 0 && !(e.target as HTMLElement).closest('[data-no-drag]')) {
            e.preventDefault();
            getCurrentWindow().startDragging();
          }
        }}>
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
            title={`新版本 ${updateInfo.version} 可用，点击前往下载`}
          >
            新版本 {updateInfo.version}
          </span>
        )}
        <div className="w-px h-3.5 bg-[var(--border-default)]" />
        <div className="flex items-center gap-3 text-[var(--text-muted)]" data-no-drag>
          <span className="cursor-pointer hover:text-[var(--text-primary)] transition-colors duration-150" onClick={() => setConfigOpen(true)}>设置</span>
        </div>
        <div className="flex-1" />
      </div>

      <div className="flex-1 overflow-hidden">
        {configLoaded ? <Allotment
          defaultSizes={config.layoutSizes ?? [200, 280, 1000]}
          onChange={saveLayoutSizes}
        >
          <Allotment.Pane minSize={140} maxSize={350}>
            <ProjectList />
          </Allotment.Pane>

          <Allotment.Pane minSize={180}>
            <Allotment
              vertical
              defaultSizes={config.middleColumnSizes ?? [300, 200]}
              onChange={saveMiddleColumnSizes}
            >
              <Allotment.Pane minSize={150}>
                <FileTree key={activeProjectId} />
              </Allotment.Pane>
              <Allotment.Pane minSize={36}>
                <GitHistory key={activeProjectId} />
              </Allotment.Pane>
            </Allotment>
          </Allotment.Pane>

          <Allotment.Pane>
            <div className="relative h-full">
              {config.projects.map((project) => (
                <div
                  key={project.id}
                  className="absolute inset-0"
                  style={{ display: project.id === activeProjectId ? 'block' : 'none' }}
                >
                  <TerminalArea projectId={project.id} projectPath={project.path} />
                </div>
              ))}
              {config.projects.length === 0 && (
                <div className="h-full bg-[var(--bg-terminal)] flex items-center justify-center text-[var(--text-muted)] text-sm">
                  请先在左栏添加项目
                </div>
              )}
            </div>
          </Allotment.Pane>
        </Allotment> : null}
      </div>
      <SettingsModal open={configOpen} onClose={() => setConfigOpen(false)} />
      <ToastContainer />
    </div>
  );
}
