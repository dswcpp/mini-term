import { useEffect, useMemo, useRef, useState } from 'react';
import type { ViewerLayoutMode } from './types';
import { MermaidFocusLayer } from './MermaidFocusLayer';
import { MermaidViewport } from './MermaidViewport';
import { useMermaidDiagram } from './useMermaidDiagram';

let mermaidSequence = 0;

function buildMermaidExportBaseName(fileName: string, diagramId: string) {
  const stem = fileName.replace(/\.[^.]+$/, '');
  const suffix = diagramId.split('-').pop() ?? '1';
  return `${stem}-mermaid-${suffix}`;
}

export function MermaidDiagramBlock({
  source,
  active,
  layoutMode,
  exportFileName,
  immersive = false,
  autoOpenFocus = false,
}: {
  source: string;
  active: boolean;
  layoutMode: ViewerLayoutMode;
  exportFileName: string;
  immersive?: boolean;
  autoOpenFocus?: boolean;
}) {
  const [focusViewerOpen, setFocusViewerOpen] = useState(false);
  const autoOpenedRef = useRef(false);
  const diagramId = useMemo(() => {
    mermaidSequence += 1;
    return `mini-term-mermaid-${mermaidSequence}`;
  }, []);
  const { svg, error, bindFunctions } = useMermaidDiagram(source, diagramId, active);
  const suppressInlineViewport = autoOpenFocus && focusViewerOpen;

  useEffect(() => {
    if (!autoOpenFocus || !active || !svg || autoOpenedRef.current) {
      return;
    }

    autoOpenedRef.current = true;
    setFocusViewerOpen(true);
  }, [active, autoOpenFocus, svg]);

  if (error) {
    return (
      <div className="my-5 overflow-hidden rounded-xl border border-[var(--color-error)]/40 bg-[rgba(212,96,90,0.08)]">
        <div className="border-b border-[var(--color-error)]/30 px-4 py-2 text-xs font-medium text-[var(--color-error)]">
          Mermaid render failed
        </div>
        <div className="px-4 py-3 text-xs text-[var(--text-secondary)]">{error}</div>
        <pre className="m-0 overflow-x-auto border-t border-[var(--border-default)] bg-[rgba(8,8,8,0.35)] px-4 py-3 text-[13px] text-[var(--text-primary)]">
          <code>{source}</code>
        </pre>
      </div>
    );
  }

  return (
    <>
      {!suppressInlineViewport && (
        <MermaidViewport
          svg={svg}
          bindFunctions={bindFunctions}
          active={active}
          layoutMode={layoutMode}
          testIdPrefix="mermaid"
          onOpenFocus={active && svg ? () => setFocusViewerOpen(true) : undefined}
          exportBaseName={buildMermaidExportBaseName(exportFileName, diagramId)}
          immersive={immersive}
        />
      )}
      <MermaidFocusLayer
        open={focusViewerOpen && active}
        onClose={() => setFocusViewerOpen(false)}
        svg={svg}
        bindFunctions={bindFunctions}
        exportBaseName={buildMermaidExportBaseName(exportFileName, diagramId)}
      />
    </>
  );
}

MermaidDiagramBlock.displayName = 'MermaidDiagramBlock';
