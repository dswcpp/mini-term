use crate::mcp::tools::{files, git, pty, runtime, sessions, tasks, ui, workspace};
use serde_json::{json, Value};

pub type ToolHandler = fn(Value) -> Result<Value, String>;

pub struct ToolDefinition {
    pub name: &'static str,
    pub description: &'static str,
    pub input_schema: fn() -> Value,
    pub handler: ToolHandler,
    pub group: &'static str,
    pub stability: &'static str,
    pub read_only: bool,
    pub requires_confirmation: bool,
    pub requires_host_connection: bool,
    pub supports_dry_run: bool,
    pub supports_pagination: bool,
    pub when_to_use: &'static str,
}

fn schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false,
    })
}

fn empty_schema() -> Value {
    schema(json!({}), &[])
}
fn paged_schema() -> Value {
    schema(
        json!({
            "cursor": { "type": "string" },
            "limit": { "type": "integer", "minimum": 1, "maximum": 200 }
        }),
        &[],
    )
}
fn list_tools_schema() -> Value {
    schema(
        json!({
            "cursor": { "type": "string" },
            "group": { "type": "string" },
            "limit": { "type": "integer", "minimum": 1, "maximum": 200 }
        }),
        &[],
    )
}
fn recent_events_schema() -> Value {
    schema(
        json!({
            "cursor": { "type": "string" },
            "kinds": { "type": "array", "items": { "type": "string" } },
            "limit": { "type": "integer", "minimum": 1, "maximum": 200 },
            "since": { "type": "integer", "minimum": 0 }
        }),
        &[],
    )
}
fn ai_sessions_schema() -> Value {
    schema(
        json!({
            "cursor": { "type": "string" },
            "limit": { "type": "integer", "minimum": 1, "maximum": 200 },
            "workspaceId": { "type": "string" }
        }),
        &[],
    )
}
fn get_config_schema() -> Value {
    schema(
        json!({
            "sections": { "type": "array", "items": { "type": "string" } }
        }),
        &[],
    )
}
fn set_config_fields_schema() -> Value {
    schema(
        json!({
            "dryRun": { "type": "boolean" },
            "patch": {
                "type": "object",
                "properties": {
                    "defaultShell": { "type": "string" },
                    "availableShells": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": { "type": "string" },
                                "command": { "type": "string" },
                                "args": { "type": "array", "items": { "type": "string" } }
                            },
                            "required": ["name", "command"],
                            "additionalProperties": false
                        }
                    },
                    "uiFontSize": { "type": "number", "minimum": 8, "maximum": 72 },
                    "terminalFontSize": { "type": "number", "minimum": 8, "maximum": 72 },
                    "layoutSizes": { "type": "array", "items": { "type": "number", "exclusiveMinimum": 0 } },
                    "middleColumnSizes": { "type": "array", "items": { "type": "number", "exclusiveMinimum": 0 } },
                    "workspaceSidebarSizes": { "type": "array", "items": { "type": "number", "exclusiveMinimum": 0 } },
                    "theme": {
                        "type": "object",
                        "properties": {
                            "preset": { "type": "string" },
                            "windowEffect": { "type": "string" }
                        },
                        "additionalProperties": false
                    }
                },
                "additionalProperties": false
            }
        }),
        &["patch"],
    )
}
fn workspace_context_schema() -> Value {
    schema(
        json!({
            "workspaceId": { "type": "string" },
            "preset": { "type": "string", "enum": ["light", "standard", "review"] }
        }),
        &["workspaceId"],
    )
}
fn read_file_schema() -> Value {
    schema(json!({ "path": { "type": "string" } }), &["path"])
}
fn search_files_schema() -> Value {
    schema(
        json!({
            "rootPath": { "type": "string" },
            "query": { "type": "string" },
            "limit": { "type": "integer", "minimum": 1 }
        }),
        &["rootPath", "query"],
    )
}
fn project_path_schema() -> Value {
    schema(
        json!({ "projectPath": { "type": "string" } }),
        &["projectPath"],
    )
}
fn diff_for_review_schema() -> Value {
    schema(
        json!({
            "projectPath": { "type": "string" },
            "filePath": { "type": "string" }
        }),
        &["projectPath", "filePath"],
    )
}
fn list_ai_sessions_legacy_schema() -> Value {
    schema(
        json!({
            "projectPaths": { "type": "array", "items": { "type": "string" }, "minItems": 1 }
        }),
        &["projectPaths"],
    )
}
fn start_task_schema() -> Value {
    schema(
        json!({
            "workspaceId": { "type": "string" },
            "target": { "type": "string", "enum": ["codex", "claude"] },
            "prompt": { "type": "string" },
            "contextPreset": { "type": "string", "enum": ["light", "standard", "review"] },
            "cwd": { "type": "string" },
            "title": { "type": "string" }
        }),
        &["workspaceId", "target", "prompt", "contextPreset"],
    )
}
fn task_id_schema() -> Value {
    schema(json!({ "taskId": { "type": "string" } }), &["taskId"])
}
fn approval_list_schema() -> Value {
    schema(
        json!({
            "status": { "type": "string", "enum": ["pending", "approved", "rejected", "executed"] },
            "toolName": { "type": "string" }
        }),
        &[],
    )
}
fn approval_decision_schema() -> Value {
    schema(
        json!({
            "requestId": { "type": "string" },
            "decision": { "type": "string", "enum": ["approved", "rejected"] }
        }),
        &["requestId", "decision"],
    )
}
fn send_task_input_schema() -> Value {
    schema(
        json!({
            "taskId": { "type": "string" },
            "input": { "type": "string" },
            "submitOnly": { "type": "boolean" }
        }),
        &["taskId"],
    )
}
fn close_task_schema() -> Value {
    schema(
        json!({
            "taskId": { "type": "string" },
            "approvalRequestId": { "type": "string" }
        }),
        &["taskId"],
    )
}
fn write_file_schema() -> Value {
    schema(
        json!({
            "path": { "type": "string" },
            "content": { "type": "string" },
            "approvalRequestId": { "type": "string" }
        }),
        &["path", "content"],
    )
}
fn run_workspace_command_schema() -> Value {
    schema(
        json!({
            "workspacePath": { "type": "string" },
            "command": { "type": "string" },
            "approvalRequestId": { "type": "string" }
        }),
        &["workspacePath", "command"],
    )
}
fn pty_id_schema() -> Value {
    schema(
        json!({ "ptyId": { "type": "integer", "minimum": 1 } }),
        &["ptyId"],
    )
}
fn create_pty_schema() -> Value {
    schema(
        json!({
            "workspaceId": { "type": "string" },
            "cwd": { "type": "string" },
            "shellName": { "type": "string" },
            "mode": { "type": "string", "enum": ["human", "agent", "task"] },
            "cols": { "type": "integer", "minimum": 1 },
            "rows": { "type": "integer", "minimum": 1 }
        }),
        &["workspaceId"],
    )
}
fn write_pty_schema() -> Value {
    schema(
        json!({
            "ptyId": { "type": "integer", "minimum": 1 },
            "data": { "type": "string" }
        }),
        &["ptyId", "data"],
    )
}
fn resize_pty_schema() -> Value {
    schema(
        json!({
            "ptyId": { "type": "integer", "minimum": 1 },
            "cols": { "type": "integer", "minimum": 1 },
            "rows": { "type": "integer", "minimum": 1 }
        }),
        &["ptyId", "cols", "rows"],
    )
}
fn kill_pty_schema() -> Value {
    schema(
        json!({
            "ptyId": { "type": "integer", "minimum": 1 },
            "approvalRequestId": { "type": "string" }
        }),
        &["ptyId"],
    )
}
fn focus_workspace_schema() -> Value {
    schema(
        json!({ "workspaceId": { "type": "string" } }),
        &["workspaceId"],
    )
}
fn create_tab_schema() -> Value {
    schema(
        json!({
            "workspaceId": { "type": "string" },
            "cwd": { "type": "string" },
            "shellName": { "type": "string" },
            "activate": { "type": "boolean" }
        }),
        &["workspaceId"],
    )
}
fn close_tab_schema() -> Value {
    schema(
        json!({
            "workspaceId": { "type": "string" },
            "tabId": { "type": "string" },
            "approvalRequestId": { "type": "string" }
        }),
        &["workspaceId", "tabId"],
    )
}
fn split_pane_schema() -> Value {
    schema(
        json!({
            "workspaceId": { "type": "string" },
            "tabId": { "type": "string" },
            "paneId": { "type": "string" },
            "direction": { "type": "string", "enum": ["horizontal", "vertical"] },
            "cwd": { "type": "string" },
            "shellName": { "type": "string" },
            "activate": { "type": "boolean" }
        }),
        &["workspaceId", "tabId", "paneId", "direction"],
    )
}
fn notify_user_schema() -> Value {
    schema(
        json!({
            "message": { "type": "string" },
            "tone": { "type": "string", "enum": ["info", "success", "error"] },
            "durationMs": { "type": "integer", "minimum": 0 }
        }),
        &["message"],
    )
}

macro_rules! tool {
    ($name:literal, $desc:literal, $schema:ident, $handler:path, $group:literal, $ro:literal, $confirm:literal, $host:literal, $dry:literal, $page:literal, $use:literal) => {
        ToolDefinition {
            name: $name,
            description: $desc,
            input_schema: $schema,
            handler: $handler,
            group: $group,
            stability: "stable",
            read_only: $ro,
            requires_confirmation: $confirm,
            requires_host_connection: $host,
            supports_dry_run: $dry,
            supports_pagination: $page,
            when_to_use: $use,
        }
    };
}

const TOOL_DEFINITIONS: &[ToolDefinition] = &[
    tool!(
        "ping",
        "Health check.",
        empty_schema,
        runtime::ping_tool,
        "core-runtime",
        true,
        false,
        false,
        false,
        false,
        "Check server liveness first."
    ),
    tool!(
        "server_info",
        "Version and host diagnostics.",
        empty_schema,
        runtime::server_info_tool,
        "core-runtime",
        true,
        false,
        false,
        false,
        false,
        "Inspect transport and host status."
    ),
    tool!(
        "list_tools",
        "Tool discovery with metadata.",
        list_tools_schema,
        runtime::list_tools_tool,
        "core-runtime",
        true,
        false,
        false,
        false,
        true,
        "Discover groups, approval gates, and host-backed tools."
    ),
    tool!(
        "list_workspaces",
        "Workspace catalog.",
        empty_schema,
        workspace::list_workspaces_tool,
        "runtime-observation",
        true,
        false,
        false,
        false,
        false,
        "Pick a workspace before acting."
    ),
    tool!(
        "get_workspace_context",
        "Structured workspace context.",
        workspace_context_schema,
        workspace::get_workspace_context_tool,
        "runtime-observation",
        true,
        false,
        false,
        false,
        false,
        "Load instructions and related context."
    ),
    tool!(
        "get_config",
        "Focused config view.",
        get_config_schema,
        runtime::get_config_tool,
        "runtime-observation",
        true,
        false,
        false,
        false,
        false,
        "Inspect shell, theme, and layout settings."
    ),
    tool!(
        "list_ptys",
        "Lightweight PTY summaries.",
        paged_schema,
        runtime::list_ptys_tool,
        "runtime-observation",
        true,
        false,
        false,
        false,
        true,
        "See which PTYs exist before detail lookup."
    ),
    tool!(
        "get_pty_detail",
        "Detailed PTY state and retained output.",
        pty_id_schema,
        pty::get_pty_detail_tool,
        "runtime-observation",
        true,
        false,
        true,
        false,
        false,
        "Fetch retained PTY detail from the live host."
    ),
    tool!(
        "get_process_tree",
        "OS process tree for a PTY.",
        pty_id_schema,
        pty::get_process_tree_tool,
        "runtime-observation",
        true,
        false,
        true,
        false,
        false,
        "Inspect child processes under a PTY root."
    ),
    tool!(
        "list_fs_watches",
        "Filesystem watcher summaries.",
        paged_schema,
        runtime::list_fs_watches_tool,
        "runtime-observation",
        true,
        false,
        false,
        false,
        true,
        "Check active watch roots."
    ),
    tool!(
        "get_recent_events",
        "Recent runtime events.",
        recent_events_schema,
        runtime::get_recent_events_tool,
        "runtime-observation",
        true,
        false,
        false,
        false,
        true,
        "Inspect recent PTY or fs activity."
    ),
    tool!(
        "get_ai_sessions",
        "Workspace AI session history.",
        ai_sessions_schema,
        runtime::get_ai_sessions_tool,
        "runtime-observation",
        true,
        false,
        false,
        false,
        true,
        "Correlate work with recent Codex or Claude sessions."
    ),
    tool!(
        "create_pty",
        "Create a PTY.",
        create_pty_schema,
        pty::create_pty_tool,
        "pty-control",
        false,
        false,
        true,
        false,
        false,
        "Open a fresh terminal session."
    ),
    tool!(
        "write_pty",
        "Write raw PTY input.",
        write_pty_schema,
        pty::write_pty_tool,
        "pty-control",
        false,
        false,
        true,
        false,
        false,
        "Send data without implicit newline handling."
    ),
    tool!(
        "resize_pty",
        "Resize a PTY.",
        resize_pty_schema,
        pty::resize_pty_tool,
        "pty-control",
        false,
        false,
        true,
        false,
        false,
        "Keep PTY size in sync with UI or host needs."
    ),
    tool!(
        "kill_pty",
        "Terminate a PTY.",
        kill_pty_schema,
        pty::kill_pty_tool,
        "pty-control",
        false,
        true,
        true,
        false,
        false,
        "Stop a PTY after approval."
    ),
    tool!(
        "set_config_fields",
        "Patch config with optional dry-run.",
        set_config_fields_schema,
        runtime::set_config_fields_tool,
        "ui-control",
        false,
        false,
        false,
        true,
        false,
        "Change config safely without rebuilding UI state in MCP."
    ),
    tool!(
        "focus_workspace",
        "Focus a workspace in the UI.",
        focus_workspace_schema,
        ui::focus_workspace_tool,
        "ui-control",
        false,
        false,
        true,
        false,
        false,
        "Switch the active workspace."
    ),
    tool!(
        "create_tab",
        "Create a terminal tab in the UI.",
        create_tab_schema,
        ui::create_tab_tool,
        "ui-control",
        false,
        false,
        true,
        false,
        false,
        "Open a terminal tab on the host."
    ),
    tool!(
        "close_tab",
        "Close a tab in the UI.",
        close_tab_schema,
        ui::close_tab_tool,
        "ui-control",
        false,
        true,
        true,
        false,
        false,
        "Close a terminal tab after approval."
    ),
    tool!(
        "split_pane",
        "Split a pane in the UI.",
        split_pane_schema,
        ui::split_pane_tool,
        "ui-control",
        false,
        false,
        true,
        false,
        false,
        "Create a new terminal pane beside an existing one."
    ),
    tool!(
        "notify_user",
        "Show a toast in the UI.",
        notify_user_schema,
        ui::notify_user_tool,
        "ui-control",
        false,
        false,
        true,
        false,
        false,
        "Push a user-visible notice."
    ),
    tool!(
        "start_task",
        "Start a tracked task.",
        start_task_schema,
        tasks::start_task_tool,
        "task-management",
        false,
        false,
        false,
        false,
        false,
        "Launch Codex or Claude under Mini-Term tracking."
    ),
    tool!(
        "get_task_status",
        "Read tracked task status.",
        task_id_schema,
        tasks::get_task_status_tool,
        "task-management",
        true,
        false,
        false,
        false,
        false,
        "Inspect a task's current state."
    ),
    tool!(
        "list_attention_tasks",
        "List tasks needing attention.",
        empty_schema,
        tasks::list_attention_tasks_tool,
        "task-management",
        true,
        false,
        false,
        false,
        false,
        "Find running, waiting, failed, or review-ready tasks."
    ),
    tool!(
        "resume_session",
        "Resume task session detail.",
        task_id_schema,
        tasks::resume_session_tool,
        "task-management",
        true,
        false,
        false,
        false,
        false,
        "Reconnect to a tracked task."
    ),
    tool!(
        "send_task_input",
        "Send input to a tracked task.",
        send_task_input_schema,
        tasks::send_task_input_tool,
        "task-management",
        false,
        false,
        false,
        false,
        false,
        "Continue an interactive tracked task."
    ),
    tool!(
        "close_task",
        "Terminate a tracked task.",
        close_task_schema,
        tasks::close_task_tool,
        "task-management",
        false,
        true,
        false,
        false,
        false,
        "Close a tracked task after approval."
    ),
    tool!(
        "list_approval_requests",
        "List approvals.",
        approval_list_schema,
        tasks::list_approval_requests_tool,
        "task-management",
        true,
        false,
        false,
        false,
        false,
        "Inspect pending or historical approvals."
    ),
    tool!(
        "decide_approval_request",
        "Approve or reject an approval.",
        approval_decision_schema,
        tasks::decide_approval_request_tool,
        "task-management",
        false,
        false,
        false,
        false,
        false,
        "Drive approval flow forward."
    ),
    tool!(
        "read_file",
        "Read a workspace file.",
        read_file_schema,
        files::read_file_tool,
        "legacy-compat",
        true,
        false,
        false,
        false,
        false,
        "Use the compat read path with workspace validation."
    ),
    tool!(
        "search_files",
        "Search text inside a workspace root.",
        search_files_schema,
        files::search_files_tool,
        "legacy-compat",
        true,
        false,
        false,
        false,
        false,
        "Use the compat search path."
    ),
    tool!(
        "get_git_summary",
        "Git status summary.",
        project_path_schema,
        git::get_git_summary_tool,
        "legacy-compat",
        true,
        false,
        false,
        false,
        false,
        "Use the compat git summary path."
    ),
    tool!(
        "get_diff_for_review",
        "Diff for one file.",
        diff_for_review_schema,
        git::get_diff_for_review_tool,
        "legacy-compat",
        true,
        false,
        false,
        false,
        false,
        "Use the compat review diff path."
    ),
    tool!(
        "write_file",
        "Write a file through approval.",
        write_file_schema,
        tasks::write_file_tool,
        "legacy-compat",
        false,
        true,
        false,
        false,
        false,
        "Use the compat write path when approval semantics matter."
    ),
    tool!(
        "run_workspace_command",
        "Run a workspace command through approval.",
        run_workspace_command_schema,
        tasks::run_workspace_command_tool,
        "legacy-compat",
        false,
        true,
        false,
        false,
        false,
        "Use the compat shell path when approval semantics matter."
    ),
    tool!(
        "list_ai_sessions",
        "Legacy AI session alias.",
        list_ai_sessions_legacy_schema,
        sessions::list_ai_sessions_tool,
        "legacy-compat",
        true,
        false,
        false,
        false,
        false,
        "Use only when explicit project paths are already known."
    ),
];

pub fn find_tool(name: &str) -> Option<&'static ToolDefinition> {
    TOOL_DEFINITIONS.iter().find(|tool| tool.name == name)
}

pub fn tool_definitions() -> Vec<Value> {
    tool_definitions_with_meta()
}

pub fn tool_definitions_with_meta() -> Vec<Value> {
    TOOL_DEFINITIONS
        .iter()
        .map(|tool| {
            json!({
                "name": tool.name,
                "description": tool.description,
                "inputSchema": (tool.input_schema)(),
                "group": tool.group,
                "stability": tool.stability,
                "readOnly": tool.read_only,
                "requiresConfirmation": tool.requires_confirmation,
                "requiresHostConnection": tool.requires_host_connection,
                "supportsDryRun": tool.supports_dry_run,
                "supportsPagination": tool.supports_pagination,
                "whenToUse": tool.when_to_use,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn registry_keeps_expected_order_and_total() {
        let names = TOOL_DEFINITIONS
            .iter()
            .map(|tool| tool.name)
            .collect::<Vec<_>>();
        assert_eq!(TOOL_DEFINITIONS.len(), 37);
        assert_eq!(
            names,
            vec![
                "ping",
                "server_info",
                "list_tools",
                "list_workspaces",
                "get_workspace_context",
                "get_config",
                "list_ptys",
                "get_pty_detail",
                "get_process_tree",
                "list_fs_watches",
                "get_recent_events",
                "get_ai_sessions",
                "create_pty",
                "write_pty",
                "resize_pty",
                "kill_pty",
                "set_config_fields",
                "focus_workspace",
                "create_tab",
                "close_tab",
                "split_pane",
                "notify_user",
                "start_task",
                "get_task_status",
                "list_attention_tasks",
                "resume_session",
                "send_task_input",
                "close_task",
                "list_approval_requests",
                "decide_approval_request",
                "read_file",
                "search_files",
                "get_git_summary",
                "get_diff_for_review",
                "write_file",
                "run_workspace_command",
                "list_ai_sessions",
            ]
        );
    }

    #[test]
    fn registry_group_distribution_matches_contract() {
        let mut counts = BTreeMap::<&str, usize>::new();
        for tool in TOOL_DEFINITIONS {
            *counts.entry(tool.group).or_default() += 1;
        }
        assert_eq!(
            counts,
            BTreeMap::from([
                ("core-runtime", 3),
                ("legacy-compat", 7),
                ("pty-control", 4),
                ("runtime-observation", 9),
                ("task-management", 8),
                ("ui-control", 6),
            ])
        );
    }

    #[test]
    fn registry_flags_match_host_and_approval_surface() {
        let host_backed = TOOL_DEFINITIONS
            .iter()
            .filter(|t| t.requires_host_connection)
            .map(|t| t.name)
            .collect::<Vec<_>>();
        assert_eq!(
            host_backed,
            vec![
                "get_pty_detail",
                "get_process_tree",
                "create_pty",
                "write_pty",
                "resize_pty",
                "kill_pty",
                "focus_workspace",
                "create_tab",
                "close_tab",
                "split_pane",
                "notify_user",
            ]
        );

        let approval_gated = TOOL_DEFINITIONS
            .iter()
            .filter(|t| t.requires_confirmation)
            .map(|t| t.name)
            .collect::<Vec<_>>();
        assert_eq!(
            approval_gated,
            vec![
                "kill_pty",
                "close_tab",
                "close_task",
                "write_file",
                "run_workspace_command"
            ]
        );
        assert!(
            !find_tool("set_config_fields")
                .unwrap()
                .requires_host_connection
        );
    }

    #[test]
    fn registry_exposes_expected_schema_and_metadata() {
        let create_pty = (find_tool("create_pty").unwrap().input_schema)();
        assert_eq!(create_pty["required"], json!(["workspaceId"]));
        assert_eq!(
            create_pty["properties"]["mode"]["enum"],
            json!(["human", "agent", "task"])
        );

        let list_tools = (find_tool("list_tools").unwrap().input_schema)();
        assert!(list_tools["properties"]["group"].is_object());

        let exported = tool_definitions_with_meta();
        let get_pty_detail = exported
            .iter()
            .find(|tool| tool["name"] == "get_pty_detail")
            .unwrap();
        assert_eq!(get_pty_detail["requiresHostConnection"], true);
        assert_eq!(get_pty_detail["group"], "runtime-observation");

        let set_config_fields = exported
            .iter()
            .find(|tool| tool["name"] == "set_config_fields")
            .unwrap();
        assert_eq!(set_config_fields["requiresHostConnection"], false);
        assert_eq!(set_config_fields["supportsDryRun"], true);
    }
}
