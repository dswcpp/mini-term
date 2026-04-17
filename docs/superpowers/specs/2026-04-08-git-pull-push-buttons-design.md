# Git Pull/Push 按钮设计

## 概述

在 Git History 面板的每个仓库行右侧添加 pull (`↓`) 和 push (`↑`) 操作按钮，hover 时显示，点击后在后台静默执行 git 命令并通过按钮状态反馈结果。

## Rust 后端

在 `src-tauri/src/git.rs` 新增两个 Tauri command：

```rust
#[tauri::command]
pub async fn git_pull(repo_path: String) -> Result<String, String>

#[tauri::command]
pub async fn git_push(repo_path: String) -> Result<String, String>
```

- 通过 `std::process::Command` 在 `repo_path` 目录下执行 `git pull` / `git push`
- 设置 `stdin(Stdio::null())` 防止认证提示阻塞进程
- 成功返回 stdout，失败返回 stderr 作为 `Err(String)`
- 在 `lib.rs` 中注册这两个 command

注意：现有 `git.rs` 使用 git2-rs 做只读操作，pull/push 是首次引入 `std::process::Command`，因为 git2-rs 的认证处理（SSH key / credential helper）配置复杂且平台差异大，直接调用 git CLI 可复用用户已配置的认证方式。Tauri async command 运行在阻塞线程池上，使用 `std::process::Command` 是安全的。

## 前端 UI

### 仓库行布局（GitHistory.tsx）

```
默认：    ▾ repo-name [main]
hover 后：▾ repo-name [main]                    ↓ ↑
```

- 仓库行使用 `display: flex; justify-content: space-between`
- 右侧容器包含 `↓`（pull）和 `↑`（push）两个 Unicode 按钮
- 默认 `opacity: 0`，hover 仓库行时 `opacity: 1`，过渡 150ms
- 按钮颜色 `--text-muted`，hover 按钮时 `--text-primary`
- 点击 `e.stopPropagation()` 防止触发仓库展开/折叠
- 执行期间显示旋转的 `↻` 表示 loading，禁用点击

### 操作反馈（无 toast 组件）

- **执行中**：按钮变为旋转的 `↻`
- **成功**：按钮短暂变为 `✓`（绿色 `--color-success`），1.5 秒后恢复
- **失败**：按钮短暂变为 `✕`（红色 `--color-error`），`title` 属性显示错误信息，1.5 秒后恢复

## 数据流

```
用户 hover 仓库行 → 显示 ↓ ↑ 按钮
点击 ↓ → invoke('git_pull', { repoPath }) → loading
  → 成功：✓ 闪绿 + 刷新 commits 和 branches
  → 失败：✕ 闪红 + title 显示错误
点击 ↑ → invoke('git_push', { repoPath }) → loading
  → 成功：✓ 闪绿 + 刷新 branches（远程分支指针已变）
  → 失败：✕ 闪红 + title 显示错误
```

## 状态管理

- loading 状态用组件内 `useState` 管理（不入全局 store）
- pull 成功后调用 `loadCommits` + `loadBranches` 刷新该仓库
- push 成功后调用 `loadBranches` 刷新远程分支信息
- 同一仓库 pull/push 互斥：任一操作执行中时，两个按钮均禁用

## 边界情况

- **无 remote**：`git pull`/`git push` 会输出错误到 stderr，通过通用失败反馈处理（title 显示错误信息）
- **detached HEAD**：同上，stderr 自然处理
- **认证阻塞**：`stdin(Stdio::null())` 确保不会等待用户输入，认证失败会立即返回错误

## 技术决策

- **git CLI 而非 git2-rs**：git2-rs 认证配置复杂且平台差异大；CLI 复用用户已配置的 SSH key / credential helper，简单可靠。这是对现有 git2-rs 只读模式的有意补充
- **Unicode 字符而非 icon 库**：与项目现有风格一致（`▾` `↻` `✕`）
- **hover 显示而非始终显示**：保持界面简洁
