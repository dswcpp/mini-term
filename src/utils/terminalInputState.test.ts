import { describe, expect, it } from 'vitest';
import {
  applyCompletionEditToState,
  applyTerminalInputData,
  buildCompletionSequence,
  createTerminalInputState,
} from './terminalInputState';

describe('terminalInputState', () => {
  it('tracks printable input and cursor movement without leaking ANSI sequences', () => {
    let state = createTerminalInputState();
    state = applyTerminalInputData(state, 'git status');
    state = applyTerminalInputData(state, '\x1b[D\x1b[D');

    expect(state.text).toBe('git status');
    expect(state.cursor).toBe('git stat'.length);
    expect(state.unsafe).toBe(false);
  });

  it('marks the state unsafe for history navigation sequences', () => {
    let state = createTerminalInputState();
    state = applyTerminalInputData(state, 'git status');
    state = applyTerminalInputData(state, '\x1b[A');

    expect(state.unsafe).toBe(true);
    expect(state.text).toBe('');
    expect(state.cursor).toBe(0);
  });

  it('supports replacing a token in the middle of the line', () => {
    const current = {
      text: 'git sttus --short',
      cursor: 'git st'.length,
      version: 3,
      unsafe: false,
    };

    const next = applyCompletionEditToState(current, {
      replaceStart: 4,
      replaceEnd: 9,
      newText: 'status',
    });

    expect(next.text).toBe('git status --short');
    expect(next.cursor).toBe('git status'.length);
    expect(next.unsafe).toBe(false);
  });

  it('builds an edit sequence that rewrites only the active token', () => {
    const current = {
      text: 'git sttus --short',
      cursor: 'git st'.length,
      version: 1,
      unsafe: false,
    };

    const { data, nextState } = buildCompletionSequence(current, {
      replaceStart: 4,
      replaceEnd: 9,
      newText: 'status',
    });

    expect(data).toContain('\x1b[D');
    expect(data).toContain('\x1b[3~');
    expect(data).toContain('status');
    expect(nextState.text).toBe('git status --short');
  });
});
