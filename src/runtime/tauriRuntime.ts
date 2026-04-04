import { getDefaultThemeConfig } from '../theme';
import type { AppConfig } from '../types';

declare global {
  interface Window {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  }
}

export function isTauriRuntime() {
  if (typeof window === 'undefined') {
    return false;
  }

  return '__TAURI_INTERNALS__' in window || '__TAURI__' in window;
}

export function createFallbackAppConfig(): AppConfig {
  return {
    workspaces: [],
    recentWorkspaces: [],
    projects: [],
    defaultShell: 'powershell',
    availableShells: [
      {
        name: 'powershell',
        command: 'powershell',
        args: ['-NoLogo'],
      },
      {
        name: 'cmd',
        command: 'cmd',
      },
    ],
    uiFontSize: 13,
    terminalFontSize: 14,
    layoutSizes: [200, 280, 1000],
    middleColumnSizes: [300, 200],
    workspaceSidebarSizes: [68, 32],
    theme: getDefaultThemeConfig(),
    completionUsage: {
      commands: {},
      subcommands: {},
      options: {},
      arguments: {},
      scopes: {},
    },
  };
}
