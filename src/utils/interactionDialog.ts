import { useAppStore } from '../store';
import type { InteractionDialogTone } from '../types';

interface ShowConfirmOptions {
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: InteractionDialogTone;
}

interface ShowPromptOptions {
  hint?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  readOnly?: boolean;
}

type PendingInteractionDialog = {
  dialogId: string;
  resolveDismiss: () => void;
  resolveConfirm: (value?: string) => void;
};

let interactionDialogSequence = 0;
let pendingInteractionDialog: PendingInteractionDialog | null = null;

function nextDialogId() {
  interactionDialogSequence += 1;
  return `interaction-dialog-${Date.now()}-${interactionDialogSequence}`;
}

function settleInteractionDialog(
  dialogId: string,
  resolver: (pending: PendingInteractionDialog) => void,
) {
  if (!pendingInteractionDialog || pendingInteractionDialog.dialogId !== dialogId) {
    return;
  }

  const current = pendingInteractionDialog;
  pendingInteractionDialog = null;
  useAppStore.getState().closeDialog();
  resolver(current);
}

useAppStore.subscribe((state, previousState) => {
  const previousDialog = previousState.ui.activeDialog;
  const activeDialog = state.ui.activeDialog;

  if (
    previousDialog?.kind === 'interaction-dialog' &&
    pendingInteractionDialog?.dialogId === previousDialog.dialogId &&
    (activeDialog?.kind !== 'interaction-dialog' || activeDialog.dialogId !== previousDialog.dialogId)
  ) {
    const current = pendingInteractionDialog;
    pendingInteractionDialog = null;
    current.resolveDismiss();
  }
});

export function confirmInteractionDialog(dialogId: string, value?: string) {
  settleInteractionDialog(dialogId, (current) => current.resolveConfirm(value));
}

export function cancelInteractionDialog(dialogId: string) {
  settleInteractionDialog(dialogId, (current) => current.resolveDismiss());
}

export function showAlert(
  title: string,
  message: string,
  options: Omit<ShowConfirmOptions, 'cancelLabel'> = {},
): Promise<void> {
  return new Promise((resolve) => {
    if (pendingInteractionDialog) {
      pendingInteractionDialog.resolveDismiss();
      pendingInteractionDialog = null;
    }

    const dialogId = nextDialogId();
    pendingInteractionDialog = {
      dialogId,
      resolveDismiss: resolve,
      resolveConfirm: () => resolve(),
    };

    useAppStore.getState().openInteractionDialog({
      dialogId,
      mode: 'alert',
      title,
      message,
      detail: options.detail,
      confirmLabel: options.confirmLabel ?? '知道了',
      tone: options.tone ?? 'neutral',
    });
  });
}

export function showConfirm(
  title: string,
  message: string,
  options: ShowConfirmOptions = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    if (pendingInteractionDialog) {
      pendingInteractionDialog.resolveDismiss();
      pendingInteractionDialog = null;
    }

    const dialogId = nextDialogId();
    pendingInteractionDialog = {
      dialogId,
      resolveDismiss: () => resolve(false),
      resolveConfirm: () => resolve(true),
    };

    useAppStore.getState().openInteractionDialog({
      dialogId,
      mode: 'confirm',
      title,
      message,
      detail: options.detail,
      confirmLabel: options.confirmLabel ?? '确定',
      cancelLabel: options.cancelLabel ?? '取消',
      tone: options.tone ?? 'neutral',
    });
  });
}

export function showPrompt(
  title: string,
  placeholder?: string,
  initialValue = '',
  options: ShowPromptOptions = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    if (pendingInteractionDialog) {
      pendingInteractionDialog.resolveDismiss();
      pendingInteractionDialog = null;
    }

    const dialogId = nextDialogId();
    pendingInteractionDialog = {
      dialogId,
      resolveDismiss: () => resolve(null),
      resolveConfirm: (value) => resolve(value ?? ''),
    };

    useAppStore.getState().openInteractionDialog({
      dialogId,
      mode: 'prompt',
      title,
      message: options.readOnly ? (options.hint ?? 'Esc 关闭') : 'Enter 确认，Esc 取消',
      detail: options.readOnly ? undefined : options.hint ?? placeholder ?? '输入内容后按 Enter 提交',
      placeholder,
      initialValue,
      confirmLabel: options.confirmLabel ?? (options.readOnly ? '关闭' : '确定'),
      cancelLabel: options.readOnly ? undefined : options.cancelLabel ?? '取消',
      tone: 'neutral',
      readOnly: options.readOnly ?? false,
    });
  });
}
