# Blueprint 日间模式设计规格

> **Goal:** 让 Blueprint 皮肤支持日间/夜间双模式，用户选中蓝图皮肤后可自由切换深色/浅色/跟随系统主题。

## 1. 架构变更

### 1.1 去���强制 dark 逻辑

**文件:** `src/App.tsx`

当前 skin useEffect 中 `if (skin === 'blueprint') { applyTheme('dark'); }` 需删除。Blueprint 不再锁定深色主题。

### 1.2 恢复主题选择器

**文件:** `src/components/SettingsModal.tsx`

- 删除 Blueprint 时主题按钮的 `disabled` 状态和灰色样式
- 删除 "蓝图皮肤仅支持深色主题" 提示文字
- 主题按钮恢复为始终可用

### 1.3 CSS 变量层 — 日间���盖

**文件:** `src/styles.css`

在现有 `[data-skin="blueprint"]` 变量块之后，新增：

```css
:root[data-skin="blueprint"][data-theme="light"] {
  --bg-base: #f0f4f8;
  --bg-surface: #e8eef4;
  --bg-elevated: #dce4ed;
  --bg-overlay: #d0dae6;
  --bg-terminal: #f5f8fb;

  --accent: #0e7490;
  --accent-muted: rgba(14, 116, 144, 0.15);
  --accent-subtle: rgba(14, 116, 144, 0.06);

  --text-primary: #0f172a;
  --text-secondary: #334155;
  --text-muted: rgba(14, 116, 144, 0.5);

  --border-subtle: rgba(14, 116, 144, 0.08);
  --border-default: rgba(14, 116, 144, 0.15);
  --border-strong: rgba(14, 116, 144, 0.22);

  --color-file: #0369a1;
  --color-folder: #0284c7;
  --color-success: #15803d;
  --color-warning: #c2410c;
  --color-error: #dc2626;
  --color-ai: #7c3aed;
  --color-ai-working: #0e7490;
  --color-info: #1d4ed8;

  --diff-add-bg: rgba(21, 128, 61, 0.1);
  --diff-del-bg: rgba(220, 38, 38, 0.1);
  --diff-add-text: #15803d;
  --diff-del-text: #dc2626;

  --color-error-muted: rgba(220, 38, 38, 0.1);
  --shadow-overlay: 0 8px 32px rgba(0, 0, 0, 0.12), 0 0 1px rgba(14, 116, 144, 0.15);

  --radius-sm: 2px;
  --radius-md: 3px;
}
```

### 1.4 blueprint.css 日间规则

**文件:** `src/blueprint.css`

blueprint.css 中角标记、网格、滚动条等使用了硬编码颜色（针对深色模式），需为日间模式添加覆盖规则：

```css
/* --- Light mode grid --- */
[data-skin="blueprint"][data-theme="light"] #root::after {
  background-image:
    linear-gradient(rgba(14, 116, 144, 0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(14, 116, 144, 0.04) 1px, transparent 1px),
    linear-gradient(rgba(14, 116, 144, 0.1) 1px, transparent 1px),
    linear-gradient(90deg, rgba(14, 116, 144, 0.1) 1px, transparent 1px);
}

/* --- Light mode corner marks --- */
[data-skin="blueprint"][data-theme="light"] [data-panel] {
  border-color: rgba(14, 116, 144, 0.15);
}

[data-skin="blueprint"][data-theme="light"] [data-panel]::before {
  border-top-color: rgba(14, 116, 144, 0.45);
  border-left-color: rgba(14, 116, 144, 0.45);
}

[data-skin="blueprint"][data-theme="light"] [data-panel]::after {
  border-bottom-color: rgba(14, 116, 144, 0.45);
  border-right-color: rgba(14, 116, 144, 0.45);
}

[data-skin="blueprint"][data-theme="light"] [data-panel]:hover {
  border-color: rgba(14, 116, 144, 0.3);
  box-shadow: inset 0 0 20px rgba(14, 116, 144, 0.03);
}

/* --- Light mode panel headers --- */
[data-skin="blueprint"][data-theme="light"] [data-panel-header] {
  color: rgba(14, 116, 144, 0.6);
  border-bottom-color: rgba(14, 116, 144, 0.15);
}

/* --- Light mode file tree hover --- */
[data-skin="blueprint"][data-theme="light"] [data-file-item]:hover {
  border-left-color: rgba(14, 116, 144, 0.4);
  color: #0e7490;
  background: rgba(14, 116, 144, 0.04);
}

/* --- Light mode scrollbar --- */
[data-skin="blueprint"][data-theme="light"] ::-webkit-scrollbar-thumb {
  background: rgba(14, 116, 144, 0.15);
}
[data-skin="blueprint"][data-theme="light"] ::-webkit-scrollbar-thumb:hover {
  background: rgba(14, 116, 144, 0.3);
}

/* --- Light mode sash --- */
[data-skin="blueprint"][data-theme="light"] .sash-container .sash:hover {
  background: rgba(14, 116, 144, 0.25) !important;
  box-shadow: 0 0 6px rgba(14, 116, 144, 0.15);
}

/* --- Light mode button hover --- */
[data-skin="blueprint"][data-theme="light"] button[class*="border"]:hover {
  border-color: rgba(14, 116, 144, 0.35) !important;
  box-shadow: 0 0 10px rgba(14, 116, 144, 0.08);
}
```

### 1.5 noise texture 日间处理

`styles.css` 中已有 `[data-skin="blueprint"] #root::before { opacity: 0; }` 隐藏 noise。日间模式可以考虑保持隐藏（网格已经提供了足够的纹理感），无需额外规则。

### 1.6 终端日间配色

**文件:** `src/utils/terminalCache.ts`

新增 `BLUEPRINT_LIGHT_TERMINAL_THEME` 常量：

```typescript
export const BLUEPRINT_LIGHT_TERMINAL_THEME = {
  background: '#f5f8fb',
  foreground: '#0f172a',
  cursor: '#0e7490',
  cursorAccent: '#f5f8fb',
  selectionBackground: 'rgba(14,116,144,0.15)',
  selectionForeground: '#0f172a',
  black: '#1e293b',
  red: '#dc2626',
  green: '#15803d',
  yellow: '#c2410c',
  blue: '#1d4ed8',
  magenta: '#7c3aed',
  cyan: '#0e7490',
  white: '#94a3b8',
  brightBlack: '#475569',
  brightRed: '#ef4444',
  brightGreen: '#22c55e',
  brightYellow: '#f97316',
  brightBlue: '#3b82f6',
  brightMagenta: '#8b5cf6',
  brightCyan: '#14b8a6',
  brightWhite: '#64748b',
};
```

### 1.7 getTerminalTheme 更新

**文件:** `src/utils/terminalCache.ts`

```typescript
export function getTerminalTheme(terminalFollowTheme: boolean): typeof DARK_TERMINAL_THEME {
  if (!terminalFollowTheme) return DARK_TERMINAL_THEME;
  const skin = useAppStore.getState().config.skin;
  if (skin === 'blueprint') {
    return getResolvedTheme() === 'light'
      ? BLUEPRINT_LIGHT_TERMINAL_THEME
      : BLUEPRINT_TERMINAL_THEME;
  }
  if (getResolvedTheme() === 'light') return LIGHT_TERMINAL_THEME;
  return DARK_TERMINAL_THEME;
}
```

## 2. 改动文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/App.tsx` | 修改 | 删除 `applyTheme('dark')` 强制逻辑 |
| `src/components/SettingsModal.tsx` | 修改 | 恢复主题选择器，删除禁用逻辑和提示文字 |
| `src/styles.css` | 修改 | 追加 `[data-skin="blueprint"][data-theme="light"]` 变量块 |
| `src/blueprint.css` | 修改 | 追加日间模式覆盖规则（网格/角标/滚动条/按钮等） |
| `src/utils/terminalCache.ts` | 修改 | 新增 BLUEPRINT_LIGHT_TERMINAL_THEME，更新 getTerminalTheme |

## 3. 设计原则

- **保留结构特征**：网格、角标记、等宽字体、uppercase headers — 这些是 Blueprint 的身份标识，不因主题切换而消失
- **色温反转**：深底青光 → 浅底深青，核心色相（青/蓝）保持一致
- **对比度优先**：浅底上使用更深的强调色 `#0e7490` 替代 `#22d3ee`，确保文字可读性
- **最小改动**：复用现有 CSS 架构（data-skin + data-theme 组合选择器），不引入新的机制
