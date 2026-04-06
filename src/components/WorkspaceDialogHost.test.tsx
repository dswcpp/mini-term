import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../store';

import { WorkspaceDialogHost } from './WorkspaceDialogHost';

describe('WorkspaceDialogHost', () => {
  beforeEach(() => {
    useAppStore.setState((state) => ({
      ...state,
      ui: {
        activeDialog: null,
        activeNotice: null,
      },
    }));
  });

  it('renders settings dialog and closes it on escape', async () => {
    useAppStore.getState().openSettings('theme');

    render(<WorkspaceDialogHost />);

    expect(await screen.findByTestId('settings-modal')).not.toBeNull();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(useAppStore.getState().ui.activeDialog).toBeNull();
  });

  it('closes the current dialog when the backdrop is clicked', async () => {
    useAppStore.getState().openSettings();

    render(<WorkspaceDialogHost />);

    fireEvent.click(await screen.findByTestId('overlay-surface-backdrop'));

    expect(useAppStore.getState().ui.activeDialog).toBeNull();
  });

  it('renders interaction dialogs from the host', () => {
    useAppStore.getState().openInteractionDialog({
      dialogId: 'confirm-1',
      mode: 'confirm',
      title: 'Close workspace?',
      message: 'Current layout will stay saved.',
      confirmLabel: 'Close',
      cancelLabel: 'Cancel',
    });

    render(<WorkspaceDialogHost />);
    expect(screen.getByTestId('message-box-dialog')).not.toBeNull();
  });
});
