//! The recent MCP tool calls listed in Koharu's settings. They are kept in
//! memory while Koharu runs and never include call arguments.

use std::{
    collections::VecDeque,
    sync::{Mutex, PoisonError},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use specta::Type;
use tokio::sync::broadcast;

use crate::Reach;

const CAPACITY: usize = 100;
/// Errors are shortened to this many characters of their first line.
const ERROR_LENGTH: usize = 200;

/// One finished MCP tool call.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Type)]
pub struct ToolActivity {
    /// When the call finished, in milliseconds since the Unix epoch.
    #[specta(type = f64)]
    pub finished_at: u64,
    pub tool: String,
    /// The page the call worked on, or the first of several, when the host
    /// reports one. Following the agent shows it.
    pub page: Option<String>,
    /// How far the call reached when it worked on several pages, which the
    /// log names instead of `page`.
    pub reach: Option<Reach>,
    pub ok: bool,
    /// Whether the call changed the project.
    pub changed: bool,
    /// The start of the error message when the call failed or was refused.
    pub error: Option<String>,
    #[specta(type = f64)]
    pub elapsed_ms: u64,
}

impl ToolActivity {
    pub(super) fn new(tool: String, elapsed: Duration) -> Self {
        Self {
            finished_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |since| {
                    u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
                }),
            tool,
            page: None,
            reach: None,
            ok: true,
            changed: false,
            error: None,
            elapsed_ms: u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX),
        }
    }

    pub(super) fn failed(mut self, error: &str) -> Self {
        let line = error.lines().next().unwrap_or_default().trim();
        let mut summary = line.chars().take(ERROR_LENGTH).collect::<String>();
        if summary.len() < line.len() {
            summary.push('…');
        }
        self.ok = false;
        self.changed = false;
        self.error = Some(summary);
        self
    }
}

pub(super) struct ActivityLog {
    entries: Mutex<VecDeque<ToolActivity>>,
    recorded: broadcast::Sender<ToolActivity>,
}

impl ActivityLog {
    pub(super) fn new() -> Self {
        Self {
            entries: Mutex::new(VecDeque::with_capacity(CAPACITY)),
            recorded: broadcast::Sender::new(CAPACITY),
        }
    }

    pub(super) fn record(&self, activity: ToolActivity) {
        {
            let mut entries = self.lock();
            if entries.len() == CAPACITY {
                entries.pop_front();
            }
            entries.push_back(activity.clone());
        }
        // Nobody listening is fine; the log keeps the entry.
        let _ = self.recorded.send(activity);
    }

    /// The recorded calls, oldest first.
    pub(super) fn entries(&self) -> Vec<ToolActivity> {
        self.lock().iter().cloned().collect()
    }

    pub(super) fn clear(&self) {
        self.lock().clear();
    }

    pub(super) fn subscribe(&self) -> broadcast::Receiver<ToolActivity> {
        self.recorded.subscribe()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, VecDeque<ToolActivity>> {
        self.entries.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_log_keeps_the_latest_calls_and_short_errors() {
        let log = ActivityLog::new();
        for index in 0..CAPACITY + 5 {
            log.record(ToolActivity::new(format!("tool_{index}"), Duration::ZERO));
        }
        let entries = log.entries();
        assert_eq!(entries.len(), CAPACITY);
        assert_eq!(entries[0].tool, "tool_5");

        let failed = ToolActivity::new("remove".to_owned(), Duration::from_millis(1500))
            .failed(&format!("{}\ncaused by: more", "x".repeat(300)));
        assert!(!failed.ok);
        assert_eq!(failed.elapsed_ms, 1500);
        assert_eq!(
            failed.error.as_deref().map(str::chars).map(Iterator::count),
            Some(ERROR_LENGTH + 1)
        );

        log.clear();
        assert!(log.entries().is_empty());
    }
}
