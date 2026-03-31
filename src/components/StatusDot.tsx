import type { PaneStatus } from '../types';

const STATUS_STYLES: Record<PaneStatus, { bg: string; shadow: string }> = {
  idle: { bg: 'var(--text-muted)', shadow: 'none' },
  'ai-idle': { bg: 'var(--color-success)', shadow: 'none' },
  'ai-working': { bg: 'var(--color-ai)', shadow: '0 0 6px var(--color-ai-glow)' },
  error: { bg: 'var(--color-error)', shadow: 'none' },
};

const GLOW_STATUSES: PaneStatus[] = ['ai-working'];

export function StatusDot({ status, size = 'sm' }: { status: PaneStatus; size?: 'sm' | 'md' }) {
  const style = STATUS_STYLES[status];
  const glow = GLOW_STATUSES.includes(status) ? 'animate-glow' : '';
  const dim = size === 'sm' ? 'w-1.5 h-1.5' : 'w-2 h-2';

  return (
    <span
      className={`inline-block rounded-full flex-shrink-0 ${dim} ${glow}`}
      style={{ backgroundColor: style.bg, boxShadow: style.shadow }}
      title={status}
    />
  );
}
