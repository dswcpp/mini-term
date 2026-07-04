import type { SshConnection } from '../types';

const SSH_SAFE_USER_RE = /^[A-Za-z0-9._-]+$/;
const SSH_SAFE_HOST_RE = /^[A-Za-z0-9._:[\]-]+$/;

export interface SshCommandValidation {
  ok: boolean;
  reason?: 'missing-user' | 'missing-host' | 'invalid-user' | 'invalid-host' | 'invalid-port';
}

export function validateSshConnectionTarget(conn: Pick<SshConnection, 'user' | 'host' | 'port'>): SshCommandValidation {
  const user = conn.user.trim();
  const host = conn.host.trim();
  if (!user) return { ok: false, reason: 'missing-user' };
  if (!host) return { ok: false, reason: 'missing-host' };
  if (!SSH_SAFE_USER_RE.test(user)) return { ok: false, reason: 'invalid-user' };
  if (!SSH_SAFE_HOST_RE.test(host)) return { ok: false, reason: 'invalid-host' };
  if (!Number.isInteger(conn.port) || conn.port <= 0 || conn.port > 65535) {
    return { ok: false, reason: 'invalid-port' };
  }
  return { ok: true };
}

function quoteForShell(value: string): string {
  return `"${value.replace(/\\/g, '/').replace(/"/g, '\\"')}"`;
}

/**
 * 构建写入当前交互式 shell 的 ssh 命令。
 *
 * user / host 只允许 OpenSSH 目标常用字符，避免把保存的连接配置变成任意 shell 片段。
 * identityPath 走双引号并把 Windows 反斜杠转为正斜杠，兼容 PowerShell / bash / nushell。
 */
export function buildSshCommand(conn: SshConnection, identityPath?: string): string {
  const normalized = {
    ...conn,
    user: conn.user.trim(),
    host: conn.host.trim(),
    port: conn.port || 22,
  };
  const validation = validateSshConnectionTarget(normalized);
  if (!validation.ok) {
    throw new Error(validation.reason ?? 'invalid-target');
  }

  const parts = ['ssh'];
  if (normalized.port !== 22) parts.push('-p', String(normalized.port));

  const identity = identityPath?.trim();
  if (identity) {
    parts.push('-i', quoteForShell(identity), '-o', 'IdentitiesOnly=yes');
  }

  parts.push(`${normalized.user}@${normalized.host}`);
  return parts.join(' ');
}
