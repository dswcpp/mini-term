import type { RunProfile } from '../../types';

interface RunProfileInspectorProps {
  runProfile?: RunProfile;
  fallbackCommand?: string;
  onClose: () => void;
}

function formatTimestamp(timestamp?: number) {
  if (!timestamp) {
    return '未运行';
  }

  return new Date(timestamp).toLocaleString([], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function RunProfileInspector({ runProfile, fallbackCommand, onClose }: RunProfileInspectorProps) {
  const savedCommand = runProfile?.savedCommand ?? fallbackCommand ?? '';

  return (
    <div className="absolute top-3 right-3 z-20 w-[min(30rem,calc(100%_-_1.5rem))] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-default)] bg-[color-mix(in_srgb,var(--bg-elevated)_88%,transparent)] shadow-[0_18px_50px_rgba(0,0,0,0.28)] backdrop-blur-xl">
      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-3 py-2 text-[11px]">
        <div>
          <div className="text-[9px] uppercase tracking-[0.18em] text-[var(--text-muted)]">Run Profile</div>
          <div className="mt-0.5 text-[var(--text-primary)]">当前分屏的运行命令</div>
        </div>
        <button
          type="button"
          className="rounded-[var(--radius-sm)] px-2 py-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--border-subtle)] hover:text-[var(--text-primary)]"
          onClick={onClose}
        >
          关闭
        </button>
      </div>

      <div className="grid gap-3 px-3 py-3 text-[11px] text-[var(--text-secondary)]">
        <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-overlay)] px-3 py-2">
          <div className="mb-1 text-[9px] uppercase tracking-[0.16em] text-[var(--text-muted)]">Command</div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] text-[var(--text-primary)]">
            {savedCommand || '未设置'}
          </pre>
        </div>

        <div className="grid grid-cols-3 gap-2 text-[10px]">
          <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-overlay)] px-2 py-2">
            <div className="text-[var(--text-muted)]">最近运行</div>
            <div className="mt-1 text-[var(--text-primary)]">{formatTimestamp(runProfile?.lastRunAt)}</div>
          </div>
          <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-overlay)] px-2 py-2">
            <div className="text-[var(--text-muted)]">最近退出码</div>
            <div className="mt-1 text-[var(--text-primary)]">{runProfile?.lastExitCode ?? '未知'}</div>
          </div>
          <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-overlay)] px-2 py-2">
            <div className="text-[var(--text-muted)]">作用域</div>
            <div className="mt-1 truncate text-[var(--text-primary)]">{runProfile?.usageScope ?? '当前终端'}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
