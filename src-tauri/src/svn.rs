use crate::vcs::{
    build_hunks, full_replace_diff, hide_console_window, status_label, ChangeFileStatus,
    GitDiffResult, GitFileStatus, GitStatus, MAX_REPO_DISCOVER_DEPTH, SKIP_DISCOVERY_DIRS,
};
use pathdiff::diff_paths;
use quick_xml::events::Event;
use quick_xml::Reader as XmlReader;
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

const MAX_DIFF_FILE_SIZE: u64 = 1_048_576;

fn svn_failure(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        "svn 未返回错误详情".to_string()
    };
    let status = output
        .status
        .code()
        .map(|code| code.to_string())
        .unwrap_or_else(|| "signal".to_string());
    format!("svn 命令失败(退出状态 {status}): {detail}")
}

fn run_svn_output(repo_path: &Path, args: &[&str]) -> Result<Output, String> {
    if !repo_path.is_dir() {
        return Err(format!("不是有效目录: {}", repo_path.display()));
    }

    let mut cmd = Command::new("svn");
    cmd.args(args).current_dir(repo_path).stdin(Stdio::null());
    hide_console_window(&mut cmd);
    let output = cmd
        .output()
        .map_err(|error| format!("启动 svn 失败: {error}"))?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(svn_failure(&output))
    }
}

pub(crate) fn run_svn_command(repo_path: &Path, args: &[&str]) -> Result<String, String> {
    let output = run_svn_output(repo_path, args)?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn filesystem_svn_root(path: &Path) -> Option<PathBuf> {
    let canonical = path.canonicalize().ok()?;
    let start = if canonical.is_dir() {
        canonical.as_path()
    } else {
        canonical.parent()?
    };
    start
        .ancestors()
        .find(|candidate| candidate.join(".svn").is_dir())
        .map(Path::to_path_buf)
}

pub(crate) fn svn_working_copy_root(path: &Path) -> Option<PathBuf> {
    let mut cmd = Command::new("svn");
    cmd.args(["info", "--show-item", "wc-root", "--"])
        .arg(path)
        .stdin(Stdio::null());
    hide_console_window(&mut cmd);
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }

    // 优先使用文件系统中发现的 .svn 根目录，避免 Windows 本地代码页导致
    // `svn info` 输出中的非 ASCII 路径被 UTF-8 lossy 解码破坏。
    if let Some(root) = filesystem_svn_root(path) {
        return Some(root);
    }

    let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if root.is_empty() {
        None
    } else {
        PathBuf::from(root).canonicalize().ok()
    }
}

fn canonical_or_original(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn push_unique_svn_root(
    roots: &mut Vec<PathBuf>,
    seen: &mut HashSet<PathBuf>,
    root: PathBuf,
) -> bool {
    let key = canonical_or_original(&root);
    if !seen.insert(key) {
        return false;
    }
    roots.push(root);
    true
}

fn discover_svn_repo_paths_with<F>(project_path: &Path, mut working_copy_root: F) -> Vec<PathBuf>
where
    F: FnMut(&Path) -> Option<PathBuf>,
{
    let mut roots = Vec::new();
    let mut seen = HashSet::new();

    if let Some(root) = working_copy_root(project_path) {
        push_unique_svn_root(&mut roots, &mut seen, root);
    }

    fn scan<F>(
        dir: &Path,
        depth: u32,
        roots: &mut Vec<PathBuf>,
        seen: &mut HashSet<PathBuf>,
        working_copy_root: &mut F,
    ) where
        F: FnMut(&Path) -> Option<PathBuf>,
    {
        if depth > MAX_REPO_DISCOVER_DEPTH {
            return;
        }

        let dir_entries = match std::fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(_) => return,
        };

        for entry in dir_entries.flatten() {
            let sub = entry.path();
            if !sub.is_dir() {
                continue;
            }

            let dir_name = entry.file_name();
            let dir_name_str = dir_name.to_string_lossy();
            if SKIP_DISCOVERY_DIRS.contains(&dir_name_str.as_ref()) {
                continue;
            }

            if sub.join(".svn").is_dir() {
                if let Some(root) = working_copy_root(&sub) {
                    push_unique_svn_root(roots, seen, root);
                }
            }

            scan(&sub, depth + 1, roots, seen, working_copy_root);
        }
    }

    scan(
        project_path,
        1,
        &mut roots,
        &mut seen,
        &mut working_copy_root,
    );
    roots
}

pub(crate) fn discover_svn_repo_paths(project_path: &Path) -> Vec<PathBuf> {
    discover_svn_repo_paths_with(project_path, svn_working_copy_root)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SvnStatus {
    Modified,
    Added,
    Deleted,
    Replaced,
    Untracked,
    Conflicted,
    Missing,
}

impl SvnStatus {
    fn git_status(self) -> GitStatus {
        match self {
            Self::Modified => GitStatus::Modified,
            Self::Added => GitStatus::Added,
            Self::Deleted | Self::Missing => GitStatus::Deleted,
            Self::Replaced => GitStatus::Renamed,
            Self::Untracked => GitStatus::Untracked,
            Self::Conflicted => GitStatus::Conflicted,
        }
    }
}

fn svn_status_from_xml(item: &str, props: Option<&str>) -> Option<SvnStatus> {
    let text_status = match item {
        "modified" | "incomplete" => Some(SvnStatus::Modified),
        "added" => Some(SvnStatus::Added),
        "deleted" => Some(SvnStatus::Deleted),
        "replaced" => Some(SvnStatus::Replaced),
        "unversioned" => Some(SvnStatus::Untracked),
        "conflicted" | "obstructed" => Some(SvnStatus::Conflicted),
        "missing" => Some(SvnStatus::Missing),
        _ => None,
    };
    text_status.or_else(|| match props {
        Some("modified") => Some(SvnStatus::Modified),
        Some("conflicted") => Some(SvnStatus::Conflicted),
        _ => None,
    })
}

fn parse_svn_status_xml(output: &[u8]) -> Result<Vec<(String, SvnStatus)>, String> {
    let mut reader = XmlReader::from_reader(output);
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let mut current_path: Option<String> = None;
    let mut result = Vec::new();

    loop {
        match reader
            .read_event_into(&mut buffer)
            .map_err(|error| format!("解析 svn status XML 失败: {error}"))?
        {
            Event::Start(event) if event.name().as_ref() == b"entry" => {
                let decoder = reader.decoder();
                current_path = event
                    .attributes()
                    .with_checks(false)
                    .filter_map(Result::ok)
                    .find(|attribute| attribute.key.as_ref() == b"path")
                    .map(|attribute| {
                        attribute
                            .decode_and_unescape_value(decoder)
                            .map(|path| path.replace('\\', "/"))
                            .map_err(|error| format!("解析 SVN 路径失败: {error}"))
                    })
                    .transpose()?;
            }
            Event::Start(event) | Event::Empty(event) if event.name().as_ref() == b"wc-status" => {
                let decoder = reader.decoder();
                let mut item = None;
                let mut props = None;
                for attribute in event.attributes().with_checks(false) {
                    let attribute =
                        attribute.map_err(|error| format!("解析 SVN 状态属性失败: {error}"))?;
                    if attribute.key.as_ref() == b"item" {
                        item = Some(
                            attribute
                                .decode_and_unescape_value(decoder)
                                .map_err(|error| format!("解析 SVN 文本状态失败: {error}"))?
                                .into_owned(),
                        );
                    } else if attribute.key.as_ref() == b"props" {
                        props = Some(
                            attribute
                                .decode_and_unescape_value(decoder)
                                .map_err(|error| format!("解析 SVN 属性状态失败: {error}"))?
                                .into_owned(),
                        );
                    }
                }

                if let (Some(path), Some(item)) = (current_path.as_ref(), item.as_deref()) {
                    if let Some(status) = svn_status_from_xml(item, props.as_deref()) {
                        result.push((path.clone(), status));
                    }
                }
            }
            Event::End(event) if event.name().as_ref() == b"entry" => current_path = None,
            Event::Eof => break,
            _ => {}
        }
        buffer.clear();
    }

    Ok(result)
}

fn read_svn_status(
    repo_root: &Path,
    target: Option<&str>,
) -> Result<Vec<(String, SvnStatus)>, String> {
    let mut args = vec!["status", "--xml"];
    if let Some(target) = target {
        args.extend(["--", target]);
    }
    let output = run_svn_output(repo_root, &args)?;
    parse_svn_status_xml(&output.stdout)
}

fn map_svn_status_entries(
    repo_root: &Path,
    display_base: Option<&Path>,
    statuses: Vec<(String, SvnStatus)>,
) -> Vec<GitFileStatus> {
    // `svn_working_copy_root` 返回 canonical 路径（Windows 上带 verbatim 前缀），
    // 而 projectPath 通常未 canonicalize。pathdiff 前必须统一两侧，否则所有
    // Windows 状态都可能被误判为通过 `../` 逃逸。
    let display_context = display_base.map(|base| {
        (
            canonical_or_original(repo_root),
            canonical_or_original(base),
        )
    });
    let mut result = Vec::new();

    for (path, svn_status) in statuses {
        let status = svn_status.git_status();
        let display_path = if let Some((root, base)) = display_context.as_ref() {
            let abs = root.join(path.replace('/', std::path::MAIN_SEPARATOR_STR));
            match diff_paths(&abs, base) {
                Some(relative) => {
                    let normalized = relative.to_string_lossy().replace('\\', "/");
                    if normalized.starts_with("../") || normalized == ".." {
                        continue;
                    }
                    normalized
                }
                None => continue,
            }
        } else {
            path
        };

        result.push(GitFileStatus {
            path: display_path,
            old_path: None,
            status_label: status_label(&status).to_string(),
            status,
        });
    }

    result
}

pub(crate) fn collect_svn_status(
    repo_root: &Path,
    display_base: Option<&Path>,
) -> Result<Vec<GitFileStatus>, String> {
    let statuses = read_svn_status(repo_root, None)?;
    Ok(map_svn_status_entries(repo_root, display_base, statuses))
}

fn deepest_containing_root<'a>(path: &Path, roots: &'a [PathBuf]) -> Option<&'a PathBuf> {
    roots
        .iter()
        .filter(|root| path.starts_with(root))
        .max_by_key(|root| root.components().count())
}

fn collect_svn_status_from_roots<F>(
    project_path: &Path,
    roots: &[PathBuf],
    mut collect: F,
) -> Vec<GitFileStatus>
where
    F: FnMut(&Path, &Path) -> Result<Vec<GitFileStatus>, String>,
{
    let project = canonical_or_original(project_path);
    let mut batches = Vec::new();
    for root in roots {
        if let Ok(files) = collect(root, project_path) {
            batches.push((canonical_or_original(root), files));
        }
    }

    // 独立 working copy 可以嵌套。成功返回状态的最深根拥有其覆盖路径；
    // 若内层状态读取失败，则外层结果仍作为降级保留。
    let successful_roots: Vec<PathBuf> = batches.iter().map(|(root, _)| root.clone()).collect();
    let mut seen = HashSet::new();
    let mut all = Vec::new();
    for (source_root, files) in batches {
        for mut file in files {
            let Ok((relative, normalized)) = parse_relative_path(&file.path) else {
                continue;
            };
            let absolute = project.join(relative);
            if deepest_containing_root(&absolute, &successful_roots) != Some(&source_root) {
                continue;
            }

            file.path = normalized;
            if seen.insert(file.path.clone()) {
                all.push(file);
            }
        }
    }
    all
}

pub(crate) fn collect_discovered_svn_status(project_path: &Path) -> Vec<GitFileStatus> {
    let roots = discover_svn_repo_paths(project_path);
    collect_svn_status_from_roots(project_path, &roots, |root, display_base| {
        collect_svn_status(root, Some(display_base))
    })
}

pub(crate) fn get_svn_changes_status(repo_path: &str) -> Result<Vec<ChangeFileStatus>, String> {
    let repo_root = svn_working_copy_root(Path::new(repo_path))
        .ok_or_else(|| format!("不是 SVN 工作副本: {repo_path}"))?;
    let files = collect_svn_status(&repo_root, None)?;
    Ok(files
        .into_iter()
        .map(|file| ChangeFileStatus {
            path: file.path,
            old_path: None,
            staged_status: None,
            unstaged_status: Some(file.status),
            status_label: file.status_label,
        })
        .collect())
}

#[derive(Debug)]
struct ValidatedSvnPath {
    relative: String,
    absolute: PathBuf,
}

fn parse_relative_path(input: &str) -> Result<(PathBuf, String), String> {
    if input.is_empty() || input.contains('\0') {
        return Err("SVN 路径不能为空或包含 NUL".to_string());
    }

    let normalized = input.replace('\\', "/");
    let bytes = normalized.as_bytes();
    let has_windows_prefix = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    if normalized.starts_with('/') || has_windows_prefix || Path::new(&normalized).is_absolute() {
        return Err(format!("SVN 文件路径必须是仓库内相对路径: {input}"));
    }

    let mut path = PathBuf::new();
    let mut normalized_parts = Vec::new();
    for part in normalized.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return Err(format!("SVN 文件路径包含不安全路径段: {input}"));
        }
        path.push(part);
        normalized_parts.push(part);
    }
    Ok((path, normalized_parts.join("/")))
}

fn resolve_without_following_final(root: &Path, unresolved: &Path) -> Result<PathBuf, String> {
    let mut ancestor = unresolved
        .parent()
        .ok_or_else(|| format!("无法解析 SVN 路径: {}", unresolved.display()))?;
    while std::fs::symlink_metadata(ancestor).is_err() {
        ancestor = ancestor
            .parent()
            .ok_or_else(|| format!("无法解析 SVN 路径父目录: {}", unresolved.display()))?;
    }

    let canonical_ancestor = ancestor
        .canonicalize()
        .map_err(|error| format!("无法解析 SVN 路径父目录 {}: {error}", ancestor.display()))?;
    if !canonical_ancestor.starts_with(root) {
        return Err(format!(
            "SVN 文件路径逃逸出工作副本: {}",
            unresolved.display()
        ));
    }

    let suffix = unresolved
        .strip_prefix(ancestor)
        .map_err(|_| format!("无法计算 SVN 相对路径: {}", unresolved.display()))?;
    Ok(canonical_ancestor.join(suffix))
}

fn resolve_svn_path(
    repo_root: &Path,
    base: &Path,
    input: &str,
    follow_final: bool,
) -> Result<ValidatedSvnPath, String> {
    let root = repo_root
        .canonicalize()
        .map_err(|error| format!("SVN 工作副本根目录无效 {}: {error}", repo_root.display()))?;
    let base = base
        .canonicalize()
        .map_err(|error| format!("SVN 路径基准目录无效 {}: {error}", base.display()))?;
    if !base.is_dir() || !base.starts_with(&root) {
        return Err(format!(
            "SVN 路径基准目录不在工作副本内: {}",
            base.display()
        ));
    }

    let (relative_input, _) = parse_relative_path(input)?;
    let unresolved = base.join(relative_input);
    let mut absolute = resolve_without_following_final(&root, &unresolved)?;
    if follow_final && std::fs::symlink_metadata(&absolute).is_ok() {
        absolute = absolute
            .canonicalize()
            .map_err(|error| format!("无法解析 SVN 文件路径 {}: {error}", absolute.display()))?;
        if !absolute.starts_with(&root) {
            return Err(format!(
                "SVN 文件路径逃逸出工作副本: {}",
                absolute.display()
            ));
        }
    }

    let relative = absolute
        .strip_prefix(&root)
        .map_err(|_| format!("SVN 文件路径不在工作副本内: {}", absolute.display()))?
        .to_string_lossy()
        .replace('\\', "/");
    if relative.is_empty() {
        return Err("不能对 SVN 工作副本根目录执行文件操作".to_string());
    }

    Ok(ValidatedSvnPath { relative, absolute })
}

fn resolve_project_svn_path(
    project_path: &Path,
    input: &str,
    roots: &[PathBuf],
    follow_final: bool,
) -> Result<(PathBuf, ValidatedSvnPath), String> {
    let project = project_path
        .canonicalize()
        .map_err(|error| format!("SVN 项目目录无效 {}: {error}", project_path.display()))?;
    if !project.is_dir() {
        return Err(format!("SVN 项目路径不是目录: {}", project.display()));
    }

    let (relative_input, _) = parse_relative_path(input)?;
    let unresolved = project.join(relative_input);
    let mut absolute = resolve_without_following_final(&project, &unresolved)?;
    let canonical_roots: Vec<PathBuf> = roots
        .iter()
        .filter_map(|root| root.canonicalize().ok())
        .collect();
    let repo_root = deepest_containing_root(&absolute, &canonical_roots)
        .cloned()
        .ok_or_else(|| format!("SVN 文件不在已发现的工作副本内: {}", absolute.display()))?;

    if follow_final && std::fs::symlink_metadata(&absolute).is_ok() {
        absolute = absolute
            .canonicalize()
            .map_err(|error| format!("无法解析 SVN 文件路径 {}: {error}", absolute.display()))?;
        if !absolute.starts_with(&project) || !absolute.starts_with(&repo_root) {
            return Err(format!(
                "SVN 文件路径逃逸出项目或工作副本: {}",
                absolute.display()
            ));
        }
    }

    let relative = absolute
        .strip_prefix(&repo_root)
        .map_err(|_| format!("SVN 文件路径不在工作副本内: {}", absolute.display()))?
        .to_string_lossy()
        .replace('\\', "/");
    if relative.is_empty() {
        return Err("不能对 SVN 工作副本根目录执行文件操作".to_string());
    }

    Ok((repo_root, ValidatedSvnPath { relative, absolute }))
}

pub(crate) fn svn_stage_file(repo: &Path, file: &str) -> Result<(), String> {
    let repo_root = svn_working_copy_root(repo)
        .ok_or_else(|| format!("不是 SVN 工作副本: {}", repo.display()))?;
    let path = resolve_svn_path(&repo_root, &repo_root, file, false)?;
    let status = read_svn_status(&repo_root, Some(&path.relative))?
        .into_iter()
        .find_map(|(candidate, status)| (candidate == path.relative).then_some(status));

    match status {
        Some(SvnStatus::Untracked) => {
            run_svn_command(&repo_root, &["add", "--parents", "--", &path.relative])?;
        }
        Some(SvnStatus::Missing) => {
            run_svn_command(&repo_root, &["delete", "--force", "--", &path.relative])?;
        }
        Some(_) | None => {
            // SVN 没有 Git 式暂存区；已受版本控制的修改本身即可提交。
        }
    }
    Ok(())
}

pub(crate) fn svn_stage_all(repo_path: &str, include_untracked: bool) -> Result<(), String> {
    let repo_root = svn_working_copy_root(Path::new(repo_path))
        .ok_or_else(|| format!("不是 SVN 工作副本: {repo_path}"))?;
    let statuses = read_svn_status(&repo_root, None)?;
    let mut candidates = Vec::new();
    for (path, status) in statuses {
        if matches!(status, SvnStatus::Missing)
            || (include_untracked && matches!(status, SvnStatus::Untracked))
        {
            candidates.push((
                resolve_svn_path(&repo_root, &repo_root, &path, false)?,
                status,
            ));
        }
    }

    for (path, status) in candidates {
        match status {
            SvnStatus::Untracked => {
                run_svn_command(&repo_root, &["add", "--parents", "--", &path.relative])?;
            }
            SvnStatus::Missing => {
                run_svn_command(&repo_root, &["delete", "--force", "--", &path.relative])?;
            }
            _ => unreachable!("stage-all candidates are filtered above"),
        }
    }
    Ok(())
}

fn remove_unversioned_path(path: &Path) -> Result<(), String> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("读取待删除路径 {} 失败: {error}", path.display())),
    };

    let result = if metadata.file_type().is_symlink() {
        #[cfg(windows)]
        {
            if path.is_dir() {
                std::fs::remove_dir(path)
            } else {
                std::fs::remove_file(path)
            }
        }
        #[cfg(not(windows))]
        {
            std::fs::remove_file(path)
        }
    } else if metadata.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };
    result.map_err(|error| format!("删除未版本控制路径 {} 失败: {error}", path.display()))
}

pub(crate) fn svn_discard_files(repo: &Path, files: Vec<String>) -> Result<(), String> {
    let repo_root = svn_working_copy_root(repo)
        .ok_or_else(|| format!("不是 SVN 工作副本: {}", repo.display()))?;
    let statuses: HashMap<String, SvnStatus> =
        read_svn_status(&repo_root, None)?.into_iter().collect();
    let mut seen = HashSet::new();
    let mut targets = Vec::new();

    // 先校验全部输入，再执行任何破坏性操作，避免一组请求处理一半后才发现路径逃逸。
    for file in files {
        let path = resolve_svn_path(&repo_root, &repo_root, &file, false)?;
        if !seen.insert(path.relative.clone()) {
            continue;
        }
        let status = statuses
            .get(&path.relative)
            .copied()
            .ok_or_else(|| format!("路径没有可丢弃的 SVN 更改: {}", path.relative))?;
        targets.push((path, status));
    }

    for (path, status) in targets {
        match status {
            SvnStatus::Untracked => remove_unversioned_path(&path.absolute)?,
            SvnStatus::Added => {
                run_svn_command(
                    &repo_root,
                    &["revert", "--depth", "infinity", "--", &path.relative],
                )?;
                remove_unversioned_path(&path.absolute)?;
            }
            _ => {
                run_svn_command(
                    &repo_root,
                    &["revert", "--depth", "infinity", "--", &path.relative],
                )?;
            }
        }
    }
    Ok(())
}

fn read_text_file_for_diff(path: &Path) -> Result<(String, bool, bool), String> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((String::new(), false, false));
        }
        Err(error) => return Err(format!("读取文件元数据 {} 失败: {error}", path.display())),
    };
    if !metadata.is_file() {
        return Err(format!("无法预览非文件路径的 SVN 差异: {}", path.display()));
    }
    if metadata.len() > MAX_DIFF_FILE_SIZE {
        return Ok((String::new(), false, true));
    }

    let bytes = std::fs::read(path)
        .map_err(|error| format!("读取文件 {} 失败: {error}", path.display()))?;
    match std::str::from_utf8(&bytes) {
        Ok(content) => Ok((content.to_string(), false, false)),
        Err(_) => Ok((String::new(), true, false)),
    }
}

fn get_svn_base_content(repo_root: &Path, rel_path: &str) -> Result<(String, bool, bool), String> {
    let mut cmd = Command::new("svn");
    cmd.args(["cat", "--"])
        .arg(rel_path)
        .current_dir(repo_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console_window(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|error| format!("启动 svn cat 失败: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法读取 svn cat 标准输出".to_string())?;
    let mut bytes = Vec::new();
    stdout
        .take(MAX_DIFF_FILE_SIZE + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取 svn cat 输出失败: {error}"))?;

    if bytes.len() as u64 > MAX_DIFF_FILE_SIZE {
        let _ = child.kill();
        let _ = child.wait();
        return Ok((String::new(), false, true));
    }

    let output = child
        .wait_with_output()
        .map_err(|error| format!("等待 svn cat 结束失败: {error}"))?;
    if !output.status.success() {
        return Err(svn_failure(&output));
    }
    match std::str::from_utf8(&bytes) {
        Ok(content) => Ok((content.to_string(), false, false)),
        Err(_) => Ok((String::new(), true, false)),
    }
}

pub(crate) fn get_svn_diff(
    project_path: String,
    file_path: String,
) -> Result<GitDiffResult, String> {
    let project = Path::new(&project_path);
    let roots = discover_svn_repo_paths(project);
    let (repo_root, path) = resolve_project_svn_path(project, &file_path, &roots, true)?;
    let status = read_svn_status(&repo_root, Some(&path.relative))?
        .into_iter()
        .find_map(|(candidate, status)| (candidate == path.relative).then_some(status));

    let (old_content, old_binary, old_too_large) =
        if matches!(status, Some(SvnStatus::Added | SvnStatus::Untracked)) {
            (String::new(), false, false)
        } else {
            get_svn_base_content(&repo_root, &path.relative)?
        };
    if old_binary || old_too_large {
        return Ok(GitDiffResult {
            old_content: String::new(),
            new_content: String::new(),
            hunks: Vec::new(),
            is_binary: old_binary,
            too_large: old_too_large,
        });
    }

    let (new_content, new_binary, new_too_large) = read_text_file_for_diff(&path.absolute)?;
    if new_binary || new_too_large {
        return Ok(GitDiffResult {
            old_content: String::new(),
            new_content: String::new(),
            hunks: Vec::new(),
            is_binary: new_binary,
            too_large: new_too_large,
        });
    }

    let old_lines: Vec<&str> = old_content.lines().collect();
    let new_lines: Vec<&str> = new_content.lines().collect();
    let old_count = old_lines.len() as u64;
    let new_count = new_lines.len() as u64;
    let hunks = if old_count.saturating_mul(new_count) > 10_000_000 {
        full_replace_diff(&old_content, &new_content)
    } else {
        build_hunks(&old_lines, &new_lines)
    };

    Ok(GitDiffResult {
        old_content,
        new_content,
        hunks,
        is_binary: false,
        too_large: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_temp_dir(label: &str) -> PathBuf {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "mini-term-svn-{label}-{}-{timestamp}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn push_unique_svn_root_deduplicates_canonical_paths() {
        let root = make_temp_dir("dedupe");
        let nested = root.join(".").join("child").join("..");

        let mut roots = Vec::new();
        let mut seen = HashSet::new();

        assert!(push_unique_svn_root(&mut roots, &mut seen, root.clone()));
        assert!(!push_unique_svn_root(&mut roots, &mut seen, nested));
        assert_eq!(roots, vec![root.clone()]);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn discovery_finds_nested_working_copy_roots() {
        let project = make_temp_dir("nested-discovery");
        let outer = project.join("outer");
        let nested = outer.join("nested");
        std::fs::create_dir_all(outer.join(".svn")).unwrap();
        std::fs::create_dir_all(nested.join(".svn")).unwrap();

        let roots = discover_svn_repo_paths_with(&project, |candidate| {
            candidate
                .join(".svn")
                .is_dir()
                .then(|| candidate.canonicalize().unwrap())
        });
        let outer = outer.canonicalize().unwrap();
        let nested = nested.canonicalize().unwrap();

        assert_eq!(roots.len(), 2);
        assert!(roots.contains(&outer));
        assert!(roots.contains(&nested));

        let _ = std::fs::remove_dir_all(project);
    }

    #[test]
    fn status_aggregation_visits_all_roots_and_ignores_failures() {
        let project = PathBuf::from("workspace");
        let roots = vec![
            project.join("outer"),
            project.join("outer/nested"),
            project.join("broken"),
        ];
        let mut visited = Vec::new();

        let statuses = collect_svn_status_from_roots(&project, &roots, |root, display_base| {
            assert_eq!(display_base, project.as_path());
            visited.push(root.to_path_buf());
            if root.ends_with("broken") {
                return Err("unavailable".to_string());
            }

            let path = if root.ends_with("nested") {
                "outer/nested/changed.txt"
            } else {
                "outer/changed.txt"
            };
            Ok(vec![GitFileStatus {
                path: path.to_string(),
                old_path: None,
                status: GitStatus::Modified,
                status_label: "M".to_string(),
            }])
        });

        assert_eq!(visited, roots);
        assert_eq!(statuses.len(), 2);
        assert_eq!(statuses[0].path, "outer/changed.txt");
        assert_eq!(statuses[1].path, "outer/nested/changed.txt");
    }

    #[test]
    fn status_aggregation_assigns_nested_paths_to_deepest_successful_root() {
        let project = PathBuf::from("workspace");
        let outer = project.join("outer");
        let nested = outer.join("nested");
        let roots = vec![outer.clone(), nested.clone()];

        let statuses = collect_svn_status_from_roots(&project, &roots, |root, _| {
            if root == outer {
                Ok(vec![
                    GitFileStatus {
                        path: "outer/parent.txt".to_string(),
                        old_path: None,
                        status: GitStatus::Modified,
                        status_label: "M".to_string(),
                    },
                    GitFileStatus {
                        path: "outer/nested".to_string(),
                        old_path: None,
                        status: GitStatus::Untracked,
                        status_label: "?".to_string(),
                    },
                    GitFileStatus {
                        path: "outer/nested/changed.txt".to_string(),
                        old_path: None,
                        status: GitStatus::Modified,
                        status_label: "M".to_string(),
                    },
                ])
            } else {
                Ok(vec![
                    GitFileStatus {
                        path: "outer/nested/changed.txt".to_string(),
                        old_path: None,
                        status: GitStatus::Added,
                        status_label: "A".to_string(),
                    },
                    GitFileStatus {
                        path: "outer/nested/own.txt".to_string(),
                        old_path: None,
                        status: GitStatus::Modified,
                        status_label: "M".to_string(),
                    },
                ])
            }
        });

        assert_eq!(statuses.len(), 3);
        assert_eq!(statuses[0].path, "outer/parent.txt");
        assert_eq!(statuses[1].path, "outer/nested/changed.txt");
        assert_eq!(statuses[1].status, GitStatus::Added);
        assert_eq!(statuses[2].path, "outer/nested/own.txt");
        assert!(!statuses.iter().any(|status| status.path == "outer/nested"));
    }

    #[test]
    fn status_aggregation_keeps_parent_fallback_when_nested_status_fails() {
        let project = PathBuf::from("workspace");
        let outer = project.join("outer");
        let nested = outer.join("nested");
        let roots = vec![outer.clone(), nested.clone()];

        let statuses = collect_svn_status_from_roots(&project, &roots, |root, _| {
            if root == nested {
                return Err("nested unavailable".to_string());
            }
            Ok(vec![GitFileStatus {
                path: "outer/nested/changed.txt".to_string(),
                old_path: None,
                status: GitStatus::Modified,
                status_label: "M".to_string(),
            }])
        });

        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0].path, "outer/nested/changed.txt");
    }

    #[cfg(windows)]
    #[test]
    fn status_mapping_normalizes_verbatim_root_and_project_base() {
        let project = make_temp_dir("status-path-prefix");
        let repo = project.join("nested");
        std::fs::create_dir_all(&repo).unwrap();
        let canonical_repo = repo.canonicalize().unwrap();

        let statuses = map_svn_status_entries(
            &canonical_repo,
            Some(&project),
            vec![("changed.txt".to_string(), SvnStatus::Modified)],
        );

        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0].path, "nested/changed.txt");

        let _ = std::fs::remove_dir_all(project);
    }

    #[test]
    fn parse_svn_status_xml_maps_states_and_unescapes_paths() {
        let output = br#"<?xml version="1.0" encoding="UTF-8"?>
<status><target path=".">
  <entry path="src/main.ts"><wc-status item="modified" props="none" /></entry>
  <entry path="src\windows.ts"><wc-status item="modified" props="none" /></entry>
  <entry path="props-only.txt"><wc-status item="normal" props="modified" /></entry>
  <entry path="src/new.ts"><wc-status item="added" props="none" /></entry>
  <entry path="src/old.ts"><wc-status item="deleted" props="none" /></entry>
  <entry path="scratch&amp;notes.txt"><wc-status item="unversioned" props="none" /></entry>
  <entry path="conflicted.txt"><wc-status item="conflicted" props="none" /></entry>
  <entry path="missing.txt"><wc-status item="missing" props="none" /></entry>
</target></status>"#;

        let parsed = parse_svn_status_xml(output).unwrap();

        assert_eq!(
            parsed,
            vec![
                ("src/main.ts".to_string(), SvnStatus::Modified),
                ("src/windows.ts".to_string(), SvnStatus::Modified),
                ("props-only.txt".to_string(), SvnStatus::Modified),
                ("src/new.ts".to_string(), SvnStatus::Added),
                ("src/old.ts".to_string(), SvnStatus::Deleted),
                ("scratch&notes.txt".to_string(), SvnStatus::Untracked),
                ("conflicted.txt".to_string(), SvnStatus::Conflicted),
                ("missing.txt".to_string(), SvnStatus::Missing),
            ]
        );
    }

    #[test]
    fn parse_svn_status_xml_ignores_clean_external_and_ignored_entries() {
        let output = br#"<?xml version="1.0" encoding="UTF-8"?>
<status><target path=".">
  <entry path="clean.txt"><wc-status item="normal" props="none" /></entry>
  <entry path="external-lib"><wc-status item="external" props="none" /></entry>
  <entry path="ignored.tmp"><wc-status item="ignored" props="none" /></entry>
</target></status>"#;

        assert!(parse_svn_status_xml(output).unwrap().is_empty());
    }

    #[test]
    fn relative_path_validation_rejects_escape_and_absolute_inputs() {
        for path in [
            "../outside.txt",
            "nested/../../outside.txt",
            "/tmp/outside.txt",
            r"C:\outside.txt",
            r"\\server\share\outside.txt",
            "./inside.txt",
            "nested//inside.txt",
        ] {
            assert!(
                parse_relative_path(path).is_err(),
                "path should fail: {path}"
            );
        }
    }

    #[test]
    fn relative_path_validation_accepts_option_like_filename() {
        let (path, normalized) = parse_relative_path("nested/-option-like.txt").unwrap();
        assert_eq!(path, PathBuf::from("nested").join("-option-like.txt"));
        assert_eq!(normalized, "nested/-option-like.txt");
    }

    #[test]
    fn project_relative_resolution_uses_deepest_nested_working_copy() {
        let project = make_temp_dir("nested-diff-resolution");
        let outer = project.join("outer");
        let nested = outer.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        let nested_file = nested.join("changed.txt");
        std::fs::write(&nested_file, "changed").unwrap();
        let outer_file = outer.join("outer.txt");
        std::fs::write(&outer_file, "outer").unwrap();

        let roots = vec![
            outer.canonicalize().unwrap(),
            nested.canonicalize().unwrap(),
        ];
        let (repo_root, path) =
            resolve_project_svn_path(&project, "outer/nested/changed.txt", &roots, true).unwrap();
        assert_eq!(repo_root, nested.canonicalize().unwrap());
        assert_eq!(path.relative, "changed.txt");
        assert_eq!(path.absolute, nested_file.canonicalize().unwrap());

        let (repo_root, path) =
            resolve_project_svn_path(&project, "outer/outer.txt", &roots, true).unwrap();
        assert_eq!(repo_root, outer.canonicalize().unwrap());
        assert_eq!(path.relative, "outer.txt");

        std::fs::remove_file(&nested_file).unwrap();
        let (repo_root, missing) =
            resolve_project_svn_path(&project, "outer/nested/deleted.txt", &roots, true).unwrap();
        assert_eq!(repo_root, nested.canonicalize().unwrap());
        assert_eq!(missing.relative, "deleted.txt");
        assert_eq!(missing.absolute, repo_root.join("deleted.txt"));

        assert!(resolve_project_svn_path(&project, "../outside.txt", &roots, true).is_err());
        assert!(resolve_project_svn_path(&project, "unmanaged/file.txt", &roots, true).is_err());

        let _ = std::fs::remove_dir_all(project);
    }

    #[test]
    fn resolve_svn_path_rejects_base_outside_repo() {
        let repo = make_temp_dir("repo-boundary");
        let outside = make_temp_dir("outside-boundary");

        let error = resolve_svn_path(&repo, &outside, "file.txt", false).unwrap_err();
        assert!(error.contains("不在工作副本内"));

        let _ = std::fs::remove_dir_all(repo);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[test]
    fn read_text_file_marks_large_file_before_reading() {
        let root = make_temp_dir("large-diff");
        let path = root.join("large.txt");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_DIFF_FILE_SIZE + 1).unwrap();

        let result = read_text_file_for_diff(&path).unwrap();
        assert_eq!(result, (String::new(), false, true));

        let _ = std::fs::remove_dir_all(root);
    }
}
