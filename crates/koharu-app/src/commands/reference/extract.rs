//! Reading the text of references into their pages.
//!
//! A reference shows the same artwork as its page, so once it is placed over
//! the page their speech bubbles line up. Layout detection finds the
//! reference's bubbles and text, each found area is mapped into page space
//! through the placement and paired with the page's own bubble or text area
//! that it overlaps most, and the paired reference areas are read with OCR.

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
/// How much a page area and a reference area must overlap to pair at once.
const MIN_AFFINITY: f64 = 0.2;
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
    /// Text areas of the pages that received text from their reference.
    pub read: u32,
    /// Text areas of the pages that no reference area matched.
    pub unmatched: u32,
    /// Text areas found in references that matched nothing on their page.
    pub unused: u32,
}

/// Where text sits on a page: a speech bubble with the text contents that
/// flow into it, or text outside any bubble.
#[derive(Clone, Debug, PartialEq)]
struct PageArea {
    bounds: Bounds,
    /// In text order; the first one receives the reference's text.
    contents: Vec<EntityId>,
}

/// An area of a reference with text to read.
#[derive(Clone, Debug, PartialEq)]
struct ReferenceArea {
    /// Where the area lies over the page, in page pixels.
    bounds: Bounds,
    /// What to read, in reference pixels.
    read: Bounds,
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
    let pairs = pair(&page_areas, &reference_areas);
    let crops = pairs
        .iter()
        .flatten()
        .map(|&index| crop(&image, reference_areas[index].read))
        .collect::<Vec<_>>();
    let mut texts = pipeline.read_text(crops).await?.into_iter();
    let read = pairs
        .iter()
        .map(|paired| paired.and_then(|_| texts.next()))
        .collect::<Vec<_>>();
    let same_language = in_language(&reference.language, target);
    let (patch, mut reading) = write(
        snapshot,
        &page_areas,
        read,
        &reference.language,
        same_language,
    )?;
    reading.unused = u32::try_from(
        reference_areas
            .len()
            .saturating_sub(pairs.iter().flatten().count()),
    )
    .unwrap_or(u32::MAX);
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
        &[PageArea {
            bounds,
            contents: vec![content],
        }],
        vec![text],
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

/// Writes what was read for each page area into the area's first text
/// content: always as its reference text, and as its translation too when the
/// reference is in the target language. Text a person wrote stays.
fn write(
    snapshot: &Snapshot,
    areas: &[PageArea],
    read: Vec<Option<String>>,
    language: &LanguageTag,
    same_language: bool,
) -> Result<(koharu_scene::Patch, ReferenceReading)> {
    let mut generation = Generation::new(ProducerId::new(PRODUCER)?);
    generation.model = Some(READER.to_owned());
    let mut edit = snapshot.edit_as(generation.clone());
    let mut reading = ReferenceReading::default();
    let written = |origin: Option<&Origin>| !matches!(origin, Some(Origin::User));
    for (area, text) in areas.iter().zip(read) {
        let text = text.map(|text| joined(&text));
        let (Some(text), Some(&content)) =
            (text.filter(|text| !text.is_empty()), area.contents.first())
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

/// The page's text areas: each speech bubble once, with every text content
/// that flows into it, and each text outside a bubble on its own.
fn page_areas(snapshot: &Snapshot, page: EntityId) -> Result<Vec<PageArea>> {
    let Some(group) = snapshot.page(page)?.text_group()? else {
        return Ok(Vec::new());
    };
    let mut areas: Vec<PageArea> = Vec::new();
    let mut by_target = HashMap::new();
    for layer in group.text_layers()? {
        let content = layer.content()?.id();
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
        if let Some(&index) = target.and_then(|target| by_target.get(&target)) {
            let area: &mut PageArea = &mut areas[index];
            area.contents.push(content);
            continue;
        }
        if let Some(target) = target {
            by_target.insert(target, areas.len());
        }
        areas.push(PageArea {
            bounds,
            contents: vec![content],
        });
    }
    Ok(areas)
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
/// text found inside it, and each text outside any bubble.
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
    bubbles
        .iter()
        .zip(inside)
        .map(|(bubble, texts)| ReferenceArea {
            bounds: mapping.to_page(*bubble),
            // A bubble without detected text is read whole.
            read: texts.into_iter().reduce(union).unwrap_or(*bubble),
        })
        .chain(free.into_iter().map(|text| ReferenceArea {
            bounds: mapping.to_page(text),
            read: text,
        }))
        .collect()
}

/// Pairs each page area with at most one reference area: first those that
/// overlap most, then, for areas still alone, the nearest reference area
/// close enough that misalignment explains the distance.
fn pair(page: &[PageArea], reference: &[ReferenceArea]) -> Vec<Option<usize>> {
    let mut candidates = Vec::new();
    for (page_index, page_area) in page.iter().enumerate() {
        for (reference_index, reference_area) in reference.iter().enumerate() {
            let affinity = affinity(page_area.bounds, reference_area.bounds);
            if affinity >= MIN_AFFINITY {
                candidates.push((affinity, page_index, reference_index));
            }
        }
    }
    candidates.sort_by(|left, right| right.0.total_cmp(&left.0));
    let mut pairs = vec![None; page.len()];
    let mut used = vec![false; reference.len()];
    for (_, page_index, reference_index) in candidates {
        if pairs[page_index].is_none() && !used[reference_index] {
            pairs[page_index] = Some(reference_index);
            used[reference_index] = true;
        }
    }
    for (page_index, page_area) in page.iter().enumerate() {
        if pairs[page_index].is_some() {
            continue;
        }
        let nearest = reference
            .iter()
            .enumerate()
            .filter(|(index, _)| !used[*index])
            .map(|(index, area)| (index, distance(page_area.bounds, area.bounds), area))
            .filter(|(_, distance, area)| {
                *distance <= NEAR * diagonal(page_area.bounds).max(diagonal(area.bounds))
            })
            .min_by(|left, right| left.1.total_cmp(&right.1));
        if let Some((index, _, _)) = nearest {
            pairs[page_index] = Some(index);
            used[index] = true;
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
        At, BubbleRegion, FitsTo, FlowsIn, PageDraft, Session, TextLayout, TextLayoutKind,
        TextRegion,
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
            }
            contents.push(content);
        }
        session.commit(edit.finish().unwrap()).await.unwrap();
        (session, page, contents)
    }

    #[tokio::test]
    async fn page_areas_are_bubbles_with_their_texts_and_free_texts() {
        let (session, page, contents) = page_with_text().await;
        assert_eq!(
            page_areas(&session.snapshot(), page).unwrap(),
            [
                PageArea {
                    bounds: [100.0, 100.0, 300.0, 300.0],
                    contents: vec![contents[0], contents[1]],
                },
                PageArea {
                    bounds: [600.0, 1200.0, 800.0, 1300.0],
                    contents: vec![contents[2]],
                },
            ]
        );
    }

    #[tokio::test]
    async fn read_text_is_kept_as_reference_and_becomes_the_translation_in_the_target_language() {
        let (mut session, page, contents) = page_with_text().await;
        let english = LanguageTag::new("en-US").unwrap();
        let snapshot = session.snapshot();
        let areas = page_areas(&snapshot, page).unwrap();
        let (patch, reading) = write(
            &snapshot,
            &areas,
            vec![Some("WHERE ARE\nYOU?".to_owned()), None],
            &english,
            true,
        )
        .unwrap();
        assert_eq!(
            reading,
            ReferenceReading {
                read: 1,
                unmatched: 1,
                unused: 0,
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
            &areas,
            vec![Some("WHERE?".to_owned()), Some("HEY".to_owned())],
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

    fn page_area(bounds: Bounds) -> PageArea {
        PageArea {
            bounds,
            contents: vec![EntityId::new()],
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
            ],
            &mapping,
        );
        assert_eq!(
            areas,
            [
                ReferenceArea {
                    bounds: [120.0, 20.0, 320.0, 120.0],
                    read: [30.0, 20.0, 90.0, 50.0],
                },
                ReferenceArea {
                    bounds: [700.0, 800.0, 780.0, 840.0],
                    read: [300.0, 400.0, 340.0, 420.0],
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
    fn areas_pair_by_overlap_then_by_nearness_without_sharing() {
        let page = [
            page_area([100.0, 100.0, 300.0, 200.0]),
            page_area([600.0, 100.0, 700.0, 400.0]),
            page_area([100.0, 900.0, 200.0, 1000.0]),
            page_area([800.0, 1300.0, 900.0, 1400.0]),
        ];
        let reference = [
            // Slightly shifted copy of the first bubble.
            ReferenceArea {
                bounds: [110.0, 105.0, 310.0, 205.0],
                read: [0.0; 4],
            },
            // Horizontal lettering inside the second, vertical, text.
            ReferenceArea {
                bounds: [590.0, 220.0, 720.0, 280.0],
                read: [0.0; 4],
            },
            // Near the third area, without touching it.
            ReferenceArea {
                bounds: [205.0, 905.0, 290.0, 995.0],
                read: [0.0; 4],
            },
            // Far from everything.
            ReferenceArea {
                bounds: [400.0, 600.0, 450.0, 650.0],
                read: [0.0; 4],
            },
        ];
        assert_eq!(pair(&page, &reference), [Some(0), Some(1), Some(2), None]);
    }

    #[test]
    fn text_from_lettered_lines_reads_as_one_paragraph() {
        assert_eq!(joined("WHERE ARE\n  YOU GOING?\n"), "WHERE ARE YOU GOING?");
        assert_eq!(joined("WELL-\nKNOWN"), "WELL-KNOWN");
        assert_eq!(joined("どこへ\n行くの？"), "どこへ行くの？");
        assert_eq!(joined("\n\n"), "");
    }
}
