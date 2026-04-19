use crate::agent_core::data_dir::{app_data_dir, ensure_parent};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[cfg(test)]
use std::sync::atomic::AtomicUsize;

const RUNTIME_STATE_FILE: &str = "runtime_mcp_state.json";
const MAX_RECENT_EVENTS: usize = 200;
const MAX_OUTPUT_PREVIEW_CHARS: usize = 400;
const MAX_OUTPUT_TAIL_CHARS: usize = 64 * 1024;
const MAX_OUTPUT_SUMMARY_CHARS: usize = 120;
const MAX_STARTUP_OUTPUT_CHARS: usize = 64 * 1024;
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(2);
const FLUSH_INTERVAL: Duration = Duration::from_millis(200);

fn heartbeat_started() -> &'static OnceLock<()> {
    static STARTED: OnceLock<()> = OnceLock::new();
    &STARTED
}

fn runtime_store_registry() -> &'static Mutex<HashMap<PathBuf, Arc<RuntimeStateStore>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<PathBuf, Arc<RuntimeStateStore>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn runtime_state_path() -> PathBuf {
    app_data_dir().join(RUNTIME_STATE_FILE)
}

struct RuntimeStateStore {
    path: PathBuf,
    state: Mutex<RuntimeMcpState>,
    dirty: AtomicBool,
    flush_started: OnceLock<()>,
    #[cfg(test)]
    write_count: AtomicUsize,
}

fn display_path(path: &str) -> String {
    #[cfg(windows)]
    {
        let cleaned = if let Some(rest) = path.strip_prefix("\\\\?\\UNC\\") {
            format!("\\\\{rest}")
        } else if let Some(rest) = path.strip_prefix("\\\\?\\") {
            rest.to_string()
        } else {
            path.to_string()
        };
        cleaned.replace('/', "\\")
    }

    #[cfg(not(windows))]
    path.to_string()
}

fn now_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn truncate_chars(value: &str, limit: usize) -> String {
    let truncated: String = value.chars().take(limit).collect();
    if value.chars().count() > limit {
        format!("{truncated}...")
    } else {
        truncated
    }
}

/// Strip ANSI/VT100 escape sequences and non-printable control characters,
/// leaving only human-readable text and newlines.
///
/// Handles: CSI (`ESC [`), OSC (`ESC ]`), DCS/APC/PM/SOS, and single-char
/// Fe sequences. Normalises `\r\n` → `\n` and discards bare `\r`.
fn strip_ansi(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        match ch {
            '\x1b' => match chars.peek().copied() {
                // CSI – ESC [ … ends at final byte 0x40–0x7E
                Some('[') => {
                    chars.next();
                    for c in chars.by_ref() {
                        if ('\x40'..='\x7e').contains(&c) {
                            break;
                        }
                    }
                }
                // OSC – ESC ] … terminated by BEL or ST (ESC \)
                Some(']') => {
                    chars.next();
                    loop {
                        match chars.next() {
                            Some('\x07') | None => break,
                            Some('\x1b') => {
                                if chars.peek() == Some(&'\\') {
                                    chars.next();
                                }
                                break;
                            }
                            _ => {}
                        }
                    }
                }
                // DCS / APC / PM / SOS – ESC P/^/_/X … terminated by ST
                Some('P') | Some('^') | Some('_') | Some('X') => {
                    chars.next();
                    loop {
                        match chars.next() {
                            None => break,
                            Some('\x1b') => {
                                if chars.peek() == Some(&'\\') {
                                    chars.next();
                                }
                                break;
                            }
                            _ => {}
                        }
                    }
                }
                // All other ESC sequences: skip the one character that follows
                Some(_) => {
                    chars.next();
                }
                None => {}
            },
            // \r\n → \n; bare \r → discard
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    result.push('\n');
                    chars.next();
                }
            }
            '\n' => result.push('\n'),
            '\t' => result.push(' '),
            // Strip remaining C0/C1 control characters
            c if (c as u32) < 0x20 || c == '\x7f' => {}
            c => result.push(c),
        }
    }
    result
}

/// Remove PTY snapshot entries that are definitively stale:
///  - `exited` entries older than 5 minutes (already done, no need to keep)
fn prune_stale_ptys(state: &mut RuntimeMcpState) {
    const EXITED_RETENTION_MS: u64 = 5 * 60 * 1_000;
    let now = now_timestamp_ms();
    state.ptys.retain(|pty| {
        if pty.phase == "exited" {
            now.saturating_sub(pty.updated_at) < EXITED_RETENTION_MS
        } else {
            true
        }
    });
}

fn truncate_recent_chars(value: &str, limit: usize) -> String {
    let char_count = value.chars().count();
    if char_count <= limit {
        return value.to_string();
    }

    if limit <= 3 {
        return value
            .chars()
            .skip(char_count.saturating_sub(limit))
            .collect();
    }

    let tail: String = value.chars().skip(char_count - (limit - 3)).collect();
    format!("...{tail}")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeHostInfo {
    pub app_version: String,
    pub desktop_pid: u32,
    pub transport_mode: String,
    pub last_heartbeat_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_control: Option<RuntimeHostControlInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeHostControlInfo {
    pub transport: String,
    pub endpoint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePtySnapshot {
    pub pty_id: u32,
    pub session_id: String,
    pub shell: String,
    pub shell_kind: String,
    pub cwd: String,
    pub root_path: String,
    pub mode: String,
    pub phase: String,
    pub status: String,
    pub last_output_at: Option<u64>,
    pub output_preview: String,
    pub output_tail: String,
    pub startup_output: String,
    pub cols: u16,
    pub rows: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_pid: Option<u32>,
    pub created_at: u64,
    pub updated_at: u64,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeWatcherSnapshot {
    pub watch_path: String,
    pub project_path: String,
    pub recursive: bool,
    pub updated_at: u64,
}

#[derive(Debug, Clone)]
pub struct RuntimeFsEventRecord {
    pub path: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEvent {
    pub event_id: String,
    pub kind: String,
    pub timestamp: u64,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload_preview: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeMcpState {
    pub schema_version: u32,
    pub updated_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<RuntimeHostInfo>,
    #[serde(default)]
    pub ptys: Vec<RuntimePtySnapshot>,
    #[serde(default)]
    pub watchers: Vec<RuntimeWatcherSnapshot>,
    #[serde(default)]
    pub recent_events: Vec<RuntimeEvent>,
}

impl Default for RuntimeMcpState {
    fn default() -> Self {
        Self {
            schema_version: 1,
            updated_at: now_timestamp_ms(),
            host: None,
            ptys: Vec::new(),
            watchers: Vec::new(),
            recent_events: Vec::new(),
        }
    }
}

fn load_state_from_path(path: &Path) -> RuntimeMcpState {
    match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => RuntimeMcpState::default(),
    }
}

fn save_state_to_path(path: &Path, state: &RuntimeMcpState) -> Result<(), String> {
    ensure_parent(path)?;
    let json = serde_json::to_vec_pretty(state).map_err(|err| err.to_string())?;
    let temp_path = path.with_extension("json.tmp");
    fs::write(&temp_path, json).map_err(|err| err.to_string())?;
    fs::rename(&temp_path, path)
        .or_else(|_| {
            let _ = fs::remove_file(path);
            fs::rename(&temp_path, path)
        })
        .map_err(|err| err.to_string())
}

impl RuntimeStateStore {
    fn new(path: PathBuf) -> Self {
        Self {
            state: Mutex::new(load_state_from_path(&path)),
            path,
            dirty: AtomicBool::new(false),
            flush_started: OnceLock::new(),
            #[cfg(test)]
            write_count: AtomicUsize::new(0),
        }
    }

    fn snapshot(&self) -> RuntimeMcpState {
        self.state.lock().unwrap().clone()
    }

    fn mutate(&self, mutator: impl FnOnce(&mut RuntimeMcpState)) {
        let mut state = self.state.lock().unwrap();
        mutator(&mut state);
        prune_stale_ptys(&mut state);
        state.updated_at = now_timestamp_ms();
        self.dirty.store(true, Ordering::Release);
    }

    #[cfg(test)]
    fn replace_for_tests(&self, state: RuntimeMcpState) -> Result<(), String> {
        {
            let mut current = self.state.lock().unwrap();
            *current = state;
            prune_stale_ptys(&mut current);
            current.updated_at = now_timestamp_ms();
        }
        self.dirty.store(true, Ordering::Release);
        self.flush_now()
    }

    fn flush_now(&self) -> Result<(), String> {
        if !self.dirty.swap(false, Ordering::AcqRel) {
            return Ok(());
        }

        let snapshot = self.snapshot();
        match save_state_to_path(&self.path, &snapshot) {
            Ok(()) => {
                #[cfg(test)]
                self.write_count.fetch_add(1, Ordering::Relaxed);
                Ok(())
            }
            Err(err) => {
                self.dirty.store(true, Ordering::Release);
                Err(err)
            }
        }
    }

    fn ensure_flush_thread(self: &Arc<Self>) {
        if self.flush_started.set(()).is_err() {
            return;
        }

        let store = Arc::clone(self);
        thread::spawn(move || loop {
            thread::sleep(FLUSH_INTERVAL);
            if store.dirty.load(Ordering::Acquire) {
                let _ = store.flush_now();
            }
        });
    }
}

fn runtime_store_for_path(path: PathBuf) -> Arc<RuntimeStateStore> {
    let store = {
        let mut registry = runtime_store_registry().lock().unwrap();
        registry
            .entry(path.clone())
            .or_insert_with(|| Arc::new(RuntimeStateStore::new(path)))
            .clone()
    };
    store.ensure_flush_thread();
    store
}

fn runtime_store() -> Arc<RuntimeStateStore> {
    runtime_store_for_path(runtime_state_path())
}

fn mutate_state_with_store(
    store: &Arc<RuntimeStateStore>,
    mutator: impl FnOnce(&mut RuntimeMcpState),
) -> Result<(), String> {
    store.mutate(mutator);
    Ok(())
}

fn mutate_state(mutator: impl FnOnce(&mut RuntimeMcpState)) -> Result<(), String> {
    let store = runtime_store();
    mutate_state_with_store(&store, mutator)
}

pub(crate) fn runtime_state_path_for_current_thread() -> PathBuf {
    runtime_state_path()
}

pub(crate) fn record_fs_event_batch_for_path(
    runtime_path: PathBuf,
    project_path: &str,
    events: &[RuntimeFsEventRecord],
) -> Result<(), String> {
    let store = runtime_store_for_path(runtime_path);
    if events.is_empty() {
        return Ok(());
    }

    mutate_state_with_store(&store, |state| {
        let project_path = display_path(project_path);
        let mut kind_counts = BTreeMap::<String, usize>::new();
        let sample_paths = events
            .iter()
            .take(5)
            .map(|event| {
                *kind_counts.entry(event.kind.clone()).or_default() += 1;
                display_path(&event.path)
            })
            .collect::<Vec<_>>();

        for event in events.iter().skip(5) {
            *kind_counts.entry(event.kind.clone()).or_default() += 1;
        }

        let summary = if events.len() == 1 {
            format!("FS change detected at {}.", sample_paths[0])
        } else {
            format!(
                "FS change batch detected at {} paths under {}.",
                events.len(),
                project_path
            )
        };

        push_event(
            state,
            "fs-change",
            summary,
            Some(json!({
                "projectPath": project_path,
                "count": events.len(),
                "samplePaths": sample_paths,
                "kindCounts": kind_counts,
            })),
        );
    })
}

pub(crate) fn update_host_heartbeat_for_path(
    runtime_path: PathBuf,
    app_version: &str,
) -> Result<(), String> {
    let store = runtime_store_for_path(runtime_path);
    mutate_state_with_store(&store, |state| {
        let host = state.host.get_or_insert(RuntimeHostInfo {
            app_version: app_version.to_string(),
            desktop_pid: std::process::id(),
            transport_mode: "app-data-snapshot".to_string(),
            last_heartbeat_at: now_timestamp_ms(),
            host_control: None,
        });
        host.app_version = app_version.to_string();
        host.desktop_pid = std::process::id();
        host.transport_mode = "app-data-snapshot".to_string();
        host.last_heartbeat_at = now_timestamp_ms();
    })
}

fn push_event(
    state: &mut RuntimeMcpState,
    kind: &str,
    summary: String,
    payload_preview: Option<Value>,
) {
    state.recent_events.push(RuntimeEvent {
        event_id: Uuid::now_v7().to_string(),
        kind: kind.to_string(),
        timestamp: now_timestamp_ms(),
        summary,
        payload_preview,
    });
    if state.recent_events.len() > MAX_RECENT_EVENTS {
        let overflow = state.recent_events.len() - MAX_RECENT_EVENTS;
        state.recent_events.drain(0..overflow);
    }
}

fn find_pty_mut(state: &mut RuntimeMcpState, pty_id: u32) -> Option<&mut RuntimePtySnapshot> {
    state.ptys.iter_mut().find(|item| item.pty_id == pty_id)
}

pub fn load_runtime_state() -> RuntimeMcpState {
    runtime_store().snapshot()
}

pub fn initialize_runtime_host(app_version: &str) -> Result<(), String> {
    mutate_state(|state| {
        state.host = Some(RuntimeHostInfo {
            app_version: app_version.to_string(),
            desktop_pid: std::process::id(),
            transport_mode: "app-data-snapshot".to_string(),
            last_heartbeat_at: now_timestamp_ms(),
            host_control: None,
        });
        state.ptys.clear();
        state.watchers.clear();
        state.recent_events.clear();
        push_event(
            state,
            "host-started",
            "Mini-Term desktop host initialized runtime MCP state.".to_string(),
            Some(json!({
                "appVersion": app_version,
                "desktopPid": std::process::id(),
            })),
        );
    })
}

pub fn start_runtime_heartbeat(app_version: String) {
    if heartbeat_started().set(()).is_err() {
        return;
    }

    let runtime_path = runtime_state_path_for_current_thread();
    thread::spawn(move || loop {
        let _ = update_host_heartbeat_for_path(runtime_path.clone(), &app_version);
        thread::sleep(HEARTBEAT_INTERVAL);
    });
}

pub fn register_pty(
    pty_id: u32,
    session_id: &str,
    shell: &str,
    shell_kind: &str,
    cwd: &str,
    mode: &str,
    phase: &str,
) -> Result<(), String> {
    mutate_state(|state| {
        let now = now_timestamp_ms();
        let cwd = display_path(cwd);
        state.ptys.retain(|item| item.pty_id != pty_id);
        state.ptys.push(RuntimePtySnapshot {
            pty_id,
            session_id: session_id.to_string(),
            shell: shell.to_string(),
            shell_kind: shell_kind.to_string(),
            cwd: cwd.clone(),
            root_path: cwd.clone(),
            mode: mode.to_string(),
            phase: phase.to_string(),
            status: "idle".to_string(),
            last_output_at: None,
            output_preview: String::new(),
            output_tail: String::new(),
            startup_output: String::new(),
            cols: 80,
            rows: 24,
            root_pid: None,
            created_at: now,
            updated_at: now,
            exit_code: None,
        });
        state.ptys.sort_by_key(|item| item.pty_id);
        push_event(
            state,
            "pty-session-created",
            format!("PTY {pty_id} session {session_id} created in {cwd}."),
            Some(json!({
                "ptyId": pty_id,
                "sessionId": session_id,
                "cwd": cwd,
                "shell": shell,
                "mode": mode,
            })),
        );
    })
}

pub fn update_pty_phase(pty_id: u32, phase: &str) -> Result<(), String> {
    mutate_state(|state| {
        if let Some(item) = find_pty_mut(state, pty_id) {
            item.phase = phase.to_string();
            item.updated_at = now_timestamp_ms();
            if phase == "running" && item.status == "idle" {
                item.status = "running".to_string();
            }
            if phase == "exited" {
                item.status = "exited".to_string();
            }
        }
    })
}

pub fn update_pty_cwd(pty_id: u32, cwd: &str) -> Result<(), String> {
    mutate_state(|state| {
        let cwd = display_path(cwd);
        if let Some(item) = find_pty_mut(state, pty_id) {
            item.cwd = cwd;
            item.updated_at = now_timestamp_ms();
        }
    })
}

pub fn update_pty_status(pty_id: u32, status: &str) -> Result<(), String> {
    mutate_state(|state| {
        let mut event_payload = None;
        if let Some(item) = find_pty_mut(state, pty_id) {
            item.status = status.to_string();
            item.updated_at = now_timestamp_ms();
            event_payload = Some((item.pty_id, item.session_id.clone(), status.to_string()));
        }
        if let Some((event_pty_id, session_id, next_status)) = event_payload {
            push_event(
                state,
                "pty-status-change",
                format!("PTY {} status changed to {}.", event_pty_id, next_status),
                Some(json!({
                    "ptyId": event_pty_id,
                    "sessionId": session_id,
                    "status": next_status,
                })),
            );
        }
    })
}

pub fn append_pty_output(pty_id: u32, data: &str) -> Result<(), String> {
    mutate_state(|state| {
        let mut event_payload = None;
        if let Some(item) = find_pty_mut(state, pty_id) {
            item.last_output_at = Some(now_timestamp_ms());
            item.updated_at = now_timestamp_ms();
            let clean = strip_ansi(data);
            item.output_preview.push_str(&clean);
            item.output_preview =
                truncate_recent_chars(&item.output_preview, MAX_OUTPUT_PREVIEW_CHARS);
            item.output_tail.push_str(&clean);
            item.output_tail = truncate_recent_chars(&item.output_tail, MAX_OUTPUT_TAIL_CHARS);
            if item.startup_output.chars().count() < MAX_STARTUP_OUTPUT_CHARS {
                item.startup_output.push_str(&clean);
                item.startup_output =
                    truncate_chars(&item.startup_output, MAX_STARTUP_OUTPUT_CHARS);
            }
            // Advance phase from 'starting' to 'running' on first real output.
            if item.phase == "starting" {
                item.phase = "running".to_string();
            }
            if item.phase != "exited" && !item.status.starts_with("ai-") {
                item.status = "running".to_string();
            }
            event_payload = Some((
                item.pty_id,
                item.session_id.clone(),
                truncate_chars(data, MAX_OUTPUT_SUMMARY_CHARS),
            ));
        }
        if let Some((event_pty_id, session_id, preview)) = event_payload {
            push_event(
                state,
                "pty-output",
                format!("PTY {} emitted output.", event_pty_id),
                Some(json!({
                    "ptyId": event_pty_id,
                    "sessionId": session_id,
                    "preview": preview,
                })),
            );
        }
    })
}

pub fn mark_pty_exited(pty_id: u32, exit_code: i32) -> Result<(), String> {
    mutate_state(|state| {
        let mut event_payload = None;
        if let Some(item) = find_pty_mut(state, pty_id) {
            item.phase = "exited".to_string();
            item.status = "exited".to_string();
            item.exit_code = Some(exit_code);
            item.updated_at = now_timestamp_ms();
            event_payload = Some((item.pty_id, item.session_id.clone(), exit_code));
        }
        if let Some((event_pty_id, session_id, event_exit_code)) = event_payload {
            push_event(
                state,
                "pty-exit",
                format!("PTY {} exited with code {}.", event_pty_id, event_exit_code),
                Some(json!({
                    "ptyId": event_pty_id,
                    "sessionId": session_id,
                    "exitCode": event_exit_code,
                })),
            );
        }
    })
}

pub fn remove_pty(pty_id: u32) -> Result<(), String> {
    mutate_state(|state| {
        let removed = state
            .ptys
            .iter()
            .find(|item| item.pty_id == pty_id)
            .cloned();
        state.ptys.retain(|item| item.pty_id != pty_id);
        if let Some(item) = removed {
            push_event(
                state,
                "pty-session-removed",
                format!(
                    "PTY {} session {} removed from runtime snapshot.",
                    item.pty_id, item.session_id
                ),
                Some(json!({
                    "ptyId": item.pty_id,
                    "sessionId": item.session_id,
                    "phase": item.phase,
                    "status": item.status,
                    "exitCode": item.exit_code,
                })),
            );
        }
    })
}

pub fn update_pty_size(pty_id: u32, cols: u16, rows: u16) -> Result<(), String> {
    mutate_state(|state| {
        if let Some(item) = find_pty_mut(state, pty_id) {
            item.cols = cols;
            item.rows = rows;
            item.updated_at = now_timestamp_ms();
        }
    })
}

pub fn update_pty_root_pid(pty_id: u32, root_pid: Option<u32>) -> Result<(), String> {
    mutate_state(|state| {
        if let Some(item) = find_pty_mut(state, pty_id) {
            item.root_pid = root_pid;
            item.updated_at = now_timestamp_ms();
        }
    })
}

pub fn set_host_control_info(
    transport: String,
    endpoint: String,
    token: Option<String>,
    capabilities: Vec<String>,
) -> Result<(), String> {
    mutate_state(|state| {
        let host = state.host.get_or_insert(RuntimeHostInfo {
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            desktop_pid: std::process::id(),
            transport_mode: "app-data-snapshot".to_string(),
            last_heartbeat_at: now_timestamp_ms(),
            host_control: None,
        });
        host.host_control = Some(RuntimeHostControlInfo {
            transport,
            endpoint,
            token,
            capabilities,
        });
    })
}

pub fn register_fs_watch(
    watch_path: &str,
    project_path: &str,
    recursive: bool,
) -> Result<(), String> {
    mutate_state(|state| {
        let now = now_timestamp_ms();
        let watch_path = display_path(watch_path);
        let project_path = display_path(project_path);
        state.watchers.retain(|item| item.watch_path != watch_path);
        state.watchers.push(RuntimeWatcherSnapshot {
            watch_path: watch_path.clone(),
            project_path: project_path.clone(),
            recursive,
            updated_at: now,
        });
        state
            .watchers
            .sort_by(|a, b| a.watch_path.cmp(&b.watch_path));
        push_event(
            state,
            "fs-watch-started",
            format!("Started watching {}.", watch_path),
            Some(json!({
                "watchPath": watch_path,
                "projectPath": project_path,
                "recursive": recursive,
            })),
        );
    })
}

pub fn unregister_fs_watch(watch_path: &str) -> Result<(), String> {
    mutate_state(|state| {
        let watch_path = display_path(watch_path);
        state.watchers.retain(|item| item.watch_path != watch_path);
        push_event(
            state,
            "fs-watch-stopped",
            format!("Stopped watching {}.", watch_path),
            Some(json!({
                "watchPath": watch_path,
            })),
        );
    })
}

#[allow(dead_code)]
pub fn record_fs_event(project_path: &str, path: &str, kind: &str) -> Result<(), String> {
    record_fs_event_batch(
        project_path,
        &[RuntimeFsEventRecord {
            path: path.to_string(),
            kind: kind.to_string(),
        }],
    )
}

pub fn record_fs_event_batch(
    project_path: &str,
    events: &[RuntimeFsEventRecord],
) -> Result<(), String> {
    record_fs_event_batch_for_path(runtime_state_path(), project_path, events)
}

pub fn record_runtime_event(
    kind: &str,
    summary: impl Into<String>,
    payload_preview: Option<Value>,
) -> Result<(), String> {
    let summary = summary.into();
    mutate_state(|state| {
        push_event(state, kind, summary, payload_preview);
    })
}

#[cfg(test)]
pub fn write_runtime_state_for_tests(state: RuntimeMcpState) {
    runtime_store().replace_for_tests(state).unwrap();
}

#[cfg(test)]
fn flush_runtime_state_for_tests() {
    runtime_store().flush_now().unwrap();
}

#[cfg(test)]
fn runtime_write_count_for_tests() -> usize {
    runtime_store().write_count.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::tools::test_support::TestHarness;

    #[cfg(windows)]
    #[test]
    fn display_path_normalizes_windows_separators() {
        assert_eq!(
            display_path(r"\\?\C:/code/mini-term/test.txt"),
            r"C:\code\mini-term\test.txt"
        );
        assert_eq!(
            display_path(r"\\?\UNC\server/share/repo/file.txt"),
            r"\\server\share\repo\file.txt"
        );
    }

    #[cfg(windows)]
    #[test]
    fn register_pty_normalizes_windows_paths() {
        let _harness = TestHarness::new("runtime-register-pty-paths");
        initialize_runtime_host("test-version").expect("host init should succeed");
        register_pty(
            7,
            "session-7",
            "powershell",
            "powershell",
            r"\\?\C:/code/mini-term",
            "human",
            "starting",
        )
        .expect("register pty should succeed");

        let state = load_runtime_state();
        let pty = state
            .ptys
            .into_iter()
            .find(|item| item.pty_id == 7)
            .expect("pty should exist");
        assert_eq!(pty.cwd, r"C:\code\mini-term");
        assert_eq!(pty.root_path, r"C:\code\mini-term");
    }

    #[cfg(windows)]
    #[test]
    fn update_pty_cwd_normalizes_windows_paths() {
        let _harness = TestHarness::new("runtime-update-pty-cwd");
        initialize_runtime_host("test-version").expect("host init should succeed");
        register_pty(
            8,
            "session-8",
            "powershell",
            "powershell",
            r"C:\code\mini-term",
            "human",
            "starting",
        )
        .expect("register pty should succeed");

        update_pty_cwd(8, r"\\?\C:/code/mini-term/src").expect("update cwd should succeed");

        let state = load_runtime_state();
        let pty = state
            .ptys
            .into_iter()
            .find(|item| item.pty_id == 8)
            .expect("pty should exist");
        assert_eq!(pty.cwd, r"C:\code\mini-term\src");
        assert_eq!(pty.root_path, r"C:\code\mini-term");
    }

    #[test]
    fn runtime_state_tracks_pty_and_fs_lifecycle() {
        let harness = TestHarness::new("runtime-lifecycle");
        initialize_runtime_host("test-version").expect("host init should succeed");

        register_pty(
            11,
            "session-11",
            "powershell",
            "powershell",
            &harness.workspace_path(),
            "human",
            "starting",
        )
        .expect("register pty should succeed");
        update_pty_phase(11, "running").expect("phase update should succeed");
        update_pty_status(11, "ai-working").expect("status update should succeed");
        append_pty_output(11, "hello runtime").expect("output append should succeed");
        mark_pty_exited(11, 0).expect("exit mark should succeed");
        register_fs_watch(&harness.workspace_path(), &harness.workspace_path(), true)
            .expect("watch register should succeed");
        record_fs_event(
            &harness.workspace_path(),
            &harness.workspace_path(),
            "modify",
        )
        .expect("fs event should succeed");
        unregister_fs_watch(&harness.workspace_path()).expect("watch unregister should succeed");
        remove_pty(11).expect("pty removal should succeed");

        let state = load_runtime_state();
        assert_eq!(
            state.host.as_ref().map(|host| host.app_version.as_str()),
            Some("test-version")
        );
        assert!(state.ptys.is_empty());
        assert!(state.watchers.is_empty());

        let kinds = state
            .recent_events
            .iter()
            .map(|event| event.kind.as_str())
            .collect::<Vec<_>>();
        assert!(kinds.contains(&"host-started"));
        assert!(kinds.contains(&"pty-session-created"));
        assert!(kinds.contains(&"pty-status-change"));
        assert!(kinds.contains(&"pty-output"));
        assert!(kinds.contains(&"pty-exit"));
        assert!(kinds.contains(&"pty-session-removed"));
        assert!(kinds.contains(&"fs-watch-started"));
        assert!(kinds.contains(&"fs-change"));
        assert!(kinds.contains(&"fs-watch-stopped"));
    }

    #[test]
    fn runtime_updates_flush_lazily() {
        let harness = TestHarness::new("runtime-lazy-flush");
        initialize_runtime_host("test-version").expect("host init should succeed");
        flush_runtime_state_for_tests();
        let baseline_writes = runtime_write_count_for_tests();

        register_pty(
            31,
            "session-31",
            "powershell",
            "powershell",
            &harness.workspace_path(),
            "human",
            "starting",
        )
        .expect("register pty should succeed");
        for chunk in ["hello", " ", "runtime", " ", "buffer"] {
            append_pty_output(31, chunk).expect("output append should succeed");
        }
        update_pty_status(31, "running").expect("status update should succeed");

        assert_eq!(runtime_write_count_for_tests(), baseline_writes);
        let state = load_runtime_state();
        let pty = state
            .ptys
            .iter()
            .find(|item| item.pty_id == 31)
            .expect("pty should be present in memory");
        assert_eq!(pty.output_tail, "hello runtime buffer");

        flush_runtime_state_for_tests();
        assert!(runtime_write_count_for_tests() > baseline_writes);

        let persisted = load_state_from_path(&runtime_state_path());
        let persisted_pty = persisted
            .ptys
            .into_iter()
            .find(|item| item.pty_id == 31)
            .expect("pty should be persisted");
        assert_eq!(persisted_pty.output_tail, "hello runtime buffer");
    }

    #[test]
    fn record_fs_event_batch_summarizes_multiple_paths() {
        let harness = TestHarness::new("runtime-fs-batch");
        initialize_runtime_host("test-version").expect("host init should succeed");

        record_fs_event_batch(
            &harness.workspace_path(),
            &[
                RuntimeFsEventRecord {
                    path: format!("{}\\src\\main.rs", harness.workspace_path()),
                    kind: "Modify(File(Data(Any)))".to_string(),
                },
                RuntimeFsEventRecord {
                    path: format!("{}\\src\\lib.rs", harness.workspace_path()),
                    kind: "Modify(File(Data(Any)))".to_string(),
                },
            ],
        )
        .expect("batch should succeed");

        let state = load_runtime_state();
        let event = state
            .recent_events
            .iter()
            .rev()
            .find(|event| event.kind == "fs-change")
            .expect("fs batch event should exist");
        assert!(event.summary.contains("2 paths"));
        let payload = event
            .payload_preview
            .as_ref()
            .expect("payload preview should exist");
        assert_eq!(payload.get("count").and_then(Value::as_u64), Some(2));
    }

    #[test]
    fn append_pty_output_keeps_recent_preview_tail() {
        let harness = TestHarness::new("runtime-output-preview-tail");
        initialize_runtime_host("test-version").expect("host init should succeed");
        register_pty(
            21,
            "session-21",
            "powershell",
            "powershell",
            &harness.workspace_path(),
            "human",
            "starting",
        )
        .expect("register pty should succeed");

        append_pty_output(21, &"a".repeat(400)).expect("first output append should succeed");
        append_pty_output(21, &"b".repeat(50)).expect("second output append should succeed");

        let state = load_runtime_state();
        let pty = state
            .ptys
            .into_iter()
            .find(|item| item.pty_id == 21)
            .expect("pty should exist");
        assert_eq!(pty.output_preview.len(), MAX_OUTPUT_PREVIEW_CHARS);
        assert!(pty.output_preview.starts_with("..."));
        assert!(pty.output_preview.ends_with(&"b".repeat(50)));
        assert!(pty.output_preview[3..350].chars().all(|ch| ch == 'a'));
    }

    // ── strip_ansi ────────────────────────────────────────────────────────────

    #[test]
    fn strip_ansi_removes_csi_sequences() {
        assert_eq!(strip_ansi("\x1b[?25l\x1b[2J\x1b[H"), "");
        assert_eq!(strip_ansi("\x1b[32mhello\x1b[0m"), "hello");
        assert_eq!(strip_ansi("\x1b[1;34Htext"), "text");
    }

    #[test]
    fn strip_ansi_removes_osc_sequences() {
        // OSC terminated by BEL
        assert_eq!(strip_ansi("\x1b]0;window title\x07PS> "), "PS> ");
        // OSC terminated by ST (ESC \)
        assert_eq!(strip_ansi("\x1b]2;title\x1b\\PS> "), "PS> ");
    }

    #[test]
    fn strip_ansi_normalizes_crlf() {
        assert_eq!(strip_ansi("line1\r\nline2\r\n"), "line1\nline2\n");
    }

    #[test]
    fn strip_ansi_discards_bare_cr() {
        // Bare \r is discarded; both sides of the carriage return are kept
        // (we strip escape sequences, not emulate terminal cursor semantics).
        assert_eq!(strip_ansi("over\rwrite"), "overwrite");
        // \r\n is normalised to \n.
        assert_eq!(strip_ansi("line\r\nnext"), "line\nnext");
    }

    #[test]
    fn strip_ansi_strips_control_chars() {
        // BEL, BS, etc. are stripped; \n and spaces are kept.
        assert_eq!(strip_ansi("a\x07b\x08c"), "abc");
        assert_eq!(strip_ansi("a\x00b"), "ab");
    }

    #[test]
    fn strip_ansi_preserves_plain_text_and_newlines() {
        let input = "PS D:\\code\\mini-term> cargo test\nrunning 5 tests\n";
        assert_eq!(strip_ansi(input), input);
    }

    #[test]
    fn strip_ansi_handles_realistic_powershell_prompt() {
        let raw = "\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m\x1b[HPS D:\\code\\mini-term>\x1b[1C\x1b]0;C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.EXE\x07\x1b[?25h";
        let clean = strip_ansi(raw);
        assert_eq!(clean.trim(), "PS D:\\code\\mini-term>");
    }

    #[test]
    fn append_pty_output_strips_ansi_from_preview() {
        let harness = TestHarness::new("runtime-output-ansi-strip");
        initialize_runtime_host("test-version").expect("host init should succeed");
        register_pty(
            30,
            "session-30",
            "powershell",
            "powershell",
            &harness.workspace_path(),
            "human",
            "starting",
        )
        .expect("register pty should succeed");

        let raw = "\x1b[?25l\x1b[2J\x1b[mPS D:\\code> \x1b[?25h";
        append_pty_output(30, raw).expect("output append should succeed");

        let state = load_runtime_state();
        let pty = state.ptys.into_iter().find(|p| p.pty_id == 30).unwrap();
        assert!(
            !pty.output_preview.contains('\x1b'),
            "ANSI ESC must not appear in preview"
        );
        assert!(pty.output_preview.contains("PS D:\\code>"));
    }

    #[test]
    fn append_pty_output_advances_phase_from_starting_to_running() {
        let harness = TestHarness::new("runtime-output-phase-advance");
        initialize_runtime_host("test-version").expect("host init should succeed");
        register_pty(
            31,
            "session-31",
            "powershell",
            "powershell",
            &harness.workspace_path(),
            "human",
            "starting",
        )
        .expect("register pty should succeed");

        let state = load_runtime_state();
        assert_eq!(
            state.ptys.iter().find(|p| p.pty_id == 31).unwrap().phase,
            "starting"
        );

        append_pty_output(31, "hello").expect("output append should succeed");

        let state = load_runtime_state();
        assert_eq!(
            state.ptys.iter().find(|p| p.pty_id == 31).unwrap().phase,
            "running"
        );
    }

    #[test]
    fn prune_stale_ptys_removes_old_exited_entries() {
        let harness = TestHarness::new("runtime-prune-exited");
        initialize_runtime_host("test-version").expect("host init should succeed");
        register_pty(
            40,
            "session-40",
            "powershell",
            "powershell",
            &harness.workspace_path(),
            "human",
            "starting",
        )
        .expect("register pty should succeed");
        mark_pty_exited(40, 0).expect("exit mark should succeed");

        // Manually backdate the exited PTY so it looks stale.
        let stale_ts = now_timestamp_ms().saturating_sub(6 * 60 * 1_000);
        {
            let store = runtime_store();
            let mut state = store.snapshot();
            for pty in &mut state.ptys {
                if pty.pty_id == 40 {
                    pty.updated_at = stale_ts;
                }
            }
            store.replace_for_tests(state).unwrap();
        }

        // Trigger any mutation so prune_stale_ptys runs.
        register_pty(
            41,
            "session-41",
            "powershell",
            "powershell",
            &harness.workspace_path(),
            "human",
            "starting",
        )
        .expect("register pty should succeed");

        let state = load_runtime_state();
        assert!(
            state.ptys.iter().all(|p| p.pty_id != 40),
            "exited PTY older than retention window should be pruned"
        );
        assert!(
            state.ptys.iter().any(|p| p.pty_id == 41),
            "recently active PTY should remain"
        );
    }
}
