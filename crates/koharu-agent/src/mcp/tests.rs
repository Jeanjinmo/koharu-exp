use std::{collections::BTreeSet, path::Path, sync::Arc, time::Duration};

use anyhow::{Context as _, Result, bail};
use async_trait::async_trait;
use reqwest::{StatusCode, header};
use rmcp::{
    ClientHandler, RoleClient, ServiceExt as _,
    model::{CallToolRequest, CallToolRequestParams, ClientRequest, ContentBlock, ServerResult},
    service::{NotificationContext, PeerRequestOptions, RunningService},
    transport::{
        StreamableHttpClientTransport, streamable_http_client::StreamableHttpClientTransportConfig,
    },
};
use serde_json::{Value, json};
use tokio::sync::{Notify, watch};

use super::{ActivityLog, Server, ServerStatus, Shared, Supervisor, Token, write_pointer};
use crate::{
    Config, Control, Host, Invocation, McpConfig, Tool, ToolCall, ToolGroup, ToolMetadata,
    ToolProfile, Vision,
};

/// A representative subset of the tools Koharu's desktop host exposes, in order.
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
/// control is cancelled, like the real pipeline tool, and `move_page` until
/// it is released.
#[derive(Default)]
pub(super) struct FakeHost {
    started: Arc<Notify>,
    cancelled: Arc<Notify>,
    release: Arc<Notify>,
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
                    metadata(name),
                )
            })
            .collect()
    }

    async fn invoke(&self, call: ToolCall, control: &Control) -> Result<Invocation> {
        match call.name.as_str() {
            "inspect_project" => Invocation::read(json!({ "pages": [] })),
            "view_page" => Ok(Invocation::read(json!({ "page": "page" }))?
                .with_image("Rendered page", format!("data:image/webp;base64,{PIXEL}"))),
            "set_translation" => Ok(Invocation::changed(serde_json::from_str::<Value>(
                &call.arguments,
            )?)?
            .on_page("page")),
            "run_pipeline" => {
                self.started.notify_one();
                control.cancelled().await;
                self.cancelled.notify_one();
                bail!("pipeline processing was cancelled")
            }
            "move_page" => {
                self.started.notify_one();
                self.release.notified().await;
                Invocation::changed(json!({ "moved": true }))
            }
            name => bail!("unknown Koharu tool {name}"),
        }
    }
}

pub(super) fn metadata(name: &str) -> ToolMetadata {
    ToolMetadata {
        group: match name {
            "inspect_project" | "view_page" => ToolGroup::Read,
            "rename_page" | "move_page" | "delete_pages" => ToolGroup::Pages,
            "run_pipeline" => ToolGroup::Pipeline,
            _ => ToolGroup::Text,
        },
        vision: if name == "view_page" {
            Vision::Required
        } else {
            Vision::None
        },
        mutates_image: name == "run_pipeline",
        destructive: matches!(name, "delete_pages" | "delete_elements"),
    }
}

fn config(mcp: McpConfig) -> koharu_config::Config<Config> {
    koharu_config::Config::memory(Config {
        mcp,
        ..Config::default()
    })
}

async fn start(host: FakeHost) -> Result<(Server, Token)> {
    let token = Token::generate();
    let shared = Arc::new(Shared {
        host,
        config: config(McpConfig::default()),
        activity: ActivityLog::new(),
    });
    let server = Server::bind(shared, 0, token.clone()).await?;
    Ok((server, token))
}

async fn connect(server: &Server, token: &Token) -> Result<RunningService<RoleClient, ()>> {
    connect_as((), &server.url(), token).await
}

async fn connect_as<C>(client: C, url: &str, token: &Token) -> Result<RunningService<RoleClient, C>>
where
    C: ClientHandler,
{
    let transport = StreamableHttpClientTransport::from_config(
        StreamableHttpClientTransportConfig::with_uri(url).auth_header(token.expose()),
    );
    Ok(client.serve(transport).await?)
}

/// A client that records `notifications/tools/list_changed`.
#[derive(Clone, Default)]
struct Listener {
    tools_changed: Arc<Notify>,
}

impl ClientHandler for Listener {
    async fn on_tool_list_changed(&self, _context: NotificationContext<RoleClient>) {
        self.tools_changed.notify_one();
    }
}

fn supervise(
    host: FakeHost,
    mcp: McpConfig,
    pointer: &Path,
) -> Result<(Supervisor<FakeHost>, Token)> {
    let token = Token::generate();
    let supervisor = Supervisor::for_test(host, config(mcp), token.clone(), pointer.to_owned())?;
    Ok((supervisor, token))
}

async fn reaches(
    status: &mut watch::Receiver<ServerStatus>,
    expected: impl Fn(&ServerStatus) -> bool,
) -> Result<ServerStatus> {
    let status = tokio::time::timeout(Duration::from_secs(10), status.wait_for(expected))
        .await
        .context("the MCP server did not reach the expected status")??;
    Ok(status.clone())
}

fn running_url(status: &ServerStatus) -> Option<&str> {
    match status {
        ServerStatus::Running { url, .. } => Some(url),
        _ => None,
    }
}

fn text_of(content: &[ContentBlock]) -> Option<&str> {
    content
        .first()
        .and_then(|block| block.as_text())
        .map(|text| text.text.as_str())
}

fn free_port() -> Result<u16> {
    Ok(std::net::TcpListener::bind("127.0.0.1:0")?
        .local_addr()?
        .port())
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

#[tokio::test]
async fn disabled_tools_are_hidden_refused_and_announced() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let (supervisor, token) = supervise(
        FakeHost::default(),
        McpConfig {
            port: 0,
            ..McpConfig::default()
        },
        &directory.path().join("mcp.json"),
    )?;
    let running = reaches(&mut supervisor.status(), |status| {
        running_url(status).is_some()
    })
    .await?;
    let listener = Listener::default();
    let client = connect_as(
        listener.clone(),
        running_url(&running).context("url")?,
        &token,
    )
    .await?;
    assert_eq!(client.list_all_tools().await?.len(), TOOLS.len());

    supervisor.set_tools(ToolProfile::Text, BTreeSet::new())?;
    tokio::time::timeout(Duration::from_secs(10), listener.tools_changed.notified())
        .await
        .context("the client was not told that the tools changed")?;

    let tools = client.list_all_tools().await?;
    assert_eq!(tools.len(), TOOLS.len() - 1);
    assert!(tools.iter().all(|tool| tool.name != "view_page"));
    let refused = client
        .call_tool(CallToolRequestParams::new("view_page"))
        .await?;
    assert_eq!(refused.is_error, Some(true));
    assert_eq!(
        text_of(&refused.content),
        Some("Tool `view_page` is disabled in Koharu settings")
    );
    client.cancel().await?;
    Ok(())
}

#[tokio::test]
async fn finished_calls_are_logged_without_their_arguments() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let (supervisor, token) = supervise(
        FakeHost::default(),
        McpConfig {
            port: 0,
            profile: ToolProfile::Read,
            ..McpConfig::default()
        },
        &directory.path().join("mcp.json"),
    )?;
    let running = reaches(&mut supervisor.status(), |status| {
        running_url(status).is_some()
    })
    .await?;
    let client = connect_as((), running_url(&running).context("url")?, &token).await?;
    let mut recorded = supervisor.subscribe_activity();

    client
        .call_tool(CallToolRequestParams::new("inspect_project"))
        .await?;
    client
        .call_tool(
            CallToolRequestParams::new("set_translation").with_arguments(
                json!({ "text": "secret" })
                    .as_object()
                    .cloned()
                    .context("object")?,
            ),
        )
        .await?;
    supervisor.set_tools(ToolProfile::Vision, BTreeSet::new())?;
    client
        .call_tool(
            CallToolRequestParams::new("set_translation").with_arguments(
                json!({ "text": "secret" })
                    .as_object()
                    .cloned()
                    .context("object")?,
            ),
        )
        .await?;

    let activity = supervisor.activity();
    assert_eq!(
        activity
            .iter()
            .map(|entry| (
                entry.tool.as_str(),
                entry.ok,
                entry.changed,
                entry.page.as_deref()
            ))
            .collect::<Vec<_>>(),
        [
            ("inspect_project", true, false, None),
            ("set_translation", false, false, None),
            ("set_translation", true, true, Some("page")),
        ]
    );
    assert_eq!(
        activity[1].error.as_deref(),
        Some("Tool `set_translation` is disabled in Koharu settings")
    );
    assert!(!format!("{activity:?}").contains("secret"));
    assert_eq!(recorded.recv().await?.tool, "inspect_project");

    supervisor.clear_activity();
    assert!(supervisor.activity().is_empty());
    client.cancel().await?;
    Ok(())
}

#[tokio::test]
async fn stopping_waits_for_running_calls_and_stop_now_cancels_them() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let pointer = directory.path().join("mcp.json");
    let host = FakeHost::default();
    let (started, cancelled) = (host.started.clone(), host.cancelled.clone());
    let (supervisor, token) = supervise(
        host,
        McpConfig {
            port: 0,
            ..McpConfig::default()
        },
        &pointer,
    )?;
    let mut status = supervisor.status();
    let running = reaches(&mut status, |status| running_url(status).is_some()).await?;
    let url = running_url(&running).context("url")?.to_owned();
    let client = connect_as((), &url, &token).await?;
    let pipeline = client
        .send_cancellable_request(
            ClientRequest::from(CallToolRequest::new(CallToolRequestParams::new(
                "run_pipeline",
            ))),
            PeerRequestOptions::no_options(),
        )
        .await?;
    tokio::time::timeout(Duration::from_secs(5), started.notified()).await?;

    supervisor.set_enabled(false)?;
    reaches(&mut status, |status| {
        *status == ServerStatus::Stopping { tasks: 1 }
    })
    .await?;
    let refused = client
        .call_tool(CallToolRequestParams::new("inspect_project"))
        .await?;
    assert_eq!(refused.is_error, Some(true));
    assert!(text_of(&refused.content).is_some_and(|text| text.contains("stopping")));

    supervisor.stop_now();
    tokio::time::timeout(Duration::from_secs(5), cancelled.notified()).await?;
    // The client still learns that its call was cancelled.
    let ServerResult::CallToolResult(cancelled) =
        tokio::time::timeout(Duration::from_secs(5), pipeline.await_response()).await??
    else {
        bail!("the pipeline call got no tool result");
    };
    assert_eq!(cancelled.is_error, Some(true));
    assert!(text_of(&cancelled.content).is_some_and(|text| text.contains("cancelled")));
    reaches(&mut status, |status| *status == ServerStatus::Off).await?;
    eventually(|| async { initialize(&url, &[]).await.is_err() })
        .await
        .context("the port stays open")?;

    supervisor.set_enabled(true)?;
    let restarted = reaches(&mut status, |status| running_url(status).is_some()).await?;
    let pointer: Value = serde_json::from_slice(&std::fs::read(&pointer)?)?;
    assert_eq!(pointer["token"], json!(token.expose()));
    assert_eq!(
        pointer["url"],
        json!(running_url(&restarted).context("url")?)
    );
    Ok(())
}

#[tokio::test]
async fn stopping_answers_running_calls_before_closing() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let host = FakeHost::default();
    let (started, release) = (host.started.clone(), host.release.clone());
    let (supervisor, token) = supervise(
        host,
        McpConfig {
            port: 0,
            ..McpConfig::default()
        },
        &directory.path().join("mcp.json"),
    )?;
    let mut status = supervisor.status();
    let running = reaches(&mut status, |status| running_url(status).is_some()).await?;
    let client = connect_as((), running_url(&running).context("url")?, &token).await?;
    let slow = client
        .send_cancellable_request(
            ClientRequest::from(CallToolRequest::new(CallToolRequestParams::new(
                "move_page",
            ))),
            PeerRequestOptions::no_options(),
        )
        .await?;
    tokio::time::timeout(Duration::from_secs(5), started.notified()).await?;

    supervisor.set_enabled(false)?;
    reaches(&mut status, |status| {
        *status == ServerStatus::Stopping { tasks: 1 }
    })
    .await?;
    let refused = client
        .call_tool(CallToolRequestParams::new("inspect_project"))
        .await?;
    assert_eq!(refused.is_error, Some(true));

    // The running call finishes while the server stops, and its answer
    // reaches the client before the connection closes (#17).
    release.notify_one();
    let ServerResult::CallToolResult(answer) =
        tokio::time::timeout(Duration::from_secs(5), slow.await_response()).await??
    else {
        bail!("the running call got no tool result");
    };
    assert_ne!(answer.is_error, Some(true));
    assert!(text_of(&answer.content).is_some_and(|text| text.contains("moved")));
    reaches(&mut status, |status| *status == ServerStatus::Off).await?;
    Ok(())
}

#[tokio::test]
async fn busy_ports_fail_until_a_retry_succeeds() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let occupant = std::net::TcpListener::bind("127.0.0.1:0")?;
    let port = occupant.local_addr()?.port();
    let (supervisor, _token) = supervise(
        FakeHost::default(),
        McpConfig {
            port,
            ..McpConfig::default()
        },
        &directory.path().join("mcp.json"),
    )?;
    let mut status = supervisor.status();
    let failed = reaches(&mut status, |status| {
        matches!(status, ServerStatus::Failed { .. })
    })
    .await?;
    assert!(
        matches!(&failed, ServerStatus::Failed { message } if message.contains(&port.to_string())),
        "{failed:?}"
    );

    drop(occupant);
    supervisor.set_enabled(true)?;
    let running = reaches(&mut status, |status| running_url(status).is_some()).await?;
    assert_eq!(
        running_url(&running),
        Some(format!("http://127.0.0.1:{port}/mcp").as_str())
    );
    Ok(())
}

#[tokio::test]
async fn rapid_requests_settle_on_the_last_one_with_one_server() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let port = free_port()?;
    let (supervisor, token) = supervise(
        FakeHost::default(),
        McpConfig {
            port,
            ..McpConfig::default()
        },
        &directory.path().join("mcp.json"),
    )?;
    for enabled in [false, true, false, true, false, true] {
        supervisor.set_enabled(enabled)?;
    }
    // A second server could not bind the same port, so the last request
    // ending in a reachable server shows the transitions never overlapped.
    let url = format!("http://127.0.0.1:{port}/mcp");
    let authorization = format!("Bearer {}", token.expose());
    let status = supervisor.status();
    eventually(|| async {
        let running = running_url(&status.borrow()) == Some(url.as_str());
        running
            && initialize(&url, &[("authorization", &authorization)])
                .await
                .is_ok_and(|response| response.status() == StatusCode::OK)
    })
    .await
    .context("the last request did not leave one reachable server")?;
    Ok(())
}

async fn eventually<F, Check>(check: Check) -> Result<()>
where
    Check: Fn() -> F,
    F: Future<Output = bool>,
{
    tokio::time::timeout(Duration::from_secs(10), async {
        while !check().await {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await?;
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
