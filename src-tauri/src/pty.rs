use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyOutputPayload {
    pty_id: u32,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyExitPayload {
    pty_id: u32,
    exit_code: i32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtySessionCreatedPayload {
    session_id: String,
    pty_id: u32,
    shell: String,
    shell_kind: String,
    cwd: String,
    mode: String,
    phase: String,
    created_at: u64,
    updated_at: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtySessionPhasePayload {
    pty_id: u32,
    phase: String,
    last_exit_code: Option<i32>,
    updated_at: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtySessionCommandPayload {
    pty_id: u32,
    command: String,
    updated_at: u64,
}

struct PtyInstance {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct TrackInputOutcome {
    commands: Vec<String>,
}

const AI_COMMANDS: &[&str] = &["claude", "codex"];
const STARTUP_OUTPUT_LIMIT: usize = 64 * 1024;
const NON_INTERACTIVE_FLAGS: &[&str] = &[
    "-v",
    "--version",
    "-h",
    "--help",
    "-p",
    "--print",
];
const AI_EXIT_COMMANDS: &[&str] = &[
    "/exit",
    "exit",
    "/quit",
    "quit",
    ":quit",
    "/logout",
];
const DOUBLE_CTRLC_WINDOW: Duration = Duration::from_millis(1000);

fn now_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn session_id_for_pty(pty_id: u32) -> String {
    format!("session-{pty_id}")
}

fn infer_shell_kind(shell: &str) -> String {
    let name = shell
        .rsplit('\\')
        .next()
        .unwrap_or(shell)
        .rsplit('/')
        .next()
        .unwrap_or(shell)
        .to_lowercase();

    match name.as_str() {
        "powershell" | "powershell.exe" => "powershell".to_string(),
        "pwsh" | "pwsh.exe" => "pwsh".to_string(),
        "cmd" | "cmd.exe" => "cmd".to_string(),
        "bash" | "bash.exe" => "bash".to_string(),
        "zsh" | "zsh.exe" => "zsh".to_string(),
        _ => "unknown".to_string(),
    }
}

#[derive(Clone)]
pub struct PtyManager {
    instances: Arc<Mutex<HashMap<u32, PtyInstance>>>,
    next_id: Arc<Mutex<u32>>,
    last_output: Arc<Mutex<HashMap<u32, Instant>>>,
    startup_output: Arc<Mutex<HashMap<u32, String>>>,
    ai_sessions: Arc<Mutex<HashSet<u32>>>,
    input_buffers: Arc<Mutex<HashMap<u32, String>>>,
    last_ctrlc: Arc<Mutex<HashMap<u32, Instant>>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            instances: Arc::new(Mutex::new(HashMap::new())),
            next_id: Arc::new(Mutex::new(1)),
            last_output: Arc::new(Mutex::new(HashMap::new())),
            startup_output: Arc::new(Mutex::new(HashMap::new())),
            ai_sessions: Arc::new(Mutex::new(HashSet::new())),
            input_buffers: Arc::new(Mutex::new(HashMap::new())),
            last_ctrlc: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn get_pty_ids(&self) -> Vec<u32> {
        self.instances.lock().unwrap().keys().copied().collect()
    }

    pub fn has_recent_output(&self, pty_id: u32, within: Duration) -> bool {
        let map = self.last_output.lock().unwrap();
        map.get(&pty_id)
            .map_or(false, |timestamp| timestamp.elapsed() < within)
    }

    pub fn is_ai_session(&self, pty_id: u32) -> bool {
        self.ai_sessions.lock().unwrap().contains(&pty_id)
    }

    pub fn track_input(&self, pty_id: u32, data: &str) -> TrackInputOutcome {
        let in_ai = self.is_ai_session(pty_id);
        let mut enter_ai = false;
        let mut exit_ai = false;
        let mut commands = Vec::new();

        {
            let mut buffers = self.input_buffers.lock().unwrap();
            let buf = buffers.entry(pty_id).or_default();

            for ch in data.chars() {
                match ch {
                    '\x03' if in_ai => {
                        let mut last = self.last_ctrlc.lock().unwrap();
                        let now = Instant::now();
                        if let Some(prev) = last.get(&pty_id) {
                            if now.duration_since(*prev) < DOUBLE_CTRLC_WINDOW {
                                exit_ai = true;
                                last.remove(&pty_id);
                            } else {
                                last.insert(pty_id, now);
                            }
                        } else {
                            last.insert(pty_id, now);
                        }
                        buf.clear();
                    }
                    '\x04' if in_ai => {
                        exit_ai = true;
                        buf.clear();
                    }
                    '\r' | '\n' => {
                        let raw_command = buf.trim().to_string();
                        let normalized = raw_command.to_lowercase();

                        if in_ai {
                            if AI_EXIT_COMMANDS.iter().any(|&command| normalized == command) {
                                exit_ai = true;
                            }
                        } else if !normalized.is_empty() {
                            let mut words = normalized.split_whitespace();
                            let first_word = words.next().unwrap_or("");
                            let is_ai_command = AI_COMMANDS.iter().any(|&ai| {
                                first_word == ai
                                    || first_word.ends_with(&format!("/{ai}"))
                                    || first_word.ends_with(&format!("\\{ai}"))
                            });
                            let has_non_interactive_flag =
                                is_ai_command && words.any(|word| NON_INTERACTIVE_FLAGS.iter().any(|&flag| word == flag));
                            if is_ai_command && !has_non_interactive_flag {
                                enter_ai = true;
                            }
                        }

                        if !raw_command.is_empty() {
                            commands.push(raw_command);
                        }
                        buf.clear();
                    }
                    '\x7f' | '\x08' => {
                        buf.pop();
                    }
                    c if c >= ' ' => buf.push(c),
                    _ => {}
                }
            }
        }

        if enter_ai || exit_ai {
            let mut sessions = self.ai_sessions.lock().unwrap();
            if enter_ai {
                sessions.insert(pty_id);
            }
            if exit_ai {
                sessions.remove(&pty_id);
            }
        }

        TrackInputOutcome { commands }
    }
}

#[tauri::command]
pub fn create_pty(
    app: AppHandle,
    state: tauri::State<'_, PtyManager>,
    shell: String,
    args: Vec<String>,
    cwd: String,
) -> Result<u32, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())?;

    let mut cmd = CommandBuilder::new(&shell);
    for arg in &args {
        cmd.arg(arg);
    }
    cmd.cwd(&cwd);

    // Advertise terminal capabilities so TUI apps (Claude Code, etc.)
    // enable colors and advanced cursor rendering.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // Ensure UTF-8 encoding for proper CJK/emoji rendering.
    // Only set LC_CTYPE to avoid overriding the user's locale preferences.
    cmd.env("LC_CTYPE", "UTF-8");

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;

    let pty_id = {
        let mut next = state.next_id.lock().unwrap();
        let id = *next;
        *next += 1;
        id
    };

    let writer = pair.master.take_writer().map_err(|error| error.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|error| error.to_string())?;
    let master = pair.master;

    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let instances_clone = state.instances.clone();
    let pty_id_for_reader = pty_id;

    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let app_flush = app.clone();
    let last_output = state.last_output.clone();
    let startup_output = state.startup_output.clone();
    let ai_sessions = state.ai_sessions.clone();
    let input_buffers = state.input_buffers.clone();
    let last_ctrlc = state.last_ctrlc.clone();

    thread::spawn(move || {
        let mut pending = Vec::new();

        loop {
            match rx.recv_timeout(Duration::from_millis(16)) {
                Ok(data) => {
                    pending.extend(data);
                    while let Ok(more) = rx.try_recv() {
                        pending.extend(more);
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    if !pending.is_empty() {
                        let data = String::from_utf8_lossy(&pending).into_owned();
                        let _ = app_flush.emit(
                            "pty-output",
                            PtyOutputPayload {
                                pty_id: pty_id_for_reader,
                                data,
                            },
                        );
                    }

                    let exit_code = {
                        let mut instances = instances_clone.lock().unwrap();
                        if let Some(mut inst) = instances.remove(&pty_id_for_reader) {
                            inst.child
                                .try_wait()
                                .ok()
                                .flatten()
                                .map(|status| status.exit_code() as i32)
                                .unwrap_or(0)
                        } else {
                            0
                        }
                    };

                    let _ = app_flush.emit(
                        "pty-session-phase-change",
                        PtySessionPhasePayload {
                            pty_id: pty_id_for_reader,
                            phase: "exited".to_string(),
                            last_exit_code: Some(exit_code),
                            updated_at: now_timestamp_ms(),
                        },
                    );
                    let _ = app_flush.emit(
                        "pty-exit",
                        PtyExitPayload {
                            pty_id: pty_id_for_reader,
                            exit_code,
                        },
                    );

                    last_output.lock().unwrap().remove(&pty_id_for_reader);
                    startup_output.lock().unwrap().remove(&pty_id_for_reader);
                    ai_sessions.lock().unwrap().remove(&pty_id_for_reader);
                    input_buffers.lock().unwrap().remove(&pty_id_for_reader);
                    last_ctrlc.lock().unwrap().remove(&pty_id_for_reader);
                    return;
                }
            }

            if !pending.is_empty() {
                let data = String::from_utf8_lossy(&pending).into_owned();
                if let Ok(mut startup) = startup_output.lock() {
                    if let Some(buffer) = startup.get_mut(&pty_id_for_reader) {
                        buffer.push_str(&data);
                        if buffer.len() > STARTUP_OUTPUT_LIMIT {
                            let excess = buffer.len() - STARTUP_OUTPUT_LIMIT;
                            buffer.drain(..excess);
                        }
                    }
                }

                let _ = app_flush.emit(
                    "pty-output",
                    PtyOutputPayload {
                        pty_id: pty_id_for_reader,
                        data,
                    },
                );
                pending.clear();
                if let Ok(mut map) = last_output.lock() {
                    map.insert(pty_id_for_reader, Instant::now());
                }
            }
        }
    });

    {
        let mut instances = state.instances.lock().unwrap();
        instances.insert(
            pty_id,
            PtyInstance {
                writer,
                master,
                child,
            },
        );
    }
    state
        .startup_output
        .lock()
        .unwrap()
        .insert(pty_id, String::new());

    let now = now_timestamp_ms();
    let _ = app.emit(
        "pty-session-created",
        PtySessionCreatedPayload {
            session_id: session_id_for_pty(pty_id),
            pty_id,
            shell: shell.clone(),
            shell_kind: infer_shell_kind(&shell),
            cwd,
            mode: "human".to_string(),
            phase: "starting".to_string(),
            created_at: now,
            updated_at: now,
        },
    );

    Ok(pty_id)
}

#[tauri::command]
pub fn write_pty(
    app: AppHandle,
    state: tauri::State<'_, PtyManager>,
    pty_id: u32,
    data: String,
) -> Result<(), String> {
    {
        let mut instances = state.instances.lock().unwrap();
        let instance = instances.get_mut(&pty_id).ok_or("PTY not found")?;
        instance
            .writer
            .write_all(data.as_bytes())
            .map_err(|error| error.to_string())?;
        instance.writer.flush().map_err(|error| error.to_string())?;
    }

    let tracked = state.track_input(pty_id, &data);
    for command in tracked.commands {
        let updated_at = now_timestamp_ms();
        let _ = app.emit(
            "pty-session-command-started",
            PtySessionCommandPayload {
                pty_id,
                command,
                updated_at,
            },
        );
        let _ = app.emit(
            "pty-session-phase-change",
            PtySessionPhasePayload {
                pty_id,
                phase: "running".to_string(),
                last_exit_code: None,
                updated_at,
            },
        );
    }

    Ok(())
}

#[tauri::command]
pub fn resize_pty(
    state: tauri::State<'_, PtyManager>,
    pty_id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let instances = state.instances.lock().unwrap();
    let instance = instances.get(&pty_id).ok_or("PTY not found")?;
    instance
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn kill_pty(state: tauri::State<'_, PtyManager>, pty_id: u32) -> Result<(), String> {
    state.instances.lock().unwrap().remove(&pty_id);
    state.last_output.lock().unwrap().remove(&pty_id);
    state.startup_output.lock().unwrap().remove(&pty_id);
    state.ai_sessions.lock().unwrap().remove(&pty_id);
    state.input_buffers.lock().unwrap().remove(&pty_id);
    state.last_ctrlc.lock().unwrap().remove(&pty_id);
    Ok(())
}

#[tauri::command]
pub fn take_startup_output(
    state: tauri::State<'_, PtyManager>,
    pty_id: u32,
) -> Result<String, String> {
    let mut startup_output = state.startup_output.lock().unwrap();
    Ok(startup_output.remove(&pty_id).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_claude_command() {
        let mgr = PtyManager::new();
        mgr.track_input(1, "claude\r");
        assert!(mgr.is_ai_session(1));
    }

    #[test]
    fn detect_codex_command() {
        let mgr = PtyManager::new();
        mgr.track_input(1, "codex\r");
        assert!(mgr.is_ai_session(1));
    }

    #[test]
    fn non_ai_command_not_ai_session() {
        let mgr = PtyManager::new();
        mgr.track_input(1, "npm install\r");
        assert!(!mgr.is_ai_session(1));
    }

    #[test]
    fn prompt_in_ai_session_stays() {
        let mgr = PtyManager::new();
        mgr.track_input(1, "claude\r");
        assert!(mgr.is_ai_session(1));
        mgr.track_input(1, "fix the bug\r");
        assert!(mgr.is_ai_session(1));
    }

    #[test]
    fn single_ctrl_c_does_not_exit_ai_session() {
        let mgr = PtyManager::new();
        mgr.track_input(1, "claude\r");
        assert!(mgr.is_ai_session(1));
        mgr.track_input(1, "\x03");
        assert!(mgr.is_ai_session(1));
    }

    #[test]
    fn double_ctrl_c_exits_ai_session() {
        let mgr = PtyManager::new();
        mgr.track_input(1, "claude\r");
        assert!(mgr.is_ai_session(1));
        mgr.track_input(1, "\x03");
        assert!(mgr.is_ai_session(1));
        mgr.track_input(1, "\x03");
        assert!(!mgr.is_ai_session(1));
    }

    #[test]
    fn ctrl_d_exits_ai_session() {
        let mgr = PtyManager::new();
        mgr.track_input(1, "claude\r");
        assert!(mgr.is_ai_session(1));
        mgr.track_input(1, "\x04");
        assert!(!mgr.is_ai_session(1));
    }

    #[test]
    fn slash_exit_exits_ai_session() {
        let mgr = PtyManager::new();
        mgr.track_input(1, "claude\r");
        assert!(mgr.is_ai_session(1));
        mgr.track_input(1, "/exit\r");
        assert!(!mgr.is_ai_session(1));
    }

    #[test]
    fn exit_command_exits_ai_session() {
        let mgr = PtyManager::new();
        mgr.track_input(1, "claude\r");
        assert!(mgr.is_ai_session(1));
        mgr.track_input(1, "exit\r");
        assert!(!mgr.is_ai_session(1));
    }

    #[test]
    fn slash_quit_exits_ai_session() {
        let mgr = PtyManager::new();
        mgr.track_input(1, "claude\r");
        assert!(mgr.is_ai_session(1));
        mgr.track_input(1, "/quit\r");
        assert!(!mgr.is_ai_session(1));
    }

    #[test]
    fn quit_exits_ai_session() {
        let mgr = PtyManager::new();
        mgr.track_input(1, "codex\r");
        assert!(mgr.is_ai_session(1));
        mgr.track_input(1, "quit\r");
        assert!(!mgr.is_ai_session(1));
    }

    #[test]
    fn colon_quit_exits_codex_session() {
        let mgr = PtyManager::new();
        mgr.track_input(1, "codex\r");
        assert!(mgr.is_ai_session(1));
        mgr.track_input(1, ":quit\r");
        assert!(!mgr.is_ai_session(1));
    }

    #[test]
    fn slash_logout_exits_codex_session() {
        let mgr = PtyManager::new();
        mgr.track_input(1, "codex\r");
        assert!(mgr.is_ai_session(1));
        mgr.track_input(1, "/logout\r");
        assert!(!mgr.is_ai_session(1));
    }

    #[test]
    fn claude_with_interactive_args() {
        let mgr = PtyManager::new();
        mgr.track_input(1, "claude --model opus\r");
        assert!(mgr.is_ai_session(1));
    }

    #[test]
    fn claude_version_not_ai_session() {
        let mgr = PtyManager::new();
        mgr.track_input(1, "claude -v\r");
        assert!(!mgr.is_ai_session(1));
    }

    #[test]
    fn claude_long_version_not_ai_session() {
        let mgr = PtyManager::new();
        mgr.track_input(1, "claude --version\r");
        assert!(!mgr.is_ai_session(1));
    }

    #[test]
    fn claude_help_not_ai_session() {
        let mgr = PtyManager::new();
        mgr.track_input(1, "claude -h\r");
        assert!(!mgr.is_ai_session(1));
    }

    #[test]
    fn claude_print_not_ai_session() {
        let mgr = PtyManager::new();
        mgr.track_input(1, "claude -p \"hello\"\r");
        assert!(!mgr.is_ai_session(1));
    }

    #[test]
    fn codex_version_not_ai_session() {
        let mgr = PtyManager::new();
        mgr.track_input(1, "codex --version\r");
        assert!(!mgr.is_ai_session(1));
    }

    #[test]
    fn codex_help_not_ai_session() {
        let mgr = PtyManager::new();
        mgr.track_input(1, "codex --help\r");
        assert!(!mgr.is_ai_session(1));
    }

    #[test]
    fn backspace_corrects_input() {
        let mgr = PtyManager::new();
        mgr.track_input(1, "claue\x7fde\r");
        assert!(mgr.is_ai_session(1));
    }

    #[test]
    fn empty_enter_keeps_ai_session() {
        let mgr = PtyManager::new();
        mgr.track_input(1, "claude\r");
        assert!(mgr.is_ai_session(1));
        mgr.track_input(1, "\r");
        assert!(mgr.is_ai_session(1));
    }

    #[test]
    fn char_by_char_input() {
        let mgr = PtyManager::new();
        for ch in "claude\r".chars() {
            mgr.track_input(1, &ch.to_string());
        }
        assert!(mgr.is_ai_session(1));
    }

    #[test]
    fn captures_commands_for_session_events() {
        let mgr = PtyManager::new();
        let tracked = mgr.track_input(1, "npm test\r");
        assert_eq!(tracked.commands, vec!["npm test".to_string()]);
    }
}
