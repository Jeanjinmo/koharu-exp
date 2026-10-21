//! Translated editions of pages, attached to guide their translation.
//!
//! Importing references stages the images first, so they can be paired with
//! pages before anything is written to the project. Attaching stores each one
//! as the page's `PageReference::ASSET_ROLE` asset, which neither rendering
//! nor export reads.

mod extract;

pub use extract::ReferenceReading;

use std::{io::Cursor, sync::Arc};

use anyhow::{Context as _, Result};
use image::{
    DynamicImage, ExtendedColorType, ImageEncoder as _, ImageFormat, Rgb, RgbImage,
    codecs::jpeg::JpegEncoder, imageops::FilterType,
};
use koharu_desktop::Desktop;
use koharu_scene::{
    AssetInput, AssetMetadata, EntityId, LanguageTag, PageReference, ReferencePlacement,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, State, WebviewWindow};
use tauri_runtime_cef::CefRuntime;

use super::{
    ChannelExt as _, Error,
    canvas::CanvasChannel,
    import::{self, PageImportSource},
    output::{THUMBNAIL_EDGE, ThumbnailBytes},
    processing::{JobId, JobKind, Processing, start_job},
    project::CurrentProject,
};

/// References only guide translation, so larger images are scaled down to
/// keep a long PDF within memory.
const MAX_EDGE: u32 = 4096;
const JPEG_QUALITY: u8 = 90;
/// How far a margin pixel may differ from the border color per channel, so
/// JPEG noise and paper grain still count as a plain margin.
const MARGIN_TOLERANCE: u8 = 24;

/// Reference images read from disk that are waiting to be paired with pages.
#[derive(Default)]
pub(crate) struct StagedReferences {
    images: Mutex<Vec<Arc<StagedReference>>>,
}

struct StagedReference {
    name: String,
    bytes: Arc<[u8]>,
    media_type: &'static str,
    width: u32,
    height: u32,
    thumbnail: Vec<u8>,
}

impl StagedReference {
    fn asset(&self) -> AssetInput {
        AssetInput::new(
            self.bytes.clone(),
            self.media_type,
            AssetMetadata {
                width: Some(self.width),
                height: Some(self.height),
                attributes: Default::default(),
            },
        )
    }
}

#[derive(Clone, Debug, Serialize, Type)]
pub struct ReferenceCandidate {
    pub name: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, Type)]
pub struct ReferencePair {
    pub page: EntityId,
    /// The position of the reference among the staged images.
    pub reference: u32,
}

/// Reads reference images and keeps them until they are attached or
/// discarded. `None` means the file dialog was dismissed.
#[tauri::command]
#[specta::specta]
pub(crate) async fn stage_references(
    source: PageImportSource,
    trim_margins: bool,
    window: WebviewWindow<CefRuntime>,
    project: State<'_, CurrentProject>,
    staged: State<'_, StagedReferences>,
) -> std::result::Result<Option<Vec<ReferenceCandidate>>, Error> {
    project
        .project
        .lock()
        .await
        .as_ref()
        .context("no project is open")?;
    let Some(files) = import::pick(source, &window).await? else {
        return Ok(None);
    };
    let images =
        tokio_rayon::spawn(move || import::import(files, |page| prepare(page, trim_margins)))
            .await?;
    let candidates = images
        .iter()
        .map(|image| ReferenceCandidate {
            name: image.name.clone(),
            width: image.width,
            height: image.height,
        })
        .collect();
    *staged.images.lock() = images.into_iter().map(Arc::new).collect();
    Ok(Some(candidates))
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn get_staged_reference_thumbnail(
    reference: u32,
    staged: State<'_, StagedReferences>,
) -> std::result::Result<ThumbnailBytes, Error> {
    let image = staged
        .images
        .lock()
        .get(reference as usize)
        .cloned()
        .with_context(|| format!("reference {reference} is not staged"))?;
    Ok(ThumbnailBytes(image.thumbnail.clone()))
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn discard_staged_references(
    staged: State<'_, StagedReferences>,
) -> std::result::Result<(), Error> {
    staged.images.lock().clear();
    Ok(())
}

/// Attaches staged references to pages in one undoable step, then discards
/// the staged images.
#[tracing::instrument(
    target = "koharu_metrics",
    name = "references_attached",
    skip_all,
    fields(origin = "user", page_count = pairs.len()),
)]
#[tauri::command]
#[specta::specta]
pub(crate) async fn attach_references(
    pairs: Vec<ReferencePair>,
    language: String,
    staged: State<'_, StagedReferences>,
    desktop: State<'_, Desktop>,
    project: State<'_, CurrentProject>,
    processing: State<'_, Processing>,
    canvas_channel: State<'_, CanvasChannel>,
) -> std::result::Result<(), Error> {
    refuse_while_processing(&processing)?;
    let language = LanguageTag::new(language)?;
    let references = {
        let images = staged.images.lock();
        pairs
            .iter()
            .map(|pair| {
                let image = images
                    .get(pair.reference as usize)
                    .with_context(|| format!("reference {} is not staged", pair.reference))?;
                Ok((pair.page, image.asset()))
            })
            .collect::<Result<Vec<_>>>()?
    };
    attach(references, language, &desktop, &project, &canvas_channel).await?;
    staged.images.lock().clear();
    Ok(())
}

/// Asks for one image and attaches it as `page`'s reference in one undoable
/// step, in place of any it has, without staging. `false` means the dialog
/// was dismissed.
#[tracing::instrument(
    target = "koharu_metrics",
    name = "reference_attached",
    skip_all,
    fields(origin = "user")
)]
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn attach_reference_file(
    page: EntityId,
    language: String,
    trim_margins: bool,
    window: WebviewWindow<CefRuntime>,
    desktop: State<'_, Desktop>,
    project: State<'_, CurrentProject>,
    processing: State<'_, Processing>,
    canvas_channel: State<'_, CanvasChannel>,
) -> std::result::Result<bool, Error> {
    refuse_while_processing(&processing)?;
    let language = LanguageTag::new(language)?;
    let Some(path) = import::pick_image(&window).await else {
        return Ok(false);
    };
    let image =
        tokio_rayon::spawn(move || prepare(import::read_image(&path)?, trim_margins)).await?;
    attach(
        vec![(page, image.asset())],
        language,
        &desktop,
        &project,
        &canvas_channel,
    )
    .await?;
    Ok(true)
}

/// Attaches references to pages in one undoable step and shows the result.
async fn attach(
    references: Vec<(EntityId, AssetInput)>,
    language: LanguageTag,
    desktop: &Desktop,
    project: &CurrentProject,
    canvas_channel: &CanvasChannel,
) -> Result<()> {
    let (commit, page) = {
        let mut project = project.project.lock().await;
        let project = project.as_mut().context("no project is open")?;
        let commit = project.attach_references(references, language).await?;
        project.record_commit(&commit);
        (commit, project.active_page())
    };
    desktop.synchronize(&commit.snapshot, page, &commit).await?;
    canvas_channel.channel.publish(desktop.canvas_state());
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn detach_references(
    pages: Vec<EntityId>,
    desktop: State<'_, Desktop>,
    project: State<'_, CurrentProject>,
    processing: State<'_, Processing>,
    canvas_channel: State<'_, CanvasChannel>,
) -> std::result::Result<(), Error> {
    refuse_while_processing(&processing)?;
    let (commit, page) = {
        let mut project = project.project.lock().await;
        let project = project.as_mut().context("no project is open")?;
        let commit = project.detach_references(pages).await?;
        project.record_commit(&commit);
        (commit, project.active_page())
    };
    desktop.synchronize(&commit.snapshot, page, &commit).await?;
    canvas_channel.channel.publish(desktop.canvas_state());
    Ok(())
}

/// Places the references of `pages` in one undoable step, for example the
/// alignment of one page applied to the pages after it.
#[tauri::command]
#[specta::specta]
pub(crate) async fn set_reference_placement(
    pages: Vec<EntityId>,
    placement: ReferencePlacement,
    desktop: State<'_, Desktop>,
    project: State<'_, CurrentProject>,
    canvas_channel: State<'_, CanvasChannel>,
) -> std::result::Result<(), Error> {
    let (commit, page) = {
        let mut project = project.project.lock().await;
        let project = project.as_mut().context("no project is open")?;
        let commit = project.place_references(pages, placement).await?;
        project.record_commit(&commit);
        (commit, project.active_page())
    };
    desktop.synchronize(&commit.snapshot, page, &commit).await?;
    canvas_channel.channel.publish(desktop.canvas_state());
    Ok(())
}

/// Reads the text of the references of `pages` into their text elements,
/// as a job. Pages whose own text has not been detected and read yet go
/// through Detection and OCR first.
#[tracing::instrument(
    target = "koharu_metrics",
    name = "references_read",
    skip_all,
    fields(origin = "user", page_count = pages.len()),
)]
#[tauri::command]
#[specta::specta]
pub(crate) async fn read_references(
    pages: Vec<EntityId>,
    handle: AppHandle<CefRuntime>,
    project: State<'_, CurrentProject>,
) -> std::result::Result<JobId, Error> {
    {
        let project = project.project.lock().await;
        let snapshot = project.as_ref().context("no project is open")?.snapshot();
        for page in &pages {
            snapshot
                .component::<PageReference>(*page)?
                .with_context(|| format!("page {page} has no reference"))?;
        }
    }
    Ok(start_job(&handle, JobKind::References, move |job| {
        extract::read_references(job, pages)
    })?)
}

/// Reads the text in one area of a page's reference, in page pixels, into
/// a text element of that page, for text the automatic pairing missed.
#[tracing::instrument(
    target = "koharu_metrics",
    name = "reference_area_read",
    skip_all,
    fields(origin = "user")
)]
#[tauri::command]
#[specta::specta]
pub(crate) async fn read_reference_area(
    layer: EntityId,
    area: koharu_pipeline::Bounds,
    handle: AppHandle<CefRuntime>,
    processing: State<'_, Processing>,
) -> std::result::Result<(), Error> {
    refuse_while_processing(&processing)?;
    extract::read_area(&handle, layer, area).await?;
    Ok(())
}

/// Pipeline stages read page assets, so changing them mid-run would make the
/// run fail to commit.
fn refuse_while_processing(processing: &Processing) -> Result<()> {
    if processing.stops.lock().is_empty() {
        Ok(())
    } else {
        anyhow::bail!("references cannot be changed or read while processing is running")
    }
}

fn prepare(page: import::Page, trim_margins: bool) -> Result<StagedReference> {
    let image = image::load_from_memory_with_format(&page.bytes, page.format)
        .with_context(|| format!("failed to decode reference image {}", page.name))?;
    let mut pixels = opaque(image);
    let mut changed = false;
    if trim_margins && let Some([x, y, width, height]) = content_bounds(&pixels) {
        pixels = image::imageops::crop_imm(&pixels, x, y, width, height).to_image();
        changed = true;
    }
    let longest = pixels.width().max(pixels.height());
    if longest > MAX_EDGE {
        let scale = f64::from(MAX_EDGE) / f64::from(longest);
        let width = (f64::from(pixels.width()) * scale).round().max(1.0) as u32;
        let height = (f64::from(pixels.height()) * scale).round().max(1.0) as u32;
        pixels = image::imageops::resize(&pixels, width, height, FilterType::CatmullRom);
        changed = true;
    }
    // Untouched JPEG and WebP files are kept as they are; everything else is
    // stored as JPEG, which keeps rendered PDF pages small.
    let (bytes, media_type) =
        if !changed && matches!(page.format, ImageFormat::Jpeg | ImageFormat::WebP) {
            (page.bytes, page.format.to_mime_type())
        } else {
            let mut encoded = Cursor::new(Vec::new());
            JpegEncoder::new_with_quality(&mut encoded, JPEG_QUALITY).write_image(
                pixels.as_raw(),
                pixels.width(),
                pixels.height(),
                ExtendedColorType::Rgb8,
            )?;
            (Arc::from(encoded.into_inner()), "image/jpeg")
        };
    let scale =
        (f64::from(THUMBNAIL_EDGE) / f64::from(pixels.width().max(pixels.height()))).min(1.0);
    let thumbnail = image::imageops::thumbnail(
        &pixels,
        ((f64::from(pixels.width()) * scale).round() as u32).max(1),
        ((f64::from(pixels.height()) * scale).round() as u32).max(1),
    );
    Ok(StagedReference {
        name: page.name,
        bytes,
        media_type,
        width: pixels.width(),
        height: pixels.height(),
        thumbnail: webp::Encoder::from_rgb(
            thumbnail.as_raw(),
            thumbnail.width(),
            thumbnail.height(),
        )
        .encode(80.0)
        .to_vec(),
    })
}

/// Drops transparency by painting the image over white, the color of paper.
fn opaque(image: DynamicImage) -> RgbImage {
    if !image.color().has_alpha() {
        return image.into_rgb8();
    }
    let rgba = image.into_rgba8();
    RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
        let [red, green, blue, alpha] = rgba.get_pixel(x, y).0;
        let over_white = |channel: u8| {
            let alpha = u16::from(alpha);
            ((u16::from(channel) * alpha + 255 * (255 - alpha)) / 255) as u8
        };
        Rgb([over_white(red), over_white(green), over_white(blue)])
    })
}

/// The `[x, y, width, height]` of the image inside its plain margins, or
/// `None` when it has no margin to trim or would lose most of itself.
fn content_bounds(image: &RgbImage) -> Option<[u32; 4]> {
    let (width, height) = image.dimensions();
    if width < 3 || height < 3 {
        return None;
    }
    let border = border_color(image)?;
    let plain = |pixels: &mut dyn Iterator<Item = &Rgb<u8>>, count: u32| {
        // A few stray pixels, such as dust on a scan, still leave a line plain.
        let allowed = count / 200;
        pixels
            .filter(|pixel| {
                pixel
                    .0
                    .iter()
                    .zip(border.0)
                    .any(|(channel, border)| channel.abs_diff(border) > MARGIN_TOLERANCE)
            })
            .nth(allowed as usize)
            .is_none()
    };
    let row = |y: u32| plain(&mut (0..width).map(|x| image.get_pixel(x, y)), width);
    let mut top = 0;
    while top < height && row(top) {
        top += 1;
    }
    let mut bottom = height;
    while bottom > top && row(bottom - 1) {
        bottom -= 1;
    }
    let column = |x: u32| {
        plain(
            &mut (top..bottom).map(|y| image.get_pixel(x, y)),
            bottom - top,
        )
    };
    let mut left = 0;
    while left < width && column(left) {
        left += 1;
    }
    let mut right = width;
    while right > left && column(right - 1) {
        right -= 1;
    }
    let trimmed = [left, top, right - left, bottom - top];
    let keeps_most = trimmed[2] * 10 >= width && trimmed[3] * 10 >= height;
    (keeps_most && trimmed != [0, 0, width, height]).then_some(trimmed)
}

/// The color of the image's outermost pixels when they are all about the same.
fn border_color(image: &RgbImage) -> Option<Rgb<u8>> {
    let (width, height) = image.dimensions();
    let border = (0..width)
        .flat_map(|x| [(x, 0), (x, height - 1)])
        .chain((1..height - 1).flat_map(|y| [(0, y), (width - 1, y)]))
        .map(|(x, y)| image.get_pixel(x, y).0)
        .collect::<Vec<_>>();
    let median = |channel: usize| {
        let mut values = border
            .iter()
            .map(|pixel| pixel[channel])
            .collect::<Vec<_>>();
        values.sort_unstable();
        values[values.len() / 2]
    };
    let color = Rgb([median(0), median(1), median(2)]);
    let outliers = border
        .iter()
        .filter(|pixel| {
            pixel
                .iter()
                .zip(color.0)
                .any(|(channel, color)| channel.abs_diff(color) > MARGIN_TOLERANCE)
        })
        .count();
    (outliers * 50 <= border.len()).then_some(color)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn framed(width: u32, height: u32, frame: [u32; 4]) -> RgbImage {
        let [left, top, right, bottom] = frame;
        RgbImage::from_fn(width, height, |x, y| {
            if x >= left && x < width - right && y >= top && y < height - bottom {
                Rgb([20, 20, 20])
            } else {
                Rgb([250, 250, 248])
            }
        })
    }

    #[test]
    fn plain_margins_are_trimmed_even_with_specks() {
        let mut image = framed(400, 600, [10, 30, 20, 40]);
        image.put_pixel(2, 300, Rgb([0, 0, 0]));
        assert_eq!(content_bounds(&image), Some([10, 30, 370, 530]));
    }

    #[test]
    fn images_without_margins_or_with_little_content_stay_whole() {
        assert_eq!(content_bounds(&framed(400, 600, [0, 0, 0, 0])), None);
        assert_eq!(
            content_bounds(&framed(400, 600, [190, 290, 190, 290])),
            None
        );
        let blank = RgbImage::from_pixel(400, 600, Rgb([255, 255, 255]));
        assert_eq!(content_bounds(&blank), None);
    }

    #[test]
    fn staged_references_are_trimmed_and_stored_as_jpeg() {
        let mut png = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(framed(400, 600, [10, 30, 20, 40]))
            .write_to(&mut png, ImageFormat::Png)
            .unwrap();
        let page = import::Page {
            name: "credits.png".to_owned(),
            bytes: Arc::from(png.into_inner()),
            format: ImageFormat::Png,
            width: 400,
            height: 600,
        };
        let staged = prepare(page, true).unwrap();
        assert_eq!((staged.width, staged.height), (370, 530));
        assert_eq!(staged.media_type, "image/jpeg");
        assert_eq!(
            image::guess_format(&staged.bytes).unwrap(),
            ImageFormat::Jpeg
        );
        assert!(!staged.thumbnail.is_empty());
    }
}
