import type { ContextMenuEntry } from '../../utils/contextMenu';

export interface TerminalContextMenuOptions {
  hasSelection: boolean;
  canSplit: boolean;
  canClosePane: boolean;
  canRenameTab: boolean;
  canNotifyOnCompletion: boolean;
  notifyOnCompletion: boolean;
  isWindowMaximized: boolean;
  onCopy: () => void;
  onPaste: () => void;
  onToggleNotifyOnCompletion: () => void;
  onClearScreen: () => void;
  onRunCommand: () => void;
  onRestartTerminal: () => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
  onClosePane: () => void;
  onNewTab: () => void;
  onRenameTab: () => void;
  onCloseTab: () => void;
  onWindowMinimize: () => void;
  onWindowToggleMaximize: () => void;
  onWindowClose: () => void;
  onOpenSettings: () => void;
}

export function buildTerminalContextMenu(
  options: TerminalContextMenuOptions,
): ContextMenuEntry[] {
  return [
    {
      label: '复制',
      shortcut: 'Ctrl+Insert',
      disabled: !options.hasSelection,
      onClick: options.onCopy,
    },
    {
      label: '粘贴',
      shortcut: 'Ctrl+Shift+V',
      onClick: options.onPaste,
    },
    {
      label: '当前任务完成后提醒我',
      checked: options.notifyOnCompletion,
      disabled: !options.canNotifyOnCompletion && !options.notifyOnCompletion,
      onClick: options.onToggleNotifyOnCompletion,
    },
    { separator: true },
    {
      label: '清空屏幕',
      onClick: options.onClearScreen,
    },
    {
      label: '运行命令',
      onClick: options.onRunCommand,
    },
    {
      label: '重置终端',
      onClick: options.onRestartTerminal,
    },
    { separator: true },
    {
      label: '分屏',
      children: [
        {
          label: '向右分屏',
          disabled: !options.canSplit,
          onClick: options.onSplitRight,
        },
        {
          label: '向下分屏',
          disabled: !options.canSplit,
          onClick: options.onSplitDown,
        },
        {
          label: '关闭当前分屏',
          disabled: !options.canClosePane,
          danger: true,
          onClick: options.onClosePane,
        },
      ],
    },
    {
      label: '标签页',
      children: [
        {
          label: '新建标签页',
          onClick: options.onNewTab,
        },
        {
          label: '重命名标签页',
          disabled: !options.canRenameTab,
          onClick: options.onRenameTab,
        },
        {
          label: '关闭当前标签页',
          danger: true,
          onClick: options.onCloseTab,
        },
      ],
    },
    {
      label: '窗口',
      children: [
        {
          label: '最小化',
          onClick: options.onWindowMinimize,
        },
        {
          label: options.isWindowMaximized ? '还原窗口' : '最大化窗口',
          onClick: options.onWindowToggleMaximize,
        },
        {
          label: '关闭窗口',
          danger: true,
          onClick: options.onWindowClose,
        },
      ],
    },
    { separator: true },
    {
      label: '设置',
      children: [
        {
          label: '打开设置',
          onClick: options.onOpenSettings,
        },
      ],
    },
  ];
}
