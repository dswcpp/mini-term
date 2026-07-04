import { invoke } from '@tauri-apps/api/core';
import type { AppConfig, ShellConfig, TerminalEncoding } from '../types';

export interface CreateTerminalPtyArgs {
  shell: ShellConfig;
  cwd: string;
  envs: Array<[string, string]>;
  encoding: TerminalEncoding;
}

export function resolveTerminalShell(
  config: AppConfig,
  selectedShell?: ShellConfig,
  savedShellName?: string,
): ShellConfig | null {
  return selectedShell
    ?? (savedShellName ? config.availableShells.find((shell) => shell.name === savedShellName) : undefined)
    ?? config.availableShells.find((shell) => shell.name === config.defaultShell)
    ?? config.availableShells[0]
    ?? null;
}

export function createTerminalPty({
  shell,
  cwd,
  envs,
  encoding,
}: CreateTerminalPtyArgs): Promise<number> {
  return invoke<number>('create_pty', {
    shell: shell.command,
    args: shell.args ?? [],
    cwd,
    envs,
    encoding,
  });
}

export function setPtyEncoding(ptyId: number, encoding: TerminalEncoding): Promise<TerminalEncoding> {
  return invoke<TerminalEncoding>('set_pty_encoding', { ptyId, encoding });
}

export function killPty(ptyId: number): Promise<void> {
  return invoke('kill_pty', { ptyId });
}

export function killPtyQuietly(ptyId: number): void {
  void killPty(ptyId).catch(() => {});
}
