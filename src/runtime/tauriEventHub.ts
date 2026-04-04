import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  FsChangePayload,
  PtyExitPayload,
  PtyOutputPayload,
  PtySessionCommandPayload,
  PtySessionCreatedPayload,
  PtySessionCwdPayload,
  PtySessionPhasePayload,
  PtyStatusChangePayload,
} from '../types';

type EventPayloadMap = {
  'pty-exit': PtyExitPayload;
  'pty-output': PtyOutputPayload;
  'pty-session-command-started': PtySessionCommandPayload;
  'pty-session-created': PtySessionCreatedPayload;
  'pty-session-cwd-changed': PtySessionCwdPayload;
  'pty-session-phase-change': PtySessionPhasePayload;
  'pty-status-change': PtyStatusChangePayload;
  'fs-change': FsChangePayload;
};

type EventName = keyof EventPayloadMap;
type EventListener<K extends EventName> = (payload: EventPayloadMap[K]) => void;
type PtyOutputSink = (payload: PtyOutputPayload) => void;

const genericListeners = new Map<EventName, Set<(payload: unknown) => void>>();
const ptyOutputGlobalListeners = new Set<PtyOutputSink>();
const ptyOutputSinks = new Map<number, Set<PtyOutputSink>>();
const sessionOutputSinks = new Map<string, Set<PtyOutputSink>>();
const outputQueue = new Map<string, PtyOutputPayload>();
const unlistenMap = new Map<EventName, UnlistenFn>();
const listenPromises = new Map<EventName, Promise<void>>();

let outputFlushHandle: number | null = null;

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

function dispatchGeneric<K extends EventName>(event: K, payload: EventPayloadMap[K]) {
  genericListeners.get(event)?.forEach((listener) => {
    (listener as EventListener<K>)(payload);
  });
}

function flushQueuedPtyOutput() {
  outputFlushHandle = null;

  for (const payload of outputQueue.values()) {
    ptyOutputGlobalListeners.forEach((listener) => listener(payload));

    const sinks = ptyOutputSinks.get(payload.ptyId);
    if (sinks && payload.data) {
      sinks.forEach((sink) => sink(payload));
    }

    const sessionSinks = payload.sessionId ? sessionOutputSinks.get(payload.sessionId) : undefined;
    if (sessionSinks && payload.data) {
      sessionSinks.forEach((sink) => sink(payload));
    }
  }

  outputQueue.clear();
}

function queuePtyOutput(payload: PtyOutputPayload) {
  const queueKey = payload.sessionId || `pty-${payload.ptyId}`;
  const existing = outputQueue.get(queueKey);
  outputQueue.set(queueKey, {
    sessionId: payload.sessionId,
    ptyId: payload.ptyId,
    data: `${existing?.data ?? ''}${payload.data}`,
  });
  if (outputFlushHandle == null) {
    outputFlushHandle = getRaf()(flushQueuedPtyOutput);
  }
}

async function ensureEventListener<K extends EventName>(event: K) {
  if (unlistenMap.has(event)) {
    return;
  }

  const pending = listenPromises.get(event);
  if (pending) {
    await pending;
    return;
  }

  const promise = listen<EventPayloadMap[K]>(event, (evt) => {
    if (event === 'pty-output') {
      queuePtyOutput(evt.payload as PtyOutputPayload);
      return;
    }
    dispatchGeneric(event, evt.payload);
  }).then((unlisten) => {
    unlistenMap.set(event, unlisten);
    listenPromises.delete(event);
  });

  listenPromises.set(event, promise);
  await promise;
}

function subscribeGeneric<K extends EventName>(event: K, listener: EventListener<K>) {
  const listeners = genericListeners.get(event) ?? new Set<(payload: unknown) => void>();
  listeners.add(listener as (payload: unknown) => void);
  genericListeners.set(event, listeners);

  void ensureEventListener(event);

  return () => {
    const current = genericListeners.get(event);
    if (!current) {
      return;
    }
    current.delete(listener as (payload: unknown) => void);
    if (current.size === 0) {
      genericListeners.delete(event);
    }
  };
}

export function subscribePtyOutput(ptyId: number, sink: PtyOutputSink) {
  const sinks = ptyOutputSinks.get(ptyId) ?? new Set<PtyOutputSink>();
  sinks.add(sink);
  ptyOutputSinks.set(ptyId, sinks);

  void ensureEventListener('pty-output');

  return () => {
    const current = ptyOutputSinks.get(ptyId);
    if (!current) {
      return;
    }
    current.delete(sink);
    if (current.size === 0) {
      ptyOutputSinks.delete(ptyId);
    }
  };
}

export function subscribeSessionOutput(sessionId: string, sink: PtyOutputSink) {
  const sinks = sessionOutputSinks.get(sessionId) ?? new Set<PtyOutputSink>();
  sinks.add(sink);
  sessionOutputSinks.set(sessionId, sinks);

  void ensureEventListener('pty-output');

  return () => {
    const current = sessionOutputSinks.get(sessionId);
    if (!current) {
      return;
    }
    current.delete(sink);
    if (current.size === 0) {
      sessionOutputSinks.delete(sessionId);
      outputQueue.delete(sessionId);
    }
  };
}

export function subscribePtyOutputStream(listener: PtyOutputSink) {
  ptyOutputGlobalListeners.add(listener);
  void ensureEventListener('pty-output');

  return () => {
    ptyOutputGlobalListeners.delete(listener);
  };
}

export function subscribePtyExit(listener: EventListener<'pty-exit'>) {
  return subscribeGeneric('pty-exit', listener);
}

export function subscribePtyStatusChange(listener: EventListener<'pty-status-change'>) {
  return subscribeGeneric('pty-status-change', listener);
}

export function subscribePtySessionCreated(listener: EventListener<'pty-session-created'>) {
  return subscribeGeneric('pty-session-created', listener);
}

export function subscribePtySessionCommandStarted(listener: EventListener<'pty-session-command-started'>) {
  return subscribeGeneric('pty-session-command-started', listener);
}

export function subscribePtySessionCwdChanged(listener: EventListener<'pty-session-cwd-changed'>) {
  return subscribeGeneric('pty-session-cwd-changed', listener);
}

export function subscribePtySessionPhaseChange(listener: EventListener<'pty-session-phase-change'>) {
  return subscribeGeneric('pty-session-phase-change', listener);
}

export function subscribeFsChange(listener: EventListener<'fs-change'>) {
  return subscribeGeneric('fs-change', listener);
}

export async function stopTauriEventHubForTests() {
  if (outputFlushHandle != null) {
    getCancelRaf()(outputFlushHandle);
    outputFlushHandle = null;
  }

  outputQueue.clear();
  ptyOutputGlobalListeners.clear();
  ptyOutputSinks.clear();
  sessionOutputSinks.clear();
  genericListeners.clear();

  await Promise.all([...listenPromises.values()].map((promise) => promise.catch(() => undefined)));
  listenPromises.clear();

  for (const unlisten of unlistenMap.values()) {
    unlisten();
  }
  unlistenMap.clear();
}
