import { Suspense, lazy } from 'react';
import { useAppStore } from '../store';
import { InteractionDialog } from './InteractionDialog';
import { OverlaySurface } from './OverlaySurface';

const LazySettingsModal = lazy(() => import('./SettingsModal').then((module) => ({
  default: module.SettingsModal,
})));

function SettingsModalFallback({ onClose }: { onClose: () => void }) {
  return (
    <OverlaySurface
      open
      onClose={onClose}
      panelProps={{
        role: 'dialog',
        'aria-modal': true,
        'aria-label': 'settings-dialog-loading',
        'data-testid': 'settings-modal-loading',
      }}
      panelClassName="relative flex w-[min(980px,calc(100vw-32px))] flex-col overflow-hidden rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-[var(--bg-surface)] shadow-2xl animate-slide-in"
    >
      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-5 py-4">
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">设置</h2>
      </div>
      <div className="flex min-h-[360px] items-center justify-center px-5 py-4 text-sm text-[var(--text-muted)]">
        Loading settings...
      </div>
    </OverlaySurface>
  );
}

export function WorkspaceDialogHost() {
  const activeDialog = useAppStore((state) => state.ui.activeDialog);
  const closeDialog = useAppStore((state) => state.closeDialog);

  if (!activeDialog) {
    return null;
  }

  switch (activeDialog.kind) {
    case 'settings':
      return (
        <Suspense fallback={<SettingsModalFallback onClose={closeDialog} />}>
          <LazySettingsModal open onClose={closeDialog} initialPage={activeDialog.page} />
        </Suspense>
      );
    case 'interaction-dialog':
      return (
        <InteractionDialog
          open
          dialogId={activeDialog.dialogId}
          mode={activeDialog.mode}
          title={activeDialog.title}
          message={activeDialog.message}
          detail={activeDialog.detail}
          placeholder={activeDialog.placeholder}
          initialValue={activeDialog.initialValue}
          confirmLabel={activeDialog.confirmLabel}
          cancelLabel={activeDialog.cancelLabel}
          tone={activeDialog.tone}
          readOnly={activeDialog.readOnly}
        />
      );
    default:
      return null;
  }
}
