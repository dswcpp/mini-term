use git2::Repository;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

use crate::runtime_mcp;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyOutputPayload {
    session_id: String,
    pty_id: u32,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyExitPayload {
    session_id: String,
    pty_id: u32,
    exit_code: i32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySessionCreatedPayload {
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
    session_id: String,
    pty_id: u32,
    phase: String,
    last_exit_code: Option<i32>,
    updated_at: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtySessionCommandPayload {
    session_id: String,
    pty_id: u32,
    command: String,
    usage_scope: Option<String>,
    updated_at: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtySessionCwdPayload {
    session_id: String,
    pty_id: u32,
    cwd: String,
    updated_at: u64,
}

struct PtyInstance {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default, Clone)]
struct TrackedInputState {
    text: String,
    cursor: usize,
    escape: Option<EscapeState>,
}

#[derive(Clone)]
enum EscapeState {
    Start,
    Csi(String),
    Ss3,
}

#[derive(Default)]
pub struct TrackInputOutcome {
    commands: Vec<String>,
}

const AI_COMMANDS: &[&str] = &["claude", "codex"];
const STARTUP_OUTPUT_LIMIT: usize = 64 * 1024;
const NON_INTERACTIVE_FLAGS: &[&str] = &["-v", "--version", "-h", "--help", "-p", "--print"];
const AI_EXIT_COMMANDS: &[&str] = &["/exit", "exit", "/quit", "quit", ":quit", "/logout"];
const DOUBLE_CTRLC_WINDOW: Duration = Duration::from_millis(1000);
const MAX_TRACKED_INPUT_LEN: usize = 4096;

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

fn normalize_path_string(path: &Path) -> String {
    let mut value = path.to_string_lossy().replace('\\', "/");

    if let Some(stripped) = value.strip_prefix("//?/") {
        value = stripped.to_string();
    }

    if value.len() > 1 && value.ends_with('/') && !value.ends_with(":/") {
        value.pop();
    }

    value
}

fn escape_char_for_shell(shell_kind: &str, quote: Option<char>) -> Option<char> {
    match shell_kind {
        "powershell" | "pwsh" => Some('`'),
        "cmd" => Some('^'),
        "bash" | "zsh" | "unknown" => {
            if quote == Some('\'') {
                None
            } else {
                Some('\\')
            }
        }
        _ => Some('\\'),
    }
}

fn quote_chars_for_shell(shell_kind: &str) -> &'static [char] {
    match shell_kind {
        "cmd" => &['"'],
        _ => &['"', '\''],
    }
}

fn tokenize_shell_words(input: &str, shell_kind: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        if let Some(escape_char) = escape_char_for_shell(shell_kind, quote) {
            if ch == escape_char {
                if let Some(next) = chars.next() {
                    current.push(next);
                } else {
                    current.push(ch);
                }
                continue;
            }
        }

        if quote_chars_for_shell(shell_kind).contains(&ch) {
            if quote == Some(ch) {
                quote = None;
                continue;
            }
            if quote.is_none() {
                quote = Some(ch);
                continue;
            }
        }

        if quote.is_none() {
            if ch == ';' {
                break;
            }
            if (ch == '|' && chars.peek() == Some(&'|'))
                || (ch == '&' && chars.peek() == Some(&'&'))
            {
                break;
            }
            if ch == '|' || ch == '&' {
                break;
            }
            if ch.is_whitespace() {
                if !current.is_empty() {
                    tokens.push(current.clone());
                    current.clear();
                }
                continue;
            }
        }

        current.push(ch);
    }

    if !current.is_empty() {
        tokens.push(current);
    }

    tokens
}

fn home_directory() -> Option<PathBuf> {
    dirs::home_dir().and_then(|path| fs::canonicalize(path).ok())
}

fn expand_home_path(value: &str) -> Option<PathBuf> {
    if value == "~" {
        return home_directory();
    }

    let suffix = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"));
    suffix.and_then(|rest| home_directory().map(|home| home.join(rest)))
}

fn resolve_directory_target(current_cwd: &str, target: &str) -> Option<String> {
    if target.is_empty() || target == "-" {
        return None;
    }

    let candidate = if let Some(home) = expand_home_path(target) {
        home
    } else {
        let raw_path = PathBuf::from(target);
        if raw_path.is_absolute() {
            raw_path
        } else {
            Path::new(current_cwd).join(raw_path)
        }
    };

    fs::canonicalize(candidate)
        .ok()
        .filter(|path| path.is_dir())
        .map(|path| normalize_path_string(&path))
}

fn resolve_cwd_change(current_cwd: &str, shell_kind: &str, command: &str) -> Option<String> {
    let tokens = tokenize_shell_words(command, shell_kind);
    let first = tokens.first()?.to_ascii_lowercase();

    match first.as_str() {
        "cd" | "chdir" => {
            let mut index = 1;
            if shell_kind == "cmd"
                && tokens
                    .get(index)
                    .is_some_and(|token| token.eq_ignore_ascii_case("/d"))
            {
                index += 1;
            }
            if tokens.get(index).is_some_and(|token| token == "--") {
                index += 1;
            }

            let target = tokens.get(index).cloned().or_else(|| match shell_kind {
                "powershell" | "pwsh" | "bash" | "zsh" | "unknown" => Some("~".to_string()),
                _ => None,
            })?;

            resolve_directory_target(current_cwd, &target)
        }
        "set-location" | "sl" => {
            let mut index = 1;
            while index < tokens.len() {
                let token = tokens[index].to_ascii_lowercase();
                if token == "-path" || token == "-literalpath" {
                    return tokens
                        .get(index + 1)
                        .and_then(|target| resolve_directory_target(current_cwd, target));
                }
                if !token.starts_with('-') {
                    return resolve_directory_target(current_cwd, &tokens[index]);
                }
                index += 1;
            }
            resolve_directory_target(current_cwd, "~")
        }
        "pushd" => tokens
            .get(1)
            .and_then(|target| resolve_directory_target(current_cwd, target)),
        _ => None,
    }
}

fn resolve_usage_scope(
    command: &str,
    shell_kind: &str,
    current_cwd: &str,
    default_scope: &str,
) -> Option<String> {
    let first = tokenize_shell_words(command, shell_kind)
        .first()
        .map(|token| token.to_ascii_lowercase())?;

    if first == "git" {
        return Repository::discover(current_cwd)
            .ok()
            .and_then(|repo| repo.workdir().map(normalize_path_string))
            .or_else(|| Some(normalize_path_string(Path::new(current_cwd))));
    }

    Some(normalize_path_string(Path::new(default_scope)))
}

#[derive(Clone)]
pub struct PtyManager {
    instances: Arc<Mutex<HashMap<u32, Arc<Mutex<PtyInstance>>>>>,
    next_id: Arc<Mutex<u32>>,
    session_id_by_pty: Arc<Mutex<HashMap<u32, String>>>,
    pty_id_by_session: Arc<Mutex<HashMap<String, u32>>>,
    last_output: Arc<Mutex<HashMap<u32, Instant>>>,
    last_command_activity: Arc<Mutex<HashMap<u32, Instant>>>,
    startup_output: Arc<Mutex<HashMap<u32, String>>>,
    ai_sessions: Arc<Mutex<HashSet<u32>>>,
    input_buffers: Arc<Mutex<HashMap<u32, TrackedInputState>>>,
    last_ctrlc: Arc<Mutex<HashMap<u32, Instant>>>,
    session_cwds: Arc<Mutex<HashMap<u32, String>>>,
    session_roots: Arc<Mutex<HashMap<u32, String>>>,
    shell_kinds: Arc<Mutex<HashMap<u32, String>>>,
}

fn clamp_cursor(cursor: usize, text: &str) -> usize {
    cursor.min(text.len())
}

fn trim_tracked_input(state: &mut TrackedInputState) {
    if state.text.len() > MAX_TRACKED_INPUT_LEN {
        let overflow = state.text.len() - MAX_TRACKED_INPUT_LEN;
        state.text.drain(..overflow);
        state.cursor = state.cursor.saturating_sub(overflow);
    }
    state.cursor = clamp_cursor(state.cursor, &state.text);
}

fn clear_tracked_input(state: &mut TrackedInputState) {
    state.text.clear();
    state.cursor = 0;
    state.escape = None;
}

fn insert_tracked_char(state: &mut TrackedInputState, ch: char) {
    state.cursor = clamp_cursor(state.cursor, &state.text);
    state.text.insert(state.cursor, ch);
    state.cursor += ch.len_utf8();
    trim_tracked_input(state);
}

fn delete_backward(state: &mut TrackedInputState) {
    state.cursor = clamp_cursor(state.cursor, &state.text);
    if state.cursor == 0 {
        return;
    }

    let prev_start = state.text[..state.cursor]
        .char_indices()
        .last()
        .map(|(index, _)| index)
        .unwrap_or(0);
    state.text.drain(prev_start..state.cursor);
    state.cursor = prev_start;
}

fn delete_forward(state: &mut TrackedInputState) {
    state.cursor = clamp_cursor(state.cursor, &state.text);
    if state.cursor >= state.text.len() {
        return;
    }

    let next_end = state.text[state.cursor..]
        .char_indices()
        .nth(1)
        .map(|(index, _)| state.cursor + index)
        .unwrap_or(state.text.len());
    state.text.drain(state.cursor..next_end);
}

fn move_cursor_left(state: &mut TrackedInputState) {
    state.cursor = clamp_cursor(state.cursor, &state.text);
    if state.cursor == 0 {
        return;
    }
    state.cursor = state.text[..state.cursor]
        .char_indices()
        .last()
        .map(|(index, _)| index)
        .unwrap_or(0);
}

fn move_cursor_right(state: &mut TrackedInputState) {
    state.cursor = clamp_cursor(state.cursor, &state.text);
    if state.cursor >= state.text.len() {
        return;
    }
    state.cursor = state.text[state.cursor..]
        .char_indices()
        .nth(1)
        .map(|(index, _)| state.cursor + index)
        .unwrap_or(state.text.len());
}

fn move_cursor_home(state: &mut TrackedInputState) {
    state.cursor = 0;
}

fn move_cursor_end(state: &mut TrackedInputState) {
    state.cursor = state.text.len();
}

fn delete_to_line_start(state: &mut TrackedInputState) {
    state.cursor = clamp_cursor(state.cursor, &state.text);
    if state.cursor == 0 {
        return;
    }
    state.text.drain(..state.cursor);
    state.cursor = 0;
}

fn apply_csi_sequence(state: &mut TrackedInputState, params: &str, command: char) {
    match command {
        'D' => move_cursor_left(state),
        'C' => move_cursor_right(state),
        'H' => move_cursor_home(state),
        'F' => move_cursor_end(state),
        '~' => match params {
            "1" | "7" => move_cursor_home(state),
            "4" | "8" => move_cursor_end(state),
            "3" => delete_forward(state),
            _ => {}
        },
        _ => {}
    }
}

fn apply_ss3_sequence(state: &mut TrackedInputState, command: char) {
    match command {
        'H' => move_cursor_home(state),
        'F' => move_cursor_end(state),
        _ => {}
    }
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            instances: Arc::new(Mutex::new(HashMap::new())),
            next_id: Arc::new(Mutex::new(1)),
            session_id_by_pty: Arc::new(Mutex::new(HashMap::new())),
            pty_id_by_session: Arc::new(Mutex::new(HashMap::new())),
            last_output: Arc::new(Mutex::new(HashMap::new())),
            last_command_activity: Arc::new(Mutex::new(HashMap::new())),
            startup_output: Arc::new(Mutex::new(HashMap::new())),
            ai_sessions: Arc::new(Mutex::new(HashSet::new())),
            input_buffers: Arc::new(Mutex::new(HashMap::new())),
            last_ctrlc: Arc::new(Mutex::new(HashMap::new())),
            session_cwds: Arc::new(Mutex::new(HashMap::new())),
            session_roots: Arc::new(Mutex::new(HashMap::new())),
            shell_kinds: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn get_pty_ids(&self) -> Vec<u32> {
        self.instances.lock().unwrap().keys().copied().collect()
    }

    fn get_instance(&self, pty_id: u32) -> Option<Arc<Mutex<PtyInstance>>> {
        self.instances.lock().unwrap().get(&pty_id).cloned()
    }

    pub fn has_recent_output(&self, pty_id: u32, within: Duration) -> bool {
        let map = self.last_output.lock().unwrap();
        map.get(&pty_id)
            .map_or(false, |timestamp| timestamp.elapsed() < within)
    }

    #[cfg(test)]
    pub fn note_output_activity(&self, pty_id: u32) {
        self.last_output
            .lock()
            .unwrap()
            .insert(pty_id, Instant::now());
    }

    pub fn note_command_activity(&self, pty_id: u32) {
        self.last_command_activity
            .lock()
            .unwrap()
            .insert(pty_id, Instant::now());
    }

    pub fn has_recent_command_activity(&self, pty_id: u32, within: Duration) -> bool {
        let map = self.last_command_activity.lock().unwrap();
        map.get(&pty_id)
            .map_or(false, |timestamp| timestamp.elapsed() < within)
    }

    pub fn get_session_id(&self, pty_id: u32) -> String {
        self.session_id_by_pty
            .lock()
            .unwrap()
            .get(&pty_id)
            .cloned()
            .unwrap_or_else(|| session_id_for_pty(pty_id))
    }

    pub fn get_pty_id_for_session(&self, session_id: &str) -> Option<u32> {
        self.pty_id_by_session
            .lock()
            .unwrap()
            .get(session_id)
            .copied()
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
                if let Some(escape_state) = buf.escape.clone() {
                    match escape_state {
                        EscapeState::Start => {
                            buf.escape = match ch {
                                '[' => Some(EscapeState::Csi(String::new())),
                                'O' => Some(EscapeState::Ss3),
                                _ => None,
                            };
                            continue;
                        }
                        EscapeState::Csi(mut params) => {
                            if ch.is_ascii_digit() || ch == ';' {
                                params.push(ch);
                                buf.escape = Some(EscapeState::Csi(params));
                            } else {
                                apply_csi_sequence(buf, &params, ch);
                                buf.escape = None;
                            }
                            continue;
                        }
                        EscapeState::Ss3 => {
                            apply_ss3_sequence(buf, ch);
                            buf.escape = None;
                            continue;
                        }
                    }
                }

                match ch {
                    '\x1b' => {
                        buf.escape = Some(EscapeState::Start);
                    }
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
                        clear_tracked_input(buf);
                    }
                    '\x04' if in_ai => {
                        exit_ai = true;
                        clear_tracked_input(buf);
                    }
                    '\x03' => {
                        clear_tracked_input(buf);
                    }
                    '\x04' => {
                        if buf.cursor < buf.text.len() {
                            delete_forward(buf);
                        } else {
                            clear_tracked_input(buf);
                        }
                    }
                    '\x01' => {
                        move_cursor_home(buf);
                    }
                    '\x05' => {
                        move_cursor_end(buf);
                    }
                    '\x15' => {
                        delete_to_line_start(buf);
                    }
                    '\r' | '\n' => {
                        let raw_command = buf.text.trim().to_string();
                        let normalized = raw_command.to_lowercase();

                        if in_ai {
                            if AI_EXIT_COMMANDS
                                .iter()
                                .any(|&command| normalized == command)
                            {
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
                            let has_non_interactive_flag = is_ai_command
                                && words.any(|word| {
                                    NON_INTERACTIVE_FLAGS.iter().any(|&flag| word == flag)
                                });
                            if is_ai_command && !has_non_interactive_flag {
                                enter_ai = true;
                            }
                        }

                        if !raw_command.is_empty() {
                            commands.push(raw_command);
                        }
                        clear_tracked_input(buf);
                    }
                    '\x7f' | '\x08' => {
                        delete_backward(buf);
                    }
                    c if c >= ' ' => insert_tracked_char(buf, c),
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

fn link_session(state: &PtyManager, pty_id: u32, session_id: &str) {
    state
        .session_id_by_pty
        .lock()
        .unwrap()
        .insert(pty_id, session_id.to_string());
    state
        .pty_id_by_session
        .lock()
        .unwrap()
        .insert(session_id.to_string(), pty_id);
}

fn unlink_session(state: &PtyManager, pty_id: u32, session_id: &str) {
    state.session_id_by_pty.lock().unwrap().remove(&pty_id);
    let mut pty_by_session = state.pty_id_by_session.lock().unwrap();
    if pty_by_session.get(session_id).copied() == Some(pty_id) {
        pty_by_session.remove(session_id);
    }
}

fn create_pty_internal(
    app: &AppHandle,
    state: &PtyManager,
    shell: String,
    args: Vec<String>,
    cwd: String,
    session_id: Option<String>,
    mode: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<PtySessionCreatedPayload, String> {
    let pty_system = native_pty_system();
    let cols = cols.unwrap_or(80);
    let rows = rows.unwrap_or(24);
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
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
    let root_pid = child.process_id();

    let pty_id = {
        let mut next = state.next_id.lock().unwrap();
        let id = *next;
        *next += 1;
        id
    };

    let writer = pair
        .master
        .take_writer()
        .map_err(|error| error.to_string())?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| error.to_string())?;
    let master = pair.master;
    let session_id = session_id.unwrap_or_else(|| session_id_for_pty(pty_id));
    let mode = mode.unwrap_or_else(|| "human".to_string());

    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let instances_clone = state.instances.clone();
    let pty_id_for_reader = pty_id;
    let session_id_for_reader = session_id.clone();

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
    let session_id_by_pty = state.session_id_by_pty.clone();
    let pty_id_by_session = state.pty_id_by_session.clone();
    let last_output = state.last_output.clone();
    let last_command_activity = state.last_command_activity.clone();
    let startup_output = state.startup_output.clone();
    let ai_sessions = state.ai_sessions.clone();
    let input_buffers = state.input_buffers.clone();
    let last_ctrlc = state.last_ctrlc.clone();
    let session_cwds = state.session_cwds.clone();
    let session_roots = state.session_roots.clone();
    let shell_kinds = state.shell_kinds.clone();

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
                                session_id: session_id_for_reader.clone(),
                                pty_id: pty_id_for_reader,
                                data: data.clone(),
                            },
                        );
                        let _ = runtime_mcp::append_pty_output(pty_id_for_reader, &data);
                    }

                    let exit_code = {
                        let mut instances = instances_clone.lock().unwrap();
                        if let Some(inst) = instances.remove(&pty_id_for_reader) {
                            inst.lock()
                                .unwrap()
                                .child
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
                            session_id: session_id_for_reader.clone(),
                            pty_id: pty_id_for_reader,
                            phase: "exited".to_string(),
                            last_exit_code: Some(exit_code),
                            updated_at: now_timestamp_ms(),
                        },
                    );
                    let _ = runtime_mcp::update_pty_phase(pty_id_for_reader, "exited");
                    let _ = app_flush.emit(
                        "pty-exit",
                        PtyExitPayload {
                            session_id: session_id_for_reader.clone(),
                            pty_id: pty_id_for_reader,
                            exit_code,
                        },
                    );
                    let _ = runtime_mcp::mark_pty_exited(pty_id_for_reader, exit_code);

                    session_id_by_pty.lock().unwrap().remove(&pty_id_for_reader);
                    let mut session_map = pty_id_by_session.lock().unwrap();
                    if session_map.get(&session_id_for_reader).copied() == Some(pty_id_for_reader) {
                        session_map.remove(&session_id_for_reader);
                    }
                    last_output.lock().unwrap().remove(&pty_id_for_reader);
                    last_command_activity
                        .lock()
                        .unwrap()
                        .remove(&pty_id_for_reader);
                    startup_output.lock().unwrap().remove(&pty_id_for_reader);
                    ai_sessions.lock().unwrap().remove(&pty_id_for_reader);
                    input_buffers.lock().unwrap().remove(&pty_id_for_reader);
                    last_ctrlc.lock().unwrap().remove(&pty_id_for_reader);
                    session_cwds.lock().unwrap().remove(&pty_id_for_reader);
                    session_roots.lock().unwrap().remove(&pty_id_for_reader);
                    shell_kinds.lock().unwrap().remove(&pty_id_for_reader);
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
                        session_id: session_id_for_reader.clone(),
                        pty_id: pty_id_for_reader,
                        data: data.clone(),
                    },
                );
                let _ = runtime_mcp::append_pty_output(pty_id_for_reader, &data);
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
            Arc::new(Mutex::new(PtyInstance {
                writer,
                master,
                child,
            })),
        );
    }
    state
        .startup_output
        .lock()
        .unwrap()
        .insert(pty_id, String::new());
    state
        .session_cwds
        .lock()
        .unwrap()
        .insert(pty_id, normalize_path_string(Path::new(&cwd)));
    state
        .session_roots
        .lock()
        .unwrap()
        .insert(pty_id, normalize_path_string(Path::new(&cwd)));
    state
        .shell_kinds
        .lock()
        .unwrap()
        .insert(pty_id, infer_shell_kind(&shell));
    link_session(state, pty_id, &session_id);

    let now = now_timestamp_ms();
    let payload = PtySessionCreatedPayload {
        session_id,
        pty_id,
        shell: shell.clone(),
        shell_kind: infer_shell_kind(&shell),
        cwd,
        mode,
        phase: "starting".to_string(),
        created_at: now,
        updated_at: now,
    };
    let _ = app.emit("pty-session-created", payload.clone());
    let _ = runtime_mcp::register_pty(
        payload.pty_id,
        &payload.session_id,
        &payload.shell,
        &payload.shell_kind,
        &payload.cwd,
        &payload.mode,
        &payload.phase,
    );
    let _ = runtime_mcp::update_pty_size(payload.pty_id, cols, rows);
    let _ = runtime_mcp::update_pty_root_pid(payload.pty_id, root_pid);

    Ok(payload)
}

fn write_pty_internal(
    app: &AppHandle,
    state: &PtyManager,
    pty_id: u32,
    data: String,
) -> Result<(), String> {
    let instance = state.get_instance(pty_id).ok_or("PTY not found")?;
    let mut instance = instance.lock().unwrap();
    instance
        .writer
        .write_all(data.as_bytes())
        .map_err(|error| error.to_string())?;
    instance.writer.flush().map_err(|error| error.to_string())?;
    drop(instance);

    let tracked = state.track_input(pty_id, &data);
    if !tracked.commands.is_empty() {
        state.note_command_activity(pty_id);
    }
    let session_id = state.get_session_id(pty_id);
    for command in tracked.commands {
        let updated_at = now_timestamp_ms();
        let current_cwd = state.session_cwds.lock().unwrap().get(&pty_id).cloned();
        let default_scope = state.session_roots.lock().unwrap().get(&pty_id).cloned();
        let shell_kind = state
            .shell_kinds
            .lock()
            .unwrap()
            .get(&pty_id)
            .cloned()
            .unwrap_or_else(|| "unknown".to_string());
        let usage_scope = match (&current_cwd, &default_scope) {
            (Some(current_cwd), Some(default_scope)) => {
                resolve_usage_scope(&command, &shell_kind, current_cwd, default_scope)
            }
            _ => None,
        };
        let next_cwd = current_cwd
            .as_deref()
            .and_then(|cwd| resolve_cwd_change(cwd, &shell_kind, &command));
        let _ = app.emit(
            "pty-session-command-started",
            PtySessionCommandPayload {
                session_id: session_id.clone(),
                pty_id,
                command,
                usage_scope,
                updated_at,
            },
        );
        let _ = app.emit(
            "pty-session-phase-change",
            PtySessionPhasePayload {
                session_id: session_id.clone(),
                pty_id,
                phase: "running".to_string(),
                last_exit_code: None,
                updated_at,
            },
        );
        let _ = runtime_mcp::update_pty_phase(pty_id, "running");
        let _ = runtime_mcp::update_pty_status(pty_id, "running");

        if let Some(next_cwd) = next_cwd {
            state
                .session_cwds
                .lock()
                .unwrap()
                .insert(pty_id, next_cwd.clone());
            let _ = app.emit(
                "pty-session-cwd-changed",
                PtySessionCwdPayload {
                    session_id: session_id.clone(),
                    pty_id,
                    cwd: next_cwd.clone(),
                    updated_at,
                },
            );
            let _ = runtime_mcp::update_pty_cwd(pty_id, &next_cwd);
        }
    }

    Ok(())
}

fn resize_pty_internal(
    state: &PtyManager,
    pty_id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let instance = state.get_instance(pty_id).ok_or("PTY not found")?;
    let instance = instance.lock().unwrap();
    instance
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())?;
    let _ = runtime_mcp::update_pty_size(pty_id, cols, rows);
    Ok(())
}

fn kill_pty_internal(state: &PtyManager, pty_id: u32) -> Result<(), String> {
    let session_id = state.get_session_id(pty_id);
    if let Some(instance) = state.instances.lock().unwrap().remove(&pty_id) {
        let _ = instance.lock().unwrap().child.kill();
    } else {
        return Err("PTY not found".to_string());
    }
    state.last_output.lock().unwrap().remove(&pty_id);
    state.last_command_activity.lock().unwrap().remove(&pty_id);
    state.startup_output.lock().unwrap().remove(&pty_id);
    state.ai_sessions.lock().unwrap().remove(&pty_id);
    state.input_buffers.lock().unwrap().remove(&pty_id);
    state.last_ctrlc.lock().unwrap().remove(&pty_id);
    state.session_cwds.lock().unwrap().remove(&pty_id);
    state.session_roots.lock().unwrap().remove(&pty_id);
    state.shell_kinds.lock().unwrap().remove(&pty_id);
    unlink_session(state, pty_id, &session_id);
    let _ = runtime_mcp::remove_pty(pty_id);
    Ok(())
}

fn take_startup_output_internal(state: &PtyManager, pty_id: u32) -> Result<String, String> {
    let mut startup_output = state.startup_output.lock().unwrap();
    Ok(startup_output.remove(&pty_id).unwrap_or_default())
}

pub(crate) fn create_terminal_session_for_host(
    app: &AppHandle,
    state: &PtyManager,
    shell: String,
    args: Vec<String>,
    cwd: String,
    session_id: Option<String>,
    mode: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<PtySessionCreatedPayload, String> {
    create_pty_internal(app, state, shell, args, cwd, session_id, mode, cols, rows)
}

pub(crate) fn write_pty_for_host(
    app: &AppHandle,
    state: &PtyManager,
    pty_id: u32,
    data: String,
) -> Result<(), String> {
    write_pty_internal(app, state, pty_id, data)
}

pub(crate) fn resize_pty_for_host(
    state: &PtyManager,
    pty_id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    resize_pty_internal(state, pty_id, cols, rows)
}

pub(crate) fn kill_pty_for_host(state: &PtyManager, pty_id: u32) -> Result<(), String> {
    kill_pty_internal(state, pty_id)
}

#[tauri::command]
pub fn create_pty(
    app: AppHandle,
    state: tauri::State<'_, PtyManager>,
    shell: String,
    args: Vec<String>,
    cwd: String,
) -> Result<u32, String> {
    create_pty_internal(
        &app,
        state.inner(),
        shell,
        args,
        cwd,
        None,
        None,
        None,
        None,
    )
    .map(|payload| payload.pty_id)
}

#[tauri::command]
pub fn create_terminal_session(
    app: AppHandle,
    state: tauri::State<'_, PtyManager>,
    shell: String,
    args: Vec<String>,
    cwd: String,
    session_id: Option<String>,
    mode: Option<String>,
) -> Result<PtySessionCreatedPayload, String> {
    create_pty_internal(
        &app,
        state.inner(),
        shell,
        args,
        cwd,
        session_id,
        mode,
        None,
        None,
    )
}

#[tauri::command]
pub fn write_pty(
    app: AppHandle,
    state: tauri::State<'_, PtyManager>,
    pty_id: u32,
    data: String,
) -> Result<(), String> {
    write_pty_internal(&app, state.inner(), pty_id, data)
}

#[tauri::command]
pub fn write_terminal_input(
    app: AppHandle,
    state: tauri::State<'_, PtyManager>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let pty_id = state
        .get_pty_id_for_session(&session_id)
        .ok_or("PTY not found for session")?;
    write_pty_internal(&app, state.inner(), pty_id, data)
}

#[tauri::command]
pub fn run_terminal_command(
    app: AppHandle,
    state: tauri::State<'_, PtyManager>,
    session_id: String,
    command: String,
) -> Result<(), String> {
    let mut data = command;
    if !data.ends_with('\n') && !data.ends_with('\r') {
        data.push('\r');
    }
    write_terminal_input(app, state, session_id, data)
}

#[tauri::command]
pub fn resize_pty(
    state: tauri::State<'_, PtyManager>,
    pty_id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    resize_pty_internal(state.inner(), pty_id, cols, rows)
}

#[tauri::command]
pub fn resize_terminal_session(
    state: tauri::State<'_, PtyManager>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let pty_id = state
        .get_pty_id_for_session(&session_id)
        .ok_or("PTY not found for session")?;
    resize_pty_internal(state.inner(), pty_id, cols, rows)
}

#[tauri::command]
pub fn kill_pty(state: tauri::State<'_, PtyManager>, pty_id: u32) -> Result<(), String> {
    kill_pty_internal(state.inner(), pty_id)
}

#[tauri::command]
pub fn close_terminal_session(
    state: tauri::State<'_, PtyManager>,
    session_id: String,
) -> Result<(), String> {
    let pty_id = state
        .get_pty_id_for_session(&session_id)
        .ok_or("PTY not found for session")?;
    kill_pty_internal(state.inner(), pty_id)
}

#[tauri::command]
pub fn restart_terminal_session(
    app: AppHandle,
    state: tauri::State<'_, PtyManager>,
    session_id: String,
    shell: String,
    args: Vec<String>,
    cwd: String,
    mode: Option<String>,
) -> Result<PtySessionCreatedPayload, String> {
    if let Some(existing_pty_id) = state.get_pty_id_for_session(&session_id) {
        let _ = kill_pty_internal(state.inner(), existing_pty_id);
    }

    create_pty_internal(
        &app,
        state.inner(),
        shell,
        args,
        cwd,
        Some(session_id),
        mode,
        None,
        None,
    )
}

#[tauri::command]
pub fn take_startup_output(
    state: tauri::State<'_, PtyManager>,
    pty_id: u32,
) -> Result<String, String> {
    take_startup_output_internal(state.inner(), pty_id)
}

#[tauri::command]
pub fn take_terminal_startup_output(
    state: tauri::State<'_, PtyManager>,
    session_id: String,
) -> Result<String, String> {
    let pty_id = state
        .get_pty_id_for_session(&session_id)
        .ok_or("PTY not found for session")?;
    take_startup_output_internal(state.inner(), pty_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Error;
    use portable_pty::{ExitStatus, MasterPty, PtySize};
    use std::fs;
    use std::io;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Condvar, Mutex as StdMutex};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn create_temp_dir(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("mini-term-{label}-{unique}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[derive(Debug, Default)]
    struct DummyWriter;

    impl Write for DummyWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[derive(Debug, Clone)]
    struct ResizeBlocker {
        entered: Arc<(StdMutex<bool>, Condvar)>,
        release: Arc<(StdMutex<bool>, Condvar)>,
    }

    impl ResizeBlocker {
        fn new() -> Self {
            Self {
                entered: Arc::new((StdMutex::new(false), Condvar::new())),
                release: Arc::new((StdMutex::new(false), Condvar::new())),
            }
        }

        fn wait_until_entered(&self) {
            let (lock, cvar) = &*self.entered;
            let mut entered = lock.lock().unwrap();
            while !*entered {
                entered = cvar.wait(entered).unwrap();
            }
        }

        fn release(&self) {
            let (lock, cvar) = &*self.release;
            *lock.lock().unwrap() = true;
            cvar.notify_all();
        }
    }

    #[derive(Debug)]
    struct MockMaster {
        blocker: Option<ResizeBlocker>,
    }

    impl MasterPty for MockMaster {
        fn resize(&self, _size: PtySize) -> Result<(), Error> {
            if let Some(blocker) = &self.blocker {
                let (entered_lock, entered_cvar) = &*blocker.entered;
                *entered_lock.lock().unwrap() = true;
                entered_cvar.notify_all();

                let (release_lock, release_cvar) = &*blocker.release;
                let mut released = release_lock.lock().unwrap();
                while !*released {
                    released = release_cvar.wait(released).unwrap();
                }
            }
            Ok(())
        }

        fn get_size(&self) -> Result<PtySize, Error> {
            Ok(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
        }

        fn try_clone_reader(&self) -> Result<Box<dyn Read + Send>, Error> {
            Ok(Box::new(io::empty()))
        }

        fn take_writer(&self) -> Result<Box<dyn Write + Send>, Error> {
            Ok(Box::new(DummyWriter))
        }
    }

    #[derive(Debug, Clone)]
    struct MockChildKiller {
        killed: Arc<AtomicBool>,
    }

    impl portable_pty::ChildKiller for MockChildKiller {
        fn kill(&mut self) -> io::Result<()> {
            self.killed.store(true, Ordering::Release);
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            Box::new(self.clone())
        }
    }

    #[derive(Debug)]
    struct MockChild {
        killer: MockChildKiller,
        exit_code: u32,
    }

    impl portable_pty::ChildKiller for MockChild {
        fn kill(&mut self) -> io::Result<()> {
            self.killer.kill()
        }

        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            self.killer.clone_killer()
        }
    }

    impl portable_pty::Child for MockChild {
        fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
            Ok(Some(ExitStatus::with_exit_code(self.exit_code)))
        }

        fn wait(&mut self) -> io::Result<ExitStatus> {
            Ok(ExitStatus::with_exit_code(self.exit_code))
        }

        fn process_id(&self) -> Option<u32> {
            Some(1)
        }

        #[cfg(windows)]
        fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
            None
        }
    }

    fn insert_mock_instance(
        state: &PtyManager,
        pty_id: u32,
        blocker: Option<ResizeBlocker>,
    ) -> Arc<AtomicBool> {
        let killed = Arc::new(AtomicBool::new(false));
        state.instances.lock().unwrap().insert(
            pty_id,
            Arc::new(Mutex::new(PtyInstance {
                writer: Box::new(DummyWriter),
                master: Box::new(MockMaster { blocker }),
                child: Box::new(MockChild {
                    killer: MockChildKiller {
                        killed: Arc::clone(&killed),
                    },
                    exit_code: 0,
                }),
            })),
        );
        killed
    }

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

    #[test]
    fn arrow_keys_do_not_pollute_tracked_command() {
        let mgr = PtyManager::new();
        let tracked = mgr.track_input(1, "git fetch\x1b[D\x1b[D\x1b[C\x1b[C --all\r");
        assert_eq!(tracked.commands, vec!["git fetch --all".to_string()]);
    }

    #[test]
    fn cursor_movement_allows_mid_line_insertions() {
        let mgr = PtyManager::new();
        let tracked = mgr.track_input(1, "git stats\x1b[Du\r");
        assert_eq!(tracked.commands, vec!["git status".to_string()]);
    }

    #[test]
    fn ctrl_c_clears_pending_command_outside_ai_session() {
        let mgr = PtyManager::new();
        let tracked = mgr.track_input(1, "git stat\x03ls\r");
        assert_eq!(tracked.commands, vec!["ls".to_string()]);
    }

    #[test]
    fn resolves_relative_cd_commands_to_new_cwd() {
        let root = create_temp_dir("cwd-relative");
        let current = root.join("project");
        let next = current.join("src");
        fs::create_dir_all(&next).unwrap();

        let resolved = resolve_cwd_change(current.to_string_lossy().as_ref(), "bash", "cd src");

        assert_eq!(resolved, Some(normalize_path_string(&next)));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn resolves_powershell_set_location_with_quotes() {
        let root = create_temp_dir("cwd-powershell");
        let current = root.join("workspace");
        let next = current.join("my dir");
        fs::create_dir_all(&next).unwrap();

        let resolved = resolve_cwd_change(
            current.to_string_lossy().as_ref(),
            "powershell",
            "Set-Location \"my dir\"",
        );

        assert_eq!(resolved, Some(normalize_path_string(&next)));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn git_usage_scope_prefers_repository_root() {
        let root = create_temp_dir("usage-scope");
        let repo_root = root.join("repo");
        let nested = repo_root.join("packages").join("app");
        fs::create_dir_all(&nested).unwrap();
        Repository::init(&repo_root).unwrap();

        let scope = resolve_usage_scope(
            "git status",
            "bash",
            nested.to_string_lossy().as_ref(),
            root.to_string_lossy().as_ref(),
        );

        assert_eq!(scope, Some(normalize_path_string(&repo_root)));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn non_git_usage_scope_falls_back_to_project_root() {
        let root = create_temp_dir("usage-default");
        let nested = root.join("workspace").join("nested");
        fs::create_dir_all(&nested).unwrap();

        let scope = resolve_usage_scope(
            "npm test",
            "bash",
            nested.to_string_lossy().as_ref(),
            root.to_string_lossy().as_ref(),
        );

        assert_eq!(scope, Some(normalize_path_string(&root)));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn resize_on_one_pty_does_not_block_kill_on_another() {
        let state = PtyManager::new();
        let blocker = ResizeBlocker::new();
        let _ = insert_mock_instance(&state, 1, Some(blocker.clone()));
        let killed = insert_mock_instance(&state, 2, None);

        let state_for_resize = state.clone();
        let resize_thread = std::thread::spawn(move || {
            resize_pty_internal(&state_for_resize, 1, 120, 40).expect("resize should succeed");
        });

        blocker.wait_until_entered();
        kill_pty_internal(&state, 2).expect("kill should succeed");
        assert!(killed.load(Ordering::Acquire));
        assert!(state.get_instance(2).is_none());

        blocker.release();
        resize_thread.join().expect("resize thread should complete");
    }
}
