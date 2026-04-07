use crate::agent_core::{
    data_dir::config_path,
    models::{TaskContextPreset, TaskTarget},
    task_store::get_task_detail,
};
use crate::config::{load_config_from_path, AppConfig};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const MCP_SERVER_NAME: &str = "mini-term";
const MCP_INSTALL_STARTUP_TIMEOUT_SEC: i64 = 60;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum AgentClientType {
    Codex,
    Claude,
    Cursor,
    GenericMcp,
}

impl AgentClientType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
            Self::Cursor => "cursor",
            Self::GenericMcp => "generic-mcp",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PromptStyle {
    Minimal,
    Balanced,
    Strict,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InjectionTargets {
    Codex,
    Claude,
    Both,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ToolUsagePolicy {
    #[serde(default)]
    pub preferred_sequence: Vec<String>,
    #[serde(default)]
    pub approval_tools: Vec<String>,
    #[serde(default)]
    pub read_only_tools: Vec<String>,
    #[serde(default)]
    pub task_tools: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPolicyProfile {
    pub id: String,
    pub client_type: AgentClientType,
    pub enabled: bool,
    pub display_name: String,
    #[serde(default)]
    pub platform_prompt_template: String,
    #[serde(default)]
    pub tool_policy_prompt_template: String,
    #[serde(default)]
    pub client_wrapper_prompt_template: String,
    pub system_prompt_template: String,
    pub skill_template: String,
    pub mcp_instructions_template: String,
    pub tool_usage_policy: ToolUsagePolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedPromptSections {
    pub platform_prompt: String,
    pub tool_policy_prompt: String,
    pub client_wrapper_prompt: String,
    pub task_preset_prompt: String,
    pub workspace_override_prompt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePolicyOverride {
    pub workspace_id: String,
    pub profile_id: String,
    pub enabled_tools: Vec<String>,
    pub extra_instructions: String,
    pub prompt_style: PromptStyle,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetPolicyTemplates {
    pub light: String,
    pub standard: String,
    pub review: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TaskInjectionProfileBindings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TaskInjectionTargetPresetPolicies {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex: Option<PresetPolicyTemplates>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude: Option<PresetPolicyTemplates>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInjectionPolicy {
    pub enabled: bool,
    pub targets: InjectionTargets,
    pub preset_policies: PresetPolicyTemplates,
    pub approval_hints: bool,
    pub review_hints: bool,
    #[serde(default)]
    pub profile_bindings: TaskInjectionProfileBindings,
    #[serde(default)]
    pub target_preset_policies: TaskInjectionTargetPresetPolicies,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPoliciesConfig {
    #[serde(default = "default_profiles")]
    pub profiles: Vec<AgentPolicyProfile>,
    #[serde(default)]
    pub workspace_overrides: Vec<WorkspacePolicyOverride>,
    #[serde(default = "default_task_injection")]
    pub task_injection: TaskInjectionPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPolicyExportBundle {
    pub client_type: AgentClientType,
    pub profile: AgentPolicyProfile,
    pub workspace_id: Option<String>,
    pub workspace_name: Option<String>,
    pub platform_prompt: String,
    pub tool_policy_prompt: String,
    pub client_wrapper_prompt: String,
    pub task_preset_templates: PresetPolicyTemplates,
    pub system_prompt: String,
    pub skill_text: String,
    pub mcp_instructions: String,
    pub workspace_override_prompt: String,
    pub effective_policy_summary: String,
    pub mcp_launch: McpLaunchInfo,
    pub mcp_config_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpLaunchInfo {
    pub status: String,
    pub transport: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpClientInstallFileResult {
    pub path: String,
    pub kind: String,
    pub created: bool,
    pub updated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpClientInstallResult {
    pub client_type: AgentClientType,
    pub server_name: String,
    pub files: Vec<McpClientInstallFileResult>,
    pub launch: McpLaunchInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInjectionPreview {
    pub profile_id: String,
    pub client_type: AgentClientType,
    pub preset: TaskContextPreset,
    pub workspace_id: String,
    pub workspace_name: String,
    pub policy_summary: String,
    pub rendered_sections: RenderedPromptSections,
    pub final_prompt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEffectivePolicy {
    pub task_id: String,
    pub injection_profile_id: Option<String>,
    pub injection_preset: Option<TaskContextPreset>,
    pub policy_summary: Option<String>,
    pub is_injected: bool,
}

fn default_codex_profile() -> AgentPolicyProfile {
    AgentPolicyProfile {
        id: "codex-default".into(),
        client_type: AgentClientType::Codex,
        enabled: true,
        display_name: "Codex Default".into(),
        platform_prompt_template: r#"## Role
You are an engineering agent operating through Mini-Term.
Mini-Term is both:
- a local desktop workspace host
- the MCP control plane for context, tracked tasks, approvals, and review handoff

## What Mini-Term Controls
- workspace discovery
- structured workspace context
- tracked task execution
- approval-gated actions
- Git review handoff

## Hard Constraints
1. Before making assumptions about project structure, load workspace context.
2. When local facts matter, prefer Mini-Term tools over speculation.
3. If a tool returns `approvalRequired`, stop and wait.
4. If a tracked task exits with changes, inspect review context before concluding."#.into(),
        tool_policy_prompt_template: r#"## Tool Groups
- Core runtime: ping, server_info, list_tools
- Runtime observation: workspace/context, config, PTY summaries/details, events, AI sessions
- PTY control: create/write/resize/kill PTY
- UI control: focus workspace, create/close tabs, split panes, notices, config patches
- Task tools: {task_tools}
- Legacy compat: {read_only_tools}
- Approval-gated: {approval_tools}

## Preferred Sequence
{tool_sequence}

## When To Use Runtime Observation
- Use `list_workspaces` before choosing a project root.
- Use `get_workspace_context` before planning or editing.
- Use `list_ptys` first, then `get_pty_detail` / `get_process_tree` when summary data is insufficient.
- Use `get_recent_events` when you need a concise runtime trail.

## When To Use Legacy Compat Tools
- Use `read_file` / `search_files` when implementation details matter.
- Use `get_git_summary` / `get_diff_for_review` when review or change understanding matters.

## When To Use Task Tools
- Use `start_task` when work should be tracked by Mini-Term.
- Use `get_task_status`, `list_attention_tasks`, and `list_approval_requests` to monitor execution and approvals.
- Use `save_task_plan` when a tracked task produces a durable Markdown plan document.
- Use `send_task_input` to continue a live tracked task instead of creating a duplicate.

## When To Stop For Approval
- Never continue a high-risk action after `approvalRequired` until the user approves it in Mini-Term."#.into(),
        client_wrapper_prompt_template: r#"## Client Role
You are Codex operating through Mini-Term.

## How To Work With Mini-Term
- Treat Mini-Term as the operating control plane for this workspace.
- Prefer tracked tasks over ad-hoc shell duplication.
- Keep explanations grounded in Mini-Term task state, Git review, and file inspection results.

## Biases To Correct
- Do not assume local repository state from memory.
- Do not skip review after changes exist.
- Do not bypass approval-gated actions."#.into(),
        system_prompt_template: r#"## Role
You are an engineering agent working through Mini-Term.
Mini-Term is both:
- a local desktop workspace host
- the MCP control plane for context, task tracking, approvals, and review handoff

Current workspace:
- id: {workspace_id}
- name: {workspace_name}
- client: {client_type}
- task target: {target}
- injection preset: {preset}

## Core operating rules
1. Treat Mini-Term as the authoritative source of local workspace state.
2. Before making assumptions about project structure, load workspace context.
3. Prefer Mini-Term MCP tools over speculative reasoning whenever local facts matter.
4. Do not bypass approval-gated actions. If approval is pending, stop and wait.
5. If a tracked task exits with changes, inspect review context before concluding.

## Required workflow
Follow this preferred sequence unless the current step is already satisfied:
{tool_sequence}

## Safety
- Approval-gated tools: {approval_tools}
- Read-only tools: {read_only_tools}
- Task tools: {task_tools}
- Extra instructions: {extra_instructions}"#.into(),
        skill_template: r#"# Mini-Term For Codex

Use Mini-Term as the local runtime hub for workspace context, tracked tasks, approvals, and review handoff.

## Default workflow
1. Call `list_workspaces`.
2. Select the correct workspace.
3. Call `get_workspace_context` before planning or editing.
4. Use `read_file` / `search_files` before inferring implementation details.
5. Use `get_git_summary` or `get_diff_for_review` when review context matters.
6. Use `start_task` for tracked execution when the user wants Codex or Claude to run under Mini-Term control.
7. Poll `get_task_status` or `list_attention_tasks` for progress.
8. Use `send_task_input` to continue a live tracked task instead of creating duplicates.

## Approval rules
- `write_file`, `close_task`, and `run_workspace_command` are approval-gated.
- If a call returns `approvalRequired`, stop and wait for the user to approve it in Mini-Term.
- After approval, retry with `approvalRequestId`.

## Review rules
- When a task reports changes, inspect `changedFiles`.
- Use `get_diff_for_review` before summarizing implementation outcomes.
- Explain task state from Mini-Term data first, not from guesswork."#.into(),
        mcp_instructions_template: r#"Mini-Term MCP guidance for {client_type}:
- Workspace: {workspace_name}
- Preferred sequence: {tool_sequence}
- Approval tools: {approval_tools}
- Read-only tools: {read_only_tools}
- Task tools: {task_tools}

Use Mini-Term for:
- workspace discovery
- structured project context
- tracked task execution
- review and diff inspection
- approval-gated actions

Do not treat Mini-Term as a passive tool list. It is the operating control plane for this workspace."#.into(),
        tool_usage_policy: default_tool_usage_policy(),
    }
}

fn default_claude_profile() -> AgentPolicyProfile {
    AgentPolicyProfile {
        id: "claude-default".into(),
        client_type: AgentClientType::Claude,
        enabled: true,
        display_name: "Claude Default".into(),
        platform_prompt_template: r#"## Role
You are a reasoning-heavy engineering assistant operating through Mini-Term.
Mini-Term is the local workspace host and MCP control plane for context, tracked tasks, approvals, and Git review handoff.

## What Mini-Term Controls
- workspace truth
- structured local project context
- tracked execution
- approval flow
- Git review and change explanation

## Hard Constraints
1. Ground local project claims in Mini-Term context or tool output.
2. Respect approval boundaries and stop on `approvalRequired`.
3. Use Mini-Term review data before concluding on changed work.
4. Distinguish clearly between your reasoning and Mini-Term reported task state."#.into(),
        tool_policy_prompt_template: r#"## Tool Groups
- Core runtime: ping, server_info, list_tools
- Runtime observation: workspace/context, config, PTY summaries/details, events, AI sessions
- PTY control: create/write/resize/kill PTY
- UI control: focus workspace, create/close tabs, split panes, notices, config patches
- Task tools: {task_tools}
- Legacy compat: {read_only_tools}
- Approval-gated: {approval_tools}

## Preferred Sequence
{tool_sequence}

## When To Use Runtime Observation
- Use `get_workspace_context` before substantial planning.
- Use `list_ptys` first, then `get_pty_detail` / `get_process_tree` when summary data is insufficient.
- Use `get_recent_events` when you need a concise runtime trail.

## When To Use Legacy Compat Tools
- Use `read_file` / `search_files` before broader reasoning about implementation.
- Use `get_git_summary` / `get_diff_for_review` for change-aware explanation.

## When To Use Task Tools
- Use `start_task` when execution should be tracked and recoverable.
- Use `save_task_plan` when task output should be preserved as a reusable plan document.
- Use `send_task_input` to continue live tracked tasks.
- Use `resume_session` when you need current tracked task state.

## When To Stop For Approval
- Approval-gated tools are not immediate.
- Retry only after the user approves in Mini-Term."#.into(),
        client_wrapper_prompt_template: r#"## Client Role
You are Claude operating through Mini-Term.

## How To Work With Mini-Term
- Name the workspace or task you are acting on.
- Summarize live task state from Mini-Term data first.
- Use review data to support conclusions.

## Biases To Correct
- Do not let fluent explanation replace concrete local evidence.
- Do not continue through approval or review boundaries without data."#.into(),
        system_prompt_template: r#"## Role
You are a reasoning-heavy engineering assistant connected to Mini-Term.
Mini-Term is the local workspace host and MCP control plane for:
- workspace discovery
- structured context
- tracked tasks
- approvals
- Git review handoff

Active workspace:
- id: {workspace_id}
- name: {workspace_name}
- client: {client_type}
- task target: {target}
- preset: {preset}

## Behavior rules
1. Ground all local project claims in Mini-Term context or tool results.
2. Prefer explicit tool usage over hidden assumptions.
3. Respect approval boundaries. Do not continue past an approval gate.
4. Distinguish clearly between your reasoning and Mini-Term task state.
5. When review is involved, prefer Git summary and diff data before making claims.

## Preferred workflow
{tool_sequence}

## Constraints
- Approval tools: {approval_tools}
- Read-only tools: {read_only_tools}
- Task tools: {task_tools}
- Extra instructions: {extra_instructions}"#.into(),
        skill_template: r#"# Mini-Term For Claude

Use Mini-Term as the control plane around Claude or Codex CLI runs.

## Default workflow
1. Call `list_workspaces`.
2. Call `get_workspace_context` with the smallest preset that still fits the task.
3. Use `read_file` / `search_files` for narrow inspection before broader reasoning.
4. Use `start_task` when tracked execution is preferable to free-form shell work.
5. Poll with `get_task_status` or `list_attention_tasks`.
6. When Mini-Term reports `needs-review`, inspect `changedFiles` and call `get_diff_for_review`.

## Approval behavior
- Approval-gated tools do not execute immediately.
- A first call may only create an approval request.
- Retry only after the user approves it in Mini-Term.

## Response style
- Name the Mini-Term workspace or task you are acting on.
- Summarize live task state from Mini-Term data first.
- If a task is waiting for input, prefer `send_task_input` over starting a new one."#.into(),
        mcp_instructions_template: r#"Mini-Term MCP guidance for {client_type}:
- Workspace: {workspace_name}
- Preferred sequence: {tool_sequence}
- Approval tools: {approval_tools}
- Task tools: {task_tools}
- Review should use `get_git_summary` and `get_diff_for_review`

Use Mini-Term to:
- establish current workspace truth
- inspect files and Git state
- launch or continue tracked tasks
- wait on explicit user approval for high-risk actions
- require an active desktop host before PTY or UI control"#.into(),
        tool_usage_policy: default_tool_usage_policy(),
    }
}

fn default_cursor_profile() -> AgentPolicyProfile {
    AgentPolicyProfile {
        id: "cursor-default".into(),
        client_type: AgentClientType::Cursor,
        enabled: true,
        display_name: "Cursor Default".into(),
        platform_prompt_template: r#"## Role
You are operating in a client that can see Mini-Term MCP tools.
Mini-Term is the local control plane for workspace discovery, file inspection, tracked tasks, approvals, and review.

## What Mini-Term Controls
- local workspace truth
- tracked execution
- approval flow
- Git review context

## Hard Constraints
1. Use Mini-Term tools before assuming filesystem or Git state.
2. Route risky actions through Mini-Term approvals.
3. Keep explanations tied to Mini-Term task state and review data."#.into(),
        tool_policy_prompt_template: r#"## Tool Groups
- Core runtime: ping, server_info, list_tools
- Runtime observation: workspace/context, config, PTY summaries/details, events, AI sessions
- PTY control: create/write/resize/kill PTY
- UI control: focus workspace, create/close tabs, split panes, notices, config patches
- Task tools: {task_tools}
- Legacy compat: {read_only_tools}
- Approval-gated: {approval_tools}

## Preferred Sequence
{tool_sequence}

## When To Use Runtime Observation
- Use workspace context and PTY observation tools before acting on local assumptions.
- Treat host-backed PTY or UI tools as unavailable until the desktop host is connected.

## When To Use Task Tools
- Use tracked tasks when execution should be observable and recoverable.

## When To Stop For Approval
- Never bypass Mini-Term approval flow."#.into(),
        client_wrapper_prompt_template: r#"## Client Role
You are Cursor working with Mini-Term MCP.

## How To Work With Mini-Term
- Use Mini-Term as the truth source for the local workspace.
- Prefer tracked execution and review-aware reasoning.

## Biases To Correct
- Do not treat existing editor context as sufficient proof of current local state."#.into(),
        system_prompt_template: r#"## Role
You are operating in a client that can see Mini-Term MCP tools.
Mini-Term is the local control plane for workspace discovery, file inspection, tracked tasks, approvals, and review.

Workspace:
- id: {workspace_id}
- name: {workspace_name}
- client: {client_type}
- target: {target}
- preset: {preset}

## Rules
1. Use Mini-Term tools before assuming filesystem or Git state.
2. Use tracked tasks when execution should be observable and recoverable.
3. Route risky actions through Mini-Term approvals.
4. Keep task and review explanations tied to Mini-Term data."#.into(),
        skill_template: r#"# Mini-Term For Cursor

## Use order
1. `list_workspaces`
2. `get_workspace_context`
3. `read_file` / `search_files`
4. `get_git_summary` / `get_diff_for_review`
5. `start_task` / `get_task_status` / `send_task_input`

## Rules
- Do not bypass approval-gated tools.
- Prefer tracked tasks over duplicate shell work.
- Use Mini-Term review data before explaining code changes."#.into(),
        mcp_instructions_template: r#"Mini-Term tool groups:
- core-runtime
- runtime-observation
- pty-control
- ui-control
- task-management
- legacy-compat

Preferred sequence: {tool_sequence}
Approval tools: {approval_tools}
Read-only compat tools: {read_only_tools}
Task tools: {task_tools}
Host-backed tools require an active desktop host."#.into(),
        tool_usage_policy: default_tool_usage_policy(),
    }
}

fn default_generic_profile() -> AgentPolicyProfile {
    AgentPolicyProfile {
        id: "generic-mcp-default".into(),
        client_type: AgentClientType::GenericMcp,
        enabled: true,
        display_name: "Generic MCP Default".into(),
        platform_prompt_template: r#"## Role
You are connected to Mini-Term MCP.
Mini-Term is a local workspace host plus MCP control plane.

## What Mini-Term Controls
- workspace discovery
- structured project context
- tracked execution
- approval-gated actions
- review handoff

## Hard Constraints
1. Discover the correct workspace before acting.
2. Load workspace context before making local project claims.
3. Stop on `approvalRequired`.
4. Prefer Mini-Term review data when changes exist."#.into(),
        tool_policy_prompt_template: r#"## Tool Groups
- Core runtime: ping, server_info, list_tools
- Runtime observation: workspace/context, config, PTY summaries/details, events, AI sessions
- PTY control: create/write/resize/kill PTY
- UI control: focus workspace, create/close tabs, split panes, notices, config patches
- Task tools: {task_tools}
- Legacy compat: {read_only_tools}
- Approval-gated: {approval_tools}

## Preferred Sequence
{tool_sequence}

## When To Use Legacy Compat Tools
- Before local file or Git claims

## When To Use Task Tools
- When execution should be tracked and recoverable

## When To Stop For Approval
- Any `approvalRequired` response is a hard stop until approved."#.into(),
        client_wrapper_prompt_template: r#"## Client Role
You are a generic MCP client using Mini-Term.

## How To Work With Mini-Term
- Prefer portable MCP semantics.
- Avoid assumptions tied to a specific IDE or desktop client.

## Biases To Correct
- Do not rely on client-local context when Mini-Term can provide authoritative local state."#.into(),
        system_prompt_template: r#"## Role
You are connected to Mini-Term MCP.
Mini-Term is a local workspace host plus MCP control plane.

Workspace:
- id: {workspace_id}
- name: {workspace_name}
- client: {client_type}
- target: {target}
- preset: {preset}

## General rules
1. Discover the correct workspace before acting.
2. Load workspace context before making local project claims.
3. Use file and git tools before risky actions.
4. If an action is approval-gated, stop until approval is granted.
5. If a tracked task exists, continue it rather than duplicating work unless the user asks otherwise."#.into(),
        skill_template: r#"# Mini-Term Generic MCP

Use Mini-Term to discover workspaces, inspect context, read files, review Git state, and control tracked tasks.

## Baseline order
1. `list_workspaces`
2. `get_workspace_context`
3. `read_file` / `search_files`
4. `get_git_summary` / `get_diff_for_review`
5. `start_task` / `get_task_status` / `send_task_input`

## Approval rule
Never continue a high-risk action after `approvalRequired` until Mini-Term approval is granted."#.into(),
        mcp_instructions_template: r#"Mini-Term exposes a local MCP control plane with six fixed tool groups.

Read-only compat tools: {read_only_tools}
Approval tools: {approval_tools}
Task tools: {task_tools}
Preferred sequence: {tool_sequence}
Host-backed PTY/UI tools require the desktop host to be online."#.into(),
        tool_usage_policy: default_tool_usage_policy(),
    }
}

fn default_profiles() -> Vec<AgentPolicyProfile> {
    vec![
        default_codex_profile(),
        default_claude_profile(),
        default_cursor_profile(),
        default_generic_profile(),
    ]
}

fn default_tool_usage_policy() -> ToolUsagePolicy {
    ToolUsagePolicy {
        preferred_sequence: vec![
            "list_workspaces".into(),
            "get_workspace_context".into(),
            "list_ptys/get_pty_detail/get_process_tree".into(),
            "read_file/search_files".into(),
            "get_git_summary/get_diff_for_review".into(),
            "start_task/spawn_worker/get_task_status/save_task_plan/send_task_input/close_task"
                .into(),
        ],
        approval_tools: vec![
            "kill_pty".into(),
            "close_tab".into(),
            "write_file".into(),
            "close_task".into(),
            "run_workspace_command".into(),
        ],
        read_only_tools: vec![
            "list_workspaces".into(),
            "get_workspace_context".into(),
            "list_ptys".into(),
            "get_pty_detail".into(),
            "get_process_tree".into(),
            "read_file".into(),
            "search_files".into(),
            "get_git_summary".into(),
            "get_diff_for_review".into(),
            "list_ai_sessions".into(),
        ],
        task_tools: vec![
            "start_task".into(),
            "spawn_worker".into(),
            "get_task_status".into(),
            "save_task_plan".into(),
            "list_attention_tasks".into(),
            "resume_session".into(),
            "send_task_input".into(),
            "close_task".into(),
            "list_approval_requests".into(),
            "decide_approval_request".into(),
        ],
    }
}

fn default_task_injection() -> TaskInjectionPolicy {
    TaskInjectionPolicy {
        enabled: true,
        targets: InjectionTargets::Both,
        preset_policies: PresetPolicyTemplates {
            light: r#"## Task mode: light
- Use the smallest set of tools needed.
- Prefer narrow file inspection over broad repository exploration.
- Avoid speculative edits.
- If local facts matter, read them first.
- Do not escalate to approval-gated actions unless the user intent clearly requires it."#
                .into(),
            standard: r#"## Task mode: standard
- Use Mini-Term as the control plane for context, task state, approvals, and review.
- Load workspace context before planning substantial work.
- Inspect relevant files and Git state before changing behavior.
- Prefer tracked tasks and incremental continuation over duplicate task creation.
- Keep approval-gated actions explicit and user-visible."#
                .into(),
            review: r#"## Task mode: review
- Treat this as review-sensitive work.
- Use `get_git_summary` and `get_diff_for_review` before concluding.
- If changes exist, explain them using Mini-Term review data rather than inference.
- Highlight uncertainty when the diff or workspace context is incomplete.
- Favor precise evidence, concise findings, and explicit risk framing."#
                .into(),
        },
        approval_hints: true,
        review_hints: true,
        profile_bindings: TaskInjectionProfileBindings {
            codex: Some("codex-default".into()),
            claude: Some("claude-default".into()),
        },
        target_preset_policies: TaskInjectionTargetPresetPolicies::default(),
    }
}

pub fn default_agent_policies() -> AgentPoliciesConfig {
    AgentPoliciesConfig {
        profiles: default_profiles(),
        workspace_overrides: Vec::new(),
        task_injection: default_task_injection(),
    }
}

fn find_profile(config: &AgentPoliciesConfig, profile_id: &str) -> Option<AgentPolicyProfile> {
    config
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id)
        .cloned()
}

fn find_enabled_profile_for_target(
    config: &AgentPoliciesConfig,
    injection_policy: &TaskInjectionPolicy,
    target: &TaskTarget,
) -> Result<AgentPolicyProfile, String> {
    let preferred_client_type = match target {
        TaskTarget::Codex => AgentClientType::Codex,
        TaskTarget::Claude => AgentClientType::Claude,
    };
    let preferred_id = match target {
        TaskTarget::Codex => injection_policy
            .profile_bindings
            .codex
            .as_deref()
            .unwrap_or("codex-default"),
        TaskTarget::Claude => injection_policy
            .profile_bindings
            .claude
            .as_deref()
            .unwrap_or("claude-default"),
    };

    config
        .profiles
        .iter()
        .find(|profile| profile.id == preferred_id && profile.enabled)
        .cloned()
        .or_else(|| {
            config
                .profiles
                .iter()
                .find(|profile| profile.client_type == preferred_client_type && profile.enabled)
                .cloned()
        })
        .ok_or_else(|| {
            format!(
                "no enabled policy profile found for target: {}",
                target.as_str()
            )
        })
}

fn find_workspace_override<'a>(
    config: &'a AgentPoliciesConfig,
    workspace_id: &str,
    profile_id: &str,
) -> Option<&'a WorkspacePolicyOverride> {
    config
        .workspace_overrides
        .iter()
        .find(|item| item.workspace_id == workspace_id && item.profile_id == profile_id)
}

fn render_template(
    template: &str,
    workspace_id: &str,
    workspace_name: &str,
    client_type: &AgentClientType,
    target: &TaskTarget,
    preset: &TaskContextPreset,
    tool_usage_policy: &ToolUsagePolicy,
) -> String {
    template
        .replace("{workspace_id}", workspace_id)
        .replace("{workspace_name}", workspace_name)
        .replace("{client_type}", client_type.as_str())
        .replace("{target}", target.as_str())
        .replace(
            "{preset}",
            match preset {
                TaskContextPreset::Light => "light",
                TaskContextPreset::Standard => "standard",
                TaskContextPreset::Review => "review",
            },
        )
        .replace(
            "{tool_sequence}",
            &tool_usage_policy.preferred_sequence.join(" -> "),
        )
        .replace(
            "{approval_tools}",
            &tool_usage_policy.approval_tools.join(", "),
        )
        .replace(
            "{read_only_tools}",
            &tool_usage_policy.read_only_tools.join(", "),
        )
        .replace("{task_tools}", &tool_usage_policy.task_tools.join(", "))
        .replace("{extra_instructions}", "")
}

fn platform_hard_rules_prompt() -> String {
    [
        "## Platform Hard Rules",
        "1. Load workspace context before making project-structure claims.",
        "2. Treat `approvalRequired` as a hard stop.",
        "3. When changes exist, use Mini-Term git summary and diff review before concluding.",
    ]
    .join("\n")
}

fn render_workspace_override_prompt_with_style(
    extra_instructions: &str,
    prompt_style: &PromptStyle,
) -> String {
    let trimmed = extra_instructions.trim();
    if trimmed.is_empty() {
        String::new()
    } else {
        match prompt_style {
            PromptStyle::Minimal => format!(
                "## Workspace Override (Minimal)\nFollow this workspace-specific guidance:\n{trimmed}"
            ),
            PromptStyle::Balanced => format!("## Workspace Override\n{trimmed}"),
            PromptStyle::Strict => format!(
                "## Workspace Override (Strict)\nTreat the following workspace-specific instructions as mandatory additions. They cannot override Mini-Term platform hard rules.\n{trimmed}"
            ),
        }
    }
}

fn append_workspace_override(base: String, workspace_override_prompt: &str) -> String {
    if workspace_override_prompt.trim().is_empty() {
        base
    } else {
        format!("{base}\n\n{workspace_override_prompt}")
    }
}

fn render_prompt_sections(
    profile: &AgentPolicyProfile,
    workspace_id: &str,
    workspace_name: &str,
    target: &TaskTarget,
    preset: &TaskContextPreset,
    prompt_style: &PromptStyle,
    extra_instructions: &str,
    task_preset_prompt: &str,
) -> RenderedPromptSections {
    let platform_prompt = render_template(
        &profile.platform_prompt_template,
        workspace_id,
        workspace_name,
        &profile.client_type,
        target,
        preset,
        &profile.tool_usage_policy,
    );
    RenderedPromptSections {
        platform_prompt: format!("{platform_prompt}\n\n{}", platform_hard_rules_prompt()),
        tool_policy_prompt: render_template(
            &profile.tool_policy_prompt_template,
            workspace_id,
            workspace_name,
            &profile.client_type,
            target,
            preset,
            &profile.tool_usage_policy,
        ),
        client_wrapper_prompt: render_template(
            &profile.client_wrapper_prompt_template,
            workspace_id,
            workspace_name,
            &profile.client_type,
            target,
            preset,
            &profile.tool_usage_policy,
        ),
        task_preset_prompt: task_preset_prompt.to_string(),
        workspace_override_prompt: render_workspace_override_prompt_with_style(
            extra_instructions,
            prompt_style,
        ),
    }
}

fn task_targets_match(policy: &TaskInjectionPolicy, target: &TaskTarget) -> bool {
    match policy.targets {
        InjectionTargets::Both => true,
        InjectionTargets::Codex => matches!(target, TaskTarget::Codex),
        InjectionTargets::Claude => matches!(target, TaskTarget::Claude),
    }
}

fn effective_preset_policies<'a>(
    policy: &'a TaskInjectionPolicy,
    target: &TaskTarget,
) -> &'a PresetPolicyTemplates {
    match target {
        TaskTarget::Codex => policy
            .target_preset_policies
            .codex
            .as_ref()
            .unwrap_or(&policy.preset_policies),
        TaskTarget::Claude => policy
            .target_preset_policies
            .claude
            .as_ref()
            .unwrap_or(&policy.preset_policies),
    }
}

fn preset_template<'a>(
    policy: &'a TaskInjectionPolicy,
    target: &TaskTarget,
    preset: &TaskContextPreset,
) -> &'a str {
    let templates = effective_preset_policies(policy, target);
    match preset {
        TaskContextPreset::Light => &templates.light,
        TaskContextPreset::Standard => &templates.standard,
        TaskContextPreset::Review => &templates.review,
    }
}

fn build_effective_policy_summary(
    profile: &AgentPolicyProfile,
    preset: &TaskContextPreset,
    prompt_style: Option<&PromptStyle>,
    workspace_override_prompt: &str,
) -> String {
    format!(
        "{} profile on {} preset{}",
        profile.display_name,
        match preset {
            TaskContextPreset::Light => "light",
            TaskContextPreset::Standard => "standard",
            TaskContextPreset::Review => "review",
        },
        if workspace_override_prompt.trim().is_empty() {
            String::new()
        } else {
            format!(
                " with {} workspace override",
                match prompt_style.unwrap_or(&PromptStyle::Balanced) {
                    PromptStyle::Minimal => "minimal",
                    PromptStyle::Balanced => "balanced",
                    PromptStyle::Strict => "strict",
                }
            )
        }
    )
}

const DEFAULT_MCP_HTTP_HOST: &str = "127.0.0.1";
const DEFAULT_MCP_HTTP_PORT: u16 = 8765;

fn candidate_mcp_binary_paths(binary_name: &str) -> Vec<PathBuf> {
    let exe_name = format!("{binary_name}{}", std::env::consts::EXE_SUFFIX);
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut candidates = Vec::new();

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(dir) = current_exe.parent() {
            candidates.push(dir.join(&exe_name));
        }
    }

    candidates.push(manifest_dir.join("target").join("debug").join(&exe_name));
    candidates.push(manifest_dir.join("target").join("release").join(&exe_name));

    let mut unique = Vec::new();
    for candidate in candidates {
        if !unique.contains(&candidate) {
            unique.push(candidate);
        }
    }
    unique
}

fn single_quote_powershell(value: &str) -> String {
    value.replace('\'', "''")
}

fn resolve_binary_launch(binary_name: &str, transport: &str) -> Option<McpLaunchInfo> {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|path| path.to_path_buf());

    let binary = candidate_mcp_binary_paths(binary_name)
        .into_iter()
        .find(|candidate| candidate.is_file())?;

    #[cfg(target_os = "windows")]
    {
        let binary_str = binary.to_string_lossy().to_string();
        return Some(McpLaunchInfo {
            status: "resolved".to_string(),
            transport: transport.to_string(),
            command: Some(
                r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe".to_string(),
            ),
            args: vec![
                "-NoLogo".to_string(),
                "-NoProfile".to_string(),
                "-Command".to_string(),
                format!("& '{}'", single_quote_powershell(&binary_str)),
            ],
            url: None,
            cwd: repo_root.map(|path| path.to_string_lossy().to_string()),
            notes: Some(format!(
                "This launch command uses Windows PowerShell to start a locally built {binary_name} binary."
            )),
        });
    }

    #[cfg(not(target_os = "windows"))]
    Some(McpLaunchInfo {
        status: "resolved".to_string(),
        transport: transport.to_string(),
        command: Some(binary.to_string_lossy().to_string()),
        args: Vec::new(),
        url: None,
        cwd: repo_root.map(|path| path.to_string_lossy().to_string()),
        notes: Some(format!(
            "This launch command is resolved from a locally built {binary_name} binary."
        )),
    })
}

fn resolve_cargo_launch(binary_name: &str, transport: &str) -> Option<McpLaunchInfo> {
    let manifest_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|path| path.to_path_buf());
    if !manifest_path.exists() {
        return None;
    }

    Some(McpLaunchInfo {
        status: "resolved".to_string(),
        transport: transport.to_string(),
        command: Some("cargo".to_string()),
        args: vec![
            "run".to_string(),
            "--manifest-path".to_string(),
            manifest_path.to_string_lossy().to_string(),
            "--bin".to_string(),
            binary_name.to_string(),
        ],
        url: None,
        cwd: repo_root.map(|path| path.to_string_lossy().to_string()),
        notes: Some(format!(
            "This launch command is resolved from the current Mini-Term source checkout for {binary_name}."
        )),
    })
}

pub(crate) fn resolve_stdio_mcp_launch() -> McpLaunchInfo {
    resolve_binary_launch("mini-term-mcp", "stdio")
        .or_else(|| resolve_cargo_launch("mini-term-mcp", "stdio"))
        .unwrap_or_else(|| McpLaunchInfo {
            status: "manual-required".to_string(),
            transport: "stdio".to_string(),
            command: None,
            args: Vec::new(),
            url: None,
            cwd: None,
            notes: Some(
                "Mini-Term could not resolve a portable stdio MCP launch command from this runtime. Configure the MCP server manually.".to_string(),
            ),
        })
}

fn resolve_http_server_launch() -> McpLaunchInfo {
    resolve_binary_launch("mini-term-mcp-http", "http")
        .or_else(|| resolve_cargo_launch("mini-term-mcp-http", "http"))
        .unwrap_or_else(|| McpLaunchInfo {
            status: "manual-required".to_string(),
            transport: "http".to_string(),
            command: None,
            args: Vec::new(),
            url: None,
            cwd: None,
            notes: Some(
                "Mini-Term could not resolve a local HTTP MCP launcher from this runtime. Start mini-term-mcp-http manually and connect to its URL.".to_string(),
            ),
        })
}

pub(crate) fn resolve_mcp_launch() -> McpLaunchInfo {
    #[cfg(target_os = "windows")]
    {
        let mut launch = resolve_http_server_launch();
        launch.url = Some(format!(
            "http://{DEFAULT_MCP_HTTP_HOST}:{DEFAULT_MCP_HTTP_PORT}/mcp"
        ));
        launch.notes = Some(match launch.notes.take() {
            Some(existing) => format!(
                "{existing} Start the HTTP wrapper locally and point Codex at this URL instead of the stdio bridge."
            ),
            None => "Start the HTTP wrapper locally and point Codex at this URL instead of the stdio bridge.".to_string(),
        });
        return launch;
    }

    #[cfg(not(target_os = "windows"))]
    resolve_stdio_mcp_launch()
}

fn build_mcp_config_json(launch: &McpLaunchInfo) -> Result<String, String> {
    let server = if launch.transport == "http" {
        serde_json::json!({
            "type": "http",
            "url": launch.url.clone(),
            "note": launch.notes.clone(),
        })
    } else {
        serde_json::json!({
            "type": "stdio",
            "command": launch.command.clone(),
            "args": launch.args.clone(),
            "cwd": launch.cwd.clone(),
            "note": launch.notes.clone(),
        })
    };

    serde_json::to_string_pretty(&serde_json::json!({
        "mcpServers": {
            "mini-term": server,
        }
    }))
    .map_err(|err| err.to_string())
}

fn resolve_client_install_launch(client_type: &AgentClientType) -> Result<McpLaunchInfo, String> {
    match client_type {
        AgentClientType::Codex | AgentClientType::Claude => {
            let launch = resolve_stdio_mcp_launch();
            if launch.status == "resolved" {
                Ok(launch)
            } else {
                let details = launch
                    .notes
                    .clone()
                    .unwrap_or_else(|| "No additional details were provided.".to_string());
                Err(format!(
                    "Mini-Term could not resolve a local stdio MCP launch for {}. {}",
                    client_type.as_str(),
                    details
                ))
            }
        }
        _ => Err(format!(
            "One-click MCP injection is currently supported only for Codex and Claude, not {}.",
            client_type.as_str()
        )),
    }
}

fn build_codex_mcp_server_value(launch: &McpLaunchInfo) -> Result<toml::Value, String> {
    let mut server = toml::map::Map::new();
    match launch.transport.as_str() {
        "http" => {
            let url = launch
                .url
                .clone()
                .ok_or_else(|| "missing MCP URL for HTTP client injection".to_string())?;
            server.insert("url".to_string(), toml::Value::String(url));
        }
        "stdio" => {
            let command = launch
                .command
                .clone()
                .ok_or_else(|| "missing MCP command for stdio client injection".to_string())?;
            server.insert("command".to_string(), toml::Value::String(command));
            server.insert(
                "args".to_string(),
                toml::Value::Array(
                    launch
                        .args
                        .iter()
                        .cloned()
                        .map(toml::Value::String)
                        .collect(),
                ),
            );
            if let Some(cwd) = launch.cwd.clone() {
                server.insert("cwd".to_string(), toml::Value::String(cwd));
            }
        }
        other => {
            return Err(format!(
                "unsupported MCP transport for Codex injection: {other}"
            ));
        }
    }
    server.insert(
        "startup_timeout_sec".to_string(),
        toml::Value::Integer(MCP_INSTALL_STARTUP_TIMEOUT_SEC),
    );
    Ok(toml::Value::Table(server))
}

fn build_claude_mcp_server_value(launch: &McpLaunchInfo) -> Result<serde_json::Value, String> {
    let mut server = serde_json::Map::new();
    server.insert(
        "description".to_string(),
        serde_json::Value::String(
            "Mini-Term workspace host, PTY control, UI control, tracked tasks, and review handoff."
                .to_string(),
        ),
    );
    match launch.transport.as_str() {
        "http" => {
            let url = launch
                .url
                .clone()
                .ok_or_else(|| "missing MCP URL for HTTP client injection".to_string())?;
            server.insert(
                "type".to_string(),
                serde_json::Value::String("http".to_string()),
            );
            server.insert("url".to_string(), serde_json::Value::String(url));
        }
        "stdio" => {
            let command = launch
                .command
                .clone()
                .ok_or_else(|| "missing MCP command for stdio client injection".to_string())?;
            server.insert(
                "type".to_string(),
                serde_json::Value::String("stdio".to_string()),
            );
            server.insert("command".to_string(), serde_json::Value::String(command));
            server.insert(
                "args".to_string(),
                serde_json::Value::Array(
                    launch
                        .args
                        .iter()
                        .cloned()
                        .map(serde_json::Value::String)
                        .collect(),
                ),
            );
            if let Some(cwd) = launch.cwd.clone() {
                server.insert("cwd".to_string(), serde_json::Value::String(cwd));
            }
        }
        other => {
            return Err(format!(
                "unsupported MCP transport for Claude injection: {other}"
            ));
        }
    }
    Ok(serde_json::Value::Object(server))
}

fn ensure_parent_dir(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            format!(
                "failed to create directory {}: {err}",
                parent.to_string_lossy()
            )
        })?;
    }
    Ok(())
}

fn write_text_if_changed(path: &Path, content: String) -> Result<(bool, bool), String> {
    let normalized = if content.ends_with('\n') {
        content
    } else {
        format!("{content}\n")
    };
    match fs::read_to_string(path) {
        Ok(existing) if existing == normalized => Ok((false, false)),
        Ok(_) => {
            ensure_parent_dir(path)?;
            fs::write(path, normalized)
                .map_err(|err| format!("failed to write {}: {err}", path.to_string_lossy()))?;
            Ok((false, true))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            ensure_parent_dir(path)?;
            fs::write(path, normalized)
                .map_err(|err| format!("failed to write {}: {err}", path.to_string_lossy()))?;
            Ok((true, false))
        }
        Err(err) => Err(format!("failed to read {}: {err}", path.to_string_lossy())),
    }
}

fn install_file_result(
    path: &Path,
    kind: &str,
    created: bool,
    updated: bool,
) -> McpClientInstallFileResult {
    McpClientInstallFileResult {
        path: path.to_string_lossy().to_string(),
        kind: kind.to_string(),
        created,
        updated,
    }
}

fn install_codex_mcp_config_at(
    home_dir: &Path,
    launch: &McpLaunchInfo,
) -> Result<Vec<McpClientInstallFileResult>, String> {
    let config_path = home_dir.join(".codex").join("config.toml");
    let mut config_value = match fs::read_to_string(&config_path) {
        Ok(content) => toml::from_str::<toml::Value>(&content).map_err(|err| {
            format!(
                "failed to parse Codex config {}: {err}",
                config_path.to_string_lossy()
            )
        })?,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            toml::Value::Table(toml::map::Map::new())
        }
        Err(err) => {
            return Err(format!(
                "failed to read Codex config {}: {err}",
                config_path.to_string_lossy()
            ));
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
    mcp_servers.insert(
        MCP_SERVER_NAME.to_string(),
        build_codex_mcp_server_value(launch)?,
    );
    let serialized = toml::to_string_pretty(&config_value).map_err(|err| err.to_string())?;
    let (created, updated) = write_text_if_changed(&config_path, serialized)?;
    Ok(vec![install_file_result(
        &config_path,
        "primary",
        created,
        updated,
    )])
}

fn install_claude_json_file(
    path: &Path,
    kind: &str,
    launch: &McpLaunchInfo,
) -> Result<McpClientInstallFileResult, String> {
    let mut config_value = match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str::<serde_json::Value>(&content).map_err(|err| {
            format!(
                "failed to parse Claude config {}: {err}",
                path.to_string_lossy()
            )
        })?,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
        Err(err) => {
            return Err(format!(
                "failed to read Claude config {}: {err}",
                path.to_string_lossy()
            ));
        }
    };
    let root = config_value
        .as_object_mut()
        .ok_or_else(|| "Claude config must be a JSON object".to_string())?;
    let mcp_servers = root
        .entry("mcpServers".to_string())
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| "Claude config field `mcpServers` must be a JSON object".to_string())?;
    mcp_servers.insert(
        MCP_SERVER_NAME.to_string(),
        build_claude_mcp_server_value(launch)?,
    );
    let serialized = serde_json::to_string_pretty(&config_value).map_err(|err| err.to_string())?;
    let (created, updated) = write_text_if_changed(path, serialized)?;
    Ok(install_file_result(path, kind, created, updated))
}

fn install_claude_mcp_config_at(
    home_dir: &Path,
    launch: &McpLaunchInfo,
) -> Result<Vec<McpClientInstallFileResult>, String> {
    let mut files = Vec::new();
    let primary_path = home_dir.join(".claude.json");
    files.push(install_claude_json_file(&primary_path, "primary", launch)?);

    let claude_dir = home_dir.join(".claude");
    if claude_dir.is_dir() {
        let catalog_path = claude_dir.join("mcp-configs").join("mcp-servers.json");
        files.push(install_claude_json_file(&catalog_path, "catalog", launch)?);
    }

    Ok(files)
}

fn build_task_injection_preview_from_config(
    config: &AppConfig,
    workspace_id: &str,
    target: TaskTarget,
    preset: TaskContextPreset,
    prompt: &str,
) -> Result<TaskInjectionPreview, String> {
    let workspace = config
        .workspaces
        .iter()
        .find(|workspace| workspace.id == workspace_id)
        .ok_or_else(|| format!("workspace not found: {workspace_id}"))?;
    let policies = config
        .agent_policies
        .clone()
        .unwrap_or_else(default_agent_policies);
    let profile = find_enabled_profile_for_target(&policies, &policies.task_injection, &target)?;
    let workspace_override = find_workspace_override(&policies, workspace_id, &profile.id);
    let prompt_style = workspace_override
        .map(|item| item.prompt_style.clone())
        .unwrap_or(PromptStyle::Balanced);
    let extra_instructions = workspace_override
        .map(|item| item.extra_instructions.clone())
        .unwrap_or_default();

    let injection_policy = &policies.task_injection;
    let task_preset_prompt = preset_template(injection_policy, &target, &preset).to_string();
    let rendered_sections = render_prompt_sections(
        &profile,
        workspace_id,
        &workspace.name,
        &target,
        &preset,
        &prompt_style,
        &extra_instructions,
        &task_preset_prompt,
    );
    let mut sections = vec![
        rendered_sections.platform_prompt.clone(),
        rendered_sections.tool_policy_prompt.clone(),
        rendered_sections.client_wrapper_prompt.clone(),
        rendered_sections.task_preset_prompt.clone(),
    ];
    if injection_policy.approval_hints {
        sections.push(
            "Approval-gated actions must wait for Mini-Term Inbox approval before retry.".into(),
        );
    }
    if injection_policy.review_hints && matches!(preset, TaskContextPreset::Review) {
        sections.push("When changes exist, inspect Mini-Term git summary and diff review tools before concluding.".into());
    }
    if !rendered_sections
        .workspace_override_prompt
        .trim()
        .is_empty()
    {
        sections.push(rendered_sections.workspace_override_prompt.clone());
    }

    let policy_summary = build_effective_policy_summary(
        &profile,
        &preset,
        Some(&prompt_style),
        &rendered_sections.workspace_override_prompt,
    );

    let final_prompt =
        if policies.task_injection.enabled && task_targets_match(injection_policy, &target) {
            format!(
                "Mini-Term runtime policy:\n{}\n\nUser request:\n{}",
                sections.join("\n\n"),
                prompt.trim()
            )
        } else {
            prompt.trim().to_string()
        };

    Ok(TaskInjectionPreview {
        profile_id: profile.id,
        client_type: profile.client_type,
        preset,
        workspace_id: workspace_id.to_string(),
        workspace_name: workspace.name.clone(),
        policy_summary,
        rendered_sections,
        final_prompt,
    })
}

pub fn build_task_injection_preview(
    workspace_id: &str,
    target: TaskTarget,
    preset: TaskContextPreset,
    prompt: &str,
) -> Result<TaskInjectionPreview, String> {
    let config = load_config_from_path(&config_path());
    build_task_injection_preview_from_config(&config, workspace_id, target, preset, prompt)
}

pub fn list_policy_profiles() -> Vec<AgentPolicyProfile> {
    load_config_from_path(&config_path())
        .agent_policies
        .unwrap_or_else(default_agent_policies)
        .profiles
}

pub fn get_policy_profile(profile_id: &str) -> Result<AgentPolicyProfile, String> {
    let policies = load_config_from_path(&config_path())
        .agent_policies
        .unwrap_or_else(default_agent_policies);
    find_profile(&policies, profile_id).ok_or_else(|| format!("profile not found: {profile_id}"))
}

pub fn get_default_policy_profile(profile_id: &str) -> Result<AgentPolicyProfile, String> {
    default_profiles()
        .into_iter()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| format!("default profile not found: {profile_id}"))
}

pub fn save_policy_profile(profile: AgentPolicyProfile) -> Result<AgentPolicyProfile, String> {
    let path = config_path();
    let mut config = load_config_from_path(&path);
    let mut policies = config.agent_policies.unwrap_or_else(default_agent_policies);
    if let Some(existing) = policies
        .profiles
        .iter_mut()
        .find(|item| item.id == profile.id)
    {
        *existing = profile.clone();
    } else {
        policies.profiles.push(profile.clone());
    }
    config.agent_policies = Some(policies);
    crate::config::save_config_to_path(&path, config)?;
    Ok(profile)
}

pub fn reset_policy_profile(profile_id: &str) -> Result<AgentPolicyProfile, String> {
    let default = default_profiles()
        .into_iter()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| format!("profile not found: {profile_id}"))?;
    save_policy_profile(default.clone())?;
    Ok(default)
}

fn export_policy_bundle_from_config(
    config: &AppConfig,
    client_type: AgentClientType,
    workspace_id: Option<String>,
) -> Result<AgentPolicyExportBundle, String> {
    let policies = config
        .agent_policies
        .clone()
        .unwrap_or_else(default_agent_policies);
    let profile = policies
        .profiles
        .iter()
        .find(|profile| profile.client_type == client_type && profile.enabled)
        .cloned()
        .ok_or_else(|| {
            format!(
                "no enabled profile found for client type: {}",
                client_type.as_str()
            )
        })?;

    let workspace = match workspace_id.as_ref() {
        Some(id) => Some(
            config
                .workspaces
                .iter()
                .find(|workspace| &workspace.id == id)
                .ok_or_else(|| format!("workspace not found: {id}"))?,
        ),
        None => None,
    };

    let workspace_name = workspace
        .map(|workspace| workspace.name.clone())
        .unwrap_or_else(|| "Mini-Term".into());
    let workspace_id_value = workspace.map(|workspace| workspace.id.clone());
    let workspace_override = workspace_id_value
        .as_deref()
        .and_then(|workspace_id| find_workspace_override(&policies, workspace_id, &profile.id));
    let prompt_style = workspace_override
        .map(|item| item.prompt_style.clone())
        .unwrap_or(PromptStyle::Balanced);
    let extra_instructions = workspace_override
        .map(|item| item.extra_instructions.clone())
        .unwrap_or_default();
    let target = match client_type {
        AgentClientType::Claude => TaskTarget::Claude,
        _ => TaskTarget::Codex,
    };
    let rendered_sections = render_prompt_sections(
        &profile,
        workspace_id_value.as_deref().unwrap_or("workspace"),
        &workspace_name,
        &target,
        &TaskContextPreset::Standard,
        &prompt_style,
        &extra_instructions,
        preset_template(
            &policies.task_injection,
            &target,
            &TaskContextPreset::Standard,
        ),
    );
    let platform_prompt = rendered_sections.platform_prompt.clone();
    let tool_policy_prompt = rendered_sections.tool_policy_prompt.clone();
    let client_wrapper_prompt = rendered_sections.client_wrapper_prompt.clone();
    let system_prompt = append_workspace_override(
        format!(
            "{}\n\n{}\n\n{}",
            platform_prompt, tool_policy_prompt, client_wrapper_prompt
        ),
        &rendered_sections.workspace_override_prompt,
    );
    let skill_text = append_workspace_override(
        format!(
            "{}\n\n{}",
            tool_policy_prompt,
            render_template(
                &profile.skill_template,
                workspace_id_value.as_deref().unwrap_or("workspace"),
                &workspace_name,
                &profile.client_type,
                &target,
                &TaskContextPreset::Standard,
                &profile.tool_usage_policy,
            )
        ),
        &rendered_sections.workspace_override_prompt,
    );
    let mcp_instructions = append_workspace_override(
        render_template(
            &profile.mcp_instructions_template,
            workspace_id_value.as_deref().unwrap_or("workspace"),
            &workspace_name,
            &profile.client_type,
            &target,
            &TaskContextPreset::Standard,
            &profile.tool_usage_policy,
        ),
        &rendered_sections.workspace_override_prompt,
    );
    let effective_policy_summary = build_effective_policy_summary(
        &profile,
        &TaskContextPreset::Standard,
        Some(&prompt_style),
        &rendered_sections.workspace_override_prompt,
    );
    let mcp_launch = resolve_mcp_launch();
    let mcp_config_json = build_mcp_config_json(&mcp_launch)?;

    Ok(AgentPolicyExportBundle {
        client_type,
        profile,
        workspace_id: workspace_id_value,
        workspace_name: workspace.map(|workspace| workspace.name.clone()),
        platform_prompt,
        tool_policy_prompt,
        client_wrapper_prompt,
        task_preset_templates: effective_preset_policies(&policies.task_injection, &target).clone(),
        system_prompt,
        skill_text,
        mcp_instructions,
        workspace_override_prompt: rendered_sections.workspace_override_prompt,
        effective_policy_summary,
        mcp_launch,
        mcp_config_json,
    })
}

pub fn export_policy_bundle(
    client_type: AgentClientType,
    workspace_id: Option<String>,
) -> Result<AgentPolicyExportBundle, String> {
    let config = load_config_from_path(&config_path());
    export_policy_bundle_from_config(&config, client_type, workspace_id)
}

pub fn install_mcp_client_config(
    client_type: AgentClientType,
) -> Result<McpClientInstallResult, String> {
    let home_dir = dirs::home_dir()
        .ok_or_else(|| "failed to resolve the current user home directory".to_string())?;
    let launch = resolve_client_install_launch(&client_type)?;
    let files = match client_type {
        AgentClientType::Codex => install_codex_mcp_config_at(&home_dir, &launch)?,
        AgentClientType::Claude => install_claude_mcp_config_at(&home_dir, &launch)?,
        _ => {
            return Err(format!(
                "One-click MCP injection is currently supported only for Codex and Claude, not {}.",
                client_type.as_str()
            ));
        }
    };

    Ok(McpClientInstallResult {
        client_type,
        server_name: MCP_SERVER_NAME.to_string(),
        files,
        launch,
    })
}

pub fn get_effective_policy_for_task(task_id: &str) -> Result<TaskEffectivePolicy, String> {
    let task = get_task_detail(task_id).ok_or_else(|| format!("task not found: {task_id}"))?;
    Ok(TaskEffectivePolicy {
        task_id: task.summary.task_id.clone(),
        injection_profile_id: task.summary.injection_profile_id.clone(),
        injection_preset: task.summary.injection_preset.clone(),
        policy_summary: task.summary.policy_summary.clone(),
        is_injected: task.summary.injection_profile_id.is_some(),
    })
}

pub fn build_injected_prompt(
    workspace_id: &str,
    target: TaskTarget,
    preset: TaskContextPreset,
    prompt: &str,
) -> Result<TaskInjectionPreview, String> {
    let config = load_config_from_path(&config_path());
    let workspace = config
        .workspaces
        .iter()
        .find(|workspace| workspace.id == workspace_id)
        .ok_or_else(|| format!("workspace not found: {workspace_id}"))?;
    let policies = config
        .agent_policies
        .clone()
        .unwrap_or_else(default_agent_policies);
    if !policies.task_injection.enabled || !task_targets_match(&policies.task_injection, &target) {
        return Ok(TaskInjectionPreview {
            profile_id: String::new(),
            client_type: match target {
                TaskTarget::Codex => AgentClientType::Codex,
                TaskTarget::Claude => AgentClientType::Claude,
            },
            preset,
            workspace_id: workspace_id.to_string(),
            workspace_name: workspace.name.clone(),
            policy_summary: "Task injection disabled".to_string(),
            rendered_sections: RenderedPromptSections {
                platform_prompt: String::new(),
                tool_policy_prompt: String::new(),
                client_wrapper_prompt: String::new(),
                task_preset_prompt: String::new(),
                workspace_override_prompt: String::new(),
            },
            final_prompt: prompt.trim().to_string(),
        });
    }
    build_task_injection_preview_from_config(&config, workspace_id, target, preset, prompt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{AppConfig, WorkspaceConfig, WorkspaceRootConfig};
    use std::collections::BTreeMap;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn create_temp_dir(label: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("mini-term-policy-{label}-{unique}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn make_config(
        workspace_root: &std::path::Path,
        policies: Option<AgentPoliciesConfig>,
    ) -> AppConfig {
        let mut config = AppConfig::default();
        config.workspaces = vec![WorkspaceConfig {
            id: "workspace-1".into(),
            name: "mini-term".into(),
            roots: vec![WorkspaceRootConfig {
                id: "root-1".into(),
                name: "mini-term".into(),
                path: workspace_root.to_string_lossy().to_string(),
                role: "primary".into(),
            }],
            pinned: false,
            accent: None,
            saved_layout: None,
            expanded_dirs_by_root: BTreeMap::new(),
            created_at: 1,
            last_opened_at: 1,
        }];
        config.agent_policies = Some(policies.unwrap_or_else(default_agent_policies));
        config
    }

    fn setup_config() -> (AppConfig, std::path::PathBuf) {
        let workspace_root = create_temp_dir("workspace");
        (make_config(&workspace_root, None), workspace_root)
    }

    fn sample_stdio_launch() -> McpLaunchInfo {
        McpLaunchInfo {
            status: "resolved".into(),
            transport: "stdio".into(),
            command: Some("cargo".into()),
            args: vec![
                "run".into(),
                "--manifest-path".into(),
                "D:/code/JavaScript/mini-term/src-tauri/Cargo.toml".into(),
                "--bin".into(),
                "mini-term-mcp".into(),
            ],
            url: None,
            cwd: Some("D:/code/JavaScript/mini-term".into()),
            notes: Some("Resolved from test fixture".into()),
        }
    }

    #[test]
    fn default_policies_have_four_profiles() {
        assert_eq!(default_agent_policies().profiles.len(), 4);
    }

    #[test]
    fn task_injection_preview_contains_policy_summary() {
        let (config, workspace_root) = setup_config();
        let preview = build_task_injection_preview_from_config(
            &config,
            "workspace-1",
            TaskTarget::Codex,
            TaskContextPreset::Review,
            "Fix the bug",
        )
        .unwrap();

        assert!(preview.final_prompt.contains("Mini-Term runtime policy"));
        assert!(preview.policy_summary.contains("profile"));
        assert!(preview.final_prompt.contains("Task mode: review"));

        let _ = fs::remove_dir_all(workspace_root);
    }

    #[test]
    fn export_bundle_contains_config_json() {
        let (config, workspace_root) = setup_config();
        let bundle = export_policy_bundle_from_config(
            &config,
            AgentClientType::Codex,
            Some("workspace-1".into()),
        )
        .unwrap();
        assert!(bundle.mcp_config_json.contains("\"mini-term\""));
        assert!(bundle.system_prompt.contains("Mini-Term"));
        assert!(bundle.system_prompt.contains("## Tool Groups"));
        assert!(bundle.platform_prompt.contains("## Role"));
        assert!(bundle.tool_policy_prompt.contains("## Tool Groups"));
        assert!(bundle.client_wrapper_prompt.contains("## Client Role"));
        assert!(bundle
            .task_preset_templates
            .review
            .contains("Task mode: review"));
        assert!(bundle.skill_text.contains("Approval rules"));
        assert!(!bundle.effective_policy_summary.is_empty());
        assert!(!bundle.mcp_launch.status.is_empty());
        #[cfg(target_os = "windows")]
        {
            assert_eq!(bundle.mcp_launch.transport, "http");
            assert_eq!(
                bundle.mcp_launch.url.as_deref(),
                Some("http://127.0.0.1:8765/mcp")
            );
            assert!(bundle
                .mcp_launch
                .args
                .iter()
                .any(|item| item.contains("mini-term-mcp-http")));
            assert!(bundle.mcp_config_json.contains("\"type\": \"http\""));
        }
        #[cfg(not(target_os = "windows"))]
        {
            assert_eq!(bundle.mcp_launch.transport, "stdio");
            assert!(bundle.mcp_config_json.contains("\"type\": \"stdio\""));
        }

        let _ = fs::remove_dir_all(workspace_root);
    }

    #[test]
    fn export_bundle_includes_workspace_override() {
        let workspace_root = create_temp_dir("override-workspace");

        let mut policies = default_agent_policies();
        policies.workspace_overrides.push(WorkspacePolicyOverride {
            workspace_id: "workspace-1".into(),
            profile_id: "codex-default".into(),
            enabled_tools: Vec::new(),
            extra_instructions: "Always mention the deployment checklist.".into(),
            prompt_style: PromptStyle::Balanced,
        });
        let config = make_config(&workspace_root, Some(policies));
        let bundle = export_policy_bundle_from_config(
            &config,
            AgentClientType::Codex,
            Some("workspace-1".into()),
        )
        .unwrap();
        assert!(
            bundle
                .workspace_override_prompt
                .contains("deployment checklist"),
            "workspace override prompt was {:?}",
            bundle.workspace_override_prompt
        );
        assert!(bundle.system_prompt.contains("Workspace Override"));
        assert!(bundle.skill_text.contains("Workspace Override"));
        assert!(bundle.mcp_instructions.contains("Workspace Override"));
        assert!(bundle
            .effective_policy_summary
            .contains("balanced workspace override"));

        let _ = fs::remove_dir_all(workspace_root);
    }

    #[test]
    fn export_bundle_requires_valid_workspace_when_workspace_id_is_provided() {
        let (config, workspace_root) = setup_config();
        let error = export_policy_bundle_from_config(
            &config,
            AgentClientType::Codex,
            Some("missing".into()),
        )
        .unwrap_err();

        assert_eq!(error, "workspace not found: missing");

        let _ = fs::remove_dir_all(workspace_root);
    }

    #[test]
    fn prompt_style_changes_override_rendering_for_preview_and_export() {
        let workspace_root = create_temp_dir("style-workspace");
        let mut policies = default_agent_policies();
        policies.workspace_overrides.push(WorkspacePolicyOverride {
            workspace_id: "workspace-1".into(),
            profile_id: "codex-default".into(),
            enabled_tools: Vec::new(),
            extra_instructions: "Always include the release checklist.".into(),
            prompt_style: PromptStyle::Strict,
        });
        let config = make_config(&workspace_root, Some(policies));

        let preview = build_task_injection_preview_from_config(
            &config,
            "workspace-1",
            TaskTarget::Codex,
            TaskContextPreset::Standard,
            "Review the changes",
        )
        .unwrap();
        let bundle = export_policy_bundle_from_config(
            &config,
            AgentClientType::Codex,
            Some("workspace-1".into()),
        )
        .unwrap();

        assert!(preview
            .rendered_sections
            .workspace_override_prompt
            .contains("Workspace Override (Strict)"));
        assert!(preview.final_prompt.contains("mandatory additions"));
        assert!(bundle
            .effective_policy_summary
            .contains("strict workspace override"));
        assert!(bundle
            .workspace_override_prompt
            .contains("mandatory additions"));

        let _ = fs::remove_dir_all(workspace_root);
    }

    #[test]
    fn task_injection_preview_uses_target_specific_profile_binding() {
        let workspace_root = create_temp_dir("binding-workspace");
        let mut policies = default_agent_policies();
        let custom_profile = AgentPolicyProfile {
            id: "codex-reviewer".into(),
            display_name: "Codex Reviewer".into(),
            client_wrapper_prompt_template: "## Client Role\nYou are the bound Codex reviewer."
                .into(),
            ..get_default_policy_profile("codex-default").unwrap()
        };
        policies.profiles.push(custom_profile);
        policies.task_injection.profile_bindings.codex = Some("codex-reviewer".into());
        let config = make_config(&workspace_root, Some(policies));

        let preview = build_task_injection_preview_from_config(
            &config,
            "workspace-1",
            TaskTarget::Codex,
            TaskContextPreset::Standard,
            "Inspect the workspace",
        )
        .unwrap();

        assert_eq!(preview.profile_id, "codex-reviewer");
        assert!(preview.policy_summary.contains("Codex Reviewer profile"));
        assert!(preview
            .rendered_sections
            .client_wrapper_prompt
            .contains("bound Codex reviewer"));

        let _ = fs::remove_dir_all(workspace_root);
    }

    #[test]
    fn task_injection_preview_uses_target_specific_preset_override() {
        let workspace_root = create_temp_dir("preset-workspace");
        let mut policies = default_agent_policies();
        policies.task_injection.target_preset_policies.claude = Some(PresetPolicyTemplates {
            light: "Claude light override".into(),
            standard: "Claude standard override".into(),
            review: "Claude review override".into(),
        });
        let config = make_config(&workspace_root, Some(policies));

        let preview = build_task_injection_preview_from_config(
            &config,
            "workspace-1",
            TaskTarget::Claude,
            TaskContextPreset::Review,
            "Review the patch",
        )
        .unwrap();
        let bundle = export_policy_bundle_from_config(
            &config,
            AgentClientType::Claude,
            Some("workspace-1".into()),
        )
        .unwrap();

        assert_eq!(
            preview.rendered_sections.task_preset_prompt,
            "Claude review override"
        );
        assert!(preview.final_prompt.contains("Claude review override"));
        assert_eq!(
            bundle.task_preset_templates.review,
            "Claude review override"
        );

        let _ = fs::remove_dir_all(workspace_root);
    }

    #[test]
    fn codex_mcp_install_creates_and_updates_config() {
        let home_dir = create_temp_dir("codex-home");
        let launch = sample_stdio_launch();
        let config_path = home_dir.join(".codex").join("config.toml");
        fs::create_dir_all(config_path.parent().unwrap()).unwrap();
        fs::write(
            &config_path,
            "model = \"gpt-5\"\n\n[mcp_servers.github]\ncommand = \"uvx\"\n",
        )
        .unwrap();

        let created = install_codex_mcp_config_at(&home_dir, &launch).unwrap();
        assert_eq!(created.len(), 1);
        assert!(!created[0].created);
        assert!(created[0].updated);

        let config: toml::Value =
            toml::from_str(&fs::read_to_string(&config_path).unwrap()).unwrap();
        let root = config.as_table().unwrap();
        assert_eq!(
            root.get("model").and_then(toml::Value::as_str),
            Some("gpt-5")
        );
        let mcp_servers = root
            .get("mcp_servers")
            .and_then(toml::Value::as_table)
            .unwrap();
        assert!(mcp_servers.contains_key("github"));
        let mini_term = mcp_servers
            .get("mini-term")
            .and_then(toml::Value::as_table)
            .unwrap();
        assert_eq!(
            mini_term.get("command").and_then(toml::Value::as_str),
            Some("cargo")
        );
        assert_eq!(
            mini_term
                .get("startup_timeout_sec")
                .and_then(toml::Value::as_integer),
            Some(MCP_INSTALL_STARTUP_TIMEOUT_SEC)
        );

        let unchanged = install_codex_mcp_config_at(&home_dir, &launch).unwrap();
        assert!(!unchanged[0].created);
        assert!(!unchanged[0].updated);

        let _ = fs::remove_dir_all(home_dir);
    }

    #[test]
    fn claude_mcp_install_updates_primary_and_catalog_files() {
        let home_dir = create_temp_dir("claude-home");
        let launch = sample_stdio_launch();
        let claude_dir = home_dir.join(".claude");
        fs::create_dir_all(claude_dir.join("mcp-configs")).unwrap();
        fs::write(
            home_dir.join(".claude.json"),
            "{\n  \"model\": \"sonnet[1m]\"\n}\n",
        )
        .unwrap();

        let files = install_claude_mcp_config_at(&home_dir, &launch).unwrap();
        assert_eq!(files.len(), 2);
        assert!(files.iter().any(|item| item.kind == "primary"));
        assert!(files.iter().any(|item| item.kind == "catalog"));

        let primary: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(home_dir.join(".claude.json")).unwrap())
                .unwrap();
        assert_eq!(
            primary.get("model").and_then(serde_json::Value::as_str),
            Some("sonnet[1m]")
        );
        let primary_server = primary
            .get("mcpServers")
            .and_then(serde_json::Value::as_object)
            .and_then(|servers| servers.get("mini-term"))
            .and_then(serde_json::Value::as_object)
            .unwrap();
        assert_eq!(
            primary_server
                .get("type")
                .and_then(serde_json::Value::as_str),
            Some("stdio")
        );
        assert_eq!(
            primary_server
                .get("command")
                .and_then(serde_json::Value::as_str),
            Some("cargo")
        );

        let catalog_path = claude_dir.join("mcp-configs").join("mcp-servers.json");
        let catalog: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&catalog_path).unwrap()).unwrap();
        assert!(catalog
            .get("mcpServers")
            .and_then(serde_json::Value::as_object)
            .map(|servers| servers.contains_key("mini-term"))
            .unwrap_or(false));

        let unchanged = install_claude_mcp_config_at(&home_dir, &launch).unwrap();
        assert!(unchanged.iter().all(|item| !item.created && !item.updated));

        let _ = fs::remove_dir_all(home_dir);
    }

    #[test]
    fn resolve_client_install_launch_rejects_unsupported_clients() {
        let error = resolve_client_install_launch(&AgentClientType::Cursor).unwrap_err();
        assert!(error.contains("supported only for Codex and Claude"));
    }

    #[test]
    fn default_profile_lookup_returns_layered_templates() {
        let profile = get_default_policy_profile("codex-default").unwrap();

        assert!(profile.platform_prompt_template.contains("## Role"));
        assert!(profile
            .tool_policy_prompt_template
            .contains("## Tool Groups"));
        assert!(profile
            .client_wrapper_prompt_template
            .contains("## Client Role"));
    }
}
