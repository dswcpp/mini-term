import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import type { MermaidExportFormat } from '../../utils/mermaidExport';
import { exportMermaidDiagram } from '../../utils/mermaidExport';
import type { MermaidViewportMode } from './types';
import {
  FitIcon,
  FocusIcon,
  ToolbarButton,
  ToolbarTextButton,
  ZoomInIcon,
  ZoomOutIcon,
} from './controls';

const MIN_SCALE = 0.2;
const MAX_SCALE = 12;
const ZOOM_FACTOR = 1.2;
const VIEWPORT_PADDING = 24;

type ViewState = {
  scale: number;
  centerX: number;
  centerY: number;
};

type ContentBounds = {
  minX: number;
  minY: number;
  width: number;
  height: number;
};

function parseSvgDimension(value: string | null | undefined) {
  if (!value) {
    return 0;
  }

  const numeric = Number(value.replace(/[^\d.]/g, ''));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function resolveSvgIntrinsicBounds(svgElement: SVGSVGElement): ContentBounds {
  const viewBoxX = svgElement.viewBox.baseVal.x;
  const viewBoxY = svgElement.viewBox.baseVal.y;
  const viewBoxWidth = svgElement.viewBox.baseVal.width;
  const viewBoxHeight = svgElement.viewBox.baseVal.height;
  if (viewBoxWidth > 0 && viewBoxHeight > 0) {
    return {
      minX: viewBoxX,
      minY: viewBoxY,
      width: viewBoxWidth,
      height: viewBoxHeight,
    };
  }

  const attrWidth = parseSvgDimension(svgElement.getAttribute('width'));
  const attrHeight = parseSvgDimension(svgElement.getAttribute('height'));
  if (attrWidth > 0 && attrHeight > 0) {
    return {
      minX: 0,
      minY: 0,
      width: attrWidth,
      height: attrHeight,
    };
  }

  try {
    const bbox = svgElement.getBBox();
    if (bbox.width > 0 && bbox.height > 0) {
      return {
        minX: bbox.x,
        minY: bbox.y,
        width: bbox.width,
        height: bbox.height,
      };
    }
  } catch {
    // Some DOM environments cannot measure SVG bbox before paint.
  }

  const rect = svgElement.getBoundingClientRect();
  return {
    minX: 0,
    minY: 0,
    width: Math.max(1, rect.width || 1),
    height: Math.max(1, rect.height || 1),
  };
}

function clampScale(value: number) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(value.toFixed(4))));
}

export function MermaidViewport({
  svg,
  bindFunctions,
  active = true,
  layoutMode,
  testIdPrefix,
  onOpenFocus,
  exportBaseName,
  immersive = false,
}: {
  svg: string;
  bindFunctions?: (element: Element) => void;
  active?: boolean;
  layoutMode: MermaidViewportMode;
  testIdPrefix: string;
  onOpenFocus?: () => void;
  exportBaseName: string;
  immersive?: boolean;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const svgElementRef = useRef<SVGSVGElement | null>(null);
  const transformHostRef = useRef<HTMLDivElement | null>(null);
  const zoomLabelRef = useRef<HTMLSpanElement | null>(null);
  const hasManualViewRef = useRef(false);
  const paintFrameRef = useRef(0);
  const dragStateRef = useRef({
    active: false,
    moved: false,
    button: 0,
    startX: 0,
    startY: 0,
  });
  const viewStateRef = useRef<ViewState>({
    scale: 1,
    centerX: 0,
    centerY: 0,
  });
  const contentBoundsRef = useRef<ContentBounds>({
    minX: 0,
    minY: 0,
    width: 1,
    height: 1,
  });
  const [exportingFormat, setExportingFormat] = useState<MermaidExportFormat | null>(null);
  const [exportMessage, setExportMessage] = useState('');
  
  const paintViewState = () => {
    paintFrameRef.current = 0;
    const current = viewStateRef.current;
    const rect = getViewportRect();
    const svgElement = svgElementRef.current;
    if (rect && svgElement) {
      const viewBoxWidth = Math.max(1 / MAX_SCALE, rect.width / current.scale);
      const viewBoxHeight = Math.max(1 / MAX_SCALE, rect.height / current.scale);
      const viewBoxX = current.centerX - viewBoxWidth / 2;
      const viewBoxY = current.centerY - viewBoxHeight / 2;
      svgElement.setAttribute('viewBox', `${viewBoxX} ${viewBoxY} ${viewBoxWidth} ${viewBoxHeight}`);

      if (transformHostRef.current) {
        transformHostRef.current.dataset.cameraViewBox = `${viewBoxX}|${viewBoxY}|${viewBoxWidth}|${viewBoxHeight}`;
      }
    }

    if (zoomLabelRef.current) {
      zoomLabelRef.current.textContent = `${Math.round(current.scale * 100)}%`;
    }
  };

  const scheduleViewPaint = () => {
    if (paintFrameRef.current) {
      return;
    }

    paintFrameRef.current = requestAnimationFrame(() => {
      paintViewState();
    });
  };

  const commitViewState = (nextState: ViewState) => {
    viewStateRef.current = nextState;
    scheduleViewPaint();
  };

  const getViewportRect = () => viewportRef.current?.getBoundingClientRect() ?? null;

  const buildCenteredState = (scale: number): ViewState => {
    const bounds = contentBoundsRef.current;

    return {
      scale,
      centerX: bounds.minX + bounds.width / 2,
      centerY: bounds.minY + bounds.height / 2,
    };
  };

  const applyFit = () => {
    const rect = getViewportRect();
    const { width, height } = contentBoundsRef.current;
    if (!rect || width <= 0 || height <= 0) {
      return;
    }

    const fitScale = clampScale(
      Math.min(
        (rect.width - VIEWPORT_PADDING * 2) / width,
        (rect.height - VIEWPORT_PADDING * 2) / height,
      ),
    );
    hasManualViewRef.current = false;
    commitViewState(buildCenteredState(fitScale));
  };

  const zoomAtViewportPoint = (anchorX: number, anchorY: number, zoomFactor: number) => {
    const rect = getViewportRect();
    if (!rect) {
      return;
    }

    const current = viewStateRef.current;
    const nextScale = clampScale(current.scale * zoomFactor);
    if (nextScale === current.scale) {
      return;
    }

    const currentViewWidth = Math.max(1 / MAX_SCALE, rect.width / current.scale);
    const currentViewHeight = Math.max(1 / MAX_SCALE, rect.height / current.scale);
    const currentViewX = current.centerX - currentViewWidth / 2;
    const currentViewY = current.centerY - currentViewHeight / 2;
    const anchorContentX = currentViewX + anchorX / current.scale;
    const anchorContentY = currentViewY + anchorY / current.scale;

    const nextViewWidth = Math.max(1 / MAX_SCALE, rect.width / nextScale);
    const nextViewHeight = Math.max(1 / MAX_SCALE, rect.height / nextScale);
    const nextViewX = anchorContentX - anchorX / nextScale;
    const nextViewY = anchorContentY - anchorY / nextScale;

    hasManualViewRef.current = true;
    commitViewState({
      scale: nextScale,
      centerX: nextViewX + nextViewWidth / 2,
      centerY: nextViewY + nextViewHeight / 2,
    });
  };

  const zoomFromViewportCenter = (zoomFactor: number) => {
    const rect = getViewportRect();
    if (!rect) {
      return;
    }

    zoomAtViewportPoint(rect.width / 2, rect.height / 2, zoomFactor);
  };

  useEffect(() => {
    if (!active || !svg || !hostRef.current || !viewportRef.current) {
      return;
    }

    const svgElement = hostRef.current.querySelector('svg');
    if (!(svgElement instanceof SVGSVGElement)) {
      return;
    }

    const nextContentBounds = resolveSvgIntrinsicBounds(svgElement);
    svgElementRef.current = svgElement;
    svgElement.setAttribute('data-testid', testIdPrefix === 'mermaid' ? 'mermaid-svg' : `${testIdPrefix}-svg`);
    svgElement.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svgElement.style.display = 'block';
    svgElement.style.width = '100%';
    svgElement.style.height = '100%';
    svgElement.style.maxWidth = 'none';
    svgElement.style.maxHeight = 'none';
    svgElement.style.overflow = 'visible';
    contentBoundsRef.current = nextContentBounds;
    hasManualViewRef.current = false;

    if (bindFunctions) {
      bindFunctions(hostRef.current);
    }

    const frame = requestAnimationFrame(() => {
      applyFit();
    });

    return () => {
      cancelAnimationFrame(frame);
      svgElementRef.current = null;
    };
  }, [active, bindFunctions, svg, testIdPrefix]);

  useEffect(() => {
    if (!active || !svg) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      applyFit();
    });

    return () => cancelAnimationFrame(frame);
  }, [active, immersive, layoutMode, svg]);

  useEffect(() => {
    if (!active || !viewportRef.current || typeof ResizeObserver === 'undefined') {
      return;
    }

    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (hasManualViewRef.current) {
        return;
      }

      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        applyFit();
      });
    });

    observer.observe(viewportRef.current);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [active, svg]);

  useEffect(() => {
    if (!active || !viewportRef.current) {
      return;
    }

    const viewport = viewportRef.current;
    const isViewportEventTarget = (target: EventTarget | null) =>
      target instanceof Node && (target === viewport || viewport.contains(target));

    const handleWheel = (event: WheelEvent) => {
      if (!isViewportEventTarget(event.target)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const rect = getViewportRect();
      if (!rect) {
        return;
      }

      zoomAtViewportPoint(
        event.clientX - rect.left,
        event.clientY - rect.top,
        event.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR,
      );
    };

    const handleMouseDown = (event: MouseEvent) => {
      if (!isViewportEventTarget(event.target)) {
        return;
      }

      if (event.button !== 0 && event.button !== 2) {
        return;
      }

      dragStateRef.current = {
        active: true,
        moved: false,
        button: event.button,
        startX: event.clientX,
        startY: event.clientY,
      };
      viewport.style.cursor = 'grabbing';
      event.preventDefault();
      event.stopPropagation();
    };

    const handleMouseMove = (event: MouseEvent) => {
      const state = dragStateRef.current;
      if (!state.active) {
        return;
      }

      const expectedButtonMask = state.button === 2 ? 2 : 1;
      if ((event.buttons & expectedButtonMask) !== expectedButtonMask) {
        state.active = false;
        viewport.style.cursor = 'grab';
        return;
      }

      const deltaX = event.clientX - state.startX;
      const deltaY = event.clientY - state.startY;
      if (deltaX === 0 && deltaY === 0) {
        return;
      }

      state.moved = true;
      state.startX = event.clientX;
      state.startY = event.clientY;
      hasManualViewRef.current = true;
      const current = viewStateRef.current;
      commitViewState({
        ...current,
        centerX: current.centerX - deltaX / current.scale,
        centerY: current.centerY - deltaY / current.scale,
      });
      event.preventDefault();
    };

    const stopDragging = () => {
      if (!dragStateRef.current.active) {
        return;
      }

      dragStateRef.current.active = false;
      dragStateRef.current.moved = false;
      viewport.style.cursor = 'grab';
    };

    const handleDoubleClick = (event: MouseEvent) => {
      if (!isViewportEventTarget(event.target)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      applyFit();
    };

    const handleContextMenu = (event: MouseEvent) => {
      if (!isViewportEventTarget(event.target)) {
        return;
      }

      if (dragStateRef.current.moved || dragStateRef.current.active || event.button === 2) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    viewport.addEventListener('wheel', handleWheel, { passive: false, capture: true });
    viewport.addEventListener('mousedown', handleMouseDown, true);
    viewport.addEventListener('dblclick', handleDoubleClick, true);
    viewport.addEventListener('contextmenu', handleContextMenu, true);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', stopDragging);
    window.addEventListener('blur', stopDragging);

    return () => {
      if (paintFrameRef.current) {
        cancelAnimationFrame(paintFrameRef.current);
        paintFrameRef.current = 0;
      }

      viewport.removeEventListener('wheel', handleWheel, true);
      viewport.removeEventListener('mousedown', handleMouseDown, true);
      viewport.removeEventListener('dblclick', handleDoubleClick, true);
      viewport.removeEventListener('contextmenu', handleContextMenu, true);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', stopDragging);
      window.removeEventListener('blur', stopDragging);
    };
  }, [active, svg]);

  useEffect(() => {
    if (!exportMessage || exportingFormat) {
      return;
    }

    const timer = window.setTimeout(() => {
      setExportMessage('');
    }, 2600);

    return () => window.clearTimeout(timer);
  }, [exportMessage, exportingFormat]);

  useEffect(() => {
    scheduleViewPaint();

    return () => {
      if (paintFrameRef.current) {
        cancelAnimationFrame(paintFrameRef.current);
        paintFrameRef.current = 0;
      }
    };
  }, [svg]);

  const handleZoomIn = () => {
    zoomFromViewportCenter(ZOOM_FACTOR);
  };

  const handleZoomOut = () => {
    zoomFromViewportCenter(1 / ZOOM_FACTOR);
  };

  const handleReset = () => {
    hasManualViewRef.current = true;
    commitViewState(buildCenteredState(1));
  };

  const handleFit = () => {
    applyFit();
  };

  const handleContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (dragStateRef.current.moved || dragStateRef.current.active || event.button === 2) {
      event.preventDefault();
    }
  };

  const handleExport = async (format: MermaidExportFormat) => {
    if (!svg || exportingFormat) {
      return;
    }

    setExportingFormat(format);
    setExportMessage(format === 'svg' ? 'Exporting SVG...' : 'Exporting PNG...');

    try {
      const savedPath = await exportMermaidDiagram({
        svgMarkup: svg,
        format,
        baseName: exportBaseName,
      });

      if (savedPath) {
        setExportMessage(`Exported ${format.toUpperCase()}`);
      } else {
        setExportMessage('');
      }
    } catch (reason) {
      setExportMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setExportingFormat(null);
    }
  };

  const viewportHeightClass =
    immersive
      ? 'flex-1 min-h-0'
      : layoutMode === 'focus'
        ? 'h-[82vh] min-h-[640px]'
        : layoutMode === 'fullscreen'
          ? 'h-[72vh] min-h-[520px]'
          : layoutMode === 'maximized'
            ? 'h-[64vh] min-h-[460px]'
            : 'h-[min(56vh,560px)] min-h-[360px]';

  return (
    <section
      className={
        immersive
          ? 'flex h-full min-h-0 flex-col overflow-hidden bg-[rgba(8,8,8,0.26)]'
          : 'my-5 overflow-hidden rounded-xl border border-[var(--border-default)] bg-[rgba(8,8,8,0.26)]'
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-default)] px-4 py-3">
        <div>
          <div className="text-sm font-medium text-[var(--text-primary)]">
            {layoutMode === 'focus' ? 'Mermaid Focus View' : 'Mermaid Diagram'}
          </div>
          <div className="text-xs text-[var(--text-secondary)]">
            WHEEL ZOOM | LEFT/RIGHT-DRAG PAN | DOUBLE-CLICK FIT
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="min-w-0 max-w-40 truncate text-xs text-[var(--text-secondary)]">
            {exportMessage}
          </div>
          <span className="min-w-14 text-right text-xs tabular-nums text-[var(--text-secondary)]">
            <span ref={zoomLabelRef} data-testid={`${testIdPrefix}-zoom-level`}>
              {Math.round(viewStateRef.current.scale * 100)}%
            </span>
          </span>
          <ToolbarTextButton
            label="Export Mermaid SVG"
            onClick={() => {
              void handleExport('svg');
            }}
            testId={`${testIdPrefix}-export-svg`}
            disabled={!svg || exportingFormat !== null}
          >
            SVG
          </ToolbarTextButton>
          <ToolbarTextButton
            label="Export Mermaid PNG"
            onClick={() => {
              void handleExport('png');
            }}
            testId={`${testIdPrefix}-export-png`}
            disabled={!svg || exportingFormat !== null}
          >
            PNG
          </ToolbarTextButton>
          {onOpenFocus && active && (
            <ToolbarButton label="Open Mermaid focus view" onClick={onOpenFocus} testId={`${testIdPrefix}-open-focus`}>
              <FocusIcon />
            </ToolbarButton>
          )}
          <ToolbarButton label="Zoom out Mermaid diagram" onClick={handleZoomOut} testId={`${testIdPrefix}-zoom-out`}>
            <ZoomOutIcon />
          </ToolbarButton>
          <ToolbarButton label="Reset Mermaid zoom" onClick={handleReset} testId={`${testIdPrefix}-reset-zoom`}>
            <span className="text-[11px] font-semibold">1:1</span>
          </ToolbarButton>
          <ToolbarButton label="Fit Mermaid viewport" onClick={handleFit} testId={`${testIdPrefix}-fit-view`}>
            <FitIcon />
          </ToolbarButton>
          <ToolbarButton label="Zoom in Mermaid diagram" onClick={handleZoomIn} testId={`${testIdPrefix}-zoom-in`}>
            <ZoomInIcon />
          </ToolbarButton>
        </div>
      </div>
      <div
        ref={viewportRef}
        data-testid={`${testIdPrefix}-viewport`}
        className={`${viewportHeightClass} relative overflow-hidden bg-[rgba(12,12,12,0.3)]`}
        style={{
          cursor: 'grab',
          userSelect: 'none',
          touchAction: 'none',
        }}
        onContextMenu={handleContextMenu}
      >
        {!svg ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--text-secondary)]">
            Rendering Mermaid diagram...
          </div>
        ) : (
          <div
            ref={transformHostRef}
            data-testid={`${testIdPrefix}-transform-host`}
            className="absolute inset-0"
          >
            <div
              ref={hostRef}
              data-testid={`${testIdPrefix}-canvas`}
              className="h-full w-full"
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </div>
        )}
      </div>
    </section>
  );
}
