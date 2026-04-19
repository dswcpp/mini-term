import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeContextMenus, showContextMenu } from './contextMenu';

describe('contextMenu', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', ((callback: FrameRequestCallback) => {
      callback(16);
      return 1;
    }) as typeof requestAnimationFrame);
    document.body.innerHTML = '';
  });

  afterEach(() => {
    closeContextMenus();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('renders a floating menu and invokes the selected action', () => {
    const onOpen = vi.fn();

    showContextMenu(120, 40, [
      { label: 'Open', onClick: onOpen },
      { separator: true },
      { label: 'Delete', danger: true, shortcut: 'Del' },
    ]);
    vi.runAllTimers();

    const layer = document.querySelector('.ctx-menu-layer');
    const menu = document.querySelector('.ctx-menu-panel') as HTMLDivElement | null;
    const items = Array.from(document.querySelectorAll('.ctx-menu-item'));

    expect(layer).not.toBeNull();
    expect(layer?.getAttribute('data-context-menu-layer')).toBe('true');
    expect(menu).not.toBeNull();
    expect(menu?.getAttribute('role')).toBe('menu');
    expect(menu?.style.position).toBe('fixed');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain('Open');
    expect(items[1]?.classList.contains('danger')).toBe(true);

    items[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onOpen).toHaveBeenCalledOnce();
    expect(document.querySelector('.ctx-menu-layer')).toBeNull();
  });

  it('closes when clicking outside the menu layer', () => {
    showContextMenu(8, 8, [{ label: 'Inspect' }]);
    vi.runAllTimers();

    expect(document.querySelector('.ctx-menu-layer')).not.toBeNull();

    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(document.querySelector('.ctx-menu-layer')).toBeNull();
  });

  it('replaces the previous menu when a new one is opened', () => {
    showContextMenu(10, 10, [{ label: 'First' }]);
    vi.runAllTimers();

    showContextMenu(20, 20, [{ label: 'Second' }]);
    vi.runAllTimers();

    const menus = Array.from(document.querySelectorAll('.ctx-menu-panel'));

    expect(menus).toHaveLength(1);
    expect(menus[0]?.textContent).toContain('Second');
  });

  it('opens a submenu on hover', () => {
    showContextMenu(24, 32, [
      {
        label: 'More',
        children: [
          { label: 'Rename' },
          { label: 'Duplicate' },
        ],
      },
    ]);
    vi.runAllTimers();

    const parentItem = document.querySelector('.ctx-menu-item.has-children') as HTMLDivElement | null;
    parentItem?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    vi.runAllTimers();

    const menus = Array.from(document.querySelectorAll('.ctx-menu-panel'));

    expect(parentItem?.getAttribute('aria-haspopup')).toBe('menu');
    expect(menus).toHaveLength(2);
    expect(menus[1]?.textContent).toContain('Rename');
    expect(menus[1]?.textContent).toContain('Duplicate');
  });

  it('does not create a layer for an empty menu', () => {
    showContextMenu(0, 0, []);
    vi.runAllTimers();

    expect(document.querySelector('.ctx-menu-layer')).toBeNull();
    expect(document.querySelector('.ctx-menu-panel')).toBeNull();
  });
});
