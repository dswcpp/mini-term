import type { CompletionEdit } from './terminalCompletion/types';

export interface TerminalInputState {
  text: string;
  cursor: number;
  version: number;
  unsafe: boolean;
}

interface MutableInputState {
  text: string;
  cursor: number;
  version: number;
  unsafe: boolean;
}

const CSI = '\x1b[';
const LEFT = `${CSI}D`;
const RIGHT = `${CSI}C`;
const DELETE = `${CSI}3~`;
const MAX_INPUT_LENGTH = 4096;

export function createTerminalInputState(): TerminalInputState {
  return {
    text: '',
    cursor: 0,
    version: 0,
    unsafe: false,
  };
}

function clampCursor(cursor: number, text: string) {
  return Math.max(0, Math.min(cursor, text.length));
}

function finalizeState(state: MutableInputState): TerminalInputState {
  if (state.text.length > MAX_INPUT_LENGTH) {
    const overflow = state.text.length - MAX_INPUT_LENGTH;
    state.text = state.text.slice(overflow);
    state.cursor = clampCursor(state.cursor - overflow, state.text);
  }

  state.cursor = clampCursor(state.cursor, state.text);
  return {
    text: state.text,
    cursor: state.cursor,
    version: state.version,
    unsafe: state.unsafe,
  };
}

function markChanged(state: MutableInputState) {
  state.version += 1;
}

function resetLine(state: MutableInputState) {
  if (state.text !== '' || state.cursor !== 0 || state.unsafe) {
    state.text = '';
    state.cursor = 0;
    state.unsafe = false;
    markChanged(state);
  }
}

function setUnsafe(state: MutableInputState) {
  if (!state.unsafe || state.text !== '' || state.cursor !== 0) {
    state.text = '';
    state.cursor = 0;
    state.unsafe = true;
    markChanged(state);
  }
}

function insertText(state: MutableInputState, value: string) {
  if (state.unsafe || value.length === 0) return;
  state.text = `${state.text.slice(0, state.cursor)}${value}${state.text.slice(state.cursor)}`;
  state.cursor += value.length;
  markChanged(state);
}

function deleteBackward(state: MutableInputState) {
  if (state.unsafe || state.cursor === 0) return;
  state.text = `${state.text.slice(0, state.cursor - 1)}${state.text.slice(state.cursor)}`;
  state.cursor -= 1;
  markChanged(state);
}

function deleteForward(state: MutableInputState) {
  if (state.unsafe || state.cursor >= state.text.length) return;
  state.text = `${state.text.slice(0, state.cursor)}${state.text.slice(state.cursor + 1)}`;
  markChanged(state);
}

function moveCursor(state: MutableInputState, delta: number) {
  if (state.unsafe) return;
  const next = clampCursor(state.cursor + delta, state.text);
  if (next !== state.cursor) {
    state.cursor = next;
    markChanged(state);
  }
}

function moveToEdge(state: MutableInputState, edge: 'start' | 'end') {
  if (state.unsafe) return;
  const next = edge === 'start' ? 0 : state.text.length;
  if (next !== state.cursor) {
    state.cursor = next;
    markChanged(state);
  }
}

function deleteToLineStart(state: MutableInputState) {
  if (state.unsafe || state.cursor === 0) return;
  state.text = state.text.slice(state.cursor);
  state.cursor = 0;
  markChanged(state);
}

function parseEscapeSequence(data: string, start: number): {
  consumed: number;
  apply: (state: MutableInputState) => void;
} {
  const next = data[start + 1];
  if (!next) {
    return { consumed: 1, apply: setUnsafe };
  }

  if (next === '[') {
    let cursor = start + 2;
    let params = '';

    while (cursor < data.length) {
      const ch = data[cursor];
      if ((ch >= '0' && ch <= '9') || ch === ';') {
        params += ch;
        cursor += 1;
        continue;
      }

      const consumed = cursor - start + 1;
      switch (ch) {
        case 'D':
          return { consumed, apply: (state) => moveCursor(state, -1) };
        case 'C':
          return { consumed, apply: (state) => moveCursor(state, 1) };
        case 'H':
          return { consumed, apply: (state) => moveToEdge(state, 'start') };
        case 'F':
          return { consumed, apply: (state) => moveToEdge(state, 'end') };
        case '~':
          switch (params) {
            case '1':
            case '7':
              return { consumed, apply: (state) => moveToEdge(state, 'start') };
            case '4':
            case '8':
              return { consumed, apply: (state) => moveToEdge(state, 'end') };
            case '3':
              return { consumed, apply: deleteForward };
            default:
              return { consumed, apply: setUnsafe };
          }
        default:
          return { consumed, apply: setUnsafe };
      }
    }

    return { consumed: data.length - start, apply: setUnsafe };
  }

  if (next === 'O') {
    const command = data[start + 2];
    if (!command) {
      return { consumed: 2, apply: setUnsafe };
    }

    switch (command) {
      case 'H':
        return { consumed: 3, apply: (state) => moveToEdge(state, 'start') };
      case 'F':
        return { consumed: 3, apply: (state) => moveToEdge(state, 'end') };
      default:
        return { consumed: 3, apply: setUnsafe };
    }
  }

  return { consumed: 2, apply: setUnsafe };
}

export function applyTerminalInputData(
  currentState: TerminalInputState | undefined,
  data: string,
): TerminalInputState {
  const state: MutableInputState = { ...(currentState ?? createTerminalInputState()) };

  for (let index = 0; index < data.length;) {
    const ch = data[index];

    switch (ch) {
      case '\r':
      case '\n':
      case '\x03':
        resetLine(state);
        index += 1;
        break;
      case '\x04':
        if (!state.unsafe && state.text.length > 0 && state.cursor < state.text.length) {
          deleteForward(state);
        } else {
          resetLine(state);
        }
        index += 1;
        break;
      case '\x01':
        moveToEdge(state, 'start');
        index += 1;
        break;
      case '\x05':
        moveToEdge(state, 'end');
        index += 1;
        break;
      case '\x15':
        if (state.unsafe) {
          resetLine(state);
        } else {
          deleteToLineStart(state);
        }
        index += 1;
        break;
      case '\x7f':
      case '\x08':
        deleteBackward(state);
        index += 1;
        break;
      case '\x1b': {
        const sequence = parseEscapeSequence(data, index);
        sequence.apply(state);
        index += sequence.consumed;
        break;
      }
      default:
        if (ch >= ' ') {
          insertText(state, ch);
        }
        index += 1;
        break;
    }
  }

  return finalizeState(state);
}

export function applyCompletionEditToState(
  currentState: TerminalInputState | undefined,
  edit: CompletionEdit,
): TerminalInputState {
  const state = currentState ?? createTerminalInputState();
  const replaceStart = clampCursor(edit.replaceStart, state.text);
  const replaceEnd = clampCursor(Math.max(edit.replaceStart, edit.replaceEnd), state.text);
  const nextText = `${state.text.slice(0, replaceStart)}${edit.newText}${state.text.slice(replaceEnd)}`;
  const nextCursor = clampCursor(edit.nextCursor ?? replaceStart + edit.newText.length, nextText);

  return {
    text: nextText,
    cursor: nextCursor,
    version: state.version + 1,
    unsafe: false,
  };
}

export function markTerminalInputStateUnsafe(
  currentState: TerminalInputState | undefined,
): TerminalInputState {
  const state = currentState ?? createTerminalInputState();
  return {
    text: '',
    cursor: 0,
    version: state.version + 1,
    unsafe: true,
  };
}

export function buildCompletionSequence(
  currentState: TerminalInputState | undefined,
  edit: CompletionEdit,
): { data: string; nextState: TerminalInputState } {
  const state = currentState ?? createTerminalInputState();
  const replaceStart = clampCursor(edit.replaceStart, state.text);
  const replaceEnd = clampCursor(Math.max(edit.replaceStart, edit.replaceEnd), state.text);
  const nextState = applyCompletionEditToState(state, edit);

  let data = '';
  if (state.cursor > replaceStart) {
    data += LEFT.repeat(state.cursor - replaceStart);
  } else if (state.cursor < replaceStart) {
    data += RIGHT.repeat(replaceStart - state.cursor);
  }

  if (replaceEnd > replaceStart) {
    data += DELETE.repeat(replaceEnd - replaceStart);
  }

  data += edit.newText;

  const insertionCursor = replaceStart + edit.newText.length;
  if (nextState.cursor < insertionCursor) {
    data += LEFT.repeat(insertionCursor - nextState.cursor);
  } else if (nextState.cursor > insertionCursor) {
    data += RIGHT.repeat(nextState.cursor - insertionCursor);
  }

  return { data, nextState };
}

export function isSameCompletionEdit(
  state: TerminalInputState | undefined,
  edit: CompletionEdit,
): boolean {
  const currentState = state ?? createTerminalInputState();
  const replaceStart = clampCursor(edit.replaceStart, currentState.text);
  const replaceEnd = clampCursor(Math.max(edit.replaceStart, edit.replaceEnd), currentState.text);
  const currentText = currentState.text.slice(replaceStart, replaceEnd);
  const currentCursor = clampCursor(currentState.cursor, currentState.text);
  const nextCursor = edit.nextCursor ?? replaceStart + edit.newText.length;

  return currentText === edit.newText && currentCursor === nextCursor;
}
