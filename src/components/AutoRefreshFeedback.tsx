import type { AutoRefreshFeedback } from '../hooks/useAutoRefreshFeedback';

interface AutoRefreshFeedbackBarProps {
  feedback: AutoRefreshFeedback | null;
  testId?: string;
}

function getToneClassName(tone: AutoRefreshFeedback['tone']) {
  if (tone === 'refresh-error') {
    return 'text-[var(--color-error)]';
  }
  if (tone === 'refresh-success') {
    return 'text-[var(--color-success)]';
  }
  return 'text-[var(--text-muted)]';
}

export function AutoRefreshFeedbackBar({ feedback, testId }: AutoRefreshFeedbackBarProps) {
  if (!feedback) {
    return null;
  }

  return (
    <div
      data-testid={testId}
      className={`border-b px-3 py-1.5 text-[11px] ${getToneClassName(feedback.tone)}`}
      style={{ borderColor: 'var(--viewer-border-subtle)' }}
    >
      {feedback.message}
    </div>
  );
}

export function AutoRefreshFeedbackBadge({ feedback, testId }: AutoRefreshFeedbackBarProps) {
  if (!feedback) {
    return null;
  }

  return (
    <span
      data-testid={testId}
      className={`mr-1 border px-1.5 py-0 text-[8px] font-medium tracking-[0.04em] ${getToneClassName(feedback.tone)}`}
      style={{
        borderColor: 'var(--viewer-border)',
        backgroundColor: 'color-mix(in srgb, var(--viewer-panel) 88%, transparent)',
      }}
    >
      {feedback.message}
    </span>
  );
}
