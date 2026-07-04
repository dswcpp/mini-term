import { useEffect, useRef, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store';
import { getCachedTerminal, getTerminalTheme, DARK_TERMINAL_THEME, writePtyInput, copyTerminalSelection, pasteToTerminal, resolveTerminalFontFamily, reloadLigaturesForPty } from '../utils/terminalCache';
import { getResolvedTheme } from '../utils/themeManager';
import { showContextMenu, type MenuEntry } from '../utils/contextMenu';
import { isFileDragging, getFileDragPath } from '../utils/fileDragState';
import { buildSshCommand } from '../utils/sshCommand';
import { useTerminalMount } from '../hooks/useTerminalMount';
import { useT, t } from '../i18n';
import type { SshConnection } from '../types';
import '@xterm/xterm/css/xterm.css';

interface Props {
  ptyId: number;
  contextMenuExtraItems?: MenuEntry[];
}

function logTerminalInstanceError(context: string, error: unknown): void {
  // eslint-disable-next-line no-console
  console.warn(`[terminal] ${context}`, error);
}

function focusTerminalSafely(ptyId: number): void {
  try {
    getCachedTerminal(ptyId)?.term.focus();
  } catch (error) {
    logTerminalInstanceError('focus failed', error);
  }
}

function runTerminalAction(context: string, action: () => Promise<unknown>): void {
  void action().catch((error) => logTerminalInstanceError(context, error));
}

/** 在指定终端中连接 SSH:有密码先注册自动填充,再写入 ssh 命令并回车 */
async function connectSsh(ptyId: number, conn: SshConnection): Promise<void> {
  if (conn.password) {
    try {
      await invoke('arm_ssh_autofill', { ptyId, password: conn.password });
    } catch (error) {
      logTerminalInstanceError('ssh autofill arm failed', error);
      // 注册自动填充失败不阻断连接,用户可在终端手动输入密码
    }
  }
  // 配了私钥时先复制到权限收紧的临时副本,绕过 OpenSSH 的
  // "UNPROTECTED PRIVATE KEY FILE" 拒绝;准备失败回退原始路径让 ssh 自行报错
  let identityPath = conn.identityFile?.trim() || undefined;
  if (identityPath) {
    try {
      identityPath = await invoke<string>('prepare_ssh_key', { identityFile: identityPath });
    } catch (e) {
      logTerminalInstanceError('prepare ssh key failed, falling back to original path', e);
    }
  }
  let command: string;
  try {
    command = buildSshCommand(conn, identityPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await writePtyInput(ptyId, `# mini-term: invalid SSH connection target (${msg})\r`);
    focusTerminalSafely(ptyId);
    return;
  }
  await writePtyInput(ptyId, `${command}\r`);
  focusTerminalSafely(ptyId);
}

/** 构建终端右键菜单的「SSH 连接」子菜单(按 group 分组) */
function buildSshSubmenu(connections: SshConnection[], ptyId: number): MenuEntry[] {
  const groups: { group?: string; items: SshConnection[] }[] = [];
  for (const conn of connections) {
    const g = conn.group?.trim() || undefined;
    let bucket = groups.find((x) => x.group === g);
    if (!bucket) {
      bucket = { group: g, items: [] };
      groups.push(bucket);
    }
    bucket.items.push(conn);
  }
  const hasNamedGroup = groups.some((g) => g.group);
  const entries: MenuEntry[] = [];
  for (const bucket of groups) {
    if (bucket.group || hasNamedGroup) {
      entries.push({ header: bucket.group ?? t('terminal.ungrouped') });
    }
    for (const conn of bucket.items) {
      entries.push({
        label: conn.name,
        onClick: () => runTerminalAction('ssh connect failed', () => connectSsh(ptyId, conn)),
      });
    }
  }
  return entries;
}

export function TerminalInstance({ ptyId, contextMenuExtraItems = [] }: Props) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const [fileDrag, setFileDrag] = useState(false);
  const terminalFontSize = useAppStore((s) => s.config.terminalFontSize);
  const terminalFontFamily = useAppStore((s) => s.config.terminalFontFamily);
  const terminalLigatures = useAppStore((s) => s.config.terminalLigatures);
  const terminalDepthUi = useAppStore((s) => s.config.terminalDepthUi ?? true);
  const terminalFollowTheme = useAppStore((s) => s.config.terminalFollowTheme);
  const sshConnections = useAppStore((s) => s.config.sshConnections);

  // 终端不跟随主题且处于浅色模式时，覆写 CSS 变量让整个终端区域（含 .xterm）统一深色
  const forceDarkBg = !terminalFollowTheme && getResolvedTheme() === 'light';
  const termStyle = forceDarkBg
    ? { '--bg-terminal': DARK_TERMINAL_THEME.background } as React.CSSProperties
    : undefined;

  useTerminalMount(ptyId, containerRef);

  useEffect(() => {
    const cached = getCachedTerminal(ptyId);
    if (cached && terminalFontSize) {
      try {
        cached.term.options.fontSize = terminalFontSize;
        cached.fitAddon.fit();
      } catch (error) {
        logTerminalInstanceError('font size update failed', error);
      }
    }
  }, [terminalFontSize, ptyId]);

  useEffect(() => {
    const cached = getCachedTerminal(ptyId);
    if (!cached) return;
    try {
      cached.term.options.fontFamily = resolveTerminalFontFamily(terminalFontFamily);
      cached.fitAddon.fit();
    } catch (error) {
      logTerminalInstanceError('font family update failed', error);
    }
  }, [terminalFontFamily, ptyId]);

  // ligatures 开关切换 / 字体切换 → 重做 ligatures + WebGL atlas
  // (上游 #5455:font-feature-settings 变更不会自动进 WebGL 纹理 atlas,需 dispose+reload)
  useEffect(() => {
    reloadLigaturesForPty(ptyId);
  }, [terminalLigatures, terminalFontFamily, ptyId]);

  useEffect(() => {
    const handler = () => {
      const cached = getCachedTerminal(ptyId);
      if (cached) {
        const { config } = useAppStore.getState();
        try {
          cached.term.options.theme = getTerminalTheme(config.terminalFollowTheme ?? true);
        } catch (error) {
          logTerminalInstanceError('theme update failed', error);
        }
      }
    };
    window.addEventListener('theme-changed', handler);
    return () => window.removeEventListener('theme-changed', handler);
  }, [ptyId]);

  // 外部拖拽（资源管理器 → 终端）：监听 useExternalFileDrop 派发的自定义事件
  useEffect(() => {
    const handler = (e: Event) => {
      setFileDrag((e as CustomEvent<number | null>).detail === ptyId);
    };
    window.addEventListener('external-file-drag', handler);
    return () => window.removeEventListener('external-file-drag', handler);
  }, [ptyId]);

  // 内部拖拽（FileTree → 终端）：自定义鼠标事件，规避 WebView2 dragDropEnabled 拦截
  const dropZoneRef = useRef<HTMLDivElement>(null);

  const handleMouseMove = useCallback(() => {
    if (isFileDragging() && !fileDrag) setFileDrag(true);
  }, [fileDrag]);

  const handleMouseLeave = useCallback(() => {
    if (fileDrag) setFileDrag(false);
  }, [fileDrag]);

  const handleMouseUp = useCallback(() => {
    const path = getFileDragPath();
    if (path) {
      setFileDrag(false);
      runTerminalAction('drop path insert failed', async () => {
        await writePtyInput(ptyId, `'${path}'`);
        focusTerminalSafely(ptyId);
      });
    }
  }, [ptyId]);

  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const hasSelection = !!getCachedTerminal(ptyId)?.term.getSelection();
    const menu: MenuEntry[] = [
      {
        label: t('terminal.copy'),
        disabled: !hasSelection,
        onClick: () => runTerminalAction('copy failed', () => copyTerminalSelection(ptyId)),
      },
      {
        label: t('terminal.paste'),
        onClick: () => {
          runTerminalAction('paste failed', () => pasteToTerminal(ptyId));
          focusTerminalSafely(ptyId);
        },
      },
      { separator: true },
      sshConnections.length > 0
        ? { label: t('terminal.sshConnect'), submenu: buildSshSubmenu(sshConnections, ptyId) }
        : { label: t('terminal.sshConnectEmpty'), disabled: true },
    ];
    if (contextMenuExtraItems.length > 0) {
      menu.push({ separator: true }, ...contextMenuExtraItems);
    }
    showContextMenu(e.clientX, e.clientY, menu);
  };

  return (
    <div className="w-full h-full flex flex-col">
      <div
        ref={dropZoneRef}
        className={`${terminalDepthUi ? 'terminal-depth-shell' : ''} flex-1 relative bg-[var(--bg-terminal)]`}
        style={termStyle}
        data-terminal-drop
        data-terminal-depth={terminalDepthUi ? 'enabled' : 'disabled'}
        data-terminal-tone={forceDarkBg ? 'dark' : undefined}
        data-pty-id={ptyId}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onMouseUp={handleMouseUp}
        onContextMenu={handleContextMenu}
      >
        <div ref={containerRef} className={`${terminalDepthUi ? 'terminal-depth-content' : ''} absolute top-1.5 bottom-0 left-2.5 right-0 cursor-none`} />

        {fileDrag && (
          <div
            className="absolute inset-1 z-10 flex items-center justify-center pointer-events-none rounded-[var(--radius-md)]"
            style={{ background: 'var(--accent-subtle)', border: '2px dashed var(--accent)' }}
          >
            <span className="text-[var(--accent)] text-xs px-3 py-1.5 rounded-[var(--radius-md)]"
              style={{ background: 'var(--bg-overlay)' }}>
              {t('terminal.dropToInsertPath')}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
