import { useCallback, useEffect, useRef } from 'react';
import { useAppStore } from '../store';
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
    const unsubs = [
      subscribePtyStatusChange((payload: PtyStatusChangePayload) => {
        queuePaneStatus(payload.ptyId, payload.status as PaneStatus);
      }),
      subscribePtyExit((payload: PtyExitPayload) => {
        const idleTimer = sessionIdleTimersRef.current.get(payload.ptyId);
        if (idleTimer) {
          clearTimeout(idleTimer);
          sessionIdleTimersRef.current.delete(payload.ptyId);
        }

        if (payload.exitCode !== 0) {
          lastPaneStatusRef.current.delete(payload.ptyId);
          updatePaneStatusByPty(payload.ptyId, 'error');
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
        recordSessionCommand(payload.ptyId, payload.command, payload.updatedAt, payload.usageScope);
      }),
      subscribePtySessionCwdChanged((payload: PtySessionCwdPayload) => {
        updateSessionCwd(payload.ptyId, payload.cwd, payload.updatedAt);
      }),
      subscribePtySessionPhaseChange((payload: PtySessionPhasePayload) => {
        const idleTimer = sessionIdleTimersRef.current.get(payload.ptyId);
        if (idleTimer && (payload.phase === 'running' || payload.phase === 'exited' || payload.phase === 'error')) {
          clearTimeout(idleTimer);
          sessionIdleTimersRef.current.delete(payload.ptyId);
        }

        if (payload.phase === 'exited') {
          finishSessionCommand(payload.ptyId, payload.lastExitCode, payload.phase, payload.updatedAt);
          return;
        }

        updateSessionPhase(payload.ptyId, payload.phase, {
          lastExitCode: payload.lastExitCode,
          updatedAt: payload.updatedAt,
        });
      }),
      subscribePtyOutputStream((payload: PtyOutputPayload) => {
        const session = useAppStore.getState().sessions.get(payload.ptyId);
        if (!session || session.phase === 'exited' || session.phase === 'error') {
          return;
        }

        const existingTimer = sessionIdleTimersRef.current.get(payload.ptyId);
        if (existingTimer) {
          clearTimeout(existingTimer);
        }

        const timer = window.setTimeout(() => {
          sessionIdleTimersRef.current.delete(payload.ptyId);
          const current = useAppStore.getState().sessions.get(payload.ptyId);
          if (!current || current.phase === 'exited' || current.phase === 'error') {
            return;
          }

          updateSessionPhase(
            payload.ptyId,
            current.lastCommand ? 'waiting-input' : 'ready',
            { updatedAt: Date.now() },
          );
        }, 220);

        sessionIdleTimersRef.current.set(payload.ptyId, timer);
      }),
    ];

    return () => {
      unsubs.forEach((unsubscribe) => unsubscribe());
    };
  }, [
    finishSessionCommand,
    queuePaneStatus,
    recordSessionCommand,
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
