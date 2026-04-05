import { useEffect } from 'react';
import { useAppStore } from '../store';

function getToneClasses(tone: 'info' | 'success' | 'error') {
  switch (tone) {
    case 'success':
      return 'border-emerald-500/30 bg-emerald-500/14 text-emerald-100';
    case 'error':
      return 'border-rose-500/35 bg-rose-500/14 text-rose-100';
    default:
      return 'border-[var(--border-strong)] bg-[var(--bg-elevated)]/95 text-[var(--text-primary)]';
  }
}

function getToneLabel(tone: 'info' | 'success' | 'error') {
  switch (tone) {
    case 'success':
      return '已同步';
    case 'error':
      return '刷新失败';
    default:
      return '提示';
  }
}

export function GlobalNoticeHost() {
  const activeNotice = useAppStore((state) => state.ui.activeNotice);
  const clearNotice = useAppStore((state) => state.clearNotice);

  useEffect(() => {
    if (!activeNotice) {
      return;
    }

    const timer = window.setTimeout(() => {
      clearNotice(activeNotice.id);
    }, activeNotice.durationMs);

    return () => {
      window.clearTimeout(timer);
    };
  }, [activeNotice, clearNotice]);

  if (!activeNotice) {
    return null;
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-[80] flex justify-center px-4">
      <div
        role="status"
        aria-live="polite"
        data-testid="global-notice"
        data-tone={activeNotice.tone}
        className={`max-w-[min(560px,100%)] rounded-full border px-4 py-2 shadow-[var(--shadow-overlay)] backdrop-blur-md ${getToneClasses(activeNotice.tone)}`}
      >
        <div className="flex items-center gap-3 text-[11px]">
          <span className="font-semibold tracking-[0.08em] uppercase opacity-80">
            {getToneLabel(activeNotice.tone)}
          </span>
          <span className="truncate">{activeNotice.message}</span>
        </div>
      </div>
    </div>
  );
}
