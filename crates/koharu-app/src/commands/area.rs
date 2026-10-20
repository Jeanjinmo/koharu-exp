//! Page-space areas edited by brush strokes and area tools. An area becomes a
//! coverage mask the size of the page, which inpainting, paint, and erase use.

use anyhow::{Context as _, Result, bail};
use image::{GrayImage, ImageEncoder as _, codecs::png::PngEncoder};
use koharu_pipeline::Bounds;

use super::canvas::Point;

pub(crate) enum Area {
    /// Axis-aligned rectangles whose edges snap to the nearest whole pixel.
    Rects(Vec<Bounds>),
    /// A round brush of `diameter` pixels dragged through `points`.
    Stroke { points: Vec<Point>, diameter: f32 },
}

/// Per-pixel coverage of an area on one page.
pub(crate) struct Mask {
    pub(crate) coverage: GrayImage,
    /// Smallest rectangle containing every covered pixel.
    pub(crate) bounds: Bounds,
}

impl Area {
    pub(crate) fn mask(&self, width: u32, height: u32) -> Result<Mask> {
        if width == 0 || height == 0 {
            bail!("page dimensions must be positive");
        }
        let mut coverage = GrayImage::new(width, height);
        let mut covered = Covered::default();
        match self {
            Self::Rects(rects) => {
                if rects.is_empty() {
                    bail!("the area is empty");
                }
                for rect in rects {
                    fill_rect(&mut coverage, &mut covered, *rect)?;
                }
            }
            Self::Stroke { points, diameter } => {
                stroke(&mut coverage, &mut covered, points, *diameter)?;
            }
        }
        let [left, top, right, bottom] = covered
            .0
            .context("the area does not cover any part of the page")?;
        Ok(Mask {
            coverage,
            bounds: Bounds {
                x: f64::from(left),
                y: f64::from(top),
                width: f64::from(right - left + 1),
                height: f64::from(bottom - top + 1),
            },
        })
    }

    /// The mask encoded as an 8-bit grayscale PNG, as inpainting consumes it.
    pub(crate) fn mask_png(&self, width: u32, height: u32) -> Result<(Vec<u8>, Bounds)> {
        let mask = self.mask(width, height)?;
        let mut png = Vec::new();
        PngEncoder::new(&mut png).write_image(
            mask.coverage.as_raw(),
            width,
            height,
            image::ExtendedColorType::L8,
        )?;
        Ok((png, mask.bounds))
    }
}

/// Inclusive `[left, top, right, bottom]` of the covered pixels.
#[derive(Default)]
struct Covered(Option<[u32; 4]>);

impl Covered {
    fn include(&mut self, x: u32, y: u32) {
        self.0 = Some(match self.0 {
            Some([left, top, right, bottom]) => {
                [left.min(x), top.min(y), right.max(x), bottom.max(y)]
            }
            None => [x, y, x, y],
        });
    }
}

fn fill_rect(coverage: &mut GrayImage, covered: &mut Covered, rect: Bounds) -> Result<()> {
    if ![rect.x, rect.y, rect.width, rect.height]
        .into_iter()
        .all(f64::is_finite)
        || rect.width <= 0.0
        || rect.height <= 0.0
    {
        bail!("rectangles must be finite and non-empty");
    }
    let clamp = |value: f64, limit: u32| value.round().clamp(0.0, f64::from(limit)) as u32;
    let left = clamp(rect.x, coverage.width());
    let top = clamp(rect.y, coverage.height());
    let right = clamp(rect.x + rect.width, coverage.width());
    let bottom = clamp(rect.y + rect.height, coverage.height());
    for y in top..bottom {
        for x in left..right {
            coverage.get_pixel_mut(x, y).0[0] = u8::MAX;
            covered.include(x, y);
        }
    }
    Ok(())
}

fn stroke(
    coverage: &mut GrayImage,
    covered: &mut Covered,
    points: &[Point],
    diameter: f32,
) -> Result<()> {
    if !diameter.is_finite() || diameter <= 0.0 || points.is_empty() {
        bail!("a stroke requires a positive diameter and at least one point");
    }
    if points
        .iter()
        .any(|point| !point.x.is_finite() || !point.y.is_finite())
    {
        bail!("stroke points must be finite");
    }
    let (width, height) = coverage.dimensions();
    let radius = f64::from(diameter) * 0.5;
    for (start, end) in points
        .iter()
        .zip(points.iter().skip(1))
        .chain(points.last().map(|point| (point, point)))
    {
        let left = (start.x.min(end.x) - radius - 0.5).floor().max(0.0) as u32;
        let top = (start.y.min(end.y) - radius - 0.5).floor().max(0.0) as u32;
        let right = (start.x.max(end.x) + radius + 0.5)
            .ceil()
            .min(f64::from(width)) as u32;
        let bottom = (start.y.max(end.y) + radius + 0.5)
            .ceil()
            .min(f64::from(height)) as u32;
        let dx = end.x - start.x;
        let dy = end.y - start.y;
        let length_squared = dx.mul_add(dx, dy * dy);
        for y in top..bottom {
            for x in left..right {
                let px = f64::from(x) + 0.5;
                let py = f64::from(y) + 0.5;
                let progress = if length_squared <= f64::EPSILON {
                    0.0
                } else {
                    (((px - start.x) * dx + (py - start.y) * dy) / length_squared).clamp(0.0, 1.0)
                };
                let nearest_x = start.x + progress * dx;
                let nearest_y = start.y + progress * dy;
                let distance = (px - nearest_x).hypot(py - nearest_y);
                let value = ((radius + 0.5 - distance).clamp(0.0, 1.0) * 255.0).round() as u8;
                if value == 0 {
                    continue;
                }
                let pixel = coverage.get_pixel_mut(x, y);
                pixel.0[0] = pixel.0[0].max(value);
                covered.include(x, y);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> Bounds {
        Bounds {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn rectangles_cover_exactly_their_pixels() {
        let mask = Area::Rects(vec![rect(2.4, 3.0, 4.2, 2.0), rect(8.0, 8.0, 10.0, 10.0)])
            .mask(10, 10)
            .unwrap();

        assert_eq!(mask.coverage.get_pixel(2, 3).0, [255]);
        assert_eq!(mask.coverage.get_pixel(6, 4).0, [255]);
        assert_eq!(mask.coverage.get_pixel(7, 4).0, [0]);
        assert_eq!(mask.coverage.get_pixel(2, 5).0, [0]);
        assert_eq!(mask.coverage.get_pixel(9, 9).0, [255]);
        assert_eq!(
            [
                mask.bounds.x,
                mask.bounds.y,
                mask.bounds.width,
                mask.bounds.height
            ],
            [2.0, 3.0, 8.0, 7.0]
        );
    }

    #[test]
    fn strokes_cover_their_path_with_soft_edges() {
        let mask = Area::Stroke {
            points: vec![Point { x: 2.0, y: 5.0 }, Point { x: 8.0, y: 5.0 }],
            diameter: 3.0,
        }
        .mask(10, 10)
        .unwrap();

        assert_eq!(mask.coverage.get_pixel(5, 5).0, [255]);
        assert_eq!(mask.coverage.get_pixel(5, 0).0, [0]);
    }

    #[test]
    fn areas_off_the_page_or_empty_are_rejected() {
        assert!(Area::Rects(Vec::new()).mask(10, 10).is_err());
        assert!(
            Area::Rects(vec![rect(20.0, 20.0, 5.0, 5.0)])
                .mask(10, 10)
                .is_err()
        );
        assert!(
            Area::Rects(vec![rect(0.0, 0.0, -1.0, 5.0)])
                .mask(10, 10)
                .is_err()
        );
        assert!(
            Area::Stroke {
                points: Vec::new(),
                diameter: 4.0
            }
            .mask(10, 10)
            .is_err()
        );
    }
}
