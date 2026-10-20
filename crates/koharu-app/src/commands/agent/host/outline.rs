//! Compact, agent-facing projections of one page. They keep what a translator
//! needs (text, boxes, core typography) and leave out artwork details and
//! fonts, which `inspect_project` already covers.

use std::collections::HashMap;

use anyhow::{Context as _, Result, bail};
use koharu_pipeline::Bounds;
use koharu_scene::{EntityId, PageStatus, RasterLayerKind, Snapshot, TextAlignment, WritingMode};
use serde::Serialize;

use crate::commands::{
    canvas::Point,
    project::{Geometry, Layer, Project, Typography},
};

#[derive(Debug, Serialize)]
pub(super) struct PageOutline {
    id: EntityId,
    label: String,
    width: f64,
    height: f64,
    status: PageStatus,
    elements: Vec<ElementOutline>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    raster_layers: Vec<RasterOutline>,
}

#[derive(Debug, Serialize)]
struct ElementOutline {
    id: EntityId,
    /// Where the element's text is laid out, as `[x, y, width, height]`.
    #[serde(rename = "box", skip_serializing_if = "Option::is_none")]
    frame: Option<[i64; 4]>,
    /// Where the original text was detected, when it differs from `box`.
    #[serde(skip_serializing_if = "Option::is_none")]
    source_box: Option<[i64; 4]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<TextOutline>,
    #[serde(skip_serializing_if = "Option::is_none")]
    translation: Option<TextOutline>,
    /// What the page's reference (a published translation) letters here.
    #[serde(skip_serializing_if = "Option::is_none")]
    reference: Option<TextOutline>,
    #[serde(skip_serializing_if = "Option::is_none")]
    typography: Option<TypographyOutline>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    hidden: bool,
}

#[derive(Debug, Serialize)]
struct TextOutline {
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    language: Option<String>,
}

#[derive(Debug, Serialize)]
struct TypographyOutline {
    #[serde(skip_serializing_if = "Option::is_none")]
    font: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<f32>,
    #[serde(skip_serializing_if = "is_true")]
    auto_fit: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    color: Option<[u8; 4]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stroke_color: Option<[u8; 4]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stroke_width: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    alignment: Option<TextAlignment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    writing_mode: Option<WritingMode>,
}

#[derive(Debug, Serialize)]
struct RasterOutline {
    id: EntityId,
    kind: RasterLayerKind,
    name: String,
}

pub(super) fn page_outline(snapshot: &Snapshot, page: EntityId) -> Result<PageOutline> {
    let view = Project::page(snapshot, page)?;
    let regions = view
        .regions
        .iter()
        .map(|region| (region.id, &region.geometry))
        .collect::<HashMap<_, _>>();
    let mut elements = Vec::new();
    let mut raster_layers = Vec::new();
    for layer in view.layers {
        match layer {
            Layer::Text {
                id,
                geometry,
                visibility,
                content,
                typography,
                automatic_region,
                ..
            } => {
                let frame = geometry
                    .as_ref()
                    .or_else(|| automatic_region.and_then(|region| regions.get(&region).copied()))
                    .and_then(extent);
                let source_box = content
                    .source_region
                    .and_then(|region| regions.get(&region).copied())
                    .and_then(extent)
                    .filter(|source| frame.as_ref() != Some(source));
                elements.push(ElementOutline {
                    id,
                    frame: frame.map(rounded),
                    source_box: source_box.map(rounded),
                    source: content.source.map(|source| TextOutline {
                        text: source.text,
                        language: source.language,
                    }),
                    translation: content.translation.map(|translation| TextOutline {
                        text: translation.text,
                        language: translation.language,
                    }),
                    reference: content.reference.map(|reference| TextOutline {
                        text: reference.text,
                        language: Some(reference.language),
                    }),
                    typography: typography.and_then(typography_outline),
                    hidden: !visibility.visible,
                });
            }
            Layer::Raster { id, kind, name, .. } => {
                raster_layers.push(RasterOutline { id, kind, name });
            }
            Layer::Group { .. } | Layer::Image { .. } | Layer::Artwork { .. } => {}
        }
    }
    Ok(PageOutline {
        status: snapshot
            .component::<PageStatus>(view.id)?
            .unwrap_or_default(),
        id: view.id,
        label: view.label,
        width: view.size.width,
        height: view.size.height,
        elements,
        raster_layers,
    })
}

/// The page-space box an area tool uses for a text element: the area where its
/// original text was detected, otherwise the box its text is laid out in.
pub(super) fn element_area(
    snapshot: &Snapshot,
    page: EntityId,
    element: EntityId,
) -> Result<Bounds> {
    if Project::containing_page(snapshot, element)? != page {
        bail!("element {element} is not on page {page}");
    }
    let view = Project::page(snapshot, page)?;
    let Some(Layer::Text {
        geometry,
        content,
        automatic_region,
        ..
    }) = view
        .layers
        .into_iter()
        .find(|layer| layer_id(layer) == element)
    else {
        bail!("element {element} is not a text element");
    };
    let region = |id: Option<EntityId>| {
        id.and_then(|id| view.regions.iter().find(|region| region.id == id))
            .map(|region| region.geometry.clone())
    };
    let [x, y, width, height] = region(content.source_region)
        .or(geometry)
        .or_else(|| region(automatic_region))
        .as_ref()
        .and_then(extent)
        .with_context(|| format!("element {element} has no area on the page"))?;
    Ok(Bounds {
        x,
        y,
        width,
        height,
    })
}

fn layer_id(layer: &Layer) -> EntityId {
    match layer {
        Layer::Group { id, .. }
        | Layer::Text { id, .. }
        | Layer::Raster { id, .. }
        | Layer::Image { id, .. }
        | Layer::Artwork { id, .. } => *id,
    }
}

fn typography_outline(typography: Typography) -> Option<TypographyOutline> {
    let outline = TypographyOutline {
        font: typography.preferred_font,
        size: typography.size,
        auto_fit: typography.auto_fit,
        color: typography.color,
        stroke_color: typography.stroke_color,
        stroke_width: typography.stroke_width,
        alignment: typography.alignment,
        writing_mode: typography.writing_mode,
    };
    let default = outline.font.is_none()
        && outline.size.is_none()
        && outline.auto_fit
        && outline.color.is_none()
        && outline.stroke_color.is_none()
        && outline.stroke_width.is_none()
        && outline.alignment.is_none()
        && outline.writing_mode.is_none();
    (!default).then_some(outline)
}

/// Axis-aligned `[x, y, width, height]` of a polygon in page pixels.
fn extent(geometry: &Geometry) -> Option<[f64; 4]> {
    let (first, rest) = geometry.points.split_first()?;
    let (min, max) = rest.iter().fold((*first, *first), |(min, max), point| {
        (
            Point {
                x: min.x.min(point.x),
                y: min.y.min(point.y),
            },
            Point {
                x: max.x.max(point.x),
                y: max.y.max(point.y),
            },
        )
    });
    Some([min.x, min.y, max.x - min.x, max.y - min.y])
}

fn rounded([x, y, width, height]: [f64; 4]) -> [i64; 4] {
    [x, y, width, height].map(|value| value.round() as i64)
}

fn is_true(value: &bool) -> bool {
    *value
}

#[cfg(test)]
mod tests {
    use koharu_scene::{
        At, Authored, Geometry as SceneGeometry, LanguageTag, Origin, PageDraft, RasterLayer,
        RecognizedFrom, ReferenceText, Session, SourceText, TextLayout, TextLayoutKind, TextRegion,
        Translation,
    };

    use super::*;

    #[tokio::test]
    async fn a_page_of_ten_balloons_stays_compact() {
        let mut session = Session::memory().await.unwrap();
        let mut ids = None;
        let patch = session
            .snapshot()
            .patch(|edit| {
                let page = edit.add_page(PageDraft::new("001.png", 1200.0, 1800.0), At::End)?;
                let mut elements = Vec::new();
                for index in 0..10 {
                    let top = 40.0 + f64::from(index) * 170.0;
                    let region = edit.add_analysis_region::<TextRegion>(
                        page,
                        At::End,
                        &SceneGeometry::rectangle(110.0, top + 10.0, 180.0, 120.0),
                        None,
                    )?;
                    let content = edit.add_text_content(page, At::End)?;
                    edit.set(
                        content,
                        &SourceText {
                            text: Authored::user("そんなことより神様はどこにいるんだ".to_owned()),
                            language: Some(LanguageTag::new("ja")?),
                        },
                    )?;
                    edit.set(
                        content,
                        &Translation {
                            text: Authored::user(
                                "Lebih penting dari itu, di mana sebenarnya Sang Tuhan berada?"
                                    .to_owned(),
                            ),
                            language: Some(LanguageTag::new("id-ID")?),
                        },
                    )?;
                    if index == 0 {
                        edit.set(
                            content,
                            &ReferenceText {
                                text: Authored::user("NEVER MIND THAT, WHERE IS GOD?".to_owned()),
                                language: LanguageTag::new("en-US")?,
                            },
                        )?;
                    }
                    edit.relate::<RecognizedFrom>(content, region)?;
                    let layer = edit.add_text_layer(
                        page,
                        At::End,
                        content,
                        &TextLayout {
                            origin: Origin::User,
                            kind: TextLayoutKind::Paragraph,
                            angle_degrees: None,
                        },
                    )?;
                    edit.set(layer, &SceneGeometry::rectangle(100.0, top, 200.0, 140.0))?;
                    elements.push(layer);
                }
                let cleanup = edit.add_entity(page, At::Start)?;
                edit.set(
                    cleanup,
                    &RasterLayer {
                        origin: Origin::User,
                        name: "Cleanup".to_owned(),
                        kind: RasterLayerKind::Cleanup,
                    },
                )?;
                ids = Some((page, elements, cleanup));
                Ok(())
            })
            .unwrap();
        let snapshot = session.commit(patch).await.unwrap().snapshot;
        let (page, elements, cleanup) = ids.unwrap();

        let outline = page_outline(&snapshot, page).unwrap();
        let json = serde_json::to_string(&outline).unwrap();

        assert!(json.len() < 5_000, "{} characters: {json}", json.len());
        assert_eq!(outline.elements.len(), 10);
        let first = &outline.elements[0];
        assert_eq!(first.id, elements[0]);
        assert_eq!(first.frame, Some([100, 40, 200, 140]));
        assert_eq!(first.source_box, Some([110, 50, 180, 120]));
        assert_eq!(
            first.translation.as_ref().unwrap().language.as_deref(),
            Some("id-ID")
        );
        let reference = first.reference.as_ref().unwrap();
        assert_eq!(reference.text, "NEVER MIND THAT, WHERE IS GOD?");
        assert_eq!(reference.language.as_deref(), Some("en-US"));
        assert!(outline.elements[1].reference.is_none());
        assert_eq!(outline.raster_layers[0].id, cleanup);

        let area = element_area(&snapshot, page, elements[0]).unwrap();
        assert_eq!(
            [area.x, area.y, area.width, area.height],
            [110.0, 50.0, 180.0, 120.0]
        );
        assert!(element_area(&snapshot, page, cleanup).is_err());
    }
}
