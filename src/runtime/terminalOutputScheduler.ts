const queuedOutput = new Map<string, string>();
const writers = new Map<string, (data: string) => void>();
let flushHandle: number | null = null;

function getRaf() {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    return window.requestAnimationFrame.bind(window);
  }
  return (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 16);
}

function getCancelRaf() {
  if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
    return window.cancelAnimationFrame.bind(window);
  }
  return (handle: number) => window.clearTimeout(handle);
}

function flushQueuedOutput() {
  flushHandle = null;

  for (const [sessionId, data] of queuedOutput) {
    if (!data) {
      continue;
    }
    writers.get(sessionId)?.(data);
  }

  queuedOutput.clear();
}

export function queueTerminalOutput(sessionId: string, writer: (data: string) => void, data: string) {
  if (!data) {
    return;
  }

  writers.set(sessionId, writer);
  queuedOutput.set(sessionId, `${queuedOutput.get(sessionId) ?? ''}${data}`);

  if (flushHandle == null) {
    flushHandle = getRaf()(flushQueuedOutput);
  }
}

export function clearTerminalOutput(sessionId: string) {
  queuedOutput.delete(sessionId);
  writers.delete(sessionId);
}

export function stopTerminalOutputSchedulerForTests() {
  if (flushHandle != null) {
    getCancelRaf()(flushHandle);
    flushHandle = null;
  }

  queuedOutput.clear();
  writers.clear();
}
