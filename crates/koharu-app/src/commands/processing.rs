use std::{collections::HashMap, fmt, future::Future, sync::Arc};

use anyhow::{Context as _, Result};
use koharu_pipeline::{Committer, Progress, RunStatus, StageOutput, StopToken};
use koharu_scene::Snapshot;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager as _, State, ipc::Channel};
use tauri_runtime_cef::CefRuntime;
use uuid::Uuid;

use super::{
    ChannelExt as _, Error, canvas::CanvasChannel, project::CurrentProject,
    reference::ReferenceReading,
};
use koharu_desktop::Desktop;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, Type)]
#[serde(transparent)]
pub struct JobId(Uuid);

impl JobId {
    #[must_use]
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for JobId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for JobId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Clone, Debug, Serialize, Type)]
pub struct Job {
    pub id: JobId,
    pub kind: JobKind,
    pub state: JobState,
    #[specta(type = f64)]
    pub completed: usize,
    #[specta(type = f64)]
    pub total: usize,
    pub page: Option<koharu_scene::EntityId>,
    pub stage: Option<koharu_pipeline::Stage>,
    pub model: Option<String>,
    pub error: Option<String>,
    /// What the job found, once it has finished.
    pub summary: Option<JobSummary>,
}

#[derive(Clone, Copy, Debug, Serialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum JobSummary {
    References(ReferenceReading),
}

/// What a job does, so its progress can say so between pipeline stages.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum JobKind {
    Pipeline,
    /// Reading the text of references into their pages.
    References,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Running,
    Finished,
    Failed,
    Stopped,
}

#[derive(Default)]
pub(crate) struct Processing {
    pub(crate) stops: Mutex<HashMap<JobId, StopToken>>,
    pub(crate) jobs: Mutex<HashMap<JobId, Job>>,
    pub(crate) inpainting_mask: Mutex<Option<koharu_pipeline::InpaintingMask>>,
}

#[derive(Default)]
pub(crate) struct JobChannel {
    pub(crate) channel: Mutex<Option<Channel<Job>>>,
}

/// The running job, as its work sees it.
#[derive(Clone)]
pub(crate) struct JobContext {
    handle: AppHandle<CefRuntime>,
    id: JobId,
    pub(crate) stop: StopToken,
}

impl JobContext {
    pub(crate) fn handle(&self) -> &AppHandle<CefRuntime> {
        &self.handle
    }

    /// Updates the job's progress and tells the UI.
    pub(crate) fn report(&self, update: impl FnOnce(&mut Job)) {
        let job = {
            let processing = self.handle.state::<Processing>();
            let mut jobs = processing.jobs.lock();
            jobs.get_mut(&self.id).map(|job| {
                update(job);
                job.clone()
            })
        };
        if let Some(job) = job {
            self.handle.state::<JobChannel>().channel.publish(job);
        }
    }

    /// Runs pipeline stages as part of this job, committing what each stage
    /// produces as it finishes.
    pub(crate) async fn run_pipeline(
        &self,
        snapshot: Snapshot,
        scope: koharu_pipeline::Scope,
        operation: koharu_pipeline::Operation,
        inpainting_mask: Option<koharu_pipeline::InpaintingMask>,
    ) -> Result<RunStatus> {
        let progress = Arc::new(Mutex::new((0_usize, 0_usize)));
        let context = self.clone();
        let mut request = koharu_pipeline::Request {
            operation,
            scope,
            stop: self.stop.clone(),
            progress: None,
            inpainting_mask,
        };
        request.progress = Some(Arc::new(move |event| {
            let update = match event {
                Progress::Started { pages, stages } => {
                    tracing::info!(
                        target: "koharu_metrics",
                        metric = "pipeline_start",
                        page_count = pages.len(),
                        stage_count = stages.len(),
                    );
                    let mut progress = progress.lock();
                    *progress = (0, pages.len().saturating_mul(stages.len()));
                    Some((0, progress.1, None, None, None))
                }
                Progress::Loading { page, stage, model } => {
                    tracing::info!(
                        target: "koharu_metrics",
                        metric = "stage_loading",
                        stage = %stage,
                        model,
                    );
                    let progress = progress.lock();
                    Some((progress.0, progress.1, Some(page), Some(stage), Some(model)))
                }
                Progress::Finished {
                    page,
                    stage,
                    model,
                    elapsed,
                } => {
                    if stage != koharu_pipeline::Stage::Translation {
                        tracing::info!(
                            target: "koharu_metrics",
                            metric = "model_run",
                            stage = %stage,
                            model,
                            duration_ms = elapsed.as_secs_f64() * 1000.0,
                        );
                    }
                    let mut progress = progress.lock();
                    progress.0 = progress.0.saturating_add(1).min(progress.1);
                    Some((progress.0, progress.1, Some(page), Some(stage), Some(model)))
                }
                Progress::Skipped { page, stage } => {
                    tracing::info!(
                        target: "koharu_metrics",
                        metric = "stage_skip",
                        stage = %stage,
                    );
                    let mut progress = progress.lock();
                    progress.0 = progress.0.saturating_add(1).min(progress.1);
                    Some((progress.0, progress.1, Some(page), Some(stage), None))
                }
                Progress::Running { stage, model, .. } => {
                    tracing::info!(
                        target: "koharu_metrics",
                        metric = "stage_running",
                        stage = %stage,
                        model,
                    );
                    None
                }
            };
            if let Some((completed, total, page, stage, model)) = update {
                context.report(|job| {
                    job.completed = completed;
                    job.total = total;
                    job.page = page;
                    job.stage = stage;
                    job.model = model;
                });
            }
        }));

        let mut committer = PipelineCommitter {
            handle: self.handle.clone(),
        };
        let result = self
            .handle
            .state::<koharu_pipeline::Pipeline>()
            .execute(snapshot, request, &mut committer)
            .await;
        tracing::info!(
            target: "koharu_metrics",
            metric = "pipeline_result",
            outcome = match &result {
                Ok(report) if report.status == RunStatus::Stopped => "stopped",
                Ok(_) => "completed",
                Err(_) => "failed",
            },
        );
        match result {
            Ok(report) => Ok(report.status),
            Err(error) => {
                tracing::error!(stage = ?error.stage, %error, "processing failed");
                Err(anyhow::anyhow!(error))
            }
        }
    }
}

struct PipelineCommitter {
    handle: AppHandle<CefRuntime>,
}

#[async_trait::async_trait]
impl Committer for PipelineCommitter {
    async fn commit(&mut self, output: StageOutput) -> Result<Snapshot> {
        let (commit, page) = {
            let projects = self.handle.state::<CurrentProject>();
            let mut projects = projects.project.lock().await;
            let project = projects.as_mut().context("no project is open")?;
            let Some(commit) = project.commit_rebased(output.patch).await? else {
                return Ok(project.snapshot());
            };
            project.record_commit(&commit);
            let page = project.active_page();
            (commit, page)
        };
        let snapshot = commit.snapshot.clone();
        let desktop = self.handle.state::<Desktop>();
        desktop.synchronize(&commit.snapshot, page, &commit).await?;
        let canvas = desktop.canvas_state();
        self.handle.state::<CanvasChannel>().channel.publish(canvas);
        Ok(snapshot)
    }
}

/// Starts `work` as the one running job: only one job runs at a time, and
/// its progress, end, and failure reach the UI.
pub(crate) fn start_job<Work, Done>(
    handle: &AppHandle<CefRuntime>,
    kind: JobKind,
    work: Work,
) -> Result<JobId>
where
    Work: FnOnce(JobContext) -> Done + Send + 'static,
    Done: Future<Output = Result<RunStatus>> + Send + 'static,
{
    let id = JobId::new();
    let stop = StopToken::default();
    {
        let processing = handle.state::<Processing>();
        let mut stops = processing.stops.lock();
        if !stops.is_empty() {
            anyhow::bail!("another process is already running");
        }
        stops.insert(id, stop.clone());
    }
    let job = Job {
        id,
        kind,
        state: JobState::Running,
        completed: 0,
        total: 0,
        page: None,
        stage: None,
        model: None,
        error: None,
        summary: None,
    };
    handle
        .state::<Processing>()
        .jobs
        .lock()
        .insert(id, job.clone());
    handle.state::<JobChannel>().channel.publish(job);

    let context = JobContext {
        handle: handle.clone(),
        id,
        stop,
    };
    drop(tokio::spawn(async move {
        let handle = context.handle.clone();
        let result = work(context).await;
        handle.state::<Processing>().stops.lock().remove(&id);
        let job = handle
            .state::<Processing>()
            .jobs
            .lock()
            .remove(&id)
            .map(|mut job| {
                match result {
                    Ok(RunStatus::Completed) => job.state = JobState::Finished,
                    Ok(RunStatus::Stopped) => job.state = JobState::Stopped,
                    Err(error) => {
                        job.state = JobState::Failed;
                        job.error = Some(format!("{error:#}"));
                    }
                }
                job
            });
        if let Some(job) = job {
            handle.state::<JobChannel>().channel.publish(job);
        }
    }));
    Ok(id)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn process(
    handle: AppHandle<CefRuntime>,
    scope: koharu_pipeline::Scope,
    operation: koharu_pipeline::Operation,
    project: State<'_, CurrentProject>,
) -> std::result::Result<JobId, Error> {
    let snapshot = project
        .project
        .lock()
        .await
        .as_ref()
        .context("no project is open")?
        .snapshot();
    Ok(start_job(
        &handle,
        JobKind::Pipeline,
        move |job| async move {
            let inpainting_mask = job
                .handle
                .state::<Processing>()
                .inpainting_mask
                .lock()
                .take();
            job.run_pipeline(snapshot, scope, operation, inpainting_mask)
                .await
        },
    )?)
}

#[tracing::instrument(
    target = "koharu_metrics",
    name = "pipeline_stop",
    skip_all,
    fields(state = "requested")
)]
#[tauri::command]
#[specta::specta]
pub(crate) async fn stop_job(
    job: JobId,
    processing: State<'_, Processing>,
) -> std::result::Result<(), Error> {
    let stops = processing.stops.lock();
    let stop = stops
        .get(&job)
        .with_context(|| format!("job {job} is not running"))?;
    stop.stop();
    Ok(())
}
