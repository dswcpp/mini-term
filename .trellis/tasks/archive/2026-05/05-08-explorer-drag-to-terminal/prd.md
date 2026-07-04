# feat: 资源管理器拖拽文件到终端粘贴路径

## Goal

支持从 Windows 资源管理器直接拖拽文件/文件夹到终端 pane，释放后将路径粘贴到终端输入——效果与从内部 FileTree 拖拽文件完全一致。

## What I already know

* Tauri `dragDropEnabled: true` 已启用（`tauri.conf.json:19`）
* `ProjectList.tsx:107` 已注册 `onDragDropEvent` 监听，处理拖入文件夹作为项目
* 内部 FileTree → Terminal 使用自定义鼠标事件拖拽（`fileDragState.ts`），绕过 WebView2 HTML5 DnD 拦截
* `App.tsx:91-100` 全局阻止了 HTML5 `dragover`/`drop` 事件（防止浏览器导航到拖入文件）
* Tauri `onDragDropEvent` 的 `payload.position` 返回物理像素坐标，需除以 `devicePixelRatio` 转换为逻辑坐标（`ProjectList.tsx:74`）
* TerminalInstance drop zone div 已有 `data-terminal-drop` 属性但无 ptyId 标识
* 写入终端使用 `writePtyInput(ptyId, text)`
* 现有内部拖拽路径格式：`'${path}'`（单引号包裹）

## Requirements

* 从资源管理器拖拽文件/文件夹到终端 pane 上方时，显示与内部拖拽相同的蓝色虚线 overlay（"释放以插入路径"）
* overlay 仅显示在光标所在的终端 pane 上（分屏场景下不影响其他 pane）
* 松手时光标不在任何终端 pane 上则忽略 drop
* 单文件：粘贴 `'path'` 格式路径
* 多文件：空格分隔，每个路径单引号包裹 `'path1' 'path2' 'path3'`
* 文件和文件夹统一处理，不区分
* 不影响现有 ProjectList 的拖入文件夹添加项目功能

## Acceptance Criteria

- [ ] 从资源管理器拖拽单个文件到终端，释放后路径以 `'path'` 格式插入
- [ ] 从资源管理器拖拽多个文件到终端，释放后路径以 `'path1' 'path2'` 格式插入
- [ ] 从资源管理器拖拽文件夹到终端，释放后路径以 `'path'` 格式插入
- [ ] 拖拽悬停在终端上方时显示蓝色虚线 overlay
- [ ] 分屏场景下 overlay 仅显示在光标所在 pane
- [ ] 光标不在终端 pane 上松手，不执行任何操作
- [ ] 现有 ProjectList 拖入文件夹功能正常
- [ ] 现有内部 FileTree 拖拽到终端功能正常

## Definition of Done

* Lint / typecheck / CI green
* 手动测试：单文件、多文件、文件夹、分屏、非终端区域释放

## Technical Approach

### 实现方案

1. **TerminalInstance** 的 drop zone div 添加 `data-pty-id={ptyId}` 属性
2. 新建或扩展状态管理，增加外部拖拽状态（当前悬停的 ptyId）
3. 在合适位置注册 `onDragDropEvent` 监听器：
   - `enter`/`over`：用 `elementFromPoint(x/scale, y/scale)` 查找最近的 `[data-pty-id]` 元素，更新悬停状态
   - `drop`：定位目标 pane → 拼接路径字符串 → `writePtyInput(ptyId, paths)` → focus 终端
   - `leave`/`cancel`：清除悬停状态
4. **TerminalInstance** 读取外部拖拽状态，与内部拖拽状态共同控制 overlay 显示

### 关键文件

* `src/components/TerminalInstance.tsx` — 添加 data-pty-id、读取外部拖拽状态显示 overlay
* `src/utils/fileDragState.ts` — 扩展外部拖拽状态管理
* `src/App.tsx` 或新建 hook — 注册 onDragDropEvent 终端区域处理

## Out of Scope

* 拖拽文件到 FileTree 区域的处理
* 拖拽文件内容（而非路径）到终端
* macOS / Linux 平台适配验证
