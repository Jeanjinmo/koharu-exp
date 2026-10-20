//! MCP clients connected to one server, so they can be told when the tools
//! they may use change.
//!
//! Clients on protocol versions before 2026-07-28 receive notifications over
//! their session; newer clients open `subscriptions/listen` streams instead.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};

use rmcp::{Peer, RoleServer, service::SubscriptionSink};
use tokio::sync::watch;

/// Bounds how long a slow client can delay announcing a change to the others.
const NOTIFY_TIMEOUT: Duration = Duration::from_secs(2);

pub(super) struct Clients {
    state: Mutex<State>,
    count: watch::Sender<usize>,
}

#[derive(Default)]
struct State {
    next: u64,
    sessions: Vec<Peer<RoleServer>>,
    subscriptions: HashMap<u64, SubscriptionSink>,
}

impl State {
    fn count(&self) -> usize {
        self.sessions.len() + self.subscriptions.len()
    }
}

impl Clients {
    pub(super) fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State::default()),
            count: watch::Sender::new(0),
        })
    }

    pub(super) fn add_session(&self, peer: Peer<RoleServer>) {
        let mut state = self.lock();
        state.sessions.push(peer);
        self.publish(&state);
    }

    /// Registers a `subscriptions/listen` stream until the returned guard drops.
    pub(super) fn subscribe(self: &Arc<Self>, sink: SubscriptionSink) -> Subscription {
        let mut state = self.lock();
        let id = state.next;
        state.next += 1;
        state.subscriptions.insert(id, sink);
        self.publish(&state);
        Subscription {
            clients: self.clone(),
            id,
        }
    }

    /// Forgets sessions whose transport has closed.
    pub(super) fn prune(&self) {
        let mut state = self.lock();
        state.sessions.retain(|peer| !peer.is_transport_closed());
        self.publish(&state);
    }

    /// The number of connected clients, updated as they come and go.
    pub(super) fn count(&self) -> watch::Receiver<usize> {
        self.count.subscribe()
    }

    pub(super) async fn announce_tool_list_change(&self) {
        let (sessions, subscriptions) = {
            let state = self.lock();
            (
                state.sessions.clone(),
                state.subscriptions.values().cloned().collect::<Vec<_>>(),
            )
        };
        let sessions = sessions.iter().map(|peer| async move {
            if !peer.is_transport_closed()
                && let Ok(Err(error)) =
                    tokio::time::timeout(NOTIFY_TIMEOUT, peer.notify_tool_list_changed()).await
            {
                tracing::debug!(%error, "an MCP session missed a tool list change");
            }
        });
        let subscriptions = subscriptions.iter().map(|sink| async move {
            if let Ok(Err(error)) =
                tokio::time::timeout(NOTIFY_TIMEOUT, sink.notify_tool_list_changed()).await
            {
                tracing::debug!(%error, "an MCP subscription missed a tool list change");
            }
        });
        futures::future::join(
            futures::future::join_all(sessions),
            futures::future::join_all(subscriptions),
        )
        .await;
        self.prune();
    }

    fn publish(&self, state: &State) {
        self.count.send_if_modified(|count| {
            let changed = *count != state.count();
            *count = state.count();
            changed
        });
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

pub(super) struct Subscription {
    clients: Arc<Clients>,
    id: u64,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        let mut state = self.clients.lock();
        state.subscriptions.remove(&self.id);
        self.clients.publish(&state);
    }
}
