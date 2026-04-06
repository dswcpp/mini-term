import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileViewerModal } from './FileViewerModal';
import type { DocumentPreviewResult } from '../types';

const invokeMock = vi.fn();
const useWorkspaceAutoRefreshMock = vi.fn();
let latestAutoRefreshOptions: Record<string, unknown> | undefined;
const convertFileSrcMock = vi.fn((path: string) => `asset://${path}`);
const openPathMock = vi.fn((path: string, openWith?: string) => Promise.resolve({ path, openWith }));
const openUrlMock = vi.fn((url: string | URL, openWith?: string) => Promise.resolve({ url, openWith }));
const defaultRenderMermaidDiagram = async (source: string, _diagramId?: string) => ({
  svg: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 240" width="400" height="240">
      <rect x="24" y="24" width="352" height="192" rx="16" ry="16"></rect>
      <text x="48" y="120">${source}</text>
    </svg>
  `,
});
const renderMermaidDiagramMock = vi.fn(defaultRenderMermaidDiagram);
const defaultExportMermaidDiagram = async (_options?: unknown) => 'D:/exports/diagram.svg';
const exportMermaidDiagramMock = vi.fn(defaultExportMermaidDiagram);
const renderDocxPreviewMock = vi.fn(async (_data: Blob | ArrayBuffer, bodyContainer: HTMLElement) => {
  bodyContainer.innerHTML = '<div data-testid="docx-rendered">DOCX CONTENT</div>';
});
const pdfDocumentMock = vi.fn(
  ({
    children,
    file,
    loading,
    onLoadSuccess,
    onLoadError,
  }: {
    children?: ReactNode;
    file?: string | { data: Uint8Array };
    loading?: ReactNode;
    onLoadSuccess?: (value: { numPages: number }) => void;
    onLoadError?: (error: Error) => void;
  }) => {
    if (typeof file === 'string' && String(file).includes('broken.pdf')) {
      queueMicrotask(() => onLoadError?.(new Error('pdf failed')));
      return <div>{loading ?? null}</div>;
    }

    queueMicrotask(() => onLoadSuccess?.({ numPages: 3 }));
    return <div data-testid="pdf-document">{children}</div>;
  },
);
const pdfPageMock = vi.fn(({ pageNumber, scale }: { pageNumber?: number; scale?: number }) => (
  <div data-testid="pdf-page">{`page-${pageNumber}-scale-${scale}`}</div>
));
const fetchMock = vi.fn(async () => ({
  ok: true,
  arrayBuffer: async () => new ArrayBuffer(16),
}));

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

vi.mock('react-pdf', () => ({
  pdfjs: {
    GlobalWorkerOptions: {
      workerSrc: '',
    },
  },
  Document: (props: unknown) => pdfDocumentMock(props as never),
  Page: (props: unknown) => pdfPageMock(props as never),
}));

vi.mock('docx-preview', () => ({
  renderAsync: (...args: unknown[]) => renderDocxPreviewMock(...(args as [Blob | ArrayBuffer, HTMLElement])),
}));

function previewResult(
  kind: DocumentPreviewResult['kind'],
  overrides: Partial<DocumentPreviewResult> = {},
): DocumentPreviewResult {
  return {
    kind,
    tooLarge: false,
    byteLength: 128,
    ...overrides,
  };
}

function getMermaidTransformHost(prefix = 'mermaid') {
  return screen.getByTestId(`${prefix}-transform-host`);
}

function getMermaidCameraSignature(prefix = 'mermaid') {
  const host = getMermaidTransformHost(prefix);
  return host.getAttribute('data-camera-view-box') ?? '';
}

function getMermaidZoomLabel(prefix = 'mermaid') {
  return screen.getByTestId(`${prefix}-zoom-level`);
}

function setElementRect(element: Element, width: number, height: number, left = 0, top = 0) {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: left,
      y: top,
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      toJSON: () => ({}),
    }),
  });
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
    renderMermaidDiagramMock.mockReset();
    renderMermaidDiagramMock.mockImplementation(defaultRenderMermaidDiagram);
    exportMermaidDiagramMock.mockReset();
    exportMermaidDiagramMock.mockImplementation(defaultExportMermaidDiagram);
    renderDocxPreviewMock.mockClear();
    pdfDocumentMock.mockClear();
    pdfPageMock.mockClear();
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);

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
    invokeMock.mockResolvedValue(
      previewResult('markdown', {
        textContent: '# Title\n\n[Open site](https://example.com)\n\n![Diagram](./assets/diagram.png)',
      }),
    );

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
    invokeMock.mockResolvedValue(previewResult('markdown', { textContent: '# Preview First\n\nBody' }));

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
    invokeMock.mockResolvedValue(
      previewResult('markdown', { textContent: '```mermaid\ngraph TD\n  A[Start] --> B[Done]\n```' }),
    );

    render(
      <FileViewerModal
        open
        onClose={vi.fn()}
        filePath="D:\\code\\JavaScript\\mini-term\\docs\\flow.md"
        initialPreview
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('mermaid-svg')).not.toBeNull();
    });

    setElementRect(screen.getByTestId('mermaid-viewport'), 800, 600);
    fireEvent.click(screen.getByTestId('mermaid-fit-view'));

    const zoomLabel = getMermaidZoomLabel();
    await waitFor(() => {
      expect(zoomLabel.textContent).toBe('188%');
    });

    const initialZoom = zoomLabel.textContent;
    const initialViewport = getMermaidCameraSignature();
    fireEvent.click(screen.getByTestId('mermaid-zoom-in'));

    await waitFor(() => {
      expect(zoomLabel.textContent).not.toBe(initialZoom);
      expect(getMermaidCameraSignature()).not.toBe(initialViewport);
    });

    const afterZoomIn = zoomLabel.textContent;
    fireEvent.click(screen.getByTestId('mermaid-zoom-out'));

    await waitFor(() => {
      expect(zoomLabel.textContent).not.toBe(afterZoomIn);
    });

    fireEvent.click(screen.getByTestId('mermaid-reset-zoom'));

    await waitFor(() => {
      expect(zoomLabel.textContent).toBe('100%');
    });

    fireEvent.doubleClick(screen.getByTestId('mermaid-canvas'));

    await waitFor(() => {
      expect(zoomLabel.textContent).toBe(initialZoom);
    });

    fireEvent.click(screen.getByTestId('mermaid-fit-view'));

    await waitFor(() => {
      expect(zoomLabel.textContent).toBe(initialZoom);
    });

    const beforeWheelViewport = getMermaidCameraSignature();
    fireEvent.wheel(screen.getByTestId('mermaid-viewport'), {
      deltaY: -120,
      clientX: 240,
      clientY: 180,
    });

    await waitFor(() => {
      expect(zoomLabel.textContent).not.toBe(initialZoom);
      expect(getMermaidCameraSignature()).not.toBe(beforeWheelViewport);
    });

    const beforePanViewport = getMermaidCameraSignature();
    fireEvent.mouseDown(screen.getByTestId('mermaid-viewport'), {
      button: 2,
      clientX: 300,
      clientY: 220,
    });
    fireEvent.mouseMove(window, {
      buttons: 2,
      clientX: 260,
      clientY: 190,
    });
    fireEvent.mouseUp(window, { button: 2 });

    await waitFor(() => {
      expect(getMermaidCameraSignature()).not.toBe(beforePanViewport);
    });

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

    setElementRect(screen.getByTestId('mermaid-focus-viewport'), 1200, 800);
    fireEvent.click(screen.getByTestId('mermaid-focus-fit-view'));

    const focusZoomLabel = getMermaidZoomLabel('mermaid-focus');
    await waitFor(() => {
      expect(focusZoomLabel.textContent).toBe('288%');
    });

    const focusInitialZoom = focusZoomLabel.textContent;
    fireEvent.click(screen.getByTestId('mermaid-focus-zoom-in'));

    await waitFor(() => {
      expect(focusZoomLabel.textContent).not.toBe(focusInitialZoom);
    });

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
  });

  it('renders .mmd files directly in Mermaid preview mode', async () => {
    invokeMock.mockResolvedValue(
      previewResult('text', { textContent: 'graph TD\n  Start[Start] --> Finish[Done]' }),
    );

    render(
      <FileViewerModal
        open
        onClose={vi.fn()}
        filePath="D:\\code\\JavaScript\\mini-term\\docs\\flow.mmd"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('mermaid-focus-layer')).not.toBeNull();
    });

    setElementRect(screen.getByTestId('mermaid-focus-viewport'), 1200, 800);
    fireEvent.click(screen.getByTestId('mermaid-focus-fit-view'));

    expect(screen.getByTestId('file-viewer-preview-toggle').getAttribute('aria-label')).toContain('Mermaid');
    expect(screen.queryByTestId('mermaid-transform-host')).toBeNull();
    expect(screen.getByTestId('mermaid-focus-transform-host')).not.toBeNull();
    expect(renderMermaidDiagramMock).toHaveBeenCalledWith(
      'graph TD\n  Start[Start] --> Finish[Done]',
      expect.stringContaining('mini-term-mermaid-'),
    );

    fireEvent.click(screen.getByTestId('mermaid-focus-close'));

    await waitFor(() => {
      expect(screen.queryByTestId('mermaid-focus-layer')).toBeNull();
      expect(screen.getByTestId('mermaid-viewport').className).toContain('flex-1');
    });
  });

  it('keeps Mermaid drag interaction working over foreignObject labels', async () => {
    renderMermaidDiagramMock.mockResolvedValueOnce({
      svg: `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 240">
          <g>
            <rect x="24" y="24" width="180" height="72" rx="12" ry="12"></rect>
            <foreignObject x="24" y="24" width="180" height="72">
              <div xmlns="http://www.w3.org/1999/xhtml" style="display:flex;height:100%;align-items:center;justify-content:center;">
                <span>Start Label</span>
              </div>
            </foreignObject>
          </g>
        </svg>
      `,
    });
    invokeMock.mockResolvedValue(
      previewResult('text', { textContent: 'graph TD\n  Start[Start] --> Finish[Done]' }),
    );

    render(
      <FileViewerModal
        open
        onClose={vi.fn()}
        filePath="D:\\code\\JavaScript\\mini-term\\docs\\flow.mmd"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('mermaid-focus-layer')).not.toBeNull();
    });

    fireEvent.click(screen.getByTestId('mermaid-focus-close'));

    await waitFor(() => {
      expect(screen.queryByTestId('mermaid-focus-layer')).toBeNull();
      expect(within(screen.getByTestId('mermaid-canvas')).getByText('Start Label')).not.toBeNull();
    });

    setElementRect(screen.getByTestId('mermaid-viewport'), 800, 600);
    fireEvent.click(screen.getByTestId('mermaid-fit-view'));

    const label = within(screen.getByTestId('mermaid-canvas')).getByText('Start Label');
    const viewport = screen.getByTestId('mermaid-viewport');
    fireEvent.mouseDown(label, {
      button: 2,
      clientX: 260,
      clientY: 180,
    });

    await waitFor(() => {
      expect(viewport.style.cursor).toBe('grabbing');
    });

    fireEvent.mouseMove(window, {
      buttons: 2,
      clientX: 230,
      clientY: 140,
    });
    fireEvent.mouseUp(window, { button: 2 });

    await waitFor(() => {
      expect(viewport.style.cursor).toBe('grab');
    });
  });

  it('supports maximize and fullscreen toggles', async () => {
    invokeMock.mockResolvedValue(previewResult('markdown', { textContent: '# Window Controls' }));

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
    invokeMock.mockResolvedValue(previewResult('text', { textContent: 'export const value = 1;\n' }));

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
      .mockResolvedValueOnce(previewResult('markdown', { textContent: '# Initial' }))
      .mockResolvedValueOnce(previewResult('markdown', { textContent: '# Updated' }));

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
      expect(screen.getByTestId('dialog-document-refresh-feedback').textContent).not.toBe('');
    });
  });

  it('refreshes image preview sources when the same file changes', async () => {
    invokeMock
      .mockResolvedValueOnce(previewResult('image', { mimeType: 'image/png' }))
      .mockResolvedValueOnce(previewResult('image', { mimeType: 'image/png' }));

    render(
      <FileViewerModal
        open
        onClose={vi.fn()}
        filePath="D:\\code\\JavaScript\\mini-term\\docs\\preview.png"
      />,
    );

    const image = await screen.findByTestId('image-preview-renderer');
    expect(image.getAttribute('src')).toContain('?v=1');

    await (latestAutoRefreshOptions?.onFsChange as (() => Promise<void>) | undefined)?.();

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledTimes(2);
      expect(image.getAttribute('src')).toContain('?v=2');
    });
  });

  it('renders svg files in preview mode and allows switching back to source', async () => {
    invokeMock.mockResolvedValue(
      previewResult('svg', {
        mimeType: 'image/svg+xml',
        textContent: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      }),
    );

    render(
      <FileViewerModal
        open
        onClose={vi.fn()}
        filePath="D:\\code\\JavaScript\\mini-term\\docs\\diagram.svg"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('svg-preview-renderer')).not.toBeNull();
    });

    expect(convertFileSrcMock).toHaveBeenCalledWith('D:/code/JavaScript/mini-term/docs/diagram.svg');

    fireEvent.click(screen.getByTestId('file-viewer-preview-toggle'));

    await waitFor(() => {
      expect(screen.getByText('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).not.toBeNull();
    });
  });

  it('renders image previews in-app', async () => {
    invokeMock.mockResolvedValue(previewResult('image', { mimeType: 'image/png' }));

    render(
      <FileViewerModal
        open
        onClose={vi.fn()}
        filePath="D:\\code\\JavaScript\\mini-term\\docs\\preview.png"
      />,
    );

    const image = await screen.findByTestId('image-preview-renderer');
    expect(convertFileSrcMock).toHaveBeenCalledWith('D:/code/JavaScript/mini-term/docs/preview.png');
    expect(image.getAttribute('src')).toContain('preview.png');
    expect(image.getAttribute('src')).toContain('asset://');
    expect(screen.queryByTestId('file-viewer-preview-toggle')).toBeNull();
  });

  it('falls back to inline image data when desktop asset loading fails', async () => {
    invokeMock
      .mockResolvedValueOnce(previewResult('image', { mimeType: 'image/x-icon' }))
      .mockResolvedValueOnce('data:image/x-icon;base64,AAABAAEA');

    render(
      <FileViewerModal
        open
        onClose={vi.fn()}
        filePath="D:\\code\\JavaScript\\mini-term\\mini-term.ico"
      />,
    );

    const image = await screen.findByTestId('image-preview-renderer');
    fireEvent.error(image);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenNthCalledWith(2, 'read_image_data_url', {
        path: 'D:\\\\code\\\\JavaScript\\\\mini-term\\\\mini-term.ico',
      });
      expect(image.getAttribute('src')).toBe('data:image/x-icon;base64,AAABAAEA');
    });
  });

  it('renders PDF previews with zoom controls', async () => {
    invokeMock
      .mockResolvedValueOnce(previewResult('pdf', { mimeType: 'application/pdf' }))
      .mockResolvedValueOnce('JVBERi0xLjc=');

    render(
      <FileViewerModal
        open
        onClose={vi.fn()}
        filePath="D:\\code\\JavaScript\\mini-term\\docs\\guide.pdf"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('pdf-page').textContent).toContain('page-1');
    });

    expect(invokeMock).toHaveBeenNthCalledWith(2, 'read_binary_preview_base64', {
      path: 'D:\\\\code\\\\JavaScript\\\\mini-term\\\\docs\\\\guide.pdf',
    });

    fireEvent.click(screen.getByTestId('pdf-preview-zoom-in'));

    await waitFor(() => {
      expect(screen.getByText('110%')).not.toBeNull();
    });

    fireEvent.wheel(screen.getByTestId('pdf-preview-viewport'), {
      ctrlKey: true,
      deltaY: -100,
    });

    await waitFor(() => {
      expect(screen.getByText('120%')).not.toBeNull();
    });

    const pdfViewport = screen.getByTestId('pdf-preview-viewport');
    pdfViewport.scrollLeft = 20;
    pdfViewport.scrollTop = 30;
    fireEvent.mouseDown(pdfViewport, {
      button: 2,
      clientX: 100,
      clientY: 120,
    });
    fireEvent.mouseMove(window, {
      buttons: 2,
      clientX: 70,
      clientY: 80,
    });
    expect(pdfViewport.scrollLeft).toBe(50);
    expect(pdfViewport.scrollTop).toBe(70);
    fireEvent.mouseUp(window, { button: 2 });

    const firstFileProp = (pdfDocumentMock.mock.calls[0]?.[0] as { file?: { data: Uint8Array } }).file;
    const lastCall = pdfDocumentMock.mock.calls[pdfDocumentMock.mock.calls.length - 1];
    const lastFileProp = (lastCall?.[0] as { file?: { data: Uint8Array } }).file;
    expect(lastFileProp).toBe(firstFileProp);
  });

  it('reloads PDF bytes after a silent refresh on the same file path', async () => {
    invokeMock
      .mockResolvedValueOnce(previewResult('pdf', { mimeType: 'application/pdf' }))
      .mockResolvedValueOnce('JVBERi0xLjc=')
      .mockResolvedValueOnce(previewResult('pdf', { mimeType: 'application/pdf' }))
      .mockResolvedValueOnce('JVBERi0xLjcK');

    render(
      <FileViewerModal
        open
        onClose={vi.fn()}
        filePath="D:\\code\\JavaScript\\mini-term\\docs\\guide.pdf"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('pdf-page').textContent).toContain('page-1');
    });

    await (latestAutoRefreshOptions?.onFsChange as (() => Promise<void>) | undefined)?.();

    await waitFor(() => {
      expect(invokeMock).toHaveBeenNthCalledWith(4, 'read_binary_preview_base64', {
        path: 'D:\\\\code\\\\JavaScript\\\\mini-term\\\\docs\\\\guide.pdf',
      });
    });
  });

  it('renders DOCX previews in-app', async () => {
    invokeMock.mockResolvedValue(previewResult('docx', {
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }));

    render(
      <FileViewerModal
        open
        onClose={vi.fn()}
        filePath="D:\\code\\JavaScript\\mini-term\\docs\\guide.docx"
      />,
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
      expect(renderDocxPreviewMock).toHaveBeenCalled();
      expect(screen.getByTestId('docx-rendered').textContent).toBe('DOCX CONTENT');
    });

    expect(convertFileSrcMock).toHaveBeenCalledWith('D:/code/JavaScript/mini-term/docs/guide.docx');

    fireEvent.click(screen.getByTestId('docx-preview-zoom-in'));
    await waitFor(() => {
      expect(screen.getByTestId('docx-preview-scale').textContent).toBe('110%');
    });

    fireEvent.wheel(screen.getByTestId('docx-preview-viewport'), {
      ctrlKey: true,
      deltaY: -100,
    });
    await waitFor(() => {
      expect(screen.getByTestId('docx-preview-scale').textContent).toBe('120%');
      expect(screen.getByTestId('docx-preview-scale-frame').getAttribute('style')).toContain('scale(1.2)');
    });

    const docxViewport = screen.getByTestId('docx-preview-viewport');
    docxViewport.scrollLeft = 10;
    docxViewport.scrollTop = 15;
    fireEvent.mouseDown(docxViewport, {
      button: 2,
      clientX: 140,
      clientY: 160,
    });
    fireEvent.mouseMove(window, {
      buttons: 2,
      clientX: 100,
      clientY: 110,
    });
    expect(docxViewport.scrollLeft).toBe(50);
    expect(docxViewport.scrollTop).toBe(65);
    fireEvent.mouseUp(window, { button: 2 });
  });

  it('reloads DOCX content after a silent refresh on the same file path', async () => {
    invokeMock
      .mockResolvedValueOnce(previewResult('docx', {
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }))
      .mockResolvedValueOnce(previewResult('docx', {
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }));

    render(
      <FileViewerModal
        open
        onClose={vi.fn()}
        filePath="D:\\code\\JavaScript\\mini-term\\docs\\guide.docx"
      />,
    );

    await waitFor(() => {
      expect(renderDocxPreviewMock).toHaveBeenCalledTimes(1);
    });

    await (latestAutoRefreshOptions?.onFsChange as (() => Promise<void>) | undefined)?.();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(renderDocxPreviewMock).toHaveBeenCalledTimes(2);
    });
  });

  it('falls back to inline DOCX bytes when desktop asset loading fails', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    invokeMock
      .mockResolvedValueOnce(previewResult('docx', {
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }))
      .mockResolvedValueOnce('UEsDBA==');

    render(
      <FileViewerModal
        open
        onClose={vi.fn()}
        filePath="D:\\code\\JavaScript\\mini-term\\docs\\broken.docx"
      />,
    );

    await waitFor(() => {
      expect(invokeMock).toHaveBeenNthCalledWith(2, 'read_binary_preview_base64', {
        path: 'D:\\\\code\\\\JavaScript\\\\mini-term\\\\docs\\\\broken.docx',
      });
      expect(renderDocxPreviewMock).toHaveBeenCalled();
      expect(screen.getByTestId('docx-rendered').textContent).toBe('DOCX CONTENT');
    });
  });

  it('shows a fallback notice for legacy doc files', async () => {
    invokeMock.mockResolvedValue(previewResult('doc', {
      mimeType: 'application/msword',
      openExternallyRecommended: true,
      warning: 'Legacy documents require an external app.',
    }));

    render(
      <FileViewerModal
        open
        onClose={vi.fn()}
        filePath="D:\\code\\JavaScript\\mini-term\\docs\\legacy.doc"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('doc-preview-fallback').textContent).toContain('legacy .doc');
      expect(screen.getByTestId('document-preview-open-external')).not.toBeNull();
    });
  });
});
