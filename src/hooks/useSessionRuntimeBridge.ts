import { useCallback, useEffect, useRef } from 'react';
import { useAppStore } from '../store';
import { useTauriEvent } from './useTauriEvent';
import type {
  PaneStatus,
  PtyExitPayload,
  PtyOutputPayload,
  PtySessionCommandPayload,
  PtySessionCreatedPayload,
  PtySessionPhasePayload,
  PtyStatusChangePayload,
} from '../types';

export function useSessionRuntimeBridge() {
  const updatePaneStatusByPty = useAppStore((state) => state.updatePaneStatusByPty);
  const upsertSession = useAppStore((state) => state.upsertSession);
  const updateSessionPhase = useAppStore((state) => state.updateSessionPhase);
  const recordSessionCommand = useAppStore((state) => state.recordSessionCommand);
  const finishSessionCommand = useAppStore((state) => state.finishSessionCommand);
  const sessionIdleTimersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  useTauriEvent<PtyStatusChangePayload>(
    'pty-status-change',
    useCallback(
      (payload) => {
        updatePaneStatusByPty(payload.ptyId, payload.status as PaneStatus);
      },
      [updatePaneStatusByPty],
    ),
  );

  useTauriEvent<PtyExitPayload>(
    'pty-exit',
    useCallback(
      (payload) => {
        const idleTimer = sessionIdleTimersRef.current.get(payload.ptyId);
        if (idleTimer) {
          clearTimeout(idleTimer);
          sessionIdleTimersRef.current.delete(payload.ptyId);
        }

        if (payload.exitCode !== 0) {
          updatePaneStatusByPty(payload.ptyId, 'error');
        }
      },
      [updatePaneStatusByPty],
    ),
  );

  useTauriEvent<PtySessionCreatedPayload>(
    'pty-session-created',
    useCallback(
      (payload) => {
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
      },
      [upsertSession],
    ),
  );

  useTauriEvent<PtySessionCommandPayload>(
    'pty-session-command-started',
    useCallback(
      (payload) => {
        recordSessionCommand(payload.ptyId, payload.command, payload.updatedAt);
      },
      [recordSessionCommand],
    ),
  );

  useTauriEvent<PtySessionPhasePayload>(
    'pty-session-phase-change',
    useCallback(
      (payload) => {
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
      },
      [finishSessionCommand, updateSessionPhase],
    ),
  );

  useTauriEvent<PtyOutputPayload>(
    'pty-output',
    useCallback(
      (payload) => {
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
      },
      [updateSessionPhase],
    ),
  );

  useEffect(() => {
    return () => {
      sessionIdleTimersRef.current.forEach((timer) => clearTimeout(timer));
      sessionIdleTimersRef.current.clear();
    };
  }, []);
}
