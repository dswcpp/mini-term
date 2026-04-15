import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store';
import { GitHistoryContent } from './GitHistoryContent';
import { GitChanges } from './GitChanges';
import type { GitRepoInfo } from '../types';

type GitTab = 'history' | 'changes';

export function GitHistory() {
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const config = useAppStore((s) => s.config);
  const project = config.projects.find((p) => p.id === activeProjectId);

  const [activeTab, setActiveTab] = useState<GitTab>('history');

  // 仓库选择器状态 — 提升到容器层，两个 tab 共享
  const [repos, setRepos] = useState<GitRepoInfo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string>('');

  const loadRepos = useCallback(() => {
    if (!project) return;
    invoke<GitRepoInfo[]>('discover_git_repos', { projectPath: project.path })
      .then((r) => {
        setRepos(r);
        setSelectedRepo((prev) => {
          if (prev && r.some((repo) => repo.path === prev)) return prev;
          return r.length > 0 ? r[0].path : '';
        });
      })
      .catch(() => setRepos([]));
  }, [project?.path]);

  useEffect(() => {
    loadRepos();
  }, [loadRepos]);

  // commit 成功后 Changes tab 通知容器刷新 History
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const onCommitSuccess = useCallback(() => {
    setHistoryRefreshKey((k) => k + 1);
  }, []);

  if (!project) {
    return (
      <div className="h-full bg-[var(--bg-surface)] flex items-center justify-center text-[var(--text-muted)] text-base">
        选择一个项目
      </div>
    );
  }

  return (
    <div className="h-full bg-[var(--bg-surface)] flex flex-col border-t border-[var(--border-subtle)]">
      {/* Tab 栏 */}
      <div className="flex items-center gap-0 px-3 pt-2 pb-0 flex-shrink-0">
        {(['history', 'changes'] as const).map((tab) => (
          <button
            key={tab}
            className={`px-3 py-1.5 text-sm font-medium transition-colors border-b-2 ${
              activeTab === tab
                ? 'text-[var(--accent)] border-[var(--accent)]'
                : 'text-[var(--text-muted)] border-transparent hover:text-[var(--text-primary)]'
            }`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'history' ? 'History' : 'Changes'}
          </button>
        ))}
      </div>

      {/* 仓库选择器（多仓库时显示） */}
      {repos.length > 1 && (
        <div className="px-3 pt-2 pb-0 flex-shrink-0">
          <select
            className="w-full text-sm bg-[var(--bg-base)] text-[var(--text-primary)] border border-[var(--border-default)] rounded px-2 py-1"
            value={selectedRepo}
            onChange={(e) => setSelectedRepo(e.target.value)}
          >
            {repos.map((r) => (
              <option key={r.path} value={r.path}>
                {r.name} {r.currentBranch ? `(${r.currentBranch})` : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Tab 内容 */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'history' ? (
          <GitHistoryContent
            key={historyRefreshKey}
            projectPath={project.path}
            repos={repos}
            refreshRepos={loadRepos}
          />
        ) : (
          <GitChanges
            projectPath={project.path}
            repoPath={selectedRepo}
            onCommitSuccess={onCommitSuccess}
          />
        )}
      </div>
    </div>
  );
}
