use crate::agent_ext::model_gateway::{
    ModelGatewayProviderKind, DEFAULT_ANTHROPIC_BASE_URL, DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
};
use reqwest::blocking::Client;
use serde_json::{json, Value};
use std::time::Duration;

const DEFAULT_PROVIDER_TIMEOUT_MS: u64 = 60_000;

#[derive(Debug, Clone)]
pub struct ProviderContextSnapshot {
    pub task_title: String,
    pub cwd: String,
    pub original_prompt: String,
    pub inferred_preset: String,
    pub workspace_name: Option<String>,
    pub workspace_id: Option<String>,
    pub instruction_count: usize,
    pub related_file_count: usize,
    pub recent_session_count: usize,
    pub repo_count: usize,
    pub changed_file_count: usize,
    pub recent_event_kinds: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct ProviderReply {
    pub provider_label: String,
    pub message: String,
}

#[derive(Debug, Clone)]
pub enum SidecarProvider {
    Reference,
    OpenAiCompatible(OpenAiCompatibleProvider),
    Anthropic(AnthropicProvider),
}

#[derive(Debug, Clone)]
pub struct OpenAiCompatibleProvider {
    client: Client,
    base_url: String,
    api_key: String,
    model: String,
    system_prompt: String,
}

#[derive(Debug, Clone)]
pub struct AnthropicProvider {
    client: Client,
    base_url: String,
    api_key: String,
    model: String,
    system_prompt: String,
}

impl SidecarProvider {
    pub fn from_env() -> Result<Self, String> {
        let provider = std::env::var("MINI_TERM_SIDECAR_PROVIDER")
            .unwrap_or_else(|_| ModelGatewayProviderKind::Reference.as_str().to_string())
            .trim()
            .to_ascii_lowercase();
        let kind = ModelGatewayProviderKind::parse(&provider)
            .ok_or_else(|| format!("unsupported MINI_TERM_SIDECAR_PROVIDER value: {provider}"))?;

        match kind {
            ModelGatewayProviderKind::Reference => Ok(Self::Reference),
            ModelGatewayProviderKind::OpenAiCompatible => {
                Ok(Self::OpenAiCompatible(OpenAiCompatibleProvider::from_env()?))
            }
            ModelGatewayProviderKind::Anthropic => {
                Ok(Self::Anthropic(AnthropicProvider::from_env()?))
            }
        }
    }

    pub fn label(&self) -> String {
        match self {
            Self::Reference => ModelGatewayProviderKind::Reference.as_str().to_string(),
            Self::OpenAiCompatible(provider) => {
                format!(
                    "{}/{}",
                    ModelGatewayProviderKind::OpenAiCompatible.as_str(),
                    provider.model
                )
            }
            Self::Anthropic(provider) => {
                format!(
                    "{}/{}",
                    ModelGatewayProviderKind::Anthropic.as_str(),
                    provider.model
                )
            }
        }
    }

    pub fn generate_reply(
        &self,
        context: &ProviderContextSnapshot,
        user_input: &str,
    ) -> Result<ProviderReply, String> {
        match self {
            Self::Reference => Ok(ProviderReply {
                provider_label: self.label(),
                message: build_reference_reply(context, user_input),
            }),
            Self::OpenAiCompatible(provider) => provider.generate_reply(context, user_input),
            Self::Anthropic(provider) => provider.generate_reply(context, user_input),
        }
    }
}

impl OpenAiCompatibleProvider {
    fn from_env() -> Result<Self, String> {
        let base_url = std::env::var("MINI_TERM_SIDECAR_BASE_URL")
            .unwrap_or_else(|_| DEFAULT_OPENAI_COMPATIBLE_BASE_URL.to_string())
            .trim()
            .trim_end_matches('/')
            .to_string();
        let api_key = read_required_env(
            "MINI_TERM_SIDECAR_API_KEY",
            "MINI_TERM_SIDECAR_API_KEY is required for openai-compatible provider",
        )?;
        let model = read_required_env(
            "MINI_TERM_SIDECAR_MODEL",
            "MINI_TERM_SIDECAR_MODEL is required for openai-compatible provider",
        )?;
        let system_prompt = read_system_prompt();

        Ok(Self {
            client: build_client(provider_timeout_ms())?,
            base_url,
            api_key,
            model,
            system_prompt,
        })
    }

    fn generate_reply(
        &self,
        context: &ProviderContextSnapshot,
        user_input: &str,
    ) -> Result<ProviderReply, String> {
        let response = self
            .client
            .post(format!("{}/chat/completions", self.base_url))
            .bearer_auth(&self.api_key)
            .json(&json!({
                "model": self.model,
                "messages": [
                    {
                        "role": "system",
                        "content": self.system_prompt,
                    },
                    {
                        "role": "user",
                        "content": build_remote_user_prompt(context, user_input),
                    }
                ]
            }))
            .send()
            .map_err(|err| format!("provider request failed: {err}"))?;

        let response = response
            .error_for_status()
            .map_err(|err| format!("provider returned HTTP error: {err}"))?;
        let payload = response
            .json::<Value>()
            .map_err(|err| format!("failed to decode provider response: {err}"))?;
        let message = extract_chat_completion_text(&payload)
            .ok_or_else(|| "provider response did not contain assistant text".to_string())?;

        Ok(ProviderReply {
            provider_label: format!(
                "{}/{}",
                ModelGatewayProviderKind::OpenAiCompatible.as_str(),
                self.model
            ),
            message,
        })
    }
}

impl AnthropicProvider {
    fn from_env() -> Result<Self, String> {
        let base_url = std::env::var("MINI_TERM_SIDECAR_BASE_URL")
            .unwrap_or_else(|_| DEFAULT_ANTHROPIC_BASE_URL.to_string())
            .trim()
            .trim_end_matches('/')
            .to_string();
        let api_key = read_required_env(
            "MINI_TERM_SIDECAR_API_KEY",
            "MINI_TERM_SIDECAR_API_KEY is required for anthropic provider",
        )?;
        let model = read_required_env(
            "MINI_TERM_SIDECAR_MODEL",
            "MINI_TERM_SIDECAR_MODEL is required for anthropic provider",
        )?;
        let system_prompt = read_system_prompt();

        Ok(Self {
            client: build_client(provider_timeout_ms())?,
            base_url,
            api_key,
            model,
            system_prompt,
        })
    }

    fn generate_reply(
        &self,
        context: &ProviderContextSnapshot,
        user_input: &str,
    ) -> Result<ProviderReply, String> {
        let response = self
            .client
            .post(format!("{}/messages", self.base_url))
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&json!({
                "model": self.model,
                "max_tokens": 1024,
                "system": self.system_prompt,
                "messages": [
                    {
                        "role": "user",
                        "content": build_remote_user_prompt(context, user_input),
                    }
                ]
            }))
            .send()
            .map_err(|err| format!("provider request failed: {err}"))?;

        let response = response
            .error_for_status()
            .map_err(|err| format!("provider returned HTTP error: {err}"))?;
        let payload = response
            .json::<Value>()
            .map_err(|err| format!("failed to decode provider response: {err}"))?;
        let message = extract_anthropic_text(&payload)
            .ok_or_else(|| "provider response did not contain assistant text".to_string())?;

        Ok(ProviderReply {
            provider_label: format!(
                "{}/{}",
                ModelGatewayProviderKind::Anthropic.as_str(),
                self.model
            ),
            message,
        })
    }
}

fn provider_timeout_ms() -> u64 {
    std::env::var("MINI_TERM_SIDECAR_PROVIDER_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_PROVIDER_TIMEOUT_MS)
}

fn build_client(timeout_ms: u64) -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .build()
        .map_err(|err| format!("failed to build provider client: {err}"))
}

fn read_required_env(key: &'static str, error: &'static str) -> Result<String, String> {
    let value = std::env::var(key).map_err(|_| error.to_string())?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(error.to_string());
    }
    Ok(trimmed.to_string())
}

fn read_system_prompt() -> String {
    std::env::var("MINI_TERM_SIDECAR_SYSTEM_PROMPT")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(default_system_prompt)
}

fn default_system_prompt() -> String {
    "You are the model behind Mini-Term's claude-sidecar backend. Reply concisely in plain text. You cannot call tools directly. If you need a host action, tell the user which Mini-Term sidecar command to use: /status, /review, /plan, /write-demo, /retry-write, /exit.".to_string()
}

fn build_reference_reply(context: &ProviderContextSnapshot, user_input: &str) -> String {
    let workspace = context
        .workspace_name
        .as_deref()
        .unwrap_or("unresolved workspace");
    let events = if context.recent_event_kinds.is_empty() {
        "none".to_string()
    } else {
        context.recent_event_kinds.join(", ")
    };
    format!(
        "Reference provider reply\n- input: {user_input}\n- workspace: {workspace}\n- cwd: {}\n- instructions: {}\n- related files: {}\n- changed files: {}\n- recent events: {events}\nUse /review to refresh Mini-Term context or /plan to persist an updated plan document.",
        context.cwd,
        context.instruction_count,
        context.related_file_count,
        context.changed_file_count
    )
}

fn build_remote_user_prompt(context: &ProviderContextSnapshot, user_input: &str) -> String {
    let workspace_name = context.workspace_name.as_deref().unwrap_or("unresolved");
    let workspace_id = context.workspace_id.as_deref().unwrap_or("unknown");
    let recent_events = if context.recent_event_kinds.is_empty() {
        "none".to_string()
    } else {
        context.recent_event_kinds.join(", ")
    };
    format!(
        "Mini-Term sidecar context:\n- task title: {}\n- original prompt: {}\n- cwd: {}\n- inferred preset: {}\n- workspace: {} ({})\n- instructions: {}\n- related files: {}\n- recent sessions: {}\n- repositories: {}\n- changed files: {}\n- recent runtime events: {}\n\nUser input:\n{}",
        context.task_title,
        context.original_prompt,
        context.cwd,
        context.inferred_preset,
        workspace_name,
        workspace_id,
        context.instruction_count,
        context.related_file_count,
        context.recent_session_count,
        context.repo_count,
        context.changed_file_count,
        recent_events,
        user_input
    )
}

fn extract_chat_completion_text(payload: &Value) -> Option<String> {
    let content = payload
        .get("choices")?
        .as_array()?
        .first()?
        .get("message")?
        .get("content")?;

    match content {
        Value::String(text) => Some(text.trim().to_string()).filter(|text| !text.is_empty()),
        Value::Array(parts) => {
            let joined = parts
                .iter()
                .filter_map(|part| {
                    part.get("text")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .or_else(|| {
                            part.get("content")
                                .and_then(Value::as_str)
                                .map(str::to_string)
                        })
                })
                .collect::<Vec<_>>()
                .join("");
            Some(joined.trim().to_string()).filter(|text| !text.is_empty())
        }
        _ => None,
    }
}

fn extract_anthropic_text(payload: &Value) -> Option<String> {
    let content = payload.get("content")?.as_array()?;
    let joined = content
        .iter()
        .filter_map(|part| {
            if part.get("type").and_then(Value::as_str) == Some("text") {
                part.get("text").and_then(Value::as_str).map(str::to_string)
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("");
    Some(joined.trim().to_string()).filter(|text| !text.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
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

        fn remove(key: &'static str) -> Self {
            let previous = std::env::var(key).ok();
            std::env::remove_var(key);
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
    fn extracts_chat_completion_text_from_string_and_array_content() {
        let string_payload = json!({
            "choices": [{ "message": { "content": "hello world" } }]
        });
        let array_payload = json!({
            "choices": [{ "message": { "content": [
                { "type": "text", "text": "hello " },
                { "type": "text", "text": "world" }
            ] } }]
        });

        assert_eq!(
            extract_chat_completion_text(&string_payload).as_deref(),
            Some("hello world")
        );
        assert_eq!(
            extract_chat_completion_text(&array_payload).as_deref(),
            Some("hello world")
        );
    }

    #[test]
    fn extracts_anthropic_text_from_content_array() {
        let payload = json!({
            "content": [
                { "type": "text", "text": "hello " },
                { "type": "text", "text": "anthropic" }
            ]
        });

        assert_eq!(
            extract_anthropic_text(&payload).as_deref(),
            Some("hello anthropic")
        );
    }

    #[test]
    fn provider_defaults_to_reference_when_env_is_missing() {
        let _guard = env_lock().lock().unwrap();
        let _provider = EnvVarGuard::remove("MINI_TERM_SIDECAR_PROVIDER");
        let _key = EnvVarGuard::remove("MINI_TERM_SIDECAR_API_KEY");
        let _model = EnvVarGuard::remove("MINI_TERM_SIDECAR_MODEL");

        let provider = SidecarProvider::from_env().unwrap();
        assert_eq!(provider.label(), "reference");
    }

    #[test]
    fn openai_provider_requires_model_and_api_key() {
        let _guard = env_lock().lock().unwrap();
        let _provider = EnvVarGuard::set("MINI_TERM_SIDECAR_PROVIDER", "openai-compatible");
        let _key = EnvVarGuard::remove("MINI_TERM_SIDECAR_API_KEY");
        let _model = EnvVarGuard::remove("MINI_TERM_SIDECAR_MODEL");

        let error = SidecarProvider::from_env().unwrap_err();
        assert!(error.contains("MINI_TERM_SIDECAR_API_KEY"));
    }

    #[test]
    fn anthropic_provider_requires_model_and_api_key() {
        let _guard = env_lock().lock().unwrap();
        let _provider = EnvVarGuard::set("MINI_TERM_SIDECAR_PROVIDER", "anthropic");
        let _key = EnvVarGuard::remove("MINI_TERM_SIDECAR_API_KEY");
        let _model = EnvVarGuard::remove("MINI_TERM_SIDECAR_MODEL");

        let error = SidecarProvider::from_env().unwrap_err();
        assert!(error.contains("MINI_TERM_SIDECAR_API_KEY"));
    }
}
