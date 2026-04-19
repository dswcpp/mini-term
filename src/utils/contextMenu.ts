export interface ContextMenuItem {
  label: string;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  shortcut?: string;
  children?: ContextMenuEntry[];
}

export interface ContextMenuSeparator {
  separator: true;
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuSeparator;
let activeCleanup: (() => void) | null = null;

function isSeparator(entry: ContextMenuEntry): entry is ContextMenuSeparator {
  return 'separator' in entry;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function showContextMenu(x: number, y: number, items: ContextMenuEntry[]) {
  if (items.length === 0) {
    closeContextMenus();
    return;
  }

  closeContextMenus();

  const openedMenus: HTMLDivElement[] = [];
  const menuStack = new Map<number, HTMLDivElement>();
  const menuLayer = document.createElement('div');
  menuLayer.className = 'ctx-menu-layer';
  menuLayer.style.position = 'fixed';
  menuLayer.style.inset = '0';
  menuLayer.style.pointerEvents = 'none';
  menuLayer.style.zIndex = '90';
  menuLayer.setAttribute('data-context-menu-layer', 'true');

  const cleanup = () => {
    menuLayer.remove();
    document.removeEventListener('mousedown', handlePointerDown, true);
    document.removeEventListener('keydown', handleKeyDown, true);
    window.removeEventListener('blur', cleanup);
    window.removeEventListener('resize', cleanup);
    document.removeEventListener('scroll', cleanup, true);
    if (activeCleanup === cleanup) {
      activeCleanup = null;
    }
  };

  const closeMenusFromLevel = (level: number) => {
    for (const [currentLevel, menu] of [...menuStack.entries()]) {
      if (currentLevel >= level) {
        menu.remove();
        menuStack.delete(currentLevel);
        const index = openedMenus.indexOf(menu);
        if (index >= 0) openedMenus.splice(index, 1);
      }
    }
  };

  const placeMenu = (menu: HTMLDivElement, preferredLeft: number, preferredTop: number) => {
    const margin = 8;
    const rect = menu.getBoundingClientRect();
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);

    menu.style.left = `${clamp(preferredLeft, margin, maxLeft)}px`;
    menu.style.top = `${clamp(preferredTop, margin, maxTop)}px`;
  };

  const openMenu = (
    level: number,
    entries: ContextMenuEntry[],
    anchor: { left: number; top: number },
    parentItem?: HTMLDivElement,
  ) => {
    closeMenusFromLevel(level);

    const menu = document.createElement('div');
    menu.className = 'ctx-menu ctx-menu-panel text-xs';
    menu.style.position = 'fixed';
    menu.style.pointerEvents = 'auto';
    menu.style.minWidth = '196px';
    menu.style.maxWidth = '320px';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('data-menu-level', String(level));

    entries.forEach((entry) => {
      if (isSeparator(entry)) {
        const separator = document.createElement('div');
        separator.className = 'ctx-menu-sep';
        separator.setAttribute('role', 'separator');
        menu.appendChild(separator);
        return;
      }

      const item = document.createElement('div');
      item.className = 'ctx-menu-item';
      item.setAttribute('role', 'menuitem');
      item.setAttribute('tabindex', '-1');
      if (entry.danger) item.classList.add('danger');
      if (entry.disabled) item.classList.add('disabled');
      if (entry.children?.length) item.classList.add('has-children');
      if (entry.disabled) {
        item.setAttribute('aria-disabled', 'true');
      }
      if (entry.children?.length) {
        item.setAttribute('aria-haspopup', 'menu');
      }

      const indicator = document.createElement('span');
      indicator.className = 'ctx-menu-indicator';
      indicator.textContent = entry.checked ? '✓' : '';
      item.appendChild(indicator);

      const label = document.createElement('span');
      label.className = 'ctx-menu-label';
      label.textContent = entry.label;
      item.appendChild(label);

      if (entry.shortcut) {
        const shortcut = document.createElement('span');
        shortcut.className = 'ctx-menu-shortcut';
        shortcut.textContent = entry.shortcut;
        item.appendChild(shortcut);
      }

      const childEntries = entry.children;

      if (childEntries && childEntries.length) {
        const chevron = document.createElement('span');
        chevron.className = 'ctx-menu-chevron';
        chevron.textContent = '›';
        item.appendChild(chevron);

        item.addEventListener('mouseenter', () => {
          if (entry.disabled) return;

          const rect = item.getBoundingClientRect();
          openMenu(
            level + 1,
            childEntries,
            { left: rect.right - 4, top: rect.top - 4 },
            item,
          );
        });
      } else {
        item.addEventListener('mouseenter', () => {
          closeMenusFromLevel(level + 1);
        });
      }

      item.addEventListener('click', (event) => {
        event.stopPropagation();
        if (entry.disabled || (childEntries && childEntries.length)) return;
        entry.onClick?.();
        cleanup();
      });

      menu.appendChild(item);
    });

    menuLayer.appendChild(menu);
    menuStack.set(level, menu);
    openedMenus.push(menu);

    requestAnimationFrame(() => {
      if (parentItem) {
        const parentRect = parentItem.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        const prefersLeft = parentRect.right + menuRect.width + 8 > window.innerWidth;
        placeMenu(
          menu,
          prefersLeft ? parentRect.left - menuRect.width + 4 : anchor.left,
          anchor.top,
        );
      } else {
        placeMenu(menu, anchor.left, anchor.top);
      }
    });
  };

  const handlePointerDown = (event: MouseEvent) => {
    const target = event.target as Node | null;
    if (!target || !menuLayer.contains(target)) {
      cleanup();
    }
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      cleanup();
    }
  };

  document.body.appendChild(menuLayer);
  activeCleanup = cleanup;
  openMenu(0, items, { left: x, top: y });

  setTimeout(() => {
    document.addEventListener('mousedown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('blur', cleanup);
    window.addEventListener('resize', cleanup);
    document.addEventListener('scroll', cleanup, true);
  }, 0);
}

export function closeContextMenus() {
  if (activeCleanup) {
    activeCleanup();
    return;
  }
  document.querySelectorAll('.ctx-menu-layer').forEach((element) => element.remove());
}
