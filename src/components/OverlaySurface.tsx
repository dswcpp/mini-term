import { createPortal } from 'react-dom';
import {
  useEffect,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
} from 'react';

interface OverlaySurfaceProps {
  open?: boolean;
  onClose: () => void;
  children: ReactNode;
  surfaceRef?: Ref<HTMLDivElement>;
  rootClassName?: string;
  panelClassName?: string;
  panelStyle?: CSSProperties;
  panelProps?: HTMLAttributes<HTMLDivElement> & {
    [key: `data-${string}`]: string | undefined;
  };
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  backdropTestId?: string;
}

export function OverlaySurface({
  open = true,
  onClose,
  children,
  surfaceRef,
  rootClassName = '',
  panelClassName = '',
  panelStyle,
  panelProps,
  closeOnBackdrop = true,
  closeOnEscape = true,
  onEscapeKeyDown,
  backdropTestId = 'overlay-surface-backdrop',
}: OverlaySurfaceProps) {
  useEffect(() => {
    if (!open || !closeOnEscape) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }

      onEscapeKeyDown?.(event);
      if (!event.defaultPrevented) {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closeOnEscape, onClose, onEscapeKeyDown, open]);

  if (!open) {
    return null;
  }

  const handlePanelClick: NonNullable<HTMLAttributes<HTMLDivElement>['onClick']> = (event) => {
    event.stopPropagation();
    panelProps?.onClick?.(event);
  };

  const content = (
    <div
      ref={surfaceRef}
      className={`fixed inset-0 z-50 flex items-center justify-center ${rootClassName}`.trim()}
      onClick={closeOnBackdrop ? onClose : undefined}
    >
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" data-testid={backdropTestId} />
      <div
        {...panelProps}
        className={panelClassName}
        style={panelStyle}
        onClick={handlePanelClick}
      >
        {children}
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
