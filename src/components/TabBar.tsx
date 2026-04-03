import { useAppStore } from '../store';
import { StatusDot } from './StatusDot';
import { setDraggingTabId } from '../utils/dragState';
import type { TerminalTab } from '../types';

function getTabTitle(tab: TerminalTab): string {
  if (tab.customTitle) return tab.customTitle;
  if (tab.splitLayout.type === 'leaf') return tab.splitLayout.pane.shellName;
  return 'split';
}

interface Props {
  projectId: string;
  onNewTab: (e: React.MouseEvent) => void;
  onCloseTab: (tabId: string) => void;
}

export function TabBar({ projectId, onNewTab, onCloseTab }: Props) {
  const projectStates = useAppStore((s) => s.projectStates);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const ps = projectStates.get(projectId);
  if (!ps) return null;

  return (
    <div className="flex overflow-x-auto border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[11px] select-none">
      {ps.tabs.map((tab) => {
        const isActive = tab.id === ps.activeTabId;
        return (
          <div
            key={tab.id}
            className={`relative flex cursor-pointer items-center gap-2 whitespace-nowrap px-3 py-[7px] transition-all duration-100 ${
              isActive
                ? 'bg-[var(--bg-terminal)] text-[var(--text-primary)]'
                : 'text-[var(--text-muted)] hover:bg-[var(--border-subtle)] hover:text-[var(--text-secondary)]'
            }`}
            draggable
            onDragStart={(e) => {
              setDraggingTabId(tab.id);
              e.dataTransfer.setData('application/tab-id', tab.id);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragEnd={() => {
              setDraggingTabId(null);
            }}
            onClick={() => setActiveTab(projectId, tab.id)}
          >
            {isActive && (
              <span className="absolute right-2 bottom-0 left-2 h-[2px] rounded-full bg-[var(--accent)]" />
            )}
            <StatusDot status={tab.status} />
            <span className="font-medium">{getTabTitle(tab)}</span>
            <span
              className="ml-0.5 text-[9px] text-[var(--text-muted)] transition-colors hover:text-[var(--color-error)]"
              onClick={(e) => {
                e.stopPropagation();
                onCloseTab(tab.id);
              }}
            >
              ?
            </span>
          </div>
        );
      })}
      <div
        className="cursor-pointer px-3 py-[7px] text-[var(--text-muted)] transition-colors hover:text-[var(--accent)]"
        onClick={onNewTab}
      >
        +
      </div>
    </div>
  );
}
