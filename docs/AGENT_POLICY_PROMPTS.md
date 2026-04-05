# Mini-Term Prompt Architecture

Mini-Term now manages prompts as a layered policy system instead of a single editable block. The same layered content drives:

- runtime task injection for Mini-Term managed `codex` and `claude` tasks
- exported client bundles for `codex`, `claude`, `cursor`, and `generic-mcp`
- the Agent / MCP settings page preview and reset workflow

## Layers

### 1. Platform Prompt

Defines:

- Mini-Term role as desktop workspace host and MCP control plane
- hard safety boundaries
- workspace-context-first behavior
- approval and review obligations

Required structure:

- `Role`
- `What Mini-Term Controls`
- `Hard Constraints`
- `Default Operating Order`
- `Approval and Review Rules`

### 2. Tool Policy Prompt

Defines:

- tool groups
- preferred tool order
- when to use read-only tools
- when to use tracked task tools
- when to stop for approval

The default sequence is:

1. `list_workspaces`
2. `get_workspace_context`
3. `read_file` / `search_files`
4. `get_git_summary` / `get_diff_for_review`
5. `start_task` / `get_task_status` / `send_task_input`

### 3. Client Wrapper Prompt

Adapts the platform baseline for one client type without changing core rules.

Current default profiles:

- `codex-default`
- `claude-default`
- `cursor-default`
- `generic-mcp-default`

Required structure:

- `Client Role`
- `How To Work With Mini-Term`
- `Biases To Correct`
- `Do / Do Not`

### 4. Task Injection Presets

Used only when Mini-Term starts and tracks a local task.

Available presets:

- `light`
- `standard`
- `review`

Preset responsibilities:

- `light`: narrow scope, minimal tool use, fast execution
- `standard`: full implementation workflow with context and approval discipline
- `review`: evidence-first review and diff inspection

## Runtime Composition Rules

### Exported client bundle

The exported bundle includes:

- `platformPrompt`
- `toolPolicyPrompt`
- `clientWrapperPrompt`
- `taskPresetTemplates`
- `systemPrompt`
- `skillText`
- `mcpInstructions`
- `mcpConfigJson`

`systemPrompt` is composed as:

- platform prompt
- tool policy prompt
- client wrapper prompt

### Runtime task injection

Mini-Term builds the final prompt in this order:

1. platform prompt
2. tool policy prompt
3. client wrapper prompt
4. selected task preset
5. workspace override extra instructions
6. user request and workspace context

## Guardrails

Workspace overrides may add instructions, but they may not remove:

- approval stop behavior
- review evidence requirements
- workspace context priority
- approval-gated tool risk semantics

## Authoring Rules

- Keep prompt language concrete and tool-specific.
- Do not restate MCP schemas in full.
- Use strong approval language instead of soft suggestions.
- Use review language that points to Mini-Term diff and git summary data.
- Treat Mini-Term as the operating control plane, not a passive plugin bundle.
