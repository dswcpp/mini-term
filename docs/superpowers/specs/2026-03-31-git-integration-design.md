# Git 集成功能设计

## 概述

为 mini-term 的文件树集成只读 Git 状态显示和 diff 查看功能。用户可在文件树中直观看到哪些文件被修改，点击后通过 Modal 弹窗查看变更对比。

## 需求

- 文件树中显示 Git 变更状态标记（M/A/D/R/?/C）
- 点击变更文件或右键菜单"查看变更"打开 Diff Modal
- Diff 支持并排（Side-by-side）和内联（Unified）两种视图，可切换
- 显示范围：工作区变更（unstaged + staged 合并显示，不区分），即 `git status` 可见内容
- 只读查看，不提供 stage/commit 等操作
- 支持多仓库发现：项目根目录非 git 仓库时，自动扫描直接子目录

## 设计决策

- **staged/unstaged 合并**：git2 区分 `INDEX_*`（staged）和 `WT_*`（unstaged），本设计合并为同一状态。因为功能定位为只读查看，不提供 stage 操作，区分没有实际意义。
- **嵌套仓库**：当 project_path 本身是 git 仓库时，不再扫描子目录。submodule 的变更由父仓库的 status 自然反映。
- **git status 缓存位置**：放在 FileTree 组件内 useState 中，因为只有文件树使用此数据。
- **样式实现**：DiffModal 使用内联 Tailwind 类 + CSS 变量（复用 styles.css 中已有的 Warm Carbon 主题变量），不新增全局样式类。

## 技术方案

使用 Rust `git2` crate（libgit2 绑定）在后端读取 Git 数据，前端渲染状态和 diff。

## 后端设计（Rust）

### 新增文件：`src-tauri/src/git.rs`

**依赖：** `git2` crate

### 数据结构

```rust
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub enum GitStatus {
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
    Conflicted,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    pub path: String,              // 相对于项目根目录
    pub old_path: Option<String>,  // 仅 Renamed 状态有值
    pub status: GitStatus,
    pub status_label: String,      // "M", "A", "D", "R", "?", "C"
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: String,     // "add", "delete", "context"
    pub content: String,
    pub old_lineno: Option<u32>,
    pub new_lineno: Option<u32>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffResult {
    pub old_content: String,
    pub new_content: String,
    pub hunks: Vec<DiffHunk>,
    pub is_binary: bool,       // true 时前端显示"二进制文件不支持预览"
    pub too_large: bool,       // true 时前端显示"文件过大，不支持预览"
}
```

### Tauri 命令

**`get_git_status(project_path: String) -> Result<Vec<GitFileStatus>, String>`**

1. 尝试以 `project_path` 打开 git 仓库（使用 `Repository::discover`，可处理子目录指向仓库的情况）
2. 若失败，扫描 `project_path` 的直接子目录（1 层深），对每个子目录尝试 `Repository::discover`
3. 对每个发现的仓库，调用 `repo.statuses()` 获取变更文件列表
4. 合并 staged（`INDEX_*`）和 unstaged（`WT_*`）状态为统一的 GitStatus
5. 将所有文件路径统一转为相对于 `project_path` 的路径
6. 返回合并后的 `Vec<GitFileStatus>`

**错误场景**：目录不存在、无读权限。返回 `Err(String)` 描述错误。

**`get_git_diff(project_path: String, file_path: String) -> Result<GitDiffResult, String>`**

1. 使用 `Repository::discover(file_path 的绝对路径)` 定位所属 git 仓库
2. 检测文件是否为二进制（`blob.is_binary()`），若是则设 `is_binary = true`，内容留空
3. 检测文件大小，超过 1MB 则设 `too_large = true`，内容留空
4. 使用 `git2` 获取文件的 HEAD 版本（旧内容）和工作区版本（新内容），以 UTF-8 解码（失败则视为二进制）
5. 使用 `git2::Diff` 生成 hunk 信息
6. 对于新增/未跟踪文件，旧内容为空；对于删除文件，新内容为空
7. 空仓库（无 commit）时，所有文件视为新增，旧内容为空
8. 返回 `GitDiffResult`

**错误场景**：文件不存在、无法定位仓库、读取失败。返回 `Err(String)` 描述错误。

### 仓库发现逻辑

```
get_git_status(project_path):
  if Repository::discover(project_path) 成功:
    返回该仓库的 status（不再扫描子目录）
  else:
    repos = []
    for dir in project_path 的直接子目录:
      if Repository::discover(dir) 成功:
        repos.push(dir)
    for repo in repos:
      收集 status，路径前缀加上子目录名
    返回合并结果

get_git_diff(project_path, file_path):
  abs_path = project_path + "/" + file_path
  repo = Repository::discover(abs_path)  // 自动向上查找仓库
  // 用 discover 结果定位仓库，比手动判断更可靠
```

## 前端设计

### 文件树增强（修改 `FileTree.tsx`）

**状态获取：**
- 项目切换或文件树首次加载时调用 `get_git_status`（独立 `useEffect`，依赖 `project?.path`）
- 用 `useState<Map<string, GitFileStatus>>` 缓存结果
- 收到 `fs-change` 事件后 500ms 防抖刷新
- 补充：监听 `pty-output` 事件，启发式检测 git 命令反馈，匹配模式如 `create mode`、`Switched to`、`Already up to date`、`insertions(+)`、`deletions(-)`。即使误触发也仅多一次 status 刷新（500ms 防抖内合并），开销可接受

**TreeNode 渲染：**
- 文件名右侧追加状态字母标记（M/A/D/R/?/C），小字号灰色
- 父文件夹聚合子文件状态，显示最高优先级标记

**交互入口：**
- 点击有变更标记的文件 → 打开 DiffModal
- 右键菜单新增"查看变更"选项（仅对有变更的文件显示）

**无 Git 仓库：**
- `get_git_status` 返回空数组 → 文件树正常显示，无额外标记

### 新增组件：`DiffModal.tsx`

**Props 接口：**
```typescript
interface DiffModalProps {
  open: boolean;
  onClose: () => void;
  projectPath: string;
  status: GitFileStatus;  // 文件路径从 status.path 获取
}
```

遵循 SettingsModal 的模式：外层 overlay `onClick={onClose}`，内层 `e.stopPropagation()`。

**布局：**
- 全屏 Modal（90vw x 80vh），居中显示
- ESC 或点击背景关闭
- 配色沿用项目 Warm Carbon 主题

**顶部工具栏：**
- 左侧：文件名 + 状态标记（M/A/D/R/?/C）
- 右侧：并排/内联切换按钮

**并排视图（Side-by-side）：**
- 左右两栏，左旧右新
- 删除行：红色背景高亮
- 新增行：绿色背景高亮
- 行号显示

**内联视图（Unified）：**
- 单栏显示
- 删除行以 `-` 标记 + 红色高亮
- 新增行以 `+` 标记 + 绿色高亮
- 上下文行显示行号

**特殊状态处理：**
- `is_binary` 为 true：显示"二进制文件，不支持 diff 预览"
- `too_large` 为 true：显示"文件过大（>1MB），不支持 diff 预览"

### 类型定义（修改 `types.ts`）

新增前端类型，与后端 `serde(rename_all = "camelCase")` 对齐：
- `GitStatus`
- `GitFileStatus`（含 `oldPath?: string`）
- `DiffHunk`
- `DiffLine`
- `GitDiffResult`（含 `isBinary`、`tooLarge`）

## 数据流

```
项目切换 / 文件树加载
  → invoke('get_git_status', projectPath)
  → 返回 Vec<GitFileStatus>
  → FileTree useState 缓存，TreeNode 渲染标记

文件变更 (fs-change 事件) / 终端 git 命令检测
  → 500ms 防抖
  → 重新调用 get_git_status 刷新

点击变更文件 / 右键"查看变更"
  → invoke('get_git_diff', projectPath, filePath)
  → 返回 GitDiffResult
  → 打开 DiffModal，渲染并排或内联视图
  → 若 is_binary / too_large 则显示提示信息
```

## 边界情况

| 场景 | 处理方式 |
|------|---------|
| 项目无 git 仓库 | `get_git_status` 返回空数组，文件树正常显示 |
| 空仓库（无 commit） | 所有文件视为 Added，diff 旧内容为空 |
| 二进制文件 | `is_binary = true`，DiffModal 显示提示 |
| 大文件（>1MB） | `too_large = true`，DiffModal 显示提示 |
| 非 UTF-8 编码文件 | 解码失败视为二进制处理 |
| Renamed 文件 | `old_path` 记录旧路径，diff 显示旧→新 |
| Conflicted 文件 | 正常显示 diff（包含冲突标记 `<<<<<<<` 等），不做特殊解析 |
| 嵌套仓库/submodule | 根目录是 git 仓库时不扫描子目录 |
| 深层目录变更未触发 fs-change | 通过 pty-output 启发式检测补充刷新 |
| DiffModal 加载中 | 打开后显示 loading spinner，数据返回后切换为 diff 视图 |
| 文件夹状态聚合优先级 | C > D > M > A > R > ?（冲突和删除最高优先） |

## 文件变更清单

### 新增文件

| 文件 | 类型 | 职责 |
|------|------|------|
| `src-tauri/src/git.rs` | Rust | git2 仓库发现、status、diff |
| `src/components/DiffModal.tsx` | React | Diff 弹窗组件（并排+内联切换） |

### 修改文件

| 文件 | 改动 |
|------|------|
| `src-tauri/src/lib.rs` | 添加 `mod git;`，注册 `get_git_status`、`get_git_diff` 命令 |
| `src-tauri/Cargo.toml` | 添加 `git2` 依赖 |
| `src/components/FileTree.tsx` | 加载 git status、传递给 TreeNode、右键菜单增加"查看变更"、点击打开 DiffModal |
| `src/components/App.tsx` | 无需修改——DiffModal 由 FileTree 内部控制 open 状态，挂载在 FileTree 组件内 |
| `src/types.ts` | 新增 Git 相关类型定义 |
