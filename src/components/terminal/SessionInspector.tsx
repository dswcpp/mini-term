import type { PaneState, TerminalSessionMeta } from '../../types';
import { formatCommandStatusLabel, formatSessionPhaseLabel } from '../../utils/session';

interface Props {
  pane?: PaneState | null;
  session?: TerminalSessionMeta;
}

function formatTimestamp(timestamp?: number) {
  if (!timestamp) return '暂无';
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function getStatusTone(status: TerminalSessionMeta['commands'][number]['status']) {
  switch (status) {
    case 'running':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200';
    case 'success':
      return 'border-sky-500/30 bg-sky-500/10 text-sky-200';
    case 'error':
      return 'border-rose-500/30 bg-rose-500/10 text-rose-200';
    case 'interrupted':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-200';
    default:
      return 'border-[var(--border-subtle)] bg-[var(--bg-overlay)] text-[var(--text-secondary)]';
  }
}

export function SessionInspector({ pane, session }: Props) {
  if (!pane || !session) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-[var(--text-muted)]">
        选择一个终端分屏后，这里会显示会话状态、命令历史和运行上下文。
      </div>
    );
  }

  const recentCommands = session.commands.slice(-8).reverse();

  return (
    <div className="flex h-full flex-col border-l border-[var(--border-subtle)] bg-[var(--bg-elevated)]">
      <div className="border-b border-[var(--border-subtle)] px-4 py-3">
        <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
          Runtime Inspector
        </div>
        <div className="mt-1 text-sm font-semibold text-[var(--text-primary)]">
          {pane.shellName}
        </div>
        <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-[var(--text-secondary)]">
          <span className="rounded-full border border-[var(--border-subtle)] px-2 py-0.5">
            {formatSessionPhaseLabel(session.phase)}
          </span>
          <span className="rounded-full border border-[var(--border-subtle)] px-2 py-0.5">
            {session.mode}
          </span>
          <span className="rounded-full border border-[var(--border-subtle)] px-2 py-0.5">
            {session.shellKind}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-px border-b border-[var(--border-subtle)] bg-[var(--border-subtle)] text-[11px]">
        <div className="bg-[var(--bg-elevated)] px-4 py-3">
          <div className="text-[var(--text-muted)]">Session ID</div>
          <div className="mt-1 truncate font-mono text-[var(--text-primary)]">{session.sessionId}</div>
        </div>
        <div className="bg-[var(--bg-elevated)] px-4 py-3">
          <div className="text-[var(--text-muted)]">PTY</div>
          <div className="mt-1 font-mono text-[var(--text-primary)]">{session.ptyId}</div>
        </div>
        <div className="bg-[var(--bg-elevated)] px-4 py-3">
          <div className="text-[var(--text-muted)]">Started</div>
          <div className="mt-1 text-[var(--text-primary)]">{formatTimestamp(session.createdAt)}</div>
        </div>
        <div className="bg-[var(--bg-elevated)] px-4 py-3">
          <div className="text-[var(--text-muted)]">Updated</div>
          <div className="mt-1 text-[var(--text-primary)]">{formatTimestamp(session.updatedAt)}</div>
        </div>
      </div>

      <div className="border-b border-[var(--border-subtle)] px-4 py-3 text-[11px]">
        <div className="text-[var(--text-muted)]">Working Directory</div>
        <div className="mt-1 break-all font-mono text-[var(--text-primary)]">
          {session.cwd ?? '未知'}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className="mb-3 text-[10px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
          Commands
        </div>
        <div className="space-y-2">
          {recentCommands.length === 0 && (
            <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--border-subtle)] px-3 py-4 text-xs text-[var(--text-muted)]">
              还没有记录到命令。后续这里可以继续扩成任务块、Agent 调用块和输出摘要。
            </div>
          )}

          {recentCommands.map((command) => (
            <div
              key={command.id}
              className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-overlay)] px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <span
                  className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-medium ${getStatusTone(command.status)}`}
                >
                  {formatCommandStatusLabel(command.status)}
                </span>
                <span className="truncate font-mono text-[11px] text-[var(--text-primary)]">
                  {command.command}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-[var(--text-muted)]">
                <span>开始 {formatTimestamp(command.startedAt)}</span>
                <span>结束 {formatTimestamp(command.finishedAt)}</span>
                <span>退出码 {command.exitCode ?? '待定'}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
