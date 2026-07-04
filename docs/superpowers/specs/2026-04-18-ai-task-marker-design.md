# AI 会话任务分段 Marker 设计

## 概述

在 AI 会话(Claude/Codex)中为每次用户发送(输入非空 + Enter)自动打一个 scrollback marker，并在 pane 右上角提供一个轻量下拉列表 + 全局快捷键，让用户可以快速跳回上一轮/下一轮的提问点，缓解长输出难以回看的问题。

对应 Issue: #12

## 设计决策

| 决策项 | 选择 |
|--------|------|
| 触发范围 | 仅 AI 会话(`is_ai_session(pty_id) == true`) |
| 触发事件 | 用户按 Enter 且 `take_line().trim()` 非空 |
| 同轮去重 | 不做(允许 ai-working 时再次 Enter 打断/追问,每次都 mark) |
| 展示形态 | pane 右上角按钮 + 下拉 marker 列表 |
| 快捷键 | `Ctrl+Alt+↑` / `Ctrl+Alt+↓` 跳转上/下一轮(对活跃 pane 生效) |
| 列表粒度 | 轻量:`#N · HH:MM · 输入首行截断(约 40 字)` |
| 进行中高亮 | 最后一个 marker 加黄点,表示"这一轮还没有下一个 marker 出现过" |
| 跳转反馈 | `term.scrollToLine()` 后在目标行做 ~300ms 淡黄背景闪烁 |
| 持久化 | 不持久化,pane 销毁/AI 会话退出后清除(保留 scrollback 内残留) |
| 历史范围 | 仅当前 pane 内从进入 AI 会话起累积的 markers |

## 状态模型

### 新增事件(Rust → 前端)

```rust
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiUserSubmitPayload {
    pty_id: u32,
    line: String,  // trim 后的用户输入原文
    ts: i64,       // epoch ms
}
```

事件名:`"ai-user-submit"`

### 前端类型

```typescript
// src/types.ts
export interface AiUserSubmitPayload {
  ptyId: number;
  line: string;
  ts: number;
}

export interface AiMarker {
  id: string;            // UUID,用于 React key 与 store 索引
  seq: number;           // 该 pane 内自增序号,从 1 开始(UI 显示 "#N")
  ptyId: number;
  line: string;          // 用户输入原文(trim 后)
  ts: number;            // epoch ms
  xtermMarkerId: number; // xterm IMarker.id,用于查找 module-local 缓存中的 IMarker 实例
  inProgress: boolean;   // 该 pane 内最后一个 marker 为 true,新 marker 到来时前一个翻 false
}
```

IMarker 实例本身不可序列化,不放 store。在 `src/utils/terminalCache.ts` 新增 module-local `markerInstancesByPty: Map<number, Map<number, IMarker>>`(外层 key 为 ptyId,内层 key 为 xterm IMarker id),用于跳转时查找实例。

### Store 新增

```typescript
interface AppState {
  markersByPty: Map<number, AiMarker[]>;
  addMarker: (payload: AiUserSubmitPayload, xtermMarkerId: number) => void;
  clearMarkersForPty: (ptyId: number) => void;
  getMarkersForPty: (ptyId: number) => AiMarker[];
}
```

`addMarker` 行为:
1. 取该 pty 的现有 list,将末尾(若存在)的 `inProgress` 置为 `false`
2. 追加新 marker,`seq = list.length + 1`,`inProgress = true`

## 数据流

```
用户在 AI pane 输入 "fix the bug" + Enter
  │
  ▼
write_pty command(已注入 AppHandle):
  ├─ write_pty_chunked(...) 写入 PTY
  ├─ state.track_input(pty_id, &data) —— 现有逻辑维持
  └─ state.emit_user_submit_if_needed(pty_id, &data, &app)
        ├─ 解析 data 中的 '\r'/'\n' 前的输入行(同 track_input 的字符语义)
        ├─ 若 self.is_ai_session(pty_id) 且 line.trim() 非空
        └─ app.emit("ai-user-submit", { ptyId, line, ts })
        │
        ▼
前端 hook useAiSubmitMarker:
  ├─ 收到事件,取 cached term
  ├─ 若 term 未 ready → 单次 requestAnimationFrame 重试,仍无则 warn 丢弃
  ├─ const marker = term.registerMarker(0)
  ├─ store.addMarker(payload, marker.id)
  └─ marker.onDispose(() => store.pruneDisposed(ptyId))
        │
        ▼
UI:
  ├─ PaneHeader 角标显示 markers.length
  ├─ 点击展开 <MarkerList/> 下拉
  └─ 列表项点击 → scrollToMarker(ptyId, id)
```

### 跳转实现

```typescript
// src/utils/terminalCache.ts
const markerInstancesByPty = new Map<number, Map<number, IMarker>>();

export function registerAiMarker(ptyId: number): IMarker | null {
  const cached = getCachedTerminal(ptyId);
  if (!cached) return null;
  const marker = cached.term.registerMarker(0);
  if (!marker) return null;
  let inner = markerInstancesByPty.get(ptyId);
  if (!inner) { inner = new Map(); markerInstancesByPty.set(ptyId, inner); }
  inner.set(marker.id, marker);
  marker.onDispose(() => inner!.delete(marker.id));
  return marker;
}

export function scrollToMarker(ptyId: number, xtermMarkerId: number): void {
  const cached = getCachedTerminal(ptyId);
  const marker = markerInstancesByPty.get(ptyId)?.get(xtermMarkerId);
  if (!cached || !marker || marker.isDisposed) return;
  cached.term.scrollToLine(marker.line);
  flashLine(cached.term, marker);
}

export function clearMarkerInstances(ptyId: number): void {
  markerInstancesByPty.delete(ptyId);
}
```

`flashLine(term, marker)` 实现:`term.registerDecoration({ marker, backgroundColor: 'rgba(245,197,24,0.33)' })`,`setTimeout(() => deco?.dispose(), 300)`。注意 decoration 的 marker 参数需传入一个 IMarker(可复用同一个 marker 实例);IMarker 与其 Decoration 的生命周期独立。

### 快捷键

在 `App.tsx` 挂载 `useMarkerHotkeys`,监听 `window` 级 `keydown`:
- `Ctrl+Alt+↑`:取活跃 pane 的 markers,定位到"上一次跳转位置"往上一个;若从未跳过,取最后一个 marker
- `Ctrl+Alt+↓`:反向(若已在最新,忽略)
- 非 AI pane 或 markers 为空时:不阻止事件默认行为,让 xterm 正常处理

关键实现细节:
- hook 内部用 `useRef<Map<ptyId, lastJumpedMarkerId>>` 记忆"上一次跳转位置",pane 销毁时不清(使用频率低,跨 pane 切换丢失影响小)
- keydown 匹配成功时 `e.preventDefault() + e.stopPropagation()`,防止 xterm 将组合键发送到 PTY
- 活跃 pane 的 ptyId 通过 selector 计算:`activeProjectId → activeTabId → splitLayout 深度优先找 leaf 的 activePaneId → 对应 PaneState.ptyId`,在 hook 顶部缓存到 ref,每次 store 变更时更新

## 新增/改动文件

| 文件 | 变更 |
|------|------|
| `src-tauri/src/pty.rs` | 新增方法 `PtyManager::emit_user_submit_if_needed(&self, pty_id, data, &AppHandle)`,write_pty command 在 `track_input` 后调用。保持 `track_input` 签名不变以兼容测试 |
| `src-tauri/src/pty.rs` 的 `write_pty` command | 新增 `app: tauri::AppHandle` 参数(Tauri 自动注入),调用 emit 方法 |
| `src/types.ts` | 新增 `AiUserSubmitPayload`、`AiMarker` |
| `src/store.ts` | 新增 `markersByPty`、`addMarker`、`clearMarkersForPty`、`getMarkersForPty`、`pruneDisposed`;`updatePtyIdByPane`/`removePty` 相关清理逻辑同步 |
| `src/utils/terminalCache.ts` | 新增 `scrollToMarker(ptyId, xtermMarkerId)` 和 `flashLine` 内部函数 |
| `src/hooks/useAiSubmitMarker.ts` | 新建:监听 `ai-user-submit`,调 `term.registerMarker()` + `store.addMarker` |
| `src/hooks/useMarkerHotkeys.ts` | 新建:全局 `Ctrl+Alt+↑/↓` 监听,驱动活跃 pane 跳转 |
| `src/components/MarkerList.tsx` | 新建:下拉列表组件,轻量渲染 `#N · HH:MM · line` + 进行中黄点 |
| `src/components/PaneGroup.tsx` | pane header 区域新增 `<MarkerMenuButton/>`,仅当 `markers.length > 0` 且该 pane 是 AI 会话时显示 |
| `src/App.tsx` | 挂载 `useAiSubmitMarker`、`useMarkerHotkeys` |

## 边界处理

- **粘贴多行**:粘贴内容中间含 `\r` 会被 pty.rs 逐字节分发,逐行触发 `ai-user-submit`。MVP 不做前端去重,观察实际体验后再决定是否对同 pty 内 `|Δts| < 200ms` 的事件合并
- **AI 会话退出**:退出时 `is_ai_session` 变 false,后续 Enter 不再发事件;已有 markers 保留到 pane 销毁(用户还能回看)
- **pane 销毁 / pty kill**:`store.clearMarkersForPty(ptyId)` 清理;xterm IMarker 会被自身 dispose
- **term 未 ready**:事件到达但 `getCachedTerminal(ptyId)` 为 null → 单次 rAF 重试,仍空则 `console.warn` 并丢弃(极罕见,pty 创建与 term 挂载之间有短暂窗口)
- **scrollback 上限**:xterm 默认 scrollback 行数有限,超出后行被丢,对应 IMarker 会 `isDisposed = true`。`pruneDisposed` 在每次 `addMarker` 时顺带过滤一次
- **分屏 pane 焦点判定**:活跃 pane 取 `store.getState().projects.get(activeProjectId).tabs.find(...).splitLayout` 中最近 focus 的 leaf。如果当前没有 focus 的 pane,快捷键不做任何事
- **非 AI pane 的按钮隐藏**:`<MarkerMenuButton/>` 仅在 `is_ai_session` 为 true 或 `markers.length > 0` 时渲染(退出 AI 后仍可回看本次残留)

## 测试

### Rust 侧(`src-tauri/src/pty.rs` 测试模块)

- `ai_user_submit_emitted_on_enter_in_ai_session`
- `ai_user_submit_not_emitted_when_line_empty`
- `ai_user_submit_not_emitted_outside_ai_session`
- `ai_user_submit_not_emitted_on_arrow_keys`
- `ai_user_submit_emitted_multiple_times_within_one_ai_working_window`(覆盖"追问"场景)

Mock 方式:`track_input` 接口保持纯函数特性,事件发送通过注入 trait object(或现有测试风格中已有的 mock emit)。若现有测试不方便注入 emit,退而求其次:新增内部函数 `should_emit_user_submit(&self, pty_id, line) -> bool`,对其单测。

### 前端(手动 + store 单测)

- `store.addMarker` 翻转 inProgress 的单测
- `store.pruneDisposed` 过滤 disposed marker 的单测
- UI/快捷键:手测(起 claude 输入 3 轮,验证列表、点击跳转、快捷键上下跳、闪烁)

## 范围边界(YAGNI)

不在本次实现:

- ❌ 跨重启持久化 marker
- ❌ 折叠长工具输出 / 命令输出
- ❌ AI 回复内容结构化解析
- ❌ "轻量视图"(只看用户输入 + 最终结论)
- ❌ 与 `AIHistoryPanel` 的联动(AIHistoryPanel 读本地 JSONL 历史,与当前 PTY marker 是不同域)
- ❌ Marker 搜索 / 过滤
- ❌ 把耗时、完成状态显示在列表上(`中等粒度`已弃)

这些项都可以作为后续独立 issue,不阻塞 MVP。
