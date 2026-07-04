# Blueprint 皮肤实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 mini-term 新增 Blueprint 工程蓝图皮肤，作为独立于主题系统的视觉叠加层

**Architecture:** 通过 `data-skin` HTML 属性控制皮肤激活，CSS 变量覆盖实现配色切换，独立 `blueprint.css` 文件承载网格/角标记/光晕等专属样式。Rust 后端 AppConfig 新增 `skin` 字段持久化。

**Tech Stack:** CSS Custom Properties, Tailwind CSS v4, React 19, Zustand, Rust/Tauri v2, xterm.js

**Spec:** `docs/superpowers/specs/2026-04-29-blueprint-skin-design.md`

---

### Task 1: Rust 后端 — AppConfig 新增 skin 字段

**Files:**
- Modify: `src-tauri/src/config.rs:38-94` (AppConfig struct + Default impl)

- [ ] **Step 1: 添加 skin 字段到 AppConfig struct**

在 `config.rs` 的 `AppConfig` struct 中，`theme` 字段后面（约第 58 行后）添加：

```rust
    #[serde(default = "default_skin")]
    pub skin: String,
```

- [ ] **Step 2: 添加默认值函数**

在 `default_theme()` 函数附近添加：

```rust
fn default_skin() -> String {
    "none".into()
}
```

- [ ] **Step 3: 更新 Default impl**

在 `impl Default for AppConfig` 中，`theme: default_theme(),` 后面添加：

```rust
            skin: default_skin(),
```

- [ ] **Step 4: 验证编译**

Run: `cd src-tauri && cargo build 2>&1 | tail -5`
Expected: 编译成功，无错误

- [ ] **Step 5: 验证现有测试通过**

Run: `cd src-tauri && cargo test 2>&1 | tail -10`
Expected: 所有测试 PASSED

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/config.rs
git commit -m "feat(config): Rust AppConfig 新增 skin 字段，默认 'none'"
```

---

### Task 2: 前端类型 + Store — skin 状态管理

**Files:**
- Modify: `src/types.ts:24` (AppConfig interface)
- Modify: `src/store.ts:327` (config 默认值)

- [ ] **Step 1: 更新 TypeScript 类型**

在 `src/types.ts` 的 `AppConfig` 接口中，`theme` 字段后添加：

```typescript
  skin: 'none' | 'blueprint';
```

- [ ] **Step 2: 更新 store 默认值**

在 `src/store.ts` 的 config 初始值中，`theme: 'auto',` 后添加：

```typescript
    skin: 'none',
```

- [ ] **Step 3: 验证 TypeScript 编译**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: 无类型错误（或仅预期的 skin 使用处错误）

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/store.ts
git commit -m "feat(types): 前端 AppConfig 新增 skin 类型定义和默认值"
```

---

### Task 3: 终端配色 — Blueprint Terminal Theme

**Files:**
- Modify: `src/utils/terminalCache.ts:33-88` (theme constants + getTerminalTheme)

- [ ] **Step 1: 添加 BLUEPRINT_TERMINAL_THEME 常量**

在 `LIGHT_TERMINAL_THEME` 常量后面（第 81 行后），添加：

```typescript
export const BLUEPRINT_TERMINAL_THEME = {
  background: '#060e1c',
  foreground: '#d9e2ec',
  cursor: '#22d3ee',
  cursorAccent: '#060e1c',
  selectionBackground: 'rgba(34,211,238,0.2)',
  selectionForeground: '#f8fafc',
  black: '#0a1628',
  red: '#ef4444',
  green: '#22c55e',
  yellow: '#f97316',
  blue: '#60a5fa',
  magenta: '#a78bfa',
  cyan: '#22d3ee',
  white: '#e2e8f0',
  brightBlack: '#1a365d',
  brightRed: '#f87171',
  brightGreen: '#4ade80',
  brightYellow: '#fb923c',
  brightBlue: '#93c5fd',
  brightMagenta: '#c4b5fd',
  brightCyan: '#67e8f9',
  brightWhite: '#f8fafc',
};
```

- [ ] **Step 2: 修改 getTerminalTheme 函数**

将现有的 `getTerminalTheme` 函数替换为：

```typescript
export function getTerminalTheme(terminalFollowTheme: boolean): typeof DARK_TERMINAL_THEME {
  if (!terminalFollowTheme) return DARK_TERMINAL_THEME;
  const skin = useAppStore.getState().config.skin;
  if (skin === 'blueprint') return BLUEPRINT_TERMINAL_THEME;
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
git commit -m "feat(terminal): 新增 Blueprint 终端配色方案及决策树逻辑"
```

---

### Task 4: CSS 变量覆盖 — styles.css

**Files:**
- Modify: `src/styles.css` (文件末尾追加 blueprint 变量块)

- [ ] **Step 1: 在 styles.css 末尾追加 Blueprint CSS 变量覆盖**

在文件末尾追加：

```css
/* ===== Blueprint Skin — CSS Variable Overrides ===== */

:root[data-skin="blueprint"] {
  --bg-base: #0a1628;
  --bg-surface: #0f1f38;
  --bg-elevated: #162a4a;
  --bg-overlay: #1a365d;
  --bg-terminal: #060e1c;

  --accent: #22d3ee;
  --accent-muted: rgba(34, 211, 238, 0.2);
  --accent-subtle: rgba(34, 211, 238, 0.08);

  --text-primary: rgba(255, 255, 255, 0.85);
  --text-secondary: rgba(255, 255, 255, 0.6);
  --text-muted: rgba(96, 165, 250, 0.5);

  --border-subtle: rgba(96, 165, 250, 0.12);
  --border-default: rgba(96, 165, 250, 0.2);
  --border-strong: rgba(96, 165, 250, 0.25);

  --color-file: #60a5fa;
  --color-folder: #93c5fd;
  --color-success: #22c55e;
  --color-warning: #f97316;
  --color-error: #ef4444;
  --color-ai: #a78bfa;
  --color-ai-working: #22d3ee;
  --color-info: #60a5fa;

  --diff-add-bg: rgba(34, 197, 94, 0.12);
  --diff-del-bg: rgba(239, 68, 68, 0.12);
  --diff-add-text: #22c55e;
  --diff-del-text: #ef4444;

  --color-error-muted: rgba(239, 68, 68, 0.15);
  --shadow-overlay: 0 8px 32px rgba(0, 0, 0, 0.6), 0 0 1px rgba(96, 165, 250, 0.2);

  --radius-sm: 2px;
  --radius-md: 3px;
}
```

- [ ] **Step 2: 添加 noise texture 隐藏规则**

在 Blueprint 变量块后追加：

```css
[data-skin="blueprint"] #root::before {
  opacity: 0;
}
```

- [ ] **Step 3: 验证 Vite dev 能正常编译 CSS**

Run: `npx vite build 2>&1 | tail -5`
Expected: 构建成功

- [ ] **Step 4: Commit**

```bash
git add src/styles.css
git commit -m "feat(css): Blueprint 皮肤 CSS 变量覆盖 + noise texture 隐藏"
```

---

### Task 5: Blueprint 专属样式 — blueprint.css

**Files:**
- Create: `src/blueprint.css`
- Modify: `src/styles.css:1-2` (添加 import)

- [ ] **Step 1: 创建 blueprint.css**

创建 `src/blueprint.css`，内容如下：

```css
/* ===== Blueprint Skin — Exclusive Styles ===== */
/* 仅在 [data-skin="blueprint"] 下生效 */

/* --- Grid Background via #root::after --- */
[data-skin="blueprint"] #root::after {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.03) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.03) 1px, transparent 1px),
    linear-gradient(rgba(96, 165, 250, 0.08) 1px, transparent 1px),
    linear-gradient(90deg, rgba(96, 165, 250, 0.08) 1px, transparent 1px);
  background-size: 20px 20px, 20px 20px, 100px 100px, 100px 100px;
}

/* --- Monospace Font for UI --- */
[data-skin="blueprint"] {
  font-family: 'Courier New', Consolas, 'Liberation Mono', monospace;
}

/* --- Panel Corner Marks --- */
[data-skin="blueprint"] [data-panel] {
  position: relative;
  border: 1px solid rgba(96, 165, 250, 0.2);
  transition: box-shadow 0.25s ease, border-color 0.25s ease;
}

[data-skin="blueprint"] [data-panel]::before {
  content: '';
  position: absolute;
  top: -1px;
  left: -1px;
  width: 8px;
  height: 8px;
  border-top: 1.5px solid rgba(34, 211, 238, 0.6);
  border-left: 1.5px solid rgba(34, 211, 238, 0.6);
  pointer-events: none;
  z-index: 5;
  transition: width 0.2s ease, height 0.2s ease;
}

[data-skin="blueprint"] [data-panel]::after {
  content: '';
  position: absolute;
  bottom: -1px;
  right: -1px;
  width: 8px;
  height: 8px;
  border-bottom: 1.5px solid rgba(34, 211, 238, 0.6);
  border-right: 1.5px solid rgba(34, 211, 238, 0.6);
  pointer-events: none;
  z-index: 5;
  transition: width 0.2s ease, height 0.2s ease;
}

[data-skin="blueprint"] [data-panel]:hover::before,
[data-skin="blueprint"] [data-panel]:hover::after {
  width: 12px;
  height: 12px;
}

[data-skin="blueprint"] [data-panel]:hover {
  border-color: rgba(34, 211, 238, 0.35);
  box-shadow: inset 0 0 20px rgba(34, 211, 238, 0.03);
}

/* --- Panel Headers: uppercase + letter-spacing --- */
[data-skin="blueprint"] [data-panel-header] {
  text-transform: uppercase;
  letter-spacing: 1.5px;
  font-size: 9px;
  color: rgba(96, 165, 250, 0.7);
  border-bottom: 1px solid rgba(96, 165, 250, 0.2);
}

/* --- Tab Styling --- */
[data-skin="blueprint"] [data-pane-tab] {
  text-transform: uppercase;
  letter-spacing: 1px;
  font-size: 10px;
}

/* --- Interactive Hover Effects (buttons with borders) --- */
[data-skin="blueprint"] button[class*="border"]:hover {
  border-color: rgba(34, 211, 238, 0.4) !important;
  box-shadow: 0 0 10px rgba(34, 211, 238, 0.12);
}

/* --- File Tree Items --- */
[data-skin="blueprint"] [data-file-item] {
  border-left: 2px solid transparent;
  transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease;
}

[data-skin="blueprint"] [data-file-item]:hover {
  border-left-color: rgba(34, 211, 238, 0.5);
  color: #22d3ee;
  background: rgba(34, 211, 238, 0.04);
}

/* --- Scrollbar --- */
[data-skin="blueprint"] ::-webkit-scrollbar {
  width: 4px;
  height: 4px;
}
[data-skin="blueprint"] ::-webkit-scrollbar-track {
  background: transparent;
}
[data-skin="blueprint"] ::-webkit-scrollbar-thumb {
  background: rgba(96, 165, 250, 0.2);
  border-radius: 2px;
}
[data-skin="blueprint"] ::-webkit-scrollbar-thumb:hover {
  background: rgba(96, 165, 250, 0.4);
}

/* --- Allotment Sash Glow --- */
[data-skin="blueprint"] .sash-container .sash:hover {
  background: rgba(34, 211, 238, 0.3) !important;
  box-shadow: 0 0 6px rgba(34, 211, 238, 0.2);
}
```

- [ ] **Step 2: 在 styles.css 中导入 blueprint.css**

在 `src/styles.css` 的第 2 行（`@import "allotment/dist/style.css";` 之后）添加：

```css
@import "./blueprint.css";
```

- [ ] **Step 3: 验证构建**

Run: `npx vite build 2>&1 | tail -5`
Expected: 构建成功

- [ ] **Step 4: Commit**

```bash
git add src/blueprint.css src/styles.css
git commit -m "feat(css): 新增 blueprint.css — 网格/角标记/字体/光晕/滚动条专属样式"
```

---

### Task 6: App.tsx — skin 应用逻辑

**Files:**
- Modify: `src/App.tsx:115-118` (theme useEffect 附近)
- Modify: `src/utils/terminalCache.ts` (import updateAllTerminalThemes 已存在于 App.tsx 的导入中，需确认)

- [ ] **Step 1: 添加 skin 应用 useEffect**

在 `src/App.tsx` 中现有主题 useEffect（约第 116-118 行）后面添加。需要导入 `updateAllTerminalThemes`（如果尚未导入）：

```typescript
  // 皮肤变化时应用
  useEffect(() => {
    const skin = config.skin ?? 'none';
    document.documentElement.dataset.skin = skin === 'none' ? '' : skin;
    if (skin === 'blueprint') {
      applyTheme('dark');
    }
    // 同步终端配色（启动恢复持久化皮肤时也需要）
    updateAllTerminalThemes(config.terminalFollowTheme);
  }, [config.skin]);
```

确保文件顶部有 `import { updateAllTerminalThemes } from './utils/terminalCache';`（若已有则跳过）。

- [ ] **Step 2: 验证编译**

Run: `npx tsc --noEmit 2>&1 | head -10`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat(app): useEffect 监听 skin 变化，设置 data-skin + 强制 dark + 同步终端配色"
```

---

### Task 7: SettingsModal — 皮肤选择器 UI

**Files:**
- Modify: `src/components/SettingsModal.tsx:640-692` (SystemSettings 组件内)

- [ ] **Step 1: 添加 skin 变更处理函数**

在 `handleTerminalFollowThemeChange` 回调（约第 640-645 行）后面添加：

```typescript
  const handleSkinChange = useCallback((skin: 'none' | 'blueprint') => {
    const currentConfig = useAppStore.getState().config;
    const newConfig = { ...currentConfig, skin };
    setConfig(newConfig);
    updateAllTerminalThemes(newConfig.terminalFollowTheme);
    invoke('save_config', { config: newConfig });
  }, [setConfig]);
```

- [ ] **Step 2: 添加皮肤选择器 UI**

在主题按钮组的 `</div>`（约第 672 行）和终端跟随主题 toggle（约第 674 行）之间，插入皮肤选择器：

```tsx
      {/* 皮肤 */}
      <div className="text-base text-[var(--text-muted)] uppercase tracking-[0.1em] mb-2 mt-4">
        皮肤
      </div>

      <div className="flex gap-2 mb-4">
        {([
          { value: 'none' as const, label: '无' },
          { value: 'blueprint' as const, label: '蓝图' },
        ]).map((opt) => (
          <button
            key={opt.value}
            className={`flex-1 py-2 rounded-[var(--radius-sm)] text-base transition-all ${
              config.skin === opt.value
                ? 'bg-[var(--accent-muted)] text-[var(--accent)] border border-[var(--accent)]'
                : 'bg-[var(--bg-base)] text-[var(--text-secondary)] border border-[var(--border-default)] hover:border-[var(--accent)]'
            }`}
            onClick={() => handleSkinChange(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
```

- [ ] **Step 3: Blueprint 激活时禁用主题选择器**

修改主题按钮组（约第 654-672 行），在每个按钮上添加 disabled 状态。将按钮改为：

```tsx
        {([
          { value: 'dark' as const, label: '深色' },
          { value: 'light' as const, label: '浅色' },
          { value: 'auto' as const, label: '跟随系统' },
        ]).map((opt) => (
          <button
            key={opt.value}
            disabled={config.skin === 'blueprint'}
            className={`flex-1 py-2 rounded-[var(--radius-sm)] text-base transition-all ${
              config.skin === 'blueprint'
                ? 'opacity-40 cursor-not-allowed bg-[var(--bg-base)] text-[var(--text-muted)] border border-[var(--border-subtle)]'
                : config.theme === opt.value
                  ? 'bg-[var(--accent-muted)] text-[var(--accent)] border border-[var(--accent)]'
                  : 'bg-[var(--bg-base)] text-[var(--text-secondary)] border border-[var(--border-default)] hover:border-[var(--accent)]'
            }`}
            onClick={() => handleThemeChange(opt.value)}
          >
            {opt.label}
          </button>
        ))}
```

在按钮组下方、皮肤选择器上方添加提示文本（仅 blueprint 时显示）：

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
git add src/components/SettingsModal.tsx
git commit -m "feat(settings): 新增皮肤选择器 + Blueprint 时禁用主题切换"
```

---

### Task 8: 组件 data 属性标记 — 让 CSS 选择器生效

**Files:**
- Modify: `src/components/ProjectList.tsx:506` (根容器 div)
- Modify: `src/components/FileTree.tsx:477-478` (根容器 + 标题 div)
- Modify: `src/components/TerminalArea.tsx:170` (终端区域根容器)
- Modify: `src/components/PaneGroup.tsx:251,258` (tab bar + 各 tab 元素)
- Modify: `src/components/FileTree.tsx:38` (TreeNode 组件的根 div)
- Modify: `src/components/GitHistory.tsx` (Git 面板根容器)

- [ ] **Step 1: ProjectList — 添加 data-panel**

`src/components/ProjectList.tsx` 约第 506 行，将：
```tsx
<div className="h-full bg-[var(--bg-surface)] flex flex-col select-none">
```
改为：
```tsx
<div data-panel className="h-full bg-[var(--bg-surface)] flex flex-col select-none">
```

- [ ] **Step 2: FileTree — 添加 data-panel + data-panel-header**

`src/components/FileTree.tsx` 约第 477 行根容器，将：
```tsx
<div className="h-full bg-[var(--bg-surface)] flex flex-col border-l border-[var(--border-subtle)] select-none">
```
改为：
```tsx
<div data-panel className="h-full bg-[var(--bg-surface)] flex flex-col border-l border-[var(--border-subtle)] select-none">
```

约第 478 行标题栏，将：
```tsx
<div className="px-3 pt-3 pb-1.5 flex items-center justify-between gap-2 flex-shrink-0">
```
改为：
```tsx
<div data-panel-header className="px-3 pt-3 pb-1.5 flex items-center justify-between gap-2 flex-shrink-0">
```

- [ ] **Step 3: TerminalArea — 添加 data-panel**

`src/components/TerminalArea.tsx` 约第 170 行，将：
```tsx
<div className="flex flex-col h-full bg-[var(--bg-terminal)]">
```
改为：
```tsx
<div data-panel className="flex flex-col h-full bg-[var(--bg-terminal)]">
```

- [ ] **Step 4: PaneGroup — tab bar 添加 data-panel-header，各 tab 添加 data-pane-tab**

`src/components/PaneGroup.tsx` 约第 251 行 tab bar 容器，将：
```tsx
<div
  className="flex bg-[var(--bg-elevated)] border-b border-[var(--border-subtle)] text-[11px] overflow-x-auto select-none shrink-0"
```
改为：
```tsx
<div
  data-panel-header
  className="flex bg-[var(--bg-elevated)] border-b border-[var(--border-subtle)] text-[11px] overflow-x-auto select-none shrink-0"
```

约第 258 行各 tab div，将：
```tsx
<div
  key={pane.id}
  className={`flex items-center gap-1.5 px-3 py-[3px] cursor-pointer whitespace-nowrap transition-all duration-100 relative ${
```
改为：
```tsx
<div
  key={pane.id}
  data-pane-tab
  className={`flex items-center gap-1.5 px-3 py-[3px] cursor-pointer whitespace-nowrap transition-all duration-100 relative ${
```

- [ ] **Step 5: FileTree TreeNode — 添加 data-file-item**

`src/components/FileTree.tsx` 的 `TreeNode` 组件中，找到每个文件/文件夹项的可点击容器 div，在其上添加 `data-file-item` 属性。该容器通常是 TreeNode render 方法中带有 `onClick` 和 `cursor-pointer` 的 div。

- [ ] **Step 6: GitHistory — 添加 data-panel**

在 `src/components/GitHistory.tsx` 的根容器 div 上添加 `data-panel` 属性。

- [ ] **Step 7: 验证编译**

Run: `npx tsc --noEmit 2>&1 | head -10`
Expected: 无错误

- [ ] **Step 8: Commit**

```bash
git add src/components/ProjectList.tsx src/components/FileTree.tsx src/components/TerminalArea.tsx src/components/PaneGroup.tsx src/components/GitHistory.tsx
git commit -m "feat(components): 面板添加 data-panel/data-panel-header/data-pane-tab/data-file-item 属性"
```

---

### Task 9: 集成测试 — 手动验证

- [ ] **Step 1: 启动 dev server**

Run: `npm run tauri dev`

- [ ] **Step 2: 验证默认状态**

打开应用，确认默认 skin 为 'none'，界面外观与之前完全一致。

- [ ] **Step 3: 切换到 Blueprint 皮肤**

进入 Settings → 系统设置 → 皮肤 → 选择"蓝图"。验证：
- 背景变为深普鲁士蓝 + 网格线可见
- 文字变为等宽字体
- 面板出现角标记（L 型青色线）
- 边框变为浅蓝色
- 主题自动切换到 dark（如果之前是 light/auto）
- 终端配色变为 blueprint 方案（深蓝背景 + 青色光标）
- 悬停面板时有青色光晕
- 滚动条变窄变蓝

- [ ] **Step 4: 切换回"无"皮肤**

确认所有视觉恢复到原来的 Warm Carbon 主题。

- [ ] **Step 5: 验证持久化**

关闭并重新打开应用，确认 Blueprint 皮肤设置被保存。

- [ ] **Step 6: 最终 commit（如有微调）**

```bash
git add -A
git commit -m "fix: Blueprint 皮肤集成测试微调"
```
