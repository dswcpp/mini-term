import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../store';
import { GlobalNoticeHost } from './GlobalNoticeHost';

describe('GlobalNoticeHost', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAppStore.setState((state) => ({
      ...state,
      ui: {
        activeDialog: null,
        activeNotice: null,
      },
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the current notice and clears it after the timeout', () => {
    render(<GlobalNoticeHost />);

    act(() => {
      useAppStore.getState().showNotice({
        message: '该文件已无差异，已关闭 diff',
        tone: 'success',
        durationMs: 1200,
      });
    });

    expect(screen.getByTestId('global-notice')).not.toBeNull();
    expect(screen.getByText('该文件已无差异，已关闭 diff')).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1200);
    });

    expect(screen.queryByTestId('global-notice')).toBeNull();
    expect(useAppStore.getState().ui.activeNotice).toBeNull();
  });

  it('keeps a newer notice when the previous timeout finishes', () => {
    render(<GlobalNoticeHost />);

    act(() => {
      useAppStore.getState().showNotice({
        message: '第一条提示',
        tone: 'info',
        durationMs: 1200,
      });
    });

    act(() => {
      vi.advanceTimersByTime(600);
    });

    act(() => {
      useAppStore.getState().showNotice({
        message: '第二条提示',
        tone: 'success',
        durationMs: 1200,
      });
    });

    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(screen.getByText('第二条提示')).not.toBeNull();
    expect(useAppStore.getState().ui.activeNotice?.message).toBe('第二条提示');
  });
});
