/**
 * 项目/分组拖拽状态管理。
 *
 * 与 fileDragState 同理——用 mousedown/mousemove/mouseup 替代 HTML5 DnD，
 * 规避 WebView2 dragDropEnabled 拦截内部拖拽事件的问题。
 */

export type DragPayload =
  | { type: 'project'; projectId: string }
  | { type: 'group'; groupId: string };

let _payload: DragPayload | null = null;
let _dragging = false;
let _cleanup: (() => void) | null = null;

export function isProjectDragging(): boolean {
  return _dragging;
}

export function getProjectDragPayload(): DragPayload | null {
  return _dragging ? _payload : null;
}

/**
 * 注册拖拽结束回调，用于组件清理（如清除 drop indicator）。
 */
export function onProjectDragEnd(fn: () => void): void {
  _cleanup = fn;
}

/**
 * 在项目/分组项的 mousedown 中调用。
 * 记录 payload 和起始坐标，附加全局 mousemove/mouseup 监听。
 * 鼠标移动超过 5px 后激活拖拽模式。
 */
export function initProjectDrag(
  payload: DragPayload,
  el: HTMLElement,
  startX: number,
  startY: number,
): void {
  _payload = payload;
  _dragging = false;

  const onMove = (e: MouseEvent) => {
    if (!_dragging && Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) > 5) {
      _dragging = true;
      el.style.opacity = '0.4';
      document.body.classList.add('project-dragging');
    }
  };

  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);

    if (_dragging) {
      el.style.opacity = '';
      document.body.classList.remove('project-dragging');
      // 抑制紧随 mouseup 的 click，防止触发 onClick（如切换项目、折叠分组）
      window.addEventListener(
        'click',
        (ce) => {
          ce.stopPropagation();
          ce.preventDefault();
        },
        { capture: true, once: true },
      );
    }

    _cleanup?.();
    _payload = null;
    _dragging = false;
    _cleanup = null;
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}
