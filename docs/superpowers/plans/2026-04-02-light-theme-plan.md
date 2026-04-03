# 日间模式（浅色主题）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 mini-term 新增 Pure White 浅色主题，支持跟随系统自动切换和手动覆盖，终端区域可独立控制是否跟随。

**Architecture:** 通过 CSS 变量 + `data-theme` 属性切换深浅主题。新增 `themeManager.ts` 管理主题解析和系统偏好监听。Rust `AppConfig` 新增 `theme` 和 `terminal_follow_theme` 字段。

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, Zustand, xterm.js v6, Tauri v2 (Rust), CSS Custom Properties

**Spec:** `docs/superpowers/specs/2026-04-02-light-theme-design.md`

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src-tauri/src/config.rs` | 修改 | AppConfig 新增 theme 和 terminal_follow_theme 字段 |
| `src/types.ts` | 修改 | 前端 AppConfig 接口同步新增字段 |
| `src/styles.css` | 修改 | 新增浅色变量、新增 CSS 变量、修复硬编码、添加 transition |
| `index.html` | 修改 | 内联防闪烁脚本 |
| `src/utils/themeManager.ts` | 新建 | 主题解析、系统偏好监听、localStorage 缓存 |
| `src/utils/terminalCache.ts` | 修改 | 导出深浅终端主题，支持动态选择 |
| `src/store.ts` | 修改 | 初始化时调用 themeManager |
| `src/components/SettingsModal.tsx` | 修改 | 新增主题设置 UI |
| `src/components/TerminalInstance.tsx` | 修改 | 支持主题切换时更新终端、修复硬编码 |
| `src/components/StatusDot.tsx` | 修改 | 硬编码颜色改用 CSS 变量 |
| `src/components/FileTree.tsx` | 修改 | Git 状态颜色改用 CSS 变量 |
| `src/components/SessionList.tsx` | 修改 | AI 徽标颜色改用 CSS 变量 |
| `src/components/CommitDiffModal.tsx` | 修改 | diff 状态颜色改用 CSS 变量、shadow-2xl 替换 |
| `src/components/DiffModal.tsx` | 修改 | diff 行颜色改用 CSS 变量、shadow-2xl 替换 |
| `src/components/FileViewerModal.tsx` | 修改 | shadow-2xl 替换 |
| `src/components/ProjectList.tsx` | 修改 | shadow-2xl 替换 |

---

### Task 1: Rust 后端 — AppConfig 新增字段

**Files:**
- Modify: `src-tauri/src/config.rs:32-52` (AppConfig 结构体)
- Modify: `src-tauri/src/config.rs:109-124` (Default impl)

- [ ] **Step 1: 在 AppConfig 结构体中新增 theme 和 terminal_follow_theme 字段**

在 `src-tauri/src/config.rs` 的 `AppConfig` 结构体中，在 `middle_column_sizes` 字段后添加：

```rust
#[serde(default = "default_theme")]
pub theme: String,
#[serde(default = "default_terminal_follow_theme")]
pub terminal_follow_theme: bool,
```

添加默认值函数：

```rust
fn default_theme() -> String { "auto".into() }
fn default_terminal_follow_theme() -> bool { true }
```

在 `Default` impl 中补充：

```rust
theme: default_theme(),
terminal_follow_theme: default_terminal_follow_theme(),
```

- [ ] **Step 2: 验证 Rust 编译通过**

Run: `cd src-tauri && cargo build 2>&1 | tail -5`
Expected: 编译成功，无错误

- [ ] **Step 3: 运行现有 Rust 测试确保兼容**

Run: `cd src-tauri && cargo test 2>&1`
Expected: 所有测试通过（旧 config JSON 反序列化兼容，因为使用了 `serde(default)`）

- [ ] **Step 4: 提交**

```bash
git add src-tauri/src/config.rs
git commit -m "feat: AppConfig 新增 theme 和 terminal_follow_theme 字段"
```

---

### Task 2: 前端类型 — AppConfig 同步

**Files:**
- Modify: `src/types.ts:12-24` (AppConfig 接口)
- Modify: `src/store.ts:308-314` (初始默认值)

- [ ] **Step 1: 在 AppConfig 接口中新增字段**

在 `src/types.ts` 的 `AppConfig` 接口中，在 `middleColumnSizes?` 后添加：

```typescript
theme: 'auto' | 'light' | 'dark';
terminalFollowTheme: boolean;
```

- [ ] **Step 2: 更新 store 中的默认配置**

在 `src/store.ts` 中 `useAppStore` 的 `config` 初始值添加：

```typescript
config: {
  projects: [],
  defaultShell: '',
  availableShells: [],
  uiFontSize: 13,
  terminalFontSize: 14,
  theme: 'auto',
  terminalFollowTheme: true,
},
```

- [ ] **Step 3: 验证前端编译通过**

Run: `npm run build 2>&1 | tail -5`
Expected: 编译成功

- [ ] **Step 4: 提交**

```bash
git add src/types.ts src/store.ts
git commit -m "feat: 前端 AppConfig 类型同步新增 theme 和 terminalFollowTheme"
```

---

### Task 3: CSS — 新增变量和浅色主题

**Files:**
- Modify: `src/styles.css`

- [ ] **Step 1: 在 :root 中新增缺失的深色变量**

在 `src/styles.css` 的 `:root` 块中（`--color-ai` 后面），追加：

```css
--color-info: #6896c8;
--diff-add-bg: rgba(60,180,60,0.12);
--diff-del-bg: rgba(220,60,60,0.12);
--diff-add-text: #6bb87a;
--diff-del-text: #d4605a;
--color-error-muted: rgba(212, 96, 90, 0.15);
--shadow-overlay: 0 8px 32px rgba(0,0,0,0.5), 0 0 1px rgba(255,255,255,0.05);
```

- [ ] **Step 2: 新增完整的 :root[data-theme="light"] 块**

在 `:root { ... }` 结束后、`html, body, #root` 前，添加浅色覆盖块：

```css
:root[data-theme="light"] {
  --bg-base: #ffffff;
  --bg-surface: #f5f5f5;
  --bg-elevated: #ebebeb;
  --bg-overlay: #e0e0e0;
  --bg-terminal: #fafafa;

  --accent: #b06830;
  --accent-muted: #b0683033;
  --accent-subtle: #b0683018;

  --text-primary: #1a1a1a;
  --text-secondary: #666666;
  --text-muted: #999999;

  --border-subtle: rgba(0,0,0,0.06);
  --border-default: rgba(0,0,0,0.10);
  --border-strong: rgba(0,0,0,0.15);

  --color-file: #1a8a6a;
  --color-folder: #8a7a40;
  --color-success: #2d8a46;
  --color-warning: #b08620;
  --color-error: #c0392b;
  --color-ai: #8a5cb8;
  --color-info: #2860a0;

  --diff-add-bg: rgba(40,140,40,0.10);
  --diff-del-bg: rgba(200,50,40,0.10);
  --diff-add-text: #2d8a46;
  --diff-del-text: #c0392b;

  --color-error-muted: rgba(192, 57, 43, 0.12);
  --shadow-overlay: 0 8px 32px rgba(0,0,0,0.15), 0 0 1px rgba(0,0,0,0.08);
}
```

- [ ] **Step 3: 修复滚动条硬编码颜色**

将 scrollbar thumb 的硬编码 rgba 改为变量引用：

```css
::-webkit-scrollbar-thumb {
  background: var(--border-default);
  border-radius: 3px;
}

::-webkit-scrollbar-thumb:hover {
  background: var(--border-strong);
}
```

- [ ] **Step 4: 修复上下文菜单硬编码**

`.ctx-menu` 的 `box-shadow` 改为：
```css
box-shadow: var(--shadow-overlay);
```

`.ctx-menu-item.danger:hover` 的 `background` 改为：
```css
background: var(--color-error-muted);
```

- [ ] **Step 5: 修复 prompt-dialog 硬编码**

`.prompt-dialog` 的 `box-shadow` 改为：
```css
box-shadow: var(--shadow-overlay);
```

- [ ] **Step 6: 添加过渡动画和噪声纹理浅色适配**

在 `html, body, #root` 规则中添加 transition：
```css
transition: background-color 0.25s ease, color 0.25s ease,
            border-color 0.25s ease, box-shadow 0.25s ease;
```

同时为 `.ctx-menu` 和 `.prompt-dialog` 添加相同的 transition 属性（在各自的规则中追加）：
```css
.ctx-menu {
  /* 已有属性... */
  transition: background-color 0.25s ease, color 0.25s ease,
              border-color 0.25s ease, box-shadow 0.25s ease;
}

.prompt-dialog {
  /* 已有属性... */
  transition: background-color 0.25s ease, color 0.25s ease,
              border-color 0.25s ease, box-shadow 0.25s ease;
}
```

噪声纹理的 `#root::before` 添加浅色适配（通过 `data-theme` 属性选择器）：
```css
:root[data-theme="light"] #root::before {
  opacity: 0.015;
}
```

上下文菜单浅色下毛玻璃适配：
```css
:root[data-theme="light"] .ctx-menu {
  background: rgba(255, 255, 255, 0.85);
}
```

- [ ] **Step 7: 验证 CSS 无语法错误**

Run: `npm run build 2>&1 | tail -5`
Expected: 编译成功

- [ ] **Step 8: 提交**

```bash
git add src/styles.css
git commit -m "feat: 新增 Pure White 浅色主题 CSS 变量和过渡动画"
```

---

### Task 4: themeManager — 主题管理模块

**Files:**
- Create: `src/utils/themeManager.ts`

- [ ] **Step 1: 创建 themeManager.ts**

```typescript
type ThemeMode = 'auto' | 'light' | 'dark';
type ResolvedTheme = 'light' | 'dark';

let currentResolved: ResolvedTheme = 'dark';
let cleanupFn: (() => void) | null = null;

const STORAGE_KEY = 'mini-term-theme';

function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'auto') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return mode;
}

function applyToDOM(theme: ResolvedTheme) {
  currentResolved = theme;
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(STORAGE_KEY, theme);
}

export function getResolvedTheme(): ResolvedTheme {
  return currentResolved;
}

export function applyTheme(mode: ThemeMode): void {
  // 清理之前的监听
  if (cleanupFn) {
    cleanupFn();
    cleanupFn = null;
  }

  applyToDOM(resolveTheme(mode));

  if (mode === 'auto') {
    const mql = window.matchMedia('(prefers-color-scheme: light)');
    const handler = (e: MediaQueryListEvent) => {
      applyToDOM(e.matches ? 'light' : 'dark');
      // 触发自定义事件，供终端等组件监听
      window.dispatchEvent(new CustomEvent('theme-changed', { detail: getResolvedTheme() }));
    };
    mql.addEventListener('change', handler);
    cleanupFn = () => mql.removeEventListener('change', handler);
  }
}
```

- [ ] **Step 2: 验证编译通过**

Run: `npm run build 2>&1 | tail -5`
Expected: 编译成功

- [ ] **Step 3: 提交**

```bash
git add src/utils/themeManager.ts
git commit -m "feat: 新增 themeManager 模块管理主题切换和系统偏好监听"
```

---

### Task 5: index.html — 防闪烁脚本

**Files:**
- Modify: `index.html`

- [ ] **Step 1: 在 `<body>` 开头内联同步脚本**

在 `index.html` 的 `<body>` 标签后、`<div id="root">` 前添加：

```html
<script>
  (function(){
    var t = localStorage.getItem('mini-term-theme');
    if (t === 'light' || t === 'dark') {
      document.documentElement.dataset.theme = t;
    }
  })();
</script>
```

- [ ] **Step 2: 验证编译通过**

Run: `npm run build 2>&1 | tail -5`
Expected: 编译成功

- [ ] **Step 3: 提交**

```bash
git add index.html
git commit -m "feat: index.html 内联防闪烁脚本"
```

---

### Task 6: Store 集成 — 主题初始化

**Files:**
- Modify: `src/App.tsx` (找到 config 初始化的 useEffect)

- [ ] **Step 1: 在 App.tsx 中集成 themeManager**

在 `src/App.tsx` 的 config 初始化时调用 `applyTheme`。具体位置：在 `load_config` 的 `.then()` 回调中（即 config 刚加载完毕时），添加一行调用。同时新增一个独立的 `useEffect` 监听 `config.theme` 变化，确保 SettingsModal 中修改主题后也能响应。

```typescript
import { applyTheme } from './utils/themeManager';
```

在 `load_config` 回调中添加（config 首次加载）：
```typescript
applyTheme(loaded.theme ?? 'auto');
```

新增独立 effect 响应后续变化：
```typescript
useEffect(() => {
  applyTheme(config.theme ?? 'auto');
}, [config.theme]);
```

- [ ] **Step 2: 验证主题随 config 变化而切换**

Run: `npm run build 2>&1 | tail -5`
Expected: 编译成功

- [ ] **Step 3: 提交**

```bash
git add src/App.tsx
git commit -m "feat: App.tsx 集成 themeManager，config 变更时切换主题"
```

---

### Task 7: 终端主题切换 — terminalCache + TerminalInstance

**Files:**
- Modify: `src/utils/terminalCache.ts:41-76` (Terminal 创建)
- Modify: `src/components/TerminalInstance.tsx`

- [ ] **Step 1: 在 terminalCache.ts 中导出深浅终端主题对象**

在 `terminalCache.ts` 文件顶部（`cache` 定义前）添加两套 xterm 主题：

```typescript
import { getResolvedTheme } from './themeManager';

export const DARK_TERMINAL_THEME = {
  background: '#100f0d',
  foreground: '#d8d4cc',
  cursor: '#c8805a',
  cursorAccent: '#100f0d',
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
};

export const LIGHT_TERMINAL_THEME = {
  background: '#fafafa',
  foreground: '#1a1a1a',
  cursor: '#b06830',
  cursorAccent: '#fafafa',
  selectionBackground: '#b0683030',
  selectionForeground: '#1a1a1a',
  black: '#1a1a1a',
  red: '#c0392b',
  green: '#2d8a46',
  yellow: '#b08620',
  blue: '#2860a0',
  magenta: '#8a5cb8',
  cyan: '#1a8a6a',
  white: '#f0f0f0',
  brightBlack: '#666666',
  brightRed: '#e04030',
  brightGreen: '#38a058',
  brightYellow: '#c89830',
  brightBlue: '#3870b8',
  brightMagenta: '#a070d0',
  brightCyan: '#28a080',
  brightWhite: '#ffffff',
};

export function getTerminalTheme(terminalFollowTheme: boolean): typeof DARK_TERMINAL_THEME {
  if (terminalFollowTheme && getResolvedTheme() === 'light') {
    return LIGHT_TERMINAL_THEME;
  }
  return DARK_TERMINAL_THEME;
}
```

- [ ] **Step 2: 修改 getOrCreateTerminal 使用动态主题**

将 `new Terminal({ ... theme: { ... } })` 中的硬编码主题对象替换为：

```typescript
theme: getTerminalTheme(useAppStore.getState().config.terminalFollowTheme ?? true),
```

- [ ] **Step 3: 导出更新终端主题的函数**

在 `terminalCache.ts` 末尾新增：

```typescript
export function updateAllTerminalThemes(terminalFollowTheme: boolean): void {
  const theme = getTerminalTheme(terminalFollowTheme);
  for (const entry of cache.values()) {
    entry.term.options.theme = theme;
  }
}
```

- [ ] **Step 4: 在 TerminalInstance.tsx 中修复硬编码颜色**

将第 90 行 `bg-[#100f0d]` 替换为 `bg-[var(--bg-terminal)]`：

```tsx
<div
  className="flex-1 relative bg-[var(--bg-terminal)]"
```

将第 100 行拖拽区域的 `style={{ background: 'rgba(200, 128, 90, 0.06)', ... }}` 改为：

```tsx
style={{ background: 'var(--accent-subtle)', border: '2px dashed var(--accent)' }}
```

- [ ] **Step 5: 在 TerminalInstance.tsx 中添加主题切换监听**

在现有 `useEffect` 后新增一个 effect 监听主题变更：

```typescript
useEffect(() => {
  const handler = () => {
    const cached = getCachedTerminal(ptyId);
    if (cached) {
      const { config } = useAppStore.getState();
      cached.term.options.theme = getTerminalTheme(config.terminalFollowTheme ?? true);
    }
  };
  window.addEventListener('theme-changed', handler);
  return () => window.removeEventListener('theme-changed', handler);
}, [ptyId]);
```

需要在文件顶部 import `getTerminalTheme`。

- [ ] **Step 6: 验证编译通过**

Run: `npm run build 2>&1 | tail -5`
Expected: 编译成功

- [ ] **Step 7: 提交**

```bash
git add src/utils/terminalCache.ts src/components/TerminalInstance.tsx
git commit -m "feat: 终端支持深浅主题切换，修复硬编码颜色"
```

---

### Task 8: 设置面板 — 主题设置 UI

**Files:**
- Modify: `src/components/SettingsModal.tsx:307-353` (SystemSettings 组件)

- [ ] **Step 1: 在 SystemSettings 中添加主题设置 UI**

在 `SystemSettings` 组件中，在"字体大小"标题之前（`<div className="text-base text-[var(--text-muted)] uppercase...">字体大小</div>` 之前），插入主题设置区域：

```tsx
{/* 主题模式 */}
<div className="text-base text-[var(--text-muted)] uppercase tracking-[0.1em] mb-2">
  主题
</div>

<div className="flex gap-2 mb-4">
  {([
    { value: 'dark', label: '深色' },
    { value: 'light', label: '浅色' },
    { value: 'auto', label: '跟随系统' },
  ] as const).map((opt) => (
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
  ))}
</div>

{/* 终端跟随主题 */}
<div className="flex items-center justify-between px-3 py-2.5 rounded-[var(--radius-md)] bg-[var(--bg-base)] border border-[var(--border-subtle)] mb-6">
  <div>
    <div className="text-base text-[var(--text-primary)]">终端跟随主题</div>
    <div className="text-sm text-[var(--text-muted)]">关闭时终端始终使用深色方案</div>
  </div>
  <button
    className={`relative w-9 h-5 rounded-full transition-colors ${
      config.terminalFollowTheme ? 'bg-[var(--accent)]' : 'bg-[var(--border-strong)]'
    }`}
    onClick={() => handleTerminalFollowThemeChange(!config.terminalFollowTheme)}
  >
    <span
      className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
        config.terminalFollowTheme ? 'translate-x-4' : 'translate-x-0.5'
      }`}
    />
  </button>
</div>
```

- [ ] **Step 2: 添加 handler 函数**

在 `SystemSettings` 组件内部添加：

```typescript
import { applyTheme } from '../utils/themeManager';
import { updateAllTerminalThemes } from '../utils/terminalCache';

// 在 SystemSettings 函数内：
const handleThemeChange = useCallback((theme: 'auto' | 'light' | 'dark') => {
  const newConfig = { ...useAppStore.getState().config, theme };
  setConfig(newConfig);
  applyTheme(theme);
  updateAllTerminalThemes(newConfig.terminalFollowTheme ?? true);
  invoke('save_config', { config: newConfig });
}, [setConfig]);

const handleTerminalFollowThemeChange = useCallback((follow: boolean) => {
  const newConfig = { ...useAppStore.getState().config, terminalFollowTheme: follow };
  setConfig(newConfig);
  updateAllTerminalThemes(follow);
  invoke('save_config', { config: newConfig });
}, [setConfig]);
```

需要在文件顶部添加对应 import。

- [ ] **Step 3: 验证编译通过**

Run: `npm run build 2>&1 | tail -5`
Expected: 编译成功

- [ ] **Step 4: 提交**

```bash
git add src/components/SettingsModal.tsx
git commit -m "feat: 设置面板新增主题模式和终端跟随主题设置"
```

---

### Task 9: 组件硬编码修复 — StatusDot

**Files:**
- Modify: `src/components/StatusDot.tsx`

- [ ] **Step 1: 将硬编码颜色改为 CSS 变量**

替换 `STATUS_STYLES` 对象：

```typescript
const STATUS_STYLES: Record<PaneStatus, { bg: string; shadow: string }> = {
  idle: { bg: 'var(--text-muted)', shadow: 'none' },
  'ai-idle': { bg: 'var(--color-success)', shadow: 'none' },
  'ai-working': { bg: 'var(--color-ai)', shadow: '0 0 6px var(--color-ai)' },
  error: { bg: 'var(--color-error)', shadow: 'none' },
};
```

注意 `ai-working` 的 shadow 原来用了 `#b08cd480`（带透明度），现在改为 `var(--color-ai)` 直接用会稍有差异，但因为 shadow 本身就是扩散效果，视觉上差别很小。

- [ ] **Step 2: 验证编译通过**

Run: `npm run build 2>&1 | tail -5`
Expected: 编译成功

- [ ] **Step 3: 提交**

```bash
git add src/components/StatusDot.tsx
git commit -m "refactor: StatusDot 颜色改用 CSS 变量"
```

---

### Task 10: 组件硬编码修复 — FileTree Git 状态颜色

**Files:**
- Modify: `src/components/FileTree.tsx:174-177` (GIT_COLORS)

- [ ] **Step 1: 替换 GIT_COLORS 为 CSS 变量引用**

```typescript
const GIT_COLORS: Record<string, string> = {
  M: 'text-[var(--color-warning)]',
  A: 'text-[var(--color-success)]',
  D: 'text-[var(--color-error)]',
  R: 'text-[var(--color-info)]',
  '?': 'text-[var(--color-success)]',
  C: 'text-[var(--color-error)]',
};
```

- [ ] **Step 2: 验证编译通过**

Run: `npm run build 2>&1 | tail -5`
Expected: 编译成功

- [ ] **Step 3: 提交**

```bash
git add src/components/FileTree.tsx
git commit -m "refactor: FileTree Git 状态颜色改用 CSS 变量"
```

---

### Task 11: 组件硬编码修复 — SessionList AI 徽标

**Files:**
- Modify: `src/components/SessionList.tsx:34-37` (TYPE_BADGE)

- [ ] **Step 1: 替换 TYPE_BADGE 为 CSS 变量引用**

```typescript
const TYPE_BADGE: Record<string, { label: string; color: string }> = {
  claude: { label: 'C', color: 'var(--color-ai)' },
  codex: { label: 'X', color: 'var(--color-success)' },
};
```

- [ ] **Step 2: 验证编译通过**

Run: `npm run build 2>&1 | tail -5`
Expected: 编译成功

- [ ] **Step 3: 提交**

```bash
git add src/components/SessionList.tsx
git commit -m "refactor: SessionList AI 徽标颜色改用 CSS 变量"
```

---

### Task 12: 组件硬编码修复 — CommitDiffModal

**Files:**
- Modify: `src/components/CommitDiffModal.tsx:17-22` (STATUS_LABELS)
- Modify: `src/components/CommitDiffModal.tsx:91` (shadow-2xl)

- [ ] **Step 1: 替换 STATUS_LABELS 颜色**

```typescript
const STATUS_LABELS: Record<string, { text: string; color: string }> = {
  added: { text: 'A', color: 'text-[var(--color-success)]' },
  modified: { text: 'M', color: 'text-[var(--color-warning)]' },
  deleted: { text: 'D', color: 'text-[var(--color-error)]' },
  renamed: { text: 'R', color: 'text-[var(--color-info)]' },
};
```

- [ ] **Step 2: 替换 shadow-2xl**

第 91 行，将 `shadow-2xl` 替换为 `shadow-[var(--shadow-overlay)]`。

- [ ] **Step 3: 验证编译通过**

Run: `npm run build 2>&1 | tail -5`
Expected: 编译成功

- [ ] **Step 4: 提交**

```bash
git add src/components/CommitDiffModal.tsx
git commit -m "refactor: CommitDiffModal 颜色和阴影改用 CSS 变量"
```

---

### Task 13: 组件硬编码修复 — DiffModal

**Files:**
- Modify: `src/components/DiffModal.tsx`

- [ ] **Step 1: 替换 InlineView 中的硬编码颜色**

第 26 行 `'bg-[rgba(60,180,60,0.12)]'` → `'bg-[var(--diff-add-bg)]'`
第 28 行 `'bg-[rgba(220,60,60,0.12)]'` → `'bg-[var(--diff-del-bg)]'`
第 38 行 `'text-green-400'` → `'text-[var(--diff-add-text)]'`
第 40 行 `'text-red-400'` → `'text-[var(--diff-del-text)]'`

- [ ] **Step 2: 替换 SideBySideView 中的硬编码颜色**

第 107 行中的 `'bg-[rgba(60,180,60,0.12)]'` → `'bg-[var(--diff-add-bg)]'`
第 107 行中的 `'bg-[rgba(220,60,60,0.12)]'` → `'bg-[var(--diff-del-bg)]'`
第 115 行中的 `'text-green-400'` → `'text-[var(--diff-add-text)]'`
第 115 行中的 `'text-red-400'` → `'text-[var(--diff-del-text)]'`

- [ ] **Step 3: 替换 shadow-2xl**

第 180 行，将 `shadow-2xl` 替换为 `shadow-[var(--shadow-overlay)]`。

- [ ] **Step 4: 验证编译通过**

Run: `npm run build 2>&1 | tail -5`
Expected: 编译成功

- [ ] **Step 5: 提交**

```bash
git add src/components/DiffModal.tsx
git commit -m "refactor: DiffModal 颜色和阴影改用 CSS 变量"
```

---

### Task 14: 剩余 Modal shadow-2xl 替换

**Files:**
- Modify: `src/components/SettingsModal.tsx:470`
- Modify: `src/components/ProjectList.tsx:453`
- Modify: `src/components/FileViewerModal.tsx:45`

- [ ] **Step 1: 在三个文件中将 shadow-2xl 替换为 shadow-[var(--shadow-overlay)]**

`SettingsModal.tsx` 第 470 行、`ProjectList.tsx` 第 453 行、`FileViewerModal.tsx` 第 45 行，均将 `shadow-2xl` 替换为 `shadow-[var(--shadow-overlay)]`。

- [ ] **Step 2: 验证编译通过**

Run: `npm run build 2>&1 | tail -5`
Expected: 编译成功

- [ ] **Step 3: 提交**

```bash
git add src/components/SettingsModal.tsx src/components/ProjectList.tsx src/components/FileViewerModal.tsx
git commit -m "refactor: 所有 Modal shadow-2xl 改用 --shadow-overlay 变量"
```

---

### Task 15: 集成验证 — 全功能测试

**Files:** 无修改，仅验证

- [ ] **Step 1: 确保前端编译通过**

Run: `npm run build 2>&1 | tail -10`
Expected: 编译成功

- [ ] **Step 2: 确保 Rust 编译和测试通过**

Run: `cd src-tauri && cargo test 2>&1`
Expected: 所有测试通过

- [ ] **Step 3: 启动 Tauri 开发环境手动验证**

Run: `npm run tauri dev`

验证清单：
1. 默认启动为深色主题（或跟随系统）
2. 设置面板 > 系统设置 > 主题 > 点击"浅色" → 整个 UI 切换为浅色，过渡平滑
3. 终端跟随主题开关开启时，终端背景变为浅色
4. 终端跟随主题开关关闭时，终端保持深色
5. 点击"跟随系统"，然后在 Windows 设置中切换深浅模式，应用实时响应
6. 关闭重启应用，主题偏好已保存
7. 文件树 Git 状态颜色在两种主题下清晰可读
8. StatusDot 在两种主题下清晰可见
9. Diff Modal、CommitDiff Modal 在浅色下对比度正常
10. 上下文菜单（右键）在浅色下毛玻璃效果正常
11. 滚动条在浅色下可见

- [ ] **Step 4: 如有问题，修复后提交**
