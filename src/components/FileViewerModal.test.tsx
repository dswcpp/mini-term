import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileViewerModal } from './FileViewerModal';

const invokeMock = vi.fn();
const useWorkspaceAutoRefreshMock = vi.fn();
let latestAutoRefreshOptions: Record<string, unknown> | undefined;
const convertFileSrcMock = vi.fn((path: string) => `asset://${path}`);
const openPathMock = vi.fn((path: string, openWith?: string) => Promise.resolve({ path, openWith }));
const openUrlMock = vi.fn((url: string | URL, openWith?: string) => Promise.resolve({ url, openWith }));
const renderMermaidDiagramMock = vi.fn(async (source: string, _diagramId?: string) => ({
  svg: `<svg><text>${source}</text></svg>`,
}));
const exportMermaidDiagramMock = vi.fn(async (_options?: unknown) => 'D:/exports/diagram.svg');

type PanZoomInstanceMock = {
  zoomIn: ReturnType<typeof vi.fn>;
  zoomOut: ReturnType<typeof vi.fn>;
  resetZoom: ReturnType<typeof vi.fn>;
  fit: ReturnType<typeof vi.fn>;
  center: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  getZoom: ReturnType<typeof vi.fn>;
};

let panZoomInstances: PanZoomInstanceMock[] = [];
const svgPanZoomMock = vi.fn((_svg?: SVGSVGElement, _options?: unknown) => {
  const instance = createPanZoomInstanceMock();
  panZoomInstances.push(instance);
  return instance;
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: unknown) => invokeMock(command, args),
  convertFileSrc: (path: string) => convertFileSrcMock(path),
}));

vi.mock('../hooks/useWorkspaceAutoRefresh', () => ({
  useWorkspaceAutoRefresh: (options: Record<string, unknown>) => {
    latestAutoRefreshOptions = options;
    useWorkspaceAutoRefreshMock(options);
  },
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: (path: string, openWith?: string) => openPathMock(path, openWith),
  openUrl: (url: string | URL, openWith?: string) => openUrlMock(url, openWith),
}));

vi.mock('../utils/markdownMermaid', () => ({
  renderMermaidDiagram: (source: string, diagramId: string) => renderMermaidDiagramMock(source, diagramId),
}));

vi.mock('../utils/mermaidExport', () => ({
  exportMermaidDiagram: (options: unknown) => exportMermaidDiagramMock(options),
}));

vi.mock('svg-pan-zoom', () => ({
  default: (svg: SVGSVGElement, options?: unknown) => svgPanZoomMock(svg, options),
}));

function createPanZoomInstanceMock(): PanZoomInstanceMock {
  const instance = {
    zoomIn: vi.fn(() => instance),
    zoomOut: vi.fn(() => instance),
    resetZoom: vi.fn(() => instance),
    fit: vi.fn(() => instance),
    center: vi.fn(() => instance),
    resize: vi.fn(() => instance),
    destroy: vi.fn(),
    getZoom: vi.fn(() => 1),
  };

  return instance;
}

describe('FileViewerModal', () => {
  let fullscreenElement: Element | null;
  let requestFullscreenMock: ReturnType<typeof vi.fn>;
  let exitFullscreenMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invokeMock.mockReset();
    useWorkspaceAutoRefreshMock.mockClear();
    latestAutoRefreshOptions = undefined;
    convertFileSrcMock.mockClear();
    openPathMock.mockClear();
    openUrlMock.mockClear();
    renderMermaidDiagramMock.mockClear();
    exportMermaidDiagramMock.mockClear();
    svgPanZoomMock.mockClear();
    panZoomInstances = [];

    fullscreenElement = null;
    requestFullscreenMock = vi.fn(function (this: Element) {
      fullscreenElement = this;
      document.dispatchEvent(new Event('fullscreenchange'));
      return Promise.resolve();
    });
    exitFullscreenMock = vi.fn(() => {
      fullscreenElement = null;
      document.dispatchEvent(new Event('fullscreenchange'));
      return Promise.resolve();
    });

    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => fullscreenElement,
    });
    Object.defineProperty(document, 'exitFullscreen', {
      configurable: true,
      value: exitFullscreenMock,
    });
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
      configurable: true,
      value: requestFullscreenMock,
    });
  });

  it('shows a markdown preview toggle and renders markdown when enabled', async () => {
    invokeMock.mockResolvedValue({
      content: '# Title\n\n[Open site](https://example.com)\n\n![Diagram](./assets/diagram.png)',
      isBinary: false,
      tooLarge: false,
    });

    render(
      <FileViewerModal
        open
        onClose={vi.fn()}
        filePath="D:\\code\\JavaScript\\mini-term\\README.md"
      />,
    );

    const toggle = await screen.findByTestId('file-viewer-preview-toggle');
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(screen.queryByRole('heading', { level: 1, name: 'Title' })).not.toBeNull();
    }, { timeout: 4000 });

    expect(convertFileSrcMock).toHaveBeenCalledWith('D:/code/JavaScript/mini-term/assets/diagram.png');

    fireEvent.click(screen.getByRole('link', { name: 'Open site' }));
    expect(openUrlMock).toHaveBeenCalledWith('https://example.com', undefined);
  });

  it('can open directly in preview mode', async () => {
    invokeMock.mockResolvedValue({
      content: '# Preview First\n\nBody',
      isBinary: false,
      tooLarge: false,
    });

    render(
      <FileViewerModal
        open
        onClose={vi.fn()}
        filePath="D:\\code\\JavaScript\\mini-term\\docs\\guide.md"
        initialPreview
      />,
    );

    await waitFor(() => {
      expect(screen.queryByRole('heading', { level: 1, name: 'Preview First' })).not.toBeNull();
    }, { timeout: 4000 });
  });

  it('renders mermaid fenced blocks as diagrams and wires zoom controls', async () => {
    invokeMock.mockResolvedValue({
      content: '```mermaid\ngraph TD\n  A[Start] --> B[Done]\n```',
      isBinary: false,
      tooLarge: false,
    });

    render(
      <FileViewerModal
        open
        onClose={vi.fn()}
        filePath="D:\\code\\JavaScript\\mini-term\\docs\\flow.md"
        initialPreview
      />,
    );

    await waitFor(() => {
      expect(svgPanZoomMock).toHaveBeenCalled();
    });

    const primaryInstance = panZoomInstances[0];
    primaryInstance.zoomIn.mockClear();
    primaryInstance.zoomOut.mockClear();
    primaryInstance.resetZoom.mockClear();
    primaryInstance.fit.mockClear();
    primaryInstance.center.mockClear();

    expect(screen.queryByTestId('mermaid-svg')).not.toBeNull();

    fireEvent.click(screen.getByTestId('mermaid-zoom-in'));
    fireEvent.click(screen.getByTestId('mermaid-zoom-out'));
    fireEvent.click(screen.getByTestId('mermaid-reset-zoom'));
    fireEvent.doubleClick(screen.getByTestId('mermaid-canvas'));
    fireEvent.click(screen.getByTestId('mermaid-fit-view'));
    fireEvent.click(screen.getByTestId('mermaid-export-svg'));

    await waitFor(() => {
      expect(exportMermaidDiagramMock).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByTestId('mermaid-export-png'));

    await waitFor(() => {
      expect(exportMermaidDiagramMock).toHaveBeenCalledTimes(2);
    });

    fireEvent.click(screen.getByTestId('mermaid-open-focus'));

    await waitFor(() => {
      expect(screen.queryByTestId('mermaid-focus-layer')).not.toBeNull();
    });

    const focusInstance = panZoomInstances[1];
    focusInstance.fit.mockClear();
    focusInstance.center.mockClear();
    fireEvent.click(screen.getByTestId('mermaid-focus-export-svg'));

    await waitFor(() => {
      expect(exportMermaidDiagramMock).toHaveBeenCalledTimes(3);
    });

    fireEvent.doubleClick(screen.getByTestId('mermaid-focus-canvas'));
    fireEvent.click(screen.getByTestId('mermaid-focus-close'));

    await waitFor(() => {
      expect(screen.queryByTestId('mermaid-focus-layer')).toBeNull();
    });

    expect(renderMermaidDiagramMock).toHaveBeenCalledWith(
      'graph TD\n  A[Start] --> B[Done]',
      expect.stringContaining('mini-term-mermaid-'),
    );
    const exportCalls = exportMermaidDiagramMock.mock.calls.map(([options]) => options);
    expect(exportCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          format: 'svg',
          baseName: expect.stringContaining('flow-mermaid-'),
        }),
        expect.objectContaining({
          format: 'png',
          baseName: expect.stringContaining('flow-mermaid-'),
        }),
      ]),
    );
    expect(primaryInstance.zoomIn).toHaveBeenCalled();
    expect(primaryInstance.zoomOut).toHaveBeenCalled();
    expect(primaryInstance.resetZoom).toHaveBeenCalled();
    expect(primaryInstance.fit).toHaveBeenCalledTimes(2);
    expect(primaryInstance.center).toHaveBeenCalledTimes(3);
    expect(focusInstance.fit).toHaveBeenCalled();
    expect(focusInstance.center).toHaveBeenCalled();
  });

  it('supports maximize and fullscreen toggles', async () => {
    invokeMock.mockResolvedValue({
      content: '# Window Controls',
      isBinary: false,
      tooLarge: false,
    });

    render(
      <FileViewerModal
        open
        onClose={vi.fn()}
        filePath="D:\\code\\JavaScript\\mini-term\\docs\\controls.md"
        initialPreview
      />,
    );

    await waitFor(() => {
      expect(screen.queryByRole('heading', { level: 1, name: 'Window Controls' })).not.toBeNull();
    });

    const dialog = screen.getByRole('dialog');
    const maximizeToggle = screen.getByTestId('file-viewer-maximize-toggle');
    const fullscreenToggle = screen.getByTestId('file-viewer-fullscreen-toggle');

    expect(dialog.getAttribute('data-layout-mode')).toBe('windowed');

    fireEvent.click(maximizeToggle);
    expect(dialog.getAttribute('data-layout-mode')).toBe('maximized');

    fireEvent.click(fullscreenToggle);
    await waitFor(() => {
      expect(requestFullscreenMock).toHaveBeenCalled();
      expect(dialog.getAttribute('data-layout-mode')).toBe('fullscreen');
    });

    fireEvent.click(fullscreenToggle);
    await waitFor(() => {
      expect(exitFullscreenMock).toHaveBeenCalled();
    });
  });

  it('does not show the preview toggle for non-markdown files', async () => {
    invokeMock.mockResolvedValue({
      content: 'export const value = 1;\n',
      isBinary: false,
      tooLarge: false,
    });

    render(
      <FileViewerModal
        open
        onClose={vi.fn()}
        filePath="D:\\code\\JavaScript\\mini-term\\src\\main.ts"
      />,
    );

    await screen.findByText('export const value = 1;');

    expect(screen.queryByTestId('file-viewer-preview-toggle')).toBeNull();
  });

  it('silently refreshes the open dialog after a matching fs change', async () => {
    invokeMock
      .mockResolvedValueOnce({
        content: '# Initial',
        isBinary: false,
        tooLarge: false,
      })
      .mockResolvedValueOnce({
        content: '# Updated',
        isBinary: false,
        tooLarge: false,
      });

    render(
      <FileViewerModal
        open
        onClose={vi.fn()}
        filePath="D:\\code\\JavaScript\\mini-term\\README.md"
        initialPreview
      />,
    );

    await waitFor(() => {
      expect(screen.queryByRole('heading', { level: 1, name: 'Initial' })).not.toBeNull();
    });

    await (latestAutoRefreshOptions?.onFsChange as (() => Promise<void>) | undefined)?.();

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('dialog-document-refresh-feedback').textContent).toContain('已自动刷新');
    });
  });
});
