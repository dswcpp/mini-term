import { useCallback, useEffect, useRef } from 'react';
import { useAppStore } from '../store';
import { isTauriRuntime } from '../runtime/tauriRuntime';
import {
  subscribePtyExit,
  subscribePtyOutputStream,
  subscribePtySessionCommandStarted,
  subscribePtySessionCreated,
  subscribePtySessionCwdChanged,
  subscribePtySessionPhaseChange,
  subscribePtyStatusChange,
} from '../runtime/tauriEventHub';
import type {
  PaneStatus,
  PtySessionCwdPayload,
  PtyExitPayload,
  PtyOutputPayload,
  PtySessionCommandPayload,
  PtySessionCreatedPayload,
  PtySessionPhasePayload,
  PtyStatusChangePayload,
} from '../types';

export function useSessionRuntimeBridge() {
  const tauriAvailable = isTauriRuntime();
  const updatePaneStatusByPty = useAppStore((state) => state.updatePaneStatusByPty);
  const updatePaneStatusesByPty = useAppStore((state) => state.updatePaneStatusesByPty);
  const upsertSession = useAppStore((state) => state.upsertSession);
  const updateSessionCwd = useAppStore((state) => state.updateSessionCwd);
  const updateSessionPhase = useAppStore((state) => state.updateSessionPhase);
  const recordSessionCommand = useAppStore((state) => state.recordSessionCommand);
  const finishSessionCommand = useAppStore((state) => state.finishSessionCommand);
  const sessionIdleTimersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const pendingStatusUpdatesRef = useRef(new Map<number, PaneStatus>());
  const lastPaneStatusRef = useRef(new Map<number, PaneStatus>());
  const statusFrameRef = useRef<number | null>(null);

  const resolveActivePtyId = useCallback((payload: { ptyId: number; sessionId?: string }) => {
    const state = useAppStore.getState();
    const resolvedSessionId = payload.sessionId ?? state.sessionIdByPty.get(payload.ptyId);
    if (!resolvedSessionId) {
      return state.sessions.has(payload.ptyId) ? payload.ptyId : undefined;
    }

    const activePtyId = state.ptyBySessionId.get(resolvedSessionId);
    if (activePtyId != null && activePtyId !== payload.ptyId) {
      return undefined;
    }

    if (activePtyId != null) {
      return activePtyId;
    }

    return state.sessions.has(payload.ptyId) ? payload.ptyId : undefined;
  }, []);

  const flushPendingStatuses = useCallback(() => {
    statusFrameRef.current = null;
    if (pendingStatusUpdatesRef.current.size === 0) {
      return;
    }

    const updates: Array<{ ptyId: number; status: PaneStatus }> = [];
    for (const [ptyId, status] of pendingStatusUpdatesRef.current) {
      if (lastPaneStatusRef.current.get(ptyId) === status) {
        continue;
      }

      lastPaneStatusRef.current.set(ptyId, status);
      updates.push({ ptyId, status });
    }

    pendingStatusUpdatesRef.current.clear();
    if (updates.length > 0) {
      updatePaneStatusesByPty(updates);
    }
  }, [updatePaneStatusesByPty]);

  const queuePaneStatus = useCallback(
    (ptyId: number, status: PaneStatus) => {
      pendingStatusUpdatesRef.current.set(ptyId, status);
      if (statusFrameRef.current == null) {
        statusFrameRef.current = window.requestAnimationFrame(flushPendingStatuses);
      }
    },
    [flushPendingStatuses],
  );

  useEffect(() => {
    if (!tauriAvailable) {
      return;
    }

    const unsubs = [
      subscribePtyStatusChange((payload: PtyStatusChangePayload) => {
        const activePtyId = resolveActivePtyId(payload);
        if (activePtyId == null) {
          return;
        }

        queuePaneStatus(activePtyId, payload.status as PaneStatus);
      }),
      subscribePtyExit((payload: PtyExitPayload) => {
        const activePtyId = resolveActivePtyId(payload);
        if (activePtyId == null) {
          return;
        }

        const idleTimer = sessionIdleTimersRef.current.get(activePtyId);
        if (idleTimer) {
          clearTimeout(idleTimer);
          sessionIdleTimersRef.current.delete(activePtyId);
        }

        if (payload.exitCode !== 0) {
          lastPaneStatusRef.current.delete(activePtyId);
          updatePaneStatusByPty(activePtyId, 'error');
        }
      }),
      subscribePtySessionCreated((payload: PtySessionCreatedPayload) => {
        upsertSession({
          sessionId: payload.sessionId,
          ptyId: payload.ptyId,
          shellKind: payload.shellKind,
          mode: payload.mode,
          phase: payload.phase,
          cwd: payload.cwd,
          title: payload.shell,
          commands: [],
          createdAt: payload.createdAt,
          updatedAt: payload.updatedAt,
        });
      }),
      subscribePtySessionCommandStarted((payload: PtySessionCommandPayload) => {
        const activePtyId = resolveActivePtyId(payload);
        if (activePtyId == null) {
          return;
        }

        recordSessionCommand(activePtyId, payload.command, payload.updatedAt, payload.usageScope);
      }),
      subscribePtySessionCwdChanged((payload: PtySessionCwdPayload) => {
        const activePtyId = resolveActivePtyId(payload);
        if (activePtyId == null) {
          return;
        }

        updateSessionCwd(activePtyId, payload.cwd, payload.updatedAt);
      }),
      subscribePtySessionPhaseChange((payload: PtySessionPhasePayload) => {
        const activePtyId = resolveActivePtyId(payload);
        if (activePtyId == null) {
          return;
        }

        const idleTimer = sessionIdleTimersRef.current.get(activePtyId);
        if (idleTimer && (payload.phase === 'running' || payload.phase === 'exited' || payload.phase === 'error')) {
          clearTimeout(idleTimer);
          sessionIdleTimersRef.current.delete(activePtyId);
        }

        if (payload.phase === 'exited') {
          finishSessionCommand(activePtyId, payload.lastExitCode, payload.phase, payload.updatedAt);
          return;
        }

        updateSessionPhase(activePtyId, payload.phase, {
          lastExitCode: payload.lastExitCode,
          updatedAt: payload.updatedAt,
        });
      }),
      subscribePtyOutputStream((payload: PtyOutputPayload) => {
        const activePtyId = resolveActivePtyId(payload);
        if (activePtyId == null) {
          return;
        }

        const session = useAppStore.getState().sessions.get(activePtyId);
        if (!session || session.phase === 'exited' || session.phase === 'error') {
          return;
        }

        const existingTimer = sessionIdleTimersRef.current.get(activePtyId);
        if (existingTimer) {
          clearTimeout(existingTimer);
        }

        const timer = window.setTimeout(() => {
          sessionIdleTimersRef.current.delete(activePtyId);
          const current = useAppStore.getState().sessions.get(activePtyId);
          if (!current || current.phase === 'exited' || current.phase === 'error') {
            return;
          }

          updateSessionPhase(
            activePtyId,
            current.lastCommand ? 'waiting-input' : 'ready',
            { updatedAt: Date.now() },
          );
        }, 220);

        sessionIdleTimersRef.current.set(activePtyId, timer);
      }),
    ];

    return () => {
      unsubs.forEach((unsubscribe) => unsubscribe());
    };
  }, [
    finishSessionCommand,
    queuePaneStatus,
    recordSessionCommand,
    resolveActivePtyId,
    tauriAvailable,
    updatePaneStatusByPty,
    updateSessionCwd,
    updateSessionPhase,
    upsertSession,
  ]);

  useEffect(() => {
    return () => {
      if (statusFrameRef.current != null) {
        window.cancelAnimationFrame(statusFrameRef.current);
      }
      pendingStatusUpdatesRef.current.clear();
      lastPaneStatusRef.current.clear();
      sessionIdleTimersRef.current.forEach((timer) => clearTimeout(timer));
      sessionIdleTimersRef.current.clear();
    };
  }, []);
}
