//! Results of reading images that are not pages of the project.

/// An area that layout detection found in an image.
#[derive(Clone, Debug, PartialEq)]
pub struct LayoutBox {
    /// The detection model's label, such as `text` or `bubble`.
    pub label: String,
    pub score: f32,
    /// `[left, top, right, bottom]` in image pixels.
    pub bounds: [f32; 4],
}
