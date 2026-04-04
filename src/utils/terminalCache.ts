import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { invoke } from '@tauri-apps/api/core';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { subscribePtyOutput } from '../runtime/tauriEventHub';
import { useAppStore } from '../store';
import { resolveTheme } from '../theme';
import {
  applyTerminalInputData,
  buildCompletionSequence,
  createTerminalInputState,
  markTerminalInputStateUnsafe,
  type TerminalInputState,
} from './terminalInputState';

export interface CachedTerminal {
  term: Terminal;
  fitAddon: FitAddon;
  wrapper: HTMLDivElement;
}

interface CachedEntry extends CachedTerminal {
  cleanup: () => void;
}

type InputListener = (value: string) => void;
type InputStateListener = (state: TerminalInputState) => void;
type KeyHandler = (event: KeyboardEvent) => boolean;

const cache = new Map<number, CachedEntry>();
const inputStates = new Map<number, TerminalInputState>();
const inputListeners = new Map<number, Set<InputListener>>();
const inputStateListeners = new Map<number, Set<InputStateListener>>();
const keyHandlers = new Map<number, KeyHandler>();

function notifyInputListeners(ptyId: number) {
  const value = inputStates.get(ptyId)?.text ?? '';
  const listeners = inputListeners.get(ptyId);
  if (!listeners) return;

  listeners.forEach((listener) => listener(value));
}

function notifyInputStateListeners(ptyId: number) {
  const state = inputStates.get(ptyId) ?? createTerminalInputState();
  const listeners = inputStateListeners.get(ptyId);
  if (!listeners) return;

  listeners.forEach((listener) => listener(state));
}

function updateInputState(ptyId: number, nextState: TerminalInputState) {
  inputStates.set(ptyId, nextState);
  notifyInputListeners(ptyId);
  notifyInputStateListeners(ptyId);
}

export function mirrorTerminalInput(ptyId: number, data: string): void {
  updateInputState(ptyId, applyTerminalInputData(inputStates.get(ptyId), data));
}

export function subscribeTerminalInput(ptyId: number, listener: InputListener): () => void {
  const listeners = inputListeners.get(ptyId) ?? new Set<InputListener>();
  listeners.add(listener);
  inputListeners.set(ptyId, listeners);
  listener(inputStates.get(ptyId)?.text ?? '');

  return () => {
    const current = inputListeners.get(ptyId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      inputListeners.delete(ptyId);
    }
  };
}

export function subscribeTerminalInputState(
  ptyId: number,
  listener: InputStateListener,
): () => void {
  const listeners = inputStateListeners.get(ptyId) ?? new Set<InputStateListener>();
  listeners.add(listener);
  inputStateListeners.set(ptyId, listeners);
  listener(inputStates.get(ptyId) ?? createTerminalInputState());

  return () => {
    const current = inputStateListeners.get(ptyId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      inputStateListeners.delete(ptyId);
    }
  };
}

export function getTerminalInputState(ptyId: number): TerminalInputState {
  return inputStates.get(ptyId) ?? createTerminalInputState();
}

export function registerTerminalKeyHandler(ptyId: number, handler: KeyHandler): () => void {
  keyHandlers.set(ptyId, handler);
  return () => {
    if (keyHandlers.get(ptyId) === handler) {
      keyHandlers.delete(ptyId);
    }
  };
}

export async function applyCompletionEdit(
  ptyId: number,
  edit: Parameters<typeof buildCompletionSequence>[1],
): Promise<boolean> {
  const currentState = inputStates.get(ptyId) ?? createTerminalInputState();
  if (currentState.unsafe) {
    return false;
  }

  const { data, nextState } = buildCompletionSequence(currentState, edit);
  updateInputState(ptyId, nextState);
  try {
    await invoke('write_pty', { ptyId, data });
    return true;
  } catch (error) {
    updateInputState(ptyId, currentState);
    throw error;
  }
}

export function markTerminalInputUnsafe(ptyId: number) {
  updateInputState(ptyId, markTerminalInputStateUnsafe(inputStates.get(ptyId)));
}

export function getOrCreateTerminal(ptyId: number): CachedTerminal {
  const existing = cache.get(ptyId);
  if (existing) {
    return existing;
  }

  const wrapper = document.createElement('div');
  wrapper.style.width = '100%';
  wrapper.style.height = '100%';

  const config = useAppStore.getState().config;
  const resolvedTheme = resolveTheme(config.theme);

  const term = new Terminal({
    fontSize: config.terminalFontSize ?? 14,
    fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
    fontWeight: '400',
    fontWeightBold: '600',
    cursorBlink: true,
    cursorStyle: 'bar',
    cursorWidth: 2,
    scrollback: 100000,
    letterSpacing: 0,
    lineHeight: 1.35,
    theme: resolvedTheme.preset.terminal,
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(wrapper);
  term.reset();

  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      webgl.dispose();
      term.refresh(0, term.rows - 1);
    });
    term.loadAddon(webgl);
  } catch {
    // Fall back to canvas when WebGL is unavailable.
  }

  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;

    const customHandler = keyHandlers.get(ptyId);
    if (customHandler && !customHandler(event)) {
      return false;
    }

    if (event.ctrlKey && event.shiftKey && event.code === 'KeyC') {
      event.preventDefault();
      const selection = term.getSelection();
      if (selection) {
        void writeText(selection);
      }
      return false;
    }

    if (event.ctrlKey && event.shiftKey && event.code === 'KeyV') {
      event.preventDefault();
      void readText().then((text) => {
        if (text) {
          mirrorTerminalInput(ptyId, text);
          void invoke('write_pty', { ptyId, data: text });
        }
      });
      return false;
    }

    return true;
  });

  const onDataDisposable = term.onData((data) => {
    term.scrollToBottom();
    mirrorTerminalInput(ptyId, data);
    void invoke('write_pty', { ptyId, data });
  });

  const onResizeDisposable = term.onResize(({ cols, rows }) => {
    void invoke('resize_pty', { ptyId, cols, rows });
  });

  let cancelled = false;
  let startupOutputReceived = false;
  let unlistenOutput: (() => void) | undefined;
  const bootstrapTimers = [
    window.setTimeout(() => {
      fitAddon.fit();
      term.refresh(0, term.rows - 1);
    }, 60),
    window.setTimeout(() => {
      fitAddon.fit();
      term.refresh(0, term.rows - 1);
    }, 180),
  ];

  void Promise.resolve()
    .then(() =>
      subscribePtyOutput(ptyId, (payload) => {
        if (payload.data) {
          startupOutputReceived = true;
        }
        term.write(payload.data);
      }),
    )
    .then((unlisten) => {
      if (cancelled) {
        unlisten();
        return undefined;
      }

      unlistenOutput = unlisten;
      return invoke<string>('take_startup_output', { ptyId });
    })
    .then((initialOutput) => {
      if (cancelled || !initialOutput || startupOutputReceived) {
        return;
      }

      startupOutputReceived = true;
      term.write(initialOutput);
      term.scrollToBottom();
      term.refresh(0, term.rows - 1);
    })
    .catch(console.error);

  const cleanup = () => {
    cancelled = true;
    bootstrapTimers.forEach((timer) => window.clearTimeout(timer));
    unlistenOutput?.();
    inputStates.delete(ptyId);
    inputListeners.delete(ptyId);
    inputStateListeners.delete(ptyId);
    keyHandlers.delete(ptyId);
    onDataDisposable.dispose();
    onResizeDisposable.dispose();
    term.dispose();
  };

  const entry: CachedEntry = { term, fitAddon, wrapper, cleanup };
  cache.set(ptyId, entry);
  return entry;
}

export function getCachedTerminal(ptyId: number): CachedTerminal | undefined {
  return cache.get(ptyId);
}

export function disposeTerminal(ptyId: number): void {
  const entry = cache.get(ptyId);
  if (!entry) return;

  entry.wrapper.remove();
  entry.cleanup();
  cache.delete(ptyId);
}
