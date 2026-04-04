import { useEffect, useRef, useState } from 'react';
import type { InteractionDialogMode, InteractionDialogTone } from '../types';
import { cancelInteractionDialog, confirmInteractionDialog } from '../utils/interactionDialog';
import { OverlaySurface } from './OverlaySurface';

interface InteractionDialogProps {
  open: boolean;
  dialogId: string;
  mode: InteractionDialogMode;
  title: string;
  message?: string;
  detail?: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: InteractionDialogTone;
  readOnly?: boolean;
}

function PromptIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 fill-none stroke-current" strokeWidth="1.8" aria-hidden="true">
      <path d="M4.5 6.5A2.5 2.5 0 0 1 7 4h10a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 17 16H10l-4.5 4v-4H7A2.5 2.5 0 0 1 4.5 13.5z" />
    </svg>
  );
}

function MessageIcon({ tone = 'neutral' }: { tone?: InteractionDialogTone }) {
  if (tone === 'danger') {
    return (
      <svg viewBox="0 0 24 24" className="h-5 w-5 fill-none stroke-current" strokeWidth="1.8" aria-hidden="true">
        <path d="M12 3.5 21 19H3z" />
        <path d="M12 9v4.5" />
        <path d="M12 16.5h.01" />
      </svg>
    );
  }

  if (tone === 'warning') {
    return (
      <svg viewBox="0 0 24 24" className="h-5 w-5 fill-none stroke-current" strokeWidth="1.8" aria-hidden="true">
        <path d="M12 3.5 21 19H3z" />
        <path d="M12 8.75v5.25" />
        <path d="M12 17.25h.01" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 fill-none stroke-current" strokeWidth="1.8" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 10v4" />
      <path d="M12 7.25h.01" />
    </svg>
  );
}

const toneClassMap = {
  neutral: {
    icon: 'border-[var(--accent)]/30 bg-[var(--accent-subtle)] text-[var(--accent)]',
    action: 'border-[var(--accent)] bg-[var(--accent-subtle)] text-[var(--accent)] hover:bg-[var(--accent-muted)]',
  },
  warning: {
    icon: 'border-amber-500/30 bg-amber-500/12 text-amber-300',
    action: 'border-amber-500/45 bg-amber-500/12 text-amber-200 hover:bg-amber-500/18',
  },
  danger: {
    icon: 'border-rose-500/30 bg-rose-500/12 text-rose-300',
    action: 'border-rose-500/45 bg-rose-500/12 text-rose-200 hover:bg-rose-500/18',
  },
} as const;

function DialogIcon({ mode, tone }: { mode: InteractionDialogMode; tone?: InteractionDialogTone }) {
  if (mode === 'prompt') {
    return <PromptIcon />;
  }
  return <MessageIcon tone={tone} />;
}

export function InteractionDialog({
  open,
  dialogId,
  mode,
  title,
  message,
  detail,
  placeholder,
  initialValue = '',
  confirmLabel,
  cancelLabel,
  tone = 'neutral',
  readOnly = false,
}: InteractionDialogProps) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open || mode !== 'prompt') {
      return;
    }

    setValue(initialValue);
  }, [initialValue, mode, open, dialogId]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      if (mode === 'prompt') {
        const field = readOnly ? textareaRef.current : inputRef.current;
        field?.focus();
        if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
          const length = field.value.length;
          field.setSelectionRange(length, length);
        }
        return;
      }

      confirmButtonRef.current?.focus();
    });

    return () => cancelAnimationFrame(frame);
  }, [open, mode, readOnly, dialogId]);

  if (!open) {
    return null;
  }

  const isPrompt = mode === 'prompt';
  const isReadOnlyPrompt = isPrompt && readOnly;
  const resolvedConfirmLabel =
    confirmLabel ?? (mode === 'alert' ? '知道了' : isReadOnlyPrompt ? '关闭' : '确定');
  const resolvedCancelLabel =
    cancelLabel ?? (mode === 'confirm' || (isPrompt && !readOnly) ? '取消' : undefined);
  const headerTone = toneClassMap[tone];
  const dialogTestId = isPrompt ? 'prompt-dialog' : 'message-box-dialog';
  const helperText = isPrompt && !readOnly ? detail ?? placeholder ?? '输入内容后按 Enter 提交' : undefined;

  const handleConfirm = () => {
    confirmInteractionDialog(dialogId, isPrompt ? value : undefined);
  };

  return (
    <OverlaySurface
      open={open}
      onClose={() => cancelInteractionDialog(dialogId)}
      panelProps={{
        role: isPrompt ? 'dialog' : 'alertdialog',
        'aria-modal': true,
        'aria-label': `${mode}:${title}`,
        'data-testid': dialogTestId,
        'data-mode': mode,
      }}
      panelClassName="relative flex w-[min(92vw,560px)] flex-col overflow-hidden rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-surface)] shadow-[var(--shadow-overlay)] animate-slide-in"
    >
      <div className="border-b border-[var(--border-subtle)] bg-[linear-gradient(180deg,rgba(255,255,255,0.035),rgba(255,255,255,0.01))] px-5 py-4">
        <div className="flex items-start gap-3">
          <div
            className={`mt-0.5 inline-flex h-10 w-10 items-center justify-center rounded-xl border ${headerTone.icon}`}
          >
            <DialogIcon mode={mode} tone={tone} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
              Message Box
            </div>
            <div className="mt-1 text-lg font-semibold text-[var(--text-primary)]">{title}</div>
            {message && (
              <div className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
                {message}
              </div>
            )}
            {!isPrompt && detail && (
              <div className="mt-2 text-xs leading-5 text-[var(--text-muted)]">{detail}</div>
            )}
          </div>
        </div>
      </div>

      {isPrompt ? (
        <div className="space-y-3 px-5 py-4">
          {isReadOnlyPrompt ? (
            <textarea
              ref={textareaRef}
              value={value}
              readOnly
              rows={Math.min(Math.max(value.split('\n').length + 1, 4), 12)}
              data-testid="prompt-input"
              className="min-h-[132px] w-full resize-y rounded-xl border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 py-3 font-mono text-[13px] leading-6 text-[var(--text-primary)] outline-none"
            />
          ) : (
            <input
              ref={inputRef}
              value={value}
              placeholder={placeholder ?? ''}
              spellCheck={false}
              data-testid="prompt-input"
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  handleConfirm();
                }
              }}
              className="h-12 w-full rounded-xl border border-[var(--border-default)] bg-[var(--bg-elevated)] px-3 text-sm text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
            />
          )}

          {helperText && (
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/40 px-3 py-2 text-xs text-[var(--text-secondary)]">
              {helperText}
            </div>
          )}
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-2 border-t border-[var(--border-subtle)] px-5 py-4">
        {resolvedCancelLabel && (
          <button
            type="button"
            onClick={() => cancelInteractionDialog(dialogId)}
            className="inline-flex h-10 items-center justify-center rounded-xl border border-[var(--border-default)] px-4 text-sm text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
          >
            {resolvedCancelLabel}
          </button>
        )}
        <button
          ref={confirmButtonRef}
          type="button"
          onClick={handleConfirm}
          className={`inline-flex h-10 items-center justify-center rounded-xl px-4 text-sm font-medium transition-colors ${headerTone.action}`}
        >
          {resolvedConfirmLabel}
        </button>
      </div>
    </OverlaySurface>
  );
}
