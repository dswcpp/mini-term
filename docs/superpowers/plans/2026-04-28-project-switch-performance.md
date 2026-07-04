# Issue #24: 项目切换性能优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除项目切换时的 UI 卡顿，让已访问过的项目切换感受为"即时"，首次访问的项目也能在 loading 态中保持响应。

**Architecture:** 在 FileTree / GitHistory 组件外维护一个按 `projectPath` 索引的内存缓存。组件因 `key={activeProjectId}` remount 时，先从缓存读取上一次的数据立即渲染（零延迟），同时后台发起刷新请求。目录列表与 Git 状态加载错开执行，避免线程池竞争。首次加载无缓存的项目显示轻量 loading 指示器。

**Tech Stack:** React 19, TypeScript, Zustand, Tauri v2 invoke

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/utils/projectDataCache.ts` | **新建** | 按 projectPath 缓存 FileTree 和 GitHistory 的数据（rootEntries、gitStatusMap、repos） |
| `src/components/FileTree.tsx` | 修改 | 接入缓存：mount 时先读缓存渲染，再后台刷新；目录加载完成后再触发 git status |
| `src/components/GitHistory.tsx` | 修改 | 接入缓存：mount 时先读缓存渲染，再后台刷新 |

---

### Task 1: 新建 projectDataCache 模块

**Files:**
- Create: `src/utils/projectDataCache.ts`

- [ ] **Step 1: 创建缓存模块**

```typescript
// src/utils/projectDataCache.ts
import type { FileEntry, GitFileStatus, GitRepoInfo } from '../types';

interface FileTreeCache {
  rootEntries: FileEntry[];
  gitStatusMap: Map<string, GitFileStatus>;
}

interface GitHistoryCache {
  repos: GitRepoInfo[];
  selectedRepo: string;
}

const fileTreeCache = new Map<string, FileTreeCache>();
const gitHistoryCache = new Map<string, GitHistoryCache>();

export function getFileTreeCache(projectPath: string): FileTreeCache | undefined {
  return fileTreeCache.get(projectPath);
}

export function setFileTreeCache(projectPath: string, data: FileTreeCache): void {
  fileTreeCache.set(projectPath, data);
}

export function getGitHistoryCache(projectPath: string): GitHistoryCache | undefined {
  return gitHistoryCache.get(projectPath);
}

export function setGitHistoryCache(projectPath: string, data: GitHistoryCache): void {
  gitHistoryCache.set(projectPath, data);
}

export function clearProjectCache(projectPath: string): void {
  fileTreeCache.delete(projectPath);
  gitHistoryCache.delete(projectPath);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/utils/projectDataCache.ts
git commit -m "feat: 新增 projectDataCache 模块，为项目切换提供内存缓存"
```

---

### Task 2: FileTree 接入缓存 + 错开加载

**Files:**
- Modify: `src/components/FileTree.tsx:292-333`
- Read: `src/utils/projectDataCache.ts`

核心改动逻辑：
1. `rootEntries` 初始值从缓存读取（而非空数组），实现 remount 后零延迟显示
2. `gitStatusMap` 同理从缓存读取
3. 加载顺序改为：先 `loadRootEntries()`，**完成后** 再 `loadGitStatus()`（而非并行）
4. 数据加载完成后写入缓存
5. 无缓存时显示 loading 指示器

- [ ] **Step 1: 添加缓存 import 和初始状态**

在 FileTree 组件顶部添加 import，修改 `rootEntries` 和 `gitStatusMap` 的初始值从缓存读取：

```typescript
import { getFileTreeCache, setFileTreeCache } from '../utils/projectDataCache';
```

将：
```typescript
const [rootEntries, setRootEntries] = useState<FileEntry[]>([]);
const [gitStatusMap, setGitStatusMap] = useState<Map<string, GitFileStatus>>(new Map());
```
改为（使用惰性初始化，避免每次渲染都查缓存）：
```typescript
const [rootEntries, setRootEntries] = useState<FileEntry[]>(() => {
  return (project ? getFileTreeCache(project.path) : undefined)?.rootEntries ?? [];
});
const [gitStatusMap, setGitStatusMap] = useState<Map<string, GitFileStatus>>(() => {
  return (project ? getFileTreeCache(project.path) : undefined)?.gitStatusMap ?? new Map();
});
const [loading, setLoading] = useState(() => !project || !getFileTreeCache(project.path));
```

- [ ] **Step 2: 修改 loadRootEntries 写入缓存**

将 `loadRootEntries` 回调修改为加载后更新缓存：
```typescript
const loadRootEntries = useCallback(() => {
  if (!project) return;
  invoke<FileEntry[]>('list_directory', {
    projectRoot: project.path,
    path: project.path,
  }).then((entries) => {
    setRootEntries(entries);
    setFileTreeCache(project.path, {
      rootEntries: entries,
      gitStatusMap: gitStatusMapRef.current,
    });
  });
}, [project?.path]);
```

需要一个 ref 来跟踪最新的 gitStatusMap（用于写缓存时不依赖闭包里的旧值）：
```typescript
const gitStatusMapRef = useRef(gitStatusMap);
gitStatusMapRef.current = gitStatusMap;
```

- [ ] **Step 3: 修改 loadGitStatus 写入缓存**

```typescript
const loadGitStatus = useCallback(() => {
  if (!project) return;
  invoke<GitFileStatus[]>('get_git_status', { projectPath: project.path })
    .then((statuses) => {
      const map = new Map<string, GitFileStatus>();
      for (const s of statuses) map.set(s.path, s);
      setGitStatusMap(map);
      setFileTreeCache(project.path, {
        rootEntries: rootEntriesRef.current,
        gitStatusMap: map,
      });
    })
    .catch(() => setGitStatusMap(new Map()));
}, [project?.path]);
```

同样需要 rootEntries 的 ref：
```typescript
const rootEntriesRef = useRef(rootEntries);
rootEntriesRef.current = rootEntries;
```

- [ ] **Step 4: 修改初始化 effect — 错开加载**

将原本并行触发的两个加载改为串行（目录先、Git 后）：

原代码（`FileTree.tsx:325-333`）：
```typescript
useEffect(() => {
  if (!project) {
    setRootEntries([]);
    return;
  }
  loadRootEntries();
  invoke('watch_directory', { path: project.path, projectPath: project.path });
  return () => { invoke('unwatch_directory', { path: project.path }); };
}, [project?.path, loadRootEntries]);
```

以及独立的 git status effect（`FileTree.tsx:308-310`）：
```typescript
useEffect(() => {
  loadGitStatus();
}, [loadGitStatus]);
```

合并改为：
```typescript
useEffect(() => {
  if (!project) {
    setRootEntries([]);
    setLoading(false);
    return;
  }
  let cancelled = false;
  const projectPath = project.path;
  invoke<FileEntry[]>('list_directory', {
    projectRoot: projectPath,
    path: projectPath,
  }).then((entries) => {
    if (cancelled) return;
    setRootEntries(entries);
    rootEntriesRef.current = entries;
    setLoading(false);
    setFileTreeCache(projectPath, {
      rootEntries: entries,
      gitStatusMap: gitStatusMapRef.current,
    });
    // 目录加载完成后再加载 git status，避免两者竞争线程池
    invoke<GitFileStatus[]>('get_git_status', { projectPath })
      .then((statuses) => {
        if (cancelled) return;
        const map = new Map<string, GitFileStatus>();
        for (const s of statuses) map.set(s.path, s);
        setGitStatusMap(map);
        gitStatusMapRef.current = map;
        setFileTreeCache(projectPath, {
          rootEntries: rootEntriesRef.current,
          gitStatusMap: map,
        });
      })
      .catch(() => {
        if (!cancelled) setGitStatusMap(new Map());
      });
  });
  invoke('watch_directory', { path: projectPath, projectPath });
  return () => {
    cancelled = true;
    invoke('unwatch_directory', { path: projectPath });
  };
}, [project?.path]);
```

**同时删除**原来独立的 `loadGitStatus` effect：
```typescript
// 删除这段
useEffect(() => {
  loadGitStatus();
}, [loadGitStatus]);
```

> **注意：** `loadRootEntries` 和 `loadGitStatus` 两个 useCallback 仍然保留，因为它们被刷新按钮（第 426-428 行）和 fs-change / pty-output 事件处理器使用。只是初始化不再通过它们触发。

- [ ] **Step 5: 添加 loading 指示器**

在文件列表渲染区域，当 `loading` 为 true 且无缓存数据时显示加载指示：

```typescript
<div className="flex-1 min-h-0 overflow-y-auto px-1" onContextMenu={handleRootContextMenu}>
  {loading && rootEntries.length === 0 ? (
    <div className="flex items-center justify-center py-8 text-[var(--text-muted)] text-sm">
      加载中...
    </div>
  ) : (
    rootEntries.map((entry) => (
      <TreeNode ... />
    ))
  )}
</div>
```

- [ ] **Step 6: 验证**

Run: `npm run tauri dev`

验证点：
1. 首次切换到新项目 — 显示"加载中..."，加载完成后显示文件树
2. 切回已访问的项目 — 立即显示上次的文件树数据（无闪烁）
3. 文件树的 git 状态标记在目录渲染后异步出现
4. 刷新按钮仍然正常工作
5. fs-change 事件仍然正常触发刷新

- [ ] **Step 7: Commit**

```bash
git add src/components/FileTree.tsx
git commit -m "perf: FileTree 接入缓存 + 错开加载，项目切换不再卡顿"
```

---

### Task 3: GitHistory 接入缓存

**Files:**
- Modify: `src/components/GitHistory.tsx:19-38`
- Read: `src/utils/projectDataCache.ts`

核心改动：repos 列表和 selectedRepo 从缓存读取初始值，加载完成后写入缓存。

- [ ] **Step 1: 添加缓存 import 和初始状态**

```typescript
import { getGitHistoryCache, setGitHistoryCache } from '../utils/projectDataCache';
```

修改状态初始值（惰性初始化）：
```typescript
const [repos, setRepos] = useState<GitRepoInfo[]>(() => {
  return (project ? getGitHistoryCache(project.path) : undefined)?.repos ?? [];
});
const [selectedRepo, setSelectedRepo] = useState<string>(() => {
  return (project ? getGitHistoryCache(project.path) : undefined)?.selectedRepo ?? '';
});
```

- [ ] **Step 2: 修改 loadRepos 写入缓存**

```typescript
const loadRepos = useCallback(() => {
  if (!project) return;
  invoke<GitRepoInfo[]>('discover_git_repos', { projectPath: project.path })
    .then((r) => {
      setRepos(r);
      // 先计算 selectedRepo，再写缓存（不在 setState updater 内产生副作用）
      let nextRepo = '';
      setSelectedRepo((prev) => {
        nextRepo = (prev && r.some((repo) => repo.path === prev)) ? prev : (r[0]?.path ?? '');
        return nextRepo;
      });
      // setState 是同步批处理的，此处 nextRepo 已被赋值
      setGitHistoryCache(project.path, { repos: r, selectedRepo: nextRepo });
    })
    .catch(() => setRepos([]));
}, [project?.path]);
```

- [ ] **Step 3: 验证**

Run: `npm run tauri dev`

验证点：
1. 首次打开 Git 面板 — 正常加载仓库列表
2. 切换回已访问项目 — 立即显示上次的仓库列表
3. 切换仓库下拉框仍正常工作

- [ ] **Step 4: Commit**

```bash
git add src/components/GitHistory.tsx
git commit -m "perf: GitHistory 接入缓存，切换项目时立即显示上次数据"
```

---

### Task 4: 项目删除时清理缓存

**Files:**
- Modify: `src/store.ts:382-427` (removeProject action)

- [ ] **Step 1: 在 removeProject 中清理缓存**

```typescript
import { clearProjectCache } from './utils/projectDataCache';
```

在 `removeProject` action 的开头（现有清理逻辑旁边），添加：
```typescript
const removingProject = state.config.projects.find((p) => p.id === id);
if (removingProject) {
  clearProjectCache(removingProject.path);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/store.ts
git commit -m "fix: 项目删除时清理 projectDataCache，防止内存泄漏"
```

---

## 预期效果

| 场景 | 优化前 | 优化后 |
|------|--------|--------|
| 切换到已访问项目 | 卡顿 200-700ms（remount + 重新加载） | **即时**（缓存数据立即渲染） |
| 首次切换到新项目 | 卡顿 200-700ms（白屏等待） | 显示 loading 指示器，**UI 保持响应** |
| Git 状态加载 | 与目录并行竞争线程池 | 目录加载完成后再触发，**不阻塞文件树渲染** |
