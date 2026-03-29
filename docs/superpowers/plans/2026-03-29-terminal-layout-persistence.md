# Terminal Layout Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist terminal layout (tabs, splits, pane shell assignments) per project, and restore it on next open.

**Architecture:** Extend `ProjectConfig` with an optional `SavedProjectLayout` field. On layout changes, serialize the runtime `SplitNode` tree (stripping ephemeral data) and save via existing `save_config`. On app init, deserialize and recreate PTY processes to restore the layout.

**Tech Stack:** TypeScript (React/Zustand), Rust (Tauri v2, serde)

**Spec:** `docs/superpowers/specs/2026-03-29-terminal-layout-persistence-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/types.ts` | Modify | Add `SavedPane`, `SavedSplitNode`, `SavedTab`, `SavedProjectLayout`; extend `ProjectConfig` |
| `src-tauri/src/config.rs` | Modify | Add Rust structs; extend `ProjectConfig`; add backward-compat test |
| `src/store.ts` | Modify | Add `serializeLayout()`, `restoreLayout()`, `saveLayoutToConfig()` |
| `src/App.tsx` | Modify | Call `restoreLayout` during init; add `beforeunload` handler |
| `src/components/TerminalArea.tsx` | Modify | Call `saveLayoutToConfig` after layout mutations |
| `src/components/SplitLayout.tsx` | Modify | Add Allotment `onChange` + `onLayoutChange` callback prop |

---

### Task 1: Rust — 扩展 config.rs 数据模型

**Files:**
- Modify: `src-tauri/src/config.rs:20-26`

- [ ] **Step 1: 在 `ProjectConfig` 上方添加 layout 序列化结构体**

在 `config.rs` 的 `ShellConfig` struct（第 28-34 行）之后、`ProjectConfig`（第 20 行）之前，添加：

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedPane {
    pub shell_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum SavedSplitNode {
    Leaf { pane: SavedPane },
    Split {
        direction: String,
        children: Vec<SavedSplitNode>,
        sizes: Vec<f64>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedTab {
    #[serde(default)]
    pub custom_title: Option<String>,
    pub split_layout: SavedSplitNode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedProjectLayout {
    pub tabs: Vec<SavedTab>,
    pub active_tab_index: usize,
}
```

- [ ] **Step 2: 给 `ProjectConfig` 添加 `saved_layout` 字段**

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConfig {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub saved_layout: Option<SavedProjectLayout>,
}
```

- [ ] **Step 3: 添加向后兼容性测试**

在 `config.rs` 底部 `mod tests` 中添加：

```rust
#[test]
fn old_config_without_layout_deserializes() {
    let json = r#"{
        "projects": [{"id": "1", "name": "test", "path": "/tmp"}],
        "defaultShell": "cmd",
        "availableShells": [{"name": "cmd", "command": "cmd"}],
        "uiFontSize": 13,
        "terminalFontSize": 14
    }"#;
    let config: AppConfig = serde_json::from_str(json).unwrap();
    assert_eq!(config.projects.len(), 1);
    assert!(config.projects[0].saved_layout.is_none());
}

#[test]
fn layout_round_trip() {
    let layout = SavedProjectLayout {
        tabs: vec![SavedTab {
            custom_title: Some("test".into()),
            split_layout: SavedSplitNode::Split {
                direction: "horizontal".into(),
                children: vec![
                    SavedSplitNode::Leaf { pane: SavedPane { shell_name: "cmd".into() } },
                    SavedSplitNode::Leaf { pane: SavedPane { shell_name: "powershell".into() } },
                ],
                sizes: vec![50.0, 50.0],
            },
        }],
        active_tab_index: 0,
    };
    let json = serde_json::to_string(&layout).unwrap();
    let parsed: SavedProjectLayout = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.tabs.len(), 1);
    assert_eq!(parsed.active_tab_index, 0);
}
```

- [ ] **Step 4: 运行 Rust 测试**

Run: `cd src-tauri && cargo test`
Expected: 所有测试通过，包括新增的 `old_config_without_layout_deserializes` 和 `layout_round_trip`

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/config.rs
git commit -m "feat: Rust 侧添加终端布局持久化数据结构"
```

---

### Task 2: TypeScript — 扩展类型定义

**Files:**
- Modify: `src/types.ts:1-16`

- [ ] **Step 1: 在 `ShellConfig` 之后添加 Saved 类型**

在 `src/types.ts` 的 `ShellConfig` 接口（第 18-22 行）之后、`// === 运行时状态 ===` 注释（第 24 行）之前添加：

```typescript
// === 布局持久化 ===

export interface SavedPane {
  shellName: string;
}

export type SavedSplitNode =
  | { type: 'leaf'; pane: SavedPane }
  | { type: 'split'; direction: 'horizontal' | 'vertical'; children: SavedSplitNode[]; sizes: number[] };

export interface SavedTab {
  customTitle?: string;
  splitLayout: SavedSplitNode;
}

export interface SavedProjectLayout {
  tabs: SavedTab[];
  activeTabIndex: number;
}
```

- [ ] **Step 2: 给 `ProjectConfig` 添加 `savedLayout` 字段**

```typescript
export interface ProjectConfig {
  id: string;
  name: string;
  path: string;
  savedLayout?: SavedProjectLayout;
}
```

- [ ] **Step 3: 确认编译通过**

Run: `cd D:/Git/mini-term && npx tsc --noEmit`
Expected: 无编译错误

- [ ] **Step 4: Commit**

```bash
git add src/types.ts
git commit -m "feat: TypeScript 侧添加终端布局持久化类型"
```

---

### Task 3: Store — serializeLayout 函数

**Files:**
- Modify: `src/store.ts`

- [ ] **Step 1: 添加 import**

在 `store.ts` 顶部的 import 中添加 `SavedSplitNode`、`SavedTab`、`SavedProjectLayout`：

```typescript
import type {
  AppConfig,
  ProjectConfig,
  ProjectState,
  TerminalTab,
  SplitNode,
  PaneStatus,
  SavedSplitNode,
  SavedTab,
  SavedProjectLayout,
} from './types';
```

- [ ] **Step 2: 在 `collectPtyIds` 之后添加 `serializeLayout`**

```typescript
// 序列化 SplitNode 树（剥离运行时数据）
function serializeSplitNode(node: SplitNode): SavedSplitNode {
  if (node.type === 'leaf') {
    return { type: 'leaf', pane: { shellName: node.pane.shellName } };
  }
  return {
    type: 'split',
    direction: node.direction,
    children: node.children.map(serializeSplitNode),
    sizes: [...node.sizes],
  };
}

export function serializeLayout(ps: ProjectState): SavedProjectLayout {
  const tabs: SavedTab[] = ps.tabs.map((tab) => ({
    customTitle: tab.customTitle,
    splitLayout: serializeSplitNode(tab.splitLayout),
  }));
  const activeTabIndex = ps.tabs.findIndex((t) => t.id === ps.activeTabId);
  return { tabs, activeTabIndex: activeTabIndex >= 0 ? activeTabIndex : 0 };
}
```

- [ ] **Step 3: 确认编译通过**

Run: `npx tsc --noEmit`
Expected: 无编译错误

- [ ] **Step 4: Commit**

```bash
git add src/store.ts
git commit -m "feat: 添加 serializeLayout 序列化函数"
```

---

### Task 4: Store — restoreLayout 函数

**Files:**
- Modify: `src/store.ts`

- [ ] **Step 1: 在顶部添加 invoke import**

```typescript
import { invoke } from '@tauri-apps/api/core';
```

- [ ] **Step 2: 在 `serializeLayout` 之后添加 `restoreLayout`**

```typescript
// 反序列化：重建 SplitNode 树并创建 PTY
async function restoreSplitNode(
  saved: SavedSplitNode,
  projectPath: string,
  config: AppConfig,
): Promise<SplitNode | null> {
  if (saved.type === 'leaf') {
    const shell =
      config.availableShells.find((s) => s.name === saved.pane.shellName)
      ?? config.availableShells.find((s) => s.name === config.defaultShell)
      ?? config.availableShells[0];
    if (!shell) return null;
    try {
      const ptyId = await invoke<number>('create_pty', {
        shell: shell.command,
        args: shell.args ?? [],
        cwd: projectPath,
      });
      return {
        type: 'leaf',
        pane: { id: genId(), shellName: shell.name, status: 'idle' as PaneStatus, ptyId },
      };
    } catch {
      return null;
    }
  }

  const children: SplitNode[] = [];
  for (const child of saved.children) {
    const restored = await restoreSplitNode(child, projectPath, config);
    if (restored) children.push(restored);
  }
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return {
    type: 'split',
    direction: saved.direction,
    children,
    sizes: children.map(() => 100 / children.length),
  };
}

export async function restoreLayout(
  projectId: string,
  savedLayout: SavedProjectLayout,
  projectPath: string,
  config: AppConfig,
): Promise<void> {
  const tabs: TerminalTab[] = [];
  for (const savedTab of savedLayout.tabs) {
    const layout = await restoreSplitNode(savedTab.splitLayout, projectPath, config);
    if (layout) {
      tabs.push({
        id: genId(),
        customTitle: savedTab.customTitle,
        splitLayout: layout,
        status: 'idle',
      });
    }
  }
  if (tabs.length === 0) return;
  const activeTabId = tabs[savedLayout.activeTabIndex]?.id ?? tabs[0]?.id ?? '';
  useAppStore.setState((state) => {
    const newStates = new Map(state.projectStates);
    newStates.set(projectId, { id: projectId, tabs, activeTabId });
    return { projectStates: newStates };
  });
}
```

- [ ] **Step 3: 确认编译通过**

Run: `npx tsc --noEmit`
Expected: 无编译错误

- [ ] **Step 4: Commit**

```bash
git add src/store.ts
git commit -m "feat: 添加 restoreLayout 反序列化函数"
```

---

### Task 5: Store — saveLayoutToConfig 防抖保存

**Files:**
- Modify: `src/store.ts`

- [ ] **Step 1: 在 `restoreLayout` 之后添加防抖保存函数**

```typescript
// 防抖保存布局到 config
let saveLayoutTimer: ReturnType<typeof setTimeout> | undefined;

export function saveLayoutToConfig(projectId: string) {
  clearTimeout(saveLayoutTimer);
  saveLayoutTimer = setTimeout(() => {
    const { config, projectStates } = useAppStore.getState();
    const ps = projectStates.get(projectId);
    if (!ps) return;
    const savedLayout = serializeLayout(ps);
    const newConfig = {
      ...config,
      projects: config.projects.map((p) =>
        p.id === projectId ? { ...p, savedLayout } : p
      ),
    };
    useAppStore.getState().setConfig(newConfig);
    invoke('save_config', { config: newConfig });
  }, 500);
}

// 立即保存（不防抖，用于 beforeunload）
export function flushLayoutToConfig(projectId: string) {
  clearTimeout(saveLayoutTimer);
  const { config, projectStates } = useAppStore.getState();
  const ps = projectStates.get(projectId);
  if (!ps) return;
  const savedLayout = serializeLayout(ps);
  const newConfig = {
    ...config,
    projects: config.projects.map((p) =>
      p.id === projectId ? { ...p, savedLayout } : p
    ),
  };
  useAppStore.getState().setConfig(newConfig);
  invoke('save_config', { config: newConfig });
}
```

- [ ] **Step 2: 确认编译通过**

Run: `npx tsc --noEmit`
Expected: 无编译错误

- [ ] **Step 3: Commit**

```bash
git add src/store.ts
git commit -m "feat: 添加 saveLayoutToConfig 防抖保存函数"
```

---

### Task 6: SplitLayout — 添加 onLayoutChange 回调

**Files:**
- Modify: `src/components/SplitLayout.tsx`

- [ ] **Step 1: 扩展 Props 接口，添加 onLayoutChange**

```typescript
interface Props {
  node: SplitNode;
  onSplit?: (paneId: string, direction: 'horizontal' | 'vertical') => void;
  onClose?: (paneId: string) => void;
  onTabDrop?: (sourceTabId: string, targetPaneId: string, direction: 'horizontal' | 'vertical', position: 'before' | 'after') => void;
  onLayoutChange?: (updatedNode: SplitNode) => void;
}
```

- [ ] **Step 2: 改写 `SplitLayout` 组件，传递 onLayoutChange 并处理 Allotment onChange**

将整个 `SplitLayout` 函数体替换为：

```typescript
export function SplitLayout({ node, onSplit, onClose, onTabDrop, onLayoutChange }: Props) {
  if (node.type === 'leaf') {
    return (
      <TerminalInstance
        ptyId={node.pane.ptyId}
        paneId={node.pane.id}
        shellName={node.pane.shellName}
        status={node.pane.status}
        onSplit={onSplit}
        onClose={onClose}
        onTabDrop={onTabDrop}
      />
    );
  }

  // Allotment onChange 返回像素值，需转换为比例值
  const handleSizesChange = (sizes: number[]) => {
    if (!onLayoutChange) return;
    const total = sizes.reduce((a, b) => a + b, 0);
    const proportional = total > 0 ? sizes.map((s) => (s / total) * 100) : sizes;
    onLayoutChange({ ...node, sizes: proportional });
  };

  const handleChildLayoutChange = (index: number, updatedChild: SplitNode) => {
    if (!onLayoutChange) return;
    const newChildren = [...node.children];
    newChildren[index] = updatedChild;
    onLayoutChange({ ...node, children: newChildren });
  };

  return (
    <Allotment
      vertical={node.direction === 'vertical'}
      defaultSizes={node.sizes}
      onChange={handleSizesChange}
    >
      {node.children.map((child, index) => (
        <Allotment.Pane key={getNodeKey(child)}>
          <SplitLayout
            node={child}
            onSplit={onSplit}
            onClose={onClose}
            onTabDrop={onTabDrop}
            onLayoutChange={(updated) => handleChildLayoutChange(index, updated)}
          />
        </Allotment.Pane>
      ))}
    </Allotment>
  );
}
```

- [ ] **Step 3: 确认编译通过**

Run: `npx tsc --noEmit`
Expected: 无编译错误

- [ ] **Step 4: Commit**

```bash
git add src/components/SplitLayout.tsx
git commit -m "feat: SplitLayout 添加 onLayoutChange 回调传播分屏尺寸变化"
```

---

### Task 7: TerminalArea — 接入保存触发

**Files:**
- Modify: `src/components/TerminalArea.tsx`

- [ ] **Step 1: 添加 import**

在 `TerminalArea.tsx` 顶部的 store import 中添加 `saveLayoutToConfig`：

```typescript
import { useAppStore, genId, collectPtyIds, saveLayoutToConfig } from '../store';
```

- [ ] **Step 2: 在各操作函数末尾触发保存**

在 `handleNewTab` 的 `addTab(projectId, tab);` 之后添加：
```typescript
    saveLayoutToConfig(projectId);
```

在 `handleCloseTab` 的 `removeTab(projectId, tabId);` 之后添加：
```typescript
    saveLayoutToConfig(projectId);
```

在 `handleSplitPane` 的 `updateTabLayout(projectId, activeTab.id, newLayout);` 之后添加：
```typescript
      saveLayoutToConfig(projectId);
```

在 `handleTabDrop` 的 `removeTab(projectId, sourceTabId);` 之后添加：
```typescript
      saveLayoutToConfig(projectId);
```

在 `handleClosePane` 中，`updateTabLayout` 之后添加，以及 `handleCloseTab` 调用之后也会触发（已在 handleCloseTab 中处理）：
在 `updateTabLayout(projectId, activeTab.id, newLayout);` 之后添加：
```typescript
      saveLayoutToConfig(projectId);
```

- [ ] **Step 3: 添加 onLayoutChange 回调并传给 SplitLayout**

在 `TerminalArea` 组件内添加回调：

```typescript
  const handleLayoutChange = useCallback((updatedNode: SplitNode) => {
    const currentPs = useAppStore.getState().projectStates.get(projectId);
    const currentActiveTab = currentPs?.tabs.find((t) => t.id === currentPs.activeTabId);
    if (!currentActiveTab) return;
    updateTabLayout(projectId, currentActiveTab.id, updatedNode);
    saveLayoutToConfig(projectId);
  }, [projectId, updateTabLayout]);
```

将 `<SplitLayout>` 调用改为：
```tsx
<SplitLayout node={tab.splitLayout} onSplit={handleSplitPane} onClose={handleClosePane} onTabDrop={handleTabDrop} onLayoutChange={handleLayoutChange} />
```

- [ ] **Step 4: 确认编译通过**

Run: `npx tsc --noEmit`
Expected: 无编译错误

- [ ] **Step 5: Commit**

```bash
git add src/components/TerminalArea.tsx
git commit -m "feat: TerminalArea 在布局变化后触发保存"
```

---

### Task 8: App.tsx — 启动恢复 + beforeunload + 项目切换保存

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: 添加 import**

```typescript
import { restoreLayout, flushLayoutToConfig } from './store';
```

- [ ] **Step 2: 修改 `useEffect` 初始化逻辑，加入 restoreLayout**

在现有 `useEffect` 中，`useAppStore.setState(...)` 之后、`});` 之前添加异步恢复：

```typescript
      // 异步恢复各项目的终端布局（不阻塞 UI，恢复完成后 store 自动更新）
      Promise.all(
        cfg.projects
          .filter((p) => p.savedLayout && p.savedLayout.tabs.length > 0)
          .map((p) => restoreLayout(p.id, p.savedLayout!, p.path, cfg))
      ).catch(console.error);
```

- [ ] **Step 3: 添加 beforeunload 事件处理**

在 `App` 组件内、现有 `useEffect` 之后添加：

```typescript
  useEffect(() => {
    const handleBeforeUnload = () => {
      const { activeProjectId } = useAppStore.getState();
      if (activeProjectId) {
        flushLayoutToConfig(activeProjectId);
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);
```

- [ ] **Step 4: 在项目切换时保存当前项目布局**

找到 `setActiveProject` 的调用点。在 `ProjectList.tsx` 中切换项目时，布局已通过各操作的 `saveLayoutToConfig` 保存。但为确保最新状态被保存，在 `App.tsx` 中用 `useEffect` 监听 `activeProjectId` 变化：

在 `beforeunload` 的 useEffect 之后添加：

```typescript
  const prevProjectRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevProjectRef.current && prevProjectRef.current !== activeProjectId) {
      flushLayoutToConfig(prevProjectRef.current);
    }
    prevProjectRef.current = activeProjectId;
  }, [activeProjectId]);
```

- [ ] **Step 5: 确认编译通过**

Run: `npx tsc --noEmit`
Expected: 无编译错误

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx
git commit -m "feat: 启动时恢复终端布局，关闭/切换项目时保存"
```

---

### Task 9: 端到端验证

- [ ] **Step 1: 启动 Tauri 开发环境**

Run: `npm run tauri dev`

- [ ] **Step 2: 验证保存**

1. 新建一个终端 tab
2. 对 tab 进行分屏（横向/纵向）
3. 关闭应用
4. 检查 `%APPDATA%/Mini-Term/config.json` （或对应平台目录），确认 `savedLayout` 字段存在且包含正确的 tab/split 树结构

- [ ] **Step 3: 验证恢复**

1. 重新启动应用 (`npm run tauri dev`)
2. 确认之前的 tab 和分屏布局被恢复
3. 确认每个 pane 都有一个正常工作的 shell

- [ ] **Step 4: 验证错误降级**

1. 手动编辑 `config.json`，将某个 pane 的 `shellName` 改为不存在的名称
2. 启动应用，确认该 pane 使用 defaultShell 恢复（而非崩溃）

- [ ] **Step 5: 验证向后兼容**

1. 手动编辑 `config.json`，移除所有 `savedLayout` 字段
2. 启动应用，确认正常启动（无 tab，和之前行为一致）

- [ ] **Step 6: 运行 Rust 测试**

Run: `cd src-tauri && cargo test`
Expected: 所有测试通过

- [ ] **Step 7: Final commit（如有修复）**

```bash
git add -A
git commit -m "fix: 端到端验证修复"
```
