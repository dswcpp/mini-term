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
  ├── GitHistoryContent.tsx (原有逻辑原样迁移)
  │     └── 仓库选择、分支列表、Commit 历史、Pull/Push
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
- 原有历史相关代码平移到 `GitHistoryContent.tsx`，不改行为
- `GitChanges.tsx` 独立管理自己的状态和刷新逻辑
- 查看 diff 复用现有 `DiffModal.tsx`

## 后端新增命令

现有后端已有 `get_git_status`、`get_git_diff` 可复用，还需新增：

| 命令 | 功能 | 参数 |
|------|------|------|
| `git_stage` | 暂存文件 | `repo_path`, `files: Vec<String>` |
| `git_unstage` | 取消暂存 | `repo_path`, `files: Vec<String>` |
| `git_stage_all` | 暂存全部 | `repo_path` |
| `git_unstage_all` | 取消暂存全部 | `repo_path` |
| `git_commit` | 提交 | `repo_path`, `message: String` |
| `git_discard_file` | 丢弃工作区变更 | `repo_path`, `files: Vec<String>` |

### 实现方式

- 所有命令通过 `git2` crate 实现（项目已有依赖），不走 shell 命令
- stage/unstage 支持批量操作（传文件数组），单文件和全部共用同一命令
- `git_discard_file` 为危险操作，前端需二次确认
- commit 只做最基础的 `git commit -m`，不支持 amend/sign 等高级选项

## 前端数据流与交互

### 刷新机制

- Changes tab 激活时立即调用 `get_git_status` 加载文件列表
- 与现有 FileTree 共享同一个 PTY 输出监听（检测 git 命令执行后自动刷新，防抖 500ms）
- stage/unstage/commit 操作完成后立即刷新列表
- commit 成功后同时刷新 History tab 的 commit 列表（通过回调或事件）

### 交互细节

| 操作 | 行为 |
|------|------|
| 点击文件名 | 打开 DiffModal 查看变更 |
| 点击 `+` 按钮 | stage 该文件 |
| 点击 `−` 按钮 | unstage 该文件 |
| 分组标题的 `↑全部` / `↓全部` | stage all / unstage all |
| 右键文件 | 上下文菜单：查看 Diff / Stage / Unstage / 丢弃修改 |
| 丢弃修改 | 弹确认框后调用 `git_discard_file` |
| Commit 按钮 | message 为空时禁用；提交后清空输入框 |
| 列表/树形切换 | 图标按钮切换，选择状态持久化到 config |

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
| `src/components/GitHistory.tsx` | 退化为 tab 容器，渲染 GitHistoryContent / GitChanges |
| `src/types.ts` | AppConfig 新增 `gitChangesViewMode` 字段 |
| `src-tauri/src/git.rs` | 新增 6 个命令 |
| `src-tauri/src/lib.rs` | 注册新命令 |

### 不动的文件

- `DiffModal.tsx` — 原样复用
- `FileTree.tsx` — 不改，git 状态刷新逻辑各自独立
- `store.ts` — 不加新状态，变更列表由 GitChanges 本地管理
