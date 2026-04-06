import { describe, expect, it } from 'vitest';
import { isIgnorableWindowIssue } from './runtimeErrorFilter';

describe('isIgnorableWindowIssue', () => {
  it('ignores known ResizeObserver browser noise', () => {
    expect(isIgnorableWindowIssue('ResizeObserver loop limit exceeded')).toBe(true);
    expect(isIgnorableWindowIssue('ResizeObserver loop completed with undelivered notifications.')).toBe(true);
    expect(isIgnorableWindowIssue(new Error('ResizeObserver loop completed with undelivered notifications.'))).toBe(true);
    expect(isIgnorableWindowIssue({ message: 'ResizeObserver loop limit exceeded' })).toBe(true);
  });

  it('keeps real application errors fatal', () => {
    expect(isIgnorableWindowIssue(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isIgnorableWindowIssue('Unhandled Promise Rejection')).toBe(false);
    expect(isIgnorableWindowIssue(undefined)).toBe(false);
  });
});
