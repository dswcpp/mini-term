use crate::{pty, runtime_mcp};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::fs::{File, OpenOptions};
use std::io::ErrorKind;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::process::Command;
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

#[cfg(unix)]
use crate::agent_core::data_dir::app_data_dir;

#[cfg(unix)]
use std::fs;

#[cfg(unix)]
use std::os::unix::net::{UnixListener, UnixStream};

#[cfg(unix)]
use std::path::PathBuf;


#[cfg(windows)]
use std::os::windows::io::FromRawHandle;

#[cfg(windows)]
use windows::core::PCWSTR;

#[cfg(windows)]
use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_PIPE_CONNECTED, INVALID_HANDLE_VALUE};

#[cfg(windows)]
use windows::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;

#[cfg(windows)]
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES,
    PIPE_WAIT,
};

const CONTROL_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const CONTROL_STALE_AFTER_MS: u64 = 5_000;
const HOST_CONTROL_EVENT: &str = "host-control-request";
const CONTROL_FRAME_LIMIT_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostControlEnvelope {
    action: String,
    payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostUiRequest {
    request_id: String,
    action: String,
    payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostControlReply {
    ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostCreatePtyInput {
    shell: String,
    #[serde(default)]
    args: Vec<String>,
    cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cols: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    rows: Option<u16>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostWritePtyInput {
    pty_id: u32,
    data: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostResizePtyInput {
    pty_id: u32,
    cols: u16,
    rows: u16,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostPtyIdInput {
    pty_id: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OsProcessInfo {
    #[serde(alias = "ProcessId")]
    process_id: u32,
    #[serde(alias = "ParentProcessId")]
    parent_process_id: u32,
    #[serde(default, alias = "Name")]
    name: String,
    #[serde(default, alias = "ExecutablePath")]
    executable_path: Option<String>,
    #[serde(default, alias = "CommandLine")]
    command_line: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessTreeNode {
    pid: u32,
    parent_pid: Option<u32>,
    name: String,
    exe: Option<String>,
    command_line: Option<String>,
    alive: bool,
    children: Vec<ProcessTreeNode>,
}

type HostControlResultSender = SyncSender<Result<Value, String>>;
type PendingHostUiRequests = Mutex<HashMap<String, HostControlResultSender>>;

fn pending_ui_requests() -> &'static PendingHostUiRequests {
    static PENDING: OnceLock<PendingHostUiRequests> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn map_host_transport_error(_: &std::io::Error) -> String {
    "host connection unavailable".to_string()
}

fn write_framed_value<W: Write>(writer: &mut W, value: &impl Serialize) -> Result<(), String> {
    let body = serde_json::to_vec(value).map_err(|_| "host control serialization failed".to_string())?;
    if body.len() > CONTROL_FRAME_LIMIT_BYTES {
        return Err("host control payload is too large".to_string());
    }
    let length = (body.len() as u32).to_le_bytes();
    writer
        .write_all(&length)
        .map_err(|error| map_host_transport_error(&error))?;
    writer
        .write_all(&body)
        .map_err(|error| map_host_transport_error(&error))?;
    writer
        .flush()
        .map_err(|error| map_host_transport_error(&error))
}

fn read_framed_value<R: Read, T: for<'de> Deserialize<'de>>(reader: &mut R) -> Result<T, String> {
    let mut length = [0u8; 4];
    reader
        .read_exact(&mut length)
        .map_err(|error| map_host_transport_error(&error))?;
    let body_len = u32::from_le_bytes(length) as usize;
    if body_len == 0 || body_len > CONTROL_FRAME_LIMIT_BYTES {
        return Err("host connection unavailable".to_string());
    }
    let mut body = vec![0u8; body_len];
    reader
        .read_exact(&mut body)
        .map_err(|error| map_host_transport_error(&error))?;
    serde_json::from_slice(&body).map_err(|_| "host connection unavailable".to_string())
}

#[cfg(windows)]
fn to_wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn accept_named_pipe_connection(endpoint: &str) -> Result<File, String> {
    let wide = to_wide_null(endpoint);
    unsafe {
        let handle = CreateNamedPipeW(
            PCWSTR(wide.as_ptr()),
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            PIPE_UNLIMITED_INSTANCES,
            CONTROL_FRAME_LIMIT_BYTES as u32,
            CONTROL_FRAME_LIMIT_BYTES as u32,
            0,
            None,
        );
        if handle == INVALID_HANDLE_VALUE {
            return Err("failed to start host control pipe".to_string());
        }

        if ConnectNamedPipe(handle, None).is_err() {
            let error = GetLastError();
            if error != ERROR_PIPE_CONNECTED {
                let _ = CloseHandle(handle);
                return Err("failed to accept host control connection".to_string());
            }
        }

        Ok(File::from_raw_handle(handle.0 as *mut _))
    }
}

#[cfg(windows)]
fn connect_named_pipe(endpoint: &str) -> Result<File, String> {
    for _ in 0..40 {
        match OpenOptions::new().read(true).write(true).open(endpoint) {
            Ok(file) => return Ok(file),
            Err(error)
                if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::PermissionDenied)
                    || matches!(error.raw_os_error(), Some(231 | 233)) =>
            {
                thread::sleep(Duration::from_millis(25));
            }
            Err(error) => return Err(map_host_transport_error(&error)),
        }
    }

    Err("host connection unavailable".to_string())
}

#[cfg(windows)]
fn host_control_transport() -> &'static str {
    "named-pipe"
}

#[cfg(windows)]
fn build_host_control_endpoint() -> String {
    format!(r"\\.\pipe\mini-term-host-control-{}", Uuid::now_v7())
}

#[cfg(unix)]
fn host_control_transport() -> &'static str {
    "unix-socket"
}

#[cfg(unix)]
fn build_host_control_endpoint() -> String {
    app_data_dir()
        .join(format!("host-control-{}.sock", Uuid::now_v7()))
        .to_string_lossy()
        .to_string()
}

fn find_header_end(buffer: &[u8]) -> Option<(usize, usize)> {
    if let Some(index) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
        return Some((index, 4));
    }
    buffer
        .windows(2)
        .position(|window| window == b"\n\n")
        .map(|index| (index, 2))
}

fn find_line_end(buffer: &[u8]) -> Option<(usize, usize)> {
    if let Some(index) = buffer.windows(2).position(|window| window == b"\r\n") {
        return Some((index, 2));
    }
    buffer
        .iter()
        .position(|byte| *byte == b'\n')
        .map(|index| (index, 1))
}

fn leading_empty_line_len(buffer: &[u8]) -> Option<usize> {
    if buffer.starts_with(b"\r\n") {
        Some(2)
    } else if buffer.starts_with(b"\n") {
        Some(1)
    } else {
        None
    }
}

fn decode_chunked_body_from_slice(buffer: &[u8]) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    let mut position = 0usize;

    loop {
        let (line_end, sep_len) =
            find_line_end(&buffer[position..]).ok_or("incomplete chunked HTTP body".to_string())?;
        let line_end = position + line_end;
        let size_line =
            std::str::from_utf8(&buffer[position..line_end]).map_err(|err| err.to_string())?;
        let chunk_size =
            usize::from_str_radix(size_line.split(';').next().unwrap_or("").trim(), 16)
                .map_err(|_| "invalid chunk size".to_string())?;
        position = line_end + sep_len;

        if chunk_size == 0 {
            if leading_empty_line_len(&buffer[position..]).is_some() {
                return Ok(body);
            }
            if find_header_end(&buffer[position..]).is_some() {
                return Ok(body);
            }
            return Err("incomplete chunked HTTP body".to_string());
        }

        if buffer.len() < position + chunk_size {
            return Err("incomplete chunked HTTP body".to_string());
        }
        body.extend_from_slice(&buffer[position..position + chunk_size]);
        position += chunk_size;

        if buffer.get(position..position + 2) == Some(b"\r\n") {
            position += 2;
        } else if buffer.get(position) == Some(&b'\n') {
            position += 1;
        } else {
            return Err("invalid chunk terminator".to_string());
        }
    }
}

fn parse_http_status(header_text: &str) -> Result<u16, String> {
    let status_line = header_text
        .lines()
        .next()
        .ok_or("missing HTTP status line")?;
    let status_code = status_line
        .split_whitespace()
        .nth(1)
        .ok_or("missing HTTP status code")?;
    status_code
        .parse::<u16>()
        .map_err(|_| "invalid HTTP status code".to_string())
}

fn parse_http_response(buffer: &[u8]) -> Result<(u16, Value), String> {
    let (header_end, separator_len) =
        find_header_end(buffer).ok_or("incomplete HTTP response".to_string())?;
    let header_text =
        String::from_utf8(buffer[..header_end].to_vec()).map_err(|err| err.to_string())?;
    let status = parse_http_status(&header_text)?;
    let mut headers = BTreeMap::new();
    for line in header_text.lines().skip(1) {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    let body_bytes = &buffer[header_end + separator_len..];
    let body = if headers
        .get("transfer-encoding")
        .map(|value| value.to_ascii_lowercase().contains("chunked"))
        .unwrap_or(false)
    {
        decode_chunked_body_from_slice(body_bytes)?
    } else if let Some(content_length) = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
    {
        if body_bytes.len() < content_length {
            return Err("incomplete HTTP response body".to_string());
        }
        body_bytes[..content_length].to_vec()
    } else {
        body_bytes.to_vec()
    };
    let value = serde_json::from_slice(&body).map_err(|err| err.to_string())?;
    Ok((status, value))
}

fn read_http_response(stream: &mut TcpStream) -> Result<(u16, Value), String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|err| err.to_string())?;

    let mut buffer = Vec::new();
    let mut temp = [0u8; 4096];
    loop {
        let read = stream.read(&mut temp).map_err(|err| err.to_string())?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&temp[..read]);
    }
    parse_http_response(&buffer)
}

fn build_process_tree_node(
    current_pid: u32,
    current_parent: Option<u32>,
    process_map: &HashMap<u32, OsProcessInfo>,
    child_map: &HashMap<u32, Vec<u32>>,
) -> Result<ProcessTreeNode, String> {
    let process = process_map
        .get(&current_pid)
        .ok_or_else(|| format!("process not found in snapshot: {current_pid}"))?;

    let mut children = child_map
        .get(&current_pid)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|child_pid| {
            build_process_tree_node(child_pid, Some(current_pid), process_map, child_map)
        })
        .collect::<Result<Vec<_>, _>>()?;
    children.sort_by_key(|child| child.pid);

    Ok(ProcessTreeNode {
        pid: current_pid,
        parent_pid: current_parent,
        name: process.name.clone(),
        exe: process.executable_path.clone(),
        command_line: process.command_line.clone(),
        alive: true,
        children,
    })
}

#[cfg(windows)]
fn load_windows_processes() -> Result<HashMap<u32, OsProcessInfo>, String> {
    let output = Command::new("powershell")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress",
        ])
        .output()
        .map_err(|err| err.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        return Ok(HashMap::new());
    }

    let parsed = serde_json::from_str::<Value>(&stdout).map_err(|err| err.to_string())?;
    let items = match parsed {
        Value::Array(items) => items,
        single => vec![single],
    };

    let mut process_map = HashMap::new();
    for item in items {
        let process: OsProcessInfo = serde_json::from_value(item).map_err(|err| err.to_string())?;
        process_map.insert(process.process_id, process);
    }
    Ok(process_map)
}

#[cfg(not(windows))]
fn load_windows_processes() -> Result<HashMap<u32, OsProcessInfo>, String> {
    Err("get_process_tree is currently implemented on Windows only".to_string())
}

fn process_tree_for_root(root_pid: u32) -> Result<Value, String> {
    let process_map = load_windows_processes()?;
    if !process_map.contains_key(&root_pid) {
        return Err("PTY root process is unavailable".to_string());
    }

    let mut child_map: HashMap<u32, Vec<u32>> = HashMap::new();
    for process in process_map.values() {
        child_map
            .entry(process.parent_process_id)
            .or_default()
            .push(process.process_id);
    }

    let tree = build_process_tree_node(root_pid, None, &process_map, &child_map)?;
    serde_json::to_value(tree).map_err(|err| err.to_string())
}

fn wrap_process_tree(root: Value) -> Value {
    json!({ "root": root })
}

fn dispatch_ui_request(app: &AppHandle, action: &str, payload: Value) -> Result<Value, String> {
    let request_id = Uuid::now_v7().to_string();
    let (tx, rx) = mpsc::sync_channel(1);
    pending_ui_requests()
        .lock()
        .unwrap()
        .insert(request_id.clone(), tx);

    let request = HostUiRequest {
        request_id: request_id.clone(),
        action: action.to_string(),
        payload,
    };
    app.emit(HOST_CONTROL_EVENT, request)
        .map_err(|err| err.to_string())?;

    match rx.recv_timeout(CONTROL_REQUEST_TIMEOUT) {
        Ok(result) => result,
        Err(_) => {
            pending_ui_requests().lock().unwrap().remove(&request_id);
            Err("host UI bridge timed out".to_string())
        }
    }
}

fn direct_host_action(
    app: &AppHandle,
    action: &str,
    payload: Value,
) -> Result<Option<Value>, String> {
    match action {
        "create_pty" => {
            let input: HostCreatePtyInput =
                serde_json::from_value(payload).map_err(|_| "payload is invalid".to_string())?;
            let state = app.state::<crate::pty::PtyManager>();
            let created = pty::create_terminal_session_for_host(
                app,
                state.inner(),
                pty::CreatePtyRequest {
                    shell: input.shell,
                    args: input.args,
                    cwd: input.cwd,
                    session_id: None,
                    mode: input.mode,
                    cols: input.cols,
                    rows: input.rows,
                },
            )?;
            Ok(Some(
                serde_json::to_value(created).map_err(|err| err.to_string())?,
            ))
        }
        "write_pty" => {
            let input: HostWritePtyInput =
                serde_json::from_value(payload).map_err(|_| "payload is invalid".to_string())?;
            let state = app.state::<crate::pty::PtyManager>();
            pty::write_pty_for_host(app, state.inner(), input.pty_id, input.data)?;
            Ok(Some(json!({ "ptyId": input.pty_id })))
        }
        "resize_pty" => {
            let input: HostResizePtyInput =
                serde_json::from_value(payload).map_err(|_| "payload is invalid".to_string())?;
            let state = app.state::<crate::pty::PtyManager>();
            pty::resize_pty_for_host(state.inner(), input.pty_id, input.cols, input.rows)?;
            Ok(Some(json!({
                "ptyId": input.pty_id,
                "cols": input.cols,
                "rows": input.rows,
            })))
        }
        "kill_pty" => {
            let input: HostPtyIdInput =
                serde_json::from_value(payload).map_err(|_| "payload is invalid".to_string())?;
            let state = app.state::<crate::pty::PtyManager>();
            pty::kill_pty_for_host(state.inner(), input.pty_id)?;
            Ok(Some(json!({ "ptyId": input.pty_id, "killed": true })))
        }
        "get_pty_detail" => {
            let input: HostPtyIdInput =
                serde_json::from_value(payload).map_err(|_| "payload is invalid".to_string())?;
            let pty = runtime_mcp::load_runtime_state()
                .ptys
                .into_iter()
                .find(|item| item.pty_id == input.pty_id)
                .ok_or_else(|| "PTY not found".to_string())?;
            Ok(Some(
                serde_json::to_value(pty).map_err(|err| err.to_string())?,
            ))
        }
        "get_process_tree" => {
            let input: HostPtyIdInput =
                serde_json::from_value(payload).map_err(|_| "payload is invalid".to_string())?;
            let pty = runtime_mcp::load_runtime_state()
                .ptys
                .into_iter()
                .find(|item| item.pty_id == input.pty_id)
                .ok_or_else(|| "PTY not found".to_string())?;
            let root_pid = pty
                .root_pid
                .ok_or_else(|| "PTY root process is unavailable".to_string())?;
            Ok(Some(wrap_process_tree(process_tree_for_root(root_pid)?)))
        }
        _ => Ok(None),
    }
}

fn execute_host_action(app: &AppHandle, action: &str, payload: Value) -> Result<Value, String> {
    if let Some(result) = direct_host_action(app, action, payload.clone())? {
        return Ok(result);
    }

    match action {
        "focus_workspace" | "create_tab" | "close_tab" | "split_pane" | "notify_user" => {
            dispatch_ui_request(app, action, payload)
        }
        _ => Err(format!("unsupported host control action: {action}")),
    }
}

fn build_host_control_reply(app: &AppHandle, envelope: HostControlEnvelope) -> HostControlReply {
    match execute_host_action(app, &envelope.action, envelope.payload) {
        Ok(data) => HostControlReply {
            ok: true,
            data: Some(data),
            error: None,
        },
        Err(error) => HostControlReply {
            ok: false,
            data: None,
            error: Some(error),
        },
    }
}

fn handle_local_connection<S: Read + Write>(app: AppHandle, mut stream: S) -> Result<(), String> {
    let envelope: HostControlEnvelope = read_framed_value(&mut stream)?;
    let reply = build_host_control_reply(&app, envelope);
    write_framed_value(&mut stream, &reply)
}

pub fn start_host_control_server(app: AppHandle) -> Result<(), String> {
    let endpoint = build_host_control_endpoint();
    runtime_mcp::set_host_control_info(
        host_control_transport().to_string(),
        endpoint.clone(),
        None,
        vec![
            "pty-control".to_string(),
            "runtime-observation-detail".to_string(),
            "ui-control".to_string(),
        ],
    )?;

    #[cfg(windows)]
    thread::spawn(move || {
        loop {
            match accept_named_pipe_connection(&endpoint) {
                Ok(stream) => {
                    let app = app.clone();
                    thread::spawn(move || {
                        if let Err(error) = handle_local_connection(app, stream) {
                            eprintln!("{error}");
                        }
                    });
                }
                Err(error) => {
                    eprintln!("{error}");
                    thread::sleep(Duration::from_millis(50));
                }
            }
        }
    });

    #[cfg(unix)]
    {
        let socket_path = PathBuf::from(&endpoint);
        if socket_path.exists() {
            let _ = fs::remove_file(&socket_path);
        }
        let listener = UnixListener::bind(&socket_path).map_err(|_| "failed to bind host control socket".to_string())?;
        thread::spawn(move || {
            for stream in listener.incoming() {
                match stream {
                    Ok(stream) => {
                        let app = app.clone();
                        thread::spawn(move || {
                            if let Err(error) = handle_local_connection(app, stream) {
                                eprintln!("{error}");
                            }
                        });
                    }
                    Err(error) => eprintln!("{error}"),
                }
            }
        });
    }

    Ok(())
}

fn host_control_state() -> Result<runtime_mcp::RuntimeHostControlInfo, String> {
    let state = runtime_mcp::load_runtime_state();
    let host = state
        .host
        .ok_or_else(|| "host connection unavailable".to_string())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    if now.saturating_sub(host.last_heartbeat_at) > CONTROL_STALE_AFTER_MS {
        return Err("host connection unavailable".to_string());
    }
    host.host_control
        .ok_or_else(|| "host connection unavailable".to_string())
}

fn split_base_url(base_url: &str) -> Result<(String, String), String> {
    let trimmed = base_url
        .strip_prefix("http://")
        .ok_or_else(|| "host control base URL must use http".to_string())?;
    let (authority, path) = trimmed
        .split_once('/')
        .ok_or_else(|| "host control base URL is invalid".to_string())?;
    Ok((authority.to_string(), format!("/{}", path)))
}

pub fn call_host_control(action: &str, payload: Value) -> Result<Value, String> {
    let control = host_control_state()?;
    let reply = match control.transport.as_str() {
        #[cfg(windows)]
        "named-pipe" => {
            let mut stream = connect_named_pipe(&control.endpoint)?;
            write_framed_value(
                &mut stream,
                &HostControlEnvelope {
                    action: action.to_string(),
                    payload,
                },
            )?;
            read_framed_value::<_, HostControlReply>(&mut stream)?
        }
        #[cfg(unix)]
        "unix-socket" => {
            let mut stream =
                UnixStream::connect(&control.endpoint).map_err(|_| "host connection unavailable".to_string())?;
            write_framed_value(
                &mut stream,
                &HostControlEnvelope {
                    action: action.to_string(),
                    payload,
                },
            )?;
            read_framed_value::<_, HostControlReply>(&mut stream)?
        }
        "http" => {
            let (authority, path) = split_base_url(&control.endpoint)?;
            let mut stream =
                TcpStream::connect(&authority).map_err(|_| "host connection unavailable".to_string())?;
            stream
                .set_write_timeout(Some(Duration::from_secs(5)))
                .map_err(|_| "host connection unavailable".to_string())?;

            let body = serde_json::to_vec(&HostControlEnvelope {
                action: action.to_string(),
                payload,
            })
            .map_err(|_| "host control serialization failed".to_string())?;
            let token = control
                .token
                .as_deref()
                .ok_or_else(|| "host connection unavailable".to_string())?;

            write!(
                stream,
                "POST {path} HTTP/1.1\r\nHost: {authority}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .map_err(|_| "host connection unavailable".to_string())?;
            stream
                .write_all(&body)
                .map_err(|_| "host connection unavailable".to_string())?;
            stream
                .flush()
                .map_err(|_| "host connection unavailable".to_string())?;

            let (status, value) = read_http_response(&mut stream)?;
            if status != 200 {
                return Err("host connection unavailable".to_string());
            }
            serde_json::from_value(value).map_err(|_| "host connection unavailable".to_string())?
        }
        _ => return Err("host connection unavailable".to_string()),
    };
    if reply.ok {
        Ok(reply.data.unwrap_or_else(|| json!({})))
    } else {
        Err(reply
            .error
            .unwrap_or_else(|| "host control request failed".to_string()))
    }
}

#[tauri::command]
pub fn resolve_host_control_request(
    request_id: String,
    success: bool,
    data: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    let sender = pending_ui_requests()
        .lock()
        .unwrap()
        .remove(&request_id)
        .ok_or_else(|| "host control request not found".to_string())?;
    let result = if success {
        Ok(data.unwrap_or_else(|| json!({})))
    } else {
        Err(error.unwrap_or_else(|| "host UI bridge rejected the request".to_string()))
    };
    sender
        .send(result)
        .map_err(|_| "host UI bridge dropped the response".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_core::data_dir::app_data_dir;
    use crate::mcp::tools::test_support::TestHarness;
    use crate::runtime_mcp::{RuntimeHostControlInfo, RuntimeHostInfo, RuntimeMcpState};
    use serde_json::json;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    fn runtime_state_path() -> std::path::PathBuf {
        app_data_dir().join("runtime_mcp_state.json")
    }

    fn write_runtime_state(
        last_heartbeat_at: u64,
        transport: &str,
        endpoint: String,
        token: Option<&str>,
    ) {
        let state = RuntimeMcpState {
            schema_version: 1,
            updated_at: last_heartbeat_at,
            host: Some(RuntimeHostInfo {
                app_version: "0.2.3".to_string(),
                desktop_pid: 12345,
                transport_mode: "app-data-snapshot".to_string(),
                last_heartbeat_at,
                host_control: Some(RuntimeHostControlInfo {
                    transport: transport.to_string(),
                    endpoint,
                    token: token.map(str::to_string),
                    capabilities: vec!["ui-control".to_string()],
                }),
            }),
            ptys: Vec::new(),
            watchers: Vec::new(),
            recent_events: Vec::new(),
        };
        fs::create_dir_all(app_data_dir()).unwrap();
        fs::write(
            runtime_state_path(),
            serde_json::to_string_pretty(&state).unwrap(),
        )
        .unwrap();
    }

    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0)
    }

    fn start_mock_server(
        expected_token: Option<&'static str>,
        status_code: u16,
        body: Value,
    ) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buffer = Vec::new();
                let mut temp = [0u8; 4096];
                let header_end = loop {
                    let read = stream.read(&mut temp).unwrap();
                    if read == 0 {
                        return;
                    }
                    buffer.extend_from_slice(&temp[..read]);
                    if let Some(index) = buffer.windows(4).position(|window| window == b"\r\n\r\n")
                    {
                        break index;
                    }
                };
                let header_text = String::from_utf8(buffer[..header_end].to_vec()).unwrap();
                let content_length = header_text
                    .lines()
                    .find_map(|line| {
                        line.split_once(':').and_then(|(name, value)| {
                            if name.eq_ignore_ascii_case("Content-Length") {
                                value.trim().parse::<usize>().ok()
                            } else {
                                None
                            }
                        })
                    })
                    .unwrap_or(0);
                let body_start = header_end + 4;
                while buffer.len() < body_start + content_length {
                    let read = stream.read(&mut temp).unwrap();
                    if read == 0 {
                        break;
                    }
                    buffer.extend_from_slice(&temp[..read]);
                }

                let auth = header_text
                    .lines()
                    .find(|line| line.to_ascii_lowercase().starts_with("authorization:"))
                    .unwrap_or_default()
                    .to_string();
                let (status_code, body) = if let Some(token) = expected_token {
                    if auth == format!("Authorization: Bearer {token}") {
                        (status_code, body)
                    } else {
                        (401, json!({ "ok": false, "error": "unauthorized" }))
                    }
                } else {
                    (status_code, body)
                };

                let response_body = serde_json::to_vec(&body).unwrap();
                write!(
                    stream,
                    "HTTP/1.1 {} TEST\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    status_code,
                    response_body.len()
                )
                .unwrap();
                stream.write_all(&response_body).unwrap();
                stream.flush().unwrap();
            }
        });
        format!("http://127.0.0.1:{}/host-control", addr.port())
    }

    #[test]
    fn process_tree_builder_nests_children_under_root() {
        let process_map = HashMap::from([
            (
                10,
                OsProcessInfo {
                    process_id: 10,
                    parent_process_id: 1,
                    name: "root.exe".into(),
                    executable_path: Some("C:/root.exe".into()),
                    command_line: Some("root".into()),
                },
            ),
            (
                11,
                OsProcessInfo {
                    process_id: 11,
                    parent_process_id: 10,
                    name: "child.exe".into(),
                    executable_path: Some("C:/child.exe".into()),
                    command_line: Some("child".into()),
                },
            ),
        ]);
        let child_map = HashMap::from([(10, vec![11])]);
        let tree = build_process_tree_node(10, None, &process_map, &child_map).unwrap();
        assert_eq!(tree.pid, 10);
        assert_eq!(tree.children.len(), 1);
        assert_eq!(tree.children[0].pid, 11);
        assert_eq!(tree.children[0].parent_pid, Some(10));
    }

    #[test]
    fn os_process_info_accepts_powershell_pascal_case_fields() {
        let process: OsProcessInfo = serde_json::from_value(json!({
            "ProcessId": 10,
            "ParentProcessId": 1,
            "Name": "powershell.exe",
            "ExecutablePath": "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
            "CommandLine": "powershell"
        }))
        .unwrap();
        assert_eq!(process.process_id, 10);
        assert_eq!(process.parent_process_id, 1);
        assert_eq!(process.name, "powershell.exe");
        assert_eq!(
            process.executable_path.as_deref(),
            Some("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe")
        );
        assert_eq!(process.command_line.as_deref(), Some("powershell"));
    }

    #[test]
    fn wrap_process_tree_returns_root_object() {
        let wrapped = wrap_process_tree(json!({ "pid": 10, "children": [] }));
        assert_eq!(wrapped["root"]["pid"], 10);
        assert_eq!(wrapped["root"]["children"], json!([]));
    }

    #[test]
    fn split_base_url_parses_authority_and_path() {
        let (authority, path) = split_base_url("http://127.0.0.1:9999/host-control").unwrap();
        assert_eq!(authority, "127.0.0.1:9999");
        assert_eq!(path, "/host-control");
    }

    #[test]
    fn parse_http_response_supports_chunked_json_bodies() {
        let response = concat!(
            "HTTP/1.1 200 OK\r\n",
            "Content-Type: application/json\r\n",
            "Transfer-Encoding: chunked\r\n",
            "\r\n",
            "b\r\n",
            "{\"ok\":true}\r\n",
            "0\r\n",
            "\r\n"
        );
        let (status, value) = parse_http_response(response.as_bytes()).unwrap();
        assert_eq!(status, 200);
        assert_eq!(value, json!({ "ok": true }));
    }

    #[test]
    fn call_host_control_rejects_stale_runtime_snapshot() {
        let _harness = TestHarness::new("host-control-stale");
        let base_url = "http://127.0.0.1:9/host-control".to_string();
        write_runtime_state(
            now_ms().saturating_sub(CONTROL_STALE_AFTER_MS + 50),
            "http",
            base_url,
            Some("stale-token"),
        );

        let error = call_host_control("focus_workspace", json!({ "workspaceId": "workspace-1" }))
            .unwrap_err();
        assert_eq!(error, "host connection unavailable");
    }

    #[test]
    fn call_host_control_returns_unavailable_on_non_200_or_bad_token() {
        let _harness = TestHarness::new("host-control-bad-token");
        let base_url = start_mock_server(
            Some("server-expected-token"),
            401,
            json!({
                "ok": false,
                "error": "unauthorized"
            }),
        );
        write_runtime_state(now_ms(), "http", base_url, Some("client-sent-token"));

        let error = call_host_control("focus_workspace", json!({ "workspaceId": "workspace-1" }))
            .unwrap_err();
        assert_eq!(error, "host connection unavailable");
    }

    #[test]
    fn call_host_control_propagates_host_reply_errors_for_200_responses() {
        let _harness = TestHarness::new("host-control-reply-error");
        let base_url = start_mock_server(
            Some("shared-token"),
            200,
            json!({
                "ok": false,
                "error": "tab not found"
            }),
        );
        write_runtime_state(now_ms(), "http", base_url, Some("shared-token"));

        let error = call_host_control(
            "close_tab",
            json!({
                "workspaceId": "workspace-1",
                "tabId": "tab-404"
            }),
        )
        .unwrap_err();
        assert_eq!(error, "tab not found");
    }
}
