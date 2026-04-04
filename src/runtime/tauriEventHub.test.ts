import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listenMock = vi.fn();
const eventHandlers = new Map<string, (event: { payload: unknown }) => void>();

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

describe('tauriEventHub', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    eventHandlers.clear();
    listenMock.mockReset();
    listenMock.mockImplementation((event: string, handler: (event: { payload: unknown }) => void) => {
      eventHandlers.set(event, handler);
      return Promise.resolve(() => {
        eventHandlers.delete(event);
      });
    });
    vi.stubGlobal('requestAnimationFrame', ((callback: FrameRequestCallback) => setTimeout(() => callback(0), 0)) as typeof requestAnimationFrame);
    vi.stubGlobal('cancelAnimationFrame', ((handle: number) => clearTimeout(handle)) as typeof cancelAnimationFrame);
  });

  afterEach(async () => {
    const hub = await import('./tauriEventHub');
    await hub.stopTauriEventHubForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('registers a single pty-output listener and batches writes per pty', async () => {
    const hub = await import('./tauriEventHub');
    const sinkA = vi.fn();
    const sinkB = vi.fn();

    const unsubscribeA = hub.subscribePtyOutput(1, sinkA);
    const unsubscribeB = hub.subscribePtyOutput(2, sinkB);

    await Promise.resolve();
    expect(listenMock.mock.calls.filter(([event]) => event === 'pty-output')).toHaveLength(1);

    eventHandlers.get('pty-output')?.({ payload: { ptyId: 1, data: 'git ' } });
    eventHandlers.get('pty-output')?.({ payload: { ptyId: 1, data: 'status' } });
    eventHandlers.get('pty-output')?.({ payload: { ptyId: 2, data: 'npm test' } });

    await vi.advanceTimersByTimeAsync(1);

    expect(sinkA).toHaveBeenCalledTimes(1);
    expect(sinkA).toHaveBeenCalledWith({ ptyId: 1, data: 'git status' });
    expect(sinkB).toHaveBeenCalledTimes(1);
    expect(sinkB).toHaveBeenCalledWith({ ptyId: 2, data: 'npm test' });

    unsubscribeA();
    unsubscribeB();
  });
});
