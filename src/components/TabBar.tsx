import { useAppStore } from '../store';
import { StatusDot } from './StatusDot';
import type { TerminalTab } from '../types';

function getTabTitle(tab: TerminalTab): string {
  if (tab.customTitle) return tab.customTitle;
  if (tab.splitLayout.type === 'leaf') return tab.splitLayout.pane.shellName;
  return 'split';
}

interface Props {
  projectId: string;
  onNewTab: () => void;
}

export function TabBar({ projectId, onNewTab }: Props) {
  const projectStates = useAppStore((s) => s.projectStates);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const removeTab = useAppStore((s) => s.removeTab);
  const ps = projectStates.get(projectId);
  if (!ps) return null;

  return (
    <div className="flex bg-[#1a1a2e] border-b border-[#333] text-[11px] overflow-x-auto">
      {ps.tabs.map((tab) => {
        const isActive = tab.id === ps.activeTabId;
        return (
          <div
            key={tab.id}
            className={`flex items-center gap-1.5 px-3 py-1.5 cursor-pointer border-r border-[#333] whitespace-nowrap ${
              isActive ? 'bg-[#0d0d1a] text-[#7c83ff]' : 'text-gray-500 hover:text-gray-300'
            }`}
            onClick={() => setActiveTab(projectId, tab.id)}
          >
            <StatusDot status={tab.status} />
            <span>{getTabTitle(tab)}</span>
            <span
              className="ml-1 text-gray-600 hover:text-white"
              onClick={(e) => {
                e.stopPropagation();
                removeTab(projectId, tab.id);
              }}
            >
              ✕
            </span>
          </div>
        );
      })}
      <div
        className="px-3 py-1.5 text-gray-600 cursor-pointer hover:text-white"
        onClick={onNewTab}
      >
        +
      </div>
    </div>
  );
}
