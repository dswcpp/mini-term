# Fluent 2 + backdrop-filter：Modal Portal Convention

> Fluent 2 的 `[data-panel]` 容器会使用 `backdrop-filter` 实现 acrylic 效果。
> 按 CSS containing block 规则，这类祖先可能让后代的 `position: fixed` 不再相对
> viewport 定位。全屏 modal 或 overlay 必须通过 `createPortal(..., document.body)`
> 脱离该祖先，而不能内联渲染在 panel 子树中。

## Scope / Trigger

新增或修改满足任一条件的覆盖层时，必须读本规范：

- 使用 `position: fixed`、`inset: 0` 或其他 viewport 级定位；
- 可能位于 `[data-panel]`、`backdrop-filter`、`transform`、`filter`、
  `perspective`、`will-change` 或 `contain` 祖先之下；
- 需要处理 Escape、遮罩关闭、嵌套覆盖层、焦点陷阱或关闭后的焦点还原；
- 使用命令式 DOM 创建 alert / confirm / prompt。

当前 React modal 的参考实现是 `src/components/Modal.tsx`。新业务弹窗优先复用该组件，
而不是复制 portal、键盘监听和焦点管理逻辑。

## CSS Containing Block Contract

下列任一非默认祖先属性都可能为后代 `position: fixed` 建立 containing block：

- `backdrop-filter`；
- `transform`、`filter`、`perspective`；
- `will-change: transform | filter | perspective | backdrop-filter`；
- `contain: paint | layout | strict | content`。

因此，内联的 `fixed inset-0` 可能只覆盖最近的 panel，而不是整个 viewport。不能根据
当前组件“恰好位于 App 顶层”来省略 portal；DOM 层级或皮肤样式变化后该假设会失效。

## React Modal Contract

`src/components/Modal.tsx` 是当前可执行参考，核心边界如下：

```tsx
import { createPortal } from 'react-dom';

export function Modal({ open, onClose, children, ...props }: ModalProps) {
  // 省略：overlay stack、Escape、遮罩、焦点陷阱与焦点还原逻辑。
  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50">
      <div role="dialog" aria-modal="true" tabIndex={-1}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
```

上面是对现有结构的缩略说明，不是可替代 `Modal.tsx` 的新实现。调用方必须复用共享
`Modal`，并遵守以下契约：

1. `open === false` 时不渲染 modal；打开时 portal 根节点必须进入 `document.body`；
2. 打开时 `pushOverlay('modal')`，清理 effect 时以返回的 id 调用 `popOverlay(id)`；
3. Escape 及 Tab 处理前必须用 `isTopOverlay(id)` 确认当前层位于栈顶；
4. 打开后的下一帧优先聚焦第一个可用 input / textarea，否则聚焦 dialog panel；
5. Tab / Shift+Tab 必须在 dialog 内环形移动，不能把焦点泄漏到背景界面；
6. 关闭或卸载时取消待执行的 animation frame、移除 capture keydown listener、出栈，
   并尝试把焦点还原到打开前的元素；
7. `closeOnOverlay` 开启时，只允许遮罩自身的 `mousedown` 触发关闭；从 panel 内开始的
   文本选择或拖动不得误关 modal；
8. dialog 必须提供 `role="dialog"`、`aria-modal="true"`，并通过标题或 `ariaLabel`
   提供可访问名称。

## Imperative Prompt Contract

`src/utils/prompt.ts` 的 alert / confirm / prompt 不经过 React portal，但同样必须把 root
overlay 直接 append 到 `document.body`，并与 React modal 共用
`src/utils/overlayStack.ts`。所有关闭路径（按钮、遮罩、Enter、Escape）必须收敛到同一个
幂等 `close()`：

```typescript
const previousFocus = document.activeElement as HTMLElement | null;
const overlayId = pushOverlay('prompt');
let closed = false;

const close = () => {
  if (closed) return;
  closed = true;
  popOverlay(overlayId);
  window.removeEventListener('keydown', keyHandler, true);
  overlay.remove();
  previousFocus?.focus?.();
};
```

命令式 prompt 还必须满足：

- 注册在 `window` capture phase 的 keydown listener，cleanup 使用完全相同的
  target、event name、handler 和 capture 参数；
- key handler 首先检查 `closed || !isTopOverlay(overlayId)`，只有栈顶层响应
  Enter、Escape 和 Tab；
- Tab / Shift+Tab 在 prompt 可聚焦元素之间环形移动；
- 先完成 cleanup，再 resolve Promise，避免回调同步打开下一层时旧层仍占据栈顶；
- `showPrompt` 必须区分空字符串与取消：确认空输入返回 `''`，取消返回 `null`。

## Validation & Error Matrix

| 现象 | 原因 | 修复 |
|---|---|---|
| modal 被限制在侧栏或 panel 内 | `fixed` 元素仍内联在 containing-block 祖先下 | 复用 `Modal`，确保 `createPortal(..., document.body)` |
| 上层 prompt 打开时 Escape 关闭了下层 modal | handler 未检查共享 overlay stack 的栈顶 id | 所有覆盖层使用 `pushOverlay` / `isTopOverlay` / `popOverlay` |
| 关闭后按 Enter 仍触发旧回调 | 某条关闭路径未移除 capture keydown listener | 所有路径收敛到幂等 `close()` |
| 多次调用 close 导致栈状态或 DOM 异常 | cleanup 非幂等 | 在 cleanup 首行使用 `closed` guard；`popOverlay` 也保持幂等 |
| 打开 modal 后焦点仍停留在背景 | 未在渲染完成后聚焦 panel 内元素 | 下一帧聚焦第一个输入框或 panel |
| Tab 可进入背景页面 | 未实现环形 focus trap | 对首尾可聚焦元素处理 Tab / Shift+Tab |
| 关闭后键盘焦点丢到 body | 未保存或还原原活动元素 | 打开前保存 `document.activeElement`，cleanup 时还原 |
| 在 panel 内按下并拖到遮罩松开导致误关 | 使用冒泡 click 判断或未检查事件 target | 使用遮罩 `mousedown` 且要求 `target === currentTarget` |

## Good / Base / Bad Cases

- **Good**：业务弹窗复用共享 `Modal`；imperative prompt 直接挂到 body；两者使用同一
  overlay stack，并完整处理清理、栈顶判断和焦点生命周期。
- **Base**：独立覆盖层正确 portal 到 body，但重复实现一套键盘或焦点逻辑；功能可能
  暂时可用，却容易与共享栈行为漂移，应优先收敛到 `Modal`。
- **Bad**：在 panel 子树内内联 `fixed inset-0`；每次打开新增全局 listener 却只在
  Escape 路径移除；嵌套覆盖层不判断栈顶就响应快捷键。

## Wrong vs Correct

### Wrong

```tsx
function PanelContent() {
  const [open, setOpen] = useState(false);
  return (
    <div data-panel>
      <button onClick={() => setOpen(true)}>打开</button>
      {open && (
        <div className="fixed inset-0 z-50">
          {/* 错：该节点可能被 data-panel 的 containing block 限制。 */}
          <section>...</section>
        </div>
      )}
    </div>
  );
}
```

### Correct

```tsx
import { Modal } from './Modal';

function PanelContent() {
  const [open, setOpen] = useState(false);
  return (
    <div data-panel>
      <button onClick={() => setOpen(true)}>打开</button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="示例弹窗"
        panelClassName="w-[640px] max-h-[80vh]"
      >
        <div className="p-5">...</div>
      </Modal>
    </div>
  );
}
```

`Modal` 的 JSX 虽由调用方写在 panel 子树中，实际 DOM 会由
`createPortal(..., document.body)` 挂到 body，因此不受 panel containing block 限制。

## Tests Required

1. **Portal target**：打开共享 `Modal`，断言 dialog 的 overlay 根节点位于
   `document.body`，而不是调用方 panel DOM 下；
2. **Fluent 2 visual smoke**：从深层 `[data-panel]` 子树打开 modal，确认遮罩覆盖整个
   viewport，dialog 未被侧栏裁剪；
3. **Stack order**：在 React modal 上再打开 imperative confirm，第一次 Escape 只关闭
   confirm，第二次才关闭底层 modal；
4. **Listener cleanup**：分别通过按钮、遮罩、Enter、Escape 关闭 prompt，确认不会残留
   keydown handler，也不会重复 resolve；
5. **Focus lifecycle**：打开后焦点进入 dialog；Tab 不离开；关闭后回到触发元素；
6. **Backdrop semantics**：在 panel 内按下并拖到遮罩松开不关闭，直接按下遮罩才按
   `closeOnOverlay` 配置决定是否关闭；
7. **Accessibility**：dialog 具有 `role="dialog"`、`aria-modal="true"` 和可访问名称。

## Related

- `src/components/Modal.tsx`：React modal、body portal、焦点陷阱与清理参考
- `src/utils/prompt.ts`：命令式 prompt 的幂等 cleanup 与焦点还原参考
- `src/utils/overlayStack.ts`：跨 React / imperative 覆盖层的共享栈
- `src/fluent2.css`：`[data-panel]` 的 backdrop-filter 来源
- MDN: [Layout and the containing block](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_display/Containing_block)
