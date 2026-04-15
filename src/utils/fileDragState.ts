/**
 * 自定义文件拖拽状态管理。
 *
 * 替代 HTML5 DnD API——Tauri v2 在 Windows/WebView2 上启用 dragDropEnabled
 * 后，原生 OLE 拖拽会拦截内部 HTML5 dragover/drop 事件，导致 FileTree → Terminal
 * 的拖拽功能失效。改用 mousedown/mousemove/mouseup 实现不受此限制。
 */

let _path: string | null = null;
let _dragging = false;

export function isFileDragging(): boolean {
  return _dragging;
}

export function getFileDragPath(): string | null {
  return _dragging ? _path : null;
}

/**
 * 在 FileTree 项的 mousedown 中调用。
 * 记录路径和起始坐标，附加全局 mousemove/mouseup 监听。
 * 鼠标移动超过 5px 后激活拖拽模式。
 */
export function initFileDrag(path: string, startX: number, startY: number): void {
  _path = path;
  _dragging = false;

  const onMove = (e: MouseEvent) => {
    if (!_dragging && Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) > 5) {
      _dragging = true;
      document.body.classList.add('file-dragging');
    }
  };

  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);

    if (_dragging) {
      // 抑制紧随 mouseup 的 click 事件，防止触发 FileTree 的 onClick (打开/切换)
      window.addEventListener(
        'click',
        (ce) => {
          ce.stopPropagation();
          ce.preventDefault();
        },
        { capture: true, once: true },
      );
    }

    _path = null;
    _dragging = false;
    document.body.classList.remove('file-dragging');
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}
