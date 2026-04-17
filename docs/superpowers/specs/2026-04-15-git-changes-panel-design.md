# Git Changes 面板设计

## 概述

在现有 GitHistory 面板中新增 **Changes** tab，实现类似 VS Code Source Control 的完整变更管理功能，支持暂存/取消暂存、提交、查看 diff，以及平铺列表与树形视图切换。

## 方案选择

**方案：拆分为独立子组件**

将 GitHistory.tsx 退化为纯 tab 容器，原有历史逻辑迁移至 GitHistoryContent.tsx，新增 GitChanges.tsx 独立管理 changes 功能。

选择理由：现有 GitHistory.tsx 已较大，拆分后职责清晰，单文件不膨胀。

## 组件架构

```
GitHistory.tsx (tab 容器)
  ├── 顶部 tab 栏: [History] [Changes]
  ├── 仓库选择器 (从 GitHistoryContent 提升到 tab 容器层，两个 tab 共享)
  ├── GitHistoryContent.tsx (原有逻辑原样迁移)
  │     └── 分支列表、Commit 历史、Pull/Push
  └── GitChanges.tsx (新增)
        ├── 头部工具栏: 刷新 | 列表/树形切换 | 展开/折叠全部
        ├── 文件列表区域 (三个分组，各自可折叠)
        │     ├── Staged Changes (暂存区)
        │     ├── Changes (工作区已修改)
        │     └── Untracked Files (未跟踪)
        ├── 每个文件行: 状态图标 + 路径 + [stage/unstage 按钮] + [点击查看 diff]
        └── 底部提交区域
              ├── commit message textarea (支持多行)
              └── [Commit] 按钮
```

### 关键设计决策

- `GitHistory.tsx` 退化为纯 tab shell，不含业务逻辑
- **仓库选择器提升到 tab 容器层**：当前选中的 `repo_path` 作为 prop 传给两个子 tab，两个 tab 始终操作同一个仓库
- 原有历史相关代码平移到 `GitHistoryContent.tsx`，不改行为
- `GitChanges.tsx` 独立管理自己的状态和刷新逻辑
- 查看 diff 复用现有 `DiffModal.tsx`（需扩展支持 staged diff）

## 后端新增命令

### 新增 `get_changes_status` 命令

现有 `get_git_status` 的 `map_status()` 将 `INDEX_*` 和 `WT_*` 标志合并为单一状态，无法区分 staged/unstaged。Changes 面板需要精确的三区分组，因此**新增专用命令** `get_changes_status`，不修改现有 `get_git_status`（避免影响 FileTree）。

```rust
// 新增返回结构
pub struct ChangeFileStatus {
    pub path: String,
    pub old_path: Option<String>,
    pub staged_status: Option<GitStatus>,   // INDEX 区状态，None 表示不在暂存区
    pub unstaged_status: Option<GitStatus>,  // WT 区状态，None 表示工作区无修改
    pub status_label: String,
}
```

**同一文件可同时出现在 staged 和 unstaged**（部分暂存场景）：`staged_status` 和 `unstaged_status` 可同时非 None。前端根据这两个字段分别在 "Staged Changes" 和 "Changes" 分组中各显示一行。

参数：`repo_path: String`（由 tab 容器层的仓库选择器提供）。

### 扩展 `get_git_diff` 命令

现有 `get_git_diff` 只对比 HEAD vs 工作区。Staged 文件的 diff 需要对比 HEAD vs Index。

**方案**：给 `get_git_diff` 增加 `staged: bool` 参数（默认 false），当 `staged = true` 时对比 HEAD vs Index 而非工作区文件。

### 其他新增命令

| 命令 | 功能 | 参数 | 实现方式 |
|------|------|------|----------|
| `git_stage` | 暂存文件 | `repo_path`, `files: Vec<String>` | git2 `index.add_path()` |
| `git_unstage` | 取消暂存 | `repo_path`, `files: Vec<String>` | git2 `index.remove_path()` + reset to HEAD |
| `git_stage_all` | 暂存全部 | `repo_path` | git2 `index.add_all()` |
| `git_unstage_all` | 取消暂存全部 | `repo_path` | git2 reset index to HEAD |
| `git_commit` | 提交 | `repo_path`, `message: String` | spawn `git commit`（见下方说明） |
| `git_discard_file` | 丢弃变更 | `repo_path`, `files: Vec<String>` | git2 checkout HEAD（见下方说明） |

### 实现方式说明

**stage/unstage**：通过 `git2` crate 操作 index，纯内存操作，性能好且无副作用。

**git_commit**：使用 spawn `git commit -m` 子进程而非 git2 API。理由：
- 与现有 `git_pull`/`git_push` 保持一致（都走 shell 命令）
- 自动触发 git hooks（pre-commit, commit-msg 等），符合用户预期
- 自动读取用户的 git config（user.name/email、GPG 签名等）
- 不支持 amend/sign 等高级选项

**git_discard_file 行为定义**：
| 文件状态 | 行为 |
|----------|------|
| Modified（工作区） | checkout HEAD 版本恢复文件 |
| Deleted（工作区） | checkout HEAD 版本恢复文件 |
| Untracked | 删除文件（`fs::remove_file`） |
| Staged | 先 unstage，再 checkout HEAD 恢复（即完全丢弃所有修改） |
| Conflicted | 不支持，按钮置灰 |

所有 discard 操作前端需二次确认弹框。

## 前端数据流与交互

### 刷新机制

- Changes tab 激活时立即调用 `get_changes_status` 加载文件列表
- 监听 PTY 输出检测 git 操作后自动刷新（防抖 500ms），与 FileTree/GitHistory 各自独立监听（逻辑简单，不需要抽取公共 hook）
- stage/unstage/commit/discard 操作完成后立即刷新列表
- commit 成功后通过回调通知 GitHistory tab 容器，触发 History 刷新 commit 列表

### 交互细节

| 操作 | 行为 |
|------|------|
| 点击文件名 | 打开 DiffModal 查看变更（staged 文件传 `staged=true`） |
| 点击 `+` 按钮 | stage 该文件 |
| 点击 `−` 按钮 | unstage 该文件 |
| 分组标题的 `↑全部` / `↓全部` | stage all / unstage all |
| 右键文件 | 上下文菜单：查看 Diff / Stage / Unstage / 丢弃修改 |
| 丢弃修改 | 弹确认框后调用 `git_discard_file` |
| Commit 按钮 | message 为空时禁用；staged 为空时禁用；提交后清空输入框 |
| 列表/树形切换 | 图标按钮切换，选择状态持久化到 config |

### 树形视图说明

树形视图按目录层级折叠展示文件，但**操作粒度仍为单文件**（不支持按目录批量 stage/unstage）。目录节点仅作为折叠容器，无操作按钮。按目录操作作为后续迭代考虑。

### 空状态

- 无变更时显示 "No changes" 文案 + 图标
- 某个分组为空时该分组隐藏（不显示 "0 files"）

### 状态管理

- 变更文件列表作为 `GitChanges` 组件的本地 state，不放入全局 store
- 列表/树形视图偏好存入 `AppConfig`（新增 `gitChangesViewMode: 'list' | 'tree'` 字段）

## 文件改动清单

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/components/GitChanges.tsx` | Changes 面板主组件 |
| `src/components/GitHistoryContent.tsx` | 从 GitHistory.tsx 迁出的历史逻辑 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `src/components/GitHistory.tsx` | 退化为 tab 容器，仓库选择器提升到此层，渲染 GitHistoryContent / GitChanges |
| `src/components/DiffModal.tsx` | 支持 `staged` prop，传递给 `get_git_diff` |
| `src/types.ts` | AppConfig 新增 `gitChangesViewMode` 字段；新增 `ChangeFileStatus` 类型 |
| `src-tauri/src/git.rs` | 新增 `get_changes_status` + 6 个操作命令；`get_git_diff` 增加 `staged` 参数 |
| `src-tauri/src/lib.rs` | 注册新命令 |
| `src-tauri/src/config.rs` | `AppConfig` struct 新增 `git_changes_view_mode` 字段（`#[serde(default)]`） |

### 不动的文件

- `FileTree.tsx` — 不改，继续使用 `get_git_status`
- `store.ts` — 不加新状态，变更列表由 GitChanges 本地管理
