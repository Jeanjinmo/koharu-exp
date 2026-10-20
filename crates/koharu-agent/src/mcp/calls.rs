//! Tool calls in flight on one server, so stopping it can refuse new calls,
//! wait for the running ones, or cancel them.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, PoisonError},
};

use tokio::sync::watch;

use crate::Control;

pub(super) struct Calls {
    state: Mutex<State>,
    running: watch::Sender<usize>,
}

struct State {
    accepting: bool,
    next: u64,
    controls: HashMap<u64, Control>,
}

impl Calls {
    pub(super) fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State {
                accepting: true,
                next: 0,
                controls: HashMap::new(),
            }),
            running: watch::Sender::new(0),
        })
    }

    /// Admits a call controlled by `control` unless the server is stopping.
    /// The call counts as running until the returned guard drops.
    pub(super) fn begin(self: &Arc<Self>, control: Control) -> Option<Call> {
        let mut state = self.lock();
        if !state.accepting {
            return None;
        }
        let id = state.next;
        state.next += 1;
        state.controls.insert(id, control);
        self.running.send_replace(state.controls.len());
        Some(Call {
            calls: self.clone(),
            id,
        })
    }

    pub(super) fn set_accepting(&self, accepting: bool) {
        self.lock().accepting = accepting;
    }

    pub(super) fn cancel_all(&self) {
        for control in self.lock().controls.values() {
            control.cancel();
        }
    }

    /// The number of running calls, updated as calls start and finish.
    pub(super) fn running(&self) -> watch::Receiver<usize> {
        self.running.subscribe()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

pub(super) struct Call {
    calls: Arc<Calls>,
    id: u64,
}

impl Drop for Call {
    fn drop(&mut self) {
        let mut state = self.calls.lock();
        state.controls.remove(&self.id);
        self.calls.running.send_replace(state.controls.len());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stopping_refuses_new_calls_and_cancels_running_ones() {
        let calls = Calls::new();
        let running = calls.running();
        let control = Control::default();

        let call = calls.begin(control.clone()).expect("calls are accepted");
        assert_eq!(*running.borrow(), 1);
        calls.set_accepting(false);
        assert!(calls.begin(Control::default()).is_none());

        calls.cancel_all();
        assert!(control.is_cancelled());
        drop(call);
        assert_eq!(*running.borrow(), 0);
    }
}
