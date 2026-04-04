import { useAppStore } from '../store';
import { InteractionDialog } from './InteractionDialog';
import { SettingsModal } from './SettingsModal';

export function WorkspaceDialogHost() {
  const activeDialog = useAppStore((state) => state.ui.activeDialog);
  const closeDialog = useAppStore((state) => state.closeDialog);

  if (!activeDialog) {
    return null;
  }

  switch (activeDialog.kind) {
    case 'settings':
      return <SettingsModal open onClose={closeDialog} initialPage={activeDialog.page} />;
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
