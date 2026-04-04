import { memo } from 'react';
import type { PaneStatus } from '../types';
import { TerminalController } from './terminal/TerminalController';

interface Props {
  tabId: string;
  projectPath: string;
  ptyId: number;
  paneId?: string;
  shellName?: string;
  runCommand?: string;
  status?: PaneStatus;
  isActive: boolean;
  isVisible: boolean;
  onActivatePane?: (paneId: string) => void;
  onSplit?: (paneId: string, direction: 'horizontal' | 'vertical') => void;
  onClose?: (paneId: string) => void;
  onRestart?: (paneId: string) => void;
  onNewTab?: () => void;
  onRenameTab?: () => void;
  onCloseTab?: () => void;
  onOpenSettings?: () => void;
  onTabDrop?: (
    sourceTabId: string,
    targetPaneId: string,
    direction: 'horizontal' | 'vertical',
    position: 'before' | 'after',
  ) => void;
}

export const TerminalInstance = memo(function TerminalInstance(props: Props) {
  return <TerminalController {...props} />;
});
