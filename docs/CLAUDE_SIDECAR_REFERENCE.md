# Claude Sidecar Reference

Mini-Term now includes a repository-local reference sidecar binary for the `claude-sidecar` backend.

## Start Command

From the repository root:

```powershell
npm run agent:claude-sidecar
```

Direct Cargo equivalent:

```powershell
cargo run --manifest-path src-tauri/Cargo.toml --bin mini-term-claude-sidecar
```

## Purpose

This reference process is not a full Claude replacement. It is a protocol-faithful sidecar meant to validate Mini-Term's sidecar runtime, brokered tool calls, plan persistence, approval loop, and task lifecycle.

## What It Does

- replies with a valid `handshake`
- emits `started`, `output`, `attention`, and `exited` events
- calls Mini-Term tools through the sidecar broker
- saves a task plan artifact with `save_task_plan`
- demonstrates approval-gated writes with `write_file`

## Interactive Commands

After the sidecar task is running, send input from the task panel:

```text
/status
/review
/plan
/write-demo [path]
/retry-write <approval-request-id>
/exit
```

## Suggested Sidecar Config

- `Command`: `cargo`
- `Args JSON`:

```json
[
  "run",
  "--manifest-path",
  "src-tauri/Cargo.toml",
  "--bin",
  "mini-term-claude-sidecar"
]
```

- `Working Directory`: repository root
- `Env JSON`: optional provider selection and model credentials passed directly to the sidecar process

## Provider Modes

The reference binary keeps slash commands local and only routes free-form input through a configurable provider.

- `reference`
  - default mode
  - offline and deterministic
  - good for validating Mini-Term's sidecar protocol, brokered tools, plan persistence, and approval flow
- `openai-compatible`
  - uses a Chat Completions compatible endpoint for free-form input
  - keeps `/status`, `/review`, `/plan`, `/write-demo`, `/retry-write`, and `/exit` handled locally inside the sidecar

## Env Contract

Set these values in the Claude Sidecar `Env JSON` field inside Mini-Term settings:

- `MINI_TERM_SIDECAR_PROVIDER`
  - optional
  - default: `reference`
  - supported values: `reference`, `openai-compatible`
- `MINI_TERM_SIDECAR_API_KEY`
  - required for `openai-compatible`
- `MINI_TERM_SIDECAR_MODEL`
  - required for `openai-compatible`
- `MINI_TERM_SIDECAR_BASE_URL`
  - optional
  - default: `https://api.openai.com/v1`
- `MINI_TERM_SIDECAR_PROVIDER_TIMEOUT_MS`
  - optional
  - default: `60000`
- `MINI_TERM_SIDECAR_SYSTEM_PROMPT`
  - optional
  - overrides the default provider system prompt

Example `Env JSON`:

```json
{
  "MINI_TERM_SIDECAR_PROVIDER": "openai-compatible",
  "MINI_TERM_SIDECAR_BASE_URL": "https://api.openai.com/v1",
  "MINI_TERM_SIDECAR_MODEL": "gpt-4.1-mini",
  "MINI_TERM_SIDECAR_API_KEY": "<YOUR_API_KEY>",
  "MINI_TERM_SIDECAR_PROVIDER_TIMEOUT_MS": "60000"
}
```

In `reference` mode, none of the model-related environment variables are required.

Run `测试启动 / 握手` in Mini-Term settings after saving the config.
