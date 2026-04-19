use super::meta::SERVER_NAME;
use super::protocol::handle_json_rpc_request;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::Duration;
use uuid::Uuid;

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 8765;
const HTTP_AUTH_ENV_KEY: &str = "MINI_TERM_MCP_HTTP_TOKEN";

#[derive(Debug)]
struct HttpRequest {
    method: String,
    path: String,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

#[derive(Debug)]
struct HttpResponse {
    status: &'static str,
    content_type: &'static str,
    body: Vec<u8>,
    headers: Vec<(String, String)>,
}

fn response_json(
    status: &'static str,
    value: Value,
    headers: Vec<(String, String)>,
) -> Result<HttpResponse, String> {
    let body = serde_json::to_vec(&value).map_err(|err| err.to_string())?;
    Ok(HttpResponse {
        status,
        content_type: "application/json",
        body,
        headers,
    })
}

fn response_text(status: &'static str, text: &str) -> HttpResponse {
    HttpResponse {
        status,
        content_type: "text/plain; charset=utf-8",
        body: text.as_bytes().to_vec(),
        headers: Vec::new(),
    }
}

fn parse_bind_addr() -> String {
    let host =
        std::env::var("MINI_TERM_MCP_HTTP_HOST").unwrap_or_else(|_| DEFAULT_HOST.to_string());
    let port = std::env::var("MINI_TERM_MCP_HTTP_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT);
    format!("{host}:{port}")
}

fn read_http_auth_token() -> Result<String, String> {
    std::env::var(HTTP_AUTH_ENV_KEY)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            format!(
                "{HTTP_AUTH_ENV_KEY} must be set before starting mini-term-mcp-http"
            )
        })
}

fn requires_authorization(request: &HttpRequest) -> bool {
    !(request.method == "GET" && request.path == "/health")
}

fn require_authorization(headers: &BTreeMap<String, String>, token: &str) -> Result<(), String> {
    let authorization = headers
        .get("authorization")
        .ok_or("missing authorization header")?;
    if authorization == &format!("Bearer {token}") {
        Ok(())
    } else {
        Err("invalid authorization token".to_string())
    }
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

fn decode_chunked_body(mut buffer: Vec<u8>, stream: &mut TcpStream) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    let mut temp = [0u8; 4096];
    let mut position = 0usize;

    loop {
        let (line_end, sep_len) = loop {
            if let Some(result) = find_line_end(&buffer[position..]) {
                break result;
            }
            let read = stream.read(&mut temp).map_err(|err| err.to_string())?;
            if read == 0 {
                return Err("incomplete chunked HTTP body".to_string());
            }
            buffer.extend_from_slice(&temp[..read]);
        };
        let line_end = position + line_end;
        let size_line =
            std::str::from_utf8(&buffer[position..line_end]).map_err(|err| err.to_string())?;
        let chunk_size =
            usize::from_str_radix(size_line.split(';').next().unwrap_or("").trim(), 16)
                .map_err(|_| "invalid chunk size".to_string())?;
        position = line_end + sep_len;

        if chunk_size == 0 {
            loop {
                if leading_empty_line_len(&buffer[position..]).is_some() {
                    return Ok(body);
                }
                if let Some((trailer_end, trailer_sep_len)) = find_header_end(&buffer[position..]) {
                    let _ = trailer_end + trailer_sep_len;
                    return Ok(body);
                }
                let read = stream.read(&mut temp).map_err(|err| err.to_string())?;
                if read == 0 {
                    return Ok(body);
                }
                buffer.extend_from_slice(&temp[..read]);
            }
        }

        while buffer.len() < position + chunk_size + 2 {
            let read = stream.read(&mut temp).map_err(|err| err.to_string())?;
            if read == 0 {
                return Err("incomplete chunked HTTP body".to_string());
            }
            buffer.extend_from_slice(&temp[..read]);
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

fn read_http_request(stream: &mut TcpStream) -> Result<Option<HttpRequest>, String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|err| err.to_string())?;

    let mut buffer = Vec::new();
    let mut temp = [0u8; 4096];
    let (header_end, separator_len) = loop {
        match stream.read(&mut temp) {
            Ok(0) if buffer.is_empty() => return Ok(None),
            Ok(0) => return Err("incomplete HTTP request".to_string()),
            Ok(read) => {
                buffer.extend_from_slice(&temp[..read]);
                if let Some(result) = find_header_end(&buffer) {
                    break result;
                }
            }
            Err(err) => return Err(err.to_string()),
        }
    };

    let header_text =
        String::from_utf8(buffer[..header_end].to_vec()).map_err(|err| err.to_string())?;
    let mut lines = header_text.lines();
    let request_line = lines.next().ok_or("missing HTTP request line")?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts
        .next()
        .ok_or("missing HTTP method")?
        .to_string();
    let path = request_parts.next().ok_or("missing HTTP path")?.to_string();

    let mut headers = BTreeMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }

    let body_start = header_end + separator_len;
    let body = if headers
        .get("transfer-encoding")
        .map(|value| value.to_ascii_lowercase().contains("chunked"))
        .unwrap_or(false)
    {
        decode_chunked_body(buffer[body_start..].to_vec(), stream)?
    } else {
        let content_length = headers
            .get("content-length")
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);
        while buffer.len() < body_start + content_length {
            let read = stream.read(&mut temp).map_err(|err| err.to_string())?;
            if read == 0 {
                return Err("incomplete HTTP request body".to_string());
            }
            buffer.extend_from_slice(&temp[..read]);
        }
        buffer[body_start..body_start + content_length].to_vec()
    };

    Ok(Some(HttpRequest {
        method,
        path,
        headers,
        body,
    }))
}

fn write_http_response(stream: &mut TcpStream, response: HttpResponse) -> Result<(), String> {
    write!(
        stream,
        "HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-cache\r\nConnection: close\r\n",
        response.status,
        response.content_type,
        response.body.len()
    )
    .map_err(|err| err.to_string())?;
    for (name, value) in response.headers {
        write!(stream, "{name}: {value}\r\n").map_err(|err| err.to_string())?;
    }
    write!(stream, "\r\n").map_err(|err| err.to_string())?;
    stream
        .write_all(&response.body)
        .map_err(|err| err.to_string())?;
    stream.flush().map_err(|err| err.to_string())
}

fn write_sse_response(stream: &mut TcpStream, session_id: &str) -> Result<(), String> {
    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\nMcp-Session-Id: {}\r\n\r\n: connected\n\n",
        session_id
    )
    .map_err(|err| err.to_string())?;
    stream.flush().map_err(|err| err.to_string())?;

    loop {
        thread::sleep(Duration::from_secs(15));
        if stream.write_all(b": keepalive\n\n").is_err() {
            return Ok(());
        }
        if stream.flush().is_err() {
            return Ok(());
        }
    }
}

fn session_id(headers: &BTreeMap<String, String>) -> String {
    headers
        .get("mcp-session-id")
        .cloned()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| Uuid::now_v7().to_string())
}

fn handle_http_request(request: HttpRequest) -> Result<HttpResponse, String> {
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/health") => response_json(
            "200 OK",
            json!({
                "ok": true,
                "serverName": SERVER_NAME,
                "transport": "http",
            }),
            Vec::new(),
        ),
        ("POST", "/mcp") => {
            let session_id = session_id(&request.headers);
            let message: Value =
                serde_json::from_slice(&request.body).map_err(|err| err.to_string())?;
            let response = handle_json_rpc_request(message);
            response_json(
                "200 OK",
                response,
                vec![("Mcp-Session-Id".to_string(), session_id)],
            )
        }
        ("GET", "/mcp") => response_json(
            "200 OK",
            json!({
                "ok": true,
                "serverName": SERVER_NAME,
                "transport": "http",
                "streaming": "sse-available-via-accept-header",
            }),
            vec![("Mcp-Session-Id".to_string(), session_id(&request.headers))],
        ),
        ("GET", "/mcp/sse") => response_json(
            "200 OK",
            json!({
                "ok": true,
                "message": "Use GET /mcp with Accept: text/event-stream for SSE keepalive.",
            }),
            vec![("Mcp-Session-Id".to_string(), session_id(&request.headers))],
        ),
        _ => Ok(response_text("404 Not Found", "not found")),
    }
}

fn handle_connection(token: &str, mut stream: TcpStream) -> Result<(), String> {
    let request = match read_http_request(&mut stream)? {
        Some(request) => request,
        None => return Ok(()),
    };

    if requires_authorization(&request)
        && require_authorization(&request.headers, token).is_err() {
            return write_http_response(
                &mut stream,
                response_json(
                    "401 Unauthorized",
                    json!({
                        "ok": false,
                        "error": "unauthorized",
                    }),
                    Vec::new(),
                )?,
            );
        }

    if request.method == "GET"
        && request.path == "/mcp"
        && request
            .headers
            .get("accept")
            .map(|value| value.contains("text/event-stream"))
            .unwrap_or(false)
    {
        let session_id = session_id(&request.headers);
        return write_sse_response(&mut stream, &session_id);
    }

    let response = handle_http_request(request)?;
    write_http_response(&mut stream, response)
}

pub fn run_http_server() -> Result<(), String> {
    let token = read_http_auth_token()?;
    let bind_addr = parse_bind_addr();
    let listener = TcpListener::bind(&bind_addr).map_err(|err| err.to_string())?;
    eprintln!("mini-term-mcp-http listening on http://{bind_addr}/mcp");

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let token = token.clone();
                thread::spawn(move || {
                    if let Err(error) = handle_connection(&token, stream) {
                        eprintln!("{error}");
                    }
                });
            }
            Err(err) => eprintln!("{err}"),
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(name: &str, value: &str) -> (String, String) {
        (name.to_string(), value.to_string())
    }

    #[test]
    fn authorization_is_not_required_for_health() {
        let request = HttpRequest {
            method: "GET".to_string(),
            path: "/health".to_string(),
            headers: BTreeMap::new(),
            body: Vec::new(),
        };

        assert!(!requires_authorization(&request));
    }

    #[test]
    fn authorization_is_required_for_mcp_endpoints() {
        let request = HttpRequest {
            method: "POST".to_string(),
            path: "/mcp".to_string(),
            headers: BTreeMap::new(),
            body: Vec::new(),
        };

        assert!(requires_authorization(&request));
        assert!(require_authorization(&request.headers, "token").is_err());
        assert!(require_authorization(
            &BTreeMap::from([header("authorization", "Bearer token")]),
            "token"
        )
        .is_ok());
    }

    #[test]
    fn leading_empty_line_detects_chunked_terminator() {
        assert_eq!(leading_empty_line_len(b"\r\n"), Some(2));
        assert_eq!(leading_empty_line_len(b"\n"), Some(1));
        assert_eq!(leading_empty_line_len(b"header: value\r\n"), None);
    }

    #[test]
    fn health_endpoint_reports_http_transport() {
        let response = handle_http_request(HttpRequest {
            method: "GET".to_string(),
            path: "/health".to_string(),
            headers: BTreeMap::new(),
            body: Vec::new(),
        })
        .unwrap();

        let body: Value = serde_json::from_slice(&response.body).unwrap();
        assert_eq!(response.status, "200 OK");
        assert_eq!(body["ok"], true);
        assert_eq!(body["transport"], "http");
    }

    #[test]
    fn initialize_post_returns_server_info_and_session_header() {
        let response = handle_http_request(HttpRequest {
            method: "POST".to_string(),
            path: "/mcp".to_string(),
            headers: BTreeMap::new(),
            body: serde_json::to_vec(&json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {}
                }
            }))
            .unwrap(),
        })
        .unwrap();

        let body: Value = serde_json::from_slice(&response.body).unwrap();
        assert_eq!(response.status, "200 OK");
        assert_eq!(body["result"]["serverInfo"]["name"], SERVER_NAME);
        assert_eq!(body["result"]["protocolVersion"], "2025-03-26");
        assert!(response
            .headers
            .iter()
            .any(|(name, value)| name == "Mcp-Session-Id" && !value.is_empty()));
    }

    #[test]
    fn tools_call_ping_reuses_json_rpc_handler() {
        let headers = BTreeMap::from([header("mcp-session-id", "session-123")]);
        let response = handle_http_request(HttpRequest {
            method: "POST".to_string(),
            path: "/mcp".to_string(),
            headers,
            body: serde_json::to_vec(&json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {
                    "name": "ping",
                    "arguments": {}
                }
            }))
            .unwrap(),
        })
        .unwrap();

        let body: Value = serde_json::from_slice(&response.body).unwrap();
        assert_eq!(body["result"]["structuredContent"]["data"]["status"], "ok");
        assert!(response
            .headers
            .iter()
            .any(|(name, value)| name == "Mcp-Session-Id" && value == "session-123"));
    }

    #[test]
    fn server_info_over_http_reports_http_transport() {
        std::env::set_var("MINI_TERM_MCP_TRANSPORT", "http");
        let response = handle_http_request(HttpRequest {
            method: "POST".to_string(),
            path: "/mcp".to_string(),
            headers: BTreeMap::new(),
            body: serde_json::to_vec(&json!({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": "server_info",
                    "arguments": {}
                }
            }))
            .unwrap(),
        })
        .unwrap();

        let body: Value = serde_json::from_slice(&response.body).unwrap();
        assert_eq!(
            body["result"]["structuredContent"]["data"]["transport"],
            "http"
        );
        std::env::remove_var("MINI_TERM_MCP_TRANSPORT");
    }
}
