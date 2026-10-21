use std::{
    fs,
    io::Cursor,
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{Context as _, Result, bail};
use image::{ImageFormat, ImageReader};
use rayon::prelude::*;
use serde::Deserialize;
use specta::Type;
use strum::{EnumIter, EnumMessage, EnumString, IntoEnumIterator as _};
use tauri::WebviewWindow;
use tauri_runtime_cef::CefRuntime;
use walkdir::WalkDir;

mod pdf;
mod rar;
mod zip;

#[derive(Clone, Copy, Debug, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PageImportSource {
    Files,
    Folder,
}

#[derive(Clone, Copy, EnumIter, EnumMessage, EnumString)]
#[strum(ascii_case_insensitive)]
pub(super) enum Format {
    #[strum(
        serialize = "png",
        serialize = "jpg",
        serialize = "jpeg",
        serialize = "webp"
    )]
    Raster,
    #[strum(serialize = "cbz", serialize = "zip")]
    Zip,
    #[strum(serialize = "rar")]
    Rar,
    #[strum(serialize = "pdf")]
    Pdf,
}

#[derive(Debug)]
pub(super) struct EncodedPage {
    pub(super) name: String,
    pub(super) bytes: Vec<u8>,
}

pub(super) struct Page {
    pub(super) name: String,
    pub(super) bytes: Arc<[u8]>,
    pub(super) format: ImageFormat,
    pub(super) width: u32,
    pub(super) height: u32,
}

fn decode(path: &Path, source: EncodedPage) -> Result<Page> {
    let EncodedPage { name, bytes } = source;
    let format = image::guess_format(&bytes).with_context(|| {
        format!(
            "failed to identify imported image {} ({name})",
            path.display()
        )
    })?;
    let (width, height) = ImageReader::with_format(Cursor::new(bytes.as_slice()), format)
        .into_dimensions()
        .with_context(|| {
            format!(
                "failed to read dimensions of imported image {} ({name})",
                path.display()
            )
        })?;
    Ok(Page {
        name,
        bytes: Arc::<[u8]>::from(bytes),
        format,
        width,
        height,
    })
}

/// Asks for one image file. `None` means the dialog was dismissed.
pub(super) async fn pick_image(window: &WebviewWindow<CefRuntime>) -> Option<PathBuf> {
    rfd::AsyncFileDialog::new()
        .add_filter("Images", Format::Raster.get_serializations())
        .set_parent(window)
        .pick_file()
        .await
        .map(|file| file.path().to_owned())
}

/// Reads one image file, named after the file.
pub(super) fn read_image(path: &Path) -> Result<Page> {
    decode(path, image_file(path)?)
}

fn image_file(path: &Path) -> Result<EncodedPage> {
    Ok(EncodedPage {
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "page".to_owned()),
        bytes: fs::read(path).with_context(|| format!("failed to read {}", path.display()))?,
    })
}

/// Asks for image, archive, and PDF files, or a folder of them. `None`
/// means the dialog was dismissed.
pub(super) async fn pick(
    source: PageImportSource,
    window: &WebviewWindow<CefRuntime>,
) -> Result<Option<Vec<PathBuf>>> {
    let extensions = Format::iter()
        .flat_map(|format| format.get_serializations())
        .collect::<Vec<_>>();
    let dialog = rfd::AsyncFileDialog::new()
        .add_filter("Images, archives, and PDF", &extensions)
        .set_parent(window);
    let files = match source {
        PageImportSource::Files => dialog.pick_files().await.map(|files| {
            files
                .into_iter()
                .map(|file| file.path().to_owned())
                .collect::<Vec<_>>()
        }),
        PageImportSource::Folder => dialog.pick_folder().await.map(|folder| {
            WalkDir::new(folder.path())
                .follow_links(false)
                .into_iter()
                .filter_map(|entry| match entry {
                    Ok(entry) if entry.file_type().is_file() => Some(entry.into_path()),
                    Ok(_) => None,
                    Err(error) => {
                        tracing::warn!(%error, "could not inspect an import directory entry");
                        None
                    }
                })
                .filter(|path| {
                    path.extension()
                        .and_then(|extension| extension.to_str())
                        .is_some_and(|extension| extension.parse::<Format>().is_ok())
                })
                .collect::<Vec<_>>()
        }),
    };
    match files {
        Some(files) if files.is_empty() => {
            bail!("no supported images were found in the selection")
        }
        files => Ok(files),
    }
}

/// Reads every page in `paths` in natural file name order and converts each
/// one as soon as it is read, so a PDF holds only one rendered page at a time
/// besides what `convert` keeps.
pub(super) fn import<T: Send>(
    mut paths: Vec<PathBuf>,
    convert: impl Fn(Page) -> Result<T> + Sync,
) -> Result<Vec<T>> {
    alphanumeric_sort::sort_slice_by_os_str_key(&mut paths, |path| {
        path.file_name().unwrap_or_else(|| path.as_os_str())
    });
    let groups = paths
        .into_par_iter()
        .map(|path| -> Result<Vec<T>> {
            let extension = path
                .extension()
                .and_then(|extension| extension.to_str())
                .and_then(|extension| extension.parse::<Format>().ok());
            let mut converted = Vec::new();
            let mut visit = |source| -> Result<()> {
                converted.push(convert(decode(&path, source)?)?);
                Ok(())
            };
            match extension {
                Some(Format::Raster) => visit(image_file(&path)?)?,
                Some(Format::Zip) => zip::extract(&path)?.into_iter().try_for_each(visit)?,
                Some(Format::Rar) => rar::extract(&path)?.into_iter().try_for_each(visit)?,
                Some(Format::Pdf) => pdf::render(&path, &mut visit)?,
                None => bail!("unsupported page import path {}", path.display()),
            }
            Ok(converted)
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(groups.into_iter().flatten().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn top_level_paths_are_naturally_sorted() {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "koharu-import-order-{}-{timestamp}",
            std::process::id()
        ));
        fs::create_dir(&directory).expect("create fixture directory");
        let image = image::RgbaImage::from_pixel(1, 1, image::Rgba([0, 0, 0, 255]));
        let mut encoded = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image)
            .write_to(&mut encoded, ImageFormat::Png)
            .expect("encode fixture");
        let paths = ["page10.PNG", "page2.png", "page1.png"].map(|name| directory.join(name));
        for path in &paths {
            fs::write(path, encoded.get_ref()).expect("write fixture");
        }

        let pages = import(paths.into(), Ok).expect("import fixtures");
        fs::remove_dir_all(&directory).expect("remove fixture directory");
        assert_eq!(
            pages
                .iter()
                .map(|page| page.name.as_str())
                .collect::<Vec<_>>(),
            ["page1.png", "page2.png", "page10.PNG"]
        );
    }
}
