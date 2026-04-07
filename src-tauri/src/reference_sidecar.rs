use crate::reference_sidecar_provider::{ProviderContextSnapshot, SidecarProvider};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{self, BufRead, Write};
use std::path::Path;

const SIDECAR_PROTOCOL_VERSION: u32 = 1;
const REFERENCE_AGENT_NAME: &str = "mini-term-claude-reference";
const RESERVED_TOOL_NAMES: &[&str] = &[
    "start_task",
    "spawn_worker",
    "resume_session",
    "send_task_input",
    "close_task",
    "decide_approval_request",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CallOrigin {
    Bootstrap,
    User,
}

#[derive(Debug, Clone)]
enum PendingCall {
    ListWorkspaces {
        origin: CallOrigin,
    },
    WorkspaceContext {
        workspace_id: String,
        origin: CallOrigin,
    },
    GitSummary {
        project_path: String,
        origin: CallOrigin,
    },
    SavePlan {
        markdown: String,
        origin: CallOrigin,
    },
    RecentEvents {
        origin: CallOrigin,
    },
    WriteFile {
        path: String,
        content: String,
        approval_request_id: Option<String>,
    },
}

#[derive(Debug, Clone)]
struct StartMessage {
    protocol_version: u32,
    backend_id: String,
    task_id: String,
    session_id: String,
    title: String,
    cwd: String,
    prompt: String,
}

#[derive(Debug, Clone, Default)]
struct WorkspaceContextSummary {
    instruction_count: usize,
    related_file_count: usize,
    recent_session_count: usize,
}

#[derive(Debug, Clone, Default)]
struct GitSummaryStats {
    repo_count: usize,
    changed_file_count: usize,
}

#[derive(Debug, Clone)]
struct WorkspaceMatch {
    workspace_id: String,
    name: String,
}

#[derive(Debug, Clone)]
struct PendingWriteRequest {
    path: String,
    content: String,
}

#[derive(Debug)]
struct ReferenceSidecarState {
    start: StartMessage,
    provider: SidecarProvider,
    next_call_id: u64,
    pending_calls: BTreeMap<String, PendingCall>,
    workspace_match: Option<WorkspaceMatch>,
    context_summary: WorkspaceContextSummary,
    git_summary: GitSummaryStats,
    recent_event_kinds: Vec<String>,
    pending_write: Option<PendingWriteRequest>,
    last_user_input: Option<String>,
    bootstrap_complete: bool,
    emitted_exit: bool,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum SidecarInboundMessage {
    #[serde(rename = "start")]
    Start {
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
        #[serde(rename = "backendId")]
        backend_id: String,
        #[serde(rename = "taskId")]
        task_id: String,
        #[serde(rename = "sessionId")]
        session_id: String,
        title: String,
        cwd: String,
        prompt: String,
    },
    #[serde(rename = "input")]
    Input {
        #[serde(rename = "taskId")]
        task_id: String,
        input: String,
    },
    #[serde(rename = "tool-result")]
    ToolResult {
        #[serde(rename = "callId")]
        call_id: String,
        result: Value,
    },
    #[serde(rename = "close")]
    Close {
        #[serde(rename = "taskId")]
        task_id: String,
    },
}

impl ReferenceSidecarState {
    fn new(start: StartMessage) -> Result<Self, String> {
        Ok(Self {
            start,
            provider: SidecarProvider::from_env()?,
            next_call_id: 1,
            pending_calls: BTreeMap::new(),
            workspace_match: None,
            context_summary: WorkspaceContextSummary::default(),
            git_summary: GitSummaryStats::default(),
            recent_event_kinds: Vec::new(),
            pending_write: None,
            last_user_input: None,
            bootstrap_complete: false,
            emitted_exit: false,
        })
    }

    fn bootstrap<W: Write>(&mut self, writer: &mut W) -> Result<(), String> {
        self.emit_handshake(writer)?;
        self.emit_started(writer)?;
        self.emit_output(
            writer,
            format!(
                "Mini-Term Claude reference sidecar connected.\nTask: {}\nWorking directory: {}\nPrompt: {}\nProvider: {}\n",
                self.start.title,
                self.start.cwd,
                self.start.prompt,
                self.provider.label()
            ),
        )?;
        self.emit_attention(
            writer,
            "running",
            Some("Collecting workspace context through the Mini-Term broker."),
        )?;
        self.request_list_workspaces(writer, CallOrigin::Bootstrap)
    }

    fn emit_handshake<W: Write>(&self, writer: &mut W) -> Result<(), String> {
        self.write_json_line(
            writer,
            &json!({
                "type": "handshake",
                "taskId": self.start.task_id,
                "handshake": {
                    "backendId": self.start.backend_id,
                    "protocolVersion": SIDECAR_PROTOCOL_VERSION,
                    "agentName": REFERENCE_AGENT_NAME,
                    "agentVersion": env!("CARGO_PKG_VERSION"),
                    "capabilities": {
                        "supportsWorkers": true,
                        "supportsResume": true,
                        "supportsToolCalls": true,
                        "brokeredTools": true,
                        "brokeredApprovals": true,
                        "restrictedToolNames": RESERVED_TOOL_NAMES,
                        "toolCallAuthority": "mini-term",
                        "toolCallNotes": "Reference sidecar tool calls are brokered through Mini-Term.",
                        "approvalFlowNotes": "Approval requests remain in Mini-Term Inbox."
                    }
                }
            }),
        )
    }

    fn emit_started<W: Write>(&self, writer: &mut W) -> Result<(), String> {
        self.write_json_line(
            writer,
            &json!({
                "type": "started",
                "taskId": self.start.task_id,
                "sessionId": self.start.session_id,
            }),
        )
    }

    fn emit_output<W: Write>(
        &self,
        writer: &mut W,
        chunk: impl Into<String>,
    ) -> Result<(), String> {
        self.write_json_line(
            writer,
            &json!({
                "type": "output",
                "taskId": self.start.task_id,
                "chunk": chunk.into(),
            }),
        )
    }

    fn emit_attention<W: Write>(
        &self,
        writer: &mut W,
        state: &str,
        message: Option<&str>,
    ) -> Result<(), String> {
        self.write_json_line(
            writer,
            &json!({
                "type": "attention",
                "taskId": self.start.task_id,
                "state": state,
                "message": message,
            }),
        )
    }

    fn emit_waiting<W: Write>(&self, writer: &mut W) -> Result<(), String> {
        self.emit_attention(
            writer,
            "waiting-input",
            Some(
                "Reference sidecar is ready. Try /status, /review, /plan, /write-demo, /retry-write <request-id>, or /exit.",
            ),
        )
    }

    fn emit_exited<W: Write>(&mut self, writer: &mut W, exit_code: i32) -> Result<(), String> {
        self.emitted_exit = true;
        self.write_json_line(
            writer,
            &json!({
                "type": "exited",
                "taskId": self.start.task_id,
                "exitCode": exit_code,
            }),
        )
    }

    fn request_list_workspaces<W: Write>(
        &mut self,
        writer: &mut W,
        origin: CallOrigin,
    ) -> Result<(), String> {
        self.request_tool_call(
            writer,
            "list_workspaces",
            json!({}),
            PendingCall::ListWorkspaces { origin },
        )
    }

    fn request_workspace_context<W: Write>(
        &mut self,
        writer: &mut W,
        workspace_id: String,
        origin: CallOrigin,
    ) -> Result<(), String> {
        let preset = infer_prompt_preset(&self.start.prompt);
        self.request_tool_call(
            writer,
            "get_workspace_context",
            json!({
                "workspaceId": workspace_id.clone(),
                "preset": preset,
            }),
            PendingCall::WorkspaceContext {
                workspace_id,
                origin,
            },
        )
    }

    fn request_git_summary<W: Write>(
        &mut self,
        writer: &mut W,
        project_path: String,
        origin: CallOrigin,
    ) -> Result<(), String> {
        self.request_tool_call(
            writer,
            "get_git_summary",
            json!({
                "projectPath": project_path.clone(),
            }),
            PendingCall::GitSummary {
                project_path,
                origin,
            },
        )
    }

    fn request_save_plan<W: Write>(
        &mut self,
        writer: &mut W,
        markdown: String,
        origin: CallOrigin,
    ) -> Result<(), String> {
        self.request_tool_call(
            writer,
            "save_task_plan",
            json!({
                "taskId": self.start.task_id,
                "title": "Reference Sidecar Plan",
                "fileName": "reference-sidecar-plan.md",
                "markdown": markdown.clone(),
            }),
            PendingCall::SavePlan { markdown, origin },
        )
    }

    fn request_recent_events<W: Write>(
        &mut self,
        writer: &mut W,
        origin: CallOrigin,
    ) -> Result<(), String> {
        self.request_tool_call(
            writer,
            "get_recent_events",
            json!({
                "limit": 5,
            }),
            PendingCall::RecentEvents { origin },
        )
    }

    fn request_write_file<W: Write>(
        &mut self,
        writer: &mut W,
        path: String,
        content: String,
        approval_request_id: Option<String>,
    ) -> Result<(), String> {
        let mut arguments = json!({
            "path": path.clone(),
            "content": content.clone(),
        });
        if let Some(request_id) = approval_request_id.clone() {
            arguments["approvalRequestId"] = Value::String(request_id);
        }
        self.request_tool_call(
            writer,
            "write_file",
            arguments,
            PendingCall::WriteFile {
                path,
                content,
                approval_request_id,
            },
        )
    }

    fn request_tool_call<W: Write>(
        &mut self,
        writer: &mut W,
        tool_name: &str,
        arguments: Value,
        pending: PendingCall,
    ) -> Result<(), String> {
        let call_id = format!("call-{}", self.next_call_id);
        self.next_call_id += 1;
        self.pending_calls.insert(call_id.clone(), pending);
        self.write_json_line(
            writer,
            &json!({
                "type": "tool-call",
                "taskId": self.start.task_id,
                "callId": call_id,
                "toolName": tool_name,
                "arguments": arguments,
            }),
        )
    }

    fn write_json_line<W: Write>(&self, writer: &mut W, value: &Value) -> Result<(), String> {
        serde_json::to_writer(&mut *writer, value).map_err(|err| err.to_string())?;
        writer.write_all(b"\n").map_err(|err| err.to_string())?;
        writer.flush().map_err(|err| err.to_string())
    }

    fn handle_input<W: Write>(&mut self, writer: &mut W, input: &str) -> Result<bool, String> {
        let trimmed = input.trim();
        self.last_user_input = (!trimmed.is_empty()).then(|| trimmed.to_string());
        if trimmed.is_empty() {
            self.emit_output(
                writer,
                "Reference sidecar received an empty input. Use /status, /review, /plan, /write-demo, or /exit.\n",
            )?;
            self.emit_waiting(writer)?;
            return Ok(true);
        }

        if matches_ignore_ascii_case(trimmed, &["/exit", "exit", "quit", "/quit"]) {
            self.emit_output(writer, "Reference sidecar exiting on user request.\n")?;
            self.emit_exited(writer, 0)?;
            return Ok(false);
        }

        if matches_ignore_ascii_case(trimmed, &["/help", "help"]) {
            self.emit_output(writer, format!("{}\n", command_help_text()))?;
            self.emit_waiting(writer)?;
            return Ok(true);
        }

        if matches_ignore_ascii_case(trimmed, &["/status", "status"]) {
            self.emit_attention(
                writer,
                "running",
                Some("Collecting recent Mini-Term runtime events."),
            )?;
            self.request_recent_events(writer, CallOrigin::User)?;
            return Ok(true);
        }

        if matches_ignore_ascii_case(trimmed, &["/review", "review"]) {
            self.emit_attention(
                writer,
                "running",
                Some("Refreshing workspace context and git summary through Mini-Term."),
            )?;
            if let Some(workspace_match) = self.workspace_match.clone() {
                self.request_workspace_context(
                    writer,
                    workspace_match.workspace_id,
                    CallOrigin::User,
                )?;
            } else {
                self.request_list_workspaces(writer, CallOrigin::User)?;
            }
            return Ok(true);
        }

        if matches_ignore_ascii_case(trimmed, &["/plan", "plan"]) {
            self.emit_attention(
                writer,
                "running",
                Some("Saving an updated task plan artifact."),
            )?;
            let markdown = self.build_plan_markdown(Some(trimmed));
            self.request_save_plan(writer, markdown, CallOrigin::User)?;
            return Ok(true);
        }

        if let Some(rest) = strip_command_prefix(trimmed, "/write-demo") {
            let path = resolve_write_demo_path(&self.start.cwd, rest);
            let content = self.build_write_demo_content(trimmed);
            self.pending_write = Some(PendingWriteRequest {
                path: path.clone(),
                content: content.clone(),
            });
            self.emit_attention(
                writer,
                "running",
                Some("Requesting write_file through Mini-Term. Approval may be required."),
            )?;
            self.request_write_file(writer, path, content, None)?;
            return Ok(true);
        }

        if let Some(rest) = strip_command_prefix(trimmed, "/retry-write") {
            let request_id = rest.trim();
            if request_id.is_empty() {
                self.emit_output(writer, "Usage: /retry-write <approval-request-id>\n")?;
                self.emit_waiting(writer)?;
                return Ok(true);
            }
            let Some(pending_write) = self.pending_write.clone() else {
                self.emit_output(
                    writer,
                    "There is no pending write approval to retry. Run /write-demo first.\n",
                )?;
                self.emit_waiting(writer)?;
                return Ok(true);
            };
            self.emit_attention(
                writer,
                "running",
                Some("Retrying write_file with an approved approval request id."),
            )?;
            self.request_write_file(
                writer,
                pending_write.path,
                pending_write.content,
                Some(request_id.to_string()),
            )?;
            return Ok(true);
        }

        self.emit_output(
            writer,
            match self
                .provider
                .generate_reply(&self.build_provider_context_snapshot(), trimmed)
            {
                Ok(reply) => format!("[{}]\n{}\n", reply.provider_label, reply.message),
                Err(error) => format!(
                    "Provider {} failed: {error}\n{}\n",
                    self.provider.label(),
                    command_help_text()
                ),
            },
        )?;
        self.emit_waiting(writer)?;
        Ok(true)
    }

    fn handle_tool_result<W: Write>(
        &mut self,
        writer: &mut W,
        call_id: &str,
        result: Value,
    ) -> Result<(), String> {
        let Some(pending) = self.pending_calls.remove(call_id) else {
            self.emit_output(
                writer,
                format!("Ignoring tool result for unknown call id {call_id}.\n"),
            )?;
            return Ok(());
        };

        match pending {
            PendingCall::ListWorkspaces { origin } => {
                self.handle_list_workspaces_result(writer, result, origin)
            }
            PendingCall::WorkspaceContext {
                workspace_id,
                origin,
            } => self.handle_workspace_context_result(writer, result, &workspace_id, origin),
            PendingCall::GitSummary {
                project_path,
                origin,
            } => self.handle_git_summary_result(writer, result, &project_path, origin),
            PendingCall::SavePlan { markdown, origin } => {
                self.handle_save_plan_result(writer, result, markdown, origin)
            }
            PendingCall::RecentEvents { origin } => {
                self.handle_recent_events_result(writer, result, origin)
            }
            PendingCall::WriteFile {
                path,
                content,
                approval_request_id,
            } => self.handle_write_file_result(
                writer,
                result,
                &path,
                &content,
                approval_request_id.as_deref(),
            ),
        }
    }

    fn handle_list_workspaces_result<W: Write>(
        &mut self,
        writer: &mut W,
        result: Value,
        origin: CallOrigin,
    ) -> Result<(), String> {
        let Some(data) = tool_result_data(&result) else {
            self.emit_output(
                writer,
                format!(
                    "list_workspaces failed: {}\n",
                    tool_result_error_message(&result)
                ),
            )?;
            return self.after_workspace_lookup(writer, origin);
        };

        if let Some(workspace_match) = match_workspace_from_result(data, &self.start.cwd) {
            self.workspace_match = Some(workspace_match.clone());
            self.emit_output(
                writer,
                format!(
                    "Matched workspace: {} ({})\n",
                    workspace_match.name, workspace_match.workspace_id
                ),
            )?;
            self.request_workspace_context(writer, workspace_match.workspace_id, origin)?;
            return Ok(());
        }

        self.emit_output(
            writer,
            "No configured workspace matched the current directory. The reference sidecar will continue with limited context.\n",
        )?;
        self.after_workspace_lookup(writer, origin)
    }

    fn after_workspace_lookup<W: Write>(
        &mut self,
        writer: &mut W,
        origin: CallOrigin,
    ) -> Result<(), String> {
        match origin {
            CallOrigin::Bootstrap => {
                let markdown = self.build_plan_markdown(None);
                self.request_save_plan(writer, markdown, CallOrigin::Bootstrap)
            }
            CallOrigin::User => self.emit_waiting(writer),
        }
    }

    fn handle_workspace_context_result<W: Write>(
        &mut self,
        writer: &mut W,
        result: Value,
        workspace_id: &str,
        origin: CallOrigin,
    ) -> Result<(), String> {
        if let Some(data) = tool_result_data(&result) {
            self.context_summary.instruction_count = count_items(data.get("instructions"));
            self.context_summary.related_file_count = count_items(data.get("relatedFiles"));
            self.context_summary.recent_session_count = count_items(data.get("recentSessions"));
            if let Some(workspace) = data.get("workspace") {
                let name = workspace
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("workspace")
                    .to_string();
                self.workspace_match = Some(WorkspaceMatch {
                    workspace_id: workspace_id.to_string(),
                    name,
                });
            }
            self.emit_output(
                writer,
                format!(
                    "Workspace context loaded. Instructions: {}, related files: {}, recent sessions: {}.\n",
                    self.context_summary.instruction_count,
                    self.context_summary.related_file_count,
                    self.context_summary.recent_session_count
                ),
            )?;
        } else {
            self.emit_output(
                writer,
                format!(
                    "get_workspace_context failed: {}\n",
                    tool_result_error_message(&result)
                ),
            )?;
        }

        self.request_git_summary(writer, self.start.cwd.clone(), origin)
    }

    fn handle_git_summary_result<W: Write>(
        &mut self,
        writer: &mut W,
        result: Value,
        _project_path: &str,
        origin: CallOrigin,
    ) -> Result<(), String> {
        if let Some(data) = tool_result_data(&result) {
            self.git_summary.repo_count =
                data.get("repoCount").and_then(Value::as_u64).unwrap_or(0) as usize;
            self.git_summary.changed_file_count = count_items(data.get("changedFiles"));
            self.emit_output(
                writer,
                format!(
                    "Git summary loaded. Repositories: {}, changed files: {}.\n",
                    self.git_summary.repo_count, self.git_summary.changed_file_count
                ),
            )?;
        } else {
            self.emit_output(
                writer,
                format!(
                    "get_git_summary failed: {}\n",
                    tool_result_error_message(&result)
                ),
            )?;
        }

        match origin {
            CallOrigin::Bootstrap => {
                let markdown = self.build_plan_markdown(None);
                self.request_save_plan(writer, markdown, CallOrigin::Bootstrap)
            }
            CallOrigin::User => self.emit_waiting(writer),
        }
    }

    fn handle_save_plan_result<W: Write>(
        &mut self,
        writer: &mut W,
        result: Value,
        _markdown: String,
        origin: CallOrigin,
    ) -> Result<(), String> {
        if tool_result_ok(&result) {
            self.emit_output(
                writer,
                "Saved a task plan artifact through Mini-Term. Open Plan Document in the task details to inspect it.\n",
            )?;
        } else {
            self.emit_output(
                writer,
                format!(
                    "save_task_plan failed: {}\n",
                    tool_result_error_message(&result)
                ),
            )?;
        }

        match origin {
            CallOrigin::Bootstrap => self.request_recent_events(writer, CallOrigin::Bootstrap),
            CallOrigin::User => self.emit_waiting(writer),
        }
    }

    fn handle_recent_events_result<W: Write>(
        &mut self,
        writer: &mut W,
        result: Value,
        origin: CallOrigin,
    ) -> Result<(), String> {
        self.recent_event_kinds.clear();
        if let Some(data) = tool_result_data(&result) {
            if let Some(items) = data.get("items").and_then(Value::as_array) {
                self.recent_event_kinds = items
                    .iter()
                    .filter_map(|item| item.get("kind").and_then(Value::as_str))
                    .take(5)
                    .map(str::to_string)
                    .collect();
                self.emit_output(
                    writer,
                    format!(
                        "Recent runtime events: {}\n",
                        format_event_kinds(&self.recent_event_kinds)
                    ),
                )?;
            }
        } else {
            self.emit_output(
                writer,
                format!(
                    "get_recent_events failed: {}\n",
                    tool_result_error_message(&result)
                ),
            )?;
        }

        match origin {
            CallOrigin::Bootstrap => self.finish_bootstrap(writer),
            CallOrigin::User => self.emit_waiting(writer),
        }
    }

    fn handle_write_file_result<W: Write>(
        &mut self,
        writer: &mut W,
        result: Value,
        path: &str,
        content: &str,
        approval_request_id: Option<&str>,
    ) -> Result<(), String> {
        if tool_result_ok(&result) {
            self.pending_write = None;
            self.emit_output(
                writer,
                format!(
                    "write_file completed successfully.\nPath: {path}\nBytes: {}\n",
                    content.len()
                ),
            )?;
            self.emit_waiting(writer)?;
            return Ok(());
        }

        if tool_result_approval_required(&result) {
            self.pending_write = Some(PendingWriteRequest {
                path: path.to_string(),
                content: content.to_string(),
            });
            let request_id = tool_result_request_id(&result).unwrap_or("unknown");
            let retry_hint = if approval_request_id.is_some() {
                "Mini-Term still reports approval pending. Approve the latest request in Inbox and retry again."
            } else {
                "Approve the request in Mini-Term Inbox, then run /retry-write <request-id>."
            };
            self.emit_output(
                writer,
                format!(
                    "write_file requires approval.\nRequest: {request_id}\nPath: {path}\n{retry_hint}\n"
                ),
            )?;
            self.emit_waiting(writer)?;
            return Ok(());
        }

        self.emit_output(
            writer,
            format!(
                "write_file failed: {}\n",
                tool_result_error_message(&result)
            ),
        )?;
        self.emit_waiting(writer)
    }

    fn finish_bootstrap<W: Write>(&mut self, writer: &mut W) -> Result<(), String> {
        if self.bootstrap_complete {
            return self.emit_waiting(writer);
        }
        self.bootstrap_complete = true;
        self.emit_output(
            writer,
            format!(
                "Reference sidecar bootstrap complete.\nProvider: {}\n{}\n",
                self.provider.label(),
                command_help_text()
            ),
        )?;
        self.emit_waiting(writer)
    }

    fn build_provider_context_snapshot(&self) -> ProviderContextSnapshot {
        ProviderContextSnapshot {
            task_title: self.start.title.clone(),
            cwd: self.start.cwd.clone(),
            original_prompt: self.start.prompt.clone(),
            inferred_preset: infer_prompt_preset(&self.start.prompt).to_string(),
            workspace_name: self
                .workspace_match
                .as_ref()
                .map(|workspace| workspace.name.clone()),
            workspace_id: self
                .workspace_match
                .as_ref()
                .map(|workspace| workspace.workspace_id.clone()),
            instruction_count: self.context_summary.instruction_count,
            related_file_count: self.context_summary.related_file_count,
            recent_session_count: self.context_summary.recent_session_count,
            repo_count: self.git_summary.repo_count,
            changed_file_count: self.git_summary.changed_file_count,
            recent_event_kinds: self.recent_event_kinds.clone(),
        }
    }

    fn build_plan_markdown(&self, last_instruction: Option<&str>) -> String {
        let workspace_line = self
            .workspace_match
            .as_ref()
            .map(|workspace| format!("{} ({})", workspace.name, workspace.workspace_id))
            .unwrap_or_else(|| "Unresolved from current directory".to_string());
        let recent_events = if self.recent_event_kinds.is_empty() {
            "No runtime events captured yet".to_string()
        } else {
            self.recent_event_kinds.join(", ")
        };
        let last_input = last_instruction
            .or(self.last_user_input.as_deref())
            .unwrap_or("None");

        format!(
            "# Reference Sidecar Plan\n\n## Task\n- title: {}\n- prompt: {}\n- cwd: {}\n- inferred preset: {}\n- provider: {}\n\n## Workspace\n- resolved workspace: {}\n- instructions: {}\n- related files: {}\n- recent sessions: {}\n\n## Git\n- repositories: {}\n- changed files: {}\n\n## Runtime\n- recent events: {}\n- last user input: {}\n\n## Next Steps\n1. Review workspace instructions and related files in Mini-Term.\n2. Inspect the latest runtime events and git changes before making edits.\n3. Use `/write-demo` to exercise Mini-Term approval flow or send a concrete follow-up request.\n",
            self.start.title,
            self.start.prompt,
            self.start.cwd,
            infer_prompt_preset(&self.start.prompt),
            self.provider.label(),
            workspace_line,
            self.context_summary.instruction_count,
            self.context_summary.related_file_count,
            self.context_summary.recent_session_count,
            self.git_summary.repo_count,
            self.git_summary.changed_file_count,
            recent_events,
            last_input
        )
    }

    fn build_write_demo_content(&self, trigger: &str) -> String {
        format!(
            "# Mini-Term Reference Sidecar Write Demo\n\n- task: {}\n- cwd: {}\n- trigger: {}\n- prompt: {}\n- provider: {}\n",
            self.start.title,
            self.start.cwd,
            trigger,
            self.start.prompt,
            self.provider.label()
        )
    }
}

pub fn run_stdio_reference_sidecar() -> Result<(), String> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let stderr = io::stderr();
    run_reference_sidecar(stdin.lock(), stdout.lock(), stderr.lock())
}

fn run_reference_sidecar<R: BufRead, W: Write, E: Write>(
    mut reader: R,
    mut writer: W,
    mut stderr: E,
) -> Result<(), String> {
    let start = read_start_message(&mut reader)?;
    if start.protocol_version != SIDECAR_PROTOCOL_VERSION {
        return Err(format!(
            "unsupported sidecar protocol version {}",
            start.protocol_version
        ));
    }

    let mut state = ReferenceSidecarState::new(start)?;
    state.bootstrap(&mut writer)?;

    let mut buffer = String::new();
    loop {
        buffer.clear();
        let read = reader
            .read_line(&mut buffer)
            .map_err(|err| err.to_string())?;
        if read == 0 {
            break;
        }
        let line = buffer.trim();
        if line.is_empty() {
            continue;
        }

        let message = match serde_json::from_str::<SidecarInboundMessage>(line) {
            Ok(message) => message,
            Err(err) => {
                let _ = writeln!(stderr, "reference sidecar ignored invalid message: {err}");
                continue;
            }
        };

        let keep_running = match message {
            SidecarInboundMessage::Start { .. } => {
                let _ = writeln!(stderr, "reference sidecar ignored duplicate start envelope");
                true
            }
            SidecarInboundMessage::Input { task_id, input } => {
                if task_id != state.start.task_id {
                    let _ = writeln!(
                        stderr,
                        "reference sidecar ignored input for unexpected task {task_id}"
                    );
                    true
                } else {
                    state.handle_input(&mut writer, &input)?
                }
            }
            SidecarInboundMessage::ToolResult { call_id, result } => {
                state.handle_tool_result(&mut writer, &call_id, result)?;
                true
            }
            SidecarInboundMessage::Close { task_id } => {
                if task_id == state.start.task_id {
                    state.emit_output(
                        &mut writer,
                        "Reference sidecar received a close request.\n",
                    )?;
                    state.emit_exited(&mut writer, 0)?;
                    false
                } else {
                    let _ = writeln!(
                        stderr,
                        "reference sidecar ignored close for unexpected task {task_id}"
                    );
                    true
                }
            }
        };

        if !keep_running {
            break;
        }
    }

    if !state.emitted_exit {
        let _ = writeln!(
            stderr,
            "reference sidecar stdin closed without an explicit exit envelope"
        );
    }
    Ok(())
}

fn read_start_message<R: BufRead>(reader: &mut R) -> Result<StartMessage, String> {
    let mut buffer = String::new();
    loop {
        buffer.clear();
        let read = reader
            .read_line(&mut buffer)
            .map_err(|err| err.to_string())?;
        if read == 0 {
            return Err("sidecar stdin closed before start envelope".to_string());
        }
        let line = buffer.trim();
        if line.is_empty() {
            continue;
        }
        return match serde_json::from_str::<SidecarInboundMessage>(line)
            .map_err(|err| err.to_string())?
        {
            SidecarInboundMessage::Start {
                protocol_version,
                backend_id,
                task_id,
                session_id,
                title,
                cwd,
                prompt,
            } => Ok(StartMessage {
                protocol_version,
                backend_id,
                task_id,
                session_id,
                title,
                cwd,
                prompt,
            }),
            _ => Err("expected start envelope as the first sidecar message".to_string()),
        };
    }
}

fn infer_prompt_preset(prompt: &str) -> &'static str {
    let normalized = prompt.to_ascii_lowercase();
    if normalized.contains("review") || prompt.contains("评审") || prompt.contains("审查") {
        "review"
    } else if normalized.contains("light") {
        "light"
    } else {
        "standard"
    }
}

fn command_help_text() -> &'static str {
    "Commands: /status, /review, /plan, /write-demo [path], /retry-write <request-id>, /exit"
}

fn matches_ignore_ascii_case(input: &str, expected: &[&str]) -> bool {
    expected
        .iter()
        .any(|candidate| input.eq_ignore_ascii_case(candidate))
}

fn strip_command_prefix<'a>(input: &'a str, command: &str) -> Option<&'a str> {
    let lower = input.to_ascii_lowercase();
    let command_lower = command.to_ascii_lowercase();
    if lower == command_lower {
        Some("")
    } else if lower.starts_with(&(command_lower + " ")) {
        Some(&input[command.len()..])
    } else {
        None
    }
}

fn count_items(value: Option<&Value>) -> usize {
    value.and_then(Value::as_array).map_or(0, Vec::len)
}

fn tool_result_ok(result: &Value) -> bool {
    result.get("ok").and_then(Value::as_bool).unwrap_or(false)
}

fn tool_result_approval_required(result: &Value) -> bool {
    result
        .get("approvalRequired")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn tool_result_data(result: &Value) -> Option<&Value> {
    if tool_result_ok(result) {
        result.get("data")
    } else {
        None
    }
}

fn tool_result_error_message(result: &Value) -> String {
    result
        .get("error")
        .and_then(|value| value.get("message"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            result
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| "unknown error".to_string())
}

fn tool_result_request_id(result: &Value) -> Option<&str> {
    result
        .get("request")
        .and_then(|value| value.get("requestId"))
        .and_then(Value::as_str)
}

fn match_workspace_from_result(data: &Value, cwd: &str) -> Option<WorkspaceMatch> {
    let workspaces = data.as_array()?;
    let normalized_cwd = normalize_path(cwd);
    let mut best_match: Option<(usize, WorkspaceMatch)> = None;

    for workspace in workspaces {
        let workspace_id = workspace
            .get("workspaceId")
            .and_then(Value::as_str)?
            .to_string();
        let name = workspace
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("workspace")
            .to_string();
        let mut roots = workspace
            .get("rootPaths")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect::<Vec<_>>();
        if let Some(primary_root) = workspace.get("primaryRootPath").and_then(Value::as_str) {
            if !roots.iter().any(|root| root == primary_root) {
                roots.push(primary_root.to_string());
            }
        }

        for root in roots {
            let normalized_root = normalize_path(&root);
            if path_is_within(&normalized_cwd, &normalized_root) {
                let candidate = WorkspaceMatch {
                    workspace_id: workspace_id.clone(),
                    name: name.clone(),
                };
                let score = normalized_root.len();
                if best_match
                    .as_ref()
                    .map(|(best_score, _)| score > *best_score)
                    .unwrap_or(true)
                {
                    best_match = Some((score, candidate));
                }
            }
        }
    }

    best_match
        .map(|(_, workspace_match)| workspace_match)
        .or_else(|| {
            workspaces.first().and_then(|workspace| {
                Some(WorkspaceMatch {
                    workspace_id: workspace.get("workspaceId")?.as_str()?.to_string(),
                    name: workspace
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("workspace")
                        .to_string(),
                })
            })
        })
}

fn normalize_path(path: &str) -> String {
    path.replace('\\', "/")
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

fn path_is_within(path: &str, root: &str) -> bool {
    path == root || path.starts_with(&format!("{root}/"))
}

fn resolve_write_demo_path(cwd: &str, raw: &str) -> String {
    let trimmed = raw.trim();
    let candidate = if trimmed.is_empty() {
        Path::new(cwd).join("mini-term-sidecar-note.md")
    } else {
        let requested = Path::new(trimmed);
        if requested.is_absolute() {
            requested.to_path_buf()
        } else {
            Path::new(cwd).join(requested)
        }
    };
    candidate.to_string_lossy().replace('\\', "/")
}

fn format_event_kinds(kinds: &[String]) -> String {
    if kinds.is_empty() {
        "none".to_string()
    } else {
        kinds.join(", ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::io::Cursor;
    use std::sync::{Mutex, OnceLock};

    struct EnvVarGuard {
        key: &'static str,
        previous: Option<String>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let previous = std::env::var(key).ok();
            std::env::set_var(key, value);
            Self { key, previous }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            if let Some(previous) = &self.previous {
                std::env::set_var(self.key, previous);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn bootstrap_flow_emits_handshake_tool_calls_and_waiting_state() {
        let _guard = env_lock().lock().unwrap();
        let _provider = EnvVarGuard::set("MINI_TERM_SIDECAR_PROVIDER", "reference");
        let input = concat!(
            "{\"type\":\"start\",\"protocolVersion\":1,\"backendId\":\"claude-sidecar\",\"taskId\":\"task-1\",\"sessionId\":\"session-1\",\"title\":\"Reference Task\",\"cwd\":\"D:/code/mini-term\",\"prompt\":\"Review the workspace\"}\n",
            "{\"type\":\"tool-result\",\"callId\":\"call-1\",\"result\":{\"ok\":true,\"data\":[{\"workspaceId\":\"workspace-1\",\"name\":\"mini-term\",\"rootPaths\":[\"D:/code/mini-term\"],\"primaryRootPath\":\"D:/code/mini-term\"}]}}\n",
            "{\"type\":\"tool-result\",\"callId\":\"call-2\",\"result\":{\"ok\":true,\"data\":{\"workspace\":{\"workspaceId\":\"workspace-1\",\"name\":\"mini-term\"},\"instructions\":[{},{}],\"relatedFiles\":[{}],\"recentSessions\":[{}]}}}\n",
            "{\"type\":\"tool-result\",\"callId\":\"call-3\",\"result\":{\"ok\":true,\"data\":{\"repoCount\":1,\"changedFiles\":[{\"path\":\"src/main.ts\"},{\"path\":\"src/lib.rs\"}]}}}\n",
            "{\"type\":\"tool-result\",\"callId\":\"call-4\",\"result\":{\"ok\":true,\"data\":{\"summary\":{\"taskId\":\"task-1\"}}}}\n",
            "{\"type\":\"tool-result\",\"callId\":\"call-5\",\"result\":{\"ok\":true,\"data\":{\"items\":[{\"kind\":\"task-started\"},{\"kind\":\"task-sidecar-handshake-succeeded\"}]}}}\n"
        );
        let mut output = Vec::new();
        let mut errors = Vec::new();

        run_reference_sidecar(Cursor::new(input.as_bytes()), &mut output, &mut errors).unwrap();

        let messages = parse_output_lines(&output);
        assert_eq!(messages[0]["type"], "handshake");
        assert_eq!(messages[1]["type"], "started");
        assert_eq!(messages[4]["type"], "tool-call");
        assert_eq!(messages[4]["toolName"], "list_workspaces");
        assert_eq!(messages[6]["toolName"], "get_workspace_context");
        assert_eq!(messages[8]["toolName"], "get_git_summary");
        assert_eq!(messages[10]["toolName"], "save_task_plan");
        assert_eq!(messages[12]["toolName"], "get_recent_events");

        let chunks = output_chunks(&messages);
        assert!(chunks
            .iter()
            .any(|chunk| chunk.contains("Matched workspace: mini-term")));
        assert!(chunks
            .iter()
            .any(|chunk| chunk.contains("Saved a task plan artifact")));
        assert!(chunks
            .iter()
            .any(|chunk| chunk.contains("Reference sidecar bootstrap complete")));
        assert_eq!(messages.last().unwrap()["type"], "attention");
        assert_eq!(messages.last().unwrap()["state"], "waiting-input");
    }

    #[test]
    fn exit_command_emits_exited_event() {
        let _guard = env_lock().lock().unwrap();
        let _provider = EnvVarGuard::set("MINI_TERM_SIDECAR_PROVIDER", "reference");
        let input = concat!(
            "{\"type\":\"start\",\"protocolVersion\":1,\"backendId\":\"claude-sidecar\",\"taskId\":\"task-1\",\"sessionId\":\"session-1\",\"title\":\"Reference Task\",\"cwd\":\"D:/code/mini-term\",\"prompt\":\"Inspect workspace\"}\n",
            "{\"type\":\"input\",\"taskId\":\"task-1\",\"input\":\"/exit\"}\n"
        );
        let mut output = Vec::new();
        let mut errors = Vec::new();

        run_reference_sidecar(Cursor::new(input.as_bytes()), &mut output, &mut errors).unwrap();

        let messages = parse_output_lines(&output);
        assert!(messages
            .iter()
            .any(|message| { message["type"] == "exited" && message["exitCode"] == 0 }));
    }

    #[test]
    fn free_form_input_uses_reference_provider_reply() {
        let _guard = env_lock().lock().unwrap();
        let _provider = EnvVarGuard::set("MINI_TERM_SIDECAR_PROVIDER", "reference");
        let input = concat!(
            "{\"type\":\"start\",\"protocolVersion\":1,\"backendId\":\"claude-sidecar\",\"taskId\":\"task-1\",\"sessionId\":\"session-1\",\"title\":\"Reference Task\",\"cwd\":\"D:/code/mini-term\",\"prompt\":\"Inspect workspace\"}\n",
            "{\"type\":\"input\",\"taskId\":\"task-1\",\"input\":\"Summarize the current state\"}\n",
            "{\"type\":\"input\",\"taskId\":\"task-1\",\"input\":\"/exit\"}\n"
        );
        let mut output = Vec::new();
        let mut errors = Vec::new();

        run_reference_sidecar(Cursor::new(input.as_bytes()), &mut output, &mut errors).unwrap();

        let messages = parse_output_lines(&output);
        let chunks = output_chunks(&messages);
        assert!(chunks.iter().any(|chunk| chunk.contains("[reference]")));
        assert!(chunks
            .iter()
            .any(|chunk| chunk.contains("Reference provider reply")));
        assert!(chunks.iter().any(|chunk| {
            chunk.contains(
            "Use /review to refresh Mini-Term context or /plan to persist an updated plan document."
        )
        }));
    }

    fn parse_output_lines(bytes: &[u8]) -> Vec<Value> {
        String::from_utf8(bytes.to_vec())
            .unwrap()
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect()
    }

    fn output_chunks(messages: &[Value]) -> Vec<String> {
        messages
            .iter()
            .filter(|message| message["type"] == "output")
            .filter_map(|message| message["chunk"].as_str().map(str::to_string))
            .collect()
    }
}
