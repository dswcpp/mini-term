use serde::{Deserialize, Serialize};

pub const PROVIDER_KIND_REFERENCE: &str = "reference";
pub const PROVIDER_KIND_OPENAI_COMPATIBLE: &str = "openai-compatible";
pub const PROVIDER_KIND_ANTHROPIC: &str = "anthropic";

pub const DEFAULT_OPENAI_COMPATIBLE_BASE_URL: &str = "https://api.openai.com/v1";
pub const DEFAULT_ANTHROPIC_BASE_URL: &str = "https://api.anthropic.com";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ModelGatewayProviderKind {
    Reference,
    OpenAiCompatible,
    Anthropic,
}

impl ModelGatewayProviderKind {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "" | PROVIDER_KIND_REFERENCE => Some(Self::Reference),
            PROVIDER_KIND_OPENAI_COMPATIBLE => Some(Self::OpenAiCompatible),
            PROVIDER_KIND_ANTHROPIC => Some(Self::Anthropic),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Reference => PROVIDER_KIND_REFERENCE,
            Self::OpenAiCompatible => PROVIDER_KIND_OPENAI_COMPATIBLE,
            Self::Anthropic => PROVIDER_KIND_ANTHROPIC,
        }
    }

    pub fn default_base_url(self) -> Option<&'static str> {
        match self {
            Self::Reference => None,
            Self::OpenAiCompatible => Some(DEFAULT_OPENAI_COMPATIBLE_BASE_URL),
            Self::Anthropic => Some(DEFAULT_ANTHROPIC_BASE_URL),
        }
    }

    pub fn requires_model(self) -> bool {
        !matches!(self, Self::Reference)
    }

    pub fn requires_api_key(self) -> bool {
        !matches!(self, Self::Reference)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_supported_provider_kinds() {
        assert_eq!(
            ModelGatewayProviderKind::parse("reference"),
            Some(ModelGatewayProviderKind::Reference)
        );
        assert_eq!(
            ModelGatewayProviderKind::parse("openai-compatible"),
            Some(ModelGatewayProviderKind::OpenAiCompatible)
        );
        assert_eq!(
            ModelGatewayProviderKind::parse("anthropic"),
            Some(ModelGatewayProviderKind::Anthropic)
        );
        assert_eq!(
            ModelGatewayProviderKind::parse(""),
            Some(ModelGatewayProviderKind::Reference)
        );
        assert_eq!(ModelGatewayProviderKind::parse("unknown"), None);
    }
}
