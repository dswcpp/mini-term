# Blueprint 皮肤设计

**日期**: 2026-04-29
**状态**: 已确认

## 概述

为 mini-term 新增 Blueprint（蓝图）主题皮肤，源自工程制图视觉语言。皮肤作为独立于 dark/light/auto 主题之上的视觉叠加层，通过 `data-skin` 属性控制激活。

## 设计决策

| 决策项 | 选择 | 原因 |
|--------|------|------|
| 集成方式 | 皮肤系统（与主题正交） | 不破坏现有主题逻辑，可扩展更多皮肤 |
| 视觉深度 | B 级（全局蓝图化） | 所有面板统一风格，但不加重装饰 |
| 字体策略 | UI 文字等宽化，终端不变 | 终端字体用户自选，不应被覆盖 |
| 实现方式 | 纯 CSS 变量覆盖 + data-skin | 零组件侵入，样式层解决 |

## 色彩体系

```
背景基色:     #0a1628 (深普鲁士蓝)
表面色:       #0f1f38
抬升色:       #162a4a
叠加色:       #1a365d
终端背景:     #060e1c

主文字:       rgba(255,255,255,0.85)
次文字:       rgba(255,255,255,0.6)
弱文字:       rgba(96,165,250,0.5)

主边框:       rgba(96,165,250,0.25)
默认边框:     rgba(96,165,250,0.2)
弱边框:       rgba(96,165,250,0.12)

强调色:       #22d3ee (青色)
辅助色:       #60a5fa (浅蓝)
成功色:       #22c55e
警告色:       #f97316
错误色:       #ef4444
AI 色:        #a78bfa
```

## 主题联动

Blueprint 皮肤激活时，**强制锁定 resolved theme 为 dark**。原因：蓝图色彩体系基于深色背景设计，不存在 light 变体。

实现：`applySkin('blueprint')` 时如果当前 resolved theme 为 light，自动切换到 dark 并禁用 theme selector（或置灰显示提示）。卸载皮肤时恢复用户原始 theme 选择。

## 网格系统

使用 `#root::after` 伪元素承载网格背景（`#root::before` 已被 noise texture 占用）。Blueprint 皮肤激活时隐藏 noise texture（`opacity: 0`）。

```css
[data-skin="blueprint"] #root::before {
  opacity: 0; /* 隐藏 noise texture */
}
[data-skin="blueprint"] #root::after {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  background-image:
    linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px),
    linear-gradient(rgba(96,165,250,0.08) 1px, transparent 1px),
    linear-gradient(90deg, rgba(96,165,250,0.08) 1px, transparent 1px);
  background-size: 20px 20px, 20px 20px, 100px 100px, 100px 100px;
}
```

- 次网格: 20px 间距，白色细线
- 主网格: 100px 间距，浅蓝粗线
- 面板内容区使用实色背景覆盖网格，避免文字可读性下降

## 面板视觉元素

### 角标记

使用 `box-shadow` 模拟角标记效果（避免伪元素冲突）。通过 `blueprint.css` 中为特定容器添加 `outline` + `box-shadow` 组合实现：

**目标容器选择器**（在 `[data-skin="blueprint"]` 作用域下）：
- `.project-list-container` — 项目列表面板
- `.file-tree-container` — 文件树面板
- `.terminal-area` — 终端主区域
- `.git-history-container` — Git 历史面板
- `.ai-history-panel` — AI 历史面板

角标记使用 `outline` + 伪类或嵌套 `box-shadow` 实现。如果特定容器的伪元素已被占用，改用 CSS `outline-offset` + 多重 `box-shadow` 达到视觉效果，不需要修改组件 JSX。

```css
[data-skin="blueprint"] .terminal-content {
  box-shadow:
    inset 6px 6px 0 -5px rgba(34,211,238,0.6),
    inset -6px -6px 0 -5px rgba(34,211,238,0.6);
}
```

备选方案：对于确认没有伪元素占用的容器，仍可使用 `::before`/`::after` 绝对定位绘制 L 型线。

### 面板标题

- 大写字母 + letter-spacing: 1.5px
- 等宽字体
- 颜色: `rgba(96,165,250,0.7)`

### Tab 标签

- 大写编号: "TERMINAL 01"
- 活动 Tab 底部青色指示线
- 状态点保持现有颜色语义

## 交互效果

| 触发 | 效果 |
|------|------|
| 元素悬停 | 边框变亮 + 青色 box-shadow 光晕 (0 0 10-15px) |
| 角标记悬停 | L 型标记扩大 (6px → 10px) |
| 文件项悬停 | 左侧出现青色竖线指示 |
| 面板悬停 | 微弱内发光 inset box-shadow |
| 按钮悬停 | 边框变青 + 外发光 |

过渡时间统一 0.2-0.25s ease。

## 字体

Blueprint 皮肤激活时，UI 区域字体栈切换为：

```css
font-family: 'Courier New', Consolas, 'Liberation Mono', monospace;
```

不加载外部字体。终端区域字体保持用户配置不变。

## 终端配色 (xterm.js)

当 `terminalFollowTheme: true` 且 skin 为 blueprint 时使用：

```typescript
BLUEPRINT_TERMINAL_THEME = {
  background: '#060e1c',
  foreground: '#d9e2ec',
  cursor: '#22d3ee',
  cursorAccent: '#060e1c',
  selectionBackground: 'rgba(34,211,238,0.2)',
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
}
```

## 架构: 文件变更清单

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/types.ts` | 修改 | `AppConfig.skin: 'none' \| 'blueprint'` |
| `src/store.ts` | 修改 | 默认值 + `applySkin()` 见下方职责定义 |
| `src/styles.css` | 修改 | `[data-skin="blueprint"]` 变量覆盖块 |
| `src/blueprint.css` | 新增 | 网格、角标记、光晕、字体等专属样式 |
| `src/App.tsx` | 修改 | useEffect 监听 skin 变化设置 data-skin |
| `src/components/SettingsModal.tsx` | 修改 | 皮肤选择器 UI |
| `src/utils/terminalCache.ts` | 修改 | BLUEPRINT_TERMINAL_THEME + 选择逻辑 |
| `src-tauri/src/config.rs` | 修改 | AppConfig 加 skin 字段 |

## Settings UI

在"系统设置"页面，主题按钮组下方新增皮肤按钮组：

```
[主题]  ○ 深色  ○ 浅色  ○ 自动
[皮肤]  ○ 无    ○ 蓝图
```

皮肤切换立即生效，无需重启。切换时调用 `applySkin()` 更新 `data-skin` 属性并同步终端配色。

## `applySkin()` 职责

```typescript
function applySkin(skin: 'none' | 'blueprint') {
  // 1. 设置 data-skin 属性
  document.documentElement.dataset.skin = skin === 'none' ? '' : skin;

  // 2. Blueprint 强制 dark theme
  if (skin === 'blueprint') {
    applyTheme('dark');
  }

  // 3. 同步终端配色
  updateAllTerminalThemes(store.config.terminalFollowTheme);

  // 4. 持久化
  invoke('save_config', { config: store.config });
}
```

## 终端配色决策树

```
if (!terminalFollowTheme) → DARK_TERMINAL_THEME (用户原始选择)
if (skin === 'blueprint') → BLUEPRINT_TERMINAL_THEME
if (resolvedTheme === 'light') → LIGHT_TERMINAL_THEME
else → DARK_TERMINAL_THEME
```

## 弹出层 & 模态框

模态框（Settings、Search、Diff 等）、右键菜单、Toast 通知 **仅通过 CSS 变量继承获得蓝图配色**，不添加角标记或额外装饰。这些组件使用 `var(--bg-overlay)`、`var(--border-default)` 等变量，变量覆盖后自动生效。

## Allotment 分割条

Sash hover 颜色通过 `--accent-muted` 变量自动变为青色，无需额外处理。

## 滚动条

Blueprint 皮肤下自定义 webkit scrollbar（使用 `[data-skin="blueprint"]` 选择器确保优先级）：

```css
[data-skin="blueprint"] ::-webkit-scrollbar { width: 4px; }
[data-skin="blueprint"] ::-webkit-scrollbar-track { background: transparent; }
[data-skin="blueprint"] ::-webkit-scrollbar-thumb { background: rgba(96,165,250,0.2); }
[data-skin="blueprint"] ::-webkit-scrollbar-thumb:hover { background: rgba(96,165,250,0.4); }
```
