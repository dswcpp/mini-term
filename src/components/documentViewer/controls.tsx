import type { ReactNode } from 'react';

export function ToolbarButton({
  active = false,
  disabled = false,
  compact = false,
  label,
  onClick,
  testId,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  compact?: boolean;
  label: string;
  onClick: () => void;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      data-testid={testId}
      onClick={onClick}
      className={`inline-flex items-center justify-center border transition-colors ${
        compact ? 'h-[22px] w-[22px] rounded-none' : 'h-6 w-6 rounded-none'
      } ${
        active
          ? 'border-[var(--accent)] bg-[var(--accent-muted)] text-[var(--accent)]'
          : 'border-transparent text-[var(--text-muted)] hover:border-[var(--border-default)] hover:text-[var(--text-primary)]'
      } disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-transparent disabled:hover:text-[var(--text-muted)]`}
    >
      {children}
    </button>
  );
}

export function ToolbarTextButton({
  disabled = false,
  label,
  onClick,
  testId,
  children,
}: {
  disabled?: boolean;
  label: string;
  onClick: () => void;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      data-testid={testId}
      onClick={onClick}
      className="inline-flex h-6 items-center justify-center rounded-none border border-[var(--border-default)] px-1.5 text-[10px] font-semibold tracking-[0.08em] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

export function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current" strokeWidth="1.8" aria-hidden="true">
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="3.2" />
    </svg>
  );
}

export function MaximizeIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current" strokeWidth="1.8" aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="1.8" />
    </svg>
  );
}

export function RestoreIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current" strokeWidth="1.8" aria-hidden="true">
      <path d="M8 8h10v10H8z" />
      <path d="M6 16V6h10" />
    </svg>
  );
}

export function FullscreenIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current" strokeWidth="1.8" aria-hidden="true">
      <path d="M8 4H4v4" />
      <path d="M16 4h4v4" />
      <path d="M4 16v4h4" />
      <path d="M20 16v4h-4" />
    </svg>
  );
}

export function ExitFullscreenIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current" strokeWidth="1.8" aria-hidden="true">
      <path d="M9 4H4v5" />
      <path d="M15 4h5v5" />
      <path d="M4 15v5h5" />
      <path d="M20 15v5h-5" />
      <path d="M8 8 4 4" />
      <path d="M16 8 20 4" />
      <path d="M8 16 4 20" />
      <path d="M16 16 20 20" />
    </svg>
  );
}

export function ZoomOutIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current" strokeWidth="1.8" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" />
      <path d="M8.5 11h5" />
      <path d="M16 16l4 4" />
    </svg>
  );
}

export function ZoomInIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current" strokeWidth="1.8" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" />
      <path d="M11 8.5v5" />
      <path d="M8.5 11h5" />
      <path d="M16 16l4 4" />
    </svg>
  );
}

export function FitIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current" strokeWidth="1.8" aria-hidden="true">
      <path d="M4 10V4h6" />
      <path d="M20 10V4h-6" />
      <path d="M4 14v6h6" />
      <path d="M20 14v6h-6" />
      <rect x="8" y="8" width="8" height="8" rx="1.5" />
    </svg>
  );
}

export function FocusIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current" strokeWidth="1.8" aria-hidden="true">
      <path d="M9 4H4v5" />
      <path d="M15 4h5v5" />
      <path d="M4 15v5h5" />
      <path d="M20 15v5h-5" />
      <path d="M10 8h4v4" />
      <path d="M14 12h-4v4" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 fill-none stroke-current" strokeWidth="1.8" aria-hidden="true">
      <path d="M6 6 18 18" />
      <path d="M18 6 6 18" />
    </svg>
  );
}
