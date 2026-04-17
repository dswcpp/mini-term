# Git Pull/Push 按钮实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Git History 面板的每个仓库行右侧添加 pull/push 操作按钮，后台静默执行并通过按钮状态反馈结果。

**Architecture:** Rust 端新增两个 Tauri command，通过 `std::process::Command` 调用 git CLI（与现有 git2-rs 只读操作互补）。前端在仓库行 hover 时显示 `↓` `↑` 按钮，点击后执行操作并通过按钮状态变化（loading/success/error）反馈。

**Tech Stack:** Rust std::process::Command, React useState, Tauri invoke

**Spec:** `docs/superpowers/specs/2026-04-08-git-pull-push-buttons-design.md`

---

### Task 1: Rust 后端 — 添加 git_pull 和 git_push command

**Files:**
- Modify: `src-tauri/src/git.rs` (文件末尾追加)
- Modify: `src-tauri/src/lib.rs:25-47` (invoke_handler 注册)

- [ ] **Step 1: 在 git.rs 末尾添加 git_pull command**

在 `src-tauri/src/git.rs` 文件末尾（`get_git_diff` 函数之后）追加：

```rust
#[tauri::command]
pub async fn git_pull(repo_path: String) -> Result<String, String> {
    let output = std::process::Command::new("git")
        .arg("pull")
        .current_dir(&repo_path)
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("Failed to execute git pull: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}
```

- [ ] **Step 2: 在 git.rs 末尾添加 git_push command**

紧接 `git_pull` 之后追加：

```rust
#[tauri::command]
pub async fn git_push(repo_path: String) -> Result<String, String> {
    let output = std::process::Command::new("git")
        .arg("push")
        .current_dir(&repo_path)
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("Failed to execute git push: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}
```

- [ ] **Step 3: 在 lib.rs 注册新 command**

在 `src-tauri/src/lib.rs` 的 `invoke_handler` 列表中，`git::get_commit_file_diff` 之后添加：

```rust
            git::git_pull,
            git::git_push,
```

- [ ] **Step 4: 验证 Rust 编译通过**

Run: `cd src-tauri && cargo check`
Expected: 无编译错误

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/git.rs src-tauri/src/lib.rs
git commit -m "feat: 添加 git_pull 和 git_push Tauri command

- 通过 std::process::Command 调用 git CLI
- stdin(Stdio::null()) 防止认证提示阻塞
- 在 lib.rs 注册新 command"
```

---

### Task 2: 前端 — 添加 pull/push 按钮到仓库行

**Files:**
- Modify: `src/components/GitHistory.tsx:279-311` (renderTreeNode 中仓库行部分)

- [ ] **Step 1: 添加操作状态 state**

在 `GitHistory` 组件中（`scrollRef` 声明附近，约第 91 行后），添加：

```typescript
// pull/push 操作状态: 'idle' | 'loading' | 'success' | 'error'
const [pullState, setPullState] = useState<Map<string, { status: string; error?: string }>>(new Map());
const [pushState, setPushState] = useState<Map<string, { status: string; error?: string }>>(new Map());
```

- [ ] **Step 2: 添加 handlePull 和 handlePush 函数**

在 `debouncedRefresh` 定义附近，添加两个操作函数：

```typescript
const handlePull = useCallback(async (repoPath: string) => {
  setPullState((prev) => new Map(prev).set(repoPath, { status: 'loading' }));
  setPushState((prev) => { const n = new Map(prev); n.delete(repoPath); return n; }); // 互斥：清除 push 状态
  try {
    await invoke('git_pull', { repoPath });
    setPullState((prev) => new Map(prev).set(repoPath, { status: 'success' }));
    loadCommits(repoPath);
    loadBranches(repoPath);
  } catch (e) {
    setPullState((prev) => new Map(prev).set(repoPath, { status: 'error', error: String(e) }));
  }
  setTimeout(() => {
    setPullState((prev) => { const n = new Map(prev); n.delete(repoPath); return n; });
  }, 1500);
}, [loadCommits, loadBranches]);

const handlePush = useCallback(async (repoPath: string) => {
  setPushState((prev) => new Map(prev).set(repoPath, { status: 'loading' }));
  setPullState((prev) => { const n = new Map(prev); n.delete(repoPath); return n; }); // 互斥：清除 pull 状态
  try {
    await invoke('git_push', { repoPath });
    setPushState((prev) => new Map(prev).set(repoPath, { status: 'success' }));
    loadBranches(repoPath);
  } catch (e) {
    setPushState((prev) => new Map(prev).set(repoPath, { status: 'error', error: String(e) }));
  }
  setTimeout(() => {
    setPushState((prev) => { const n = new Map(prev); n.delete(repoPath); return n; });
  }, 1500);
}, [loadBranches]);
```

- [ ] **Step 3: 修改仓库行 JSX — 添加按钮容器**

在 `renderTreeNode` 函数中，仓库叶节点的 sticky 行（约第 288-311 行），将内部的 `<div className="flex items-center gap-1 w-full ...">` 改为包含左右两部分的布局。

当前代码（第 291-311 行）：
```tsx
<div
  className="flex items-center gap-1 w-full py-[5px] cursor-pointer hover:bg-[var(--border-subtle)] rounded-[var(--radius-sm)] text-base transition-colors duration-100 text-[var(--color-folder)]"
  style={{ paddingLeft: `${depth * 16 + 8}px` }}
  onClick={() => toggleRepo(repo.path)}
>
  <span ...>&#9662;</span>
  <span className="truncate font-medium">{node.name}</span>
  {repo.currentBranch && (
    <span ...>{repo.currentBranch}</span>
  )}
</div>
```

替换为：
```tsx
<div
  className="group flex items-center justify-between w-full py-[5px] cursor-pointer hover:bg-[var(--border-subtle)] rounded-[var(--radius-sm)] text-base transition-colors duration-100 text-[var(--color-folder)]"
  style={{ paddingLeft: `${depth * 16 + 8}px`, paddingRight: '8px' }}
  onClick={() => toggleRepo(repo.path)}
>
  <div className="flex items-center gap-1 min-w-0">
    <span
      className="text-[13px] w-3 text-center text-[var(--text-muted)] transition-transform duration-150"
      style={{
        transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)',
        display: 'inline-block',
      }}
    >
      &#9662;
    </span>
    <span className="truncate font-medium">{node.name}</span>
    {repo.currentBranch && (
      <span className="shrink-0 text-[11px] leading-[18px] px-1.5 rounded font-mono text-[var(--text-muted)] bg-[var(--border-subtle)]">
        {repo.currentBranch}
      </span>
    )}
  </div>
  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
    <GitActionButton
      repoPath={repo.path}
      action="pull"
      state={pullState.get(repo.path)}
      disabled={pullState.get(repo.path)?.status === 'loading' || pushState.get(repo.path)?.status === 'loading'}
      onClick={handlePull}
    />
    <GitActionButton
      repoPath={repo.path}
      action="push"
      state={pushState.get(repo.path)}
      disabled={pullState.get(repo.path)?.status === 'loading' || pushState.get(repo.path)?.status === 'loading'}
      onClick={handlePush}
    />
  </div>
</div>
```

- [ ] **Step 4: 添加 GitActionButton 组件**

在 `GitHistory.tsx` 文件顶部（`GitHistory` 函数之前，`buildRepoTree` 函数之后），添加 `GitActionButton` 组件：

```tsx
function GitActionButton({
  repoPath,
  action,
  state,
  disabled,
  onClick,
}: {
  repoPath: string;
  action: 'pull' | 'push';
  state?: { status: string; error?: string };
  disabled: boolean;
  onClick: (repoPath: string) => void;
}) {
  const idle = !state || state.status === 'idle';
  const loading = state?.status === 'loading';
  const success = state?.status === 'success';
  const error = state?.status === 'error';

  let display: string;
  let colorClass: string;
  if (loading) {
    display = '↻';
    colorClass = 'text-[var(--text-muted)]';
  } else if (success) {
    display = '✓';
    colorClass = 'text-[var(--color-success)]';
  } else if (error) {
    display = '✕';
    colorClass = 'text-[var(--color-error)]';
  } else {
    display = action === 'pull' ? '↓' : '↑';
    colorClass = 'text-[var(--text-muted)] hover:text-[var(--text-primary)]';
  }

  return (
    <button
      className={`w-5 h-5 flex items-center justify-center text-sm transition-colors rounded ${colorClass} ${
        disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
      } ${loading ? 'animate-pulse' : ''}`}
      title={error ? state?.error : action === 'pull' ? 'Git Pull' : 'Git Push'}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onClick(repoPath);
      }}
    >
      {display}
    </button>
  );
}
```

- [ ] **Step 5: 验证前端编译通过**

Run: `npm run build`
Expected: 无编译错误

- [ ] **Step 6: 提交**

```bash
git add src/components/GitHistory.tsx
git commit -m "feat: Git History 仓库行添加 pull/push 操作按钮

- hover 仓库行时显示 ↓(pull) ↑(push) 按钮
- 点击后后台静默执行，按钮状态反馈结果（loading/✓/✕）
- 同一仓库 pull/push 互斥，执行中两个按钮均禁用
- pull 成功后刷新 commits + branches，push 成功后刷新 branches"
```

---

### Task 3: 手动验收测试

- [ ] **Step 1: 启动开发环境**

Run: `npm run tauri dev`

- [ ] **Step 2: 验证基本功能**

1. 打开一个有 git 仓库的项目
2. 在 Git History 面板，hover 仓库行 → 应看到 `↓` `↑` 按钮出现
3. 鼠标移走 → 按钮消失
4. 点击 `↓` → 按钮变为旋转 `↻`，完成后短暂变为 `✓`（绿色）
5. 点击 `↑` → 同上
6. 验证点击按钮不会触发仓库展开/折叠

- [ ] **Step 3: 验证互斥和错误处理**

1. 在无 remote 的仓库上点击 push → 按钮应变为 `✕`（红色），hover 显示错误信息
2. 执行 pull 期间点击 push → push 按钮应被禁用（灰色不可点击）

- [ ] **Step 4: 提交最终版本（如有微调）**
