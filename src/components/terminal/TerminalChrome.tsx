import type {
  CSSProperties,
  DragEvent,
  MouseEvent,
  ReactNode,
} from 'react';
import type { PaneStatus, TerminalSessionMeta } from '../../types';
import type { TerminalCompletionItem } from '../../hooks/useTerminalCompletions';
import { StatusDot } from '../StatusDot';
import { SessionCommandTimeline } from './SessionCommandTimeline';
import { SessionMetaStrip } from './SessionMetaStrip';

export type TerminalDropZone = 'top' | 'bottom' | 'left' | 'right';
export type TerminalDragKind = 'file' | 'tab';

const noDragStyle = { WebkitAppRegion: 'no-drag' } as unknown as CSSProperties;

const dropZoneOverlay: Record<TerminalDropZone, CSSProperties> = {
  top: { top: 0, left: 0, right: 0, height: '50%' },
  bottom: { bottom: 0, left: 0, right: 0, height: '50%' },
  left: { top: 0, left: 0, bottom: 0, width: '50%' },
  right: { top: 0, right: 0, bottom: 0, width: '50%' },
};

function PaneActionButton({
  title,
  children,
  onClick,
  onContextMenu,
}: {
  title: string;
  children: ReactNode;
  onClick: () => void;
  onContextMenu?: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      title={title}
      className="inline-flex h-[18px] w-[18px] items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-muted)] transition-colors hover:bg-[var(--border-subtle)] hover:text-[var(--text-primary)]"
      style={noDragStyle}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      {children}
    </button>
  );
}

export interface TerminalChromeProps {
  tabId: string;
  paneId?: string;
  shellName?: string;
  status?: PaneStatus;
  session?: TerminalSessionMeta;
  dragKind: TerminalDragKind | null;
  tabDropZone: TerminalDropZone | null;
  completionItems: TerminalCompletionItem[];
  completionIndex: number;
  menuOpen: boolean;
  ghostText: string;
  children: ReactNode;
  onContextMenu: (event: MouseEvent<HTMLDivElement>) => void;
  onActivatePane: () => void;
  onRunCommand: () => void;
  onRunCommandContextMenu: (event: MouseEvent<HTMLButtonElement>) => void;
  onSplitRight?: () => void;
  onSplitDown?: () => void;
  onRestart?: () => void;
  onClosePane?: () => void;
  onAcceptCompletion: (item: TerminalCompletionItem) => Promise<boolean>;
  onSetCompletionIndex: (index: number) => void;
  onDragEnterCapture: (event: DragEvent<HTMLDivElement>) => void;
  onDragOverCapture: (event: DragEvent<HTMLDivElement>) => void;
  onDragLeaveCapture: (event: DragEvent<HTMLDivElement>) => void;
  onDropCapture: (event: DragEvent<HTMLDivElement>) => void;
}

export function TerminalChrome({
  tabId,
  paneId,
  shellName,
  status,
  session,
  dragKind,
  tabDropZone,
  completionItems,
  completionIndex,
  menuOpen,
  ghostText,
  children,
  onContextMenu,
  onActivatePane,
  onRunCommand,
  onRunCommandContextMenu,
  onSplitRight,
  onSplitDown,
  onRestart,
  onClosePane,
  onAcceptCompletion,
  onSetCompletionIndex,
  onDragEnterCapture,
  onDragOverCapture,
  onDragLeaveCapture,
  onDropCapture,
}: TerminalChromeProps) {
  return (
    <div
      className="flex h-full w-full flex-col"
      data-tab-id={tabId}
      onContextMenu={onContextMenu}
      onMouseDownCapture={onActivatePane}
    >
      <div
        className="flex shrink-0 items-center gap-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-2 py-[3px] text-[10px] select-none"
        style={noDragStyle}
      >
        {status && <StatusDot status={status} />}
        <SessionMetaStrip shellName={shellName} session={session} />

        <PaneActionButton title="运行命令（右键管理）" onClick={onRunCommand} onContextMenu={onRunCommandContextMenu}>
          <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden="true">
            <path d="M3 2.5v7l6-3.5-6-3.5Z" fill="currentColor" />
          </svg>
        </PaneActionButton>

        {paneId && onSplitRight && onSplitDown && (
          <>
            <PaneActionButton title="向右分屏" onClick={onSplitRight}>
              <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden="true">
                <path d="M2 2.5h8v7H2z" fill="none" stroke="currentColor" strokeWidth="1" />
                <path d="M6 2.5v7" fill="none" stroke="currentColor" strokeWidth="1" />
              </svg>
            </PaneActionButton>
            <PaneActionButton title="向下分屏" onClick={onSplitDown}>
              <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden="true">
                <path d="M2 2.5h8v7H2z" fill="none" stroke="currentColor" strokeWidth="1" />
                <path d="M2 6h8" fill="none" stroke="currentColor" strokeWidth="1" />
              </svg>
            </PaneActionButton>
          </>
        )}

        {paneId && onRestart && (
          <PaneActionButton title="重启终端" onClick={onRestart}>
            <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden="true">
              <path d="M3 4V2.5H1.5" fill="none" stroke="currentColor" strokeWidth="1" />
              <path
                d="M3 2.5A4 4 0 1 1 2.3 7.8"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="1"
              />
            </svg>
          </PaneActionButton>
        )}

        {paneId && onClosePane && (
          <PaneActionButton title="关闭分屏" onClick={onClosePane}>
            <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden="true">
              <path d="M3 3l6 6" fill="none" stroke="currentColor" strokeWidth="1" />
              <path d="M9 3 3 9" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          </PaneActionButton>
        )}
      </div>

      <SessionCommandTimeline session={session} />

      {completionItems.length > 0 && (
        <div className="border-b border-[var(--border-subtle)] bg-[var(--bg-base)]/75 px-2 py-1 text-[10px] backdrop-blur-sm">
          <div className="flex items-center gap-2 text-[var(--text-muted)]">
            <span className="rounded bg-[var(--accent-subtle)] px-1.5 py-0.5 text-[var(--accent)]">
              Tab
            </span>
            <span className="truncate">
              提示补全
              {ghostText ? `：${completionItems[completionIndex]?.label}` : ''}
            </span>
            {menuOpen && (
              <span className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[var(--text-secondary)]">
                菜单已激活
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {completionItems.map((item, index) => (
              <button
                key={item.id}
                type="button"
                className={`rounded border px-2 py-0.5 text-left transition-colors ${
                  index === completionIndex
                    ? 'border-[var(--accent)] bg-[var(--accent-subtle)] text-[var(--text-primary)]'
                    : 'border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:border-[var(--border-default)]'
                }`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void onAcceptCompletion(item)}
                onMouseEnter={() => onSetCompletionIndex(index)}
              >
                <span className="font-medium">{item.label}</span>
                <span className="ml-1 text-[var(--text-muted)]">{item.detail}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div
        className="relative flex-1 bg-[var(--bg-terminal)]"
        onDragEnterCapture={onDragEnterCapture}
        onDragOverCapture={onDragOverCapture}
        onDragLeaveCapture={onDragLeaveCapture}
        onDropCapture={onDropCapture}
      >
        {children}

        {dragKind === 'file' && (
          <div
            className="pointer-events-none absolute inset-1 z-10 flex items-center justify-center rounded-[var(--radius-md)]"
            style={{ background: 'rgba(200, 128, 90, 0.06)', border: '2px dashed var(--accent)' }}
          >
            <span
              className="rounded-[var(--radius-md)] px-3 py-1.5 text-xs text-[var(--accent)]"
              style={{ background: 'var(--bg-overlay)' }}
            >
              释放以插入路径
            </span>
          </div>
        )}

        {tabDropZone && (
          <div
            className="pointer-events-none absolute z-10"
            style={{
              ...dropZoneOverlay[tabDropZone],
              background: 'rgba(200, 128, 90, 0.12)',
              borderRadius: '4px',
            }}
          />
        )}
      </div>
    </div>
  );
}
