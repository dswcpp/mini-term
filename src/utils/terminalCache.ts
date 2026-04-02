import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { useAppStore } from '../store';
import { resolveTheme } from '../theme';
import type { PtyOutputPayload } from '../types';

export interface CachedTerminal {
  term: Terminal;
  fitAddon: FitAddon;
  wrapper: HTMLDivElement;
}

interface CachedEntry extends CachedTerminal {
  cleanup: () => void;
}

const cache = new Map<number, CachedEntry>();

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
          void invoke('write_pty', { ptyId, data: text });
        }
      });
      return false;
    }

    return true;
  });

  const onDataDisposable = term.onData((data) => {
    term.scrollToBottom();
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

  void listen<PtyOutputPayload>('pty-output', (event) => {
    if (event.payload.ptyId !== ptyId) {
      return;
    }

    if (event.payload.data) {
      startupOutputReceived = true;
    }
    term.write(event.payload.data);
  })
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
