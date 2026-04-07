use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalMcpServer {
    pub id: String,
    pub name: String,
    pub transport: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub source_clients: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub source_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalMcpSourceStatus {
    pub client_type: String,
    pub source_kind: String,
    pub path: String,
    pub exists: bool,
    pub server_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalMcpCatalog {
    pub servers: Vec<ExternalMcpServer>,
    pub sources: Vec<ExternalMcpSourceStatus>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalMcpSyncRequest {
    pub client_types: Vec<String>,
    pub servers: Vec<ExternalMcpServer>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalMcpSyncFileResult {
    pub path: String,
    pub kind: String,
    pub created: bool,
    pub updated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalMcpSyncResult {
    pub client_type: String,
    pub server_count: usize,
    pub files: Vec<ExternalMcpSyncFileResult>,
}

fn home_dir() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("MINI_TERM_HOME_DIR") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    dirs::home_dir()
}

fn ensure_parent_dir(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|err| format!("failed to create {}: {err}", parent.display()))
}

fn write_text_if_changed(path: &Path, content: String) -> Result<(bool, bool), String> {
    match fs::read_to_string(path) {
        Ok(existing) if existing == content => Ok((false, false)),
        Ok(_) => {
            ensure_parent_dir(path)?;
            fs::write(path, content)
                .map_err(|err| format!("failed to write {}: {err}", path.display()))?;
            Ok((false, true))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            ensure_parent_dir(path)?;
            fs::write(path, content)
                .map_err(|err| format!("failed to write {}: {err}", path.display()))?;
            Ok((true, false))
        }
        Err(err) => Err(format!("failed to read {}: {err}", path.display())),
    }
}

fn parse_transport(spec: &Value) -> Option<String> {
    spec.get("type")
        .and_then(Value::as_str)
        .map(str::to_ascii_lowercase)
        .or_else(|| {
            if spec.get("url").is_some() {
                Some("http".to_string())
            } else if spec.get("command").is_some() {
                Some("stdio".to_string())
            } else {
                None
            }
        })
}

fn normalize_headers(value: Option<&Value>) -> BTreeMap<String, String> {
    value
        .and_then(Value::as_object)
        .map(|headers| {
            headers
                .iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|text| (key.clone(), text.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn normalize_env_table(value: Option<&toml::Value>) -> BTreeMap<String, String> {
    value
        .and_then(toml::Value::as_table)
        .map(|table| {
            table
                .iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|text| (key.clone(), text.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn normalize_string_list_from_json(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn normalize_string_list_from_toml(value: Option<&toml::Value>) -> Vec<String> {
    value
        .and_then(toml::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn merge_server(
    map: &mut BTreeMap<String, ExternalMcpServer>,
    server: ExternalMcpServer,
    warnings: &mut Vec<String>,
) {
    if let Some(existing) = map.get_mut(&server.id) {
        if same_server_spec(existing, &server) {
            for client in server.source_clients {
                if !existing.source_clients.contains(&client) {
                    existing.source_clients.push(client);
                }
            }
            for path in server.source_paths {
                if !existing.source_paths.contains(&path) {
                    existing.source_paths.push(path);
                }
            }
        } else {
            warnings.push(format!(
                "conflicting MCP server definition for `{}`; kept the first imported spec",
                server.id
            ));
        }
        return;
    }

    map.insert(server.id.clone(), server);
}

fn same_server_spec(lhs: &ExternalMcpServer, rhs: &ExternalMcpServer) -> bool {
    lhs.transport == rhs.transport
        && lhs.command == rhs.command
        && lhs.args == rhs.args
        && lhs.cwd == rhs.cwd
        && lhs.env == rhs.env
        && lhs.url == rhs.url
        && lhs.headers == rhs.headers
}

fn import_codex_servers(
    path: &Path,
    merged: &mut BTreeMap<String, ExternalMcpServer>,
    warnings: &mut Vec<String>,
) -> Result<ExternalMcpSourceStatus, String> {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ExternalMcpSourceStatus {
                client_type: "codex".to_string(),
                source_kind: "primary".to_string(),
                path: path.to_string_lossy().to_string(),
                exists: false,
                server_count: 0,
            });
        }
        Err(err) => {
            return Err(format!(
                "failed to read Codex config {}: {err}",
                path.display()
            ))
        }
    };

    let root = toml::from_str::<toml::Value>(&content)
        .map_err(|err| format!("failed to parse Codex config {}: {err}", path.display()))?;

    let mut count = 0usize;
    if let Some(mcp_servers) = root.get("mcp_servers").and_then(toml::Value::as_table) {
        count += import_codex_server_table(mcp_servers, path, merged, warnings, "codex");
    }
    if let Some(mcp_servers) = root
        .get("mcp")
        .and_then(toml::Value::as_table)
        .and_then(|table| table.get("servers"))
        .and_then(toml::Value::as_table)
    {
        count += import_codex_server_table(mcp_servers, path, merged, warnings, "codex");
    }

    Ok(ExternalMcpSourceStatus {
        client_type: "codex".to_string(),
        source_kind: "primary".to_string(),
        path: path.to_string_lossy().to_string(),
        exists: true,
        server_count: count,
    })
}

fn import_codex_server_table(
    table: &toml::map::Map<String, toml::Value>,
    source_path: &Path,
    merged: &mut BTreeMap<String, ExternalMcpServer>,
    warnings: &mut Vec<String>,
    client_type: &str,
) -> usize {
    let mut count = 0usize;
    for (id, entry) in table {
        let Some(entry) = entry.as_table() else {
            continue;
        };
        let transport = entry
            .get("type")
            .and_then(toml::Value::as_str)
            .unwrap_or("stdio")
            .to_ascii_lowercase();
        let server = match transport.as_str() {
            "stdio" => ExternalMcpServer {
                id: id.clone(),
                name: id.clone(),
                transport,
                command: entry
                    .get("command")
                    .and_then(toml::Value::as_str)
                    .map(str::to_string),
                args: normalize_string_list_from_toml(entry.get("args")),
                cwd: entry
                    .get("cwd")
                    .and_then(toml::Value::as_str)
                    .map(str::to_string),
                env: normalize_env_table(entry.get("env")),
                url: None,
                headers: BTreeMap::new(),
                source_clients: vec![client_type.to_string()],
                source_paths: vec![source_path.to_string_lossy().to_string()],
            },
            "http" | "sse" => ExternalMcpServer {
                id: id.clone(),
                name: id.clone(),
                transport,
                command: None,
                args: Vec::new(),
                cwd: None,
                env: BTreeMap::new(),
                url: entry
                    .get("url")
                    .and_then(toml::Value::as_str)
                    .map(str::to_string),
                headers: normalize_env_table(
                    entry.get("http_headers").or_else(|| entry.get("headers")),
                ),
                source_clients: vec![client_type.to_string()],
                source_paths: vec![source_path.to_string_lossy().to_string()],
            },
            other => {
                warnings.push(format!(
                    "ignored unsupported Codex MCP transport `{other}` for server `{id}`"
                ));
                continue;
            }
        };
        merge_server(merged, server, warnings);
        count += 1;
    }
    count
}

fn import_claude_servers(
    path: &Path,
    source_kind: &str,
    merged: &mut BTreeMap<String, ExternalMcpServer>,
    warnings: &mut Vec<String>,
) -> Result<ExternalMcpSourceStatus, String> {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ExternalMcpSourceStatus {
                client_type: "claude".to_string(),
                source_kind: source_kind.to_string(),
                path: path.to_string_lossy().to_string(),
                exists: false,
                server_count: 0,
            });
        }
        Err(err) => {
            return Err(format!(
                "failed to read Claude config {}: {err}",
                path.display()
            ))
        }
    };

    let value = serde_json::from_str::<Value>(&content)
        .map_err(|err| format!("failed to parse Claude config {}: {err}", path.display()))?;

    let mut count = 0usize;
    if let Some(mcp_servers) = value.get("mcpServers").and_then(Value::as_object) {
        for (id, spec) in mcp_servers {
            let Some(transport) = parse_transport(spec) else {
                warnings.push(format!(
                    "ignored Claude MCP server `{id}` because the transport could not be determined"
                ));
                continue;
            };
            let server = match transport.as_str() {
                "stdio" => ExternalMcpServer {
                    id: id.clone(),
                    name: id.clone(),
                    transport,
                    command: spec
                        .get("command")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    args: normalize_string_list_from_json(spec.get("args")),
                    cwd: spec.get("cwd").and_then(Value::as_str).map(str::to_string),
                    env: normalize_headers(spec.get("env")),
                    url: None,
                    headers: BTreeMap::new(),
                    source_clients: vec!["claude".to_string()],
                    source_paths: vec![path.to_string_lossy().to_string()],
                },
                "http" | "sse" => ExternalMcpServer {
                    id: id.clone(),
                    name: id.clone(),
                    transport,
                    command: None,
                    args: Vec::new(),
                    cwd: None,
                    env: BTreeMap::new(),
                    url: spec.get("url").and_then(Value::as_str).map(str::to_string),
                    headers: normalize_headers(
                        spec.get("headers").or_else(|| spec.get("http_headers")),
                    ),
                    source_clients: vec!["claude".to_string()],
                    source_paths: vec![path.to_string_lossy().to_string()],
                },
                other => {
                    warnings.push(format!(
                        "ignored unsupported Claude MCP transport `{other}` for server `{id}`"
                    ));
                    continue;
                }
            };
            merge_server(merged, server, warnings);
            count += 1;
        }
    }

    Ok(ExternalMcpSourceStatus {
        client_type: "claude".to_string(),
        source_kind: source_kind.to_string(),
        path: path.to_string_lossy().to_string(),
        exists: true,
        server_count: count,
    })
}

fn build_codex_server_value(server: &ExternalMcpServer) -> Result<toml::Value, String> {
    match server.transport.as_str() {
        "stdio" => {
            let command = server
                .command
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| format!("stdio MCP server `{}` is missing a command", server.id))?;
            let mut table = toml::map::Map::new();
            table.insert("type".to_string(), toml::Value::String("stdio".to_string()));
            table.insert(
                "command".to_string(),
                toml::Value::String(command.to_string()),
            );
            if !server.args.is_empty() {
                table.insert(
                    "args".to_string(),
                    toml::Value::Array(
                        server
                            .args
                            .iter()
                            .map(|arg| toml::Value::String(arg.clone()))
                            .collect(),
                    ),
                );
            }
            if let Some(cwd) = server
                .cwd
                .as_deref()
                .filter(|value| !value.trim().is_empty())
            {
                table.insert("cwd".to_string(), toml::Value::String(cwd.to_string()));
            }
            if !server.env.is_empty() {
                let env = server
                    .env
                    .iter()
                    .map(|(key, value)| (key.clone(), toml::Value::String(value.clone())))
                    .collect();
                table.insert("env".to_string(), toml::Value::Table(env));
            }
            Ok(toml::Value::Table(table))
        }
        "http" | "sse" => {
            let url = server
                .url
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    format!(
                        "{} MCP server `{}` is missing a URL",
                        server.transport, server.id
                    )
                })?;
            let mut table = toml::map::Map::new();
            table.insert(
                "type".to_string(),
                toml::Value::String(server.transport.clone()),
            );
            table.insert("url".to_string(), toml::Value::String(url.to_string()));
            if !server.headers.is_empty() {
                let headers = server
                    .headers
                    .iter()
                    .map(|(key, value)| (key.clone(), toml::Value::String(value.clone())))
                    .collect();
                table.insert("http_headers".to_string(), toml::Value::Table(headers));
            }
            Ok(toml::Value::Table(table))
        }
        other => Err(format!(
            "unsupported MCP transport `{other}` for server `{}`",
            server.id
        )),
    }
}

fn build_claude_server_value(server: &ExternalMcpServer) -> Result<Value, String> {
    match server.transport.as_str() {
        "stdio" => {
            let command = server
                .command
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| format!("stdio MCP server `{}` is missing a command", server.id))?;
            let mut value = json!({
                "type": "stdio",
                "command": command,
            });
            if !server.args.is_empty() {
                value["args"] =
                    Value::Array(server.args.iter().cloned().map(Value::String).collect());
            }
            if let Some(cwd) = server
                .cwd
                .as_deref()
                .filter(|value| !value.trim().is_empty())
            {
                value["cwd"] = Value::String(cwd.to_string());
            }
            if !server.env.is_empty() {
                value["env"] = serde_json::to_value(&server.env).map_err(|err| err.to_string())?;
            }
            Ok(value)
        }
        "http" | "sse" => {
            let url = server
                .url
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    format!(
                        "{} MCP server `{}` is missing a URL",
                        server.transport, server.id
                    )
                })?;
            let mut value = json!({
                "type": server.transport,
                "url": url,
            });
            if !server.headers.is_empty() {
                value["headers"] =
                    serde_json::to_value(&server.headers).map_err(|err| err.to_string())?;
            }
            Ok(value)
        }
        other => Err(format!(
            "unsupported MCP transport `{other}` for server `{}`",
            server.id
        )),
    }
}

fn sync_codex_servers(
    home_dir: &Path,
    servers: &[ExternalMcpServer],
) -> Result<ExternalMcpSyncResult, String> {
    let config_path = home_dir.join(".codex").join("config.toml");
    let mut config_value = match fs::read_to_string(&config_path) {
        Ok(content) => toml::from_str::<toml::Value>(&content).map_err(|err| {
            format!(
                "failed to parse Codex config {}: {err}",
                config_path.display()
            )
        })?,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            toml::Value::Table(toml::map::Map::new())
        }
        Err(err) => {
            return Err(format!(
                "failed to read Codex config {}: {err}",
                config_path.display()
            ))
        }
    };

    let root = config_value
        .as_table_mut()
        .ok_or_else(|| "Codex config must be a TOML table".to_string())?;
    let mcp_servers = root
        .entry("mcp_servers")
        .or_insert_with(|| toml::Value::Table(toml::map::Map::new()))
        .as_table_mut()
        .ok_or_else(|| "Codex config field `mcp_servers` must be a TOML table".to_string())?;

    for server in servers {
        mcp_servers.insert(server.id.clone(), build_codex_server_value(server)?);
    }

    let serialized = toml::to_string_pretty(&config_value).map_err(|err| err.to_string())?;
    let (created, updated) = write_text_if_changed(&config_path, serialized)?;

    Ok(ExternalMcpSyncResult {
        client_type: "codex".to_string(),
        server_count: servers.len(),
        files: vec![ExternalMcpSyncFileResult {
            path: config_path.to_string_lossy().to_string(),
            kind: "primary".to_string(),
            created,
            updated,
        }],
    })
}

fn sync_claude_json_file(
    path: &Path,
    kind: &str,
    servers: &[ExternalMcpServer],
) -> Result<ExternalMcpSyncFileResult, String> {
    let mut config_value = match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str::<Value>(&content)
            .map_err(|err| format!("failed to parse Claude config {}: {err}", path.display()))?,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(err) => {
            return Err(format!(
                "failed to read Claude config {}: {err}",
                path.display()
            ))
        }
    };

    let root = config_value
        .as_object_mut()
        .ok_or_else(|| "Claude config must be a JSON object".to_string())?;
    let mcp_servers = root
        .entry("mcpServers".to_string())
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| "Claude config field `mcpServers` must be a JSON object".to_string())?;

    for server in servers {
        mcp_servers.insert(server.id.clone(), build_claude_server_value(server)?);
    }

    let serialized = serde_json::to_string_pretty(&config_value).map_err(|err| err.to_string())?;
    let (created, updated) = write_text_if_changed(path, serialized)?;
    Ok(ExternalMcpSyncFileResult {
        path: path.to_string_lossy().to_string(),
        kind: kind.to_string(),
        created,
        updated,
    })
}

fn sync_claude_servers(
    home_dir: &Path,
    servers: &[ExternalMcpServer],
) -> Result<ExternalMcpSyncResult, String> {
    let mut files = Vec::new();
    let primary = home_dir.join(".claude.json");
    files.push(sync_claude_json_file(&primary, "primary", servers)?);

    let claude_dir = home_dir.join(".claude");
    if claude_dir.is_dir() {
        let catalog = claude_dir.join("mcp-configs").join("mcp-servers.json");
        files.push(sync_claude_json_file(&catalog, "catalog", servers)?);
    }

    Ok(ExternalMcpSyncResult {
        client_type: "claude".to_string(),
        server_count: servers.len(),
        files,
    })
}

#[tauri::command]
pub fn list_external_mcp_servers() -> Result<ExternalMcpCatalog, String> {
    let home = home_dir().ok_or_else(|| "unable to resolve home directory".to_string())?;
    let codex_path = home.join(".codex").join("config.toml");
    let claude_primary = home.join(".claude.json");
    let claude_catalog = home
        .join(".claude")
        .join("mcp-configs")
        .join("mcp-servers.json");

    let mut merged = BTreeMap::new();
    let mut warnings = Vec::new();
    let sources = vec![
        import_codex_servers(&codex_path, &mut merged, &mut warnings)?,
        import_claude_servers(&claude_primary, "primary", &mut merged, &mut warnings)?,
        import_claude_servers(&claude_catalog, "catalog", &mut merged, &mut warnings)?,
    ];

    Ok(ExternalMcpCatalog {
        servers: merged.into_values().collect(),
        sources,
        warnings,
    })
}

#[tauri::command]
pub fn sync_external_mcp_servers(
    request: ExternalMcpSyncRequest,
) -> Result<Vec<ExternalMcpSyncResult>, String> {
    if request.servers.is_empty() {
        return Err("at least one MCP server is required to sync".to_string());
    }

    let home = home_dir().ok_or_else(|| "unable to resolve home directory".to_string())?;
    let mut client_types = BTreeSet::new();
    for client_type in request.client_types {
        let normalized = client_type.trim().to_ascii_lowercase();
        if normalized.is_empty() {
            continue;
        }
        client_types.insert(normalized);
    }
    if client_types.is_empty() {
        return Err("at least one client type is required to sync".to_string());
    }

    let mut results = Vec::new();
    for client_type in client_types {
        match client_type.as_str() {
            "codex" => results.push(sync_codex_servers(&home, &request.servers)?),
            "claude" => results.push(sync_claude_servers(&home, &request.servers)?),
            other => return Err(format!("unsupported MCP interop client type: {other}")),
        }
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new(prefix: &str) -> Self {
            let unique = format!(
                "{}-{}-{}",
                prefix,
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .expect("system time should be after epoch")
                    .as_nanos()
            );
            let path = env::temp_dir().join(unique);
            fs::create_dir_all(&path).expect("failed to create temp dir");
            Self { path }
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn list_external_mcp_servers_imports_codex_and_claude_sources() {
        let home = TestDir::new("mini-term-mcp-interop-import");
        fs::create_dir_all(home.path.join(".codex")).unwrap();
        fs::create_dir_all(home.path.join(".claude").join("mcp-configs")).unwrap();
        fs::write(
            home.path.join(".codex").join("config.toml"),
            r#"[mcp_servers.github]
type = "stdio"
command = "uvx"
args = ["mcp-server-github"]
"#,
        )
        .unwrap();
        fs::write(
            home.path.join(".claude.json"),
            r#"{"mcpServers":{"linear":{"type":"http","url":"http://127.0.0.1:8123/mcp"}}}"#,
        )
        .unwrap();

        let mut merged = BTreeMap::new();
        let mut warnings = Vec::new();
        let codex = import_codex_servers(
            &home.path.join(".codex").join("config.toml"),
            &mut merged,
            &mut warnings,
        )
        .unwrap();
        let claude = import_claude_servers(
            &home.path.join(".claude.json"),
            "primary",
            &mut merged,
            &mut warnings,
        )
        .unwrap();

        assert_eq!(codex.server_count, 1);
        assert_eq!(claude.server_count, 1);
        assert!(warnings.is_empty());
        assert!(merged.contains_key("github"));
        assert!(merged.contains_key("linear"));
    }

    #[test]
    fn sync_external_mcp_servers_writes_codex_and_claude_configs() {
        let home = TestDir::new("mini-term-mcp-interop-sync");
        fs::create_dir_all(home.path.join(".claude")).unwrap();

        let servers = vec![
            ExternalMcpServer {
                id: "github".to_string(),
                name: "github".to_string(),
                transport: "stdio".to_string(),
                command: Some("uvx".to_string()),
                args: vec!["mcp-server-github".to_string()],
                cwd: None,
                env: BTreeMap::new(),
                url: None,
                headers: BTreeMap::new(),
                source_clients: vec!["codex".to_string()],
                source_paths: vec![],
            },
            ExternalMcpServer {
                id: "linear".to_string(),
                name: "linear".to_string(),
                transport: "http".to_string(),
                command: None,
                args: Vec::new(),
                cwd: None,
                env: BTreeMap::new(),
                url: Some("http://127.0.0.1:8123/mcp".to_string()),
                headers: BTreeMap::new(),
                source_clients: vec!["claude".to_string()],
                source_paths: vec![],
            },
        ];

        let codex = sync_codex_servers(&home.path, &servers).unwrap();
        let claude = sync_claude_servers(&home.path, &servers).unwrap();

        assert_eq!(codex.server_count, 2);
        assert_eq!(claude.server_count, 2);
        let codex_text = fs::read_to_string(home.path.join(".codex").join("config.toml")).unwrap();
        assert!(codex_text.contains("[mcp_servers.github]"));
        assert!(codex_text.contains("[mcp_servers.linear]"));
        let claude_json = fs::read_to_string(home.path.join(".claude.json")).unwrap();
        assert!(claude_json.contains("\"github\""));
        assert!(claude_json.contains("\"linear\""));
    }
}
