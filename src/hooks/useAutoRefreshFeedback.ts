import { useCallback, useEffect, useRef, useState } from 'react';

export type AutoRefreshFeedbackTone = 'refreshing' | 'refresh-success' | 'refresh-error';

export interface AutoRefreshFeedback {
  tone: AutoRefreshFeedbackTone;
  message: string;
}

export function useAutoRefreshFeedback(successDurationMs = 1500) {
  const [feedback, setFeedback] = useState<AutoRefreshFeedback | null>(null);
  const clearTimerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (clearTimerRef.current != null) {
      window.clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
  }, []);

  const clearFeedback = useCallback(() => {
    clearTimer();
    setFeedback(null);
  }, [clearTimer]);

  const showRefreshing = useCallback(
    (message = '正在同步最新内容') => {
      clearTimer();
      setFeedback({
        tone: 'refreshing',
        message,
      });
    },
    [clearTimer],
  );

  const showSuccess = useCallback(
    (message = '已自动刷新') => {
      clearTimer();
      setFeedback({
        tone: 'refresh-success',
        message,
      });
      clearTimerRef.current = window.setTimeout(() => {
        setFeedback(null);
        clearTimerRef.current = null;
      }, successDurationMs);
    },
    [clearTimer, successDurationMs],
  );

  const showError = useCallback(
    (message = '自动刷新失败') => {
      clearTimer();
      setFeedback({
        tone: 'refresh-error',
        message,
      });
    },
    [clearTimer],
  );

  useEffect(() => clearTimer, [clearTimer]);

  return {
    feedback,
    clearFeedback,
    showRefreshing,
    showSuccess,
    showError,
  };
}
