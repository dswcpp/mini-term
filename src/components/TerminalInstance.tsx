import { useEffect, useRef, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store';
import { getOrCreateTerminal, getCachedTerminal, activateWebgl, getTerminalTheme, DARK_TERMINAL_THEME, writePtyInput, copyTerminalSelection, pasteToTerminal } from '../utils/terminalCache';
import { getResolvedTheme } from '../utils/themeManager';
import { showContextMenu } from '../utils/contextMenu';
import { isFileDragging, getFileDragPath } from '../utils/fileDragState';
import '@xterm/xterm/css/xterm.css';

interface Props {
  ptyId: number;
}

export function TerminalInstance({ ptyId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [fileDrag, setFileDrag] = useState(false);
  const terminalFontSize = useAppStore((s) => s.config.terminalFontSize);
  const terminalFollowTheme = useAppStore((s) => s.config.terminalFollowTheme);

  // 终端不跟随主题且处于浅色模式时，覆写 CSS 变量让整个终端区域（含 .xterm）统一深色
  const forceDarkBg = !terminalFollowTheme && getResolvedTheme() === 'light';
  const termStyle = forceDarkBg
    ? { '--bg-terminal': DARK_TERMINAL_THEME.background } as React.CSSProperties
    : undefined;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const { term, fitAddon, wrapper } = getOrCreateTerminal(ptyId);

    container.appendChild(wrapper);

    // fit() 前记住滚动位置（appendChild 不触发 reflow，buffer 状态尚未改变）
    const bufBefore = term.buffer.active;
    const mountWasAtBottom = bufBefore.baseY + term.rows >= bufBefore.length;

    requestAnimationFrame(() => {
      if (container.clientWidth > 0 && container.clientHeight > 0) {
        fitAddon.fit();
        invoke('resize_pty', { ptyId, cols: term.cols, rows: term.rows });
        term.refresh(0, term.rows - 1);
        // split/remount 后视口可能停留在 buffer 顶部，滚回光标位置
        if (mountWasAtBottom) term.scrollToBottom();
        // 等 canvas 渲染器首帧合成上屏后再加载 WebGL，避免替换 canvas 时闪白
        requestAnimationFrame(() => activateWebgl(ptyId));
      }
    });

    let rafId: number;
    let settleId: ReturnType<typeof setTimeout>;
    // 初始值用挂载前采样值，避免 ResizeObserver 首次回调时 fit 已改变 buffer 状态
    let wasAtBottom = mountWasAtBottom;
    let resizing = false;
    const observer = new ResizeObserver(() => {
      if (!resizing) {
        const buf = term.buffer.active;
        wasAtBottom = buf.baseY + term.rows >= buf.length;
        resizing = true;
      }
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        if (container.clientWidth > 0 && container.clientHeight > 0) {
          fitAddon.fit();
        }
      });
      // resize 结束后做一次完整刷新，修复 reflow 残留的空白行/空格
      clearTimeout(settleId);
      settleId = setTimeout(() => {
        resizing = false;
        if (container.clientWidth > 0 && container.clientHeight > 0) {
          fitAddon.fit();
          term.refresh(0, term.rows - 1);
          // split/resize 后若用户原本在底部，确保视口跟随光标
          if (wasAtBottom) term.scrollToBottom();
        }
      }, 150);
    });
    observer.observe(container);

    const visibilityObserver = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        requestAnimationFrame(() => {
          fitAddon.fit();
          term.refresh(0, term.rows - 1);
        });
      }
    });
    visibilityObserver.observe(container);

    return () => {
      cancelAnimationFrame(rafId);
      clearTimeout(settleId);
      observer.disconnect();
      visibilityObserver.disconnect();
      wrapper.remove();
    };
  }, [ptyId]);

  useEffect(() => {
    const cached = getCachedTerminal(ptyId);
    if (cached && terminalFontSize) {
      cached.term.options.fontSize = terminalFontSize;
      cached.fitAddon.fit();
    }
  }, [terminalFontSize, ptyId]);

  useEffect(() => {
    const handler = () => {
      const cached = getCachedTerminal(ptyId);
      if (cached) {
        const { config } = useAppStore.getState();
        cached.term.options.theme = getTerminalTheme(config.terminalFollowTheme ?? true);
      }
    };
    window.addEventListener('theme-changed', handler);
    return () => window.removeEventListener('theme-changed', handler);
  }, [ptyId]);

  // 自定义鼠标拖拽（替代 HTML5 DnD，规避 WebView2 dragDropEnabled 拦截）
  const dropZoneRef = useRef<HTMLDivElement>(null);

  const handleMouseMove = useCallback(() => {
    if (isFileDragging() && !fileDrag) setFileDrag(true);
  }, [fileDrag]);

  const handleMouseLeave = useCallback(() => {
    if (fileDrag) setFileDrag(false);
  }, [fileDrag]);

  const handleMouseUp = useCallback(() => {
    const path = getFileDragPath();
    if (path) {
      setFileDrag(false);
      void writePtyInput(ptyId, `"${path}"`);
      getCachedTerminal(ptyId)?.term.focus();
    }
  }, [ptyId]);

  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const hasSelection = !!getCachedTerminal(ptyId)?.term.getSelection();
    showContextMenu(e.clientX, e.clientY, [
      {
        label: '复制',
        disabled: !hasSelection,
        onClick: () => { void copyTerminalSelection(ptyId); },
      },
      {
        label: '粘贴',
        onClick: () => {
          void pasteToTerminal(ptyId);
          getCachedTerminal(ptyId)?.term.focus();
        },
      },
    ]);
  };

  return (
    <div className="w-full h-full flex flex-col">
      <div
        ref={dropZoneRef}
        className="flex-1 relative bg-[var(--bg-terminal)]"
        style={termStyle}
        data-terminal-drop
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onMouseUp={handleMouseUp}
        onContextMenu={handleContextMenu}
      >
        <div ref={containerRef} className="absolute top-1.5 bottom-0 left-2.5 right-0 cursor-none" />

        {fileDrag && (
          <div
            className="absolute inset-1 z-10 flex items-center justify-center pointer-events-none rounded-[var(--radius-md)]"
            style={{ background: 'var(--accent-subtle)', border: '2px dashed var(--accent)' }}
          >
            <span className="text-[var(--accent)] text-xs px-3 py-1.5 rounded-[var(--radius-md)]"
              style={{ background: 'var(--bg-overlay)' }}>
              释放以插入路径
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
