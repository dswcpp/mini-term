import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useT } from '../i18n';
import { useAppStore } from '../store';
import { formatError, saveConfigOptimistic } from '../utils/appConfigPersistence';
import { showAlert } from '../utils/prompt';
import {
  AboutSettings,
  AiNotificationSettings,
  FontSettings,
  ShortcutsSettings,
  SystemSettings,
  TerminalSettings,
} from './settings/SettingsSections';
import type { SettingsModalSize } from '../types';

interface Props {
  open: boolean;
  onClose: () => void;
  /** 打开时定位到指定页(便于深链入口直达某个设置分区)。 */
  initialPage?: SettingsPage;
}

export type SettingsPage = 'terminal' | 'system' | 'font' | 'ai-notification' | 'shortcuts' | 'about';

const MENU_ITEMS: { key: SettingsPage; labelKey: string }[] = [
  { key: 'terminal', labelKey: 'settings.menu.terminal' },
  { key: 'system', labelKey: 'settings.menu.system' },
  { key: 'font', labelKey: 'settings.menu.font' },
  { key: 'ai-notification', labelKey: 'settings.menu.aiNotification' },
  { key: 'shortcuts', labelKey: 'settings.menu.shortcuts' },
  { key: 'about', labelKey: 'settings.menu.about' },
];

const DEFAULT_SETTINGS_MODAL_SIZE: SettingsModalSize = { width: 760, height: 560 };
const MIN_SETTINGS_MODAL_SIZE: SettingsModalSize = { width: 640, height: 420 };
const VIEWPORT_X_PADDING = 48;
const VIEWPORT_Y_PADDING = 64;
const MIN_VIEWPORT_MODAL_WIDTH = 320;
const MIN_VIEWPORT_MODAL_HEIGHT = 260;
const WIDTH_HEIGHT_GAP = 80;
const KEYBOARD_RESIZE_STEP = 24;

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function finiteDimension(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clampSettingsModalSize(size: SettingsModalSize): SettingsModalSize {
  const viewportWidth = typeof window === 'undefined' ? 1024 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? 768 : window.innerHeight;
  const maxWidth = Math.max(MIN_VIEWPORT_MODAL_WIDTH, viewportWidth - VIEWPORT_X_PADDING);
  const minWidth = Math.min(MIN_SETTINGS_MODAL_SIZE.width, maxWidth);
  const width = clampNumber(
    Math.round(finiteDimension(size.width, DEFAULT_SETTINGS_MODAL_SIZE.width)),
    minWidth,
    maxWidth,
  );

  const maxViewportHeight = Math.max(MIN_VIEWPORT_MODAL_HEIGHT, viewportHeight - VIEWPORT_Y_PADDING);
  const maxHeight = Math.min(maxViewportHeight, Math.max(MIN_VIEWPORT_MODAL_HEIGHT, width - WIDTH_HEIGHT_GAP));
  const minHeight = Math.min(MIN_SETTINGS_MODAL_SIZE.height, maxHeight);
  const height = clampNumber(
    Math.round(finiteDimension(size.height, DEFAULT_SETTINGS_MODAL_SIZE.height)),
    minHeight,
    maxHeight,
  );

  return { width, height };
}

function resolveSettingsModalSize(savedSize?: SettingsModalSize): SettingsModalSize {
  return clampSettingsModalSize({
    width: finiteDimension(savedSize?.width, DEFAULT_SETTINGS_MODAL_SIZE.width),
    height: finiteDimension(savedSize?.height, DEFAULT_SETTINGS_MODAL_SIZE.height),
  });
}

function isSameSize(a: SettingsModalSize | undefined, b: SettingsModalSize): boolean {
  if (!a) return false;
  return Math.round(a.width) === b.width && Math.round(a.height) === b.height;
}

export function SettingsModal({ open, onClose, initialPage }: Props) {
  const t = useT();
  const [activePage, setActivePage] = useState<SettingsPage>(initialPage ?? 'terminal');
  const [size, setSize] = useState<SettingsModalSize>(() => (
    resolveSettingsModalSize(useAppStore.getState().config.settingsModalSize)
  ));
  const sizeRef = useRef(size);
  const resizeStartRef = useRef<{
    pointerX: number;
    pointerY: number;
    width: number;
    height: number;
  } | null>(null);
  const isResizingRef = useRef(false);
  const suppressBackdropClickRef = useRef(false);
  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    if (open) setActivePage(initialPage ?? 'terminal');
  }, [open, initialPage]);

  useEffect(() => {
    sizeRef.current = size;
  }, [size]);

  useEffect(() => {
    if (open) {
      setSize(resolveSettingsModalSize(useAppStore.getState().config.settingsModalSize));
    }
  }, [open]);

  const persistSettingsSize = useCallback(async (nextSize: SettingsModalSize) => {
    const normalizedSize = clampSettingsModalSize(nextSize);
    const prevConfig = useAppStore.getState().config;
    if (isSameSize(prevConfig.settingsModalSize, normalizedSize)) return;

    try {
      await saveConfigOptimistic({
        ...prevConfig,
        settingsModalSize: normalizedSize,
      });
    } catch (error) {
      setSize(resolveSettingsModalSize(prevConfig.settingsModalSize));
      await showAlert(t('settings.common.saveFailedTitle'), formatError(error));
    }
  }, [t]);

  const beginResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeStartRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      width: size.width,
      height: size.height,
    };
    isResizingRef.current = true;
    suppressBackdropClickRef.current = true;
    setIsResizing(true);
  }, [size]);

  useEffect(() => {
    if (!isResizing) return;

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'nwse-resize';
    document.body.style.userSelect = 'none';

    const getNextSize = (event: PointerEvent): SettingsModalSize | null => {
      const start = resizeStartRef.current;
      if (!start) return null;
      return clampSettingsModalSize({
        width: start.width + event.clientX - start.pointerX,
        height: start.height + event.clientY - start.pointerY,
      });
    };

    const handlePointerMove = (event: PointerEvent) => {
      const nextSize = getNextSize(event);
      if (nextSize) setSize(nextSize);
    };

    const finishResize = (event: PointerEvent) => {
      const nextSize = getNextSize(event) ?? sizeRef.current;
      resizeStartRef.current = null;
      isResizingRef.current = false;
      suppressBackdropClickRef.current = true;
      setIsResizing(false);
      setSize(nextSize);
      void persistSettingsSize(nextSize);
      window.setTimeout(() => {
        suppressBackdropClickRef.current = false;
      }, 150);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', finishResize, { once: true });
    window.addEventListener('pointercancel', finishResize, { once: true });

    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', finishResize);
      window.removeEventListener('pointercancel', finishResize);
    };
  }, [isResizing, persistSettingsSize]);

  useEffect(() => {
    if (!open) return;
    const handleWindowResize = () => {
      setSize((current) => clampSettingsModalSize(current));
    };
    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, [open]);

  const handleResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? KEYBOARD_RESIZE_STEP * 2 : KEYBOARD_RESIZE_STEP;
    let nextSize: SettingsModalSize | null = null;
    if (event.key === 'ArrowRight') {
      nextSize = clampSettingsModalSize({ ...size, width: size.width + step });
    } else if (event.key === 'ArrowLeft') {
      nextSize = clampSettingsModalSize({ ...size, width: size.width - step });
    } else if (event.key === 'ArrowDown') {
      nextSize = clampSettingsModalSize({ ...size, height: size.height + step });
    } else if (event.key === 'ArrowUp') {
      nextSize = clampSettingsModalSize({ ...size, height: size.height - step });
    }

    if (!nextSize) return;
    event.preventDefault();
    event.stopPropagation();
    setSize(nextSize);
    void persistSettingsSize(nextSize);
  }, [persistSettingsSize, size]);

  const handleBackdropClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (isResizingRef.current || suppressBackdropClickRef.current) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onClose();
  }, [onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]" onClick={handleBackdropClick}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="relative bg-[var(--bg-surface)] border border-[var(--border-strong)] rounded-[var(--radius-md)] shadow-[var(--shadow-overlay)] flex flex-col overflow-hidden animate-slide-in"
        style={{ width: size.width, height: size.height }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-subtle)]">
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">{t("settings.title")}</h2>
          <button
            className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors text-lg leading-none"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          <div className="w-[160px] flex-shrink-0 border-r border-[var(--border-subtle)] py-3 px-2 space-y-0.5">
            {MENU_ITEMS.map((item) => (
              <div
                key={item.key}
                className={`flex items-center gap-2 px-3 py-2 rounded-[var(--radius-sm)] cursor-pointer text-base transition-all duration-150 ${
                  activePage === item.key
                    ? 'bg-[var(--accent-subtle)] text-[var(--accent)]'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--border-subtle)]'
                }`}
                onClick={() => setActivePage(item.key)}
              >
                {activePage === item.key && (
                  <span className="w-0.5 h-4 rounded-full bg-[var(--accent)] flex-shrink-0" />
                )}
                <span>{t(item.labelKey)}</span>
              </div>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            {activePage === 'terminal' && <TerminalSettings />}
            {activePage === 'system' && <SystemSettings />}
            {activePage === 'font' && <FontSettings />}
            {activePage === 'ai-notification' && <AiNotificationSettings />}
            {activePage === 'shortcuts' && <ShortcutsSettings />}
            {activePage === 'about' && <AboutSettings />}
          </div>
        </div>
        <div
          role="separator"
          tabIndex={0}
          aria-label={t('settings.resizeHandle')}
          title={t('settings.resizeHandle')}
          className="absolute bottom-1 right-1 z-10 h-5 w-5 cursor-nwse-resize touch-none rounded-sm text-[var(--text-muted)] hover:text-[var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
          onPointerDown={beginResize}
          onKeyDown={handleResizeKeyDown}
        >
          <span className="absolute bottom-1 right-1 h-3 w-3 border-r border-b border-current opacity-70" />
          <span className="absolute bottom-1 right-1 h-1.5 w-1.5 border-r border-b border-current opacity-70" />
        </div>
      </div>
    </div>
  );
}
