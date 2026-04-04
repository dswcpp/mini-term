import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../store';
import { showAlert, showConfirm } from '../utils/messageBox';
import { WorkspaceDialogHost } from './WorkspaceDialogHost';

describe('MessageBoxDialog', () => {
  beforeEach(() => {
    useAppStore.setState((state) => ({
      ...state,
      ui: {
        activeDialog: null,
      },
    }));
  });

  it('renders a message box and resolves true on confirm', async () => {
    render(<WorkspaceDialogHost />);

    const pending = showConfirm('关闭确认', '确定要关闭 Mini-Term 吗？', {
      detail: '当前布局会先保存。',
      confirmLabel: '关闭应用',
      cancelLabel: '取消',
      tone: 'warning',
    });

    expect(await screen.findByTestId('message-box-dialog')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '关闭应用' }));

    await expect(pending).resolves.toBe(true);
    expect(useAppStore.getState().ui.activeDialog).toBeNull();
  });

  it('cancels the message box on escape', async () => {
    render(<WorkspaceDialogHost />);

    const pending = showConfirm('关闭确认', '确定要关闭 Mini-Term 吗？');
    await screen.findByTestId('message-box-dialog');

    fireEvent.keyDown(window, { key: 'Escape' });

    await expect(pending).resolves.toBe(false);
    expect(useAppStore.getState().ui.activeDialog).toBeNull();
  });

  it('supports alert mode without a cancel button', async () => {
    render(<WorkspaceDialogHost />);

    const pending = showAlert('保存完成', '文档内容已更新。', {
      confirmLabel: '知道了',
    });

    await screen.findByTestId('message-box-dialog');
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '知道了' }));

    await expect(pending).resolves.toBeUndefined();
    expect(useAppStore.getState().ui.activeDialog).toBeNull();
  });
});
