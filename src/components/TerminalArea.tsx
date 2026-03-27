import { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore, genId } from '../store';
import { TabBar } from './TabBar';
import { TerminalInstance } from './TerminalInstance';
import type { TerminalTab } from '../types';

interface Props {
  projectId: string;
  projectPath: string;
}

export function TerminalArea({ projectId, projectPath }: Props) {
  const config = useAppStore((s) => s.config);
  const projectStates = useAppStore((s) => s.projectStates);
  const addTab = useAppStore((s) => s.addTab);
  const ps = projectStates.get(projectId);

  const handleNewTab = useCallback(async () => {
    const shell = config.availableShells.find((s) => s.name === config.defaultShell)
      ?? config.availableShells[0];
    if (!shell) return;

    const ptyId = await invoke<number>('create_pty', {
      shell: shell.command,
      args: shell.args ?? [],
      cwd: projectPath,
    });

    const paneId = genId();
    const tabId = genId();

    const tab: TerminalTab = {
      id: tabId,
      status: 'idle',
      splitLayout: {
        type: 'leaf',
        pane: {
          id: paneId,
          shellName: shell.name,
          status: 'idle',
          ptyId,
        },
      },
    };

    addTab(projectId, tab);
  }, [projectId, projectPath, config, addTab]);

  return (
    <div className="flex flex-col h-full bg-[#0d0d1a]">
      <TabBar projectId={projectId} onNewTab={handleNewTab} />

      <div className="flex-1 overflow-hidden relative">
        {ps?.tabs.map((tab) => (
          <div
            key={tab.id}
            className="absolute inset-0"
            style={{ display: tab.id === ps.activeTabId ? 'block' : 'none' }}
          >
            {tab.splitLayout.type === 'leaf' && (
              <TerminalInstance ptyId={tab.splitLayout.pane.ptyId} />
            )}
          </div>
        ))}

        {(!ps || ps.tabs.length === 0) && (
          <div className="flex items-center justify-center h-full text-gray-600 text-sm">
            <button
              className="px-4 py-2 border border-dashed border-gray-600 rounded hover:border-[#7c83ff] hover:text-[#7c83ff]"
              onClick={handleNewTab}
            >
              + 新建终端
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
