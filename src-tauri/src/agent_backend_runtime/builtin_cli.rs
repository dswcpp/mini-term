use super::{BackendLaunchRequest, BackendLaunchSpec};
use std::path::{Path, PathBuf};

use portable_pty::CommandBuilder;

fn shell_escape(arg: &str) -> String {
    if arg.is_empty()
        || arg
            .chars()
            .any(|ch| ch.is_whitespace() || ch == '"' || ch == '\'')
    {
        format!("{arg:?}")
    } else {
        arg.to_string()
    }
}

fn shim_command_for(target: &str) -> Option<CommandBuilder> {
    let shim = std::env::var("MINI_TERM_AGENT_SHIM")
        .ok()
        .or_else(|| std::env::var("MINI_TERM_TEST_AGENT_SHIM").ok())?;

    let lower = shim.to_ascii_lowercase();
    if lower.ends_with(".js") || lower.ends_with(".mjs") || lower.ends_with(".cjs") {
        #[cfg(windows)]
        let node = resolve_windows_command("node");
        #[cfg(not(windows))]
        let node = "node".to_string();
        let mut builder = CommandBuilder::new(&node);
        builder.arg(&shim);
        builder.arg(target);
        return Some(builder);
    }

    #[cfg(windows)]
    {
        let mut builder = wrap_windows_command(&shim);
        builder.arg(target);
        return Some(builder);
    }

    #[cfg(not(windows))]
    {
        let mut builder = CommandBuilder::new("sh");
        builder.arg(&shim);
        builder.arg(target);
        return Some(builder);
    }
}

#[cfg(windows)]
fn wrap_windows_command(path: &str) -> CommandBuilder {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".cmd") || lower.ends_with(".bat") {
        let mut builder = CommandBuilder::new("cmd");
        builder.arg("/C");
        builder.arg(path);
        return builder;
    }
    if lower.ends_with(".ps1") {
        let mut builder = CommandBuilder::new("powershell");
        builder.arg("-NoLogo");
        builder.arg("-NoProfile");
        builder.arg("-ExecutionPolicy");
        builder.arg("Bypass");
        builder.arg("-File");
        builder.arg(path);
        return builder;
    }
    CommandBuilder::new(path)
}

#[cfg(windows)]
pub(crate) fn resolve_windows_command(program: &str) -> String {
    let requested = Path::new(program);
    if requested.components().count() > 1 {
        return program.to_string();
    }

    let path_var = std::env::var_os("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path_var) {
        for candidate in [
            dir.join(format!("{program}.exe")),
            dir.join(format!("{program}.com")),
            dir.join(format!("{program}.cmd")),
            dir.join(format!("{program}.bat")),
            dir.join(format!("{program}.ps1")),
        ] {
            if candidate.is_file() {
                return candidate.to_string_lossy().to_string();
            }
        }
    }

    program.to_string()
}

#[cfg(windows)]
fn resolve_claude_windows_launch() -> (CommandBuilder, String) {
    let resolved = resolve_windows_command("claude");
    let cli_js = PathBuf::from(&resolved)
        .parent()
        .map(|dir| {
            dir.join("node_modules")
                .join("@anthropic-ai")
                .join("claude-code")
                .join("cli.js")
        })
        .filter(|path| path.is_file());

    if let Some(cli_js) = cli_js {
        let node = resolve_windows_command("node");
        let mut builder = CommandBuilder::new(&node);
        builder.arg(cli_js.to_string_lossy().as_ref());
        return (
            builder,
            format!("{} {}", node, shell_escape(&cli_js.to_string_lossy())),
        );
    }

    (wrap_windows_command(&resolved), resolved)
}

#[cfg(windows)]
fn resolve_codex_windows_launch() -> (CommandBuilder, String) {
    let resolved = resolve_windows_command("codex");
    let cli_js = PathBuf::from(&resolved)
        .parent()
        .map(|dir| {
            dir.join("node_modules")
                .join("@openai")
                .join("codex")
                .join("bin")
                .join("codex.js")
        })
        .filter(|path| path.is_file());

    if let Some(cli_js) = cli_js {
        let node = resolve_windows_command("node");
        let mut builder = CommandBuilder::new(&node);
        builder.arg(cli_js.to_string_lossy().as_ref());
        return (
            builder,
            format!("{} {}", node, shell_escape(&cli_js.to_string_lossy())),
        );
    }

    (wrap_windows_command(&resolved), resolved)
}

#[cfg_attr(windows, allow(dead_code))]
pub(crate) fn codex_args(cwd: &str, prompt: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        vec![
            "-c".to_string(),
            r#"trust_level="trusted""#.to_string(),
            "-C".to_string(),
            cwd.to_string(),
            prompt.to_string(),
        ]
    }

    #[cfg(not(windows))]
    {
        vec!["-C".to_string(), cwd.to_string(), prompt.to_string()]
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
fn codex_args_without_prompt(cwd: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        vec![
            "-c".to_string(),
            r#"trust_level="trusted""#.to_string(),
            "-C".to_string(),
            cwd.to_string(),
        ]
    }

    #[cfg(not(windows))]
    {
        vec!["-C".to_string(), cwd.to_string()]
    }
}

#[cfg_attr(windows, allow(dead_code))]
fn claude_args(title: &str, prompt: &str) -> Vec<String> {
    vec!["-n".to_string(), title.to_string(), prompt.to_string()]
}

#[cfg_attr(not(windows), allow(dead_code))]
fn claude_args_without_prompt(title: &str) -> Vec<String> {
    vec!["-n".to_string(), title.to_string()]
}

pub(crate) fn build_launch_command(
    request: BackendLaunchRequest<'_>,
) -> Result<BackendLaunchSpec, String> {
    if let Some(mut command) = shim_command_for(request.backend.target.as_str()) {
        command.cwd(request.cwd);
        return Ok(BackendLaunchSpec {
            builder: command,
            display: format!(
                "{} {}",
                std::env::var("MINI_TERM_AGENT_SHIM")
                    .ok()
                    .or_else(|| std::env::var("MINI_TERM_TEST_AGENT_SHIM").ok())
                    .unwrap_or_else(|| "<shim>".to_string()),
                request.backend.backend_id
            ),
            initial_input: None,
        });
    }

    let _cli_command = request.backend.cli_command.as_deref().ok_or_else(|| {
        format!(
            "backend {} is missing a cli command",
            request.backend.backend_id
        )
    })?;

    let (mut command, display, initial_input) = match request.backend.backend_id.as_str() {
        "codex-cli" => {
            #[cfg(windows)]
            let (mut builder, launch_prefix) = resolve_codex_windows_launch();
            #[cfg(not(windows))]
            let launch_prefix = _cli_command.to_string();
            #[cfg(not(windows))]
            let mut builder = CommandBuilder::new(_cli_command);
            #[cfg(windows)]
            let args = codex_args_without_prompt(request.cwd);
            #[cfg(not(windows))]
            let args = codex_args(request.cwd, request.prompt);
            for arg in &args {
                builder.arg(arg);
            }
            let display = format!(
                "{} {}{}",
                launch_prefix,
                args.iter()
                    .map(|arg| shell_escape(arg))
                    .collect::<Vec<_>>()
                    .join(" "),
                if cfg!(windows) {
                    " <prompt-via-pty>"
                } else {
                    ""
                }
            );
            let initial_input = if cfg!(windows) {
                Some(request.prompt.to_string())
            } else {
                None
            };
            (builder, display, initial_input)
        }
        "claude-cli" => {
            #[cfg(windows)]
            let (mut builder, launch_prefix) = resolve_claude_windows_launch();
            #[cfg(not(windows))]
            let launch_prefix = _cli_command.to_string();
            #[cfg(not(windows))]
            let mut builder = CommandBuilder::new(_cli_command);
            #[cfg(windows)]
            let args = claude_args_without_prompt(request.title);
            #[cfg(not(windows))]
            let args = claude_args(request.title, request.prompt);
            for arg in &args {
                builder.arg(arg);
            }
            let display = format!(
                "{} {}{}",
                launch_prefix,
                args.iter()
                    .map(|arg| shell_escape(arg))
                    .collect::<Vec<_>>()
                    .join(" "),
                if cfg!(windows) {
                    " <prompt-via-pty>"
                } else {
                    ""
                }
            );
            let initial_input = if cfg!(windows) {
                Some(request.prompt.to_string())
            } else {
                None
            };
            (builder, display, initial_input)
        }
        other => {
            return Err(format!("unsupported builtin backend: {other}"));
        }
    };
    command.cwd(request.cwd);
    Ok(BackendLaunchSpec {
        builder: command,
        display,
        initial_input,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_backends::default_backend_for_target;
    use crate::agent_core::models::TaskTarget;

    #[test]
    fn codex_args_include_cwd_and_prompt() {
        let args = codex_args("D:/repo", "fix the bug");
        #[cfg(windows)]
        assert_eq!(
            args,
            vec![
                "-c".to_string(),
                r#"trust_level="trusted""#.to_string(),
                "-C".to_string(),
                "D:/repo".to_string(),
                "fix the bug".to_string(),
            ]
        );
        #[cfg(not(windows))]
        assert_eq!(
            args,
            vec![
                "-C".to_string(),
                "D:/repo".to_string(),
                "fix the bug".to_string(),
            ]
        );
    }

    #[cfg(windows)]
    #[test]
    fn command_for_codex_streams_initial_prompt_via_pty() {
        let backend = default_backend_for_target(&TaskTarget::Codex).unwrap();
        let launch = build_launch_command(BackendLaunchRequest {
            backend: &backend,
            prompt: "review pending changes",
            cwd: "D:/repo",
            title: "Codex task",
        })
        .unwrap();
        assert!(launch.display.contains("<prompt-via-pty>"));
        assert!(launch.display.contains("trust_level"));
        assert_eq!(
            launch.initial_input.as_deref(),
            Some("review pending changes")
        );
    }

    #[cfg(windows)]
    #[test]
    fn resolve_windows_command_prefers_wrapped_scripts_over_extensionless_stub() {
        let temp_dir =
            std::env::temp_dir().join(format!("mini-term-backend-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        std::fs::write(temp_dir.join("codex"), "stub").unwrap();
        std::fs::write(temp_dir.join("codex.cmd"), "@echo off\r\n").unwrap();

        let original_path = std::env::var("PATH").unwrap_or_default();
        std::env::set_var(
            "PATH",
            format!("{};{original_path}", temp_dir.to_string_lossy()),
        );
        let resolved = resolve_windows_command("codex");
        std::env::set_var("PATH", original_path);

        assert!(resolved.to_ascii_lowercase().ends_with("codex.cmd"));
        let _ = std::fs::remove_dir_all(temp_dir);
    }
}
