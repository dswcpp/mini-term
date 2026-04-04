import { useEffect, useRef, useState } from 'react';
import svgPanZoom from 'svg-pan-zoom';
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

export function MermaidViewport({
  svg,
  bindFunctions,
  active = true,
  layoutMode,
  testIdPrefix,
  onOpenFocus,
  exportBaseName,
}: {
  svg: string;
  bindFunctions?: (element: Element) => void;
  active?: boolean;
  layoutMode: MermaidViewportMode;
  testIdPrefix: string;
  onOpenFocus?: () => void;
  exportBaseName: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const panZoomRef = useRef<SvgPanZoom.Instance | null>(null);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [exportingFormat, setExportingFormat] = useState<MermaidExportFormat | null>(null);
  const [exportMessage, setExportMessage] = useState('');

  useEffect(() => {
    if (!active || !svg || !hostRef.current) {
      return;
    }

    const svgElement = hostRef.current.querySelector('svg');
    if (!(svgElement instanceof SVGSVGElement)) {
      return;
    }

    svgElement.setAttribute('data-testid', testIdPrefix === 'mermaid' ? 'mermaid-svg' : `${testIdPrefix}-svg`);
    svgElement.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svgElement.style.width = '100%';
    svgElement.style.height = '100%';
    svgElement.style.maxWidth = 'none';

    const instance = svgPanZoom(svgElement, {
      panEnabled: true,
      zoomEnabled: true,
      dblClickZoomEnabled: false,
      mouseWheelZoomEnabled: true,
      preventMouseEventsDefault: true,
      fit: true,
      center: true,
      contain: false,
      minZoom: 0.2,
      maxZoom: 12,
      zoomScaleSensitivity: 0.25,
      onZoom: (nextZoom) => setZoomLevel(nextZoom),
    });

    panZoomRef.current = instance;
    instance.resize();
    instance.fit();
    instance.center();
    setZoomLevel(instance.getZoom());

    if (bindFunctions) {
      bindFunctions(hostRef.current);
    }

    return () => {
      panZoomRef.current?.destroy();
      panZoomRef.current = null;
    };
  }, [active, bindFunctions, svg, testIdPrefix]);

  useEffect(() => {
    if (!active || !panZoomRef.current) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      panZoomRef.current?.resize();
      panZoomRef.current?.center();
      setZoomLevel(panZoomRef.current?.getZoom() ?? 1);
    });

    return () => cancelAnimationFrame(frame);
  }, [active, layoutMode]);

  useEffect(() => {
    if (!exportMessage || exportingFormat) {
      return;
    }

    const timer = window.setTimeout(() => {
      setExportMessage('');
    }, 2600);

    return () => window.clearTimeout(timer);
  }, [exportMessage, exportingFormat]);

  const handleZoomIn = () => {
    panZoomRef.current?.zoomIn();
    setZoomLevel(panZoomRef.current?.getZoom() ?? zoomLevel);
  };

  const handleZoomOut = () => {
    panZoomRef.current?.zoomOut();
    setZoomLevel(panZoomRef.current?.getZoom() ?? zoomLevel);
  };

  const handleReset = () => {
    panZoomRef.current?.resetZoom();
    panZoomRef.current?.center();
    setZoomLevel(panZoomRef.current?.getZoom() ?? 1);
  };

  const handleFit = () => {
    panZoomRef.current?.fit();
    panZoomRef.current?.center();
    setZoomLevel(panZoomRef.current?.getZoom() ?? zoomLevel);
  };

  const handleExport = async (format: MermaidExportFormat) => {
    if (!svg || exportingFormat) {
      return;
    }

    setExportingFormat(format);
    setExportMessage(format === 'svg' ? '正在导出 SVG...' : '正在导出 PNG...');

    try {
      const savedPath = await exportMermaidDiagram({
        svgMarkup: svg,
        format,
        baseName: exportBaseName,
      });

      if (savedPath) {
        setExportMessage(`已导出 ${format.toUpperCase()}`);
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
    layoutMode === 'focus'
      ? 'h-[82vh] min-h-[640px]'
      : layoutMode === 'fullscreen'
        ? 'h-[72vh] min-h-[520px]'
        : layoutMode === 'maximized'
          ? 'h-[64vh] min-h-[460px]'
          : 'h-[min(56vh,560px)] min-h-[360px]';

  return (
    <section className="my-5 overflow-hidden rounded-xl border border-[var(--border-default)] bg-[rgba(8,8,8,0.26)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-default)] px-4 py-3">
        <div>
          <div className="text-sm font-medium text-[var(--text-primary)]">
            {layoutMode === 'focus' ? 'Mermaid 独立查看' : 'Mermaid 图表'}
          </div>
          <div className="text-xs text-[var(--text-secondary)]">
            支持鼠标滚轮缩放、拖拽平移，双击图表可快速适应视口
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="min-w-0 max-w-40 truncate text-xs text-[var(--text-secondary)]">
            {exportMessage}
          </div>
          <span className="min-w-14 text-right text-xs tabular-nums text-[var(--text-secondary)]">
            {Math.round(zoomLevel * 100)}%
          </span>
          <ToolbarTextButton
            label="导出 Mermaid SVG"
            onClick={() => {
              void handleExport('svg');
            }}
            testId={`${testIdPrefix}-export-svg`}
            disabled={!svg || exportingFormat !== null}
          >
            SVG
          </ToolbarTextButton>
          <ToolbarTextButton
            label="导出 Mermaid PNG"
            onClick={() => {
              void handleExport('png');
            }}
            testId={`${testIdPrefix}-export-png`}
            disabled={!svg || exportingFormat !== null}
          >
            PNG
          </ToolbarTextButton>
          {onOpenFocus && active && (
            <ToolbarButton label="独立查看 Mermaid 图" onClick={onOpenFocus} testId={`${testIdPrefix}-open-focus`}>
              <FocusIcon />
            </ToolbarButton>
          )}
          <ToolbarButton label="缩小 Mermaid 图" onClick={handleZoomOut} testId={`${testIdPrefix}-zoom-out`}>
            <ZoomOutIcon />
          </ToolbarButton>
          <ToolbarButton label="重置 Mermaid 缩放" onClick={handleReset} testId={`${testIdPrefix}-reset-zoom`}>
            <span className="text-[11px] font-semibold">1:1</span>
          </ToolbarButton>
          <ToolbarButton label="适应 Mermaid 视口" onClick={handleFit} testId={`${testIdPrefix}-fit-view`}>
            <FitIcon />
          </ToolbarButton>
          <ToolbarButton label="放大 Mermaid 图" onClick={handleZoomIn} testId={`${testIdPrefix}-zoom-in`}>
            <ZoomInIcon />
          </ToolbarButton>
        </div>
      </div>
      <div className={`${viewportHeightClass} overflow-hidden bg-[rgba(12,12,12,0.3)]`}>
        {!svg ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--text-secondary)]">
            正在渲染 Mermaid 图表...
          </div>
        ) : (
          <div
            ref={hostRef}
            data-testid={`${testIdPrefix}-canvas`}
            className="h-full w-full cursor-grab active:cursor-grabbing"
            onDoubleClick={(event) => {
              event.preventDefault();
              handleFit();
            }}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        )}
      </div>
    </section>
  );
}
