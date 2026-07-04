# Blueprint 日间模式实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Blueprint 皮肤支持日间/夜间双模式，用户选中蓝图后可自由切换深色/浅色/跟随系统

**Architecture:** 删除 Blueprint 强制 dark 逻辑，恢复主题选择器，新增日间 CSS 变量覆盖 + blueprint.css 日间规则 + 终端日间配色。通过 `[data-skin="blueprint"][data-theme="light"]` 组合选择器实现，不引入新机制。

**Tech Stack:** CSS Custom Properties, React 19, TypeScript, xterm.js

**Spec:** `docs/superpowers/specs/2026-04-29-blueprint-light-design.md`

---

### Task 1: 去掉强制 dark + 恢复主题选择器

**Files:**
- Modify: `src/App.tsx:120-128` (skin useEffect)
- Modify: `src/components/SettingsModal.tsx:647-713` (handleSkinChange + 主题按钮 + 皮肤选择器)

- [ ] **Step 1: App.tsx — 删除强制 dark 逻辑**

在 `src/App.tsx` 的 skin useEffect 中，删除这两行：

```typescript
    if (skin === 'blueprint') {
      applyTheme('dark');
    }
```

保留其余逻辑（设置 dataset.skin + updateAllTerminalThemes）。

- [ ] **Step 2: SettingsModal — 恢复主题按钮为始终可用**

在 `src/components/SettingsModal.tsx` 中，将主题按钮的 `disabled` 和三元样式还原为简单版本。

将当前的主题按钮 `.map()` 中每个 button 改回：

```tsx
          <button
            key={opt.value}
            className={`flex-1 py-2 rounded-[var(--radius-sm)] text-base transition-all ${
              config.theme === opt.value
                ? 'bg-[var(--accent-muted)] text-[var(--accent)] border border-[var(--accent)]'
                : 'bg-[var(--bg-base)] text-[var(--text-secondary)] border border-[var(--border-default)] hover:border-[var(--accent)]'
            }`}
            onClick={() => handleThemeChange(opt.value)}
          >
            {opt.label}
          </button>
```

- [ ] **Step 3: SettingsModal — 删除 Blueprint 提示文字**

删除主题按钮和皮肤选择器之间的条件提示：

```tsx
      {config.skin === 'blueprint' && (
        <div className="text-xs text-[var(--text-muted)] mt-1 mb-2">
          蓝图皮肤仅支持深色主题
        </div>
      )}
```

- [ ] **Step 4: 验证编译**

Run: `npx tsc --noEmit 2>&1 | head -10`
Expected: 无错误

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/components/SettingsModal.tsx
git commit -m "refactor(skin): 去掉 Blueprint 强制 dark，恢复主题选择器"
```

---

### Task 2: 终端日间配色

**Files:**
- Modify: `src/utils/terminalCache.ts:83-114` (新增常量 + 修改 getTerminalTheme)

- [ ] **Step 1: 添加 BLUEPRINT_LIGHT_TERMINAL_THEME 常量**

在 `BLUEPRINT_TERMINAL_THEME` 常量之后添加：

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

- [ ] **Step 2: 修改 getTerminalTheme 函数**

将 `getTerminalTheme` 函数替换为：

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

- [ ] **Step 3: 验证编译**

Run: `npx tsc --noEmit 2>&1 | head -10`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add src/utils/terminalCache.ts
git commit -m "feat(terminal): 新增 Blueprint 日间终端配色 + getTerminalTheme 分支"
```

---

### Task 3: CSS 日间变量覆盖

**Files:**
- Modify: `src/styles.css` (在 Blueprint 变量块之后追加日间变量块)

- [ ] **Step 1: 在 styles.css 的 Blueprint noise 隐藏规则之后追加日间变量块**

在 `[data-skin="blueprint"] #root::before { opacity: 0; }` 之后追加：

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

- [ ] **Step 2: 验证构建**

Run: `npx vite build 2>&1 | tail -5`
Expected: 构建成功

- [ ] **Step 3: Commit**

```bash
git add src/styles.css
git commit -m "feat(css): Blueprint 日间模式 CSS 变量覆盖"
```

---

### Task 4: blueprint.css 日间规则

**Files:**
- Modify: `src/blueprint.css` (文件末尾追加日间模式覆盖)

- [ ] **Step 1: 在 blueprint.css 末尾追加日间模式规则**

在文件末尾追加：

```css
/* ===== Blueprint Light Mode Overrides ===== */

[data-skin="blueprint"][data-theme="light"] #root::after {
  background-image:
    linear-gradient(rgba(14, 116, 144, 0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(14, 116, 144, 0.04) 1px, transparent 1px),
    linear-gradient(rgba(14, 116, 144, 0.1) 1px, transparent 1px),
    linear-gradient(90deg, rgba(14, 116, 144, 0.1) 1px, transparent 1px);
}

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

[data-skin="blueprint"][data-theme="light"] [data-panel-header] {
  color: rgba(14, 116, 144, 0.6);
  border-bottom-color: rgba(14, 116, 144, 0.15);
}

[data-skin="blueprint"][data-theme="light"] [data-file-item]:hover {
  border-left-color: rgba(14, 116, 144, 0.4);
  color: #0e7490;
  background: rgba(14, 116, 144, 0.04);
}

[data-skin="blueprint"][data-theme="light"] ::-webkit-scrollbar-thumb {
  background: rgba(14, 116, 144, 0.15);
}
[data-skin="blueprint"][data-theme="light"] ::-webkit-scrollbar-thumb:hover {
  background: rgba(14, 116, 144, 0.3);
}

[data-skin="blueprint"][data-theme="light"] .sash-container .sash:hover {
  background: rgba(14, 116, 144, 0.25) !important;
  box-shadow: 0 0 6px rgba(14, 116, 144, 0.15);
}

[data-skin="blueprint"][data-theme="light"] button[class*="border"]:hover {
  border-color: rgba(14, 116, 144, 0.35) !important;
  box-shadow: 0 0 10px rgba(14, 116, 144, 0.08);
}
```

- [ ] **Step 2: 验证构建**

Run: `npx vite build 2>&1 | tail -5`
Expected: 构建成功

- [ ] **Step 3: Commit**

```bash
git add src/blueprint.css
git commit -m "feat(css): blueprint.css 新增日间模式覆盖规则"
```

---

### Task 5: 集成验证

- [ ] **Step 1: 启动 dev server**

Run: `npm run tauri dev`

- [ ] **Step 2: 验证 Blueprint 深色模式不受影响**

Settings → 皮肤 → 蓝图，主题 → 深色。确认外观与之前一致。

- [ ] **Step 3: 切换到日间模式**

主题 → 浅色。验证：
- 背景变为浅蓝灰
- 强调色从亮青变为深青
- 网格线可见但更淡
- 角标记变为深青色
- 终端变为浅底深字
- 滚动条、sash 颜色适配

- [ ] **Step 4: 切换到跟随系统**

主题 → 跟随系统。确认随系统主题自动切换。

- [ ] **Step 5: 切回无皮肤**

皮肤 → 无。确认完全恢复 Warm Carbon 主题。

- [ ] **Step 6: 最终 commit（如有微调）**

```bash
git add -A
git commit -m "fix: Blueprint 日间模式集成微调"
```
