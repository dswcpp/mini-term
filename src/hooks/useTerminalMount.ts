import { useEffect, type RefObject } from 'react';
import {
  activateWebgl,
  clearAtlasForPty,
  getOrCreateTerminal,
  resizePtySafely,
} from '../utils/terminalCache';

function hasLayoutBox(container: HTMLElement): boolean {
  return container.clientWidth > 0 && container.clientHeight > 0;
}

function logTerminalMountError(context: string, error: unknown): void {
  // eslint-disable-next-line no-console
  console.warn(`[terminal] ${context}`, error);
}

/**
 * 把缓存的 xterm 实例挂到当前 React 容器，并维护 fit / WebGL / atlas 恢复链路。
 *
 * TerminalInstance 可能因 split/tab 切换频繁卸载重挂；这里统一管理所有 RAF 和 observer，
 * 避免卸载后残留的初始化回调继续操作已脱离 DOM 的 wrapper。
 */
export function useTerminalMount(
  ptyId: number,
  containerRef: RefObject<HTMLDivElement | null>,
) {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const { term, fitAddon, wrapper } = getOrCreateTerminal(ptyId);
    let disposed = false;
    const rafIds = new Set<number>();
    let settleId: ReturnType<typeof setTimeout> | undefined;

    const scheduleFrame = (cb: () => void) => {
      const id = requestAnimationFrame(() => {
        rafIds.delete(id);
        if (!disposed) cb();
      });
      rafIds.add(id);
      return id;
    };

    const cancelFrame = (id: number | undefined) => {
      if (id === undefined) return;
      cancelAnimationFrame(id);
      rafIds.delete(id);
    };

    const fitVisibleTerminal = () => {
      if (!hasLayoutBox(container)) return;
      try {
        fitAddon.fit();
      } catch (error) {
        logTerminalMountError('fit failed', error);
      }
    };

    const refreshVisibleTerminal = () => {
      if (!hasLayoutBox(container)) return;
      try {
        fitAddon.fit();
        if (term.rows > 0) term.refresh(0, term.rows - 1);
      } catch (error) {
        logTerminalMountError('refresh failed', error);
      }
    };

    container.appendChild(wrapper);

    // fit() 前记住滚动位置（appendChild 不触发 reflow，buffer 状态尚未改变）
    const bufBefore = term.buffer.active;
    const mountWasAtBottom = bufBefore.baseY + term.rows >= bufBefore.length;

    scheduleFrame(() => {
      if (!hasLayoutBox(container)) return;
      try {
        fitAddon.fit();
        resizePtySafely(ptyId, term.cols, term.rows);
        if (term.rows > 0) term.refresh(0, term.rows - 1);
      } catch (error) {
        logTerminalMountError('initial fit failed', error);
        return;
      }
      // split/remount 后视口可能停留在 buffer 顶部，滚回光标位置
      if (mountWasAtBottom) {
        try { term.scrollToBottom(); } catch (error) { logTerminalMountError('scroll failed', error); }
      }
      // 等 canvas 渲染器首帧合成上屏后再加载 WebGL，避免替换 canvas 时闪白
      scheduleFrame(() => {
        try {
          activateWebgl(ptyId);
        } catch (error) {
          logTerminalMountError('activate webgl failed', error);
          return;
        }
        // mount 后强制 clearTextureAtlas,见 spec/frontend/xterm-webgl-atlas-sharing.md
        scheduleFrame(() => {
          try { clearAtlasForPty(ptyId); } catch (error) { logTerminalMountError('clear atlas failed', error); }
        });
      });
    });

    // 初始值用挂载前采样值，避免 ResizeObserver 首次回调时 fit 已改变 buffer 状态
    let wasAtBottom = mountWasAtBottom;
    let resizing = false;
    let resizeRafId: number | undefined;
    const observer = new ResizeObserver(() => {
      if (!resizing) {
        const buf = term.buffer.active;
        wasAtBottom = buf.baseY + term.rows >= buf.length;
        resizing = true;
      }
      cancelFrame(resizeRafId);
      resizeRafId = scheduleFrame(() => {
        resizeRafId = undefined;
        fitVisibleTerminal();
      });
      // resize 结束后做一次完整刷新，修复 reflow 残留的空白行/空格
      clearTimeout(settleId);
      settleId = setTimeout(() => {
        if (disposed) return;
        cancelFrame(resizeRafId);
        resizeRafId = undefined;
        resizing = false;
        refreshVisibleTerminal();
        // split/resize 后若用户原本在底部，确保视口跟随光标
        if (wasAtBottom) {
          try { term.scrollToBottom(); } catch (error) { logTerminalMountError('scroll failed', error); }
        }
      }, 150);
    });
    observer.observe(container);

    const visibilityObserver = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        scheduleFrame(() => {
          refreshVisibleTerminal();
          // 可见性恢复时强制清 atlas 兜底 RenderService._isPaused 拦截期间的残留,
          // 见 .trellis/spec/frontend/xterm-webgl-atlas-sharing.md 「未覆盖路径」章节
          try { clearAtlasForPty(ptyId); } catch (error) { logTerminalMountError('clear atlas failed', error); }
        });
      }
    });
    visibilityObserver.observe(container);

    return () => {
      disposed = true;
      for (const id of rafIds) cancelAnimationFrame(id);
      rafIds.clear();
      clearTimeout(settleId);
      observer.disconnect();
      visibilityObserver.disconnect();
      wrapper.remove();
    };
  }, [containerRef, ptyId]);
}
