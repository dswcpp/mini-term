use crate::agent_backends::{
    sidecar_backend_config, AgentBackendCapabilities, AgentBackendDescriptor,
};
use crate::agent_tool_broker::execute_sidecar_tool_call;
use crate::config::{SidecarBackendConfig, SidecarStartupMode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::process::{Child, ChildStderr, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

pub const SIDECAR_PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SidecarHandshake {
    pub backend_id: String,
    pub protocol_version: u32,
    pub agent_name: String,
    pub agent_version: String,
    pub capabilities: AgentBackendCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SidecarAttentionState {
    Running,
    WaitingInput,
    NeedsReview,
}

#[derive(Debug, Clone)]
pub enum SidecarEvent {
    Handshake {
        task_id: String,
        handshake: SidecarHandshake,
    },
    Started {
        session_id: String,
        task_id: String,
    },
    Output {
        task_id: String,
        chunk: String,
    },
    Attention {
        task_id: String,
        state: SidecarAttentionState,
        message: Option<String>,
    },
    Exited {
        task_id: String,
        exit_code: i32,
    },
}

pub struct SidecarSessionController {
    control_tx: Sender<SidecarControlMessage>,
}

impl SidecarSessionController {
    pub fn send_input(&self, input: &str) -> Result<(), String> {
        self.control_tx
            .send(SidecarControlMessage::Input(input.to_string()))
            .map_err(|err| err.to_string())
    }

    pub fn close(&self) -> Result<(), String> {
        self.control_tx
            .send(SidecarControlMessage::Close)
            .map_err(|err| err.to_string())
    }
}

pub struct StartedSidecarSession {
    pub controller: SidecarSessionController,
    pub events: Receiver<SidecarEvent>,
    pub display: String,
    pub initial_input: Option<String>,
    pub handshake: SidecarHandshake,
}

pub struct SidecarStartRequest<'a> {
    pub backend: &'a AgentBackendDescriptor,
    pub task_id: &'a str,
    pub session_id: &'a str,
    pub prompt: &'a str,
    pub cwd: &'a str,
    pub title: &'a str,
}

enum SidecarControlMessage {
    Input(String),
    ToolResult { call_id: String, result: Value },
    Close,
}

enum HandshakeSignal {
    Ready(SidecarHandshake),
    Error(String),
}

#[derive(Debug, Clone)]
struct ResolvedSidecarLaunch {
    config: SidecarBackendConfig,
    display: String,
    cwd: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SidecarStartEnvelope<'a> {
    #[serde(rename = "type")]
    message_type: &'static str,
    protocol_version: u32,
    backend_id: &'a str,
    task_id: &'a str,
    session_id: &'a str,
    title: &'a str,
    cwd: &'a str,
    prompt: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SidecarInputEnvelope<'a> {
    #[serde(rename = "type")]
    message_type: &'static str,
    task_id: &'a str,
    input: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SidecarToolResultEnvelope {
    #[serde(rename = "type")]
    message_type: &'static str,
    call_id: String,
    result: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SidecarCloseEnvelope<'a> {
    #[serde(rename = "type")]
    message_type: &'static str,
    task_id: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum SidecarWireEvent {
    #[serde(rename = "handshake")]
    Handshake {
        #[serde(rename = "taskId")]
        task_id: String,
        handshake: SidecarHandshake,
    },
    #[serde(rename = "started")]
    Started {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "taskId")]
        task_id: String,
    },
    #[serde(rename = "output")]
    Output {
        #[serde(rename = "taskId")]
        task_id: String,
        chunk: String,
    },
    #[serde(rename = "attention")]
    Attention {
        #[serde(rename = "taskId")]
        task_id: String,
        state: SidecarAttentionState,
        #[serde(default)]
        message: Option<String>,
    },
    #[serde(rename = "tool-call")]
    ToolCall {
        #[serde(rename = "taskId")]
        task_id: String,
        #[serde(rename = "callId")]
        call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        #[serde(default)]
        arguments: Value,
    },
    #[serde(rename = "exited")]
    Exited {
        #[serde(rename = "taskId")]
        task_id: String,
        #[serde(rename = "exitCode")]
        exit_code: i32,
    },
}

pub fn start_sidecar_session(
    request: SidecarStartRequest<'_>,
) -> Result<StartedSidecarSession, String> {
    let launch = resolve_sidecar_launch(&request.backend.backend_id, request.cwd)?;
    match launch.config.startup_mode {
        SidecarStartupMode::Loopback => start_loopback_sidecar_session(request, &launch),
        SidecarStartupMode::Process => start_process_sidecar_session(request, &launch),
    }
}

fn shell_escape(value: &str) -> String {
    if value.is_empty()
        || value
            .chars()
            .any(|ch| ch.is_whitespace() || matches!(ch, '"' | '\''))
    {
        format!("{value:?}")
    } else {
        value.to_string()
    }
}

fn parse_sidecar_startup_mode(value: &str) -> Result<SidecarStartupMode, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "loopback" => Ok(SidecarStartupMode::Loopback),
        "process" => Ok(SidecarStartupMode::Process),
        other => Err(format!(
            "unsupported sidecar startup mode override: {other}"
        )),
    }
}

fn resolve_sidecar_launch(
    backend_id: &str,
    fallback_cwd: &str,
) -> Result<ResolvedSidecarLaunch, String> {
    let mut config = sidecar_backend_config(backend_id).unwrap_or_default();

    if let Ok(mode) = std::env::var("MINI_TERM_TEST_AGENT_SIDECAR_MODE") {
        config.startup_mode = parse_sidecar_startup_mode(&mode)?;
        config.enabled = true;
    }

    if let Ok(command) = std::env::var("MINI_TERM_TEST_AGENT_SIDECAR_CMD") {
        let command = command.trim().to_string();
        if command.is_empty() {
            return Err("MINI_TERM_TEST_AGENT_SIDECAR_CMD cannot be empty".to_string());
        }
        config.command = Some(command);
        config.startup_mode = SidecarStartupMode::Process;
        config.enabled = true;
    }

    if let Ok(args_json) = std::env::var("MINI_TERM_TEST_AGENT_SIDECAR_ARGS_JSON") {
        let parsed = serde_json::from_str::<Vec<String>>(&args_json)
            .map_err(|err| format!("invalid MINI_TERM_TEST_AGENT_SIDECAR_ARGS_JSON: {err}"))?;
        config.args = parsed
            .into_iter()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .collect();
        config.startup_mode = SidecarStartupMode::Process;
        config.enabled = true;
    }

    let cwd = config
        .cwd
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| fallback_cwd.to_string());

    if let Some(reason) = config.launch_validation_error() {
        return Err(reason);
    }

    let display = match config.startup_mode {
        SidecarStartupMode::Loopback => format!("loopback://{backend_id}"),
        SidecarStartupMode::Process => format!(
            "{} {}",
            config.command.clone().unwrap_or_default(),
            config
                .args
                .iter()
                .map(|value| shell_escape(value))
                .collect::<Vec<_>>()
                .join(" ")
        )
        .trim()
        .to_string(),
    };

    Ok(ResolvedSidecarLaunch {
        config,
        display,
        cwd,
    })
}

fn wait_for_handshake(
    handshake_rx: Receiver<HandshakeSignal>,
    timeout_ms: u64,
) -> Result<SidecarHandshake, String> {
    match handshake_rx.recv_timeout(Duration::from_millis(timeout_ms.max(1))) {
        Ok(HandshakeSignal::Ready(handshake)) => Ok(handshake),
        Ok(HandshakeSignal::Error(error)) => Err(error),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            Err(format!("sidecar handshake timed out after {timeout_ms} ms"))
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            Err("sidecar handshake channel disconnected".to_string())
        }
    }
}

fn validate_handshake(
    backend: &AgentBackendDescriptor,
    handshake: &SidecarHandshake,
) -> Result<(), String> {
    if handshake.backend_id != backend.backend_id {
        return Err(format!(
            "sidecar handshake backend mismatch: expected {}, got {}",
            backend.backend_id, handshake.backend_id
        ));
    }

    if handshake.protocol_version != SIDECAR_PROTOCOL_VERSION {
        return Err(format!(
            "unsupported sidecar protocol version {} for backend {}",
            handshake.protocol_version, backend.backend_id
        ));
    }

    validate_handshake_capabilities(&backend.capabilities, &handshake.capabilities)
}

fn validate_handshake_capabilities(
    expected: &AgentBackendCapabilities,
    negotiated: &AgentBackendCapabilities,
) -> Result<(), String> {
    for (label, expected_value, negotiated_value) in [
        (
            "supportsWorkers",
            expected.supports_workers,
            negotiated.supports_workers,
        ),
        (
            "supportsResume",
            expected.supports_resume,
            negotiated.supports_resume,
        ),
        (
            "supportsToolCalls",
            expected.supports_tool_calls,
            negotiated.supports_tool_calls,
        ),
        (
            "brokeredTools",
            expected.brokered_tools,
            negotiated.brokered_tools,
        ),
        (
            "brokeredApprovals",
            expected.brokered_approvals,
            negotiated.brokered_approvals,
        ),
    ] {
        if !expected_value && negotiated_value {
            return Err(format!(
                "sidecar handshake declared stronger capability {label}=true than the registered backend contract allows"
            ));
        }
    }

    for reserved_tool in &expected.restricted_tool_names {
        if !negotiated
            .restricted_tool_names
            .iter()
            .any(|tool_name| tool_name == reserved_tool)
        {
            return Err(format!(
                "sidecar handshake omitted reserved tool {} from negotiated restrictions",
                reserved_tool
            ));
        }
    }

    Ok(())
}

fn start_loopback_sidecar_session(
    request: SidecarStartRequest<'_>,
    launch: &ResolvedSidecarLaunch,
) -> Result<StartedSidecarSession, String> {
    let (events_tx, events_rx) = mpsc::channel();
    let (control_tx, control_rx) = mpsc::channel();
    let handshake = SidecarHandshake {
        backend_id: request.backend.backend_id.clone(),
        protocol_version: SIDECAR_PROTOCOL_VERSION,
        agent_name: "mini-term-loopback".to_string(),
        agent_version: env!("CARGO_PKG_VERSION").to_string(),
        capabilities: request.backend.capabilities.clone(),
    };

    validate_handshake(request.backend, &handshake)?;

    let ready_message = format!("Loopback sidecar ready: {}", request.title);
    let task_id = request.task_id.to_string();
    let session_id = request.session_id.to_string();
    let handshake_event = handshake.clone();
    events_tx
        .send(SidecarEvent::Handshake {
            task_id: task_id.clone(),
            handshake: handshake_event,
        })
        .map_err(|err| err.to_string())?;

    thread::spawn(move || {
        let _ = events_tx.send(SidecarEvent::Started {
            task_id: task_id.clone(),
            session_id,
        });
        let _ = events_tx.send(SidecarEvent::Attention {
            task_id: task_id.clone(),
            state: SidecarAttentionState::Running,
            message: Some(ready_message),
        });

        while let Ok(message) = control_rx.recv() {
            match message {
                SidecarControlMessage::Input(input) => {
                    let _ = events_tx.send(SidecarEvent::Output {
                        task_id: task_id.clone(),
                        chunk: format!("INPUT: {input}\n"),
                    });
                    let _ = events_tx.send(SidecarEvent::Attention {
                        task_id: task_id.clone(),
                        state: SidecarAttentionState::WaitingInput,
                        message: Some(
                            "Loopback sidecar is waiting for the next input.".to_string(),
                        ),
                    });
                }
                SidecarControlMessage::ToolResult { .. } => {}
                SidecarControlMessage::Close => {
                    let _ = events_tx.send(SidecarEvent::Exited {
                        task_id: task_id.clone(),
                        exit_code: 0,
                    });
                    break;
                }
            }
        }
    });

    Ok(StartedSidecarSession {
        controller: SidecarSessionController { control_tx },
        events: events_rx,
        display: launch.display.clone(),
        initial_input: None,
        handshake,
    })
}

fn start_process_sidecar_session(
    request: SidecarStartRequest<'_>,
    launch: &ResolvedSidecarLaunch,
) -> Result<StartedSidecarSession, String> {
    let command_name = launch.config.command.as_deref().ok_or_else(|| {
        format!(
            "sidecar backend {} is missing a command",
            request.backend.backend_id
        )
    })?;

    let mut command = Command::new(command_name);
    command.args(&launch.config.args);
    command.current_dir(&launch.cwd);
    command.stdin(Stdio::piped());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    for (key, value) in launch.config.resolved_env() {
        command.env(key, value);
    }

    let mut child = command
        .spawn()
        .map_err(|err| format!("failed to launch sidecar process {}: {err}", launch.display))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "sidecar process did not expose stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "sidecar process did not expose stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "sidecar process did not expose stderr".to_string())?;

    let child = Arc::new(Mutex::new(child));
    let (events_tx, events_rx) = mpsc::channel();
    let (control_tx, control_rx) = mpsc::channel();
    let (handshake_tx, handshake_rx) = mpsc::channel();
    let handshake_ready = Arc::new(AtomicBool::new(false));
    let stderr_buffer = Arc::new(Mutex::new(String::new()));

    let start_envelope = SidecarStartEnvelope {
        message_type: "start",
        protocol_version: SIDECAR_PROTOCOL_VERSION,
        backend_id: &request.backend.backend_id,
        task_id: request.task_id,
        session_id: request.session_id,
        title: request.title,
        cwd: &launch.cwd,
        prompt: request.prompt,
    };

    let mut writer = BufWriter::new(stdin);
    write_json_line(&mut writer, &start_envelope).inspect_err(|_err| {
        let _ = kill_child(&child);
    })?;

    spawn_sidecar_stdin_loop(
        request.task_id.to_string(),
        writer,
        control_rx,
        child.clone(),
    );
    spawn_sidecar_stderr_loop(
        request.task_id.to_string(),
        stderr,
        events_tx.clone(),
        handshake_ready.clone(),
        stderr_buffer.clone(),
    );
    spawn_sidecar_stdout_loop(
        stdout,
        SidecarStdoutLoopContext {
            task_id: request.task_id.to_string(),
            child: child.clone(),
            events_tx,
            control_tx: control_tx.clone(),
            handshake_tx,
            handshake_ready,
            stderr_buffer,
        },
    );

    let handshake =
        wait_for_handshake(handshake_rx, launch.config.connection_timeout_ms).inspect_err(|_err| {
            let _ = kill_child(&child);
        })?;
    validate_handshake(request.backend, &handshake).inspect_err(|_err| {
        let _ = kill_child(&child);
    })?;

    Ok(StartedSidecarSession {
        controller: SidecarSessionController { control_tx },
        events: events_rx,
        display: launch.display.clone(),
        initial_input: None,
        handshake,
    })
}

fn spawn_sidecar_stdin_loop(
    task_id: String,
    mut writer: BufWriter<std::process::ChildStdin>,
    control_rx: Receiver<SidecarControlMessage>,
    child: Arc<Mutex<Child>>,
) {
    thread::spawn(move || {
        while let Ok(message) = control_rx.recv() {
            let write_result = match message {
                SidecarControlMessage::Input(input) => write_json_line(
                    &mut writer,
                    &SidecarInputEnvelope {
                        message_type: "input",
                        task_id: &task_id,
                        input: &input,
                    },
                ),
                SidecarControlMessage::ToolResult { call_id, result } => write_json_line(
                    &mut writer,
                    &SidecarToolResultEnvelope {
                        message_type: "tool-result",
                        call_id,
                        result,
                    },
                ),
                SidecarControlMessage::Close => {
                    let _ = write_json_line(
                        &mut writer,
                        &SidecarCloseEnvelope {
                            message_type: "close",
                            task_id: &task_id,
                        },
                    );
                    let _ = kill_child(&child);
                    break;
                }
            };

            if write_result.is_err() {
                let _ = kill_child(&child);
                break;
            }
        }
    });
}

struct SidecarStdoutLoopContext {
    task_id: String,
    child: Arc<Mutex<Child>>,
    events_tx: Sender<SidecarEvent>,
    control_tx: Sender<SidecarControlMessage>,
    handshake_tx: Sender<HandshakeSignal>,
    handshake_ready: Arc<AtomicBool>,
    stderr_buffer: Arc<Mutex<String>>,
}

fn spawn_sidecar_stdout_loop(
    stdout: ChildStdout,
    context: SidecarStdoutLoopContext,
) {
    thread::spawn(move || {
        let SidecarStdoutLoopContext {
            task_id,
            child,
            events_tx,
            control_tx,
            handshake_tx,
            handshake_ready,
            stderr_buffer,
        } = context;
        let mut reader = BufReader::new(stdout);
        let mut buffer = String::new();
        let mut handshake_sent = false;
        let mut exit_emitted = false;

        loop {
            buffer.clear();
            let read = match reader.read_line(&mut buffer) {
                Ok(read) => read,
                Err(err) => {
                    if !handshake_sent {
                        let _ = handshake_tx.send(HandshakeSignal::Error(format!(
                            "failed to read sidecar stdout before handshake: {err}"
                        )));
                    }
                    break;
                }
            };

            if read == 0 {
                break;
            }

            let line = buffer.trim();
            if line.is_empty() {
                continue;
            }

            let parsed = serde_json::from_str::<SidecarWireEvent>(line);
            if !handshake_sent {
                match parsed {
                    Ok(SidecarWireEvent::Handshake {
                        task_id: event_task_id,
                        handshake,
                    }) => {
                        handshake_ready.store(true, Ordering::SeqCst);
                        let _ = events_tx.send(SidecarEvent::Handshake {
                            task_id: event_task_id,
                            handshake: handshake.clone(),
                        });
                        let buffered_stderr = take_buffered_stderr(&stderr_buffer);
                        if !buffered_stderr.is_empty() {
                            let _ = events_tx.send(SidecarEvent::Output {
                                task_id: task_id.clone(),
                                chunk: buffered_stderr,
                            });
                        }
                        let _ = handshake_tx.send(HandshakeSignal::Ready(handshake));
                        handshake_sent = true;
                    }
                    Ok(other) => {
                        let _ = handshake_tx.send(HandshakeSignal::Error(format!(
                            "sidecar protocol error: expected handshake event before {}",
                            sidecar_wire_event_name(&other)
                        )));
                        break;
                    }
                    Err(err) => {
                        let stderr_excerpt = take_buffered_stderr(&stderr_buffer);
                        let detail = if stderr_excerpt.is_empty() {
                            line.to_string()
                        } else {
                            format!("{line} | stderr: {stderr_excerpt}")
                        };
                        let _ = handshake_tx.send(HandshakeSignal::Error(format!(
                            "failed to parse sidecar handshake event: {err}. first line: {detail}"
                        )));
                        break;
                    }
                }
                continue;
            }

            match parsed {
                Ok(SidecarWireEvent::Handshake { .. }) => {
                    let _ = events_tx.send(SidecarEvent::Output {
                        task_id: task_id.clone(),
                        chunk: "Ignoring duplicate sidecar handshake.\n".to_string(),
                    });
                }
                Ok(SidecarWireEvent::Started {
                    session_id,
                    task_id: event_task_id,
                }) => {
                    let _ = events_tx.send(SidecarEvent::Started {
                        session_id,
                        task_id: event_task_id,
                    });
                }
                Ok(SidecarWireEvent::Output {
                    task_id: event_task_id,
                    chunk,
                }) => {
                    let _ = events_tx.send(SidecarEvent::Output {
                        task_id: event_task_id,
                        chunk,
                    });
                }
                Ok(SidecarWireEvent::Attention {
                    task_id: event_task_id,
                    state,
                    message,
                }) => {
                    let _ = events_tx.send(SidecarEvent::Attention {
                        task_id: event_task_id,
                        state,
                        message,
                    });
                }
                Ok(SidecarWireEvent::ToolCall {
                    task_id: event_task_id,
                    call_id,
                    tool_name,
                    arguments,
                }) => {
                    let result = execute_sidecar_tool_call(&event_task_id, &tool_name, arguments);
                    let _ = control_tx.send(SidecarControlMessage::ToolResult { call_id, result });
                }
                Ok(SidecarWireEvent::Exited {
                    task_id: event_task_id,
                    exit_code,
                }) => {
                    let _ = events_tx.send(SidecarEvent::Exited {
                        task_id: event_task_id,
                        exit_code,
                    });
                    exit_emitted = true;
                    break;
                }
                Err(_) => {
                    let _ = events_tx.send(SidecarEvent::Output {
                        task_id: task_id.clone(),
                        chunk: format!("{line}\n"),
                    });
                }
            }
        }

        if !handshake_sent {
            let stderr_excerpt = take_buffered_stderr(&stderr_buffer);
            let message = if stderr_excerpt.is_empty() {
                "sidecar process exited before handshake".to_string()
            } else {
                format!("sidecar process exited before handshake: {stderr_excerpt}")
            };
            let _ = handshake_tx.send(HandshakeSignal::Error(message));
        }

        if handshake_sent && !exit_emitted {
            let exit_code = wait_for_child_exit(&child);
            let _ = events_tx.send(SidecarEvent::Exited { task_id, exit_code });
        }
    });
}

fn spawn_sidecar_stderr_loop(
    task_id: String,
    stderr: ChildStderr,
    events_tx: Sender<SidecarEvent>,
    handshake_ready: Arc<AtomicBool>,
    stderr_buffer: Arc<Mutex<String>>,
) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut buffer = String::new();
        loop {
            buffer.clear();
            let read = match reader.read_line(&mut buffer) {
                Ok(read) => read,
                Err(_) => break,
            };
            if read == 0 {
                break;
            }

            if handshake_ready.load(Ordering::SeqCst) {
                let _ = events_tx.send(SidecarEvent::Output {
                    task_id: task_id.clone(),
                    chunk: buffer.clone(),
                });
            } else {
                append_buffered_stderr(&stderr_buffer, &buffer);
            }
        }
    });
}

fn sidecar_wire_event_name(event: &SidecarWireEvent) -> &'static str {
    match event {
        SidecarWireEvent::Handshake { .. } => "handshake",
        SidecarWireEvent::Started { .. } => "started",
        SidecarWireEvent::Output { .. } => "output",
        SidecarWireEvent::Attention { .. } => "attention",
        SidecarWireEvent::ToolCall { .. } => "tool-call",
        SidecarWireEvent::Exited { .. } => "exited",
    }
}

fn write_json_line<W: Write, T: Serialize>(writer: &mut W, value: &T) -> Result<(), String> {
    serde_json::to_writer(&mut *writer, value).map_err(|err| err.to_string())?;
    writer.write_all(b"\n").map_err(|err| err.to_string())?;
    writer.flush().map_err(|err| err.to_string())
}

fn append_buffered_stderr(buffer: &Arc<Mutex<String>>, chunk: &str) {
    let mut locked = buffer.lock().unwrap();
    locked.push_str(chunk);
    if locked.len() > 4_000 {
        let start = locked.len().saturating_sub(4_000);
        *locked = locked[start..].to_string();
    }
}

fn take_buffered_stderr(buffer: &Arc<Mutex<String>>) -> String {
    let mut locked = buffer.lock().unwrap();
    let snapshot = locked.clone();
    locked.clear();
    snapshot
}

fn wait_for_child_exit(child: &Arc<Mutex<Child>>) -> i32 {
    child
        .lock()
        .unwrap()
        .wait()
        .ok()
        .and_then(|status| status.code())
        .unwrap_or(-1)
}

fn kill_child(child: &Arc<Mutex<Child>>) -> Result<(), String> {
    let mut child = child.lock().unwrap();
    match child.kill() {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::InvalidInput => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}
