//! What registers Koharu's MCP server with an MCP client: the server's URL and
//! the bearer token it requires, in the form each client takes. Koharu only
//! composes the text; it never reads or writes a client's files.

use koharu_secrets::SecretString;
use serde::Deserialize;
use serde_json::json;
use specta::Type;

/// How long Hermes waits for one tool call, in seconds; pipeline runs can take
/// longer than its default.
const HERMES_TIMEOUT: u32 = 900;

/// A client whose registration of the server can be copied.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Type)]
#[serde(rename_all = "snake_case")]
pub enum McpClient {
    /// The `mcpServers` JSON that most clients read.
    Json,
    /// A `claude mcp add` command.
    ClaudeCode,
    /// A `grok mcp add` command.
    GrokBuild,
    /// The server's entry in Hermes's `config.yaml`.
    Hermes,
}

pub(super) fn registration(client: McpClient, url: &str, token: &str) -> SecretString {
    let authorization = format!("Bearer {token}");
    SecretString::from(match client {
        McpClient::Json => format!(
            "{:#}",
            json!({
                "mcpServers": {
                    "koharu": {
                        "type": "http",
                        "url": url,
                        "headers": { "Authorization": authorization },
                    },
                },
            })
        ),
        McpClient::ClaudeCode => format!(
            "claude mcp add --transport http --scope user koharu {url} --header \"Authorization: {authorization}\""
        ),
        McpClient::GrokBuild => format!(
            "grok mcp add --transport http koharu {url} --header \"Authorization: {authorization}\""
        ),
        McpClient::Hermes => format!(
            "mcp_servers:\n  koharu:\n    url: \"{url}\"\n    headers:\n      Authorization: \"{authorization}\"\n    timeout: {HERMES_TIMEOUT}\n"
        ),
    })
}

#[cfg(test)]
mod tests {
    use koharu_secrets::ExposeSecret as _;
    use serde_json::Value;

    use super::*;

    const URL: &str = "http://127.0.0.1:23001/mcp";
    const TOKEN: &str = "Zm9vYmFy-token_1";

    fn text(client: McpClient) -> String {
        registration(client, URL, TOKEN).expose_secret().to_owned()
    }

    #[test]
    fn every_client_gets_the_url_and_the_token() {
        let json: Value = serde_json::from_str(&text(McpClient::Json)).unwrap();
        assert_eq!(
            json,
            json!({
                "mcpServers": {
                    "koharu": {
                        "type": "http",
                        "url": URL,
                        "headers": { "Authorization": format!("Bearer {TOKEN}") },
                    },
                },
            })
        );
        assert_eq!(
            text(McpClient::ClaudeCode),
            format!(
                "claude mcp add --transport http --scope user koharu {URL} --header \"Authorization: Bearer {TOKEN}\""
            )
        );
        assert_eq!(
            text(McpClient::GrokBuild),
            format!(
                "grok mcp add --transport http koharu {URL} --header \"Authorization: Bearer {TOKEN}\""
            )
        );
        assert_eq!(
            text(McpClient::Hermes),
            format!(
                "mcp_servers:\n  koharu:\n    url: \"{URL}\"\n    headers:\n      Authorization: \"Bearer {TOKEN}\"\n    timeout: 900\n"
            )
        );
    }

    #[test]
    fn the_text_never_shows_in_debug_output() {
        assert!(!format!("{:?}", registration(McpClient::Json, URL, TOKEN)).contains(TOKEN));
    }
}
