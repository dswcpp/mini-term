# Projects 嵌套组功能设计

## 概述

为 Projects 板块增加嵌套组支持，允许组内包含子组，最大嵌套深度 3 层。

## 数据模型

### 核心类型变化

用树形结构替代当前的扁平数组：

```typescript
// 树节点：项目ID 或 组
type ProjectTreeItem = string | ProjectGroup;

interface ProjectGroup {
  id: string;
  name: string;
  collapsed: boolean;
  children: ProjectTreeItem[]; // 可包含项目ID和子组
}
```

### AppConfig 变化

```typescript
interface AppConfig {
  projects: ProjectConfig[];        // 不变，项目详情的扁平注册表
  projectTree?: ProjectTreeItem[];  // 新字段，替代 projectGroups + projectOrdering
  // projectGroups 和 projectOrdering 废弃，仅保留用于迁移读取
  defaultShell: string;
  availableShells: ShellConfig[];
  uiFontSize: number;
  terminalFontSize: number;
  layoutSizes?: number[];
}
```

**设计要点：**
- `projects` 数组保持扁平，作为所有项目的注册表，存储 path、savedLayout 等详情
- `projectTree` 只管组织结构和排序，通过项目 ID 引用 `projects` 中的条目
- 旧配置无 `projectTree` 时，自动从 `projectGroups` + `projectOrdering` 迁移
- 若 `projectTree` 和旧字段同时存在（如迁移中途崩溃），`projectTree` 优先，旧字段忽略

## Store 逻辑

### 树操作工具函数

纯函数，不依赖 store：

```typescript
// 计算某个节点在树中的深度（0 = 顶层），未找到返回 -1
function getDepth(tree: ProjectTreeItem[], targetId: string): number

// 从树中移除一个节点（项目ID或组ID），返回被移除的节点
function removeFromTree(tree: ProjectTreeItem[], id: string): ProjectTreeItem | null

// 将节点插入到指定组内（targetGroupId 为 null 表示根级别）
// index 为插入位置索引，省略则追加到末尾
function insertIntoTree(
  tree: ProjectTreeItem[],
  targetGroupId: string | null,
  item: ProjectTreeItem,
  index?: number
): void

// 计算子树占用的额外深度层数（不含自身所在层）
// 项目ID → 0，空组 → 0，含直接项目的组 → 1，含子组的组 → 2
function getSubtreeMaxDepth(item: ProjectTreeItem): number

// 检查 ancestorId 是否是 targetId 的祖先（循环检测）
function isDescendant(tree: ProjectTreeItem[], ancestorId: string, targetId: string): boolean

// 判断拖拽是否合法：无循环 且 目标深度 + 1 + 子树深度 <= 3
function canDrop(
  tree: ProjectTreeItem[],
  targetGroupId: string,
  draggedItem: ProjectTreeItem
): boolean
```

**`getSubtreeMaxDepth` 返回值示例：**

| 节点 | 返回值 |
|---|---|
| 项目 ID（字符串） | 0 |
| 空组 / 只含项目的组 | 1 |
| 含一层子组的组 | 2 |

**深度校验公式：** `targetDepth + 1 + getSubtreeMaxDepth(draggedItem) <= MAX_DEPTH(3)`

- 拖项目到 depth=2 的组内：2 + 1 + 0 = 3 <= 3，允许
- 拖含子组的组到 depth=1：1 + 1 + 2 = 4 > 3，禁止

### Store Actions 变化

| 当前 Action | 变化 |
|---|---|
| `createGroup(name)` | 新增参数 `parentGroupId?`，支持在子组内创建 |
| `removeGroup(groupId)` | 逻辑不变：子项释放到父级，替换原组位置 |
| `renameGroup` / `toggleGroupCollapse` | 不变，在树中递归查找并修改 |
| `moveProjectToGroup` + `moveProjectOutOfGroup` + `reorderItems` | 合并为 `moveItem(itemId, targetGroupId: string \| null, index?: number)`。`targetGroupId` 为 null 表示根级别，`index` 为目标 children 数组中的插入位置，省略则追加到末尾 |

### 渲染列表生成

`getOrderedItems()` 替换为 `getOrderedTree()`：

```typescript
type OrderedItem =
  | { type: 'project'; project: ProjectConfig; depth: number }
  | { type: 'group'; group: ProjectGroup; depth: number };

function getOrderedTree(config: AppConfig): OrderedItem[]
```

递归展平树为带 `depth` 的有序列表，折叠的组不展开 children。

**注意：** `OrderedItem` 的 `group` 变体不再携带 `projects` 数组（旧版有 `projects: ProjectConfig[]`），因为嵌套组的子项通过树结构自身表达。`ProjectList.tsx` 中所有访问 `item.projects` 的代码需要更新。

## 组件与交互

### ProjectList.tsx 变化

**缩进渲染：**
- 每层 depth 增加 16px 左缩进（`paddingLeft: depth * 16`）
- 组图标和项目图标位置随缩进移动

**拖拽增强：**
- 拖拽时计算被拖拽项的子树深度（`getSubtreeMaxDepth`）
- drop 目标是组且在中间 1/3 区域时：
  - 合法：正常蓝色高亮
  - 不合法（超深度）：红色边框 + `cursor: not-allowed`
- 循环检测：组不能拖入自身或自己的子孙组
- 不合法的 drop 静默忽略

**右键菜单增强：**
- "移动到分组" 子菜单：排除自身、子组、超深度的组
- 组右键菜单新增 "新建子组"（仅当前深度 < 3 时显示）

**创建组入口：**
- 底部 "+" 按钮：在顶层创建（不变）
- 组右键菜单 → "新建子组"

## Rust 后端

### config.rs 变化

```rust
// 注意：variant 顺序不可调换！untagged 按声明顺序尝试匹配，
// ProjectId(String) 必须在 Group 之前，否则 JSON 字符串会匹配失败
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ProjectTreeItem {
    ProjectId(String),
    Group(ProjectGroup),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGroup {
    pub id: String,
    pub name: String,
    pub collapsed: bool,
    pub children: Vec<ProjectTreeItem>,
}

// AppConfig 完整变化
pub struct AppConfig {
    pub projects: Vec<ProjectConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_tree: Option<Vec<ProjectTreeItem>>,       // 新字段
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_groups: Option<Vec<ProjectGroup>>,         // 旧字段，仅迁移用
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_ordering: Option<Vec<String>>,             // 旧字段，仅迁移用
    // ... 其余字段不变
}
```

### 配置迁移

- `project_tree` 为空但旧字段有值 → 自动构建 `project_tree`
- 迁移后置空旧字段，下次保存时旧字段自然消失
- 三个字段都为空 → 所有项目作为顶层项

## 边界情况

**配置一致性：**
- `projectTree` 中引用了不存在的项目 ID → 渲染时静默跳过
- `projects` 中有项目但不在 `projectTree` 中 → 追加到顶层末尾
- 删除项目时同时从 `projects` 和 `projectTree` 中移除

**删除组：**
- 子项（项目和子组）释放到父级，保持原有顺序
- 释放位置替换被删除组在父级中的位置
- 删除操作不会导致深度违规：子项提升一层，深度只减不增，无需校验

**拖拽时的深度与循环校验：**
- 拖拽开始时预计算 `getSubtreeMaxDepth` 并缓存到组件 ref 中，避免 dragOver 频繁重算
- `canDrop` 同时检查深度限制和循环引用（`isDescendant`）

## 改动范围

| 层 | 文件 | 改动 |
|---|---|---|
| 类型 | `types.ts` | 新增 `ProjectTreeItem`，改造 `ProjectGroup`，`AppConfig` 替换字段 |
| 逻辑 | `store.ts` | 树操作工具函数，重写分组相关 actions，新 `getOrderedTree()` |
| UI | `ProjectList.tsx` | 缩进渲染、拖拽深度校验、禁止样式、右键菜单增强 |
| 后端 | `config.rs` | `ProjectTreeItem` enum、迁移逻辑、旧字段跳过序列化 |
| 拖拽 | `utils/dragState.ts` | 拖拽状态需配合缓存子树深度 |
