import type { ThemeConfig, ThemePresetId, ThemeWindowEffect } from './types';

export interface TerminalThemeDefinition {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface ThemePresetDefinition {
  id: ThemePresetId;
  name: string;
  description: string;
  preview: string[];
  ui: Record<string, string>;
  terminal: TerminalThemeDefinition;
  windowEffect: Exclude<ThemeWindowEffect, 'auto' | 'none'>;
}

export interface ResolvedTheme {
  preset: ThemePresetDefinition;
  windowEffect: ThemeWindowEffect;
}

const warmCarbon: ThemePresetDefinition = {
  id: 'warm-carbon',
  name: 'Warm Carbon',
  description: 'Warm charcoal surfaces with copper accents and a soft terminal glow.',
  preview: ['#0e0d0b', '#1e1c19', '#c8805a', '#d8d4cc'],
  ui: {
    '--bg-base': 'rgba(14, 13, 11, 0.68)',
    '--bg-surface': 'rgba(22, 21, 19, 0.80)',
    '--bg-elevated': 'rgba(30, 28, 25, 0.72)',
    '--bg-overlay': 'rgba(38, 36, 33, 0.84)',
    '--bg-terminal': 'rgba(16, 15, 13, 0.86)',
    '--accent': '#c8805a',
    '--accent-muted': '#c8805a33',
    '--accent-subtle': '#c8805a18',
    '--text-primary': '#e5e0d8',
    '--text-secondary': '#9a9488',
    '--text-muted': '#5c5850',
    '--border-subtle': 'rgba(255, 255, 255, 0.05)',
    '--border-default': 'rgba(255, 255, 255, 0.08)',
    '--border-strong': 'rgba(255, 255, 255, 0.12)',
    '--color-file': '#7dcfb8',
    '--color-folder': '#d4c8a0',
    '--color-success': '#6bb87a',
    '--color-warning': '#d4a84a',
    '--color-error': '#d4605a',
    '--color-ai': '#b08cd4',
    '--color-ai-glow': '#b08cd480',
    '--app-shell-background':
      'radial-gradient(circle at top, rgba(255, 255, 255, 0.06), transparent 40%), linear-gradient(180deg, rgba(255, 255, 255, 0.035), rgba(0, 0, 0, 0.08)), rgba(12, 11, 10, 0.44)',
    '--app-shell-border-focused': 'rgba(255, 255, 255, 0.08)',
    '--app-shell-border-unfocused': 'rgba(255, 255, 255, 0.05)',
    '--app-shell-shadow-focused':
      'inset 0 1px 0 rgba(255, 255, 255, 0.03), 0 18px 50px rgba(0, 0, 0, 0.38)',
    '--app-shell-shadow-unfocused':
      'inset 0 1px 0 rgba(255, 255, 255, 0.02), 0 12px 34px rgba(0, 0, 0, 0.22)',
    '--app-titlebar-background':
      'linear-gradient(180deg, rgba(255, 255, 255, 0.055), rgba(255, 255, 255, 0.015) 34%, rgba(0, 0, 0, 0.06)), rgba(24, 22, 19, 0.34)',
    '--app-titlebar-unfocused-opacity': '0.82',
    '--titlebar-divider-opacity': '0.65',
    '--titlebar-control-hover': 'rgba(255, 255, 255, 0.085)',
    '--titlebar-control-active': 'rgba(255, 255, 255, 0.14)',
    '--titlebar-control-unfocused-hover': 'rgba(255, 255, 255, 0.045)',
    '--titlebar-control-danger-hover': '#c42b1c',
    '--titlebar-control-danger-active': '#a62518',
    '--titlebar-control-unfocused-color': '#5c5850',
    '--noise-opacity': '0.025',
  },
  terminal: {
    background: 'rgba(16, 15, 13, 0.82)',
    foreground: '#d8d4cc',
    cursor: '#c8805a',
    cursorAccent: 'rgba(16, 15, 13, 0.82)',
    selectionBackground: '#c8805a30',
    selectionForeground: '#e5e0d8',
    black: '#2a2824',
    red: '#d4605a',
    green: '#6bb87a',
    yellow: '#d4a84a',
    blue: '#6896c8',
    magenta: '#b08cd4',
    cyan: '#7dcfb8',
    white: '#d8d4cc',
    brightBlack: '#5c5850',
    brightRed: '#e07060',
    brightGreen: '#80d090',
    brightYellow: '#e0b860',
    brightBlue: '#80aad8',
    brightMagenta: '#c0a0e0',
    brightCyan: '#90e0c8',
    brightWhite: '#e5e0d8',
  },
  windowEffect: 'mica',
};

const ghosttyDark: ThemePresetDefinition = {
  id: 'ghostty-dark',
  name: 'Ghostty Dark',
  description: 'A restrained Ghostty-inspired dark palette with crisp chrome and cooler contrast.',
  preview: ['#111111', '#1a1a1a', '#87b4ff', '#f1f1f1'],
  ui: {
    '--bg-base': 'rgba(10, 10, 11, 0.62)',
    '--bg-surface': 'rgba(18, 18, 19, 0.76)',
    '--bg-elevated': 'rgba(26, 26, 28, 0.70)',
    '--bg-overlay': 'rgba(30, 30, 33, 0.82)',
    '--bg-terminal': 'rgba(9, 9, 10, 0.88)',
    '--accent': '#87b4ff',
    '--accent-muted': '#87b4ff33',
    '--accent-subtle': '#87b4ff14',
    '--text-primary': '#f2f3f5',
    '--text-secondary': '#b5b8be',
    '--text-muted': '#747982',
    '--border-subtle': 'rgba(255, 255, 255, 0.04)',
    '--border-default': 'rgba(255, 255, 255, 0.07)',
    '--border-strong': 'rgba(255, 255, 255, 0.11)',
    '--color-file': '#8fd7ff',
    '--color-folder': '#d3d7dd',
    '--color-success': '#6cc58a',
    '--color-warning': '#dfb66a',
    '--color-error': '#e06a6a',
    '--color-ai': '#9a8bff',
    '--color-ai-glow': '#9a8bff70',
    '--app-shell-background':
      'radial-gradient(circle at top, rgba(255, 255, 255, 0.04), transparent 38%), linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(0, 0, 0, 0.10)), rgba(9, 9, 10, 0.34)',
    '--app-shell-border-focused': 'rgba(255, 255, 255, 0.09)',
    '--app-shell-border-unfocused': 'rgba(255, 255, 255, 0.045)',
    '--app-shell-shadow-focused':
      'inset 0 1px 0 rgba(255, 255, 255, 0.028), 0 18px 60px rgba(0, 0, 0, 0.42)',
    '--app-shell-shadow-unfocused':
      'inset 0 1px 0 rgba(255, 255, 255, 0.018), 0 10px 30px rgba(0, 0, 0, 0.22)',
    '--app-titlebar-background':
      'linear-gradient(180deg, rgba(255, 255, 255, 0.048), rgba(255, 255, 255, 0.012) 36%, rgba(0, 0, 0, 0.055)), rgba(18, 18, 20, 0.28)',
    '--app-titlebar-unfocused-opacity': '0.78',
    '--titlebar-divider-opacity': '0.52',
    '--titlebar-control-hover': 'rgba(255, 255, 255, 0.075)',
    '--titlebar-control-active': 'rgba(255, 255, 255, 0.13)',
    '--titlebar-control-unfocused-hover': 'rgba(255, 255, 255, 0.04)',
    '--titlebar-control-danger-hover': '#c42b1c',
    '--titlebar-control-danger-active': '#a62518',
    '--titlebar-control-unfocused-color': '#656a73',
    '--noise-opacity': '0.018',
  },
  terminal: {
    background: 'rgba(9, 9, 10, 0.84)',
    foreground: '#eceef2',
    cursor: '#c7d7ff',
    cursorAccent: 'rgba(9, 9, 10, 0.84)',
    selectionBackground: '#87b4ff2e',
    selectionForeground: '#ffffff',
    black: '#151518',
    red: '#e06a6a',
    green: '#78cb9d',
    yellow: '#dfb66a',
    blue: '#87b4ff',
    magenta: '#9a8bff',
    cyan: '#7fd2e6',
    white: '#d9dce2',
    brightBlack: '#6c727d',
    brightRed: '#f18a8a',
    brightGreen: '#9adcb4',
    brightYellow: '#f2cf90',
    brightBlue: '#aac8ff',
    brightMagenta: '#b4a8ff',
    brightCyan: '#9fe3ef',
    brightWhite: '#f5f6f8',
  },
  windowEffect: 'mica',
};

const ghosttyLight: ThemePresetDefinition = {
  id: 'ghostty-light',
  name: 'Ghostty Light',
  description: 'A soft porcelain light theme with cool shadows and a low-contrast terminal surface.',
  preview: ['#f3f4f6', '#ffffff', '#4a78c2', '#111318'],
  ui: {
    '--bg-base': 'rgba(246, 247, 249, 0.76)',
    '--bg-surface': 'rgba(255, 255, 255, 0.84)',
    '--bg-elevated': 'rgba(249, 250, 252, 0.78)',
    '--bg-overlay': 'rgba(245, 246, 249, 0.92)',
    '--bg-terminal': 'rgba(252, 252, 253, 0.88)',
    '--accent': '#4a78c2',
    '--accent-muted': '#4a78c233',
    '--accent-subtle': '#4a78c214',
    '--text-primary': '#14181f',
    '--text-secondary': '#54606f',
    '--text-muted': '#7b8491',
    '--border-subtle': 'rgba(18, 24, 33, 0.06)',
    '--border-default': 'rgba(18, 24, 33, 0.10)',
    '--border-strong': 'rgba(18, 24, 33, 0.15)',
    '--color-file': '#1b7fa7',
    '--color-folder': '#7a5e1e',
    '--color-success': '#2f9662',
    '--color-warning': '#9f6d08',
    '--color-error': '#c54d50',
    '--color-ai': '#6b60d8',
    '--color-ai-glow': '#6b60d85a',
    '--app-shell-background':
      'radial-gradient(circle at top, rgba(255, 255, 255, 0.38), transparent 42%), linear-gradient(180deg, rgba(255, 255, 255, 0.72), rgba(238, 241, 245, 0.55)), rgba(249, 250, 252, 0.60)',
    '--app-shell-border-focused': 'rgba(18, 24, 33, 0.10)',
    '--app-shell-border-unfocused': 'rgba(18, 24, 33, 0.07)',
    '--app-shell-shadow-focused':
      'inset 0 1px 0 rgba(255, 255, 255, 0.42), 0 18px 48px rgba(49, 68, 92, 0.18)',
    '--app-shell-shadow-unfocused':
      'inset 0 1px 0 rgba(255, 255, 255, 0.38), 0 12px 28px rgba(49, 68, 92, 0.12)',
    '--app-titlebar-background':
      'linear-gradient(180deg, rgba(255, 255, 255, 0.72), rgba(255, 255, 255, 0.28) 38%, rgba(233, 237, 242, 0.4)), rgba(255, 255, 255, 0.35)',
    '--app-titlebar-unfocused-opacity': '0.88',
    '--titlebar-divider-opacity': '0.38',
    '--titlebar-control-hover': 'rgba(18, 24, 33, 0.07)',
    '--titlebar-control-active': 'rgba(18, 24, 33, 0.12)',
    '--titlebar-control-unfocused-hover': 'rgba(18, 24, 33, 0.05)',
    '--titlebar-control-danger-hover': '#d04437',
    '--titlebar-control-danger-active': '#b03427',
    '--titlebar-control-unfocused-color': '#7b8491',
    '--noise-opacity': '0.012',
  },
  terminal: {
    background: 'rgba(252, 252, 253, 0.92)',
    foreground: '#1a2029',
    cursor: '#3f67aa',
    cursorAccent: 'rgba(252, 252, 253, 0.92)',
    selectionBackground: '#4a78c226',
    selectionForeground: '#0d1117',
    black: '#20252c',
    red: '#c54d50',
    green: '#2f9662',
    yellow: '#9f6d08',
    blue: '#4a78c2',
    magenta: '#6b60d8',
    cyan: '#1b7fa7',
    white: '#c7cdd6',
    brightBlack: '#6d7784',
    brightRed: '#db6668',
    brightGreen: '#48af78',
    brightYellow: '#bb8818',
    brightBlue: '#638fd8',
    brightMagenta: '#8278eb',
    brightCyan: '#2a97bf',
    brightWhite: '#111318',
  },
  windowEffect: 'blur',
};

export const THEME_PRESETS: Record<ThemePresetId, ThemePresetDefinition> = {
  'warm-carbon': warmCarbon,
  'ghostty-dark': ghosttyDark,
  'ghostty-light': ghosttyLight,
};

export const THEME_PRESET_LIST = Object.values(THEME_PRESETS);

export const WINDOW_EFFECT_OPTIONS: {
  value: ThemeWindowEffect;
  label: string;
  description: string;
}[] = [
  {
    value: 'auto',
    label: 'Auto',
    description: 'Pick the best native material for the active theme automatically.',
  },
  {
    value: 'mica',
    label: 'Mica',
    description: 'Windows 11 style mica material with subtle desktop tinting.',
  },
  {
    value: 'acrylic',
    label: 'Acrylic',
    description: 'Stronger translucency and diffusion, closer to frosted glass.',
  },
  {
    value: 'blur',
    label: 'Blur',
    description: 'A more compatible fallback blur for older Windows builds.',
  },
  {
    value: 'none',
    label: 'None',
    description: 'Disable native window materials and keep the CSS-rendered theme only.',
  },
];

export function getDefaultThemeConfig(): ThemeConfig {
  return {
    preset: 'warm-carbon',
    windowEffect: 'auto',
  };
}

export function resolveTheme(config?: ThemeConfig): ResolvedTheme {
  const themeConfig = config ?? getDefaultThemeConfig();
  const preset = THEME_PRESETS[themeConfig.preset] ?? THEME_PRESETS['warm-carbon'];

  return {
    preset,
    windowEffect: themeConfig.windowEffect ?? 'auto',
  };
}

export function applyDocumentTheme(theme: ResolvedTheme) {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme.preset.ui)) {
    root.style.setProperty(key, value);
  }
  root.dataset.themePreset = theme.preset.id;
}
