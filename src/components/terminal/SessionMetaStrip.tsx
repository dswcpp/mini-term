import { useMemo } from 'react';
import type { TerminalSessionMeta } from '../../types';
import { formatSessionPhaseLabel } from '../../utils/session';

interface Props {
  shellName?: string;
  session?: TerminalSessionMeta;
}

export function SessionMetaStrip({ shellName, session }: Props) {
  const phaseLabel = useMemo(() => formatSessionPhaseLabel(session?.phase), [session?.phase]);
  const phaseClassName = useMemo(() => {
    switch (session?.phase) {
      case 'running':
        return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200';
      case 'waiting-input':
        return 'border-[var(--accent)]/30 bg-[var(--accent)]/12 text-[var(--accent)]';
      case 'error':
        return 'border-rose-500/30 bg-rose-500/10 text-rose-200';
      case 'exited':
        return 'border-[var(--border-default)] bg-[var(--bg-overlay)] text-[var(--text-muted)]';
      default:
        return 'border-[var(--border-subtle)] bg-[var(--bg-overlay)] text-[var(--text-secondary)]';
    }
  }, [session?.phase]);

  const commandPreview = session?.activeCommand?.command ?? session?.lastCommand;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
      <span className="truncate font-medium text-[var(--text-secondary)]">
        {shellName ?? 'Terminal'}
      </span>
      <span
        className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-medium tracking-[0.08em] ${phaseClassName}`}
      >
        {phaseLabel}
      </span>
      {commandPreview && (
        <span className="truncate font-mono text-[9px] text-[var(--text-muted)]">
          {commandPreview}
        </span>
      )}
    </div>
  );
}
