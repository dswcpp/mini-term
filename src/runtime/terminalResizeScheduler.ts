const resizeTasks = new Map<string, () => void>();
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

function flushResizeTasks() {
  flushHandle = null;
  const tasks = [...resizeTasks.values()];
  resizeTasks.clear();
  tasks.forEach((task) => task());
}

export function scheduleTerminalResize(sessionId: string, task: () => void) {
  resizeTasks.set(sessionId, task);
  if (flushHandle == null) {
    flushHandle = getRaf()(flushResizeTasks);
  }
}

export function clearTerminalResize(sessionId: string) {
  resizeTasks.delete(sessionId);
}

export function stopTerminalResizeSchedulerForTests() {
  if (flushHandle != null) {
    getCancelRaf()(flushHandle);
    flushHandle = null;
  }
  resizeTasks.clear();
}
