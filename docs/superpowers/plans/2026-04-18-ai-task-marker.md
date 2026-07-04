# AI 会话任务分段 Marker 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 AI 会话(Claude/Codex)中,为用户每次按 Enter(输入非空)打一个 scrollback marker,并在 pane 右上角提供下拉 marker 列表 + 全局 Ctrl+Alt+↑/↓ 快捷键跳转,缓解长输出难回看的问题。

**Architecture:** Rust 端 `track_input` 在 Enter 命中 AI 会话时 push 到 `pending_submits` 队列;`write_pty` command 拿到注入的 `AppHandle` drain 并 emit `ai-user-submit` 事件。前端 hook 收事件后调 xterm `registerMarker` 并写入 store `markersByPty`。IMarker 实例保存在 `terminalCache.ts` 的 module-local map 用于跳转。UI 在 `PaneGroup` 右上角新增下拉按钮 + 全局快捷键。

**Tech Stack:** Rust(portable-pty, tauri v2), React 19, TypeScript, Zustand, xterm.js v6(IMarker / registerDecoration / scrollToLine API)

**Spec:** `docs/superpowers/specs/2026-04-18-ai-task-marker-design.md`

**Issue:** #12

---

## 文件结构

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/hooks/useAiSubmitMarker.ts` | 监听 `ai-user-submit` 事件,调 xterm `registerMarker()` + `store.addMarker` |
| `src/hooks/useMarkerHotkeys.ts` | 全局 `Ctrl+Alt+↑/↓` 监听,对活跃 pane 驱动上/下跳转 |
| `src/components/MarkerList.tsx` | 下拉列表组件,轻量渲染 `#N · HH:MM · line` + 进行中黄点 |

### 修改文件

| 文件 | 改动范围 |
|------|----------|
| `src-tauri/src/pty.rs` | 新增 `UserSubmit` 结构、`pending_submits` 字段、`drain_submits`;`track_input` 在 Enter 分支 push;`write_pty` 注入 `AppHandle` + emit;`kill_pty` 清理 |
| `src/types.ts` | 新增 `AiUserSubmitPayload`、`AiMarker` |
| `src/store.ts` | 新增 `markersByPty: Map<number, AiMarker[]>` + actions(`addMarker`/`clearMarkersForPty`/`pruneDisposed`/`getMarkersForPty`) |
| `src/utils/terminalCache.ts` | 新增 module-local `markerInstancesByPty` + `registerAiMarker` / `scrollToMarker` / `flashLine` / `clearMarkerInstances` |
| `src/components/PaneGroup.tsx` | pane header 右上角新增 `<MarkerMenuButton/>` 区域(markers 非空时显示) |
| `src/App.tsx` | 挂载 `useAiSubmitMarker()` 和 `useMarkerHotkeys()` |

---

## Task 1: 后端 — `UserSubmit` 结构与 `pending_submits` 基础设施

**Files:**
- Modify: `src-tauri/src/pty.rs`
- Test: `src-tauri/src/pty.rs`(文件末尾现有 `#[cfg(test)] mod tests`)

- [ ] **Step 1: 在 `pty.rs` 顶部新增 `UserSubmit` 结构**

在 `PtyOutputPayload` 后(约第 22 行)新增:

```rust
#[derive(Clone, Debug, PartialEq)]
pub struct UserSubmit {
    pub line: String,
    pub ts: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUserSubmitPayload {
    pub pty_id: u32,
    pub line: String,
    pub ts: i64,
}
```

- [ ] **Step 2: 给 `PtyManager` 结构体新增 `pending_submits` 字段**

找到 `PtyManager` 结构体(约第 243 行),在 `last_enter` 字段之后新增:

```rust
pending_submits: Arc<Mutex<HashMap<u32, Vec<UserSubmit>>>>,
```

在其 `new()` 方法里(约第 260 行)的 init block 中新增:

```rust
pending_submits: Arc::new(Mutex::new(HashMap::new())),
```

- [ ] **Step 3: 在 `impl PtyManager` 块内新增 `drain_submits` 方法**

在 `is_ai_session` 方法之后新增:

```rust
pub fn drain_submits(&self, pty_id: u32) -> Vec<UserSubmit> {
    self.pending_submits
        .lock()
        .unwrap()
        .remove(&pty_id)
        .unwrap_or_default()
}
```

- [ ] **Step 4: 写单测覆盖 drain 基本行为**

在 `#[cfg(test)] mod tests` 内找合适位置新增:

```rust
#[test]
fn drain_submits_returns_empty_initially() {
    let mgr = PtyManager::new();
    assert!(mgr.drain_submits(1).is_empty());
}

#[test]
fn drain_submits_clears_after_call() {
    let mgr = PtyManager::new();
    mgr.pending_submits
        .lock()
        .unwrap()
        .entry(1)
        .or_default()
        .push(UserSubmit { line: "test".into(), ts: 0 });
    let first = mgr.drain_submits(1);
    assert_eq!(first.len(), 1);
    let second = mgr.drain_submits(1);
    assert!(second.is_empty());
}
```

- [ ] **Step 5: 运行测试验证通过**

Run:
```bash
cd src-tauri && cargo test drain_submits 2>&1
```

Expected:两个测试 PASS。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/pty.rs
git commit -m "refactor: pty 新增 UserSubmit 结构与 pending_submits 队列基础设施

- 为后续 AI 会话用户提交事件准备数据结构
- drain_submits 提供单次取空语义,避免重复 emit
- 配套单测覆盖 drain 空态与取后清空"
```

---

## Task 2: 后端 — `track_input` 在 Enter 分支 push 到 pending

**Files:**
- Modify: `src-tauri/src/pty.rs`(`track_input` 方法内 `'\r' | '\n'` 分支)

- [ ] **Step 1: 阅读现有 `track_input` 的 Enter 分支**

`src-tauri/src/pty.rs:326` 附近:

```rust
'\r' | '\n' => {
    // 记录 Enter 时间,供输出扫描用
    self.last_enter
        .lock().unwrap()
        .insert(pty_id, Instant::now());
    let cmd = state.take_line().trim().to_lowercase();
    // ... 后续 enter_ai/exit_ai 逻辑
}
```

注意:现在 `take_line()` 在赋给 `cmd` 时就已经清空了 `state.line`,并且 `cmd` 被 `to_lowercase()` 转小写了。我们要的"用户输入原文"必须在 `take_line()` 时同步抓取(原始大小写 + trim)。

- [ ] **Step 2: 在 `'\r' | '\n'` 分支内改写取行逻辑**

将:

```rust
let cmd = state.take_line().trim().to_lowercase();
```

改为:

```rust
let raw = state.take_line();
let trimmed = raw.trim();
if !trimmed.is_empty() && self.is_ai_session(pty_id) {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    self.pending_submits
        .lock().unwrap()
        .entry(pty_id).or_default()
        .push(UserSubmit { line: trimmed.to_string(), ts });
}
let cmd = trimmed.to_lowercase();
```

保持原 `cmd` 变量以兼容下游 `enter_ai/exit_ai` 判断逻辑不被破坏。

- [ ] **Step 3: 写单测覆盖 push 行为**

在 `#[cfg(test)] mod tests` 内新增:

```rust
#[test]
fn track_input_does_not_submit_entering_command_itself() {
    // "claude\r" 本身是进入 AI 会话的命令,此时 is_ai_session 还是 false
    // 因为 ai_sessions.insert 发生在 Enter 分支的后续 enter_ai 处理中
    let mgr = PtyManager::new();
    mgr.track_input(1, "claude\r");
    assert!(mgr.drain_submits(1).is_empty());
    assert!(mgr.is_ai_session(1));       // 但会话状态已建立
}

#[test]
fn track_input_pushes_submit_in_ai_session() {
    let mgr = PtyManager::new();
    mgr.track_input(1, "claude\r");
    mgr.track_input(1, "fix the bug\r");
    let submits = mgr.drain_submits(1);
    assert_eq!(submits.len(), 1);
    assert_eq!(submits[0].line, "fix the bug");
    assert!(submits[0].ts > 0);
}

#[test]
fn track_input_no_submit_outside_ai_session() {
    let mgr = PtyManager::new();
    mgr.track_input(1, "npm install\r");
    assert!(mgr.drain_submits(1).is_empty());
}

#[test]
fn track_input_no_submit_on_empty_enter() {
    let mgr = PtyManager::new();
    mgr.track_input(1, "claude\r");
    mgr.track_input(1, "\r");            // 空回车
    mgr.track_input(1, "   \r");         // 仅空白
    assert!(mgr.drain_submits(1).is_empty());
}

#[test]
fn track_input_submits_multiple_in_working_window() {
    let mgr = PtyManager::new();
    mgr.track_input(1, "claude\r");
    mgr.track_input(1, "first question\r");
    mgr.track_input(1, "follow up\r");   // ai-working 中再次 Enter
    let submits = mgr.drain_submits(1);
    assert_eq!(submits.len(), 2);
    assert_eq!(submits[0].line, "first question");
    assert_eq!(submits[1].line, "follow up");
}

#[test]
fn track_input_no_submit_on_arrow_keys() {
    let mgr = PtyManager::new();
    mgr.track_input(1, "claude\r");
    mgr.track_input(1, "\x1b[A");        // 上方向键
    mgr.track_input(1, "\x1b[B");        // 下方向键
    assert!(mgr.drain_submits(1).is_empty());
}
```

- [ ] **Step 4: 运行测试验证通过**

Run:
```bash
cd src-tauri && cargo test track_input 2>&1
```

Expected:新增 5 个测试 PASS;原有所有 `track_input_*` 相关测试同样 PASS(兼容性验证)。

- [ ] **Step 5: 运行完整 pty 测试确认无回归**

```bash
cd src-tauri && cargo test --package mini-term-lib pty 2>&1
```

Expected:全部 PASS。若某个用例只检查 `is_ai_session`,不受影响。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/pty.rs
git commit -m "feat: track_input 在 AI 会话内 Enter 时收集用户提交

- 每次非空 Enter 且处于 AI 会话 → push UserSubmit 到 pending 队列
- 包含毫秒级时间戳和原始(trim 后)输入行
- 单测覆盖:AI 会话内、AI 会话外、空/空白回车、连续多次提交、方向键
- 保留原 cmd 变量以兼容 enter_ai/exit_ai 下游判断"
```

---

## Task 3: 后端 — `write_pty` 注入 AppHandle 并 emit 事件

**Files:**
- Modify: `src-tauri/src/pty.rs`(`write_pty` command,约第 634 行)
- Modify: `src-tauri/src/pty.rs`(`kill_pty` command,约第 680-690 行)

- [ ] **Step 1: 修改 `write_pty` 签名注入 AppHandle**

找到(约第 634 行):

```rust
#[tauri::command]
pub fn write_pty(
    state: tauri::State<PtyManager>,
    pty_id: u32,
    data: String,
) -> Result<(), String> {
    // ...
    state.track_input(pty_id, &data);
    Ok(())
}
```

改为:

```rust
#[tauri::command]
pub fn write_pty(
    app: tauri::AppHandle,
    state: tauri::State<PtyManager>,
    pty_id: u32,
    data: String,
) -> Result<(), String> {
    {
        let mut ptys = state.ptys.lock().map_err(|e| e.to_string())?;
        let instance = ptys.get_mut(&pty_id).ok_or("PTY not found")?;
        write_pty_chunked(&mut *instance.writer, &data)?;
    }
    state.track_input(pty_id, &data);

    for submit in state.drain_submits(pty_id) {
        let _ = app.emit("ai-user-submit", AiUserSubmitPayload {
            pty_id,
            line: submit.line,
            ts: submit.ts,
        });
    }
    Ok(())
}
```

(注:上面 block 内容保留你当前 write_pty 的原有写入逻辑;若已有 block 结构就保持,只在调 `track_input` 后新增 for 循环)

- [ ] **Step 2: 在 `kill_pty` 清理 pending_submits**

找到 `kill_pty`(约第 680 行),在现有 `state.ai_sessions.lock().unwrap().remove(&pty_id);` 之后新增:

```rust
state.pending_submits.lock().unwrap().remove(&pty_id);
```

- [ ] **Step 3: 手动编译验证**

Run:
```bash
cd src-tauri && cargo build 2>&1 | tail -30
```

Expected:`Compiling mini-term-lib` 完成,无错误。若有 `use` 缺失,补 `use tauri::Emitter;`(文件头已有)。

- [ ] **Step 4: 跑完整单测确认无回归**

```bash
cd src-tauri && cargo test 2>&1 | tail -20
```

Expected:所有测试 PASS。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/pty.rs
git commit -m "feat: write_pty emit ai-user-submit 事件 + kill_pty 清理队列

- write_pty 注入 AppHandle,调完 track_input 后 drain 并 emit
- kill_pty 清理 pending_submits 防止 pty 重建后旧数据串扰
- AiUserSubmitPayload 随事件发送 { ptyId, line, ts }"
```

---

## Task 4: 前端 — 类型与 store

**Files:**
- Modify: `src/types.ts`(文件末尾)
- Modify: `src/store.ts`

- [ ] **Step 1: `src/types.ts` 新增事件与 marker 类型**

在文件末尾新增:

```typescript
// === AI 任务分段 marker ===

export interface AiUserSubmitPayload {
  ptyId: number;
  line: string;
  ts: number;
}

export interface AiMarker {
  id: string;            // UUID,store 索引与 React key
  seq: number;           // 该 pane 内自增序号,UI 显示 "#N"
  ptyId: number;
  line: string;          // 用户输入原文(trim 后)
  ts: number;            // epoch ms
  xtermMarkerId: number; // xterm IMarker.id,用于查找 module-local 缓存
  inProgress: boolean;   // 最后一个 marker 为 true,新 marker 到来时前一个翻 false
}
```

- [ ] **Step 2: `src/store.ts` 导入 AiMarker 类型**

在顶部 `import type { ... } from './types';` 清单中新增 `AiMarker, AiUserSubmitPayload`。

- [ ] **Step 3: 在 AppState interface 里新增字段与 actions**

找到 `interface AppState {` 定义,在合适位置新增:

```typescript
markersByPty: Map<number, AiMarker[]>;
addMarker: (payload: AiUserSubmitPayload, xtermMarkerId: number) => string; // 返回新 marker.id
clearMarkersForPty: (ptyId: number) => void;
pruneDisposed: (ptyId: number, isDisposed: (xtermMarkerId: number) => boolean) => void;
getMarkersForPty: (ptyId: number) => AiMarker[];
```

- [ ] **Step 4: 在 store create 初始化里加入 `markersByPty: new Map()`**

找到 `create<AppState>((set, get) => ({`,在状态对象里新增 `markersByPty: new Map(),` 放在合适位置。

- [ ] **Step 5: 实现 actions**

在其他 action 旁边新增:

```typescript
addMarker: (payload, xtermMarkerId) => {
  const id = crypto.randomUUID();
  set((state) => {
    const next = new Map(state.markersByPty);
    const existing = next.get(payload.ptyId) ?? [];
    const updated = existing.map((m, idx) =>
      idx === existing.length - 1 ? { ...m, inProgress: false } : m
    );
    const marker: AiMarker = {
      id,
      seq: updated.length + 1,
      ptyId: payload.ptyId,
      line: payload.line,
      ts: payload.ts,
      xtermMarkerId,
      inProgress: true,
    };
    next.set(payload.ptyId, [...updated, marker]);
    return { markersByPty: next };
  });
  return id;
},

clearMarkersForPty: (ptyId) =>
  set((state) => {
    if (!state.markersByPty.has(ptyId)) return state;
    const next = new Map(state.markersByPty);
    next.delete(ptyId);
    return { markersByPty: next };
  }),

pruneDisposed: (ptyId, isDisposed) =>
  set((state) => {
    const list = state.markersByPty.get(ptyId);
    if (!list || list.length === 0) return state;
    const filtered = list.filter((m) => !isDisposed(m.xtermMarkerId));
    if (filtered.length === list.length) return state;
    const next = new Map(state.markersByPty);
    if (filtered.length === 0) next.delete(ptyId);
    else next.set(ptyId, filtered);
    return { markersByPty: next };
  }),

getMarkersForPty: (ptyId) => get().markersByPty.get(ptyId) ?? [],
```

- [ ] **Step 6: 在 pane 销毁路径挂 `clearMarkersForPty`**

找到 store 内 pane/pty 移除逻辑(搜 `closeTab` / `removePane` / 类似),定位到 pty 被 kill 的位置,补充调用:

```typescript
get().clearMarkersForPty(ptyId);
```

若现有 `removePane`/`closeTab` 已集中于一处调用 `invoke('kill_pty', ...)`,在同一处 append 即可。(具体位置需 grep `kill_pty` 确认,保持最小改动)

- [ ] **Step 7: TypeScript 编译检查**

```bash
npm run build 2>&1 | tail -30
```

Expected:无 TS 错误(会触发一次完整前端打包,可能慢 30s)。若不愿等完整打包,可 `npx tsc --noEmit 2>&1 | tail -20`。

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/store.ts
git commit -m "feat: store 新增 markersByPty 支持 AI 任务分段

- AiMarker/AiUserSubmitPayload 类型对齐 Rust 端事件 payload
- addMarker 自增 seq 并翻转上一个 marker 的 inProgress
- pruneDisposed 接受 isDisposed 回调,避免 store 依赖 xterm
- pane 销毁时调 clearMarkersForPty 防止内存泄漏"
```

---

## Task 5: 前端 — `terminalCache` 扩展 marker 实例管理与跳转

**Files:**
- Modify: `src/utils/terminalCache.ts`

- [ ] **Step 1: 在 `terminalCache.ts` 顶部 import IMarker 类型**

找到现有 xterm 相关 import,确保有:

```typescript
import type { Terminal, IMarker, IDecoration } from '@xterm/xterm';
```

(若已有 `Terminal` 导入,追加 `IMarker, IDecoration`)

- [ ] **Step 2: 新增 module-local marker 实例 map**

在文件顶部常量区新增:

```typescript
const markerInstancesByPty = new Map<number, Map<number, IMarker>>();

const FLASH_DECORATION_CSS_BG = 'rgba(245, 197, 24, 0.33)';
const FLASH_DURATION_MS = 300;
```

- [ ] **Step 3: 新增 `registerAiMarker`**

```typescript
export function registerAiMarker(ptyId: number): IMarker | null {
  const cached = getCachedTerminal(ptyId);
  if (!cached) return null;
  const marker = cached.term.registerMarker(0);
  if (!marker) return null;
  let inner = markerInstancesByPty.get(ptyId);
  if (!inner) {
    inner = new Map();
    markerInstancesByPty.set(ptyId, inner);
  }
  inner.set(marker.id, marker);
  marker.onDispose(() => {
    markerInstancesByPty.get(ptyId)?.delete(marker.id);
  });
  return marker;
}
```

- [ ] **Step 4: 新增 `scrollToMarker` + `flashLine`**

```typescript
export function scrollToMarker(ptyId: number, xtermMarkerId: number): void {
  const cached = getCachedTerminal(ptyId);
  const marker = markerInstancesByPty.get(ptyId)?.get(xtermMarkerId);
  if (!cached || !marker || marker.isDisposed) return;
  cached.term.scrollToLine(marker.line);
  flashLine(cached.term, marker);
}

function flashLine(term: Terminal, marker: IMarker): void {
  const deco: IDecoration | undefined = term.registerDecoration({
    marker,
    backgroundColor: FLASH_DECORATION_CSS_BG,
  });
  if (!deco) return;
  setTimeout(() => deco.dispose(), FLASH_DURATION_MS);
}
```

- [ ] **Step 5: 新增 `isMarkerDisposed` 与 `clearMarkerInstances`**

```typescript
export function isMarkerDisposed(ptyId: number, xtermMarkerId: number): boolean {
  const marker = markerInstancesByPty.get(ptyId)?.get(xtermMarkerId);
  return !marker || marker.isDisposed;
}

export function clearMarkerInstances(ptyId: number): void {
  markerInstancesByPty.delete(ptyId);
}
```

- [ ] **Step 6: 在现有 pty 清理路径调用 `clearMarkerInstances`**

搜 `terminalCache.ts` 里已有的 `disposeTerminal`(或类似函数名,处理 pty 销毁时释放 term 实例),在其内部末尾新增:

```typescript
clearMarkerInstances(ptyId);
```

(若 disposeTerminal 不存在,则在 `getCachedTerminal` 相关销毁分支里加;最小改动:只要在 cache 删除对应 ptyId 条目的同一处 append 即可)

- [ ] **Step 7: TypeScript 编译检查**

```bash
npx tsc --noEmit 2>&1 | tail -15
```

Expected:无错误。

- [ ] **Step 8: Commit**

```bash
git add src/utils/terminalCache.ts
git commit -m "feat: terminalCache 新增 AI marker 实例管理与跳转辅助

- markerInstancesByPty 保存不可序列化的 IMarker 实例,与 store 分离
- registerAiMarker 在光标位打点并挂 onDispose 自清理
- scrollToMarker 跳转后 flashLine 做 300ms 淡黄高亮提示
- clearMarkerInstances 配合 pane 销毁清空 map"
```

---

## Task 6: 前端 — `useAiSubmitMarker` hook

**Files:**
- Create: `src/hooks/useAiSubmitMarker.ts`

- [ ] **Step 1: 创建 hook 文件**

```typescript
import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useAppStore } from '../store';
import { registerAiMarker, isMarkerDisposed } from '../utils/terminalCache';
import type { AiUserSubmitPayload } from '../types';

export function useAiSubmitMarker() {
  const addMarker = useAppStore((s) => s.addMarker);
  const pruneDisposed = useAppStore((s) => s.pruneDisposed);

  useEffect(() => {
    let cancelled = false;

    const unlistenPromise = listen<AiUserSubmitPayload>('ai-user-submit', (event) => {
      if (cancelled) return;
      const payload = event.payload;

      const tryRegister = (retry: boolean) => {
        const marker = registerAiMarker(payload.ptyId);
        if (marker) {
          addMarker(payload, marker.id);
          pruneDisposed(payload.ptyId, (id) => isMarkerDisposed(payload.ptyId, id));
          return;
        }
        if (retry) {
          requestAnimationFrame(() => tryRegister(false));
        } else {
          console.warn('[ai-submit-marker] term not ready for pty', payload.ptyId);
        }
      };

      tryRegister(true);
    });

    return () => {
      cancelled = true;
      void unlistenPromise.then((fn) => fn());
    };
  }, [addMarker, pruneDisposed]);
}
```

- [ ] **Step 2: TypeScript 编译检查**

```bash
npx tsc --noEmit 2>&1 | tail -10
```

Expected:无错误。

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useAiSubmitMarker.ts
git commit -m "feat: 新增 useAiSubmitMarker hook 监听 ai-user-submit 事件

- 收到事件后尝试注册 xterm marker,term 未 ready 时 rAF 重试一次
- 同时 prune 已 disposed 的历史 marker,防止 scrollback 溢出污染列表"
```

---

## Task 7: 前端 — `useMarkerHotkeys` hook

**Files:**
- Create: `src/hooks/useMarkerHotkeys.ts`

- [ ] **Step 1: 创建 hook 文件**

```typescript
import { useEffect, useRef } from 'react';
import { useAppStore } from '../store';
import { scrollToMarker } from '../utils/terminalCache';
import type { SplitNode } from '../types';

function findActivePaneId(node: SplitNode): string | null {
  if (node.type === 'leaf') return node.activePaneId || null;
  for (const child of node.children) {
    const id = findActivePaneId(child);
    if (id) return id;
  }
  return null;
}

function findPtyIdByPaneId(node: SplitNode, paneId: string): number | null {
  if (node.type === 'leaf') {
    const pane = node.panes.find((p) => p.id === paneId);
    return pane?.ptyId ?? null;
  }
  for (const child of node.children) {
    const id = findPtyIdByPaneId(child, paneId);
    if (id != null) return id;
  }
  return null;
}

export function useMarkerHotkeys() {
  const lastJumpRef = useRef<Map<number, string>>(new Map());

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.altKey || e.shiftKey || e.metaKey) return;
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;

      const state = useAppStore.getState();
      const activeProjectId = state.activeProjectId;
      if (!activeProjectId) return;
      const ps = state.projectStates.get(activeProjectId);
      if (!ps) return;
      const tab = ps.tabs.find((t) => t.id === ps.activeTabId);
      if (!tab) return;
      const paneId = findActivePaneId(tab.splitLayout);
      if (!paneId) return;
      const ptyId = findPtyIdByPaneId(tab.splitLayout, paneId);
      if (ptyId == null) return;

      const markers = state.getMarkersForPty(ptyId);
      if (markers.length === 0) return;

      const lastId = lastJumpRef.current.get(ptyId);
      const lastIdx = lastId ? markers.findIndex((m) => m.id === lastId) : markers.length;
      const dir = e.key === 'ArrowUp' ? -1 : +1;

      let nextIdx: number;
      if (lastId && lastIdx >= 0) {
        nextIdx = lastIdx + dir;
      } else {
        nextIdx = dir === -1 ? markers.length - 1 : 0;
      }
      if (nextIdx < 0 || nextIdx >= markers.length) return;

      e.preventDefault();
      e.stopPropagation();
      const target = markers[nextIdx];
      lastJumpRef.current.set(ptyId, target.id);
      scrollToMarker(ptyId, target.xtermMarkerId);
    };

    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, []);
}
```

- [ ] **Step 2: 确认 store 对外暴露的字段名**

hook 中引用了 `state.activeProjectId` 和 `state.projectStates` —— 若实际 store 中字段名不同(比如 `activeProject` 或 `projects`),到 `src/store.ts` 搜确认后改 hook 内字段名保持一致。

Run:
```bash
npx tsc --noEmit 2>&1 | tail -15
```

Expected:若字段名不一致,TS 会报错,按报错提示修正。

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useMarkerHotkeys.ts
git commit -m "feat: 新增 useMarkerHotkeys hook 全局跳转快捷键

- Ctrl+Alt+↑/↓ 对活跃 pane 的 AI marker 列表上下跳
- capture 阶段监听 + preventDefault 避免被 xterm 转发到 PTY
- lastJumpRef 记住每个 pty 上次跳到的位置,支持连续翻页"
```

---

## Task 8: 前端 — `MarkerList` 组件

**Files:**
- Create: `src/components/MarkerList.tsx`

- [ ] **Step 1: 创建组件**

```typescript
import type { AiMarker } from '../types';
import { scrollToMarker } from '../utils/terminalCache';

interface Props {
  ptyId: number;
  markers: AiMarker[];
  onClose: () => void;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function truncate(s: string, max = 40): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

export function MarkerList({ ptyId, markers, onClose }: Props) {
  if (markers.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-[var(--text-muted)]">
        暂无标记
      </div>
    );
  }
  return (
    <div className="max-h-80 overflow-y-auto py-1 min-w-[280px]">
      {markers.map((m) => (
        <button
          key={m.id}
          className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-[var(--bg-hover)]"
          title={m.line}
          onClick={() => {
            scrollToMarker(ptyId, m.xtermMarkerId);
            onClose();
          }}
        >
          <span className="text-[var(--text-muted)] tabular-nums w-8">#{m.seq}</span>
          <span className="text-[var(--text-muted)] tabular-nums w-10">{formatTime(m.ts)}</span>
          <span className="flex-1 truncate">{truncate(m.line)}</span>
          {m.inProgress && (
            <span
              className="w-1.5 h-1.5 rounded-full shrink-0"
              style={{ background: 'var(--color-ai-working)' }}
              aria-label="正在进行"
            />
          )}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: TypeScript 检查**

```bash
npx tsc --noEmit 2>&1 | tail -10
```

Expected:无错误。

- [ ] **Step 3: Commit**

```bash
git add src/components/MarkerList.tsx
git commit -m "feat: 新增 MarkerList 下拉列表组件

- 轻量呈现 #N · HH:MM · line 三列,line 超 40 字截断并 tooltip 完整文本
- 最后一条显示黄色小圆点表示"进行中"
- 点击条目跳转并关闭面板"
```

---

## Task 9: 前端 — `PaneGroup` 接入 marker 菜单按钮

**Files:**
- Modify: `src/components/PaneGroup.tsx`

- [ ] **Step 1: 阅读现有 PaneGroup header 结构**

Run:
```bash
npx grep -n "pane.*header\|tab.*bar\|shellName" D:/Git/mini-term/src/components/PaneGroup.tsx 2>&1 | head -20
```

定位到 pane 标题栏/tabbar 区域(通常在 JSX 顶部)。目标是在该区域右侧追加一个按钮。

- [ ] **Step 2: 在 PaneGroup 顶部 import 新依赖**

```typescript
import { useState, useRef, useEffect } from 'react';
import { MarkerList } from './MarkerList';
import { useAppStore } from '../store';
```

(注意:只加缺少的;`useRef`/`useEffect`/`useState` 若已 import 合并即可)

- [ ] **Step 3: 在组件内取 markers 并渲染按钮**

假设 PaneGroup 已从 props 拿到 `pane`(含 `ptyId`)或能获取到当前活跃 pane 的 ptyId。在 header JSX 右侧、关闭按钮之前插入:

```tsx
const [markerOpen, setMarkerOpen] = useState(false);
const markers = useAppStore(
  (s) => s.markersByPty.get(activePane.ptyId) ?? []
);
const popoverRef = useRef<HTMLDivElement>(null);

useEffect(() => {
  if (!markerOpen) return;
  const onDoc = (e: MouseEvent) => {
    if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
      setMarkerOpen(false);
    }
  };
  document.addEventListener('mousedown', onDoc);
  return () => document.removeEventListener('mousedown', onDoc);
}, [markerOpen]);

// ... JSX 里在原 header 右侧的操作按钮区新增:
{markers.length > 0 && (
  <div className="relative" ref={popoverRef}>
    <button
      className="px-1.5 py-0.5 text-xs rounded hover:bg-[var(--bg-hover)] flex items-center gap-1"
      onClick={() => setMarkerOpen((v) => !v)}
      title="AI 任务标记"
    >
      <span>⚑</span>
      <span className="tabular-nums">{markers.length}</span>
    </button>
    {markerOpen && (
      <div
        className="absolute right-0 top-full mt-1 z-20 rounded-md border shadow-lg"
        style={{
          background: 'var(--bg-elevated)',
          borderColor: 'var(--border-default)',
        }}
      >
        <MarkerList
          ptyId={activePane.ptyId}
          markers={markers}
          onClose={() => setMarkerOpen(false)}
        />
      </div>
    )}
  </div>
)}
```

(若 `activePane` 变量名不同,改成你文件中实际的变量;目标是拿到当前聚焦 pane 的 `ptyId`)

- [ ] **Step 4: TypeScript + 前端编译**

```bash
npx tsc --noEmit 2>&1 | tail -10
```

Expected:无错误。

- [ ] **Step 5: Commit**

```bash
git add src/components/PaneGroup.tsx
git commit -m "feat: PaneGroup 右上角新增 AI 任务标记下拉按钮

- 仅当当前 pane 累积 markers > 0 时显示
- 点击外部区域自动关闭,避免遮挡终端
- 按钮文案 '⚑ N' 一目了然当前累积条数"
```

---

## Task 10: 前端 — `App.tsx` 挂载 hooks + 手测验证

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: 挂载两个 hook**

在 `App` 组件顶部新增:

```typescript
import { useAiSubmitMarker } from './hooks/useAiSubmitMarker';
import { useMarkerHotkeys } from './hooks/useMarkerHotkeys';
```

在组件函数体内,与其他 `useTauriEvent(...)` 调用并列:

```typescript
useAiSubmitMarker();
useMarkerHotkeys();
```

- [ ] **Step 2: 启动 dev 环境**

```bash
npm run tauri dev
```

等待窗口启动。

- [ ] **Step 3: 手测清单**

按以下步骤逐一验证并勾选:

- [ ] 打开一个项目 → 新建 Tab → 在 pane 里执行 `claude`(或 `codex`)进入 AI 会话
- [ ] 右上角暂时没有 ⚑ 按钮(markers 为空)
- [ ] 输入 `hello, what day is today?` + Enter → 右上角出现 `⚑ 1`,点击展开看到 `#1 · HH:MM · hello, what day is today?`,条目末尾有黄色圆点
- [ ] AI 还在回复时,再输入 `wait, also include tomorrow` + Enter → `⚑ 2`,上一条黄点消失,新条目显示黄点
- [ ] 点击列表第一项 → 终端滚到对应行并出现 ~300ms 淡黄闪烁
- [ ] 按 `Ctrl+Alt+↑` / `Ctrl+Alt+↓` → 在两条 marker 间跳转
- [ ] 只按 Enter(空行) → marker 数不增加
- [ ] 使用方向键编辑 shell 历史 → marker 数不增加
- [ ] 粘贴多行包含 `\r` 的文本 → 每一行产生一条 marker(观察预期行为,若觉得过多再议)
- [ ] 退出 AI 会话(如 `/exit`) → 现有 markers 保留可点击跳转
- [ ] 关闭 Tab / 关闭 pane → 下次新开 AI 会话 markers 从 0 重新开始

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "feat: App 挂载 useAiSubmitMarker 与 useMarkerHotkeys

- 完成 Issue #12 AI 任务分段 marker 功能接入
- 手测通过:打点/跳转/快捷键/空行过滤/粘贴多行/退出 AI 保留"
```

---

## Task 11: 版本号更新(可选,若希望一并发版)

**Files:**
- Modify: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `README.md`

此步仅在用户明确"发版"时执行,参考 `feedback_release_workflow`:三个版本文件同步更新 + README 徽章更新 + Cargo.lock 跟随。

非发版场景跳过。

---

## 完成标准

- [ ] 所有 Rust 单测 PASS(`cd src-tauri && cargo test`)
- [ ] TypeScript 编译通过(`npx tsc --noEmit`)
- [ ] 手测清单(Task 10 Step 3)全部勾选
- [ ] 11 个 commit(或按用户偏好合并为更少的大 commit)
- [ ] Issue #12 可关闭,在 PR/commit 中引用 `Closes #12`
