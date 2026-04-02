<p align="center">
  <img src="src-tauri/icons/icon.png" width="128" height="128" alt="Mini-Term Logo">
</p>

<h1 align="center">Mini-Term</h1>

<p align="center">
  <strong>为 AI 时代打造的桌面终端管理器</strong><br>
  基于 Tauri v2 · 多项目 · 多标签 · 分屏布局 · AI 进程感知
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.9-blue" alt="version">
  <img src="https://img.shields.io/badge/platform-Windows-lightgrey" alt="platform">
  <img src="https://img.shields.io/badge/Tauri-v2-orange" alt="tauri">
  <img src="https://img.shields.io/badge/React-19-61dafb" alt="react">
  <img src="https://img.shields.io/badge/Rust-2021-dea584" alt="rust">
</p>

---

## 解决痛点

1. **重量级工具多余** — All In AI 的用户只需要终端跑 Agent，却不得不打开 VS Code / IDEA 等重型 IDE，大且占内存
2. **多 Agent 并发无感知** — 同时开多个 Claude / Codex 会话，某个 Agent 跑完了无法直观看到
3. **项目切换不便** — 系统终端缺少多项目组织、标签页和分屏管理能力

Mini-Term 用一个轻量桌面应用解决以上所有问题。

## 预览

<!-- 主界面截图：展示三栏布局（项目列表 | 文件树 | 终端区域） -->
<!-- ![主界面](docs/screenshots/main.png) -->
> 截图待补充

## 功能特性

### 终端核心

- **多标签管理** — 每个项目独立标签页，拖拽排序，状态图标一目了然
- **递归分屏** — 横向 / 纵向任意嵌套分屏，Allotment 拖拽调整比例
- **高性能渲染** — xterm.js v6 + WebGL 加速，自动降级为 Canvas
- **10 万行滚动缓冲** — 大量日志输出也不丢失
- **终端缓存** — 切换标签 / 分屏不丢失已有内容
- **快捷键** — Ctrl+Shift+C/V 复制粘贴，文件拖拽到终端自动插入路径

<!-- 分屏截图：展示多层嵌套分屏 -->
<!-- ![分屏布局](docs/screenshots/split.png) -->

### AI 进程感知

- **实时状态检测** — 自动识别终端中运行的 Claude / Codex，显示 idle / working / error 状态
- **状态聚合** — 从单个面板 → 标签页 → 项目级别逐层聚合，优先级 `error > ai-working > ai-idle > idle`
- **会话历史** — 读取本地 Claude / Codex 历史会话记录，右键复制恢复命令快速续接

<!-- AI 状态截图：展示不同状态的 StatusDot -->
<!-- ![AI 状态](docs/screenshots/ai-status.png) -->

### 项目管理

- **项目列表** — 左侧边栏管理多个项目目录，一键切换工作区
- **嵌套分组** — 最多 3 级项目分组，拖拽排序，折叠 / 展开
- **文件树** — 集成目录浏览器，自动过滤 `.gitignore` 条目，文件监听实时刷新

<!-- 项目列表截图：展示嵌套分组 -->
<!-- ![项目管理](docs/screenshots/projects.png) -->

### Git 集成

- **文件状态** — 文件树显示 Git 状态颜色（修改 / 新增 / 删除 / 冲突）
- **变更 Diff** — 查看工作区文件变更的详细 Diff
- **提交历史** — 浏览仓库提交记录，支持游标分页加载
- **提交 Diff** — 查看任意提交的文件变更，支持并排 / 内联两种 Diff 模式
- **多仓库发现** — 自动扫描项目目录下所有 Git 仓库

<!-- Git 历史截图：展示提交记录和 Diff 查看 -->
<!-- ![Git 集成](docs/screenshots/git.png) -->

### 其他

- **布局持久化** — 分屏比例、标签页、窗口大小 / 位置自动保存，重启恢复
- **关闭确认** — 关闭窗口前弹出二次确认，避免误操作
- **版本检查** — 启动时自动检查更新，标题栏显示新版本提示
- **Warm Carbon 主题** — 暖炭色调，自定义 CSS 变量体系
- **多 Shell 支持** — 可配置多种 Shell（PowerShell、CMD、Git Bash 等）

## 技术栈

| 层 | 技术 |
|---|---|
| 框架 | Tauri v2（Rust 后端 + WebView 前端） |
| 前端 | React 19 + TypeScript 5.8 + Tailwind CSS v4 + Vite 7 |
| 终端 | xterm.js v6（WebGL addon，Canvas 降级） |
| 状态 | Zustand（全局单一 Store） |
| 布局 | Allotment（三栏主布局 + 递归 SplitNode 分屏树） |
| PTY | portable-pty 0.8 |
| Git | git2 0.19 |
| 文件监听 | notify 7 + ignore 0.4（.gitignore 过滤） |

## 快速开始

### 直接下载

前往 [Releases](https://github.com/pchaganti/mini-term/releases) 页面下载最新安装包。

> 目前仅支持 Windows 平台。

### 从源码构建

#### 前置条件

- [Node.js](https://nodejs.org/) >= 18
- [Rust](https://www.rust-lang.org/tools/install) >= 1.70
- [Tauri v2 CLI](https://v2.tauri.app/start/prerequisites/)

#### 安装与运行

```bash
# 克隆仓库
git clone https://github.com/pchaganti/mini-term.git
cd mini-term

# 安装依赖
npm install

# 启动完整 Tauri 开发环境（前端 + 后端）
npm run tauri dev

# 构建发布包
npm run tauri build
```

## 项目结构

```
mini-term/
├── src/                          # 前端源码
│   ├── App.tsx                   # 三栏主布局入口
│   ├── store.ts                  # Zustand 全局状态
│   ├── types.ts                  # 类型定义
│   ├── styles.css                # 全局样式与 CSS 变量
│   └── components/
│       ├── ProjectList.tsx       # 项目列表 + 嵌套分组
│       ├── SessionList.tsx       # AI 会话历史列表
│       ├── FileTree.tsx          # 文件目录树 + Git 状态
│       ├── TerminalArea.tsx      # 标签管理 + 分屏逻辑
│       ├── SplitLayout.tsx       # 递归渲染分屏树
│       ├── TerminalInstance.tsx  # xterm.js 终端实例
│       ├── TabBar.tsx            # 标签栏
│       ├── GitHistory.tsx        # Git 提交历史面板
│       ├── CommitDiffModal.tsx   # 提交 Diff 查看器
│       ├── DiffModal.tsx         # 文件变更 Diff 查看器
│       ├── FileViewerModal.tsx   # 文件内容查看器
│       ├── SettingsModal.tsx     # 设置弹窗
│       └── StatusDot.tsx         # 状态指示点
├── src-tauri/                    # Rust 后端
│   └── src/
│       ├── lib.rs                # Tauri 初始化与命令注册
│       ├── pty.rs                # PTY 生命周期管理
│       ├── process_monitor.rs    # 进程状态轮询
│       ├── config.rs             # 配置持久化
│       ├── fs.rs                 # 目录列表与文件监听
│       ├── git.rs                # Git 操作（状态/Diff/日志）
│       └── ai_sessions.rs       # Claude/Codex 会话读取
└── package.json
```

## 架构概览

### 数据流

```
用户键入 → xterm.onData → invoke('write_pty') → Rust PTY writer
Rust PTY reader → 16ms 批量缓冲 → emit('pty-output') → term.write()
进程监控 → 500ms 轮询子进程名 → emit('pty-status-change') → StatusDot 更新
```

### 状态优先级

终端面板状态从叶节点聚合到标签页和项目级别：

```
error > ai-working > ai-idle > idle
```

### 布局模型

```
App (Allotment 三栏)
├── 左栏：ProjectList（项目 + 分组 + 会话）
├── 中栏：FileTree（目录浏览 + Git 状态）
└── 右栏
    ├── TabBar（标签管理）
    ├── SplitLayout（递归 SplitNode 分屏树）
    │   └── TerminalInstance × N
    └── GitHistory（提交历史面板）
```

## 推荐开发环境

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## 社区

学 AI，上 L 站 — [LinuxDO](https://linux.do/)
