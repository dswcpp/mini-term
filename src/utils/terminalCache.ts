import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { subscribeSessionOutput } from '../runtime/tauriEventHub';
import {
  takeTerminalStartupOutput,
  writeTerminalInput,
} from '../runtime/terminalApi';
import { clearTerminalOutput, queueTerminalOutput } from '../runtime/terminalOutputScheduler';
import { useAppStore } from '../store';
import { resolveTheme } from '../theme';
import {
  applyTerminalInputData,
  buildCompletionSequence,
  createTerminalInputState,
  markTerminalInputStateUnsafe,
  type TerminalInputState,
} from './terminalInputState';
import { getSessionIdForPty } from './session';

export interface CachedTerminal {
  term: Terminal;
  fitAddon: FitAddon;
  wrapper: HTMLDivElement;
}

interface CachedEntry extends CachedTerminal {
  sessionId: string;
  currentPtyId: number;
  cleanup: () => void;
  rebind: (ptyId: number) => void;
}

type TerminalIdentity = number | string;
type InputListener = (value: string) => void;
type InputStateListener = (state: TerminalInputState) => void;
type KeyHandler = (event: KeyboardEvent) => boolean;

const cache = new Map<string, CachedEntry>();
const ptyToSessionKey = new Map<number, string>();
const inputStates = new Map<string, TerminalInputState>();
const inputListeners = new Map<string, Set<InputListener>>();
const inputStateListeners = new Map<string, Set<InputStateListener>>();
const keyHandlers = new Map<string, KeyHandler>();

function resolveSessionKey(identity: TerminalIdentity) {
  if (typeof identity === 'string') {
    return identity;
  }

  const state = useAppStore.getState();
  return (
    ptyToSessionKey.get(identity)
    ?? state.sessionIdByPty.get(identity)
    ?? state.sessions.get(identity)?.sessionId
    ?? getSessionIdForPty(identity)
  );
}

function resolvePtyId(identity: TerminalIdentity, fallbackPtyId?: number) {
  if (typeof identity === 'number') {
    return identity;
  }

  const cached = cache.get(identity);
  if (cached) {
    return cached.currentPtyId;
  }

  const state = useAppStore.getState();
  return fallbackPtyId
    ?? state.ptyBySessionId.get(identity)
    ?? state.terminalSessions.get(identity)?.ptyId
    ?? -1;
}

function notifyInputListeners(sessionKey: string) {
  const value = inputStates.get(sessionKey)?.text ?? '';
  const listeners = inputListeners.get(sessionKey);
  if (!listeners) {
    return;
  }

  listeners.forEach((listener) => listener(value));
}

function notifyInputStateListeners(sessionKey: string) {
  const state = inputStates.get(sessionKey) ?? createTerminalInputState();
  const listeners = inputStateListeners.get(sessionKey);
  if (!listeners) {
    return;
  }

  listeners.forEach((listener) => listener(state));
}

function updateInputState(sessionKey: string, nextState: TerminalInputState) {
  inputStates.set(sessionKey, nextState);
  notifyInputListeners(sessionKey);
  notifyInputStateListeners(sessionKey);
}

function resetInputState(sessionKey: string) {
  updateInputState(sessionKey, createTerminalInputState());
}

export function mirrorTerminalInput(identity: TerminalIdentity, data: string): void {
  const sessionKey = resolveSessionKey(identity);
  updateInputState(sessionKey, applyTerminalInputData(inputStates.get(sessionKey), data));
}

export function subscribeTerminalInput(identity: TerminalIdentity, listener: InputListener): () => void {
  const sessionKey = resolveSessionKey(identity);
  const listeners = inputListeners.get(sessionKey) ?? new Set<InputListener>();
  listeners.add(listener);
  inputListeners.set(sessionKey, listeners);
  listener(inputStates.get(sessionKey)?.text ?? '');

  return () => {
    const current = inputListeners.get(sessionKey);
    if (!current) {
      return;
    }
    current.delete(listener);
    if (current.size === 0) {
      inputListeners.delete(sessionKey);
    }
  };
}

export function subscribeTerminalInputState(
  identity: TerminalIdentity,
  listener: InputStateListener,
): () => void {
  const sessionKey = resolveSessionKey(identity);
  const listeners = inputStateListeners.get(sessionKey) ?? new Set<InputStateListener>();
  listeners.add(listener);
  inputStateListeners.set(sessionKey, listeners);
  listener(inputStates.get(sessionKey) ?? createTerminalInputState());

  return () => {
    const current = inputStateListeners.get(sessionKey);
    if (!current) {
      return;
    }
    current.delete(listener);
    if (current.size === 0) {
      inputStateListeners.delete(sessionKey);
    }
  };
}

export function getTerminalInputState(identity: TerminalIdentity): TerminalInputState {
  return inputStates.get(resolveSessionKey(identity)) ?? createTerminalInputState();
}

export function registerTerminalKeyHandler(identity: TerminalIdentity, handler: KeyHandler): () => void {
  const sessionKey = resolveSessionKey(identity);
  keyHandlers.set(sessionKey, handler);
  return () => {
    if (keyHandlers.get(sessionKey) === handler) {
      keyHandlers.delete(sessionKey);
    }
  };
}

export async function applyCompletionEdit(
  identity: TerminalIdentity,
  edit: Parameters<typeof buildCompletionSequence>[1],
): Promise<boolean> {
  const sessionKey = resolveSessionKey(identity);
  const currentState = inputStates.get(sessionKey) ?? createTerminalInputState();
  if (currentState.unsafe) {
    return false;
  }

  const { data, nextState } = buildCompletionSequence(currentState, edit);
  updateInputState(sessionKey, nextState);
  try {
    await writeTerminalInput(sessionKey, data);
    return true;
  } catch (error) {
    updateInputState(sessionKey, currentState);
    throw error;
  }
}

export function markTerminalInputUnsafe(identity: TerminalIdentity) {
  const sessionKey = resolveSessionKey(identity);
  updateInputState(sessionKey, markTerminalInputStateUnsafe(inputStates.get(sessionKey)));
}

function removePtyBindingsForSession(sessionId: string) {
  for (const [ptyId, mappedSessionId] of ptyToSessionKey.entries()) {
    if (mappedSessionId === sessionId) {
      ptyToSessionKey.delete(ptyId);
    }
  }
}

function createCachedEntry(ptyId: number, sessionId: string): CachedEntry {
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

  let currentPtyId = ptyId;
  let cancelled = false;
  let startupOutputReceived = false;
  let unlistenOutput: (() => void) | undefined;
  let bootstrapTimers: number[] = [];

  const bindOutput = (nextPtyId: number, resetTerminal = false) => {
    const previousPtyId = currentPtyId;
    currentPtyId = nextPtyId;
    ptyToSessionKey.set(nextPtyId, sessionId);
    if (previousPtyId !== nextPtyId) {
      ptyToSessionKey.delete(previousPtyId);
    }

    if (resetTerminal) {
      clearTerminalOutput(sessionId);
      resetInputState(sessionId);
      term.reset();
      term.clear();
    }

    bootstrapTimers.forEach((timer) => window.clearTimeout(timer));
    bootstrapTimers = [];
    startupOutputReceived = false;
    unlistenOutput?.();
    unlistenOutput = subscribeSessionOutput(sessionId, (payload) => {
      if (payload.data) {
        startupOutputReceived = true;
      }
      queueTerminalOutput(sessionId, (chunk) => {
        term.write(chunk);
      }, payload.data);
    });

    bootstrapTimers = [
      window.setTimeout(() => {
        fitAddon.fit();
        term.refresh(0, term.rows - 1);
      }, 60),
      window.setTimeout(() => {
        fitAddon.fit();
        term.refresh(0, term.rows - 1);
      }, 180),
    ];

    void takeTerminalStartupOutput(sessionId)
      .then((initialOutput) => {
        if (cancelled || !initialOutput || startupOutputReceived) {
          return;
        }

        startupOutputReceived = true;
        queueTerminalOutput(sessionId, (chunk) => {
          term.write(chunk);
          term.scrollToBottom();
          term.refresh(0, term.rows - 1);
        }, initialOutput);
      })
      .catch(console.error);
  };

  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') {
      return true;
    }

    const customHandler = keyHandlers.get(sessionId);
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
          mirrorTerminalInput(currentPtyId, text);
          void writeTerminalInput(sessionId, text);
        }
      });
      return false;
    }

    return true;
  });

  const onDataDisposable = term.onData((data) => {
    term.scrollToBottom();
    mirrorTerminalInput(currentPtyId, data);
    void writeTerminalInput(sessionId, data);
  });

  bindOutput(ptyId);

  const cleanup = () => {
    cancelled = true;
    bootstrapTimers.forEach((timer) => window.clearTimeout(timer));
    clearTerminalOutput(sessionId);
    unlistenOutput?.();
    removePtyBindingsForSession(sessionId);
    inputStates.delete(sessionId);
    inputListeners.delete(sessionId);
    inputStateListeners.delete(sessionId);
    keyHandlers.delete(sessionId);
    onDataDisposable.dispose();
    term.dispose();
  };

  return {
    term,
    fitAddon,
    wrapper,
    sessionId,
    currentPtyId: ptyId,
    cleanup,
    rebind: (nextPtyId: number) => {
      const shouldReset = nextPtyId !== currentPtyId;
      bindOutput(nextPtyId, shouldReset);
    },
  };
}

export function getOrCreateTerminal(identity: TerminalIdentity, nextPtyId?: number): CachedTerminal {
  const sessionId = resolveSessionKey(identity);
  const existing = cache.get(sessionId);
  const ptyId = resolvePtyId(identity, nextPtyId);
  if (existing) {
    if (ptyId >= 0) {
      existing.rebind(ptyId);
    }
    return existing;
  }

  if (ptyId < 0) {
    throw new Error(`Unable to resolve PTY for terminal session ${sessionId}`);
  }

  const entry = createCachedEntry(ptyId, sessionId);
  cache.set(sessionId, entry);
  return entry;
}

export function getCachedTerminal(identity: TerminalIdentity): CachedTerminal | undefined {
  return cache.get(resolveSessionKey(identity));
}

export function disposeTerminalBySession(sessionId: string): void {
  const entry = cache.get(sessionId);
  if (!entry) {
    return;
  }

  entry.wrapper.remove();
  entry.cleanup();
  cache.delete(sessionId);
}

export function disposeTerminal(identity: TerminalIdentity): void {
  disposeTerminalBySession(resolveSessionKey(identity));
}
