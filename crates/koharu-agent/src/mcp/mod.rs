//! Loopback Model Context Protocol server that exposes a [`Host`]'s tools to
//! external agents over Streamable HTTP.

mod activity;
mod calls;
mod clients;
mod handler;
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
    sync::Arc,
};

use anyhow::{Context as _, Result};
use http_body_util::{BodyExt as _, Full, combinators::BoxBody};
use hyper::{
    Request, Response, StatusCode,
    body::{Bytes, Incoming},
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
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;

use crate::{Config, Host, Tool};

use self::{activity::ActivityLog, calls::Calls, clients::Clients, handler::Handler, token::Token};
pub use self::{
    activity::ToolActivity,
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
        drop(tokio::spawn(accept(
            listener,
            Arc::new(Endpoint { service, token }),
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
        })
    }

    fn url(&self) -> String {
        format!("http://{}{PATH}", self.address)
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
        self.service.handle(request).await
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
