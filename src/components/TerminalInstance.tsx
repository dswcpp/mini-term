import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { PtyOutputPayload } from '../types';
import { showContextMenu } from '../utils/contextMenu';
import '@xterm/xterm/css/xterm.css';

interface Props {
  ptyId: number;
  paneId?: string;
  onSplit?: (paneId: string, direction: 'horizontal' | 'vertical') => void;
  onClose?: (paneId: string) => void;
}

export function TerminalInstance({ ptyId, paneId, onSplit, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
      fontWeight: '400',
      fontWeightBold: '600',
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      scrollback: 5000,
      letterSpacing: 0,
      lineHeight: 1.35,
      theme: {
        background: '#100f0d',
        foreground: '#d8d4cc',
        cursor: '#c8805a',
        cursorAccent: '#100f0d',
        selectionBackground: '#c8805a30',
        selectionForeground: '#e5e0d8',
        black: '#2a2824',
        red: '#d4605a',
        green: '#6bb87a',
        yellow: '#d4a84a',
        blue: '#6896c8',
        magenta: '#b08cd4',
        cyan: '#7dcfb8',
        white: '#d8d4cc',
        brightBlack: '#5c5850',
        brightRed: '#e07060',
        brightGreen: '#80d090',
        brightYellow: '#e0b860',
        brightBlue: '#80aad8',
        brightMagenta: '#c0a0e0',
        brightCyan: '#90e0c8',
        brightWhite: '#e5e0d8',
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // WebGL 不支持时回退到 Canvas
    }

    fitAddon.fit();
    termRef.current = term;
    fitAddonRef.current = fitAddon;

    invoke('resize_pty', { ptyId, cols: term.cols, rows: term.rows });

    const onDataDisposable = term.onData((data) => {
      invoke('write_pty', { ptyId, data });
    });

    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<PtyOutputPayload>('pty-output', (event) => {
      if (event.payload.ptyId === ptyId) {
        term.write(event.payload.data);
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    const onResizeDisposable = term.onResize(({ cols, rows }) => {
      invoke('resize_pty', { ptyId, cols, rows });
    });

    let rafId: number;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => fitAddon.fit());
    });
    observer.observe(containerRef.current);

    return () => {
      cancelled = true;
      unlisten?.();
      cancelAnimationFrame(rafId);
      observer.disconnect();
      onDataDisposable.dispose();
      onResizeDisposable.dispose();
      term.dispose();
    };
  }, [ptyId]);

  return (
    <div
      className="w-full h-full relative"
      onDragEnter={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setDragOver(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const filePath = e.dataTransfer.getData('text/plain');
        if (filePath) {
          invoke('write_pty', { ptyId, data: filePath });
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (!paneId || !onSplit) return;

        showContextMenu(e.clientX, e.clientY, [
          { label: '向右分屏', onClick: () => onSplit(paneId, 'horizontal') },
          { label: '向下分屏', onClick: () => onSplit(paneId, 'vertical') },
          { separator: true },
          { label: '关闭面板', danger: true, onClick: () => onClose?.(paneId) },
        ]);
      }}
    >
      {/* xterm.js 渲染容器 */}
      <div ref={containerRef} className="absolute inset-0" />

      {/* 拖拽视觉提示（纯展示，不拦截事件） */}
      {dragOver && (
        <div
          className="absolute inset-1 z-10 flex items-center justify-center pointer-events-none rounded-[var(--radius-md)]"
          style={{ background: 'rgba(200, 128, 90, 0.06)', border: '2px dashed var(--accent)' }}
        >
          <span className="text-[var(--accent)] text-xs px-3 py-1.5 rounded-[var(--radius-md)]"
            style={{ background: 'var(--bg-overlay)' }}>
            释放以插入路径
          </span>
        </div>
      )}
    </div>
  );
}
