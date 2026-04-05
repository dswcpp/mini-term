import { memo, useCallback } from 'react';
import {
  useAppStore,
  selectWorkspaceConfig,
  selectWorkspaceState,
  selectThemePreset,
  selectTabRuntimeStatus,
} from '../store';
import { isMarkdownFilePath } from '../utils/markdownPreview';
import { setDraggingTabId } from '../utils/dragState';
import {
  resolveDocumentLanguage,
  summarizeDocumentLanguages,
  type DocumentLanguageFamily,
} from './documentViewer/language';
import { EyeIcon } from './documentViewer/controls';
import { resolveViewerSkin } from './documentViewer/viewerSkin';
import { StatusDot } from './StatusDot';
import type { ThemePresetId, WorkspaceTab } from '../types';

type FileViewerTab = Extract<WorkspaceTab, { kind: 'file-viewer' }>;

function normalizePath(path: string) {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
}

function getFileName(path: string) {
  const normalized = normalizePath(path);
  const segments = normalized.split('/');
  return segments[segments.length - 1] ?? path;
}

function getDirectoryName(path: string) {
  const normalized = normalizePath(path);
  const segments = normalized.split('/');
  segments.pop();
  return segments.join('/');
}

function getRelativePath(fullPath: string, rootPaths: string[]) {
  const normalizedTarget = normalizePath(fullPath);
  let matchedRoot: string | undefined;

  for (const rootPath of rootPaths) {
    const normalizedRoot = normalizePath(rootPath);
    if (
      normalizedTarget === normalizedRoot ||
      normalizedTarget.startsWith(`${normalizedRoot}/`)
    ) {
      if (!matchedRoot || normalizedRoot.length > normalizePath(matchedRoot).length) {
        matchedRoot = rootPath;
      }
    }
  }

  if (!matchedRoot) {
    return null;
  }

  const normalizedRoot = normalizePath(matchedRoot);
  if (normalizedTarget === normalizedRoot) {
    return '.';
  }

  return normalizedTarget.slice(normalizedRoot.length + 1);
}

function getPathDetail(path: string) {
  const detail = getDirectoryName(path);
  return detail && detail !== '.' ? detail : undefined;
}

function getTabText(tab: WorkspaceTab, rootPaths: string[], workspaceName?: string) {
  if (tab.kind === 'terminal') {
    return {
      primary: tab.customTitle ?? (tab.splitLayout.type === 'leaf' ? tab.splitLayout.pane.shellName : 'split'),
      secondary: undefined,
    };
  }

  if (tab.kind === 'agent-tasks') {
    return {
      primary: 'Tasks',
      secondary: tab.filter.scope === 'all' ? 'All Workspaces' : workspaceName ?? 'Current Workspace',
    };
  }

  if (tab.kind === 'file-viewer') {
    const relativePath = getRelativePath(tab.filePath, rootPaths) ?? normalizePath(tab.filePath);
    return {
      primary: getFileName(relativePath),
      secondary: getPathDetail(relativePath),
    };
  }

  if (tab.kind === 'worktree-diff') {
    const relativePath = normalizePath(tab.status.path);
    return {
      primary: getFileName(relativePath),
      secondary: getPathDetail(relativePath),
    };
  }

  if (tab.kind === 'file-history') {
    const relativePath = getRelativePath(tab.filePath, rootPaths) ?? normalizePath(tab.filePath);
    return {
      primary: getFileName(relativePath),
      secondary: getPathDetail(relativePath),
    };
  }

  return {
    primary: tab.commitMessage,
    secondary: tab.commitHash.slice(0, 7),
  };
}

function FileIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-none stroke-current" strokeWidth="1.8" aria-hidden="true">
      <path d="M8 3.5h6l4 4V20a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 7 20V5A1.5 1.5 0 0 1 8.5 3.5Z" />
      <path d="M14 3.5V8h4" />
      <path d="M9 13h6" />
      <path d="M9 16.5h4.5" />
    </svg>
  );
}

function MarkdownSourceIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-none stroke-current" strokeWidth="1.7" aria-hidden="true">
      <path d="M8 3.5h6l4 4V20a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 7 20V5A1.5 1.5 0 0 1 8.5 3.5Z" />
      <path d="M14 3.5V8h4" />
      <path d="m9 15 1.4-3 1.6 3 1.6-3 1.4 3" />
    </svg>
  );
}

function DiffIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-none stroke-current" strokeWidth="1.7" aria-hidden="true">
      <path d="M7 6h10" />
      <path d="M7 12h5" />
      <path d="M7 18h10" />
      <path d="m14.5 10 2 2-2 2" />
    </svg>
  );
}

function CommitIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-none stroke-current" strokeWidth="1.7" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M4 12h4.8" />
      <path d="M15.2 12H20" />
    </svg>
  );
}

function TasksIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-none stroke-current" strokeWidth="1.7" aria-hidden="true">
      <path d="M9 6.5h10" />
      <path d="M9 12h10" />
      <path d="M9 17.5h10" />
      <path d="M5.5 6.5h.01" />
      <path d="M5.5 12h.01" />
      <path d="M5.5 17.5h.01" />
    </svg>
  );
}

function CloseTabIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3 w-3 fill-none stroke-current" strokeWidth="1.8" aria-hidden="true">
      <path d="M4 4l8 8" />
      <path d="M12 4 4 12" />
    </svg>
  );
}

function FileTabLeading({ tab }: { tab: FileViewerTab }) {
  const markdownFile = isMarkdownFilePath(tab.filePath);
  if (markdownFile && tab.mode === 'preview') {
    return (
      <span className="inline-flex h-3.5 w-3.5 items-center justify-center text-[var(--accent)]" aria-hidden="true">
        <EyeIcon />
      </span>
    );
  }

  return (
    <span className="text-[var(--text-muted)]" aria-hidden="true">
      {markdownFile ? <MarkdownSourceIcon /> : <FileIcon />}
    </span>
  );
}

function WorktreeDiffLeading() {
  return (
    <span className="text-[var(--color-warning)]" aria-hidden="true">
      <DiffIcon />
    </span>
  );
}

function CommitDiffLeading() {
  return (
    <span className="text-[var(--color-info)]" aria-hidden="true">
      <CommitIcon />
    </span>
  );
}

function FileHistoryLeading() {
  return (
    <span className="text-[var(--viewer-accent)]" aria-hidden="true">
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-none stroke-current" strokeWidth="1.7">
        <path d="M12 6v6l3 2" />
        <circle cx="12" cy="12" r="7.5" />
      </svg>
    </span>
  );
}

function getLanguageBadgeMeta(tab: Exclude<WorkspaceTab, { kind: 'terminal' }>): {
  label: string;
  title: string;
  family: DocumentLanguageFamily;
} {
  if (tab.kind === 'file-viewer') {
    if (isMarkdownFilePath(tab.filePath) && tab.mode === 'preview') {
      return {
        label: 'PREVIEW',
        title: 'Markdown Preview',
        family: 'docs',
      };
    }

    const language = resolveDocumentLanguage(tab.filePath);
    return {
      label: language.badge,
      title: language.displayName,
      family: language.family,
    };
  }

  if (tab.kind === 'worktree-diff') {
    const language = resolveDocumentLanguage(tab.status.path);
    return {
      label: language.badge,
      title: `${language.displayName} Diff`,
      family: language.family,
    };
  }

  if (tab.kind === 'file-history') {
    const language = resolveDocumentLanguage(tab.filePath);
    return {
      label: language.badge,
      title: `${language.displayName} History`,
      family: language.family,
    };
  }

  if (tab.kind === 'agent-tasks') {
    return {
      label: 'TASKS',
      title: 'Agent Tasks',
      family: 'generic',
    };
  }

  const summary = summarizeDocumentLanguages(tab.files.map((file) => file.path));
  return {
    label: summary.badge,
    title: summary.displayName,
    family: summary.family === 'mixed' ? 'generic' : summary.family,
  };
}

function LanguageBadge({
  label,
  title,
  family,
  themePreset,
}: {
  label: string;
  title: string;
  family: DocumentLanguageFamily;
  themePreset: ThemePresetId;
}) {
  const skin = resolveViewerSkin(family, themePreset);

  return (
    <span
      title={title}
      className="rounded-full border px-1.5 py-px text-[8px] font-semibold tracking-[0.08em]"
      style={{
        color: skin.accent,
        borderColor: skin.border,
        backgroundColor: skin.accentSubtle,
      }}
    >
      {label}
    </span>
  );
}

interface Props {
  workspaceId?: string;
  projectId?: string;
  onNewTab: (e: React.MouseEvent) => void;
  onCloseTab: (tabId: string) => void;
}

interface TabBarItemProps {
  tab: WorkspaceTab;
  isActive: boolean;
  rootPaths: string[];
  workspaceName?: string;
  themePreset: ThemePresetId;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
}

const TabBarItem = memo(function TabBarItem({
  tab,
  isActive,
  rootPaths,
  workspaceName,
  themePreset,
  onSelectTab,
  onCloseTab,
}: TabBarItemProps) {
  const draggable = tab.kind === 'terminal';
  const terminalStatus = useAppStore(selectTabRuntimeStatus(tab.id));
  const text = getTabText(tab, rootPaths, workspaceName);
  const badgeMeta = tab.kind === 'terminal' || tab.kind === 'agent-tasks' ? null : getLanguageBadgeMeta(tab);

  return (
    <div
      data-testid={`workspace-tab-${tab.id}`}
      className={`relative flex cursor-pointer items-center gap-2 whitespace-nowrap px-3 py-[7px] transition-all duration-100 ${
        isActive
          ? 'bg-[var(--bg-terminal)] text-[var(--text-primary)]'
          : 'text-[var(--text-muted)] hover:bg-[var(--border-subtle)] hover:text-[var(--text-secondary)]'
      }`}
      draggable={draggable}
      onDragStart={(event) => {
        if (!draggable) return;
        setDraggingTabId(tab.id);
        event.dataTransfer.setData('application/tab-id', tab.id);
        event.dataTransfer.effectAllowed = 'move';
      }}
      onDragEnd={() => {
        if (draggable) {
          setDraggingTabId(null);
        }
      }}
      onClick={() => onSelectTab(tab.id)}
    >
      {isActive && <span className="absolute right-2 bottom-0 left-2 h-[2px] rounded-full bg-[var(--accent)]" />}
      {tab.kind === 'terminal' && <StatusDot status={terminalStatus} />}
      {tab.kind === 'file-viewer' && <FileTabLeading tab={tab} />}
      {tab.kind === 'worktree-diff' && <WorktreeDiffLeading />}
      {tab.kind === 'file-history' && <FileHistoryLeading />}
      {tab.kind === 'commit-diff' && <CommitDiffLeading />}
      {tab.kind === 'agent-tasks' && (
        <span className="text-[var(--color-ai)]" aria-hidden="true">
          <TasksIcon />
        </span>
      )}
      <div className="flex min-w-0 max-w-[220px] items-center gap-1.5">
        <span className="truncate font-medium">{text.primary}</span>
        {text.secondary && (
          <span
            data-testid={`workspace-tab-detail-${tab.id}`}
            className="truncate text-[10px] text-[var(--text-muted)]/90"
          >
            {text.secondary}
          </span>
        )}
      </div>
      {badgeMeta ? (
        <LanguageBadge
          label={badgeMeta.label}
          title={badgeMeta.title}
          family={badgeMeta.family}
          themePreset={themePreset}
        />
      ) : null}
      <span
        className="ml-0.5 text-[9px] text-[var(--text-muted)] transition-colors hover:text-[var(--color-error)]"
        onClick={(event) => {
          event.stopPropagation();
          onCloseTab(tab.id);
        }}
      >
        <CloseTabIcon />
      </span>
    </div>
  );
});

export function TabBar({ workspaceId, projectId, onNewTab, onCloseTab }: Props) {
  const resolvedWorkspaceId = workspaceId ?? projectId;
  const setActiveTab = useAppStore((state) => state.setActiveTab);
  const workspaceState = useAppStore(selectWorkspaceState(resolvedWorkspaceId ?? ''));
  const workspace = useAppStore(selectWorkspaceConfig(resolvedWorkspaceId));
  const themePreset = useAppStore(selectThemePreset);
  const rootPaths = workspace?.roots.map((root) => root.path) ?? [];
  const handleSelectTab = useCallback(
    (tabId: string) => {
      if (!resolvedWorkspaceId) {
        return;
      }
      setActiveTab(resolvedWorkspaceId, tabId);
    },
    [resolvedWorkspaceId, setActiveTab],
  );

  if (!resolvedWorkspaceId || !workspaceState) return null;

  return (
    <div className="flex select-none overflow-x-auto border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[11px]">
      {workspaceState.tabs.map((tab) => (
        <TabBarItem
          key={tab.id}
          tab={tab}
          isActive={tab.id === workspaceState.activeTabId}
          rootPaths={rootPaths}
          workspaceName={workspace?.name}
          themePreset={themePreset}
          onSelectTab={handleSelectTab}
          onCloseTab={onCloseTab}
        />
      ))}
      <div
        className="cursor-pointer px-3 py-[7px] text-[var(--text-muted)] transition-colors hover:text-[var(--accent)]"
        onClick={onNewTab}
      >
        +
      </div>
    </div>
  );
}
