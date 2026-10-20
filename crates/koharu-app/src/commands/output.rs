use anyhow::{Context as _, Result};
use futures::future::try_join_all;
use image::{
    ExtendedColorType, ImageEncoder as _, RgbaImage,
    codecs::png::{CompressionType, FilterType, PngEncoder},
};
use koharu_pipeline::Bounds;
use koharu_psd::{PsdExportOptions, export_page};
use koharu_rasterizer::{Raster, RasterOptions, Rasterizer};
use koharu_renderer::{Frame, Renderer};
use koharu_scene::{AssetRole, EntityId, Snapshot};
use rayon::prelude::*;
use serde::Deserialize;
use specta::Type;
use std::{
    io::{Cursor, Write as _},
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::{State, WebviewWindow, ipc::IpcResponse};
use tauri_runtime_cef::CefRuntime;

use super::{Error, project::CurrentProject};
use koharu_desktop::Desktop;

pub(super) const THUMBNAIL_EDGE: u32 = 128;

#[derive(Type)]
#[specta(transparent)]
pub(crate) struct ThumbnailBytes(#[specta(type = Vec<u8>)] pub(super) Vec<u8>);

impl IpcResponse for ThumbnailBytes {
    fn body(self) -> tauri::Result<tauri::ipc::InvokeResponseBody> {
        Ok(self.0.into())
    }
}

#[derive(Type)]
#[specta(transparent)]
pub(crate) struct ImageBytes(#[specta(type = Vec<u8>)] Vec<u8>);

impl IpcResponse for ImageBytes {
    fn body(self) -> tauri::Result<tauri::ipc::InvokeResponseBody> {
        Ok(self.0.into())
    }
}

/// An image that a page keeps besides its layers.
#[derive(Clone, Copy, Debug, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PageImage {
    /// The original artwork the page was imported from.
    Source,
}

/// Image types the webview decodes; other stored types are converted to PNG.
const WEB_IMAGE_TYPES: [&str; 5] = [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "image/bmp",
];

#[derive(Clone, Copy, Debug, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ExportFormat {
    Png,
    Psd,
    Cbz,
}

#[tracing::instrument(
    target = "koharu_metrics",
    name = "export",
    skip_all,
    fields(origin = "user", format = ?format),
)]
#[tauri::command]
#[specta::specta]
pub(crate) async fn export(
    window: WebviewWindow<CefRuntime>,
    format: ExportFormat,
    project: State<'_, CurrentProject>,
    desktop: State<'_, Desktop>,
) -> std::result::Result<(), Error> {
    let (name, snapshot) = {
        let project = project.project.lock().await;
        let project = project.as_ref().context("no project is open")?;
        (project.name.clone(), project.snapshot())
    };
    let pages = snapshot.pages().map(|page| page.id()).collect::<Vec<_>>();
    if pages.is_empty() {
        return Err(anyhow::anyhow!("there are no pages to export").into());
    }
    let dialog = rfd::AsyncFileDialog::new().set_parent(&window);
    let destination = match format {
        ExportFormat::Png | ExportFormat::Psd => dialog.pick_folder().await,
        ExportFormat::Cbz => {
            dialog
                .add_filter("Comic Book Archive", &["cbz"])
                .set_file_name(format!("{name}.cbz"))
                .save_file()
                .await
        }
    };
    let Some(destination) = destination.map(|destination| destination.path().to_owned()) else {
        return Ok(());
    };
    let files = render_export(&desktop, &snapshot, &pages, format).await?;
    tokio_rayon::spawn(move || write_export(files, format, &destination, Overwrite::Allow)).await?;
    Ok(())
}

pub(crate) struct ExportedFolder {
    pub(crate) path: PathBuf,
    pub(crate) files: usize,
}

/// Exports pages into a new `<project>_<YYYY-MM-DD_HHMM>` folder under `root`,
/// adding a numeric suffix when that folder exists. Nothing is ever replaced.
pub(crate) async fn export_to_new_folder(
    desktop: &Desktop,
    snapshot: &Snapshot,
    project: &str,
    pages: &[EntityId],
    format: ExportFormat,
    root: &Path,
) -> Result<ExportedFolder> {
    if pages.is_empty() {
        anyhow::bail!("there are no pages to export");
    }
    let files = render_export(desktop, snapshot, pages, format).await?;
    let stamp = chrono::Local::now().format("%Y-%m-%d_%H%M").to_string();
    let root = root.to_owned();
    let project = project.to_owned();
    tokio_rayon::spawn(move || {
        let folder = create_new_folder(&root, &format!("{project}_{stamp}"))?;
        let (path, files) = match format {
            ExportFormat::Png | ExportFormat::Psd => {
                let count = write_export(files, format, &folder, Overwrite::Never)?;
                (folder, count)
            }
            ExportFormat::Cbz => {
                let archive = folder.join(format!("{project}.cbz"));
                write_export(files, format, &archive, Overwrite::Never)?;
                (archive, 1)
            }
        };
        Ok(ExportedFolder { path, files })
    })
    .await
}

/// One rendered page, named `{project position}_{label}.{extension}`.
struct ExportFile {
    name: String,
    bytes: Vec<u8>,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Overwrite {
    Allow,
    Never,
}

async fn render_export(
    desktop: &Desktop,
    snapshot: &Snapshot,
    pages: &[EntityId],
    format: ExportFormat,
) -> Result<Vec<ExportFile>> {
    let renderer = desktop.renderer();
    let rasterizer = desktop.rasterizer().await?;
    let frames = try_join_all(pages.iter().map(|&page| renderer.render(snapshot, page))).await?;
    let (extension, images) = match format {
        ExportFormat::Png | ExportFormat::Cbz => {
            let images = tokio_rayon::spawn(move || {
                frames
                    .par_iter()
                    .map(|frame| -> Result<_> {
                        let image = rasterizer
                            .rasterize(&frame.raster_frame()?, RasterOptions::default())?
                            .image;
                        let mut bytes = Vec::new();
                        PngEncoder::new_with_quality(
                            &mut bytes,
                            CompressionType::Best,
                            FilterType::Adaptive,
                        )
                        .write_image(
                            image.as_raw(),
                            image.width(),
                            image.height(),
                            ExtendedColorType::Rgba8,
                        )?;
                        Ok(bytes)
                    })
                    .collect::<Result<Vec<_>>>()
            })
            .await?;
            ("png", images)
        }
        ExportFormat::Psd => {
            let options = PsdExportOptions::default();
            let images = try_join_all(
                frames
                    .iter()
                    .map(|frame| export_page(Arc::clone(&rasterizer), snapshot, frame, &options)),
            )
            .await?;
            ("psd", images)
        }
    };
    let order = snapshot.pages().map(|page| page.id()).collect::<Vec<_>>();
    let width = order.len().to_string().len().max(4);
    // Async preparation and indexed encoding both preserve the requested order.
    pages
        .iter()
        .zip(images)
        .map(|(&page, bytes)| {
            let position = order
                .iter()
                .position(|candidate| *candidate == page)
                .with_context(|| format!("{page} is not a page of this project"))?;
            let label = snapshot.page(page)?.page()?.label;
            Ok(ExportFile {
                name: file_name(&label, position + 1, width, extension),
                bytes,
            })
        })
        .collect()
}

fn file_name(label: &str, number: usize, width: usize, extension: &str) -> String {
    let name = label
        .trim()
        .trim_end_matches(|character: char| character == '.' || character.is_whitespace());
    let name = name
        .rsplit_once('.')
        .map_or(name, |(stem, _)| stem)
        .replace(['<', '>', ':', '"', '/', '\\', '|', '?', '*'], "_");
    format!(
        "{number:0width$}_{}.{extension}",
        if name.is_empty() { "page" } else { &name }
    )
}

/// Writes rendered pages into the `destination` folder, or into the archive at
/// `destination` for CBZ, and returns the number of pages written.
fn write_export(
    files: Vec<ExportFile>,
    format: ExportFormat,
    destination: &Path,
    overwrite: Overwrite,
) -> Result<usize> {
    let count = files.len();
    let mut archive = if matches!(format, ExportFormat::Cbz) {
        let directory = destination.parent().context("archive path has no parent")?;
        Some(zip::ZipWriter::new(tempfile::NamedTempFile::new_in(
            directory,
        )?))
    } else {
        None
    };
    for file in files {
        if let Some(archive) = &mut archive {
            // PNG data is already compressed.
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            archive.start_file(file.name, options)?;
            archive.write_all(&file.bytes)?;
        } else {
            let path = destination.join(&file.name);
            match overwrite {
                Overwrite::Allow => std::fs::write(&path, &file.bytes)?,
                Overwrite::Never => std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&path)
                    .and_then(|mut target| target.write_all(&file.bytes))
                    .with_context(|| format!("failed to write {}", path.display()))?,
            }
        }
        tracing::info!(
            target: "koharu_metrics",
            metric = "page_exported",
            format = ?format,
        );
    }
    if let Some(archive) = archive {
        let archive = archive.finish()?;
        match overwrite {
            Overwrite::Allow => {
                archive.persist(destination)?;
            }
            Overwrite::Never => {
                archive.persist_noclobber(destination)?;
            }
        }
    }
    Ok(count)
}

fn create_new_folder(root: &Path, name: &str) -> Result<PathBuf> {
    std::fs::create_dir_all(root)
        .with_context(|| format!("failed to create {}", root.display()))?;
    for attempt in 1_usize.. {
        let folder = if attempt == 1 {
            root.join(name)
        } else {
            root.join(format!("{name}_{attempt}"))
        };
        match std::fs::create_dir(&folder) {
            Ok(()) => return Ok(folder),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("failed to create {}", folder.display()));
            }
        }
    }
    unreachable!("folder suffixes are unbounded")
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn get_thumbnail(
    page: EntityId,
    project: State<'_, CurrentProject>,
) -> std::result::Result<ThumbnailBytes, Error> {
    let snapshot = project
        .project
        .lock()
        .await
        .as_ref()
        .context("no project is open")?
        .snapshot();
    snapshot.page(page)?;
    let blob = snapshot
        .asset(page, &AssetRole::new("source")?)?
        .with_context(|| format!("page {page} has no source image"))?
        .blob;
    let bytes = snapshot.read_blob(blob).await?;
    let bytes = tokio_rayon::spawn(move || -> Result<Vec<u8>> {
        let image = image::load_from_memory(&bytes).context("failed to decode source image")?;
        if image.width() == 0 || image.height() == 0 {
            return Err(anyhow::anyhow!("source image is empty"));
        }
        let image = image.thumbnail(THUMBNAIL_EDGE, THUMBNAIL_EDGE).to_rgba8();
        let encoder = webp::Encoder::from_rgba(image.as_raw(), image.width(), image.height());
        Ok(encoder.encode(80.0).to_vec())
    })
    .await?;
    Ok(ThumbnailBytes(bytes))
}

/// One of a page's images at full resolution, for showing it beside the
/// editable canvas.
#[tauri::command]
#[specta::specta]
pub(crate) async fn get_page_image(
    page: EntityId,
    image: PageImage,
    project: State<'_, CurrentProject>,
) -> std::result::Result<ImageBytes, Error> {
    let snapshot = project
        .project
        .lock()
        .await
        .as_ref()
        .context("no project is open")?
        .snapshot();
    snapshot.page(page)?;
    let role = match image {
        PageImage::Source => "source",
    };
    let asset = snapshot
        .asset(page, &AssetRole::new(role)?)?
        .with_context(|| format!("page {page} has no {role} image"))?;
    let bytes = snapshot.read_blob(asset.blob).await?;
    if WEB_IMAGE_TYPES.contains(&asset.media_type.as_str()) {
        return Ok(ImageBytes(bytes.to_vec()));
    }
    let png = tokio_rayon::spawn(move || -> Result<Vec<u8>> {
        let image = image::load_from_memory(&bytes).context("failed to decode the page image")?;
        let mut png = Cursor::new(Vec::new());
        image.write_to(&mut png, image::ImageFormat::Png)?;
        Ok(png.into_inner())
    })
    .await?;
    Ok(ImageBytes(png))
}

/// A rendered page, or part of one, prepared for a vision model.
pub(crate) struct Preview {
    pub(crate) webp: Vec<u8>,
    /// Page-space `[x, y, width, height]` shown by the image.
    pub(crate) area: [u32; 4],
    /// Image pixels per page pixel.
    pub(crate) scale: f64,
}

/// Longest edge of a whole-page preview.
const PAGE_PREVIEW_EDGE: u32 = 1024;
/// Longest edge of a region preview; smaller regions keep full resolution.
const REGION_PREVIEW_EDGE: u32 = 1536;

pub(crate) async fn rendered_preview(
    renderer: &Renderer,
    rasterizer: Arc<Rasterizer>,
    snapshot: &Snapshot,
    page: EntityId,
    region: Option<Bounds>,
) -> Result<Preview> {
    snapshot.page(page)?;
    let frame = renderer.render(snapshot, page).await?;
    let image = rasterize(rasterizer, &frame, RasterOptions::default())
        .await?
        .image;
    tokio_rayon::spawn(move || preview(&image, region)).await
}

fn preview(image: &RgbaImage, region: Option<Bounds>) -> Result<Preview> {
    let (area, limit) = match region {
        Some(region) => (crop_area(image.dimensions(), region)?, REGION_PREVIEW_EDGE),
        None => ([0, 0, image.width(), image.height()], PAGE_PREVIEW_EDGE),
    };
    let [x, y, width, height] = area;
    let mut view = image::imageops::crop_imm(image, x, y, width, height).to_image();
    if width.max(height) > limit {
        view = image::DynamicImage::ImageRgba8(view)
            .resize(limit, limit, image::imageops::FilterType::Lanczos3)
            .to_rgba8();
    }
    let encoder = webp::Encoder::from_rgba(view.as_raw(), view.width(), view.height());
    Ok(Preview {
        webp: encoder.encode(85.0).to_vec(),
        area,
        scale: f64::from(view.width()) / f64::from(width),
    })
}

/// Whole pixels of `region` that lie on an image of `size`.
fn crop_area((image_width, image_height): (u32, u32), region: Bounds) -> Result<[u32; 4]> {
    if ![region.x, region.y, region.width, region.height]
        .into_iter()
        .all(f64::is_finite)
        || region.width <= 0.0
        || region.height <= 0.0
    {
        anyhow::bail!("the region must be finite and non-empty");
    }
    let left = region.x.max(0.0).floor();
    let top = region.y.max(0.0).floor();
    let right = (region.x + region.width).min(f64::from(image_width)).ceil();
    let bottom = (region.y + region.height)
        .min(f64::from(image_height))
        .ceil();
    if right <= left || bottom <= top {
        anyhow::bail!("the region lies outside the page");
    }
    Ok([left, top, right - left, bottom - top].map(|value| value as u32))
}

async fn rasterize(
    rasterizer: Arc<Rasterizer>,
    frame: &Frame,
    options: RasterOptions,
) -> Result<Raster> {
    let frame = frame.raster_frame()?;
    tokio_rayon::spawn(move || rasterizer.rasterize(&frame, options))
        .await
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bounds(x: f64, y: f64, width: f64, height: f64) -> Bounds {
        Bounds {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn whole_pages_are_scaled_to_the_preview_edge() {
        let preview = preview(&RgbaImage::new(2048, 3072), None).unwrap();

        assert_eq!(preview.area, [0, 0, 2048, 3072]);
        assert!((preview.scale - 1024.0 / 3072.0).abs() < 1e-3);
    }

    #[test]
    fn regions_keep_full_resolution_and_map_back_to_the_page() {
        let image = RgbaImage::new(2048, 3072);

        let region = preview(&image, Some(bounds(100.4, 200.0, 499.2, 300.0))).unwrap();
        assert_eq!(region.area, [100, 200, 500, 300]);
        assert_eq!(region.scale, 1.0);

        let clamped = preview(&image, Some(bounds(-50.0, 3000.0, 200.0, 500.0))).unwrap();
        assert_eq!(clamped.area, [0, 3000, 150, 72]);

        let large = preview(&image, Some(bounds(0.0, 0.0, 2048.0, 1024.0))).unwrap();
        assert!((large.scale - 1536.0 / 2048.0).abs() < 1e-3);
    }

    fn files(names: &[&str]) -> Vec<ExportFile> {
        names
            .iter()
            .map(|name| ExportFile {
                name: (*name).to_owned(),
                bytes: name.as_bytes().to_vec(),
            })
            .collect()
    }

    #[test]
    fn export_names_number_pages_by_project_position() {
        assert_eq!(file_name("cover.jpg", 3, 4, "png"), "0003_cover.png");
        assert_eq!(file_name("a/b: c?.png ", 12, 4, "psd"), "0012_a_b_ c_.psd");
        assert_eq!(file_name(" . ", 1, 5, "png"), "00001_page.png");
    }

    #[test]
    fn agent_exports_go_to_new_folders_and_never_overwrite() {
        let root = tempfile::tempdir().unwrap();

        let first = create_new_folder(root.path(), "Project_2026-10-20_1200").unwrap();
        let second = create_new_folder(root.path(), "Project_2026-10-20_1200").unwrap();
        assert_eq!(first, root.path().join("Project_2026-10-20_1200"));
        assert_eq!(second, root.path().join("Project_2026-10-20_1200_2"));

        let written = write_export(
            files(&["0001_a.png", "0002_b.png"]),
            ExportFormat::Png,
            &first,
            Overwrite::Never,
        )
        .unwrap();
        assert_eq!(written, 2);
        assert!(
            write_export(
                files(&["0001_a.png"]),
                ExportFormat::Png,
                &first,
                Overwrite::Never
            )
            .is_err()
        );
        assert_eq!(
            std::fs::read(first.join("0001_a.png")).unwrap(),
            b"0001_a.png"
        );

        let archive = second.join("Project.cbz");
        write_export(
            files(&["0001_a.png"]),
            ExportFormat::Cbz,
            &archive,
            Overwrite::Never,
        )
        .unwrap();
        assert!(
            write_export(
                files(&["0002_b.png"]),
                ExportFormat::Cbz,
                &archive,
                Overwrite::Never
            )
            .is_err()
        );
        let mut zip = zip::ZipArchive::new(std::fs::File::open(&archive).unwrap()).unwrap();
        assert_eq!(zip.len(), 1);
        assert_eq!(zip.by_index(0).unwrap().name(), "0001_a.png");
    }

    #[test]
    fn regions_off_the_page_are_rejected() {
        assert!(crop_area((100, 100), bounds(150.0, 0.0, 10.0, 10.0)).is_err());
        assert!(crop_area((100, 100), bounds(0.0, 0.0, 0.0, 10.0)).is_err());
        assert!(crop_area((100, 100), bounds(f64::NAN, 0.0, 10.0, 10.0)).is_err());
    }
}
