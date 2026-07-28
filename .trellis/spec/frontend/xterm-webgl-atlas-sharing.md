# xterm.js WebGL TextureAtlas 共享与 renderer 恢复契约

> 多个 `WebglAddon` 可能复用同一个 `TextureAtlas`，但每个终端拥有自己的 renderer
> model 与 GPU vertex buffer。atlas page add/remove 或 glyph 坐标变化后，所有共享
> 终端都需要重新调度渲染；终端 mount 或从不可见状态恢复时，只能重建**当前终端**的
> renderer model，不能清空共享 atlas。

## Scope / Trigger

修改以下任一位置时必须核对本规范：

- `src/utils/terminalCache.ts` 中 WebGL addon 的创建、释放、atlas 监听或渲染恢复；
- `src/components/TerminalInstance.tsx` 中 terminal mount、remount 或 visibility observer；
- `@xterm/xterm` / `@xterm/addon-webgl` 升级；
- WebGL context loss、分屏静置后乱码或重新挂载后的渲染问题。

## Current Signatures

以下签名来自当前 v0.8.3 源码：

```typescript
// src/utils/terminalCache.ts
function disposeWebgl(entry: CachedEntry): void;
function refreshAllTerminalsForAtlasChange(reason: 'add' | 'remove'): void;
export function resetRenderStateForPty(ptyId: number): void;
export function activateWebgl(ptyId: number): void;
```

`resetRenderStateForPty` 对 cache entry 或 WebGL addon 不存在的情况必须安全 no-op。
调用方不能访问 `CachedEntry`、renderer 私有字段或 addon 生命周期细节。

## Contract 1：Atlas add/remove 必须广播到全部缓存终端

每个新建的 `WebglAddon` 都必须监听两个 atlas canvas 事件，并将事件广播到 cache 中
所有终端：

```typescript
function refreshAllTerminalsForAtlasChange(reason: 'add' | 'remove'): void {
  for (const entry of cache.values()) {
    if (entry.term.rows > 0) {
      entry.term.refresh(0, entry.term.rows - 1);
    }
  }
}

const webgl = new WebglAddon();
webgl.onAddTextureAtlasCanvas(() => refreshAllTerminalsForAtlasChange('add'));
webgl.onRemoveTextureAtlasCanvas(() => refreshAllTerminalsForAtlasChange('remove'));
entry.term.loadAddon(webgl);
```

约束：

- 不能只 refresh 触发事件的终端；共享 atlas 变化会使其他 renderer 的缓存坐标失效；
- add 与 remove 都必须监听；不能假设只会新增 page；
- `term.refresh` 是 atlas 事件路径的广播动作，不得在该路径改成逐终端清 atlas；
- 不可见终端的 render service 可能暂停并延迟消费 refresh，因此仍需要可见性恢复契约。

## Contract 2：Mount / visibility 恢复只重建当前 renderer model

### 调用顺序

`src/components/TerminalInstance.tsx` 当前有两条恢复路径：

1. **mount / remount**：完成 `fit + resize_pty + refresh` 后，在下一帧调用
   `activateWebgl(ptyId)`，再下一帧调用 `resetRenderStateForPty(ptyId)`；
2. **visibility 恢复**：intersection 进入可见状态后，在下一帧执行 `fit + refresh`，
   随后调用 `resetRenderStateForPty(ptyId)`。

这两条路径必须调用 `resetRenderStateForPty`，不能直接调用
`webglAddon.clearTextureAtlas()`，也不能重新引入包装该调用的旧 helper。

### `resetRenderStateForPty` 的调用方语义

正常路径通过当前 addon 的 renderer 私有 `_clearModel(true)` 清空**当前 renderer**的
RenderModel 与 vertex buffer，然后 refresh 当前终端整屏：

```typescript
export function resetRenderStateForPty(ptyId: number): void {
  const entry = cache.get(ptyId);
  if (!entry?.webglAddon) return;

  const renderer = getCurrentRenderer(entry.webglAddon); // 说明性伪代码
  renderer._clearModel(true);
  entry.term.refresh(0, entry.term.rows - 1);
}
```

`getCurrentRenderer` 不是当前导出 API，上述片段只说明边界。调用方唯一允许使用的接口是
`resetRenderStateForPty(ptyId)`。

禁止在恢复路径清共享 atlas，原因是 `clearTextureAtlas()` 会改变所有共享终端依赖的
资源，却只同步当前 renderer；其他终端的 model / vertex buffer 仍可能指向旧坐标，且
该清理不会可靠地产生本项目监听的 add/remove 广播。

### 当前内部 fallback

当前实现为兼容 addon 私有 `_clearModel` 字段变化，仍在该字段不存在时使用一次
`clearTextureAtlas()` fallback，并记录 `clear-atlas-fallback`。这只是依赖升级失配时的
最后兜底，不是 mount / visibility 的公共契约：

- 调用方不得复制或直接触发 fallback；
- 日志出现 `clear-atlas-fallback` 时，应立即核对 addon 私有 renderer 结构；
- 升级验证必须确认正常路径仍命中 `clear-model`，而不是长期依赖 fallback。

## Contract 3：Context loss 必须复位 entry 并允许重新激活

`webglLoaded` 是 cache entry 的生命周期 guard。context loss 时如果只 dispose 回调中的
局部 `webgl`，该 flag 会保持 `true`，后续 `activateWebgl` 将直接返回，终端无法重新
尝试 WebGL。

当前正确路径统一调用 `disposeWebgl(entry)`：

```typescript
function disposeWebgl(entry: CachedEntry): void {
  if (entry.webglAddon) {
    try { entry.webglAddon.dispose(); } catch { /* already disposed */ }
    entry.webglAddon = undefined;
  }
  entry.webglLoaded = false;
}

webgl.onContextLoss(() => {
  disposeWebgl(entry);
  entry.term.refresh(0, entry.term.rows - 1);
});
```

契约：

- context loss 后 `webglAddon` 必须为空且 `webglLoaded === false`；
- 当前终端立即 refresh，以安全降级到可用 renderer；
- 回调内不递归创建 addon；之后再次进入 `activateWebgl(ptyId)` 时 guard 放行并重试；
- `loadWebgl` 创建或加载失败的 catch 路径同样必须把 `webglLoaded` 复位为 `false`；
- `disposeWebgl` 保持可重复调用，不因 addon 已 dispose 而抛出未处理异常。

## Validation & Error Matrix

| 现象 | 可能原因 | 必须检查 |
|---|---|---|
| 多个终端同时出现相同“换字”乱码 | atlas 变化只刷新事件源，其他 renderer 保留旧坐标 | add/remove 是否都广播全部 cache entry |
| 隐藏终端恢复后仍乱码，resize 才恢复 | visibility 路径只有 refresh，没有重建当前 model | 是否调用 `resetRenderStateForPty` |
| remount 一个终端后其他静置终端乱码 | 恢复路径调用了共享 `clearTextureAtlas()` | 删除直接清 atlas，改用 reset helper |
| context loss 后永久停留在降级 renderer | 只 dispose 局部 addon，`webglLoaded` 仍为 true | 统一调用 `disposeWebgl(entry)` |
| WebGL 首次加载失败后永不重试 | catch 未复位 loaded guard | catch 必须设置 `webglLoaded = false` |
| 日志出现 `clear-atlas-fallback` | addon 私有 `_renderer._clearModel` 不再可用 | 视为升级不兼容，复核实现而非复制 fallback |
| pane 已关闭时 reset 抛错 | helper 未处理 cache miss / disposed addon | cache miss 与 addon miss 必须安全 no-op |

## Good / Base / Bad Cases

- **Good**：atlas add/remove 广播 refresh；mount/visibility 只 reset 当前 renderer model；
  context loss 经 `disposeWebgl` 清 addon 并复位 loaded flag。
- **Base**：只依赖 atlas 广播；可见终端通常正常，但暂停期间未消费 refresh 的终端在
  恢复后仍可能保留旧 model，因此不完整。
- **Bad**：恢复当前终端时调用 `clearTextureAtlas`；只刷新事件源终端；context loss
  只 dispose 局部变量而不清 `webglLoaded`。

## Wrong vs Correct

### Wrong：恢复时清共享 atlas

```typescript
requestAnimationFrame(() => {
  entry.webglAddon?.clearTextureAtlas();
});
```

### Correct：只重建当前终端

```typescript
requestAnimationFrame(() => {
  resetRenderStateForPty(ptyId);
});
```

### Wrong：context loss 留下 stale guard

```typescript
webgl.onContextLoss(() => {
  webgl.dispose();
  entry.term.refresh(0, entry.term.rows - 1);
  // entry.webglLoaded 仍为 true，activateWebgl 无法重试。
});
```

### Correct：统一释放 entry 状态

```typescript
webgl.onContextLoss(() => {
  disposeWebgl(entry);
  entry.term.refresh(0, entry.term.rows - 1);
});
```

## Tests Required

1. **Atlas add/remove 广播**：构造多个 cache entry，触发任一 addon 的 add/remove，断言
   所有 `rows > 0` 的终端均收到整屏 refresh；
2. **Hidden → visible**：终端暂停期间触发 atlas 变化，恢复可见后断言调用
   `resetRenderStateForPty`，且正常路径不调用 `clearTextureAtlas`；
3. **Remount**：激活 WebGL 后才 reset 当前 model；其他共享终端不被 dispose 或清 atlas；
4. **Context loss**：断言 addon 被 dispose、entry addon 清空、`webglLoaded=false`，并
   refresh 当前终端；
5. **重新激活**：context loss 后再次调用 `activateWebgl`，断言 guard 放行并尝试创建
   新 addon；
6. **Load failure**：构造 addon 加载异常，断言 `webglLoaded` 回到 false；
7. **No-op**：cache entry 或 addon 已不存在时调用 reset，不抛异常；
8. **多终端手工回归**：分屏运行多个高输出终端并切换可见性，确认无同步换字乱码。

## Diagnostics / Upgrade Checklist

诊断开关：

```javascript
localStorage.setItem('miniterm.atlasDebug', '1');
localStorage.removeItem('miniterm.atlasDebug');
```

当前关键日志：

- `atlas-event`：add/remove 原因、cache 数量和各终端暂停状态；
- `clear-model`：当前终端 renderer model 正常重建；
- `clear-atlas-fallback`：私有 renderer API 失配告警。

升级 xterm 或 WebGL addon 前必须复核：共享 atlas 缓存方式、add/remove 事件语义、
renderer model 清理入口和 context-loss 生命周期。只有在源码与多终端回归共同证明契约
变化后，才能调整广播或 reset 行为。
