import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalViewport } from './TerminalViewport';
import type { TerminalThemeDefinition } from '../../theme';

const resizeTerminalSessionMock = vi.fn();
const getOrCreateTerminalMock = vi.fn();

vi.mock('../../utils/terminalCache', () => ({
  getOrCreateTerminal: (...args: unknown[]) => getOrCreateTerminalMock(...args),
}));

vi.mock('../../runtime/terminalApi', () => ({
  resizeTerminalSession: (...args: unknown[]) => resizeTerminalSessionMock(...args),
}));

class ResizeObserverMock {
  observe() {}
  disconnect() {}
}

class IntersectionObserverMock {
  observe() {}
  disconnect() {}
}

function createBufferLine(text: string, isWrapped = false) {
  return {
    isWrapped,
    length: text.length,
    translateToString: () => text,
  };
}

describe('TerminalViewport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
      ResizeObserverMock as unknown as typeof ResizeObserver;
    (globalThis as unknown as { IntersectionObserver: typeof IntersectionObserver }).IntersectionObserver =
      IntersectionObserverMock as unknown as typeof IntersectionObserver;

    getOrCreateTerminalMock.mockImplementation(() => {
      const wrapper = document.createElement('div');
      const registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }));
      const term = {
        options: {},
        rows: 24,
        cols: 80,
        buffer: {
          active: {
            length: 1,
            getLine: (line: number) => (line === 0 ? createBufferLine('src/App.tsx:12') : undefined),
          },
        },
        refresh: vi.fn(),
        focus: vi.fn(),
        registerLinkProvider,
      };
      const fitAddon = {
        fit: vi.fn(),
      };

      return {
        wrapper,
        term,
        fitAddon,
      };
    });
  });

  it('does not recreate the terminal wrapper when the context menu callback changes', () => {
    const firstContextMenu = vi.fn();
    const secondContextMenu = vi.fn();
    const terminalTheme = { background: '#000000' } as TerminalThemeDefinition;

    const { rerender } = render(
      <TerminalViewport
        workspaceId="workspace-7"
        tabId="tab-7"
        sessionId="session-7"
        paneId="pane-7"
        ptyId={7}
        fontSize={14}
        terminalTheme={terminalTheme}
        isActive
        isVisible
        onContextMenuRequest={firstContextMenu}
      />,
    );

    expect(getOrCreateTerminalMock).toHaveBeenCalledTimes(1);

    const wrapper = getOrCreateTerminalMock.mock.results[0]?.value.wrapper as HTMLDivElement;

    rerender(
      <TerminalViewport
        workspaceId="workspace-7"
        tabId="tab-7"
        sessionId="session-7"
        paneId="pane-7"
        ptyId={7}
        fontSize={14}
        terminalTheme={terminalTheme}
        isActive
        isVisible
        onContextMenuRequest={secondContextMenu}
      />,
    );

    expect(getOrCreateTerminalMock).toHaveBeenCalledTimes(1);

    fireEvent.contextMenu(wrapper, { clientX: 12, clientY: 16 });

    expect(firstContextMenu).not.toHaveBeenCalled();
    expect(secondContextMenu).toHaveBeenCalledWith(12, 16, undefined);
  });

  it('focuses the terminal when the pane becomes active and visible', async () => {
    const terminalTheme = { background: '#000000' } as TerminalThemeDefinition;

    render(
      <TerminalViewport
        workspaceId="workspace-9"
        tabId="tab-9"
        sessionId="session-9"
        paneId="pane-9"
        ptyId={9}
        fontSize={14}
        terminalTheme={terminalTheme}
        isActive
        isVisible
        onContextMenuRequest={vi.fn()}
      />,
    );

    const term = getOrCreateTerminalMock.mock.results[0]?.value.term as { focus: ReturnType<typeof vi.fn> };
    await waitFor(() => {
      expect(term.focus).toHaveBeenCalled();
    });
  });

  it('passes an open-link action to the context menu when a terminal link is hovered', () => {
    const onContextMenuRequest = vi.fn();
    const terminalTheme = { background: '#000000' } as TerminalThemeDefinition;

    render(
      <TerminalViewport
        workspaceId="workspace-5"
        tabId="tab-5"
        sessionId="session-5"
        paneId="pane-5"
        ptyId={5}
        fontSize={14}
        terminalTheme={terminalTheme}
        isActive
        isVisible
        onContextMenuRequest={onContextMenuRequest}
      />,
    );

    const result = getOrCreateTerminalMock.mock.results[0]?.value;
    const wrapper = result.wrapper as HTMLDivElement;
    const registerLinkProvider = result.term.registerLinkProvider as ReturnType<typeof vi.fn>;
    const provider = registerLinkProvider.mock.calls[0]?.[0] as {
      provideLinks: (
        line: number,
        callback: (links?: Array<{ text: string; hover?: () => void }>) => void,
      ) => void;
    };

    let links: Array<{ text: string; hover?: () => void }> | undefined;
    provider.provideLinks(1, (resolved) => {
      links = resolved;
    });

    links?.[0]?.hover?.();
    fireEvent.contextMenu(wrapper, { clientX: 24, clientY: 32 });

    expect(onContextMenuRequest).toHaveBeenCalledTimes(1);
    expect(onContextMenuRequest.mock.calls[0]?.[0]).toBe(24);
    expect(onContextMenuRequest.mock.calls[0]?.[1]).toBe(32);
    expect(onContextMenuRequest.mock.calls[0]?.[2]).toMatchObject({
      text: 'src/App.tsx:12',
    });
    expect(typeof onContextMenuRequest.mock.calls[0]?.[2]?.open).toBe('function');
  });
});
