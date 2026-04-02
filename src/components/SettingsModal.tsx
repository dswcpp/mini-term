import { useEffect, useState } from 'react';
import { AboutSettings } from './settings/AboutSettings';
import { SystemSettings } from './settings/SystemSettings';
import { TerminalSettings } from './settings/TerminalSettings';
import { ThemeSettings } from './settings/ThemeSettings';

interface Props {
  open: boolean;
  onClose: () => void;
}

type SettingsPage = 'terminal' | 'theme' | 'system' | 'about';

const MENU_ITEMS: { key: SettingsPage; label: string }[] = [
  { key: 'terminal', label: '终端' },
  { key: 'theme', label: '主题' },
  { key: 'system', label: '系统' },
  { key: 'about', label: '关于' },
];

export function SettingsModal({ open, onClose }: Props) {
  const [activePage, setActivePage] = useState<SettingsPage>('terminal');

  useEffect(() => {
    if (open) {
      setActivePage('terminal');
    }
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />

      <div
        className="relative flex max-h-[80vh] w-[760px] flex-col overflow-hidden rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-[var(--bg-surface)] shadow-2xl animate-slide-in"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-5 py-4">
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">设置</h2>
          <button
            type="button"
            className="text-lg leading-none text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
            onClick={onClose}
            aria-label="关闭设置"
          >
            ×
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          <div className="w-[190px] flex-shrink-0 space-y-0.5 border-r border-[var(--border-subtle)] px-2 py-3">
            {MENU_ITEMS.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-3 py-2 text-left text-base transition-all duration-150 ${
                  activePage === item.key
                    ? 'bg-[var(--accent-subtle)] text-[var(--accent)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--border-subtle)] hover:text-[var(--text-primary)]'
                }`}
                onClick={() => setActivePage(item.key)}
              >
                {activePage === item.key && (
                  <span className="h-4 w-0.5 flex-shrink-0 rounded-full bg-[var(--accent)]" />
                )}
                <span>{item.label}</span>
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            {activePage === 'terminal' && <TerminalSettings />}
            {activePage === 'theme' && <ThemeSettings />}
            {activePage === 'system' && <SystemSettings />}
            {activePage === 'about' && <AboutSettings />}
          </div>
        </div>
      </div>
    </div>
  );
}
