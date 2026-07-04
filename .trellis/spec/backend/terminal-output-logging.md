# 终端输出日志

## 契约

`Log Terminal` 功能记录 Rust PTY reader flush 后的输出，不从前端 xterm 渲染层回采。

数据流:

```text
PTY reader -> 16ms flush -> terminal_log bounded queue -> background file writer
```

## 约束

- 日志写入必须通过 `src-tauri/src/terminal_log.rs` 的有界后台队列，禁止在 PTY reader / flush 热路径里直接阻塞写磁盘。
- 队列满时可以丢弃日志 chunk，不能阻塞终端输出、渲染或 PTY 退出事件。
- 配置字段统一由 `AppConfig` 承载:
  - `terminalLogEnabled`
  - `terminalLogPath`
  - `terminalLogMaxSizeMb`
- 后端按 `terminalLogMaxSizeMb` 轮转当前文件，历史文件用时间戳命名。
- `terminalLogPath` 为空时使用 app data 目录下的 `terminal.log`。

## 注意

日志保留原始终端输出，包括 ANSI 控制序列。不要在后端剥离 ANSI，否则日志无法作为原始终端输出诊断材料。
