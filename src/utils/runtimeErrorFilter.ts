const BENIGN_WINDOW_ERROR_PATTERNS = [
  /ResizeObserver loop limit exceeded/i,
  /ResizeObserver loop completed with undelivered notifications/i,
] as const;

function extractErrorText(value: unknown): string {
  if (value instanceof Error) {
    return value.message || value.name || '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (value && typeof value === 'object') {
    const maybeMessage = Reflect.get(value, 'message');
    if (typeof maybeMessage === 'string') {
      return maybeMessage;
    }
  }

  return '';
}

export function isIgnorableWindowIssue(value: unknown) {
  const message = extractErrorText(value).trim();
  if (!message) {
    return false;
  }

  return BENIGN_WINDOW_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}
