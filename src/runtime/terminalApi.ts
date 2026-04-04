import { invoke } from '@tauri-apps/api/core';
import type { PtySessionCreatedPayload } from '../types';

interface CreateTerminalSessionOptions {
  shell: string;
  args?: string[];
  cwd: string;
  sessionId?: string;
  mode?: string;
}

interface RestartTerminalSessionOptions {
  sessionId: string;
  shell: string;
  args?: string[];
  cwd: string;
  mode?: string;
}

export async function createTerminalSession(
  options: CreateTerminalSessionOptions,
): Promise<PtySessionCreatedPayload> {
  return invoke<PtySessionCreatedPayload>('create_terminal_session', {
    shell: options.shell,
    args: options.args ?? [],
    cwd: options.cwd,
    sessionId: options.sessionId,
    mode: options.mode,
  });
}

export async function restartTerminalSession(
  options: RestartTerminalSessionOptions,
): Promise<PtySessionCreatedPayload> {
  return invoke<PtySessionCreatedPayload>('restart_terminal_session', {
    sessionId: options.sessionId,
    shell: options.shell,
    args: options.args ?? [],
    cwd: options.cwd,
    mode: options.mode,
  });
}

export async function writeTerminalInput(sessionId: string, data: string): Promise<void> {
  await invoke('write_terminal_input', { sessionId, data });
}

export async function runTerminalCommand(sessionId: string, command: string): Promise<void> {
  await invoke('run_terminal_command', { sessionId, command });
}

export async function resizeTerminalSession(sessionId: string, cols: number, rows: number): Promise<void> {
  await invoke('resize_terminal_session', { sessionId, cols, rows });
}

export async function closeTerminalSession(sessionId: string): Promise<void> {
  await invoke('close_terminal_session', { sessionId });
}

export async function takeTerminalStartupOutput(sessionId: string): Promise<string> {
  return invoke<string>('take_terminal_startup_output', { sessionId });
}
