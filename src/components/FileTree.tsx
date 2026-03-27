import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store';
import { useTauriEvent } from '../hooks/useTauriEvent';
import type { FileEntry, FsChangePayload } from '../types';

interface TreeNodeProps {
  entry: FileEntry;
  projectRoot: string;
  depth: number;
}

function TreeNode({ entry, projectRoot, depth }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[]>([]);

  const loadChildren = useCallback(async () => {
    const entries = await invoke<FileEntry[]>('list_directory', {
      projectRoot,
      path: entry.path,
    });
    setChildren(entries);
  }, [entry.path, projectRoot]);

  const handleToggle = useCallback(async () => {
    if (!entry.isDir) return;
    if (!expanded) {
      await loadChildren();
      invoke('watch_directory', { path: entry.path, projectPath: projectRoot });
    } else {
      invoke('unwatch_directory', { path: entry.path });
    }
    setExpanded(!expanded);
  }, [entry, expanded, loadChildren, projectRoot]);

  useTauriEvent<FsChangePayload>('fs-change', useCallback((payload: FsChangePayload) => {
    if (expanded && payload.path.startsWith(entry.path)) {
      loadChildren();
    }
  }, [expanded, entry.path, loadChildren]));

  return (
    <div>
      <div
        className={`flex items-center gap-1 py-0.5 cursor-pointer hover:bg-[#ffffff08] rounded text-xs ${
          entry.isDir ? 'text-gray-300' : 'text-[#8be9fd]'
        }`}
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
        onClick={handleToggle}
        draggable={!entry.isDir}
        onDragStart={(e) => {
          if (!entry.isDir) {
            e.dataTransfer.setData('text/plain', entry.path);
            e.dataTransfer.effectAllowed = 'copy';
          }
        }}
      >
        {entry.isDir && (
          <span className="text-[10px] w-3 text-center text-gray-500">
            {expanded ? '▾' : '▸'}
          </span>
        )}
        {!entry.isDir && <span className="w-3" />}
        <span className="truncate">{entry.name}</span>
      </div>

      {expanded &&
        children.map((child) => (
          <TreeNode key={child.path} entry={child} projectRoot={projectRoot} depth={depth + 1} />
        ))}
    </div>
  );
}

export function FileTree() {
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const config = useAppStore((s) => s.config);
  const project = config.projects.find((p) => p.id === activeProjectId);

  const [rootEntries, setRootEntries] = useState<FileEntry[]>([]);

  useEffect(() => {
    if (!project) {
      setRootEntries([]);
      return;
    }
    invoke<FileEntry[]>('list_directory', {
      projectRoot: project.path,
      path: project.path,
    }).then(setRootEntries);
  }, [project?.path]);

  if (!project) {
    return (
      <div className="h-full bg-[#16162a] flex items-center justify-center text-gray-600 text-xs">
        选择一个项目
      </div>
    );
  }

  return (
    <div className="h-full bg-[#16162a] flex flex-col overflow-y-auto">
      <div className="px-2 pt-2 pb-1 text-[10px] text-gray-600 uppercase tracking-widest">
        文件 — {project.name}
      </div>
      <div className="flex-1 px-1">
        {rootEntries.map((entry) => (
          <TreeNode key={entry.path} entry={entry} projectRoot={project.path} depth={0} />
        ))}
      </div>
    </div>
  );
}
