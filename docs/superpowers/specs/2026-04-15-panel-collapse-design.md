# 面板折叠设计

## 概述

支持左栏（Projects + Sessions）和中栏（Files + Git）按需折叠为 36px 图标栏，让终端区域获得更多空间。折叠状态持久化，重启后保持。

对应 Issue: #11

## 设计决策

| 决策项 | 选择 |
|--------|------|
| 折叠范围 | 4 个区域全部支持（Projects、Sessions、Files、Git） |
| 折叠粒度 | 栏级（左栏整体、中栏整体） |
| 折叠态样式 | 36px 图标栏，Projects 图标带 AI 状态角标 |
| 展开方式 | 永久展开，需手动折叠 |
| 实现方案 | Allotment `visible` 属性控制 Pane 显隐 |

## 状态模型

### AppConfig 新增字段

```typescript
interface AppConfig {
  // 现有字段...
  leftColumnCollapsed?: boolean;    // 左栏是否折叠
  middleColumnCollapsed?: boolean;  // 中栏是否折叠
  leftColumnSize?: number;          // 左栏折叠前的宽度（用于恢复）
  middleColumnSize?: number;        // 中栏折叠前的宽度（用于恢复）
}
```

### Rust 后端对应字段

```rust
pub struct AppConfig {
    // 现有字段...
    pub left_column_collapsed: Option<bool>,
    pub middle_column_collapsed: Option<bool>,
    pub left_column_size: Option<f64>,
    pub middle_column_size: Option<f64>,
}
```

### Store 新增 action

```typescript
toggleLeftColumn: () => void;    // 切换左栏折叠
toggleMiddleColumn: () => void;  // 切换中栏折叠
```

## Allotment 布局变更

### 变更前（3 Pane）

```
Allotment (horizontal)
├── Pane [minSize=140, maxSize=350] → ProjectList
├── Pane [minSize=180]              → FileTree + Git
└── Pane                            → TerminalArea
```

### 变更后（5 Pane）

```
Allotment (horizontal)
├── Pane [visible=!leftCollapsed, minSize=140, maxSize=350] → ProjectList
├── Pane [visible=leftCollapsed, minSize=36, maxSize=36]    → LeftIconBar
├── Pane [visible=!middleCollapsed, minSize=180]            → FileTree + Git
├── Pane [visible=middleCollapsed, minSize=36, maxSize=36]  → MiddleIconBar
└── Pane                                                     → TerminalArea
```

- 原 Pane 和对应 IconBar Pane 互斥显示（`visible` 互为取反）
- IconBar Pane 固定 36px（`minSize=maxSize=36`），不可拖拽
- `layoutSizes` 保存逻辑需忽略 IconBar Pane 的尺寸，只记录展开态的真实宽度

## IconBar 组件

### LeftIconBar

```
┌──────┐
│  ▶   │  ← 展开按钮
│──────│
│  📁  │  ← Projects 图标 + AI 状态角标
│  💬  │  ← Sessions 图标
│      │
└──────┘
```

### MiddleIconBar

```
┌──────┐
│  ▶   │  ← 展开按钮
│──────│
│  📄  │  ← Files 图标
│  ⑂   │  ← Git 图标
│      │
└──────┘
```

### 交互

- 点击展开箭头 ▶ 或任意图标 → 展开整栏
- 图标 hover 显示 tooltip
- Projects 图标右上角显示 AI 状态角标

### AI 状态角标

从 `store.projectStates` 遍历所有项目的 tab 状态，取最高优先级映射为角标颜色：

优先级：`ai-working`(橙) > `error`(红) > `ai-idle`(绿) > `running`(蓝) > `idle`(灰)

## 折叠触发

在展开态的栏标题区域添加折叠按钮 `◀`：

- ProjectList 标题栏："PROJECTS ──── [◀]"
- FileTree 标题栏："FILES — name ──── [◀]"

## 状态流转

```
用户点击 [◀]
  → store.toggleLeftColumn()
  → 记录当前宽度到 config.leftColumnSize
  → 设 config.leftColumnCollapsed = true
  → Allotment visible 响应变化
  → 原 Pane 隐藏，IconBar Pane 显示
  → 防抖 500ms → persistConfig()

用户点击 [▶] 或图标
  → store.toggleLeftColumn()
  → 设 config.leftColumnCollapsed = false
  → Allotment visible 响应变化
  → IconBar 隐藏，原 Pane 恢复（宽度从 leftColumnSize 恢复）
  → 防抖 500ms → persistConfig()

应用启动
  → loadConfig() 读取折叠状态
  → 直接渲染对应的折叠/展开态
```

## 涉及文件

| 文件 | 变更 |
|------|------|
| `src-tauri/src/config.rs` | AppConfig 新增 4 个字段 |
| `src/types.ts` | AppConfig 类型新增 4 个字段 |
| `src/store.ts` | 新增 toggleLeftColumn / toggleMiddleColumn action |
| `src/App.tsx` | Allotment 从 3 Pane 改为 5 Pane，visible 控制 |
| `src/components/LeftIconBar.tsx` | 新建：左栏图标栏组件 |
| `src/components/MiddleIconBar.tsx` | 新建：中栏图标栏组件 |
| `src/components/ProjectList.tsx` | 标题栏添加折叠按钮 |
| `src/components/FileTree.tsx` | 标题栏添加折叠按钮 |
