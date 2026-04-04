import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../store';
import { showPrompt } from '../utils/prompt';
import { WorkspaceDialogHost } from './WorkspaceDialogHost';

describe('PromptDialog', () => {
  beforeEach(() => {
    useAppStore.setState((state) => ({
      ...state,
      ui: {
        activeDialog: null,
      },
    }));
  });

  it('renders a prompt and resolves the entered value', async () => {
    render(<WorkspaceDialogHost />);

    const pending = showPrompt('新建文件', '请输入文件名', 'README.md');

    expect(await screen.findByTestId('prompt-dialog')).not.toBeNull();

    const input = screen.getByTestId('prompt-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'notes.md' } });
    fireEvent.click(screen.getByRole('button', { name: '确定' }));

    await expect(pending).resolves.toBe('notes.md');
    expect(useAppStore.getState().ui.activeDialog).toBeNull();
  });

  it('cancels the prompt on escape', async () => {
    render(<WorkspaceDialogHost />);

    const pending = showPrompt('重命名标签页', '请输入标题', 'Shell');
    await screen.findByTestId('prompt-dialog');

    fireEvent.keyDown(window, { key: 'Escape' });

    await expect(pending).resolves.toBeNull();
    expect(useAppStore.getState().ui.activeDialog).toBeNull();
  });

  it('supports read-only prompt mode', async () => {
    render(<WorkspaceDialogHost />);

    const pending = showPrompt('查看运行命令', '仅查看，不会自动执行', 'npm run dev', {
      readOnly: true,
      confirmLabel: '关闭',
      hint: '这是只读内容，不会自动执行',
    });

    const input = (await screen.findByTestId('prompt-input')) as HTMLTextAreaElement;
    expect(input.readOnly).toBe(true);
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '关闭' }));

    await expect(pending).resolves.toBe('npm run dev');
  });

  it('preserves empty input on confirm instead of treating it as cancel', async () => {
    render(<WorkspaceDialogHost />);

    const pending = showPrompt('重命名标签页', '请输入标题', 'Shell');
    const input = (await screen.findByTestId('prompt-input')) as HTMLInputElement;

    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '确定' }));

    await expect(pending).resolves.toBe('');
  });
});
