use anyhow::{Context as _, Result};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hyper::header::{AUTHORIZATION, HeaderMap};
use koharu_secrets::{ExposeSecret as _, SecretString};

const KEY: &str = "agent_mcp_token";

/// Bearer token that MCP clients must present. It is created once and kept in
/// the system keyring so registered clients keep working across restarts.
#[derive(Clone)]
pub(super) struct Token(SecretString);

impl Token {
    pub(super) fn load_or_create() -> Result<Self> {
        if let Some(stored) = koharu_secrets::get(KEY).context("failed to read the MCP token")?
            && !stored.expose_secret().is_empty()
        {
            return Ok(Self(stored));
        }
        let token = Self::generate();
        koharu_secrets::set(KEY, &token.0).context("failed to store the MCP token")?;
        Ok(token)
    }

    pub(super) fn generate() -> Self {
        Self(SecretString::from(
            URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>()),
        ))
    }

    pub(super) fn expose(&self) -> &str {
        self.0.expose_secret()
    }

    pub(super) fn authorizes(&self, headers: &HeaderMap) -> bool {
        headers
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split_once(' '))
            .is_some_and(|(scheme, presented)| {
                scheme.eq_ignore_ascii_case("bearer") && self.matches(presented.trim())
            })
    }

    // Compare without an early exit so response timing does not reveal how much
    // of a guessed token was correct.
    fn matches(&self, presented: &str) -> bool {
        let expected = self.expose().as_bytes();
        let presented = presented.as_bytes();
        expected.len() == presented.len()
            && expected
                .iter()
                .zip(presented)
                .fold(0, |difference, (left, right)| difference | (left ^ right))
                == 0
    }
}
