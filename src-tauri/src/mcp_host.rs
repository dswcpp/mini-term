use crate::agent_policy::{resolve_stdio_mcp_launch, McpLaunchInfo};
use crate::mcp::meta::{PROTOCOL_VERSION, SERVER_NAME};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::process::{Command, Stdio};

fn write_message<W: Write>(writer: &mut W, value: &Value) -> Result<(), String> {
    let body = serde_json::to_vec(value).map_err(|err| err.to_string())?;
    write!(writer, "Content-Length: {}\r\n\r\n", body.len()).map_err(|err| err.to_string())?;
    writer.write_all(&body).map_err(|err| err.to_string())?;
    writer.flush().map_err(|err| err.to_string())
}

fn read_message<R: Read>(reader: &mut R) -> Result<Option<Value>, String> {
    let mut content_length = None;
    let mut header = Vec::new();
    let mut byte = [0u8; 1];

    loop {
        let read = reader.read(&mut byte).map_err(|err| err.to_string())?;
        if read == 0 {
            return Ok(None);
        }
        header.push(byte[0]);
        if header.ends_with(b"\r\n\r\n") {
            let header_text = String::from_utf8_lossy(&header);
            for line in header_text.lines() {
                if let Some(value) = line
                    .to_ascii_lowercase()
                    .strip_prefix("content-length:")
                    .map(str::trim)
                {
                    content_length = value.parse::<usize>().ok();
                }
            }
            break;
        }
    }

    let Some(content_length) = content_length else {
        return Err("missing content-length".to_string());
    };
    let mut body = vec![0u8; content_length];
    reader
        .read_exact(&mut body)
        .map_err(|err| err.to_string())?;
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|err| err.to_string())
}

fn launch_process(launch: &McpLaunchInfo) -> Result<std::process::Child, String> {
    let Some(command) = launch.command.as_ref() else {
        return Err(launch
            .notes
            .clone()
            .unwrap_or_else(|| "Mini-Term MCP launch is not resolved".to_string()));
    };
    if launch.status != "resolved" {
        return Err(launch
            .notes
            .clone()
            .unwrap_or_else(|| "Mini-Term MCP launch is not resolved".to_string()));
    }

    let mut command = Command::new(command);
    command.args(&launch.args);
    if let Some(cwd) = &launch.cwd {
        command.current_dir(cwd);
    }
    command.stdin(Stdio::piped());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    command.spawn().map_err(|err| err.to_string())
}

fn request(method: &str, params: Option<Value>) -> Result<Value, String> {
    let launch = resolve_stdio_mcp_launch();
    let mut child = launch_process(&launch)?;
    let mut stdin = child.stdin.take().ok_or("missing child stdin")?;
    let mut stdout = child.stdout.take().ok_or("missing child stdout")?;
    let mut stderr = child.stderr.take().ok_or("missing child stderr")?;

    write_message(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {
                    "name": "mini-term-embedded-host",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }
        }),
    )?;

    let init_response = read_message(&mut stdout)?.ok_or("missing initialize response")?;
    if init_response
        .get("result")
        .and_then(|result| result.get("serverInfo"))
        .and_then(|info| info.get("name"))
        .and_then(Value::as_str)
        != Some(SERVER_NAME)
    {
        return Err("embedded MCP initialize returned unexpected server info".to_string());
    }

    write_message(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
            "params": {}
        }),
    )?;

    let request_value = match params {
        Some(params) => json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": method,
            "params": params,
        }),
        None => json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": method,
        }),
    };
    write_message(&mut stdin, &request_value)?;
    drop(stdin);

    let response = read_message(&mut stdout)?.ok_or("missing MCP response")?;
    let mut stderr_buffer = String::new();
    let _ = stderr.read_to_string(&mut stderr_buffer);
    let _ = child.wait();

    if let Some(error) = response.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("MCP request failed");
        let detail = if stderr_buffer.trim().is_empty() {
            message.to_string()
        } else {
            format!("{message}\n{stderr_buffer}")
        };
        return Err(detail);
    }

    Ok(response)
}

pub fn get_embedded_mcp_launch() -> McpLaunchInfo {
    resolve_stdio_mcp_launch()
}

pub fn list_embedded_mcp_tools() -> Result<Value, String> {
    let response = request("tools/list", None)?;
    Ok(response["result"]["tools"].clone())
}

pub fn call_embedded_mcp_tool(name: &str, arguments: Value) -> Result<Value, String> {
    let response = request(
        "tools/call",
        Some(json!({
            "name": name,
            "arguments": arguments,
        })),
    )?;
    Ok(response["result"]["structuredContent"].clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn test_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn embedded_host_lists_tools() {
        let _guard = test_lock().lock().unwrap();
        let tools = list_embedded_mcp_tools().expect("embedded host should list tools");
        let items = tools.as_array().expect("tools list should be an array");
        assert!(items.iter().any(|item| item["name"] == "ping"));
        assert!(items.len() >= 37);
        assert!(items.iter().any(|item| item["name"] == "get_pty_detail"));
    }

    #[test]
    fn embedded_host_calls_ping() {
        let _guard = test_lock().lock().unwrap();
        let result =
            call_embedded_mcp_tool("ping", json!({})).expect("embedded host should call ping");
        assert_eq!(result["ok"], true);
        assert_eq!(result["data"]["status"], "ok");
    }
}
