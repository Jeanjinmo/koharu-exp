//! Reading the text of references into their pages.
//!
//! A reference shows the same artwork as its page, so once it is placed over
//! the page their speech bubbles line up. Layout detection finds the
//! reference's bubbles and texts, which are mapped into page space through
//! the placement. Bubbles pair first, then texts pair one to one; each page
//! text receives at most one reference text, read with OCR, and texts that
//! do not pair clearly stay unmatched for the user to pick by hand.

use std::{collections::HashMap, sync::Arc};

use anyhow::{Context as _, Result, bail};
use image::DynamicImage;
use koharu_pipeline::{LayoutBox, Operation, Pipeline, RunStatus, Scope, Stage};
use koharu_scene::{
    AssetRole, Authored, EntityId, Generation, Geometry, LanguageTag, Origin, PageReference,
    ProducerId, ReferencePlacement, ReferenceText, Snapshot, SourceText, Translation,
};
use koharu_translator::Language;
use serde::Serialize;
use specta::Type;
use tauri::Manager as _;

use crate::commands::{
    ChannelExt as _,
    canvas::CanvasChannel,
    processing::{JobContext, JobSummary},
    project::{CurrentProject, Project},
};
use koharu_desktop::Desktop;

const PRODUCER: &str = "dev.koharu-exp.references";
const READER: &str = "paddleocr-vl-1.6";
/// How much a page area and a reference area must overlap to pair at once,
/// and how much a page text and a reference text must overlap to pair.
const MIN_AFFINITY: f64 = 0.2;
/// Added to two texts' overlap when they come in the same place in reading
/// order inside bubbles holding as many texts each.
const SAME_PLACE: f64 = 0.1;
/// How far apart, in diagonals of the larger area, two areas that do not
/// overlap enough may be and still pair, for references slightly off.
const NEAR: f64 = 0.75;
/// How much of a text box must lie in a bubble for the text to belong to it.
const MIN_CONTAINMENT: f64 = 0.6;
/// Pixels added around reference text before reading it, so OCR sees whole
/// glyphs even when detection crops them tightly.
const READ_PADDING: f64 = 4.0;

/// `[left, top, right, bottom]`.
type Bounds = [f64; 4];

/// What reading references found, reported when the job ends.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Type)]
pub struct ReferenceReading {
    /// Texts of the pages that received text from their reference.
    pub read: u32,
    /// Texts of the pages that no reference text matched clearly.
    pub unmatched: u32,
    /// Texts found in references that matched nothing on their page.
    pub unused: u32,
    /// Texts of the pages that do not fit once read, as the canvas marks them.
    pub unfit: u32,
}

/// A text of a page.
#[derive(Clone, Debug, PartialEq)]
struct PageText {
    content: EntityId,
    /// Where its original text was detected, otherwise where it is laid out.
    bounds: Bounds,
}

/// Where text sits on a page: a speech bubble with the texts that flow into
/// it, or one text outside any bubble.
#[derive(Clone, Debug, PartialEq)]
struct PageArea {
    bounds: Bounds,
    /// In reading order.
    texts: Vec<PageText>,
}

/// A text found in a reference.
#[derive(Clone, Debug, PartialEq)]
struct FoundText {
    /// Where it lies over the page, in page pixels.
    bounds: Bounds,
    /// What to read, in reference pixels.
    read: Bounds,
}

/// An area of a reference with text to read: a bubble with the texts found
/// in it, or one text outside any bubble.
#[derive(Clone, Debug, PartialEq)]
struct ReferenceArea {
    /// Where the area lies over the page, in page pixels.
    bounds: Bounds,
    /// In reading order; a bubble without detected text is read whole.
    texts: Vec<FoundText>,
}

/// What a page text receives from the reference.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Match {
    /// This text of this reference area, as `(area, text)`.
    Text(usize, usize),
    /// Nothing: the bubble's only reference text went to another of its
    /// texts, which is the start of the same speech.
    Covered,
    /// Nothing matched clearly.
    None,
}

/// Reads the references of `pages` into their text, after running Detection
/// and OCR on the pages whose own text has not been read yet. Every page's
/// result is committed as it finishes, and the whole run is one undo step.
pub(crate) async fn read_references(job: JobContext, pages: Vec<EntityId>) -> Result<RunStatus> {
    let handle = job.handle().clone();
    let snapshot = current_snapshot(&handle).await?;
    let unread = pages
        .iter()
        .copied()
        .map(|page| Ok((page, needs_ocr(&snapshot, page)?)))
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .filter_map(|(page, unread)| unread.then_some(page))
        .collect::<Vec<_>>();
    if !unread.is_empty() {
        let status = job
            .run_pipeline(
                snapshot,
                Scope::Pages(unread),
                Operation::Through { stage: Stage::Ocr },
                None,
            )
            .await?;
        if status == RunStatus::Stopped {
            return Ok(status);
        }
    }

    let target = koharu_pipeline::PipelineConfig::load()?
        .read()?
        .translation
        .target_language;
    let pipeline = handle.state::<Pipeline>().inner().clone();
    let mut reading = ReferenceReading::default();
    let mut revisions = Vec::new();
    let mut read = Vec::new();
    let total = pages.len();
    let result = async {
        for (index, page) in pages.into_iter().enumerate() {
            if job.stop.stopped() {
                return Ok(RunStatus::Stopped);
            }
            job.report(|progress| {
                progress.completed = index;
                progress.total = total;
                progress.page = Some(page);
                progress.stage = None;
                progress.model = Some(READER.to_owned());
            });
            let snapshot = current_snapshot(&handle).await?;
            let (patch, page_reading) = read_page(&pipeline, &snapshot, page, target).await?;
            reading.read += page_reading.read;
            reading.unmatched += page_reading.unmatched;
            reading.unused += page_reading.unused;
            if let Some(revision) = commit(&handle, patch).await? {
                revisions.push(revision);
            }
            read.push(page);
        }
        Ok(RunStatus::Completed)
    }
    .await;
    // Pages read before a stop or a failure stay, and undo as one step.
    {
        let project = handle.state::<CurrentProject>();
        let mut project = project.project.lock().await;
        if let Some(project) = project.as_mut() {
            project.record(revisions);
        }
    }
    match job.unfit_texts(&read).await {
        Ok(unfit) => reading.unfit = unfit,
        Err(error) => tracing::warn!(%error, "could not count texts that do not fit"),
    }
    job.report(|progress| {
        progress.completed = total;
        progress.summary = Some(JobSummary::References(reading));
    });
    result
}

async fn current_snapshot(
    handle: &tauri::AppHandle<tauri_runtime_cef::CefRuntime>,
) -> Result<Snapshot> {
    Ok(handle
        .state::<CurrentProject>()
        .project
        .lock()
        .await
        .as_ref()
        .context("no project is open")?
        .snapshot())
}

/// Commits one page's result, publishing the canvas as pipeline stages do.
async fn commit(
    handle: &tauri::AppHandle<tauri_runtime_cef::CefRuntime>,
    patch: koharu_scene::Patch,
) -> Result<Option<koharu_scene::Revision>> {
    let (commit, page) = {
        let project = handle.state::<CurrentProject>();
        let mut project = project.project.lock().await;
        let project = project.as_mut().context("no project is open")?;
        let Some(commit) = project.commit_rebased(patch).await? else {
            return Ok(None);
        };
        (commit, project.active_page())
    };
    let desktop = handle.state::<Desktop>();
    desktop.synchronize(&commit.snapshot, page, &commit).await?;
    handle
        .state::<CanvasChannel>()
        .channel
        .publish(desktop.canvas_state());
    Ok(Some(commit.revision))
}

/// Whether the page's own text has to be detected or read before its
/// reference can be paired with it: it has no text yet, or detected text
/// that OCR has not read.
fn needs_ocr(snapshot: &Snapshot, page: EntityId) -> Result<bool> {
    let Some(group) = snapshot.page(page)?.text_group()? else {
        return Ok(true);
    };
    let mut layers = group.text_layers()?.peekable();
    if layers.peek().is_none() {
        return Ok(true);
    }
    for layer in layers {
        let content = layer.content()?;
        if content.source_region()?.is_some() && content.source()?.is_none() {
            return Ok(true);
        }
    }
    Ok(false)
}

async fn read_page(
    pipeline: &Pipeline,
    snapshot: &Snapshot,
    page: EntityId,
    target: Language,
) -> Result<(koharu_scene::Patch, ReferenceReading)> {
    let (reference, image, mapping) = load(snapshot, page).await?;
    let found = pipeline.detect_layout(image.clone()).await?;
    let page_areas = page_areas(snapshot, page)?;
    let reference_areas = reference_areas(&found, &mapping);
    let matches = pair(&page_areas, &reference_areas);
    let paired = page_areas
        .iter()
        .zip(&matches)
        .flat_map(|(area, matches)| area.texts.iter().zip(matches))
        .filter(|(_, matched)| **matched != Match::Covered)
        .collect::<Vec<_>>();
    let crops = paired
        .iter()
        .filter_map(|(_, matched)| match **matched {
            Match::Text(area, text) => Some(crop(&image, reference_areas[area].texts[text].read)),
            _ => None,
        })
        .collect::<Vec<_>>();
    let used = crops.len();
    let mut read = pipeline.read_text(crops).await?.into_iter();
    let texts = paired
        .iter()
        .map(|(text, matched)| {
            let found = match matched {
                Match::Text(..) => read.next(),
                _ => None,
            };
            (text.content, found)
        })
        .collect();
    let same_language = in_language(&reference.language, target);
    let (patch, mut reading) = write(snapshot, texts, &reference.language, same_language)?;
    let found = reference_areas
        .iter()
        .map(|area| area.texts.len())
        .sum::<usize>();
    reading.unused = u32::try_from(found.saturating_sub(used)).unwrap_or(u32::MAX);
    Ok((patch, reading))
}

/// The page's reference, its decoded image, and how the image lies over the page.
async fn load(
    snapshot: &Snapshot,
    page: EntityId,
) -> Result<(PageReference, Arc<DynamicImage>, Mapping)> {
    let reference = snapshot
        .component::<PageReference>(page)?
        .with_context(|| format!("page {page} has no reference"))?;
    let asset = snapshot
        .asset(page, &AssetRole::new(PageReference::ASSET_ROLE)?)?
        .with_context(|| format!("page {page} has a reference without an image"))?;
    let bytes = snapshot.read_blob(asset.blob).await?;
    let image = Arc::new(
        tokio_rayon::spawn(move || image::load_from_memory(&bytes))
            .await
            .context("failed to decode the reference image")?,
    );
    let size = snapshot.page(page)?.page()?;
    let mapping = Mapping::new(
        reference.placement,
        [size.width, size.height],
        [f64::from(image.width()), f64::from(image.height())],
    );
    Ok((reference, image, mapping))
}

fn in_language(language: &LanguageTag, target: Language) -> bool {
    language
        .as_str()
        .parse::<Language>()
        .is_ok_and(|language| language == target)
}

/// Reads the text in one area of a page's reference, given in page pixels,
/// into the text element `layer`: the way to pair text that the automatic
/// pairing missed. It is one undo step.
pub(crate) async fn read_area(
    handle: &tauri::AppHandle<tauri_runtime_cef::CefRuntime>,
    layer: EntityId,
    area: koharu_pipeline::Bounds,
) -> Result<()> {
    let snapshot = current_snapshot(handle).await?;
    let content = snapshot.text_layer(layer)?.content()?.id();
    let page = Project::containing_page(&snapshot, layer)?;
    let (reference, image, mapping) = load(&snapshot, page).await?;
    let bounds = [area.x, area.y, area.x + area.width, area.y + area.height];
    let pipeline = handle.state::<Pipeline>().inner().clone();
    let text = pipeline
        .read_text(vec![crop(&image, mapping.to_reference(bounds))])
        .await?
        .pop();
    let target = koharu_pipeline::PipelineConfig::load()?
        .read()?
        .translation
        .target_language;
    let (patch, reading) = write(
        &snapshot,
        vec![(content, text)],
        &reference.language,
        in_language(&reference.language, target),
    )?;
    if reading.read == 0 {
        bail!("no text was found in that area of the reference");
    }
    if let Some(revision) = commit(handle, patch).await? {
        let project = handle.state::<CurrentProject>();
        let mut project = project.project.lock().await;
        if let Some(project) = project.as_mut() {
            project.record(vec![revision]);
        }
    }
    Ok(())
}

/// Writes what was read for each text content: always as its reference
/// text, and as its translation too when the reference is in the target
/// language. A content that read nothing is unmatched. Text a person wrote
/// stays.
fn write(
    snapshot: &Snapshot,
    texts: Vec<(EntityId, Option<String>)>,
    language: &LanguageTag,
    same_language: bool,
) -> Result<(koharu_scene::Patch, ReferenceReading)> {
    let mut generation = Generation::new(ProducerId::new(PRODUCER)?);
    generation.model = Some(READER.to_owned());
    let mut edit = snapshot.edit_as(generation.clone());
    let mut reading = ReferenceReading::default();
    let written = |origin: Option<&Origin>| !matches!(origin, Some(Origin::User));
    for (content, text) in texts {
        let Some(text) = text
            .map(|text| joined(&text))
            .filter(|text| !text.is_empty())
        else {
            reading.unmatched += 1;
            continue;
        };
        reading.read += 1;
        edit.observe::<ReferenceText>(content)?;
        edit.observe::<Translation>(content)?;
        edit.observe::<SourceText>(content)?;
        let reference = snapshot.component::<ReferenceText>(content)?;
        if written(reference.as_ref().map(|value| &value.text.origin)) {
            edit.set(
                content,
                &ReferenceText {
                    text: Authored::generated(text.clone(), generation.clone()),
                    language: language.clone(),
                },
            )?;
        }
        // A reference in the target language is the translation; one in
        // another language is what translation works from. A translation
        // needs source text, which OCR gave every detected text.
        let translation = snapshot.component::<Translation>(content)?;
        if same_language
            && snapshot.component::<SourceText>(content)?.is_some()
            && written(translation.as_ref().map(|value| &value.text.origin))
        {
            edit.set(
                content,
                &Translation {
                    text: Authored::generated(text, generation.clone()),
                    language: Some(language.clone()),
                },
            )?;
        }
    }
    Ok((edit.finish()?, reading))
}

/// The page's text areas: each speech bubble once, with every text that
/// flows into it, and each text outside a bubble on its own.
fn page_areas(snapshot: &Snapshot, page: EntityId) -> Result<Vec<PageArea>> {
    let Some(group) = snapshot.page(page)?.text_group()? else {
        return Ok(Vec::new());
    };
    let mut areas: Vec<PageArea> = Vec::new();
    let mut by_target = HashMap::new();
    for layer in group.text_layers()? {
        let content = layer.content()?;
        let (target, geometry) = match layer.automatic_target()? {
            Some(target) => (Some(target.id()), target.geometry()?),
            None => match layer.frame()? {
                Some(frame) => (None, frame),
                None => continue,
            },
        };
        let Some(bounds) = extents(&geometry) else {
            continue;
        };
        let detected = match content.source_region()? {
            Some(region) => extents(&region.geometry()?),
            None => None,
        };
        let text = PageText {
            content: content.id(),
            bounds: detected.unwrap_or(bounds),
        };
        if let Some(&index) = target.and_then(|target| by_target.get(&target)) {
            let area: &mut PageArea = &mut areas[index];
            area.texts.push(text);
            continue;
        }
        if let Some(target) = target {
            by_target.insert(target, areas.len());
        }
        areas.push(PageArea {
            bounds,
            texts: vec![text],
        });
    }
    for area in &mut areas {
        let order = reading_order(
            &area
                .texts
                .iter()
                .map(|text| text.bounds)
                .collect::<Vec<_>>(),
        );
        area.texts = order
            .into_iter()
            .map(|index| area.texts[index].clone())
            .collect();
    }
    Ok(areas)
}

/// The order manga is read in: rows top to bottom, and texts sharing a row
/// right to left. Texts share a row when they overlap vertically by at least
/// half the shorter one.
fn reading_order(boxes: &[Bounds]) -> Vec<usize> {
    let mut by_top = (0..boxes.len()).collect::<Vec<_>>();
    by_top.sort_by(|left, right| {
        center(boxes[*left])[1]
            .total_cmp(&center(boxes[*right])[1])
            .then(left.cmp(right))
    });
    let mut rows: Vec<(Bounds, Vec<usize>)> = Vec::new();
    for index in by_top {
        let bounds = boxes[index];
        let joins = rows.last().is_some_and(|(row, _)| {
            let shared = bounds[3].min(row[3]) - bounds[1].max(row[1]);
            shared >= 0.5 * (bounds[3] - bounds[1]).min(row[3] - row[1])
        });
        match rows.last_mut() {
            Some((row, members)) if joins => {
                *row = union(*row, bounds);
                members.push(index);
            }
            _ => rows.push((bounds, vec![index])),
        }
    }
    rows.into_iter()
        .flat_map(|(_, mut members)| {
            members.sort_by(|left, right| {
                boxes[*right][2]
                    .total_cmp(&boxes[*left][2])
                    .then(left.cmp(right))
            });
            members
        })
        .collect()
}

/// How the pixels of a reference image map onto its page.
struct Mapping {
    scale: [f64; 2],
    offset: [f64; 2],
}

impl Mapping {
    fn new(placement: ReferencePlacement, page: [f64; 2], image: [f64; 2]) -> Self {
        Self {
            scale: [
                placement.width * page[0] / image[0],
                placement.height * page[1] / image[1],
            ],
            offset: [placement.x * page[0], placement.y * page[1]],
        }
    }

    fn to_page(&self, [left, top, right, bottom]: Bounds) -> Bounds {
        [
            self.offset[0] + left * self.scale[0],
            self.offset[1] + top * self.scale[1],
            self.offset[0] + right * self.scale[0],
            self.offset[1] + bottom * self.scale[1],
        ]
    }

    fn to_reference(&self, [left, top, right, bottom]: Bounds) -> Bounds {
        [
            (left - self.offset[0]) / self.scale[0],
            (top - self.offset[1]) / self.scale[1],
            (right - self.offset[0]) / self.scale[0],
            (bottom - self.offset[1]) / self.scale[1],
        ]
    }
}

/// The reference's text areas, placed over the page: each bubble with the
/// texts found inside it, and each text outside any bubble.
fn reference_areas(found: &[LayoutBox], mapping: &Mapping) -> Vec<ReferenceArea> {
    let bounds = |found: &LayoutBox| found.bounds.map(f64::from);
    let bubbles = found
        .iter()
        .filter(|found| found.label == "bubble")
        .map(bounds)
        .collect::<Vec<_>>();
    let mut inside = vec![Vec::new(); bubbles.len()];
    let mut free = Vec::new();
    for text in found
        .iter()
        .filter(|found| found.label == "text")
        .map(bounds)
    {
        let bubble = bubbles
            .iter()
            .enumerate()
            .filter(|(_, bubble)| containment(**bubble, text) >= MIN_CONTAINMENT)
            .min_by(|(_, left), (_, right)| area(**left).total_cmp(&area(**right)));
        match bubble {
            Some((index, _)) => inside[index].push(text),
            None => free.push(text),
        }
    }
    let found = |read: Bounds| FoundText {
        bounds: mapping.to_page(read),
        read,
    };
    bubbles
        .iter()
        .zip(inside)
        .map(|(bubble, mut texts)| {
            if texts.is_empty() {
                texts.push(*bubble);
            }
            let order = reading_order(&texts);
            ReferenceArea {
                bounds: mapping.to_page(*bubble),
                texts: order.into_iter().map(|index| found(texts[index])).collect(),
            }
        })
        .chain(free.into_iter().map(|text| ReferenceArea {
            bounds: mapping.to_page(text),
            texts: vec![found(text)],
        }))
        .collect()
}

/// Decides which reference text each page text receives; each reference text
/// goes to one page text at most, and no page text receives two.
///
/// 1. Areas pair one to one, those overlapping most first. A page area that
///    overlaps no reference area may take the nearest reference area that
///    overlaps no page area, when both hold one text and misalignment
///    explains the distance.
/// 2. A paired reference area with one text gives it to the area's first
///    page text in reading order. One with several pairs them text by text by
///    their overlap, helped by reading order when both hold as many texts.
/// 3. Page texts still without text take the unused reference text they
///    overlap most, on any bubble, since detection may join or split bubbles
///    differently on each edition. A text also overlaps a bubble of one text
///    on the other side, so lettering placed off center still pairs.
/// 4. A page area of one text that still has an unused reference text inside
///    it matches more than one reference text and is left unmatched.
fn pair(page: &[PageArea], reference: &[ReferenceArea]) -> Vec<Vec<Match>> {
    let mut matches = page
        .iter()
        .map(|area| vec![Match::None; area.texts.len()])
        .collect::<Vec<_>>();
    let mut used = reference
        .iter()
        .map(|area| vec![false; area.texts.len()])
        .collect::<Vec<_>>();

    for (page_index, reference_index) in pair_areas(page, reference) {
        let (texts, found) = (&page[page_index].texts, &reference[reference_index].texts);
        if found.len() == 1 {
            matches[page_index][0] = Match::Text(reference_index, 0);
            for covered in &mut matches[page_index][1..] {
                *covered = Match::Covered;
            }
            used[reference_index][0] = true;
            continue;
        }
        let ordered = texts.len() == found.len();
        let candidates = texts.iter().enumerate().flat_map(|(text, page_text)| {
            found.iter().enumerate().map(move |(other, found_text)| {
                let same_place = if ordered && text == other {
                    SAME_PLACE
                } else {
                    0.0
                };
                (
                    affinity(page_text.bounds, found_text.bounds) + same_place,
                    text,
                    other,
                )
            })
        });
        for (text, other) in one_to_one(candidates) {
            matches[page_index][text] = Match::Text(reference_index, other);
            used[reference_index][other] = true;
        }
    }

    let candidates = page.iter().enumerate().flat_map(|(page_index, area)| {
        let matches = &matches;
        let used = &used;
        area.texts
            .iter()
            .enumerate()
            .filter(move |(text, _)| matches[page_index][*text] == Match::None)
            .flat_map(move |(text, page_text)| {
                reference
                    .iter()
                    .enumerate()
                    .flat_map(|(reference_index, area)| {
                        area.texts
                            .iter()
                            .enumerate()
                            .map(move |(other, found)| (reference_index, other, found))
                    })
                    .filter(|(reference_index, other, _)| !used[*reference_index][*other])
                    .map(move |(reference_index, other, found)| {
                        let mut score = affinity(page_text.bounds, found.bounds);
                        if reference[reference_index].texts.len() == 1 {
                            score = score.max(affinity(
                                page_text.bounds,
                                reference[reference_index].bounds,
                            ));
                        }
                        if page[page_index].texts.len() == 1 {
                            score = score.max(affinity(page[page_index].bounds, found.bounds));
                        }
                        (score, (page_index, text), (reference_index, other))
                    })
            })
    });
    for ((page_index, text), (reference_index, other)) in one_to_one(candidates.collect::<Vec<_>>())
    {
        matches[page_index][text] = Match::Text(reference_index, other);
        used[reference_index][other] = true;
    }

    for (page_index, area) in page.iter().enumerate() {
        let [Match::Text(reference_index, other)] = matches[page_index][..] else {
            continue;
        };
        let more = reference.iter().enumerate().any(|(index, candidate)| {
            candidate.texts.iter().enumerate().any(|(text, found)| {
                !used[index][text] && containment(area.bounds, found.bounds) >= MIN_CONTAINMENT
            })
        });
        if more {
            matches[page_index][0] = Match::None;
            used[reference_index][other] = false;
        }
    }
    matches
}

/// Pairs page areas with reference areas one to one, see [`pair`].
fn pair_areas(page: &[PageArea], reference: &[ReferenceArea]) -> Vec<(usize, usize)> {
    let candidates = page.iter().enumerate().flat_map(|(page_index, page_area)| {
        reference
            .iter()
            .enumerate()
            .map(move |(reference_index, reference_area)| {
                (
                    affinity(page_area.bounds, reference_area.bounds),
                    page_index,
                    reference_index,
                )
            })
    });
    let mut pairs = one_to_one(candidates.collect::<Vec<_>>());
    let page_bounds = page.iter().map(|area| area.bounds).collect::<Vec<_>>();
    let reference_bounds = reference.iter().map(|area| area.bounds).collect::<Vec<_>>();
    let overlapping = |bounds: Bounds, others: &[Bounds]| {
        others
            .iter()
            .any(|other| affinity(bounds, *other) >= MIN_AFFINITY)
    };
    let mut taken = vec![false; reference.len()];
    for (_, reference_index) in &pairs {
        taken[*reference_index] = true;
    }
    for (page_index, page_area) in page.iter().enumerate() {
        if page_area.texts.len() != 1
            || pairs.iter().any(|(paired, _)| *paired == page_index)
            || overlapping(page_area.bounds, &reference_bounds)
        {
            continue;
        }
        let nearest = reference
            .iter()
            .enumerate()
            .filter(|(index, area)| {
                !taken[*index] && area.texts.len() == 1 && !overlapping(area.bounds, &page_bounds)
            })
            .map(|(index, area)| (index, distance(page_area.bounds, area.bounds), area))
            .filter(|(_, distance, area)| {
                *distance <= NEAR * diagonal(page_area.bounds).max(diagonal(area.bounds))
            })
            .min_by(|left, right| left.1.total_cmp(&right.1));
        if let Some((index, _, _)) = nearest {
            pairs.push((page_index, index));
            taken[index] = true;
        }
    }
    pairs
}

/// Picks pairs from `(score, left, right)` candidates, best first, using each
/// left and each right once and only scores of at least [`MIN_AFFINITY`].
fn one_to_one<L: Copy + Eq, R: Copy + Eq>(
    candidates: impl IntoIterator<Item = (f64, L, R)>,
) -> Vec<(L, R)> {
    let mut candidates = candidates
        .into_iter()
        .filter(|(score, _, _)| *score >= MIN_AFFINITY)
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| right.0.total_cmp(&left.0));
    let mut pairs: Vec<(L, R)> = Vec::new();
    for (_, left, right) in candidates {
        if pairs
            .iter()
            .all(|(paired, other)| *paired != left && *other != right)
        {
            pairs.push((left, right));
        }
    }
    pairs
}

/// Joins OCR lines into one text: lettering breaks lines to fit the bubble,
/// while the editor wraps text itself. Lines join with a space, except after
/// a hyphen and between scripts written without spaces.
fn joined(text: &str) -> String {
    let mut joined = String::new();
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if let (Some(last), Some(first)) = (joined.chars().last(), line.chars().next())
            && last != '-'
            && !(unspaced(last) && unspaced(first))
        {
            joined.push(' ');
        }
        joined.push_str(&line);
    }
    joined
}

/// Han, kana, and fullwidth punctuation, which are written without spaces.
fn unspaced(character: char) -> bool {
    matches!(character,
        '\u{3000}'..='\u{30ff}' | '\u{3400}'..='\u{4dbf}' | '\u{4e00}'..='\u{9fff}'
        | '\u{f900}'..='\u{faff}' | '\u{ff00}'..='\u{ffef}')
}

fn crop(image: &DynamicImage, [left, top, right, bottom]: Bounds) -> DynamicImage {
    let width = f64::from(image.width());
    let height = f64::from(image.height());
    let left = (left - READ_PADDING).clamp(0.0, width - 1.0).floor();
    let top = (top - READ_PADDING).clamp(0.0, height - 1.0).floor();
    let right = (right + READ_PADDING).clamp(left + 1.0, width).ceil();
    let bottom = (bottom + READ_PADDING).clamp(top + 1.0, height).ceil();
    image.crop_imm(
        left as u32,
        top as u32,
        (right - left) as u32,
        (bottom - top) as u32,
    )
}

fn extents(geometry: &Geometry) -> Option<Bounds> {
    let mut points = geometry.points.iter();
    let first = points.next()?;
    Some(
        points.fold([first.x, first.y, first.x, first.y], |bounds, point| {
            [
                bounds[0].min(point.x),
                bounds[1].min(point.y),
                bounds[2].max(point.x),
                bounds[3].max(point.y),
            ]
        }),
    )
}

fn area([left, top, right, bottom]: Bounds) -> f64 {
    (right - left).max(0.0) * (bottom - top).max(0.0)
}

fn intersection(left: Bounds, right: Bounds) -> f64 {
    area([
        left[0].max(right[0]),
        left[1].max(right[1]),
        left[2].min(right[2]),
        left[3].min(right[3]),
    ])
}

fn union(left: Bounds, right: Bounds) -> Bounds {
    [
        left[0].min(right[0]),
        left[1].min(right[1]),
        left[2].max(right[2]),
        left[3].max(right[3]),
    ]
}

/// The share of `inner` that lies inside `outer`.
fn containment(outer: Bounds, inner: Bounds) -> f64 {
    let inner_area = area(inner);
    if inner_area <= 0.0 {
        0.0
    } else {
        intersection(outer, inner) / inner_area
    }
}

/// How well two areas coincide. The same bubble usually overlaps itself
/// closely; text lettered in another script fills its area differently, so
/// one area lying mostly inside the other also counts, a little less.
fn affinity(left: Bounds, right: Bounds) -> f64 {
    let shared = intersection(left, right);
    if shared <= 0.0 {
        return 0.0;
    }
    let iou = shared / (area(left) + area(right) - shared);
    let cover = shared / area(left).min(area(right));
    iou.max(cover * 0.6)
}

fn center([left, top, right, bottom]: Bounds) -> [f64; 2] {
    [(left + right) / 2.0, (top + bottom) / 2.0]
}

fn distance(left: Bounds, right: Bounds) -> f64 {
    let [x, y] = center(left);
    let [other_x, other_y] = center(right);
    (x - other_x).hypot(y - other_y)
}

fn diagonal([left, top, right, bottom]: Bounds) -> f64 {
    (right - left).hypot(bottom - top)
}

#[cfg(test)]
mod tests {
    use koharu_scene::{
        At, BubbleRegion, FitsTo, FlowsIn, PageDraft, RecognizedFrom, Session, TextLayout,
        TextLayoutKind, TextRegion,
    };

    use super::*;

    /// A page with one bubble that two texts flow into and one free text.
    async fn page_with_text() -> (Session, EntityId, Vec<EntityId>) {
        let mut session = Session::memory().await.unwrap();
        let mut edit = session.snapshot().edit();
        let page = edit
            .add_page(PageDraft::new("page", 1000.0, 1500.0), At::End)
            .unwrap();
        let bubble = edit
            .add_analysis_region::<BubbleRegion>(
                page,
                At::End,
                &Geometry::rectangle(100.0, 100.0, 200.0, 200.0),
                None,
            )
            .unwrap();
        let free = edit
            .add_analysis_region::<TextRegion>(
                page,
                At::End,
                &Geometry::rectangle(600.0, 1200.0, 200.0, 100.0),
                None,
            )
            .unwrap();
        let mut contents = Vec::new();
        for (index, target) in [bubble, bubble, free].into_iter().enumerate() {
            let content = edit.add_text_content(page, At::End).unwrap();
            edit.set(
                content,
                &SourceText {
                    text: Authored::user(format!("源{index}")),
                    language: None,
                },
            )
            .unwrap();
            let layer = edit
                .add_text_layer(
                    page,
                    At::End,
                    content,
                    &TextLayout {
                        origin: Origin::User,
                        kind: TextLayoutKind::Paragraph,
                        angle_degrees: None,
                    },
                )
                .unwrap();
            if target == bubble {
                edit.relate::<FlowsIn>(layer, target).unwrap();
            } else {
                edit.relate::<FitsTo>(layer, target).unwrap();
                let detected = edit
                    .add_analysis_region::<TextRegion>(
                        page,
                        At::End,
                        &Geometry::rectangle(610.0, 1210.0, 180.0, 80.0),
                        None,
                    )
                    .unwrap();
                edit.relate::<RecognizedFrom>(content, detected).unwrap();
            }
            contents.push(content);
        }
        session.commit(edit.finish().unwrap()).await.unwrap();
        (session, page, contents)
    }

    #[tokio::test]
    async fn page_areas_are_bubbles_with_their_texts_and_free_texts() {
        let (session, page, contents) = page_with_text().await;
        let text = |content, bounds| PageText { content, bounds };
        assert_eq!(
            page_areas(&session.snapshot(), page).unwrap(),
            [
                PageArea {
                    bounds: [100.0, 100.0, 300.0, 300.0],
                    texts: vec![
                        text(contents[0], [100.0, 100.0, 300.0, 300.0]),
                        text(contents[1], [100.0, 100.0, 300.0, 300.0]),
                    ],
                },
                PageArea {
                    bounds: [600.0, 1200.0, 800.0, 1300.0],
                    texts: vec![text(contents[2], [610.0, 1210.0, 790.0, 1290.0])],
                },
            ]
        );
    }

    #[test]
    fn texts_are_read_in_rows_from_the_top_and_right_to_left_within_a_row() {
        assert_eq!(
            reading_order(&[
                [10.0, 300.0, 90.0, 360.0],
                [10.0, 100.0, 90.0, 200.0],
                [200.0, 110.0, 280.0, 190.0],
                [100.0, 120.0, 190.0, 220.0],
            ]),
            [2, 3, 1, 0]
        );
    }

    #[tokio::test]
    async fn read_text_is_kept_as_reference_and_becomes_the_translation_in_the_target_language() {
        let (mut session, _, contents) = page_with_text().await;
        let english = LanguageTag::new("en-US").unwrap();
        let snapshot = session.snapshot();
        let (patch, reading) = write(
            &snapshot,
            vec![
                (contents[0], Some("WHERE ARE\nYOU?".to_owned())),
                (contents[2], None),
            ],
            &english,
            true,
        )
        .unwrap();
        assert_eq!(
            reading,
            ReferenceReading {
                read: 1,
                unmatched: 1,
                ..ReferenceReading::default()
            }
        );
        let snapshot = session.commit(patch).await.unwrap().snapshot;
        let text = |content| {
            let content = snapshot.text_content(content).unwrap();
            (
                content.reference().unwrap().map(|value| value.text.value),
                content.translation().unwrap().map(|value| value.text.value),
            )
        };
        assert_eq!(
            text(contents[0]),
            (
                Some("WHERE ARE YOU?".to_owned()),
                Some("WHERE ARE YOU?".to_owned())
            )
        );
        assert_eq!(text(contents[1]), (None, None));
        assert_eq!(text(contents[2]), (None, None));

        // A translation someone wrote stays, and other languages only add
        // reference text.
        let mut edit = snapshot.edit();
        edit.set(
            contents[0],
            &Translation {
                text: Authored::user("Mau ke mana?".to_owned()),
                language: None,
            },
        )
        .unwrap();
        let snapshot = session
            .commit(edit.finish().unwrap())
            .await
            .unwrap()
            .snapshot;
        let (patch, _) = write(
            &snapshot,
            vec![
                (contents[0], Some("WHERE?".to_owned())),
                (contents[2], Some("HEY".to_owned())),
            ],
            &english,
            false,
        )
        .unwrap();
        let snapshot = session.commit(patch).await.unwrap().snapshot;
        let content = snapshot.text_content(contents[0]).unwrap();
        assert_eq!(
            content.translation().unwrap().unwrap().text.value,
            "Mau ke mana?"
        );
        assert_eq!(content.reference().unwrap().unwrap().text.value, "WHERE?");
        let free = snapshot.text_content(contents[2]).unwrap();
        assert_eq!(free.reference().unwrap().unwrap().text.value, "HEY");
        assert!(free.translation().unwrap().is_none());
    }

    fn found(label: &str, bounds: [f32; 4]) -> LayoutBox {
        LayoutBox {
            label: label.to_owned(),
            score: 0.9,
            bounds,
        }
    }

    /// A page area: a bubble and its texts' boxes, or one text alone.
    fn page_area(bounds: Bounds, texts: &[Bounds]) -> PageArea {
        let texts = if texts.is_empty() {
            &[bounds][..]
        } else {
            texts
        };
        PageArea {
            bounds,
            texts: texts
                .iter()
                .map(|bounds| PageText {
                    content: EntityId::new(),
                    bounds: *bounds,
                })
                .collect(),
        }
    }

    /// A reference area: a bubble and its texts' boxes, or one text alone.
    fn reference_area(bounds: Bounds, texts: &[Bounds]) -> ReferenceArea {
        let texts = if texts.is_empty() {
            &[bounds][..]
        } else {
            texts
        };
        ReferenceArea {
            bounds,
            texts: texts
                .iter()
                .map(|bounds| FoundText {
                    bounds: *bounds,
                    read: [0.0; 4],
                })
                .collect(),
        }
    }

    #[test]
    fn reference_areas_are_placed_over_the_page_with_their_text() {
        // A half-size reference shifted right by a tenth of the page.
        let mapping = Mapping::new(
            ReferencePlacement {
                x: 0.1,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            },
            [1000.0, 1500.0],
            [500.0, 750.0],
        );
        let areas = reference_areas(
            &[
                found("bubble", [10.0, 10.0, 110.0, 60.0]),
                found("text", [30.0, 20.0, 90.0, 50.0]),
                found("text", [300.0, 400.0, 340.0, 420.0]),
                found("panel", [0.0, 0.0, 500.0, 750.0]),
                // Two texts in one bubble stay two texts, in reading order.
                found("bubble", [200.0, 100.0, 300.0, 300.0]),
                found("text", [210.0, 220.0, 290.0, 280.0]),
                found("text", [210.0, 110.0, 290.0, 150.0]),
                // A bubble without detected text is read whole.
                found("bubble", [400.0, 10.0, 450.0, 60.0]),
            ],
            &mapping,
        );
        let text = |bounds, read| FoundText { bounds, read };
        assert_eq!(
            areas,
            [
                ReferenceArea {
                    bounds: [120.0, 20.0, 320.0, 120.0],
                    texts: vec![text([160.0, 40.0, 280.0, 100.0], [30.0, 20.0, 90.0, 50.0])],
                },
                ReferenceArea {
                    bounds: [500.0, 200.0, 700.0, 600.0],
                    texts: vec![
                        text([520.0, 220.0, 680.0, 300.0], [210.0, 110.0, 290.0, 150.0]),
                        text([520.0, 440.0, 680.0, 560.0], [210.0, 220.0, 290.0, 280.0]),
                    ],
                },
                ReferenceArea {
                    bounds: [900.0, 20.0, 1000.0, 120.0],
                    texts: vec![text(
                        [900.0, 20.0, 1000.0, 120.0],
                        [400.0, 10.0, 450.0, 60.0]
                    )],
                },
                ReferenceArea {
                    bounds: [700.0, 800.0, 780.0, 840.0],
                    texts: vec![text(
                        [700.0, 800.0, 780.0, 840.0],
                        [300.0, 400.0, 340.0, 420.0]
                    )],
                },
            ]
        );
        // An area picked on the page maps back to the same reference pixels.
        assert_eq!(
            mapping.to_reference([120.0, 20.0, 320.0, 120.0]),
            [10.0, 10.0, 110.0, 60.0]
        );
    }

    #[test]
    fn bubbles_pair_by_overlap_then_by_nearness_without_sharing() {
        let page = [
            page_area([100.0, 100.0, 300.0, 200.0], &[]),
            page_area([600.0, 100.0, 700.0, 400.0], &[]),
            page_area([100.0, 900.0, 200.0, 1000.0], &[]),
            page_area([800.0, 1300.0, 900.0, 1400.0], &[]),
            // Two texts in one bubble: the reference's single text goes to
            // the first, which starts the same speech.
            page_area(
                [300.0, 600.0, 500.0, 800.0],
                &[[320.0, 620.0, 380.0, 780.0], [420.0, 620.0, 480.0, 780.0]],
            ),
        ];
        let reference = [
            // Slightly shifted copy of the first bubble.
            reference_area([110.0, 105.0, 310.0, 205.0], &[]),
            // Horizontal lettering inside the second, vertical, text.
            reference_area([590.0, 220.0, 720.0, 280.0], &[]),
            // Near the third area, without touching it.
            reference_area([205.0, 905.0, 290.0, 995.0], &[]),
            // Far from everything.
            reference_area([400.0, 450.0, 450.0, 500.0], &[]),
            reference_area(
                [300.0, 600.0, 500.0, 800.0],
                &[[330.0, 650.0, 470.0, 750.0]],
            ),
        ];
        assert_eq!(
            pair(&page, &reference),
            [
                vec![Match::Text(0, 0)],
                vec![Match::Text(1, 0)],
                vec![Match::Text(2, 0)],
                vec![Match::None],
                vec![Match::Text(4, 0), Match::Covered],
            ]
        );
    }

    /// Three stacked bubbles lettered at different sizes in each edition
    /// (#13): text by text, never two reference texts in one page text.
    fn stacked_reference() -> [ReferenceArea; 2] {
        [
            // A small bubble, lettered off center.
            reference_area([170.0, 95.0, 310.0, 185.0], &[[190.0, 115.0, 290.0, 165.0]]),
            // Two bubbles that detection joined into one.
            reference_area(
                [80.0, 200.0, 420.0, 690.0],
                &[[110.0, 225.0, 360.0, 275.0], [140.0, 340.0, 360.0, 640.0]],
            ),
        ]
    }

    #[test]
    fn stacked_bubbles_joined_on_the_page_pair_text_by_text() {
        let page = [page_area(
            [100.0, 100.0, 400.0, 700.0],
            &[
                [200.0, 110.0, 300.0, 170.0],
                [130.0, 220.0, 380.0, 280.0],
                [150.0, 350.0, 350.0, 650.0],
            ],
        )];
        assert_eq!(
            pair(&page, &stacked_reference()),
            [vec![
                Match::Text(0, 0),
                Match::Text(1, 0),
                Match::Text(1, 1)
            ]]
        );
    }

    #[test]
    fn stacked_bubbles_apart_on_the_page_pair_text_by_text() {
        let page = [
            page_area(
                [180.0, 100.0, 320.0, 180.0],
                &[[200.0, 110.0, 300.0, 170.0]],
            ),
            page_area(
                [110.0, 200.0, 400.0, 300.0],
                &[[130.0, 220.0, 380.0, 280.0]],
            ),
            page_area(
                [120.0, 320.0, 380.0, 690.0],
                &[[150.0, 350.0, 350.0, 650.0]],
            ),
        ];
        assert_eq!(
            pair(&page, &stacked_reference()),
            [
                vec![Match::Text(0, 0)],
                vec![Match::Text(1, 0)],
                vec![Match::Text(1, 1)],
            ]
        );
    }

    #[test]
    fn a_bubble_matching_two_reference_bubbles_stays_unmatched() {
        let page = [page_area(
            [100.0, 100.0, 400.0, 400.0],
            &[[150.0, 150.0, 350.0, 350.0]],
        )];
        let reference = [
            reference_area(
                [100.0, 100.0, 400.0, 240.0],
                &[[150.0, 140.0, 350.0, 200.0]],
            ),
            reference_area(
                [100.0, 260.0, 400.0, 400.0],
                &[[150.0, 300.0, 350.0, 360.0]],
            ),
        ];
        assert_eq!(pair(&page, &reference), [vec![Match::None]]);
    }

    #[test]
    fn text_from_lettered_lines_reads_as_one_paragraph() {
        assert_eq!(joined("WHERE ARE\n  YOU GOING?\n"), "WHERE ARE YOU GOING?");
        assert_eq!(joined("WELL-\nKNOWN"), "WELL-KNOWN");
        assert_eq!(joined("どこへ\n行くの？"), "どこへ行くの？");
        assert_eq!(joined("\n\n"), "");
    }
}
