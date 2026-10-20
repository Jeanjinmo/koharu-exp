use std::{
    collections::BTreeSet,
    future::Future,
    pin::Pin,
    sync::{Arc, OnceLock},
};

use anyhow::{Context as _, Result, anyhow, bail};
use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use koharu_agent::{Control, Host, Invocation, Tool, ToolCall, ToolGroup, ToolMetadata, Vision};
use koharu_desktop::{Desktop, Frame};
use koharu_pipeline::{
    Bounds, Committer, InpaintingMask, Operation, PipelineConfig, Report, RunStatus, Scope, Stage,
    StageOutput, StopToken,
};
use koharu_renderer::RenderDiagnostic;
use koharu_scene::{
    Commit, EntityId, LanguageTag, RasterLayer, RasterLayerKind, Revision, Snapshot,
};
use schemars::{JsonSchema, schema_for};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager as _};
use tauri_runtime_cef::CefRuntime;

use crate::commands::{
    ChannelExt as _,
    area::{Area, Mask},
    canvas::{CanvasChannel, Point},
    editing::{GeometryUpdate, TypographyUpdate},
    lifecycle::ProjectChannel,
    output,
    preferences::Preferences,
    processing::{JobId, Processing},
    project::{
        CurrentProject, Project, ProjectInfo, RasterStrokeMode, TranslationUpdate, Typography,
    },
};

mod outline;

#[derive(Clone)]
pub(super) struct KoharuHost {
    handle: AppHandle<CefRuntime>,
}

impl KoharuHost {
    pub(super) fn new(handle: AppHandle<CefRuntime>) -> Self {
        Self { handle }
    }

    async fn project_context(&self) -> Result<Value> {
        let (project, pages) = {
            let current = self.handle.state::<CurrentProject>();
            let current = current.project.lock().await;
            let project = current.as_ref().context("no project is open")?;
            let snapshot = project.snapshot();
            let pages = Project::pages(&snapshot)?
                .into_iter()
                .map(|page| Project::page(&snapshot, page.id))
                .collect::<Result<Vec<_>>>()?;
            (project.info(), pages)
        };
        let preferences = Preferences::load()?;
        let fonts = self
            .handle
            .state::<Desktop>()
            .renderer()
            .available_fonts()
            .await?;
        let providers = preferences
            .providers
            .entries
            .iter()
            .map(|provider| {
                json!({
                    "name": provider.name,
                    "config": provider.config,
                    "credential_configured": provider
                        .credential
                        .as_ref()
                        .is_some_and(|credential| credential.configured),
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({
            "project": project,
            "pages": pages,
            "configuration": {
                "pipeline": preferences.pipeline,
                "providers": providers,
                "typesetting": preferences.typesetting,
                "available_fonts": fonts.into_iter().map(|font| font.name).collect::<Vec<_>>(),
            },
        }))
    }

    async fn snapshot(&self) -> Result<Snapshot> {
        Ok(self
            .handle
            .state::<CurrentProject>()
            .project
            .lock()
            .await
            .as_ref()
            .context("no project is open")?
            .snapshot())
    }

    async fn mutate<T>(
        &self,
        mutation: impl for<'project> FnOnce(
            &'project mut Project,
        ) -> Pin<
            Box<dyn Future<Output = Result<(Commit, T)>> + Send + 'project>,
        >,
    ) -> Result<Invocation>
    where
        T: serde::Serialize + Send,
    {
        let (committed, value) = self.commit(mutation).await?;
        committed.invocation(value)
    }

    async fn commit<T>(
        &self,
        mutation: impl for<'project> FnOnce(
            &'project mut Project,
        ) -> Pin<
            Box<dyn Future<Output = Result<(Commit, T)>> + Send + 'project>,
        >,
    ) -> Result<(Committed, T)>
    where
        T: Send,
    {
        let (commit, value, page, project) = {
            let current = self.handle.state::<CurrentProject>();
            let mut current = current.project.lock().await;
            let project = current.as_mut().context("no project is open")?;
            let (commit, value) = mutation(project).await?;
            project.record_commit(&commit);
            project.reconcile_page();
            (commit, value, project.active_page(), project.info())
        };
        let committed = Committed {
            revision: commit.revision,
            snapshot: commit.snapshot.clone(),
            project: project.clone(),
        };
        self.synchronize(commit, page, project).await?;
        Ok((committed, value))
    }

    /// Lays out the given text elements as the renderer would and reports
    /// those whose text overflows its frame or shrinks below the readable size.
    async fn text_fit(
        &self,
        snapshot: &Snapshot,
        elements: &[EntityId],
    ) -> Result<Vec<FitWarning>> {
        let pages = elements
            .iter()
            .map(|element| Project::containing_page(snapshot, *element))
            .collect::<Result<BTreeSet<_>>>()?;
        let renderer = self.handle.state::<Desktop>().renderer();
        let mut diagnostics = Vec::new();
        for page in pages {
            let frame = renderer.render(snapshot, page).await?;
            diagnostics.extend_from_slice(frame.diagnostics());
        }
        Ok(fit_warnings(&diagnostics, elements))
    }

    /// Presents a committed agent change. Agent tools also run outside the
    /// agent panel (over MCP), so the project info is published for the UI to
    /// refresh its project, page, and layer queries.
    async fn synchronize(
        &self,
        commit: Commit,
        page: Option<EntityId>,
        project: ProjectInfo,
    ) -> Result<()> {
        let desktop = self.handle.state::<Desktop>();
        desktop.synchronize(&commit.snapshot, page, &commit).await?;
        let canvas = desktop.canvas_state();
        self.handle.state::<CanvasChannel>().channel.publish(canvas);
        self.handle
            .state::<ProjectChannel>()
            .channel
            .publish(Some(project));
        Ok(())
    }

    async fn run_pipeline(&self, arguments: RunPipeline, control: &Control) -> Result<Invocation> {
        let scope = arguments.scope()?;
        let report = self
            .process(scope, arguments.operation.into(), None, control)
            .await?;
        Invocation::changed(json!({
            "base_revision": report.base,
            "final_revision": report.final_revision,
            "completed": report.completed,
            "total": report.total,
            "elapsed_ms": report.elapsed.as_millis(),
        }))
    }

    /// Inpaints only the given area of a page into its cleanup layer.
    async fn remove(&self, arguments: Remove, control: &Control) -> Result<Invocation> {
        let page = entity(&arguments.page)?;
        let snapshot = self.snapshot().await?;
        let area = area(&snapshot, page, arguments.area)?;
        let (width, height) = page_pixels(&snapshot, page)?;
        let (png, bounds) = tokio_rayon::spawn(move || area.mask_png(width, height)).await?;
        let report = self
            .process(
                Scope::Region { page, bounds },
                Operation::Only {
                    stage: Stage::Inpainting,
                },
                Some(InpaintingMask {
                    page,
                    png: Arc::from(png),
                }),
                control,
            )
            .await?;
        let snapshot = self.snapshot().await?;
        let cleanup_layer = snapshot.children(page)?.find(|layer| {
            snapshot
                .component::<RasterLayer>(*layer)
                .ok()
                .flatten()
                .is_some_and(|raster| raster.kind == RasterLayerKind::Cleanup)
        });
        Invocation::changed(json!({
            "page": page,
            "area": [bounds.x, bounds.y, bounds.width, bounds.height],
            "cleanup_layer": cleanup_layer,
            "base_revision": report.base,
            "final_revision": report.final_revision,
        }))
    }

    async fn mask(&self, page: EntityId, arguments: AreaArguments) -> Result<Mask> {
        let snapshot = self.snapshot().await?;
        let area = area(&snapshot, page, arguments)?;
        let (width, height) = page_pixels(&snapshot, page)?;
        tokio_rayon::spawn(move || area.mask(width, height)).await
    }

    /// Runs the pipeline as an agent job: one job at a time with the UI's
    /// processing, cancelled through the agent control, committed as it goes.
    async fn process(
        &self,
        scope: Scope,
        operation: Operation,
        inpainting_mask: Option<InpaintingMask>,
        control: &Control,
    ) -> Result<Report> {
        let snapshot = self.snapshot().await?;
        let job = JobId::new();
        let stop = StopToken::default();
        {
            let processing = self.handle.state::<Processing>();
            let mut stops = processing.stops.lock();
            if !stops.is_empty() {
                bail!("another pipeline process is already running");
            }
            stops.insert(job, stop.clone());
        }

        let watcher = tauri::async_runtime::spawn({
            let control = control.clone();
            let stop = stop.clone();
            async move {
                control.cancelled().await;
                stop.stop();
            }
        });
        let mut committer = AgentCommitter { host: self.clone() };
        let request = koharu_pipeline::Request {
            operation,
            scope,
            stop,
            progress: None,
            inpainting_mask,
        };
        let result = self
            .handle
            .state::<koharu_pipeline::Pipeline>()
            .execute(snapshot, request, &mut committer)
            .await;
        watcher.abort();
        self.handle.state::<Processing>().stops.lock().remove(&job);
        let report = result.map_err(|error| anyhow!(error))?;
        if report.status == RunStatus::Stopped {
            bail!("pipeline processing was cancelled");
        }
        Ok(report)
    }
}

#[async_trait]
impl Host for KoharuHost {
    async fn context(&self) -> Result<Value> {
        self.project_context().await
    }

    fn tools(&self) -> Vec<Tool> {
        tools().to_vec()
    }

    #[tracing::instrument(
        target = "koharu_metrics",
        name = "agent_tool",
        skip_all,
        fields(tool = call.name.as_str()),
    )]
    async fn invoke(&self, call: ToolCall, control: &Control) -> Result<Invocation> {
        match call.name.as_str() {
            "inspect_project" => {
                let _: InspectProject = arguments(&call)?;
                Invocation::read(self.project_context().await?)
            }
            "inspect_page" => {
                let arguments: InspectPage = arguments(&call)?;
                let page = entity(&arguments.page)?;
                Invocation::read(outline::page_outline(&self.snapshot().await?, page)?)
            }
            "view_page" => {
                let arguments: ViewPage = arguments(&call)?;
                let page = entity(&arguments.page)?;
                let snapshot = self.snapshot().await?;
                let value = snapshot.page(page)?.page()?;
                let desktop = self.handle.state::<Desktop>();
                let renderer = desktop.renderer();
                let rasterizer = desktop.rasterizer().await?;
                let preview = output::rendered_preview(
                    &renderer,
                    rasterizer,
                    &snapshot,
                    page,
                    arguments.region.map(Into::into),
                )
                .await?;
                let [x, y, width, height] = preview.area;
                let label = value.label;
                Ok(Invocation::read(json!({
                    "page": page,
                    "label": label,
                    "width": value.width,
                    "height": value.height,
                    "view": { "x": x, "y": y, "width": width, "height": height, "scale": preview.scale },
                }))?
                .with_image(
                    format!("Rendered page {label} ({page}), area {x},{y} {width}x{height}"),
                    format!("data:image/webp;base64,{}", STANDARD.encode(preview.webp)),
                ))
            }
            "rename_page" => {
                let arguments: RenamePage = arguments(&call)?;
                let page = entity(&arguments.page)?;
                self.mutate(|project| {
                    Box::pin(async move {
                        Ok((
                            project.rename_page(page, arguments.label).await?,
                            json!({ "page": page }),
                        ))
                    })
                })
                .await
            }
            "move_page" => {
                let arguments: MovePage = arguments(&call)?;
                let page = entity(&arguments.page)?;
                self.mutate(|project| {
                    Box::pin(async move {
                        Ok((
                            project.move_page(page, arguments.index).await?,
                            json!({ "page": page }),
                        ))
                    })
                })
                .await
            }
            "delete_pages" => {
                let arguments: DeletePages = arguments(&call)?;
                let pages = entities(&arguments.pages)?;
                self.mutate(|project| {
                    Box::pin(async move {
                        Ok((
                            project.delete_pages(pages.clone()).await?,
                            json!({ "pages": pages }),
                        ))
                    })
                })
                .await
            }
            "add_text_box" => {
                let arguments: AddTextBox = arguments(&call)?;
                let page = entity(&arguments.page)?;
                let frame = Frame {
                    x: arguments.x,
                    y: arguments.y,
                    width: arguments.width,
                    height: arguments.height,
                    angle_degrees: arguments.angle_degrees,
                };
                self.mutate(|project| {
                    Box::pin(async move {
                        let (commit, element) = project.add_text_box(page, frame).await?;
                        Ok((commit, json!({ "page": page, "element": element })))
                    })
                })
                .await
            }
            "set_source_text" => {
                let arguments: SetText = arguments(&call)?;
                let element = entity(&arguments.element)?;
                self.mutate(|project| {
                    Box::pin(async move {
                        Ok((
                            project.set_source_text(element, arguments.text).await?,
                            json!({ "element": element }),
                        ))
                    })
                })
                .await
            }
            "set_translation" => {
                let arguments: SetTranslation = arguments(&call)?;
                let element = entity(&arguments.element)?;
                let Some(text) = arguments.text else {
                    return self
                        .mutate(|project| {
                            Box::pin(async move {
                                Ok((
                                    project.remove_translation(element).await?,
                                    json!({ "element": element }),
                                ))
                            })
                        })
                        .await;
                };
                let language = match explicit_language(arguments.language)? {
                    Some(language) => language,
                    None => target_language()?,
                };
                let update = TranslationUpdate {
                    layer: element,
                    text,
                    language: Some(language.clone()),
                };
                let (committed, ()) = self
                    .commit(|project| {
                        Box::pin(
                            async move { Ok((project.set_translations(vec![update]).await?, ())) },
                        )
                    })
                    .await?;
                let warnings = self.text_fit(&committed.snapshot, &[element]).await?;
                committed.invocation(json!({
                    "element": element,
                    "language": language.as_str(),
                    "warnings": warnings,
                }))
            }
            "set_translations" => {
                let arguments: SetTranslations = arguments(&call)?;
                let target = target_language()?;
                let updates = arguments
                    .translations
                    .into_iter()
                    .map(|translation| {
                        let layer = entity(&translation.element)?;
                        let language = explicit_language(translation.language)
                            .with_context(|| format!("element {layer}"))?
                            .unwrap_or_else(|| target.clone());
                        Ok(TranslationUpdate {
                            layer,
                            text: translation.text,
                            language: Some(language),
                        })
                    })
                    .collect::<Result<Vec<_>>>()?;
                let elements = updates
                    .iter()
                    .map(|update| update.layer)
                    .collect::<Vec<_>>();
                let (committed, ()) = self
                    .commit(|project| {
                        Box::pin(async move { Ok((project.set_translations(updates).await?, ())) })
                    })
                    .await?;
                let warnings = self.text_fit(&committed.snapshot, &elements).await?;
                committed.invocation(json!({ "elements": elements, "warnings": warnings }))
            }
            "set_typography" => {
                let arguments: SetTypography = arguments(&call)?;
                let element = entity(&arguments.element)?;
                let typography = Typography {
                    preferred_font: arguments.preferred_font,
                    font_weight: arguments.font_weight,
                    font_style: arguments.font_style.map(Into::into),
                    size: arguments.size,
                    auto_fit: arguments.auto_fit,
                    color: arguments.color,
                    stroke_color: arguments.stroke_color,
                    stroke_width: arguments.stroke_width,
                    alignment: arguments.alignment.map(Into::into),
                    writing_mode: arguments.writing_mode.map(Into::into),
                };
                self.mutate(|project| {
                    Box::pin(async move {
                        Ok((
                            project
                                .set_typography(vec![TypographyUpdate {
                                    layer: element,
                                    typography,
                                }])
                                .await?,
                            json!({ "element": element }),
                        ))
                    })
                })
                .await
            }
            "set_geometry" => {
                let arguments: SetGeometry = arguments(&call)?;
                let element = entity(&arguments.element)?;
                let points = arguments
                    .points
                    .into_iter()
                    .map(|point| Point {
                        x: point.x,
                        y: point.y,
                    })
                    .collect();
                self.mutate(|project| {
                    Box::pin(async move {
                        Ok((
                            project
                                .set_geometry(vec![GeometryUpdate {
                                    layer: element,
                                    points: Some(points),
                                }])
                                .await?,
                            json!({ "element": element }),
                        ))
                    })
                })
                .await
            }
            "set_visibility" => {
                let arguments: SetVisibility = arguments(&call)?;
                let elements = entities(&arguments.elements)?;
                self.mutate(|project| {
                    Box::pin(async move {
                        Ok((
                            project
                                .set_visibility(
                                    elements.clone(),
                                    arguments.visible,
                                    arguments.opacity,
                                )
                                .await?,
                            json!({ "elements": elements }),
                        ))
                    })
                })
                .await
            }
            "delete_elements" => {
                let arguments: DeleteElements = arguments(&call)?;
                let elements = entities(&arguments.elements)?;
                self.mutate(|project| {
                    Box::pin(async move {
                        Ok((
                            project.delete_layers(elements.clone()).await?,
                            json!({ "elements": elements }),
                        ))
                    })
                })
                .await
            }
            "move_element" => {
                let arguments: MoveElement = arguments(&call)?;
                let element = entity(&arguments.element)?;
                let parent = entity(&arguments.parent)?;
                self.mutate(|project| {
                    Box::pin(async move {
                        Ok((
                            project.move_layer(element, parent, arguments.index).await?,
                            json!({ "element": element, "parent": parent }),
                        ))
                    })
                })
                .await
            }
            "remove" => self.remove(arguments(&call)?, control).await,
            "draw" => {
                let arguments: Draw = arguments(&call)?;
                let page = entity(&arguments.page)?;
                let color = hex_color(&arguments.color)?;
                let layer = arguments.layer.as_deref().map(entity).transpose()?;
                let mask = self.mask(page, arguments.area).await?;
                self.mutate(|project| {
                    Box::pin(async move {
                        let (commit, layer) = project
                            .apply_raster_mask(
                                page,
                                layer,
                                RasterStrokeMode::Paint,
                                color,
                                &mask.coverage,
                            )
                            .await?;
                        Ok((commit, json!({ "page": page, "layer": layer })))
                    })
                })
                .await
            }
            "run_pipeline" => self.run_pipeline(arguments(&call)?, control).await,
            name => bail!("unknown Koharu tool {name}"),
        }
    }
}

/// The project state right after an agent edit was recorded and presented.
struct Committed {
    revision: Revision,
    snapshot: Snapshot,
    project: ProjectInfo,
}

impl Committed {
    fn invocation(self, result: impl Serialize) -> Result<Invocation> {
        Invocation::changed(json!({
            "revision": self.revision,
            "project": self.project,
            "result": result,
        }))
    }
}

#[derive(Debug, PartialEq, Serialize)]
struct FitWarning {
    element: EntityId,
    /// Final font size chosen by the layout.
    font_size: f32,
    /// The laid-out text extends past its frame.
    overflows: bool,
    /// Present when the text had to shrink below this readable size.
    #[serde(skip_serializing_if = "Option::is_none")]
    minimum_font_size: Option<f32>,
}

fn fit_warnings(diagnostics: &[RenderDiagnostic], elements: &[EntityId]) -> Vec<FitWarning> {
    elements
        .iter()
        .filter_map(|element| {
            let mut warning = None::<FitWarning>;
            for diagnostic in diagnostics {
                let (entity, font_size, overflows, minimum_font_size) = match diagnostic {
                    RenderDiagnostic::TextOverflow {
                        entity, font_size, ..
                    } => (entity, *font_size, true, None),
                    RenderDiagnostic::TextBelowReadableSize {
                        entity,
                        font_size,
                        minimum_font_size,
                    } => (entity, *font_size, false, Some(*minimum_font_size)),
                    RenderDiagnostic::MissingAsset { .. } => continue,
                };
                if entity != element {
                    continue;
                }
                let warning = warning.get_or_insert(FitWarning {
                    element: *element,
                    font_size,
                    overflows: false,
                    minimum_font_size: None,
                });
                warning.overflows |= overflows;
                warning.minimum_font_size = warning.minimum_font_size.or(minimum_font_size);
            }
            warning
        })
        .collect()
}

struct AgentCommitter {
    host: KoharuHost,
}

#[async_trait]
impl Committer for AgentCommitter {
    async fn commit(&mut self, output: StageOutput) -> Result<Snapshot> {
        let (commit, page, info) = {
            let current = self.host.handle.state::<CurrentProject>();
            let mut current = current.project.lock().await;
            let project = current.as_mut().context("no project is open")?;
            let Some(commit) = project.commit_rebased(output.patch).await? else {
                return Ok(project.snapshot());
            };
            project.record_commit(&commit);
            (commit, project.active_page(), project.info())
        };
        let snapshot = commit.snapshot.clone();
        self.host.synchronize(commit, page, info).await?;
        Ok(snapshot)
    }
}

/// Every tool the host offers, shared by the in-app agent and the MCP server.
fn tools() -> &'static [Tool] {
    static TOOLS: OnceLock<Vec<Tool>> = OnceLock::new();
    TOOLS
        .get_or_init(|| {
            vec![
                definition::<InspectProject>(
                    "inspect_project",
                    "Read the latest complete semantic project state after edits. This does not include page images.",
                    metadata(ToolGroup::Read),
                ),
                definition::<InspectPage>(
                    "inspect_page",
                    "Read one page compactly: its size, every text element (ID, box, source text and translation with languages, core typography) and its paint and cleanup layer IDs. Prefer this over inspect_project when working page by page.",
                    metadata(ToolGroup::Read),
                ),
                definition::<ViewPage>(
                    "view_page",
                    "Render one page, or one region of it at full resolution, as an image. Call this only for pages whose visual appearance matters to the request. The result gives the page size and the area shown; convert image coordinates with page_x = view.x + image_x / view.scale and page_y = view.y + image_y / view.scale.",
                    ToolMetadata {
                        vision: Vision::Required,
                        ..metadata(ToolGroup::Read)
                    },
                ),
                definition::<RenamePage>(
                    "rename_page",
                    "Rename a project page.",
                    metadata(ToolGroup::Pages),
                ),
                definition::<MovePage>(
                    "move_page",
                    "Move a page to a zero-based project index.",
                    metadata(ToolGroup::Pages),
                ),
                definition::<DeletePages>(
                    "delete_pages",
                    "Delete pages and their contents.",
                    ToolMetadata {
                        destructive: true,
                        ..metadata(ToolGroup::Pages)
                    },
                ),
                definition::<AddTextBox>(
                    "add_text_box",
                    "Add a paragraph text box to a page.",
                    ToolMetadata {
                        vision: Vision::Better,
                        ..metadata(ToolGroup::Text)
                    },
                ),
                definition::<SetText>(
                    "set_source_text",
                    "Replace an element's source text.",
                    metadata(ToolGroup::Text),
                ),
                definition::<SetTranslation>(
                    "set_translation",
                    "Set an element's translation, or pass null to remove it. The translation is tagged with its language, which decides how lines break. The result warns when the text overflows its frame or shrinks below the readable size.",
                    metadata(ToolGroup::Text),
                ),
                definition::<SetTranslations>(
                    "set_translations",
                    "Set the translations of many elements in one call and one undo step. Every element is validated first; if any is invalid, nothing changes. Prefer this over repeated set_translation calls. The result warns about text that overflows its frame or shrinks below the readable size.",
                    metadata(ToolGroup::Text),
                ),
                definition::<SetTypography>(
                    "set_typography",
                    "Replace an element's typography settings. Font is a family name from available_fonts.",
                    metadata(ToolGroup::Text),
                ),
                definition::<SetGeometry>(
                    "set_geometry",
                    "Replace an element's page-space polygon geometry.",
                    ToolMetadata {
                        vision: Vision::Better,
                        ..metadata(ToolGroup::Text)
                    },
                ),
                definition::<SetVisibility>(
                    "set_visibility",
                    "Change visibility and/or opacity for elements.",
                    metadata(ToolGroup::Text),
                ),
                definition::<DeleteElements>(
                    "delete_elements",
                    "Delete elements and descendants.",
                    ToolMetadata {
                        destructive: true,
                        ..metadata(ToolGroup::Text)
                    },
                ),
                definition::<MoveElement>(
                    "move_element",
                    "Move an element under a page or element at a zero-based index.",
                    metadata(ToolGroup::Text),
                ),
                definition::<Remove>(
                    "remove",
                    "Remove artwork such as original text from one area of a page by inpainting it, like the Remove tool. Pixels outside the area do not change; the result goes into the page's cleanup layer and can be undone. Give the area as text elements, a rect, or a brush path. The inpainting model tends to continue structural lines through the area.",
                    ToolMetadata {
                        vision: Vision::Better,
                        mutates_image: true,
                        ..metadata(ToolGroup::Image)
                    },
                ),
                definition::<Draw>(
                    "draw",
                    "Fill one area of a page with a solid color, like the Draw tool, for example white over leftover text. Draws on the given paint or cleanup layer, or on a new paint layer, and returns the layer ID. Give the area as text elements, a rect, or a brush path.",
                    ToolMetadata {
                        vision: Vision::Better,
                        mutates_image: true,
                        ..metadata(ToolGroup::Image)
                    },
                ),
                definition::<RunPipeline>(
                    "run_pipeline",
                    "Run Koharu's configured processing pipeline for the whole project, selected pages, or selected text elements.",
                    ToolMetadata {
                        mutates_image: true,
                        ..metadata(ToolGroup::Pipeline)
                    },
                ),
            ]
        })
}

fn definition<T: JsonSchema>(name: &str, description: &str, metadata: ToolMetadata) -> Tool {
    Tool::new(
        name,
        description,
        serde_json::to_value(schema_for!(T)).expect("tool argument schema must serialize"),
        metadata,
    )
}

/// Resolves the area an area tool works on from exactly one way of giving it.
fn area(snapshot: &Snapshot, page: EntityId, arguments: AreaArguments) -> Result<Area> {
    let AreaArguments {
        elements,
        rect,
        points,
        diameter,
    } = arguments;
    match (!elements.is_empty(), rect, !points.is_empty()) {
        (true, None, false) => Ok(Area::Rects(
            elements
                .iter()
                .map(|element| outline::element_area(snapshot, page, entity(element)?))
                .collect::<Result<_>>()?,
        )),
        (false, Some(rect), false) => Ok(Area::Rects(vec![rect.into()])),
        (false, None, true) => Ok(Area::Stroke {
            points: points
                .into_iter()
                .map(|point| Point {
                    x: point.x,
                    y: point.y,
                })
                .collect(),
            diameter: diameter.context("points need a brush diameter")?,
        }),
        _ => bail!("give exactly one of elements, rect, or points with diameter"),
    }
}

fn hex_color(value: &str) -> Result<[u8; 4]> {
    let digits = value.trim().trim_start_matches('#');
    let channel = |index: usize| {
        digits
            .get(index..index + 2)
            .and_then(|pair| u8::from_str_radix(pair, 16).ok())
    };
    let color = match digits.len() {
        6 => (0..3)
            .map(|index| channel(index * 2))
            .chain([Some(u8::MAX)])
            .collect::<Option<Vec<_>>>(),
        8 => (0..4).map(|index| channel(index * 2)).collect(),
        _ => None,
    };
    color
        .and_then(|color| color.try_into().ok())
        .with_context(|| format!("{value:?} is not a #RRGGBB or #RRGGBBAA color"))
}

fn page_pixels(snapshot: &Snapshot, page: EntityId) -> Result<(u32, u32)> {
    let value = snapshot.page(page)?.page()?;
    Ok((value.width.round() as u32, value.height.round() as u32))
}

/// Metadata for a tool that only needs text and leaves artwork and content intact.
fn metadata(group: ToolGroup) -> ToolMetadata {
    ToolMetadata {
        group,
        vision: Vision::None,
        mutates_image: false,
        destructive: false,
    }
}

fn arguments<T: for<'de> Deserialize<'de>>(call: &ToolCall) -> Result<T> {
    serde_json::from_str(&call.arguments)
        .with_context(|| format!("invalid arguments for {}", call.name))
}

fn explicit_language(language: Option<String>) -> Result<Option<LanguageTag>> {
    language
        .filter(|language| !language.trim().is_empty())
        .map(|language| {
            LanguageTag::new(language.trim())
                .with_context(|| format!("{language:?} is not a valid BCP 47 language tag"))
        })
        .transpose()
}

/// Agent translations without an explicit language are tagged with the
/// configured target language, so the renderer breaks lines with that
/// language's rules instead of the English fallback for untagged text.
fn target_language() -> Result<LanguageTag> {
    let pipeline = PipelineConfig::load()?;
    let target = pipeline.read()?.translation.target_language;
    Ok(LanguageTag::new(target.tag())?)
}

fn entity(value: &str) -> Result<EntityId> {
    serde_json::from_value(Value::String(value.to_owned()))
        .with_context(|| format!("invalid entity ID {value}"))
}

fn entities(values: &[String]) -> Result<Vec<EntityId>> {
    values.iter().map(|value| entity(value)).collect()
}

#[derive(Deserialize, JsonSchema)]
struct InspectProject {}

#[derive(Deserialize, JsonSchema)]
struct InspectPage {
    page: String,
}

#[derive(Deserialize, JsonSchema)]
struct ViewPage {
    page: String,
    /// Page area to view at full resolution instead of the whole page.
    region: Option<Rect>,
}

/// The page area an area tool works on. Give exactly one of `elements`,
/// `rect`, or `points` with `diameter`.
#[derive(Deserialize, JsonSchema)]
struct AreaArguments {
    /// Text elements on the page. Each covers the box where its original text
    /// was detected, or its text box when no detection exists.
    #[serde(default)]
    elements: Vec<String>,
    rect: Option<Rect>,
    /// A brush path in page pixels, drawn with a round brush of `diameter`.
    #[serde(default)]
    points: Vec<AgentPoint>,
    diameter: Option<f32>,
}

#[derive(Deserialize, JsonSchema)]
struct Remove {
    page: String,
    #[serde(flatten)]
    area: AreaArguments,
}

#[derive(Deserialize, JsonSchema)]
struct Draw {
    page: String,
    #[serde(flatten)]
    area: AreaArguments,
    /// Fill color as `#RRGGBB` or `#RRGGBBAA`.
    color: String,
    /// Paint or cleanup layer to draw on. Omit it to add a new paint layer.
    layer: Option<String>,
}

/// An axis-aligned rectangle in page pixels.
#[derive(Clone, Copy, Deserialize, JsonSchema)]
struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl From<Rect> for Bounds {
    fn from(rect: Rect) -> Self {
        Self {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
        }
    }
}

#[derive(Deserialize, JsonSchema)]
struct RenamePage {
    page: String,
    label: String,
}

#[derive(Deserialize, JsonSchema)]
struct MovePage {
    page: String,
    index: usize,
}

#[derive(Deserialize, JsonSchema)]
struct DeletePages {
    pages: Vec<String>,
}

#[derive(Deserialize, JsonSchema)]
struct AddTextBox {
    page: String,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    #[serde(default)]
    angle_degrees: f32,
}

#[derive(Deserialize, JsonSchema)]
struct SetText {
    element: String,
    text: String,
}

#[derive(Deserialize, JsonSchema)]
struct SetTranslation {
    element: String,
    text: Option<String>,
    /// BCP 47 tag of the translation's language, such as `id-ID`. Defaults to
    /// the target language in Koharu's settings.
    language: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct SetTranslations {
    translations: Vec<ElementTranslation>,
}

#[derive(Deserialize, JsonSchema)]
struct ElementTranslation {
    element: String,
    text: String,
    /// BCP 47 tag of the translation's language, such as `id-ID`. Defaults to
    /// the target language in Koharu's settings.
    language: Option<String>,
}

#[derive(Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
enum AgentTextAlignment {
    Start,
    Center,
    End,
    Justify,
}

impl From<AgentTextAlignment> for koharu_scene::TextAlignment {
    fn from(value: AgentTextAlignment) -> Self {
        match value {
            AgentTextAlignment::Start => Self::Start,
            AgentTextAlignment::Center => Self::Center,
            AgentTextAlignment::End => Self::End,
            AgentTextAlignment::Justify => Self::Justify,
        }
    }
}

#[derive(Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
enum AgentWritingMode {
    Horizontal,
    Vertical,
}

#[derive(Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
enum AgentFontStyle {
    Normal,
    Italic,
    Oblique,
}

impl From<AgentFontStyle> for koharu_scene::FontStyle {
    fn from(value: AgentFontStyle) -> Self {
        match value {
            AgentFontStyle::Normal => Self::Normal,
            AgentFontStyle::Italic => Self::Italic,
            AgentFontStyle::Oblique => Self::Oblique,
        }
    }
}

impl From<AgentWritingMode> for koharu_scene::WritingMode {
    fn from(value: AgentWritingMode) -> Self {
        match value {
            AgentWritingMode::Horizontal => Self::Horizontal,
            AgentWritingMode::Vertical => Self::Vertical,
        }
    }
}

#[derive(Deserialize, JsonSchema)]
struct SetTypography {
    element: String,
    preferred_font: Option<String>,
    font_weight: Option<u16>,
    font_style: Option<AgentFontStyle>,
    size: Option<f32>,
    auto_fit: bool,
    color: Option<[u8; 4]>,
    stroke_color: Option<[u8; 4]>,
    stroke_width: Option<f32>,
    alignment: Option<AgentTextAlignment>,
    writing_mode: Option<AgentWritingMode>,
}

#[derive(Deserialize, JsonSchema)]
struct SetGeometry {
    element: String,
    points: Vec<AgentPoint>,
}

#[derive(Deserialize, JsonSchema)]
struct AgentPoint {
    x: f64,
    y: f64,
}

#[derive(Deserialize, JsonSchema)]
struct SetVisibility {
    elements: Vec<String>,
    visible: Option<bool>,
    opacity: Option<f32>,
}

#[derive(Deserialize, JsonSchema)]
struct DeleteElements {
    elements: Vec<String>,
}

#[derive(Deserialize, JsonSchema)]
struct MoveElement {
    element: String,
    parent: String,
    index: usize,
}

#[derive(Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
enum AgentPipelineOperation {
    Full,
    Detection,
    Ocr,
    Translation,
    Inpainting,
}

impl From<AgentPipelineOperation> for Operation {
    fn from(value: AgentPipelineOperation) -> Self {
        match value {
            AgentPipelineOperation::Full => Self::Full,
            AgentPipelineOperation::Detection => Self::Only {
                stage: Stage::Detection,
            },
            AgentPipelineOperation::Ocr => Self::Only { stage: Stage::Ocr },
            AgentPipelineOperation::Translation => Self::Only {
                stage: Stage::Translation,
            },
            AgentPipelineOperation::Inpainting => Self::Only {
                stage: Stage::Inpainting,
            },
        }
    }
}

#[derive(Deserialize, JsonSchema)]
struct RunPipeline {
    operation: AgentPipelineOperation,
    #[serde(default)]
    pages: Vec<String>,
    #[serde(default)]
    elements: Vec<String>,
}

impl RunPipeline {
    fn scope(&self) -> Result<Scope> {
        match (self.pages.is_empty(), self.elements.is_empty()) {
            (true, true) => Ok(Scope::Project),
            (false, true) => Ok(Scope::Pages(entities(&self.pages)?)),
            (true, false) => Ok(Scope::Entities(entities(&self.elements)?)),
            (false, false) => bail!("pipeline scope cannot contain both pages and elements"),
        }
    }
}

#[cfg(test)]
mod tests {
    use koharu_renderer::RenderBounds;

    use super::*;

    #[test]
    fn hex_colors_parse_with_or_without_alpha() {
        assert_eq!(hex_color("#FFFFFF").unwrap(), [255, 255, 255, 255]);
        assert_eq!(hex_color("10203080").unwrap(), [16, 32, 48, 128]);
        assert!(hex_color("#FFF").is_err());
        assert!(hex_color("#GG0000").is_err());
    }

    #[test]
    fn tool_arguments_are_object_schemas() {
        for tool in tools() {
            assert_eq!(tool.parameters["type"], json!("object"), "{}", tool.name);
        }
        let remove = tools().iter().find(|tool| tool.name == "remove").unwrap();
        for property in ["page", "elements", "rect", "points", "diameter"] {
            assert!(
                remove.parameters["properties"].get(property).is_some(),
                "remove lacks {property}: {}",
                remove.parameters
            );
        }
    }

    #[test]
    fn fit_warnings_merge_diagnostics_for_the_edited_elements() {
        let (shrunk_and_overflowing, shrunk, untouched) =
            (EntityId::new(), EntityId::new(), EntityId::new());
        let diagnostics = [
            RenderDiagnostic::TextBelowReadableSize {
                entity: shrunk_and_overflowing,
                font_size: 7.0,
                minimum_font_size: 9.0,
            },
            RenderDiagnostic::TextOverflow {
                entity: shrunk_and_overflowing,
                available: RenderBounds::default(),
                actual_width: 120.0,
                actual_height: 80.0,
                font_size: 7.0,
            },
            RenderDiagnostic::TextBelowReadableSize {
                entity: shrunk,
                font_size: 8.0,
                minimum_font_size: 9.0,
            },
            RenderDiagnostic::TextOverflow {
                entity: untouched,
                available: RenderBounds::default(),
                actual_width: 1.0,
                actual_height: 1.0,
                font_size: 9.0,
            },
            RenderDiagnostic::MissingAsset {
                entity: shrunk,
                role: "source".to_owned(),
            },
        ];

        assert_eq!(
            fit_warnings(&diagnostics, &[shrunk, shrunk_and_overflowing]),
            [
                FitWarning {
                    element: shrunk,
                    font_size: 8.0,
                    overflows: false,
                    minimum_font_size: Some(9.0),
                },
                FitWarning {
                    element: shrunk_and_overflowing,
                    font_size: 7.0,
                    overflows: true,
                    minimum_font_size: Some(9.0),
                },
            ]
        );
    }
}
