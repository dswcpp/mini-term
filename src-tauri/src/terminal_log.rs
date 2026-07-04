use crate::config::{read_config, AppConfig};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const MIN_MAX_SIZE_MB: u64 = 1;
const MAX_MAX_SIZE_MB: u64 = 10 * 1024;
const CONFIG_REFRESH_INTERVAL: Duration = Duration::from_secs(1);
const LOG_QUEUE_CAPACITY: usize = 1024;

static LOG_SENDER: OnceLock<SyncSender<TerminalLogEvent>> = OnceLock::new();

struct TerminalLogEvent {
    pty_id: u32,
    data: String,
}

#[derive(Clone)]
struct TerminalLogConfig {
    enabled: bool,
    path: PathBuf,
    max_bytes: u64,
}

pub fn append_pty_output(app: &AppHandle, pty_id: u32, data: &str) {
    if data.is_empty() {
        return;
    }
    let sender = LOG_SENDER.get_or_init(|| start_log_worker(app.clone()));
    let event = TerminalLogEvent {
        pty_id,
        data: data.to_string(),
    };
    match sender.try_send(event) {
        Ok(()) => {}
        Err(TrySendError::Full(_)) => {
            eprintln!("[terminal-log] log queue full, dropping terminal output chunk");
        }
        Err(TrySendError::Disconnected(_)) => {
            eprintln!("[terminal-log] log worker disconnected");
        }
    }
}

fn start_log_worker(app: AppHandle) -> SyncSender<TerminalLogEvent> {
    let (tx, rx) = mpsc::sync_channel::<TerminalLogEvent>(LOG_QUEUE_CAPACITY);
    thread::spawn(move || {
        let mut cached_config = resolve_log_config(&app, &read_config(&app));
        let mut last_config_refresh = Instant::now();

        while let Ok(event) = rx.recv() {
            if last_config_refresh.elapsed() >= CONFIG_REFRESH_INTERVAL {
                cached_config = resolve_log_config(&app, &read_config(&app));
                last_config_refresh = Instant::now();
            }
            if !cached_config.enabled {
                continue;
            }
            if let Err(error) = append_event(&cached_config, &event) {
                eprintln!("[terminal-log] append failed: {error}");
            }
        }
    });
    tx
}

fn resolve_log_config(app: &AppHandle, config: &AppConfig) -> TerminalLogConfig {
    TerminalLogConfig {
        enabled: config.terminal_log_enabled,
        path: resolve_log_path(app, config.terminal_log_path.as_deref()),
        max_bytes: max_size_bytes(config.terminal_log_max_size_mb),
    }
}

fn resolve_log_path(app: &AppHandle, configured: Option<&str>) -> PathBuf {
    let trimmed = configured.map(str::trim).filter(|s| !s.is_empty());
    if let Some(path) = trimmed {
        return PathBuf::from(path);
    }
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("terminal.log")
}

fn max_size_bytes(max_size_mb: u64) -> u64 {
    max_size_mb
        .clamp(MIN_MAX_SIZE_MB, MAX_MAX_SIZE_MB)
        .saturating_mul(1024 * 1024)
}

fn append_event(config: &TerminalLogConfig, event: &TerminalLogEvent) -> std::io::Result<()> {
    if let Some(parent) = config.path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    let chunk = format_log_chunk(event.pty_id, &event.data);
    rotate_if_needed(&config.path, config.max_bytes, chunk.len() as u64)?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&config.path)?;
    file.write_all(chunk.as_bytes())
}

fn rotate_if_needed(path: &Path, max_bytes: u64, incoming_bytes: u64) -> std::io::Result<()> {
    if max_bytes == 0 || !path.exists() {
        return Ok(());
    }
    let current_len = fs::metadata(path)?.len();
    if current_len == 0 || current_len.saturating_add(incoming_bytes) <= max_bytes {
        return Ok(());
    }
    let rotated = rotated_log_path(path, unix_millis());
    if let Some(parent) = rotated.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    fs::rename(path, rotated)
}

fn rotated_log_path(path: &Path, timestamp_ms: u128) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new(""));
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("terminal");
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("log");
    parent.join(format!("{stem}-{timestamp_ms}.{ext}"))
}

fn format_log_chunk(pty_id: u32, data: &str) -> String {
    format!(
        "\n[mini-term ts={} pty={}]\n{}",
        unix_millis(),
        pty_id,
        data
    )
}

fn unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_size_bytes_clamps_to_supported_range() {
        assert_eq!(max_size_bytes(0), 1024 * 1024);
        assert_eq!(max_size_bytes(10), 10 * 1024 * 1024);
        assert_eq!(max_size_bytes(20_000), 10 * 1024 * 1024 * 1024);
    }

    #[test]
    fn rotated_path_preserves_extension() {
        let path = PathBuf::from("C:/logs/terminal.log");
        let rotated = rotated_log_path(&path, 123);
        assert!(rotated.ends_with("terminal-123.log"));
    }

    #[test]
    fn formatted_chunk_contains_pty_id_and_data() {
        let chunk = format_log_chunk(42, "hello");
        assert!(chunk.contains("pty=42"));
        assert!(chunk.ends_with("hello"));
    }
}
