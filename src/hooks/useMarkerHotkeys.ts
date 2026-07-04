import { useEffect, useRef } from 'react';
import { useAppStore } from '../store';
import { scrollToMarker } from '../utils/terminalCache';
import type { SplitNode } from '../types';

/// 多分屏下,DOM focus 是判断"用户当前操作哪个 pane"最准确的信号:
/// 用户输入时 xterm textarea 是 document.activeElement,它的最近祖先
/// `[data-pty-id]` 就是当前 PaneGroup 的 active pane ptyId。
///
/// 失败时(如焦点在弹窗、菜单、body)回退到 findActivePaneIdInTree,
/// 行为与之前一致(命中树里第一个 leaf 的 activePaneId)。
function findFocusedPtyIdFromDom(): number | null {
  const active = document.activeElement;
  if (!active) return null;
  const el = (active as Element).closest('[data-pty-id]') as HTMLElement | null;
  if (!el?.dataset.ptyId) return null;
  const id = Number(el.dataset.ptyId);
  return Number.isFinite(id) ? id : null;
}

function findActivePaneIdInTree(node: SplitNode): string | null {
  if (node.type === 'leaf') return node.activePaneId || null;
  for (const child of node.children) {
    const id = findActivePaneIdInTree(child);
    if (id) return id;
  }
  return null;
}

function findPtyIdByPaneId(node: SplitNode, paneId: string): number | null {
  if (node.type === 'leaf') {
    const pane = node.panes.find((p) => p.id === paneId);
    return pane?.ptyId ?? null;
  }
  for (const child of node.children) {
    const id = findPtyIdByPaneId(child, paneId);
    if (id != null) return id;
  }
  return null;
}

/// 校验给定 ptyId 是否属于当前 tab,防止焦点落在已切走 tab 的残留 DOM 上时误跳转
function ptyBelongsToTree(node: SplitNode, ptyId: number): boolean {
  if (node.type === 'leaf') {
    return node.panes.some((p) => p.ptyId === ptyId);
  }
  return node.children.some((c) => ptyBelongsToTree(c, ptyId));
}

export function useMarkerHotkeys() {
  const lastJumpRef = useRef<Map<number, string>>(new Map());

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey) return;
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;

      const state = useAppStore.getState();
      const activeProjectId = state.activeProjectId;
      if (!activeProjectId) return;
      const ps = state.projectStates.get(activeProjectId);
      if (!ps) return;
      const tab = ps.tabs.find((t) => t.id === ps.activeTabId);
      if (!tab) return;

      // 优先用 DOM focus 定位真正聚焦的 pane(多分屏关键修复);
      // 焦点不在任何 pane 内时回退到树里第一个 leaf 的 activePaneId
      const domPtyId = findFocusedPtyIdFromDom();
      const ptyId = domPtyId != null && ptyBelongsToTree(tab.splitLayout, domPtyId)
        ? domPtyId
        : (() => {
            const paneId = findActivePaneIdInTree(tab.splitLayout);
            return paneId ? findPtyIdByPaneId(tab.splitLayout, paneId) : null;
          })();
      if (ptyId == null) return;

      const markers = state.getMarkersForPty(ptyId);
      if (markers.length === 0) return;

      const lastId = lastJumpRef.current.get(ptyId);
      const lastIdx = lastId ? markers.findIndex((m) => m.id === lastId) : markers.length;
      const dir = e.key === 'ArrowUp' ? -1 : +1;

      let nextIdx: number;
      if (lastId && lastIdx >= 0) {
        nextIdx = lastIdx + dir;
      } else {
        nextIdx = dir === -1 ? markers.length - 1 : 0;
      }
      if (nextIdx < 0 || nextIdx >= markers.length) return;

      e.preventDefault();
      e.stopPropagation();
      const target = markers[nextIdx];
      lastJumpRef.current.set(ptyId, target.id);
      scrollToMarker(ptyId, target.xtermMarkerId);
    };

    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, []);
}
