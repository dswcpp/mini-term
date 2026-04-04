import {
  closeTerminalSession,
  createTerminalSession,
  restartTerminalSession,
  runTerminalCommand,
  writeTerminalInput,
} from './terminalApi';
import { mapCreatedTerminalSession } from './terminalSessionMeta';
import { useAppStore } from '../store';
import type { PtySessionCreatedPayload, SessionMode } from '../types';
import { disposeTerminalBySession } from '../utils/terminalCache';

export interface OpenTerminalSessionOptions {
  shell: string;
  args?: string[];
  cwd: string;
  sessionId?: string;
  mode?: SessionMode;
}

export async function openManagedTerminalSession(
  options: OpenTerminalSessionOptions,
): Promise<PtySessionCreatedPayload> {
  const payload = await createTerminalSession({
    shell: options.shell,
    args: options.args,
    cwd: options.cwd,
    sessionId: options.sessionId,
    mode: options.mode,
  });
  useAppStore.getState().upsertSession(mapCreatedTerminalSession(payload));
  return payload;
}

export async function restartManagedTerminalSession(
  options: OpenTerminalSessionOptions & { sessionId: string },
): Promise<PtySessionCreatedPayload> {
  const payload = await restartTerminalSession({
    sessionId: options.sessionId,
    shell: options.shell,
    args: options.args,
    cwd: options.cwd,
    mode: options.mode,
  });
  useAppStore.getState().upsertSession(mapCreatedTerminalSession(payload));
  return payload;
}

export async function closeManagedTerminalSession(sessionId: string): Promise<void> {
  try {
    await closeTerminalSession(sessionId);
  } finally {
    disposeTerminalBySession(sessionId);
    useAppStore.getState().removeSessionBySessionId(sessionId);
  }
}

export async function writeManagedTerminalInput(sessionId: string, data: string): Promise<void> {
  await writeTerminalInput(sessionId, data);
}

export async function runManagedTerminalCommand(sessionId: string, command: string): Promise<void> {
  await runTerminalCommand(sessionId, command);
}
