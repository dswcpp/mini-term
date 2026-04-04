import type { PtySessionCreatedPayload, TerminalSessionMeta } from '../types';

export function mapCreatedTerminalSession(payload: PtySessionCreatedPayload): TerminalSessionMeta {
  return {
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
  };
}
