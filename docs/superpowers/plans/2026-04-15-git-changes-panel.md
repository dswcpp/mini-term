# Git Changes 面板实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 GitHistory 面板中新增 Changes tab，支持查看变更文件、stage/unstage、commit 和 diff 查看。

**Architecture:** GitHistory.tsx 退化为 tab 容器，原有历史逻辑迁入 GitHistoryContent.tsx，新增 GitChanges.tsx。后端新增 `get_changes_status` 和 6 个 git 操作命令。DiffModal 扩展支持 staged diff。

**Tech Stack:** Rust (git2 crate + git CLI), React 19, TypeScript, Tailwind CSS v4

**Spec:** `docs/superpowers/specs/2026-04-15-git-changes-panel-design.md`

---

## 文件结构

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/components/GitChanges.tsx` | Changes 面板主组件 |
| `src/components/GitHistoryContent.tsx` | 从 GitHistory.tsx 迁出的历史逻辑 |

### 修改文件

| 文件 | 改动范围 |
|------|----------|
| `src-tauri/src/git.rs` | 新增 `ChangeFileStatus` 结构体 + 7 个命令 |
| `src-tauri/src/config.rs:34-62` | `AppConfig` 新增 `git_changes_view_mode` 字段 |
| `src-tauri/src/lib.rs:28-54` | 注册 7 个新命令 |
| `src/types.ts:12-29` | `AppConfig` 新增字段；新增 `ChangeFileStatus` 类型 |
| `src/components/GitHistory.tsx` | 退化为 tab 容器 |
| `src/components/DiffModal.tsx:5-9,148-161` | 新增 `staged` / `repoPath` prop |

---

### Task 1: 后端 — `ChangeFileStatus` 结构体和 `get_changes_status` 命令

**Files:**
- Modify: `src-tauri/src/git.rs`

- [ ] **Step 1: 在 git.rs 数据结构区域新增 `ChangeFileStatus`**

在 `GitFileStatus` 结构体之后（第 28 行后）添加：

```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChangeFileStatus {
    pub path: String,
    pub old_path: Option<String>,
    pub staged_status: Option<GitStatus>,
    pub unstaged_status: Option<GitStatus>,
    pub status_label: String,
}
```

- [ ] **Step 2: 新增 `map_staged_status` 和 `map_unstaged_status` 辅助函数**

在 `map_status` 函数之后添加两个独立的映射函数：

```rust
fn map_staged_status(status: Status) -> Option<GitStatus> {
    if status.contains(Status::CONFLICTED) {
        return Some(GitStatus::Conflicted);
    }
    if status.contains(Status::INDEX_RENAMED) {
        return Some(GitStatus::Renamed);
    }
    if status.contains(Status::INDEX_NEW) {
        return Some(GitStatus::Added);
    }
    if status.contains(Status::INDEX_MODIFIED) {
        return Some(GitStatus::Modified);
    }
    if status.contains(Status::INDEX_DELETED) {
        return Some(GitStatus::Deleted);
    }
    None
}

fn map_unstaged_status(status: Status, is_empty_repo: bool) -> Option<GitStatus> {
    if status.contains(Status::CONFLICTED) {
        return Some(GitStatus::Conflicted);
    }
    if status.contains(Status::WT_RENAMED) {
        return Some(GitStatus::Renamed);
    }
    if status.contains(Status::WT_MODIFIED) {
        return Some(GitStatus::Modified);
    }
    if status.contains(Status::WT_DELETED) {
        return Some(GitStatus::Deleted);
    }
    if status.contains(Status::WT_NEW) {
        if is_empty_repo {
            return Some(GitStatus::Added);
        } else {
            return Some(GitStatus::Untracked);
        }
    }
    None
}
```

- [ ] **Step 3: 新增 `get_changes_status` 命令**

在 `get_git_status` 之后添加：

```rust
#[tauri::command]
pub fn get_changes_status(repo_path: String) -> Result<Vec<ChangeFileStatus>, String> {
    let path = Path::new(&repo_path);
    let repo = Repository::open(path).map_err(|e| e.to_string())?;
    let is_empty_repo = repo.head().is_err();

    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);

    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;
    let mut result = Vec::new();

    for entry in statuses.iter() {
        let raw_path = entry.path().unwrap_or("").to_string();
        let s = entry.status();

        let staged = map_staged_status(s);
        let unstaged = map_unstaged_status(s, is_empty_repo);

        if staged.is_none() && unstaged.is_none() {
            continue;
        }

        // status_label: 优先显示 staged 的标签，否则 unstaged
        let label = staged
            .as_ref()
            .or(unstaged.as_ref())
            .map(status_label)
            .unwrap_or("")
            .to_string();

        let old_path = if s.contains(Status::INDEX_RENAMED) || s.contains(Status::WT_RENAMED) {
            entry.head_to_index().and_then(|d| {
                d.old_file()
                    .path()
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
            })
        } else {
            None
        };

        result.push(ChangeFileStatus {
            path: raw_path,
            old_path,
            staged_status: staged,
            unstaged_status: unstaged,
            status_label: label,
        });
    }

    Ok(result)
}
```

- [ ] **Step 4: 验证编译**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`
Expected: 无错误（有 dead_code 警告是正常的，命令尚未注册）

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/git.rs
git commit -m "feat: 新增 get_changes_status 命令，区分 staged/unstaged/untracked 文件状态"
```

---

### Task 2: 后端 — stage/unstage 命令

**Files:**
- Modify: `src-tauri/src/git.rs`

- [ ] **Step 1: 新增 `git_stage` 命令**

在 `git_push` 之后添加：

```rust
#[tauri::command]
pub fn git_stage(repo_path: String, files: Vec<String>) -> Result<(), String> {
    let repo = Repository::open(Path::new(&repo_path)).map_err(|e| e.to_string())?;
    let mut index = repo.index().map_err(|e| e.to_string())?;
    for file in &files {
        let path = Path::new(file);
        let abs_path = repo.workdir().ok_or("bare repo")?.join(path);
        if abs_path.exists() {
            index.add_path(path).map_err(|e| e.to_string())?;
        } else {
            // 文件已删除，需要从 index 移除
            index.remove_path(path).map_err(|e| e.to_string())?;
        }
    }
    index.write().map_err(|e| e.to_string())?;
    Ok(())
}
```

- [ ] **Step 2: 新增 `git_unstage` 命令**

```rust
#[tauri::command]
pub fn git_unstage(repo_path: String, files: Vec<String>) -> Result<(), String> {
    let repo = Repository::open(Path::new(&repo_path)).map_err(|e| e.to_string())?;

    let head = match repo.head() {
        Ok(h) => Some(h.peel_to_commit().map_err(|e| e.to_string())?),
        Err(_) => None, // empty repo, no HEAD
    };

    if let Some(ref commit) = head {
        for file in &files {
            repo.reset_default(Some(commit.as_object()), [file.as_str()])
                .map_err(|e| e.to_string())?;
        }
    } else {
        // empty repo: 批量从 index 移除，最后一次 write
        let mut index = repo.index().map_err(|e| e.to_string())?;
        for file in &files {
            index.remove_path(Path::new(file)).map_err(|e| e.to_string())?;
        }
        index.write().map_err(|e| e.to_string())?;
    }
    Ok(())
}
```

- [ ] **Step 3: 新增 `git_stage_all` 和 `git_unstage_all` 命令**

```rust
#[tauri::command]
pub fn git_stage_all(repo_path: String) -> Result<(), String> {
    let repo = Repository::open(Path::new(&repo_path)).map_err(|e| e.to_string())?;
    let mut index = repo.index().map_err(|e| e.to_string())?;
    index
        .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
        .map_err(|e| e.to_string())?;

    // 处理已删除的文件：遍历 index，移除工作区中不存在的文件
    let workdir = repo.workdir().ok_or("bare repo")?;
    let entries: Vec<String> = index
        .iter()
        .filter_map(|e| {
            let path = String::from_utf8_lossy(&e.path).to_string();
            if !workdir.join(&path).exists() {
                Some(path)
            } else {
                None
            }
        })
        .collect();
    for path in entries {
        index.remove_path(Path::new(&path)).map_err(|e| e.to_string())?;
    }

    index.write().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn git_unstage_all(repo_path: String) -> Result<(), String> {
    let repo = Repository::open(Path::new(&repo_path)).map_err(|e| e.to_string())?;

    match repo.head() {
        Ok(head) => {
            let commit = head.peel_to_commit().map_err(|e| e.to_string())?;
            repo.reset(commit.as_object(), git2::ResetType::Mixed, None)
                .map_err(|e| e.to_string())?;
        }
        Err(_) => {
            // empty repo: 清空整个 index
            let mut index = repo.index().map_err(|e| e.to_string())?;
            index.clear().map_err(|e| e.to_string())?;
            index.write().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
```

- [ ] **Step 4: 验证编译**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/git.rs
git commit -m "feat: 新增 git_stage/git_unstage/git_stage_all/git_unstage_all 命令"
```

---

### Task 3: 后端 — commit 和 discard 命令

**Files:**
- Modify: `src-tauri/src/git.rs`

- [ ] **Step 1: 新增 `git_commit` 命令（使用 spawn 子进程）**

```rust
#[tauri::command]
pub fn git_commit(repo_path: String, message: String) -> Result<String, String> {
    let repo = Path::new(&repo_path);
    if !repo.is_dir() {
        return Err(format!("不是有效目录:{}", repo_path));
    }
    if !repo.join(".git").exists() {
        return Err(format!("不是 git 仓库(缺少 .git):{}", repo_path));
    }

    let output = std::process::Command::new("git")
        .args(["commit", "-m", &message])
        .current_dir(&repo_path)
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("启动 git commit 失败:{}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}
```

- [ ] **Step 2: 新增 `git_discard_file` 命令**

```rust
#[tauri::command]
pub fn git_discard_file(repo_path: String, files: Vec<String>) -> Result<(), String> {
    let repo = Repository::open(Path::new(&repo_path)).map_err(|e| e.to_string())?;
    let workdir = repo.workdir().ok_or("bare repo")?.to_path_buf();

    for file in &files {
        let abs_path = workdir.join(file);

        // 检查是否 untracked (WT_NEW)
        let mut opts = StatusOptions::new();
        opts.pathspec(file);
        let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;
        let is_untracked = statuses.iter().any(|e| e.status().contains(Status::WT_NEW));

        if is_untracked {
            // untracked: 直接删除文件
            if abs_path.exists() {
                std::fs::remove_file(&abs_path).map_err(|e| e.to_string())?;
            }
        } else {
            // tracked: 先 unstage（如果在暂存区），再 checkout HEAD 版本
            let head = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
            if let Some(ref commit) = head {
                // unstage
                let _ = repo.reset_default(Some(commit.as_object()), [file.as_str()]);
            }
            // checkout from HEAD
            repo.checkout_head(Some(
                git2::build::CheckoutBuilder::new()
                    .force()
                    .path(file),
            ))
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
```

- [ ] **Step 3: 验证编译**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`

- [ ] **Step 4: 提交**

```bash
git add src-tauri/src/git.rs
git commit -m "feat: 新增 git_commit（spawn 子进程）和 git_discard_file 命令"
```

---

### Task 4: 后端 — 扩展 `get_git_diff` 支持 staged diff + 注册所有新命令

**Files:**
- Modify: `src-tauri/src/git.rs:736`
- Modify: `src-tauri/src/config.rs:34-62`
- Modify: `src-tauri/src/lib.rs:28-54`

- [ ] **Step 1: 给 `get_git_diff` 增加 `staged` 参数**

修改 `get_git_diff` 函数签名和实现。当 `staged=true` 时，读 index 中的内容作为 new_content，而非工作区文件：

```rust
#[tauri::command]
pub fn get_git_diff(
    project_path: String,
    file_path: String,
    staged: Option<bool>,
) -> Result<GitDiffResult, String> {
    let project = Path::new(&project_path);
    let abs_file = project.join(&file_path);

    let repo = Repository::discover(&abs_file).map_err(|e| e.to_string())?;
    let workdir = repo
        .workdir()
        .ok_or("bare repository not supported")?;

    let rel_path = diff_paths(&abs_file, workdir)
        .ok_or("file is outside repository working directory")?;
    let rel_str = rel_path.to_string_lossy().replace('\\', "/");

    let is_staged = staged.unwrap_or(false);

    // Read new content: from index (staged) or working tree (unstaged)
    let new_content = if is_staged {
        let index = repo.index().map_err(|e| e.to_string())?;
        match index.get_path(Path::new(&rel_str), 0) {
            Some(entry) => {
                let blob = repo.find_blob(entry.id).map_err(|e| e.to_string())?;
                if blob.is_binary() {
                    return Ok(GitDiffResult {
                        old_content: String::new(),
                        new_content: String::new(),
                        hunks: Vec::new(),
                        is_binary: true,
                        too_large: false,
                    });
                }
                if blob.content().len() > 1_048_576 {
                    return Ok(GitDiffResult {
                        old_content: String::new(),
                        new_content: String::new(),
                        hunks: Vec::new(),
                        is_binary: false,
                        too_large: true,
                    });
                }
                std::str::from_utf8(blob.content())
                    .map_err(|_| "binary".to_string())?
                    .to_string()
            }
            None => String::new(),
        }
    } else {
        let new_bytes = std::fs::read(&abs_file).map_err(|e| e.to_string())?;
        if new_bytes.len() > 1_048_576 {
            return Ok(GitDiffResult {
                old_content: String::new(),
                new_content: String::new(),
                hunks: Vec::new(),
                is_binary: false,
                too_large: true,
            });
        }
        match std::str::from_utf8(&new_bytes) {
            Ok(s) => s.to_string(),
            Err(_) => {
                return Ok(GitDiffResult {
                    old_content: String::new(),
                    new_content: String::new(),
                    hunks: Vec::new(),
                    is_binary: true,
                    too_large: false,
                })
            }
        }
    };

    let old_content = match get_head_content(&repo, &rel_str)? {
        None => String::new(),
        Some(s) => s,
    };

    let old_lines: Vec<&str> = old_content.lines().collect();
    let new_lines_vec: Vec<&str> = new_content.lines().collect();

    let ol = old_lines.len() as u64;
    let nl = new_lines_vec.len() as u64;

    let hunks = if ol * nl > 10_000_000 {
        full_replace_diff(&old_content, &new_content)
    } else {
        build_hunks(&old_lines, &new_lines_vec)
    };

    Ok(GitDiffResult {
        old_content,
        new_content,
        hunks,
        is_binary: false,
        too_large: false,
    })
}
```

- [ ] **Step 2: config.rs 新增 `git_changes_view_mode` 字段**

在 `AppConfig` struct 的 `vscode_path` 字段之后添加：

```rust
    #[serde(default = "default_git_changes_view_mode")]
    pub git_changes_view_mode: String,
```

添加默认值函数：

```rust
fn default_git_changes_view_mode() -> String {
    "list".into()
}
```

在 `Default for AppConfig` impl 中添加：

```rust
            git_changes_view_mode: default_git_changes_view_mode(),
```

- [ ] **Step 3: lib.rs 注册所有新命令**

在 `invoke_handler` 的 `git::git_push` 之后添加：

```rust
            git::get_changes_status,
            git::git_stage,
            git::git_unstage,
            git::git_stage_all,
            git::git_unstage_all,
            git::git_commit,
            git::git_discard_file,
```

- [ ] **Step 4: 验证编译**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`
Expected: 编译通过

- [ ] **Step 5: 运行 Rust 测试**

Run: `cd src-tauri && cargo test 2>&1 | tail -10`
Expected: 所有测试通过（config 序列化测试需要兼容新字段）

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/git.rs src-tauri/src/config.rs src-tauri/src/lib.rs
git commit -m "feat: get_git_diff 支持 staged 参数；注册所有 changes 相关命令；config 新增 gitChangesViewMode"
```

---

### Task 5: 前端 — 类型定义

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: 新增 `ChangeFileStatus` 类型**

在 `GitFileStatus` 接口之后（第 153 行后）添加：

```typescript
export interface ChangeFileStatus {
  path: string;
  oldPath?: string;
  stagedStatus?: GitStatusType;
  unstagedStatus?: GitStatusType;
  statusLabel: string;
}
```

- [ ] **Step 2: `AppConfig` 新增字段**

在 `vscodePath` 之后添加：

```typescript
  gitChangesViewMode: 'list' | 'tree';
```

- [ ] **Step 3: 提交**

```bash
git add src/types.ts
git commit -m "feat: 新增 ChangeFileStatus 类型，AppConfig 新增 gitChangesViewMode 字段"
```

---

### Task 6: 前端 — 重构 GitHistory 为 tab 容器（仓库选择器提升）

**Files:**
- Create: `src/components/GitHistoryContent.tsx`
- Modify: `src/components/GitHistory.tsx`

- [ ] **Step 1: 创建 `GitHistoryContent.tsx`**

将 `GitHistory.tsx` 的全部内容复制到 `GitHistoryContent.tsx`，做以下修改：

**组件签名改为接收 props：**

```typescript
interface GitHistoryContentProps {
  projectPath: string;
  repos: GitRepoInfo[];        // 从容器层传入，不再自行 discover
  refreshRepos: () => void;    // 通知容器刷新仓库列表
}

export function GitHistoryContent({ projectPath, repos, refreshRepos }: GitHistoryContentProps) {
```

**需要修改的部分：**
- 删除 `useAppStore` 获取 project 的逻辑（改为从 props.projectPath 获取）
- 删除 `loadRepos` + `repos` 状态 + `discover_git_repos` 调用（改为从 props.repos 获取）
- 删除顶部面板标题栏（"Git History" 标题区域，第 529-546 行），由外层容器 tab 栏替代
- 删除 "选择一个项目" 空状态判断（第 519-525 行），由外层容器处理
- `debouncedRefresh` 中原来调用 `loadRepos()` 的地方改为 `refreshRepos()`
- 保留 `GitActionButton`、`buildRepoTree`、`RepoTreeNode` 等辅助类型和组件（它们只在此组件使用）
- **保留所有业务逻辑**（expandedRepos、repoStates、commits 加载、branches、pull/push、PTY 监听、CommitDiffModal、自动展开等），不改行为

- [ ] **Step 2: 改造 `GitHistory.tsx` 为 tab 容器（含共享仓库选择器）**

清空原有内容，改为：

```typescript
import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store';
import { GitHistoryContent } from './GitHistoryContent';
import { GitChanges } from './GitChanges';
import type { GitRepoInfo } from '../types';

type GitTab = 'history' | 'changes';

export function GitHistory() {
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const config = useAppStore((s) => s.config);
  const project = config.projects.find((p) => p.id === activeProjectId);

  const [activeTab, setActiveTab] = useState<GitTab>('history');

  // 仓库选择器状态 — 提升到容器层，两个 tab 共享
  const [repos, setRepos] = useState<GitRepoInfo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string>('');

  const loadRepos = useCallback(() => {
    if (!project) return;
    invoke<GitRepoInfo[]>('discover_git_repos', { projectPath: project.path })
      .then((r) => {
        setRepos(r);
        setSelectedRepo((prev) => {
          // 保持选中；若之前选中的已消失则选第一个
          if (prev && r.some((repo) => repo.path === prev)) return prev;
          return r.length > 0 ? r[0].path : '';
        });
      })
      .catch(() => setRepos([]));
  }, [project?.path]);

  useEffect(() => {
    loadRepos();
  }, [loadRepos]);

  // commit 成功后 Changes tab 通过此回调通知容器，容器 key 变化触发 History 重新加载
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const onCommitSuccess = useCallback(() => {
    setHistoryRefreshKey((k) => k + 1);
  }, []);

  if (!project) {
    return (
      <div className="h-full bg-[var(--bg-surface)] flex items-center justify-center text-[var(--text-muted)] text-base">
        选择一个项目
      </div>
    );
  }

  return (
    <div className="h-full bg-[var(--bg-surface)] flex flex-col border-t border-[var(--border-subtle)]">
      {/* Tab 栏 */}
      <div className="flex items-center gap-0 px-3 pt-2 pb-0 flex-shrink-0">
        {(['history', 'changes'] as const).map((tab) => (
          <button
            key={tab}
            className={`px-3 py-1.5 text-sm font-medium transition-colors border-b-2 ${
              activeTab === tab
                ? 'text-[var(--accent)] border-[var(--accent)]'
                : 'text-[var(--text-muted)] border-transparent hover:text-[var(--text-primary)]'
            }`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'history' ? 'History' : 'Changes'}
          </button>
        ))}
      </div>

      {/* 仓库选择器（多仓库时显示，两个 tab 共享） */}
      {repos.length > 1 && (
        <div className="px-3 pt-2 pb-0 flex-shrink-0">
          <select
            className="w-full text-sm bg-[var(--bg-base)] text-[var(--text-primary)] border border-[var(--border-default)] rounded px-2 py-1"
            value={selectedRepo}
            onChange={(e) => setSelectedRepo(e.target.value)}
          >
            {repos.map((r) => (
              <option key={r.path} value={r.path}>
                {r.name} {r.currentBranch ? `(${r.currentBranch})` : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Tab 内容 */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'history' ? (
          <GitHistoryContent
            key={historyRefreshKey}
            projectPath={project.path}
            repos={repos}
            refreshRepos={loadRepos}
          />
        ) : (
          <GitChanges
            projectPath={project.path}
            repoPath={selectedRepo}
            onCommitSuccess={onCommitSuccess}
          />
        )}
      </div>
    </div>
  );
}
```

注意：此时 `GitChanges` 组件尚未创建，先创建一个占位：

```typescript
// src/components/GitChanges.tsx (临时占位)
export function GitChanges({ projectPath, repoPath, onCommitSuccess }: {
  projectPath: string;
  repoPath: string;
  onCommitSuccess: () => void;
}) {
  return (
    <div className="h-full flex items-center justify-center text-[var(--text-muted)] text-sm">
      Changes — {repoPath || projectPath}
    </div>
  );
}
```

- [ ] **Step 3: 验证前端编译**

Run: `cd D:/Git/mini-term && npx tsc --noEmit 2>&1 | tail -10`

- [ ] **Step 4: 提交**

```bash
git add src/components/GitHistoryContent.tsx src/components/GitHistory.tsx src/components/GitChanges.tsx
git commit -m "refactor: GitHistory 拆分为 tab 容器 + GitHistoryContent，仓库选择器提升到容器层共享"
```

---

### Task 7: 前端 — 实现 GitChanges 组件

**Files:**
- Modify: `src/components/GitChanges.tsx`

这是最大的 Task，分多步实现。

- [ ] **Step 1: 基础结构 — 加载和展示变更文件列表**

实现核心状态、加载逻辑。注意 `repoPath` 从容器层 props 获取（不自行 discover）：

```typescript
import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store';
import { useTauriEvent } from '../hooks/useTauriEvent';
import { showContextMenu } from '../utils/contextMenu';
import { DiffModal } from './DiffModal';
import type { ChangeFileStatus, PtyOutputPayload } from '../types';

interface GitChangesProps {
  projectPath: string;
  repoPath: string;            // 从 GitHistory 容器层获取，与 History tab 共享
  onCommitSuccess: () => void;  // 通知容器刷新 History tab
}

const GIT_REFRESH_PATTERNS = [
  /create mode/,
  /Switched to/,
  /Already up to date/,
  /insertions?\(\+\)/,
  /deletions?\(-\)/,
];

export function GitChanges({ projectPath, repoPath, onCommitSuccess }: GitChangesProps) {
  const config = useAppStore((s) => s.config);
  const setConfig = useAppStore((s) => s.setConfig);

  // 变更文件列表
  const [changes, setChanges] = useState<ChangeFileStatus[]>([]);
  const [loading, setLoading] = useState(false);

  // 视图模式
  const viewMode = config.gitChangesViewMode ?? 'list';

  // commit
  const [commitMsg, setCommitMsg] = useState('');
  const [committing, setCommitting] = useState(false);

  // diff modal
  const [diffModal, setDiffModal] = useState<{
    open: boolean;
    filePath: string;
    staged: boolean;
    statusLabel: string;
  } | null>(null);

  // 折叠状态（树形视图用）
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());

  // 分组
  const staged = changes.filter((c) => c.stagedStatus);
  const unstaged = changes.filter((c) => c.unstagedStatus && c.unstagedStatus !== 'untracked');
  const untracked = changes.filter((c) => c.unstagedStatus === 'untracked');

  // 加载变更
  const loadChanges = useCallback(() => {
    if (!repoPath) return;
    setLoading(true);
    invoke<ChangeFileStatus[]>('get_changes_status', { repoPath })
      .then(setChanges)
      .catch(() => setChanges([]))
      .finally(() => setLoading(false));
  }, [repoPath]);

  useEffect(() => {
    loadChanges();
  }, [loadChanges]);

  // PTY 输出监听 — 自动刷新
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedRefresh = useCallback(() => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(loadChanges, 500);
  }, [loadChanges]);

  useTauriEvent<PtyOutputPayload>(
    'pty-output',
    useCallback(
      (payload: PtyOutputPayload) => {
        if (GIT_REFRESH_PATTERNS.some((p) => p.test(payload.data))) {
          debouncedRefresh();
        }
      },
      [debouncedRefresh],
    ),
  );

  // ... 后续步骤实现操作函数和 JSX 渲染
}
```

- [ ] **Step 2: 操作函数 — stage/unstage/commit/discard**

在组件内添加操作处理函数。注意 `handleCommit` 成功后调用 `onCommitSuccess()` 通知容器刷新 History：

```typescript
  const handleStage = useCallback(async (files: string[]) => {
    try {
      await invoke('git_stage', { repoPath, files });
      loadChanges();
    } catch (e) {
      console.error('stage failed:', e);
    }
  }, [repoPath, loadChanges]);

  const handleUnstage = useCallback(async (files: string[]) => {
    try {
      await invoke('git_unstage', { repoPath, files });
      loadChanges();
    } catch (e) {
      console.error('unstage failed:', e);
    }
  }, [repoPath, loadChanges]);

  const handleStageAll = useCallback(async () => {
    try {
      await invoke('git_stage_all', { repoPath });
      loadChanges();
    } catch (e) {
      console.error('stage all failed:', e);
    }
  }, [repoPath, loadChanges]);

  const handleUnstageAll = useCallback(async () => {
    try {
      await invoke('git_unstage_all', { repoPath });
      loadChanges();
    } catch (e) {
      console.error('unstage all failed:', e);
    }
  }, [repoPath, loadChanges]);

  const handleCommit = useCallback(async () => {
    if (!commitMsg.trim() || staged.length === 0) return;
    setCommitting(true);
    try {
      await invoke('git_commit', { repoPath, message: commitMsg.trim() });
      setCommitMsg('');
      loadChanges();
      onCommitSuccess(); // 通知容器刷新 History tab
    } catch (e) {
      console.error('commit failed:', e);
    } finally {
      setCommitting(false);
    }
  }, [repoPath, commitMsg, staged.length, loadChanges, onCommitSuccess]);

  const handleDiscard = useCallback(async (files: string[]) => {
    if (!confirm(`确定要丢弃 ${files.length} 个文件的修改？此操作不可撤销。`)) return;
    try {
      await invoke('git_discard_file', { repoPath, files });
      loadChanges();
    } catch (e) {
      console.error('discard failed:', e);
    }
  }, [repoPath, loadChanges]);

  const handleViewDiff = useCallback((filePath: string, staged: boolean, statusLabel: string) => {
    setDiffModal({ open: true, filePath, staged, statusLabel });
  }, []);

  const toggleViewMode = useCallback(() => {
    const next = viewMode === 'list' ? 'tree' : 'list';
    setConfig({ ...config, gitChangesViewMode: next });
  }, [viewMode, config, setConfig]);
```

- [ ] **Step 3: 树形视图辅助函数**

在组件外部添加树形结构构建函数：

```typescript
interface FileTreeNode {
  name: string;
  fullPath: string; // 目录路径（用于折叠状态 key）
  file?: ChangeFileStatus; // 叶节点有值
  children: FileTreeNode[];
}

function buildFileTree(files: ChangeFileStatus[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];

  for (const file of files) {
    const parts = file.path.split('/');
    let current = root;
    let pathSoFar = '';

    for (let i = 0; i < parts.length; i++) {
      pathSoFar += (i > 0 ? '/' : '') + parts[i];
      const isLast = i === parts.length - 1;

      if (isLast) {
        current.push({ name: parts[i], fullPath: pathSoFar, file, children: [] });
      } else {
        let dir = current.find((n) => n.name === parts[i] && !n.file);
        if (!dir) {
          dir = { name: parts[i], fullPath: pathSoFar, children: [] };
          current.push(dir);
        }
        current = dir.children;
      }
    }
  }

  return root;
}
```

- [ ] **Step 4: JSX 渲染 — 文件列表（列表 + 树形视图）和提交区域**

```typescript
  // 文件行渲染
  const renderFileRow = (
    file: ChangeFileStatus,
    area: 'staged' | 'unstaged' | 'untracked',
    displayName: string,
    depth: number = 0,
  ) => {
    const isStaged = area === 'staged';
    const statusChar = isStaged
      ? statusLabelFor(file.stagedStatus)
      : statusLabelFor(file.unstagedStatus);

    return (
      <div
        key={`${area}-${file.path}`}
        className="group flex items-center justify-between py-1 px-2 hover:bg-[var(--border-subtle)] rounded-[var(--radius-sm)] cursor-pointer text-sm"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => handleViewDiff(file.path, isStaged, statusChar)}
        onContextMenu={(e) => {
          e.preventDefault();
          const items = [
            { label: '查看 Diff', onClick: () => handleViewDiff(file.path, isStaged, statusChar) },
            { separator: true as const },
            ...(isStaged
              ? [{ label: 'Unstage', onClick: () => handleUnstage([file.path]) }]
              : [{ label: 'Stage', onClick: () => handleStage([file.path]) }]),
            ...(area !== 'staged'
              ? [{ separator: true as const }, { label: '丢弃修改', onClick: () => handleDiscard([file.path]) }]
              : []),
          ];
          showContextMenu(e.clientX, e.clientY, items);
        }}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={`shrink-0 text-xs font-mono w-4 text-center ${statusColor(file, area)}`}>
            {statusChar}
          </span>
          <span className="truncate" title={file.path}>
            {displayName}
          </span>
        </div>
        <button
          className="shrink-0 w-5 h-5 flex items-center justify-center text-sm opacity-0 group-hover:opacity-100 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-opacity"
          title={isStaged ? 'Unstage' : 'Stage'}
          onClick={(e) => {
            e.stopPropagation();
            isStaged ? handleUnstage([file.path]) : handleStage([file.path]);
          }}
        >
          {isStaged ? '−' : '+'}
        </button>
      </div>
    );
  };

  // 树节点递归渲染
  const renderTreeNode = (node: FileTreeNode, area: 'staged' | 'unstaged' | 'untracked', depth: number) => {
    if (node.file) {
      return renderFileRow(node.file, area, node.name, depth);
    }
    // 目录节点
    const isCollapsed = collapsedDirs.has(`${area}:${node.fullPath}`);
    return (
      <div key={`dir-${area}-${node.fullPath}`}>
        <div
          className="flex items-center gap-1 py-0.5 px-2 text-sm text-[var(--text-muted)] cursor-pointer hover:bg-[var(--border-subtle)] rounded-[var(--radius-sm)]"
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() => {
            const key = `${area}:${node.fullPath}`;
            setCollapsedDirs((prev) => {
              const next = new Set(prev);
              if (next.has(key)) next.delete(key); else next.add(key);
              return next;
            });
          }}
        >
          <span className="text-[11px] w-3 text-center" style={{
            transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
            display: 'inline-block',
            transition: 'transform 150ms',
          }}>▾</span>
          <span>{node.name}</span>
        </div>
        {!isCollapsed && node.children.map((child) => renderTreeNode(child, area, depth + 1))}
      </div>
    );
  };

  // 渲染文件列表（根据 viewMode 选择列表或树形）
  const renderFiles = (files: ChangeFileStatus[], area: 'staged' | 'unstaged' | 'untracked') => {
    if (viewMode === 'tree') {
      const tree = buildFileTree(files);
      return tree.map((node) => renderTreeNode(node, area, 0));
    }
    return files.map((f) => renderFileRow(f, area, f.path));
  };

  // 分组渲染
  const renderGroup = (
    title: string,
    files: ChangeFileStatus[],
    area: 'staged' | 'unstaged' | 'untracked',
    action?: { label: string; onClick: () => void },
  ) => {
    if (files.length === 0) return null;
    return (
      <div className="mb-2">
        <div className="flex items-center justify-between px-2 py-1">
          <span className="text-xs text-[var(--text-muted)] uppercase tracking-wider font-medium">
            {title} ({files.length})
          </span>
          {action && (
            <button
              className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
              onClick={action.onClick}
            >
              {action.label}
            </button>
          )}
        </div>
        {renderFiles(files, area)}
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col">
      {/* 工具栏 */}
      <div className="flex items-center justify-between px-3 py-1.5 flex-shrink-0">
        <button
          className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors text-sm"
          onClick={loadChanges}
          title="刷新"
        >
          ↻
        </button>
        <button
          className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
          onClick={toggleViewMode}
          title={viewMode === 'list' ? '切换到树形视图' : '切换到列表视图'}
        >
          {viewMode === 'list' ? '⊞' : '≡'}
        </button>
      </div>

      {/* 文件列表 */}
      <div className="flex-1 overflow-y-auto px-1">
        {loading && changes.length === 0 && (
          <div className="text-center text-[var(--text-muted)] text-sm py-6">加载中...</div>
        )}

        {!loading && changes.length === 0 && (
          <div className="text-center text-[var(--text-muted)] text-sm py-6">暂无变更</div>
        )}

        {renderGroup('Staged Changes', staged, 'staged', {
          label: '↓ 全部取消',
          onClick: handleUnstageAll,
        })}
        {renderGroup('Changes', unstaged, 'unstaged', {
          label: '↑ 全部暂存',
          onClick: handleStageAll,
        })}
        {renderGroup('Untracked Files', untracked, 'untracked', {
          label: '↑ 全部暂存',
          onClick: handleStageAll,
        })}
      </div>

      {/* 提交区域 */}
      <div className="flex-shrink-0 border-t border-[var(--border-subtle)] p-2">
        <textarea
          className="w-full text-sm bg-[var(--bg-base)] text-[var(--text-primary)] border border-[var(--border-default)] rounded px-2 py-1.5 resize-none placeholder:text-[var(--text-muted)]"
          rows={3}
          placeholder="Commit message..."
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              handleCommit();
            }
          }}
        />
        <button
          className={`w-full mt-1.5 py-1.5 text-sm rounded font-medium transition-colors ${
            commitMsg.trim() && staged.length > 0 && !committing
              ? 'bg-[var(--accent)] text-white hover:opacity-90 cursor-pointer'
              : 'bg-[var(--bg-elevated)] text-[var(--text-muted)] cursor-not-allowed'
          }`}
          disabled={!commitMsg.trim() || staged.length === 0 || committing}
          onClick={handleCommit}
        >
          {committing ? '提交中...' : `Commit (${staged.length})`}
        </button>
      </div>

      {/* Diff Modal */}
      {diffModal && repoPath && (
        <DiffModal
          open={diffModal.open}
          onClose={() => setDiffModal(null)}
          projectPath={repoPath}
          status={{
            path: diffModal.filePath,
            status: 'modified',
            statusLabel: diffModal.statusLabel,
          }}
          staged={diffModal.staged}
        />
      )}
    </div>
  );
}

// 辅助函数
function statusLabelFor(status?: string): string {
  switch (status) {
    case 'modified': return 'M';
    case 'added': return 'A';
    case 'deleted': return 'D';
    case 'renamed': return 'R';
    case 'untracked': return '?';
    case 'conflicted': return 'C';
    default: return ' ';
  }
}

function statusColor(file: ChangeFileStatus, area: string): string {
  const status = area === 'staged' ? file.stagedStatus : file.unstagedStatus;
  switch (status) {
    case 'modified': return 'text-[var(--color-warning,#e5c07b)]';
    case 'added': return 'text-[var(--color-success,#98c379)]';
    case 'deleted': return 'text-[var(--color-error,#e06c75)]';
    case 'renamed': return 'text-[var(--color-info,#61afef)]';
    case 'untracked': return 'text-[var(--color-success,#98c379)]';
    default: return 'text-[var(--text-muted)]';
  }
}
```

- [ ] **Step 4: 验证前端编译**

Run: `cd D:/Git/mini-term && npx tsc --noEmit 2>&1 | tail -10`

- [ ] **Step 5: 提交**

```bash
git add src/components/GitChanges.tsx
git commit -m "feat: 实现 GitChanges 组件 — 变更文件列表、stage/unstage、commit、右键菜单"
```

---

### Task 8: 前端 — 扩展 DiffModal 支持 staged diff

**Files:**
- Modify: `src/components/DiffModal.tsx:5-9,148-161`

- [ ] **Step 1: 修改 DiffModal props 和 invoke 调用**

修改 `DiffModalProps` 接口，新增可选的 `staged` prop：

```typescript
interface DiffModalProps {
  open: boolean;
  onClose: () => void;
  projectPath: string;
  status: GitFileStatus;
  staged?: boolean;
}
```

修改组件签名：

```typescript
export function DiffModal({ open, onClose, projectPath, status, staged }: DiffModalProps) {
```

修改 `invoke` 调用，传递 `staged` 参数：

```typescript
    invoke<GitDiffResult>('get_git_diff', {
      projectPath,
      filePath: status.path,
      staged: staged ?? false,
    })
```

- [ ] **Step 2: 验证前端编译**

Run: `cd D:/Git/mini-term && npx tsc --noEmit 2>&1 | tail -10`

- [ ] **Step 3: 提交**

```bash
git add src/components/DiffModal.tsx
git commit -m "feat: DiffModal 支持 staged 参数，查看暂存区 diff"
```

---

### Task 9: 集成验证

- [ ] **Step 1: 完整编译验证**

Run: `cd D:/Git/mini-term && npx tsc --noEmit && cd src-tauri && cargo check`
Expected: 前后端均编译通过

- [ ] **Step 2: Rust 测试**

Run: `cd src-tauri && cargo test`
Expected: 所有测试通过

- [ ] **Step 3: 运行 `npm run tauri dev` 手动验证**

手动测试检查清单：
1. GitHistory 面板显示 History / Changes 两个 tab
2. 点击 Changes tab 显示变更文件列表
3. 文件分为 Staged / Changes / Untracked 三组
4. 点击 `+` 按钮 stage 文件，点击 `−` 按钮 unstage
5. 全部暂存 / 全部取消功能正常
6. 点击文件名打开 DiffModal 查看变更
7. 输入 commit message 后 Commit 按钮可用
8. Commit 成功后清空输入框，文件列表刷新
9. 右键菜单功能正常（查看 Diff / Stage / Unstage / 丢弃修改）
10. 丢弃修改弹确认框
11. 列表/树形视图切换正常
12. 切换回 History tab 功能不受影响

- [ ] **Step 4: 最终提交（如有修复）**

```bash
git add -A
git commit -m "fix: 修复集成测试中发现的问题"
```
