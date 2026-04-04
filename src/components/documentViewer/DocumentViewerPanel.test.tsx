import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach } from 'vitest';
import { describe, expect, it, vi } from 'vitest';
import { DocumentViewerPanel } from './DocumentViewerPanel';

const resolvePreviewRendererMock = vi.fn((_context?: unknown, _mode?: unknown) => ({
  render: ({ mode }: { mode: 'source' | 'preview' }) => <div data-testid="document-renderer-mode">{mode}</div>,
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
    expect(screen.getByTestId('document-renderer-mode').textContent).toBe('preview');
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
});
