//! Starts and stops the MCP server as Koharu's settings ask. One task owns the
//! server and performs one transition at a time, so rapid requests can never
//! run two servers and the last request decides the final state.

use std::{
    collections::BTreeSet,
    path::PathBuf,
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};

use anyhow::{Context as _, Result, bail};
use serde::Serialize;
use specta::Type;
use tokio::{
    sync::{broadcast, watch},
    time::Instant,
};

use super::{ActivityLog, Calls, POINTER, Server, Shared, Token, ToolActivity, write_pointer};
use crate::{Config, Host, Tool, ToolProfile};

/// How long a busy port is retried before starting fails.
const BIND_PATIENCE: Duration = Duration::from_secs(3);
const BIND_RETRY: Duration = Duration::from_millis(500);
/// How often a running server forgets clients whose session has closed.
const PRUNE_INTERVAL: Duration = Duration::from_secs(5);
/// How long stopping waits for finished calls' answers to reach their clients.
const ANSWER_PATIENCE: Duration = Duration::from_secs(3);

/// What the MCP server is doing, as shown in Koharu's settings.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Type)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ServerStatus {
    Off,
    Starting,
    Running {
        url: String,
        clients: u32,
    },
    /// New tool calls are refused while `tasks` running calls finish.
    Stopping {
        tasks: u32,
    },
    Failed {
        message: String,
    },
}

#[derive(Clone, Copy, Debug, Default)]
struct Request {
    enabled: bool,
    /// Counts requests to start, so a failed start is only retried when asked.
    attempt: u64,
    shutdown: bool,
}

/// Owns the MCP server's lifecycle for one Koharu process.
pub struct Supervisor<H> {
    inner: Arc<Inner<H>>,
    requests: watch::Sender<Request>,
}

struct Inner<H> {
    shared: Arc<Shared<H>>,
    /// Cached after the first start, so restarts keep the token clients hold.
    token: Mutex<Option<Token>>,
    /// Where the URL and token are recorded; `None` means `~/.koharu/mcp.json`.
    pointer: Option<PathBuf>,
    status: watch::Sender<ServerStatus>,
    /// The calls of a server that is waiting for them before it stops.
    stopping: Mutex<Option<Arc<Calls>>>,
}

enum Phase {
    Off,
    Failed { attempt: u64 },
    Running(Server),
}

impl<H> Supervisor<H>
where
    H: Host,
{
    /// Supervises an MCP server for `host`, starting it now when the
    /// configuration enables it.
    pub fn new(host: H, config: koharu_config::Config<Config>) -> Result<Self> {
        Self::spawn(host, config, None, None)
    }

    fn spawn(
        host: H,
        config: koharu_config::Config<Config>,
        token: Option<Token>,
        pointer: Option<PathBuf>,
    ) -> Result<Self> {
        let enabled = config.read()?.mcp.enabled;
        let inner = Arc::new(Inner {
            shared: Arc::new(Shared {
                host,
                config,
                activity: ActivityLog::new(),
            }),
            token: Mutex::new(token),
            pointer,
            status: watch::Sender::new(ServerStatus::Off),
            stopping: Mutex::new(None),
        });
        let (requests, receiver) = watch::channel(Request {
            enabled,
            ..Request::default()
        });
        drop(tokio::spawn(inner.clone().supervise(receiver)));
        Ok(Self { inner, requests })
    }

    #[must_use]
    pub fn status(&self) -> watch::Receiver<ServerStatus> {
        self.inner.status.subscribe()
    }

    /// Every tool the host offers, whether or not MCP clients may use it.
    #[must_use]
    pub fn tools(&self) -> Vec<Tool> {
        self.inner.shared.host.tools()
    }

    /// Starts or stops the server and remembers the choice. Enabling also
    /// retries a server that failed to start.
    pub fn set_enabled(&self, enabled: bool) -> Result<()> {
        {
            let mut config = self.inner.shared.config.write()?;
            config.mcp.enabled = enabled;
            config.save()?;
        }
        self.requests.send_modify(|request| {
            request.enabled = enabled;
            if enabled {
                request.attempt += 1;
            }
        });
        Ok(())
    }

    /// Chooses the tools MCP clients may list and call: a preset `profile`, or
    /// the custom profile without `disabled_tools`. Connected clients are told
    /// when the set changes.
    pub fn set_tools(&self, profile: ToolProfile, disabled_tools: BTreeSet<String>) -> Result<()> {
        let mut config = self.inner.shared.config.write()?;
        config.mcp.profile = profile;
        config.mcp.disabled_tools = disabled_tools;
        config.save()
    }

    /// The recent tool calls, oldest first.
    #[must_use]
    pub fn activity(&self) -> Vec<ToolActivity> {
        self.inner.shared.activity.entries()
    }

    /// Every tool call from now on, as it finishes.
    #[must_use]
    pub fn subscribe_activity(&self) -> broadcast::Receiver<ToolActivity> {
        self.inner.shared.activity.subscribe()
    }

    pub fn clear_activity(&self) {
        self.inner.shared.activity.clear();
    }

    /// Cancels the tool calls that a stopping server is waiting for.
    pub fn stop_now(&self) {
        if let Some(calls) = &*lock(&self.inner.stopping) {
            calls.cancel_all();
        }
    }

    /// Cancels every running tool call and closes the server without waiting.
    pub fn shutdown(&self) {
        self.requests.send_modify(|request| request.shutdown = true);
    }
}

impl<H> Drop for Supervisor<H> {
    fn drop(&mut self) {
        self.requests.send_modify(|request| request.shutdown = true);
    }
}

impl<H> Inner<H>
where
    H: Host,
{
    async fn supervise(self: Arc<Self>, mut requests: watch::Receiver<Request>) {
        let mut phase = Phase::Off;
        loop {
            let request = *requests.borrow_and_update();
            if request.shutdown {
                if let Phase::Running(server) = phase {
                    server.calls.cancel_all();
                }
                break;
            }
            phase = match phase {
                Phase::Running(server) if !request.enabled => {
                    match self.stop(server, &mut requests).await {
                        Some(server) => Phase::Running(server),
                        None => Phase::Off,
                    }
                }
                Phase::Running(server) => {
                    if !self.serve(&server, &mut requests).await {
                        break;
                    }
                    Phase::Running(server)
                }
                Phase::Off | Phase::Failed { .. } if !request.enabled => {
                    self.status.send_replace(ServerStatus::Off);
                    if requests.changed().await.is_err() {
                        break;
                    }
                    Phase::Off
                }
                Phase::Failed { attempt } if attempt == request.attempt => {
                    if requests.changed().await.is_err() {
                        break;
                    }
                    Phase::Failed { attempt }
                }
                Phase::Off | Phase::Failed { .. } => {
                    self.status.send_replace(ServerStatus::Starting);
                    match self.start(&requests).await {
                        Ok(server) => Phase::Running(server),
                        Err(error) => {
                            if requests.borrow().enabled {
                                tracing::error!("the MCP server is unavailable: {error:#}");
                                self.status.send_replace(ServerStatus::Failed {
                                    message: format!("{error:#}"),
                                });
                            }
                            Phase::Failed {
                                attempt: request.attempt,
                            }
                        }
                    }
                }
            };
        }
        self.status.send_replace(ServerStatus::Off);
    }

    async fn start(&self, requests: &watch::Receiver<Request>) -> Result<Server> {
        let token = self.token()?;
        let port = self.shared.config.read()?.mcp.port;
        let deadline = Instant::now() + BIND_PATIENCE;
        let server = loop {
            match Server::bind(self.shared.clone(), port, token.clone()).await {
                Ok(server) => break server,
                Err(error) if Instant::now() + BIND_RETRY < deadline => {
                    tracing::debug!("retrying the MCP server port: {error:#}");
                    tokio::time::sleep(BIND_RETRY).await;
                    let request = *requests.borrow();
                    if !request.enabled || request.shutdown {
                        bail!("starting the MCP server was cancelled");
                    }
                }
                Err(error) => return Err(error),
            }
        };
        let pointer = match &self.pointer {
            Some(pointer) => pointer.clone(),
            None => koharu_config::path()?.with_file_name(POINTER),
        };
        write_pointer(&pointer, &server.url(), &token)?;
        tracing::info!(
            url = %server.url(),
            pointer = %pointer.display(),
            "MCP server is listening",
        );
        Ok(server)
    }

    /// Reports a running server until a new request arrives. Returns `false`
    /// when the supervisor is gone.
    async fn serve(&self, server: &Server, requests: &mut watch::Receiver<Request>) -> bool {
        let mut clients = server.clients.count();
        loop {
            let status = ServerStatus::Running {
                url: server.url(),
                clients: u32::try_from(*clients.borrow_and_update()).unwrap_or(u32::MAX),
            };
            self.status.send_if_modified(|current| {
                let changed = *current != status;
                *current = status;
                changed
            });
            tokio::select! {
                changed = requests.changed() => return changed.is_ok(),
                _ = clients.changed() => {}
                () = tokio::time::sleep(PRUNE_INTERVAL) => server.clients.prune(),
            }
        }
    }

    /// Refuses new calls, waits for running ones, and then closes the server.
    /// Returns the server again when it is re-enabled while stopping.
    async fn stop(
        &self,
        server: Server,
        requests: &mut watch::Receiver<Request>,
    ) -> Option<Server> {
        server.calls.set_accepting(false);
        *lock(&self.stopping) = Some(server.calls.clone());
        let mut running = server.calls.running();
        let resumed = loop {
            let tasks = *running.borrow_and_update();
            if tasks == 0 {
                break false;
            }
            self.status.send_replace(ServerStatus::Stopping {
                tasks: u32::try_from(tasks).unwrap_or(u32::MAX),
            });
            tokio::select! {
                _ = running.changed() => {}
                changed = requests.changed() => {
                    let request = *requests.borrow();
                    if changed.is_err() || request.shutdown {
                        server.calls.cancel_all();
                        break false;
                    }
                    if request.enabled {
                        break true;
                    }
                }
            }
        };
        lock(&self.stopping).take();
        if resumed {
            server.calls.set_accepting(true);
            return Some(server);
        }
        // The calls are done, but their answers may still be on their way;
        // closing now would leave clients without them.
        server.deliver_answers(ANSWER_PATIENCE).await;
        tracing::info!("MCP server stopped");
        None
    }

    fn token(&self) -> Result<Token> {
        let mut token = lock(&self.token);
        if let Some(token) = &*token {
            return Ok(token.clone());
        }
        let loaded = Token::load_or_create().context("the MCP token is unavailable")?;
        *token = Some(loaded.clone());
        Ok(loaded)
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
impl<H> Supervisor<H>
where
    H: Host,
{
    pub(super) fn for_test(
        host: H,
        config: koharu_config::Config<Config>,
        token: Token,
        pointer: PathBuf,
    ) -> Result<Self> {
        Self::spawn(host, config, Some(token), Some(pointer))
    }
}
