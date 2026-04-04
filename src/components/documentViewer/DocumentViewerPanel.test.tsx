import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach } from 'vitest';
import { describe, expect, it, vi } from 'vitest';
import { DocumentViewerPanel } from './DocumentViewerPanel';

const resolvePreviewRendererMock = vi.fn((_context?: unknown, _mode?: unknown) => ({
  render: ({ mode }: { mode: 'source' | 'preview' }) => (
    <div data-testid="document-renderer-mode">
      <div data-source-line="1">line-1</div>
      <div data-source-line="2">line-2</div>
      <div data-source-line="3">line-3</div>
      <span>{mode}</span>
    </div>
  ),
}));
const useDocumentContentMock = vi.fn((_filePath: string, _enabled: boolean) => ({
  result: {
    content: '# Title',
    isBinary: false,
    tooLarge: false,
  },
  loading: false,
  error: '',
}));

vi.mock('./useDocumentContent', () => ({
  useDocumentContent: (filePath: string, enabled: boolean) => useDocumentContentMock(filePath, enabled),
}));

vi.mock('./renderers', () => ({
  resolvePreviewRenderer: (context: unknown, mode: unknown) => resolvePreviewRendererMock(context, mode),
}));

describe('DocumentViewerPanel', () => {
  beforeEach(() => {
    resolvePreviewRendererMock.mockClear();
    useDocumentContentMock.mockClear();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('emits mode changes so the workspace tab can stay in sync', () => {
    const onModeChange = vi.fn();

    render(
      <DocumentViewerPanel
        filePath="D:/code/JavaScript/mini-term/README.md"
        mode="source"
        onModeChange={onModeChange}
        onClose={vi.fn()}
        variant="tab"
      />,
    );

    fireEvent.click(screen.getByTestId('embedded-file-viewer-preview-toggle'));

    expect(onModeChange).toHaveBeenCalledWith('preview');
  });

  it('renders using the current mode supplied by the workspace tab', () => {
    render(
      <DocumentViewerPanel
        filePath="D:/code/JavaScript/mini-term/README.md"
        mode="preview"
        onModeChange={vi.fn()}
        onClose={vi.fn()}
        variant="tab"
      />,
    );

    const region = screen.getByRole('region', { name: 'File viewer: README.md' });

    expect(region.getAttribute('data-language-family')).toBe('docs');
    expect(region.getAttribute('data-language-id')).toBe('markdown');
    expect(region.getAttribute('data-viewer-variant')).toBe('docs');
    expect(screen.getByTestId('document-renderer-mode').textContent).toContain('preview');
    expect(resolvePreviewRendererMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'preview',
        language: expect.objectContaining({ family: 'docs', languageId: 'markdown' }),
        skin: expect.objectContaining({ family: 'docs' }),
      }),
      'preview',
    );
  });

  it('passes the active flag into document loading so hidden tabs can suspend heavy work', () => {
    render(
      <DocumentViewerPanel
        filePath="D:/code/JavaScript/mini-term/README.md"
        mode="source"
        active={false}
        onModeChange={vi.fn()}
        onClose={vi.fn()}
        variant="tab"
      />,
    );

    expect(useDocumentContentMock).toHaveBeenCalledWith(
      'D:/code/JavaScript/mini-term/README.md',
      false,
    );
  });

  it('scrolls to and highlights the requested source line', async () => {
    render(
      <DocumentViewerPanel
        filePath="D:/code/JavaScript/mini-term/src/App.tsx"
        mode="source"
        navigationTarget={{
          line: 2,
          column: 4,
          requestId: 1,
        }}
        onClose={vi.fn()}
        variant="tab"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('line-2').getAttribute('data-source-active-line')).toBe('true');
    });
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('reapplies navigation when the same line is requested with a new request id', async () => {
    const { rerender } = render(
      <DocumentViewerPanel
        filePath="D:/code/JavaScript/mini-term/src/App.tsx"
        mode="source"
        navigationTarget={{
          line: 2,
          requestId: 1,
        }}
        onClose={vi.fn()}
        variant="tab"
      />,
    );

    await waitFor(() => {
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
    });

    rerender(
      <DocumentViewerPanel
        filePath="D:/code/JavaScript/mini-term/src/App.tsx"
        mode="source"
        navigationTarget={{
          line: 2,
          requestId: 2,
        }}
        onClose={vi.fn()}
        variant="tab"
      />,
    );

    await waitFor(() => {
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByText('line-2').getAttribute('data-source-active-line')).toBe('true');
  });
});
