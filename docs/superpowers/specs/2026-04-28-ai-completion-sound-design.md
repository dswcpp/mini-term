# AI 完成提示音功能设计

## 概述

在 AI 任务完成（`ai-working → ai-idle`）时播放提示音，支持默认系统合成音和自定义音频文件。同时将现有的 AI 完成通知设置（Toast 弹窗、任务栏闪烁）与提示音设置整合到统一的「AI 完成通知」板块中。

## 触发条件

- 状态变化：`ai-working → ai-idle`（与现有 toast/taskbar flash 同一检测点）
- 无论窗口/项目是否激活，都播放提示音

## 配置扩展

### Rust 后端 (`config.rs`)

`AppConfig` 新增两个字段：

```rust
#[serde(default = "default_true")]
pub ai_completion_sound: bool,

#[serde(default)]
pub ai_completion_sound_path: Option<String>,
```

- `ai_completion_sound`：开关，默认 `true`
- `ai_completion_sound_path`：自定义音频文件路径，`None` 表示使用内置合成音

### 前端类型 (`types.ts`)

`AppConfig` 接口新增：

```typescript
aiCompletionSound: boolean;
aiCompletionSoundPath?: string;
```

### Zustand Store (`store.ts`)

`config` 默认值新增：

```typescript
aiCompletionSound: true,
```

## 音频播放

### 工具函数 (`src/utils/notificationSound.ts`)

```typescript
export function playNotificationSound(soundPath?: string): void
```

**默认音（无 soundPath）**：使用 Web Audio API 合成一个短促的双音提示（类似 `ding-dong`），频率约 880Hz → 660Hz，每段约 100ms，总时长约 250ms。

**自定义音频（有 soundPath）**：通过 Tauri 的 `convertFileSrc` 将本地文件路径转为可访问 URL，使用 `HTMLAudioElement` 播放。支持 `.mp3`、`.wav`、`.ogg` 等浏览器支持的格式。

播放失败时静默处理（catch 错误不中断流程）。

### 触发点 (`store.ts`)

在 `updatePaneStatusByPty` 的 `isCompletion` 分支中，与 taskbar flash 同级调用：

```typescript
if (isCompletion) {
  // 提示音 — 不区分激活项目
  if (state.config.aiCompletionSound) {
    queueMicrotask(() => {
      playNotificationSound(state.config.aiCompletionSoundPath);
    });
  }

  // 任务栏闪烁（已有逻辑）...
  // Toast（已有逻辑）...
}
```

## 设置 UI 改造

### SystemSettings 中新增「AI 完成通知」板块

将现有的两个 AI 设置（弹框提醒、任务栏闪烁）从散落位置移到统一板块，并新增提示音设置：

```
AI 完成通知
├── AI 完成弹框提醒        [开关] （已有，移入）
├── AI 完成任务栏闪烁      [开关] （已有，移入）
├── AI 完成提示音          [开关] （新增）
│   └── 自定义提示音文件    [文件选择] + [试听]（开关开启时可用）
```

**自定义音频文件选择**：复用 Tauri 的 `openDialog`，筛选 `.mp3 / .wav / .ogg` 文件。选择后显示文件路径，并提供「清除」按钮恢复默认音。

**试听按钮**：调用 `playNotificationSound()` 立即播放当前配置的声音（默认音或自定义文件）。

## 涉及文件清单

| 文件 | 变更 |
|------|------|
| `src-tauri/src/config.rs` | 新增 `ai_completion_sound` + `ai_completion_sound_path` 字段及默认值 |
| `src/types.ts` | `AppConfig` 接口新增两个字段 |
| `src/store.ts` | config 默认值 + `updatePaneStatusByPty` 中调用 `playNotificationSound` |
| `src/utils/notificationSound.ts` | 新建，音频播放工具函数 |
| `src/components/SettingsModal.tsx` | SystemSettings 中重组 AI 完成通知板块，新增提示音开关/文件选择/试听 |
