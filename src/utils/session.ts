import type { PaneState, SessionPhase, ShellKind, TerminalSessionMeta } from '../types';

export const getSessionIdForPty = (ptyId: number) => `session-${ptyId}`;

function inferShellKind(label: string): ShellKind {
  const normalized = label.toLowerCase();
  if (normalized.includes('powershell')) return 'powershell';
  if (normalized.includes('pwsh')) return 'pwsh';
  if (normalized.includes('cmd')) return 'cmd';
  if (normalized.includes('bash')) return 'bash';
  if (normalized.includes('zsh')) return 'zsh';
  return 'unknown';
}

export function createTerminalPane(
  shellName: string,
  ptyId: number,
  paneId: string,
  mode: PaneState['mode'] = 'human',
  runCommand?: string,
): PaneState {
  return {
    id: paneId,
    sessionId: getSessionIdForPty(ptyId),
    shellName,
    runCommand,
    status: 'idle',
    mode,
    phase: 'starting',
    ptyId,
  };
}

export function createTerminalSessionMeta(
  shellName: string,
  ptyId: number,
  cwd?: string,
  mode: TerminalSessionMeta['mode'] = 'human',
): TerminalSessionMeta {
  const now = Date.now();
  return {
    sessionId: getSessionIdForPty(ptyId),
    ptyId,
    shellKind: inferShellKind(shellName),
    mode,
    phase: 'starting',
    cwd,
    title: shellName,
    createdAt: now,
    updatedAt: now,
    commands: [],
  };
}

export function formatSessionPhaseLabel(phase?: SessionPhase): string {
  switch (phase) {
    case 'starting':
      return '启动中';
    case 'ready':
      return '就绪';
    case 'running':
      return '执行中';
    case 'waiting-input':
      return '等待输入';
    case 'error':
      return '错误';
    case 'exited':
      return '已退出';
    default:
      return '会话';
  }
}

export function formatCommandStatusLabel(status: TerminalSessionMeta['commands'][number]['status']): string {
  switch (status) {
    case 'running':
      return '进行中';
    case 'completed':
      return '已完成';
    case 'success':
      return '成功';
    case 'error':
      return '失败';
    case 'interrupted':
      return '中断';
    default:
      return '命令';
  }
}
