use std::{sync::Arc, time::Duration};

use anyhow::{Context as _, Result, bail};
use async_trait::async_trait;
use reqwest::{StatusCode, header};
use rmcp::{
    RoleClient, ServiceExt as _,
    model::{CallToolRequest, CallToolRequestParams, ClientRequest, ContentBlock},
    service::{PeerRequestOptions, RunningService},
    transport::{
        StreamableHttpClientTransport, streamable_http_client::StreamableHttpClientTransportConfig,
    },
};
use serde_json::{Value, json};
use tokio::sync::Notify;

use super::{Server, Token, write_pointer};
use crate::{Control, Host, Invocation, Tool, ToolCall};

/// The tool names Koharu's desktop host exposes, in order.
pub(super) const TOOLS: [&str; 14] = [
    "inspect_project",
    "view_page",
    "rename_page",
    "move_page",
    "delete_pages",
    "add_text_box",
    "set_source_text",
    "set_translation",
    "set_typography",
    "set_geometry",
    "set_visibility",
    "delete_elements",
    "move_element",
    "run_pipeline",
];

/// Base64 payload of a 1x1 WebP image.
pub(super) const PIXEL: &str = "UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=";

const INITIALIZE: &str = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"koharu-test","version":"0"}}}"#;

/// Stand-in for Koharu's desktop host. `run_pipeline` blocks until its
/// control is cancelled, like the real pipeline tool.
#[derive(Default)]
pub(super) struct FakeHost {
    started: Arc<Notify>,
    cancelled: Arc<Notify>,
}

#[async_trait]
impl Host for FakeHost {
    async fn context(&self) -> Result<Value> {
        Ok(json!({}))
    }

    fn tools(&self) -> Vec<Tool> {
        TOOLS
            .into_iter()
            .map(|name| {
                Tool::new(
                    name,
                    format!("Fake {name}."),
                    json!({ "type": "object", "properties": {} }),
                )
            })
            .collect()
    }

    async fn invoke(&self, call: ToolCall, control: &Control) -> Result<Invocation> {
        match call.name.as_str() {
            "inspect_project" => Invocation::read(json!({ "pages": [] })),
            "view_page" => Ok(Invocation::read(json!({ "page": "page" }))?
                .with_image("Rendered page", format!("data:image/webp;base64,{PIXEL}"))),
            "set_translation" => {
                Invocation::changed(serde_json::from_str::<Value>(&call.arguments)?)
            }
            "run_pipeline" => {
                self.started.notify_one();
                control.cancelled().await;
                self.cancelled.notify_one();
                bail!("pipeline processing was cancelled")
            }
            name => bail!("unknown Koharu tool {name}"),
        }
    }
}

async fn start(host: FakeHost) -> Result<(Server, Token)> {
    let token = Token::generate();
    let server = Server::bind(Arc::new(host), 0, token.clone()).await?;
    Ok((server, token))
}

async fn connect(server: &Server, token: &Token) -> Result<RunningService<RoleClient, ()>> {
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(server.url()).auth_header(token.expose()),
    );
    Ok(().serve(transport).await?)
}

async fn initialize(url: &str, headers: &[(&str, &str)]) -> Result<reqwest::Response> {
    let mut request = reqwest::Client::builder()
        .no_proxy()
        .build()?
        .post(url)
        .header(header::ACCEPT, "application/json, text/event-stream")
        .header(header::CONTENT_TYPE, "application/json")
        .body(INITIALIZE);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    Ok(request.send().await?)
}

#[tokio::test]
async fn client_initializes_lists_and_calls_tools() -> Result<()> {
    let (server, token) = start(FakeHost::default()).await?;
    let client = connect(&server, &token).await?;

    let info = client.peer_info().context("server did not initialize")?;
    assert_eq!(
        info.server_info.as_ref().map(|server| server.name.as_str()),
        Some("koharu")
    );
    assert!(
        info.instructions
            .as_deref()
            .is_some_and(|instructions| instructions.contains("inspect_project"))
    );

    let tools = client.list_all_tools().await?;
    assert_eq!(
        tools
            .iter()
            .map(|tool| tool.name.as_ref())
            .collect::<Vec<_>>(),
        TOOLS
    );

    let arguments = json!({ "element": "element", "text": "Hello" });
    let result = client
        .call_tool(
            CallToolRequestParams::new("set_translation")
                .with_arguments(arguments.as_object().cloned().context("object")?),
        )
        .await?;
    assert_eq!(result.is_error, Some(false));
    assert_eq!(
        result.content,
        vec![ContentBlock::text(arguments.to_string())]
    );

    let result = client
        .call_tool(CallToolRequestParams::new("view_page"))
        .await?;
    assert_eq!(
        result.content,
        vec![
            ContentBlock::text(json!({ "page": "page" }).to_string()),
            ContentBlock::image(PIXEL, "image/webp"),
        ]
    );

    let result = client
        .call_tool(CallToolRequestParams::new("missing_tool"))
        .await?;
    assert_eq!(result.is_error, Some(true));
    assert_eq!(
        result.content,
        vec![ContentBlock::text("unknown Koharu tool missing_tool")]
    );

    client.cancel().await?;
    Ok(())
}

#[tokio::test]
async fn cancelled_requests_cancel_the_host_control() -> Result<()> {
    let host = FakeHost::default();
    let (started, cancelled) = (host.started.clone(), host.cancelled.clone());
    let (server, token) = start(host).await?;
    let client = connect(&server, &token).await?;

    let request = client
        .send_cancellable_request(
            ClientRequest::from(CallToolRequest::new(CallToolRequestParams::new(
                "run_pipeline",
            ))),
            PeerRequestOptions::no_options(),
        )
        .await?;
    tokio::time::timeout(Duration::from_secs(5), started.notified()).await?;
    request.cancel(None).await?;
    tokio::time::timeout(Duration::from_secs(5), cancelled.notified()).await?;

    client.cancel().await?;
    Ok(())
}

#[tokio::test]
async fn unauthenticated_requests_are_rejected() -> Result<()> {
    let (server, token) = start(FakeHost::default()).await?;
    let authorization = format!("Bearer {}", token.expose());

    let accepted = initialize(&server.url(), &[("authorization", &authorization)]).await?;
    assert_eq!(accepted.status(), StatusCode::OK);

    let missing = initialize(&server.url(), &[]).await?;
    assert_eq!(missing.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        missing.headers().get(header::WWW_AUTHENTICATE),
        Some(&header::HeaderValue::from_static("Bearer"))
    );

    let wrong = format!("Bearer {}", Token::generate().expose());
    let wrong = initialize(&server.url(), &[("authorization", &wrong)]).await?;
    assert_eq!(wrong.status(), StatusCode::UNAUTHORIZED);

    let other_scheme = format!("Basic {}", token.expose());
    let other_scheme = initialize(&server.url(), &[("authorization", &other_scheme)]).await?;
    assert_eq!(other_scheme.status(), StatusCode::UNAUTHORIZED);
    Ok(())
}

#[tokio::test]
async fn browser_and_foreign_host_requests_are_rejected() -> Result<()> {
    let (server, token) = start(FakeHost::default()).await?;
    let authorization = format!("Bearer {}", token.expose());

    for origin in ["http://localhost", "http://127.0.0.1:3000", "null"] {
        let response = initialize(
            &server.url(),
            &[("authorization", &authorization), ("origin", origin)],
        )
        .await?;
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "origin {origin}");
    }

    let response = initialize(
        &server.url(),
        &[
            ("authorization", &authorization),
            ("host", "attacker.example"),
        ],
    )
    .await?;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    Ok(())
}

#[tokio::test]
async fn other_paths_are_not_served() -> Result<()> {
    let (server, token) = start(FakeHost::default()).await?;
    let authorization = format!("Bearer {}", token.expose());
    let url = server.url().replace("/mcp", "/other");

    let response = initialize(&url, &[("authorization", &authorization)]).await?;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    Ok(())
}

#[test]
fn pointer_records_url_and_token_privately() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let path = directory.path().join(".koharu").join("mcp.json");
    let token = Token::generate();

    write_pointer(&path, "http://127.0.0.1:47821/mcp", &token)?;

    let pointer: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    assert_eq!(
        pointer,
        json!({ "url": "http://127.0.0.1:47821/mcp", "token": token.expose() })
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        assert_eq!(
            std::fs::metadata(&path)?.permissions().mode() & 0o777,
            0o600
        );
    }
    Ok(())
}

#[test]
fn generated_tokens_are_random_and_url_safe() {
    let (first, second) = (Token::generate(), Token::generate());
    assert_ne!(first.expose(), second.expose());
    assert_eq!(first.expose().len(), 43);
    assert!(
        first
            .expose()
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    );
}
