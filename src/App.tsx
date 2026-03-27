import { useEffect, useCallback } from 'react';
import { Allotment } from 'allotment';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from './store';
import { TerminalArea } from './components/TerminalArea';
import { ProjectList } from './components/ProjectList';
import { FileTree } from './components/FileTree';
import { AIHistoryPanel } from './components/AIHistoryPanel';
import { useTauriEvent } from './hooks/useTauriEvent';
import type { AppConfig, PtyStatusChangePayload, PtyExitPayload, PaneStatus } from './types';

export function App() {
  const aiPanelVisible = useAppStore((s) => s.aiPanelVisible);
  const toggleAiPanel = useAppStore((s) => s.toggleAiPanel);
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const config = useAppStore((s) => s.config);
  const setConfig = useAppStore((s) => s.setConfig);
  const updatePaneStatusByPty = useAppStore((s) => s.updatePaneStatusByPty);

  useEffect(() => {
    invoke<AppConfig>('load_config').then((cfg) => {
      setConfig(cfg);
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

  const activeProject = config.projects.find((p) => p.id === activeProjectId);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-4 px-4 py-2 bg-[var(--bg-elevated)] border-b border-[var(--border-subtle)] text-xs select-none"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <span className="font-semibold tracking-wide text-[var(--accent)] text-sm" style={{ fontFamily: "'DM Sans', sans-serif", letterSpacing: '0.05em' }}>
          MINI-TERM
        </span>
        <div className="w-px h-3.5 bg-[var(--border-default)]" />
        <div className="flex items-center gap-3 text-[var(--text-muted)]" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <span className="cursor-pointer hover:text-[var(--text-primary)] transition-colors duration-150">终端</span>
          <span className="cursor-pointer hover:text-[var(--text-primary)] transition-colors duration-150">设置</span>
          <span
            className={`cursor-pointer transition-colors duration-150 ${aiPanelVisible ? 'text-[var(--accent)]' : 'hover:text-[var(--text-primary)]'}`}
            onClick={toggleAiPanel}
          >
            AI 历史
          </span>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5 text-[var(--text-muted)]" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <span className="w-3 h-3 rounded-full border border-[var(--border-default)] cursor-pointer hover:bg-[var(--color-success)] hover:border-transparent transition-all" />
          <span className="w-3 h-3 rounded-full border border-[var(--border-default)] cursor-pointer hover:bg-[var(--color-warning)] hover:border-transparent transition-all" />
          <span className="w-3 h-3 rounded-full border border-[var(--border-default)] cursor-pointer hover:bg-[var(--color-error)] hover:border-transparent transition-all" />
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        <Allotment>
          <Allotment.Pane preferredSize={200} minSize={140} maxSize={350}>
            <ProjectList />
          </Allotment.Pane>

          <Allotment.Pane preferredSize={280} minSize={180}>
            <FileTree />
          </Allotment.Pane>

          <Allotment.Pane>
            <Allotment>
              <Allotment.Pane>
                {activeProject ? (
                  <TerminalArea projectId={activeProject.id} projectPath={activeProject.path} />
                ) : (
                  <div className="h-full bg-[var(--bg-terminal)] flex items-center justify-center text-[var(--text-muted)] text-sm">
                    请先在左栏添加项目
                  </div>
                )}
              </Allotment.Pane>

              {aiPanelVisible && (
                <Allotment.Pane preferredSize={180} minSize={140} maxSize={280} snap>
                  <AIHistoryPanel />
                </Allotment.Pane>
              )}
            </Allotment>
          </Allotment.Pane>
        </Allotment>
      </div>
    </div>
  );
}
