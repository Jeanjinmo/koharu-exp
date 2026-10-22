//! Loopback Model Context Protocol server that exposes a [`Host`]'s tools to
//! external agents over Streamable HTTP.

mod activity;
mod calls;
mod clients;
mod handler;
mod registration;
mod supervisor;
#[cfg(test)]
mod tests;
mod token;

use std::{
    convert::Infallible,
    fs::OpenOptions,
    io::Write as _,
    net::{Ipv4Addr, SocketAddr},
    path::Path,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
};

use anyhow::{Context as _, Result};
use http_body_util::{BodyExt as _, Full, combinators::BoxBody};
use hyper::{
    Method, Request, Response, StatusCode,
    body::{Bytes, Frame, Incoming, SizeHint},
    header::{HeaderValue, WWW_AUTHENTICATE},
    server::conn::http1,
    service::service_fn,
};
use hyper_util::rt::TokioIo;
use rmcp::transport::{
    StreamableHttpServerConfig, StreamableHttpService,
    streamable_http_server::session::local::LocalSessionManager,
};
use serde_json::json;
use tokio::{
    net::{TcpListener, TcpStream},
    sync::watch,
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;

use crate::{Config, Host, Tool};

use self::{activity::ActivityLog, calls::Calls, clients::Clients, handler::Handler, token::Token};
pub use self::{
    activity::ToolActivity,
    registration::McpClient,
    supervisor::{ServerStatus, Supervisor},
};

const PATH: &str = "/mcp";
const POINTER: &str = "mcp.json";

type Body = BoxBody<Bytes, Infallible>;

/// What every MCP session of one Koharu process works with.
struct Shared<H> {
    host: H,
    config: koharu_config::Config<Config>,
    activity: ActivityLog,
}

impl<H> Shared<H>
where
    H: Host,
{
    /// The host tools that MCP clients may list and call.
    fn enabled_tools(&self) -> Result<Vec<Tool>> {
        let config = self.config.read()?;
        Ok(self
            .host
            .tools()
            .into_iter()
            .filter(|tool| config.mcp.enables(tool))
            .collect())
    }

    /// Whether the host offers `name` but Koharu's settings disable it.
    fn disables(&self, name: &str) -> Result<bool> {
        let config = self.config.read()?;
        Ok(self
            .host
            .tools()
            .iter()
            .any(|tool| tool.name == name && !config.mcp.enables(tool)))
    }
}

/// A running MCP server. Dropping it stops accepting connections and closes
/// every open MCP session.
struct Server {
    address: SocketAddr,
    shutdown: CancellationToken,
    calls: Arc<Calls>,
    clients: Arc<Clients>,
    /// Answers to client messages that are still being sent.
    answers: Arc<watch::Sender<usize>>,
}

impl Server {
    async fn bind<H>(shared: Arc<Shared<H>>, port: u16, token: Token) -> Result<Self>
    where
        H: Host,
    {
        let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
        let listener = TcpListener::bind(address).await.with_context(|| {
            format!("failed to listen on {address}; another program may already be using this port")
        })?;
        let address = listener.local_addr()?;
        let shutdown = CancellationToken::new();
        let (calls, clients) = (Calls::new(), Clients::new());
        let config = StreamableHttpServerConfig::default()
            .with_allowed_hosts(["127.0.0.1", "localhost"])
            .enforce_origin_validation()
            .with_cancellation_token(shutdown.child_token());
        let service = StreamableHttpService::new(
            {
                let (shared, calls, clients) = (shared.clone(), calls.clone(), clients.clone());
                move || Ok(Handler::new(shared.clone(), calls.clone(), clients.clone()))
            },
            Arc::default(),
            config,
        );
        let answers = Arc::new(watch::Sender::new(0));
        drop(tokio::spawn(accept(
            listener,
            Arc::new(Endpoint {
                service,
                token,
                answers: answers.clone(),
            }),
            shutdown.clone(),
        )));
        drop(tokio::spawn(announce_tool_changes(
            shared,
            clients.clone(),
            shutdown.clone(),
        )));
        Ok(Self {
            address,
            shutdown,
            calls,
            clients,
            answers,
        })
    }

    fn url(&self) -> String {
        format!("http://{}{PATH}", self.address)
    }

    /// Waits until the answers being sent have reached their clients, or
    /// `patience` runs out, so closing the server does not cut them off.
    async fn deliver_answers(&self, patience: std::time::Duration) {
        let mut answers = self.answers.subscribe();
        let _ = tokio::time::timeout(patience, answers.wait_for(|open| *open == 0)).await;
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}

/// Tells connected clients when the tools they may use change, so clients
/// that honor `notifications/tools/list_changed` refresh their tool list.
async fn announce_tool_changes<H>(
    shared: Arc<Shared<H>>,
    clients: Arc<Clients>,
    shutdown: CancellationToken,
) where
    H: Host,
{
    let names = || {
        shared
            .enabled_tools()
            .map(|tools| tools.into_iter().map(|tool| tool.name).collect::<Vec<_>>())
            .ok()
    };
    let mut revisions = shared.config.subscribe();
    let mut announced = names();
    loop {
        tokio::select! {
            () = shutdown.cancelled() => return,
            changed = revisions.changed() => if changed.is_err() {
                return;
            },
        }
        let current = names();
        if current != announced {
            announced = current;
            clients.announce_tool_list_change().await;
        }
    }
}

/// Admits only authenticated requests for [`PATH`]. rmcp then rejects
/// non-loopback `Host` headers and every request that carries an `Origin`.
struct Endpoint<H> {
    service: StreamableHttpService<Handler<H>, LocalSessionManager>,
    token: Token,
    answers: Arc<watch::Sender<usize>>,
}

impl<H> Endpoint<H>
where
    H: Host,
{
    async fn respond(&self, request: Request<Incoming>) -> Response<Body> {
        if request.uri().path() != PATH {
            return text(StatusCode::NOT_FOUND, "Not Found");
        }
        if !self.token.authorizes(request.headers()) {
            let mut response = text(StatusCode::UNAUTHORIZED, "Unauthorized");
            response
                .headers_mut()
                .insert(WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
            return response;
        }
        // A POST carries a client message, and its response streams the
        // answer, such as a tool's result. A GET stream only carries
        // notifications and stays open, so it is not an answer.
        let answer = (request.method() == Method::POST).then(|| Answer::new(&self.answers));
        let response = self.service.handle(request).await;
        match answer {
            Some(answer) => response.map(|body| {
                Answered {
                    body,
                    answer: Some(answer),
                }
                .boxed()
            }),
            None => response,
        }
    }
}

/// One answer being sent; it is done when dropped.
struct Answer(Arc<watch::Sender<usize>>);

impl Answer {
    fn new(answers: &Arc<watch::Sender<usize>>) -> Self {
        answers.send_modify(|open| *open += 1);
        Self(answers.clone())
    }
}

impl Drop for Answer {
    fn drop(&mut self) {
        self.0.send_modify(|open| *open -= 1);
    }
}

/// A response body that counts as an answer being sent until its last frame
/// has been taken, or the connection drops it.
struct Answered {
    body: Body,
    answer: Option<Answer>,
}

impl hyper::body::Body for Answered {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        let this = self.get_mut();
        let frame = Pin::new(&mut this.body).poll_frame(context);
        if let Poll::Ready(None) = frame {
            this.answer = None;
        }
        frame
    }

    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.body.size_hint()
    }
}

async fn accept<H>(listener: TcpListener, endpoint: Arc<Endpoint<H>>, shutdown: CancellationToken)
where
    H: Host,
{
    // Dropping the set when the server shuts down aborts its open connections.
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            () = shutdown.cancelled() => break,
            Some(_) = connections.join_next() => {}
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    connections.spawn(connect(stream, endpoint.clone()));
                }
                Err(error) => tracing::warn!(%error, "MCP server failed to accept a connection"),
            },
        }
    }
}

async fn connect<H>(stream: TcpStream, endpoint: Arc<Endpoint<H>>)
where
    H: Host,
{
    let service = service_fn(move |request| {
        let endpoint = endpoint.clone();
        async move { Ok::<_, Infallible>(endpoint.respond(request).await) }
    });
    if let Err(error) = http1::Builder::new()
        .serve_connection(TokioIo::new(stream), service)
        .await
    {
        tracing::debug!(%error, "MCP connection closed with an error");
    }
}

fn text(status: StatusCode, body: &'static str) -> Response<Body> {
    let mut response = Response::new(Full::new(Bytes::from_static(body.as_bytes())).boxed());
    *response.status_mut() = status;
    response
}

fn write_pointer(path: &Path, url: &str, token: &Token) -> Result<()> {
    let contents = serde_json::to_vec_pretty(&json!({ "url": url, "token": token.expose() }))?;
    write_private(path, &contents).with_context(|| format!("failed to write {}", path.display()))
}

// The pointer file holds the bearer token, so only the current user may read it.
fn write_private(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(path)?;
    #[cfg(unix)]
    file.set_permissions(std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
    file.write_all(contents)
}
