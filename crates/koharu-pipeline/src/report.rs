use std::time::Duration;

use anyhow::Result;
use async_trait::async_trait;

use crate::Stage;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RunStatus {
    Completed,
    Stopped,
}

#[derive(Debug)]
pub struct Report {
    pub status: RunStatus,
    pub base: koharu_scene::Revision,
    pub final_revision: koharu_scene::Revision,
    pub completed: usize,
    pub total: usize,
    pub elapsed: Duration,
    /// Stages that did not run on a page, and why.
    pub skipped: Vec<SkippedStage>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkippedStage {
    pub page: koharu_scene::EntityId,
    pub stage: Stage,
    pub reason: String,
}

#[derive(Debug)]
pub struct StageOutput {
    pub page: koharu_scene::EntityId,
    pub stage: Stage,
    pub patch: koharu_scene::Patch,
}

#[async_trait]
pub trait Committer: Send {
    async fn commit(&mut self, output: StageOutput) -> Result<koharu_scene::Snapshot>;
}
