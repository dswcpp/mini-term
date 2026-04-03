import type { TerminalSessionMeta } from '../../types';
import { formatCommandStatusLabel } from '../../utils/session';

interface Props {
  session?: TerminalSessionMeta;
}

function getStatusClassName(status: TerminalSessionMeta['commands'][number]['status']) {
  switch (status) {
    case 'running':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200';
    case 'success':
      return 'border-sky-500/30 bg-sky-500/10 text-sky-200';
    case 'error':
      return 'border-rose-500/30 bg-rose-500/10 text-rose-200';
    case 'interrupted':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-200';
    default:
      return 'border-[var(--border-subtle)] bg-[var(--bg-overlay)] text-[var(--text-secondary)]';
  }
}

export function SessionCommandTimeline({ session }: Props) {
  if (!session || session.commands.length === 0) {
    return null;
  }

  const items = session.commands.slice(-4).reverse();

  return (
    <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--border-subtle)] bg-[var(--bg-overlay)] px-2 py-1">
      {items.map((command) => (
        <div
          key={command.id}
          className="min-w-0 shrink-0 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2 py-1"
          style={{ minWidth: 140, maxWidth: 260 }}
        >
          <div className="flex items-center gap-1.5">
            <span
              className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-medium ${getStatusClassName(command.status)}`}
            >
              {formatCommandStatusLabel(command.status)}
            </span>
            <span className="truncate font-mono text-[10px] text-[var(--text-primary)]">
              {command.command}
            </span>
          </div>
          <div className="mt-0.5 text-[9px] text-[var(--text-muted)]">
            {command.exitCode == null ? '等待状态回填' : `退出码 ${command.exitCode}`}
          </div>
        </div>
      ))}
    </div>
  );
}
