# 发布 0.6.9 Windows 安装包

## Goal

将当前已合并的 mini-term 代码发布为 0.6.9：同步项目版本号，运行质量检查，创建发布提交与 `v0.6.9` tag，推送到当前 GitHub 仓库，并通过现有 GitHub Actions Release workflow 构建和上传安装包。

## What I already know

* 当前分支为 `main`，HEAD 为 `eea7b81`（已合并 `dreamlonglll/main`）。
* 当前项目版本为 `0.6.8`。
* 当前 `origin` 为 `https://github.com/dswcpp/mini-term.git`，GitHub CLI 已登录 `dswcpp`，具备 `repo` 与 `workflow` 权限。
* `.github/workflows/release.yml` 在推送 `v*` tag 后触发，矩阵构建 Windows、macOS Apple Silicon、Ubuntu 安装包，并由 `tauri-apps/tauri-action` 创建 GitHub Release 与上传 artifacts。
* 版本号出现于 `package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/tauri.conf.json` 以及中英文 README badge。

## Assumptions

* 目标版本按主人对默认方案的同意处理为 `0.6.9`，Git tag 为 `v0.6.9`。
* “上传 git”按当前 `origin`（`dswcpp/mini-term`）推送 `main` 与 `v0.6.9` 处理。
* Release 安装包按仓库既有 workflow 发布全部配置平台，而不是只在本机手动构建 Windows 包。

## Requirements

* [ ] 将所有项目版本引用从 `0.6.8` 更新为 `0.6.9`，不修改依赖版本。
* [ ] 运行前端构建与测试、Rust 检查与库测试。
* [ ] 创建发布提交（不 amend）。
* [ ] 创建并推送 `v0.6.9` tag，同时推送 `main`。
* [ ] 等待并确认 GitHub Actions Release workflow 完成，确认 GitHub Release 与安装包 assets 可用。

## Acceptance Criteria

* [ ] 版本文件、锁文件和 README badge 均为 `0.6.9`。
* [ ] `npm run build` 与 `npm run test` 通过。
* [ ] `cargo check --manifest-path src-tauri/Cargo.toml` 与 `cargo test --manifest-path src-tauri/Cargo.toml --lib` 通过。
* [ ] 发布提交存在于远程 `main`，tag `v0.6.9` 指向该提交并存在于远程。
* [ ] GitHub Actions 对 `v0.6.9` 的 Release workflow 成功，GitHub Release 为非草稿并包含平台安装包。

## Definition of Done

* 工作区干净，版本发布提交和 tag 已推送。
* GitHub Release 页面及安装包下载链接可验证。
* 不执行 force push，不覆盖已有 tag；若目标 tag 已存在则停止并报告。

## Out of Scope

* 不修改业务功能。
* 不创建或上传额外平台之外的自定义构建产物。
* 不修改 GitHub Actions workflow，除非现有发布流程无法完成。

## Technical Approach

* 使用现有 `.github/workflows/release.yml` 作为唯一 Release 构建入口：先提交版本号，再推送 `main` 和 `v0.6.9` tag，由 tag push 触发 Actions。
* 发布前检查远程是否已存在 `v0.6.9`，避免覆盖既有发布。
* 发布后通过 `gh run list`、`gh run watch` 与 `gh release view` 验证状态和 assets。

## Technical Notes

* 本次发布是外部副作用操作：会修改本地文件、创建提交/tag、推送 GitHub，并创建 Release/上传安装包。
* 当前 origin：`https://github.com/dswcpp/mini-term.git`。
