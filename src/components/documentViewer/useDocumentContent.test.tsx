import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useDocumentContent } from './useDocumentContent';
import type { DocumentPreviewResult } from '../../types';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: unknown) => invokeMock(command, args),
}));

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function HookHarness({
  filePath,
  projectPath = 'D:/code/JavaScript/mini-term',
  enabled = true,
}: {
  filePath: string;
  projectPath?: string;
  enabled?: boolean;
}) {
  const state = useDocumentContent(filePath, projectPath, enabled);

  return (
    <div>
      <div data-testid="loading">{state.loading ? 'true' : 'false'}</div>
      <div data-testid="refreshing">{state.refreshing ? 'true' : 'false'}</div>
      <div data-testid="error">{state.error}</div>
      <div data-testid="content">{state.result?.textContent ?? ''}</div>
      <button
        type="button"
        data-testid="silent-reload"
        onClick={() => {
          void state.reload({ silent: true });
        }}
      >
        reload
      </button>
    </div>
  );
}

describe('useDocumentContent', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  function previewResult(textContent: string): DocumentPreviewResult {
    return {
      kind: 'markdown',
      textContent,
      tooLarge: false,
      byteLength: textContent.length,
    };
  }

  it('shows loading during the initial fetch', async () => {
    const deferred = createDeferred<DocumentPreviewResult>();
    invokeMock.mockReturnValueOnce(deferred.promise);

    render(<HookHarness filePath="D:/code/JavaScript/mini-term/README.md" />);

    expect(screen.getByTestId('loading').textContent).toBe('true');
    expect(screen.getByTestId('content').textContent).toBe('');

    await act(async () => {
      deferred.resolve(previewResult('# Title'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
      expect(screen.getByTestId('content').textContent).toBe('# Title');
    });
  });

  it('keeps previous content visible during silent reload and marks refreshing', async () => {
    const deferred = createDeferred<DocumentPreviewResult>();
    invokeMock
      .mockResolvedValueOnce(previewResult('# Old'))
      .mockReturnValueOnce(deferred.promise);

    render(<HookHarness filePath="D:/code/JavaScript/mini-term/README.md" />);

    await waitFor(() => {
      expect(screen.getByTestId('content').textContent).toBe('# Old');
    });

    fireEvent.click(screen.getByTestId('silent-reload'));

    expect(screen.getByTestId('content').textContent).toBe('# Old');
    expect(screen.getByTestId('refreshing').textContent).toBe('true');
    expect(screen.getByTestId('loading').textContent).toBe('false');

    await act(async () => {
      deferred.resolve(previewResult('# New'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('refreshing').textContent).toBe('false');
      expect(screen.getByTestId('content').textContent).toBe('# New');
    });
  });

  it('preserves previous content and exposes the error when silent reload fails', async () => {
    invokeMock
      .mockResolvedValueOnce(previewResult('# Stable'))
      .mockRejectedValueOnce(new Error('read failed'));

    render(<HookHarness filePath="D:/code/JavaScript/mini-term/README.md" />);

    await waitFor(() => {
      expect(screen.getByTestId('content').textContent).toBe('# Stable');
    });

    fireEvent.click(screen.getByTestId('silent-reload'));

    await waitFor(() => {
      expect(screen.getByTestId('refreshing').textContent).toBe('false');
      expect(screen.getByTestId('content').textContent).toBe('# Stable');
      expect(screen.getByTestId('error').textContent).toContain('read failed');
    });
  });
});
