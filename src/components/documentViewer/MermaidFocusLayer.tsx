import { createPortal } from 'react-dom';
import { useEffect } from 'react';
import { CloseIcon, ToolbarButton } from './controls';
import { MermaidViewport } from './MermaidViewport';

export function MermaidFocusLayer({
  open,
  onClose,
  svg,
  bindFunctions,
  exportBaseName,
}: {
  open: boolean;
  onClose: () => void;
  svg: string;
  bindFunctions?: (element: Element) => void;
  exportBaseName: string;
}) {
  useEffect(() => {
    if (!open) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      onClose();
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose, open]);

  if (!open) {
    return null;
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/72 p-4 backdrop-blur-md"
      data-testid="mermaid-focus-layer"
      onClick={onClose}
    >
      <div
        className="flex h-full w-full max-w-[1800px] flex-col overflow-hidden rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-surface)] shadow-[var(--shadow-overlay)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex flex-shrink-0 items-center justify-between border-b border-[var(--border-default)] px-5 py-4">
          <div>
            <div className="text-base font-medium text-[var(--accent)]">Mermaid Focus View</div>
            <div className="text-sm text-[var(--text-secondary)]">
              Dedicated diagram view for large Mermaid flows and detailed inspection.
            </div>
          </div>
          <ToolbarButton
            label="Close Mermaid focus view"
            onClick={onClose}
            testId="mermaid-focus-close"
          >
            <CloseIcon />
          </ToolbarButton>
        </div>
        <div className="flex-1 overflow-auto px-6 py-6">
          <MermaidViewport
            svg={svg}
            bindFunctions={bindFunctions}
            layoutMode="focus"
            testIdPrefix="mermaid-focus"
            exportBaseName={exportBaseName}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
