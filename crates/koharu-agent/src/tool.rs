use anyhow::Result;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

use crate::Control;

#[derive(Clone, Debug)]
pub struct ToolImage {
    pub label: String,
    pub data_url: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct Tool {
    #[serde(rename = "type")]
    kind: &'static str,
    pub name: String,
    pub description: String,
    pub parameters: Value,
    pub strict: bool,
    /// Host-side classification for settings and MCP annotations. It is never
    /// part of the function definition sent to a model.
    #[serde(skip)]
    pub metadata: ToolMetadata,
}

impl Tool {
    #[must_use]
    pub fn new(
        name: impl Into<String>,
        description: impl Into<String>,
        parameters: Value,
        metadata: ToolMetadata,
    ) -> Self {
        let mut description = description.into();
        if metadata.vision == Vision::Required {
            description.push_str(" (requires image input)");
        }
        Self {
            kind: "function",
            name: name.into(),
            description,
            parameters,
            strict: false,
            metadata,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Type)]
pub struct ToolMetadata {
    pub group: ToolGroup,
    pub vision: Vision,
    pub mutates_image: bool,
    pub destructive: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ToolGroup {
    Read,
    Pages,
    Text,
    Image,
    Pipeline,
    Output,
}

/// How much a tool depends on the model seeing images.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum Vision {
    Required,
    Better,
    None,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ToolCall {
    pub call_id: String,
    pub name: String,
    pub arguments: String,
}

/// How far a call that worked on several pages reached, for activity logs.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Reach {
    /// Every page of the project.
    Project { pages: u32 },
    /// Some of the project's pages.
    Pages { pages: u32 },
}

#[derive(Clone, Debug)]
pub struct Invocation {
    pub value: Value,
    pub changed: bool,
    pub images: Vec<ToolImage>,
    /// The page the call worked on, or the first of several in project order,
    /// which following the agent shows. It is not part of the result sent to
    /// the model.
    pub page: Option<String>,
    /// How far the call reached when it worked on several pages; activity
    /// logs name that rather than `page`.
    pub reach: Option<Reach>,
}

impl Invocation {
    pub fn read(value: impl Serialize) -> Result<Self> {
        Ok(Self {
            value: serde_json::to_value(value)?,
            changed: false,
            images: Vec::new(),
            page: None,
            reach: None,
        })
    }

    pub fn changed(value: impl Serialize) -> Result<Self> {
        Ok(Self {
            value: serde_json::to_value(value)?,
            changed: true,
            images: Vec::new(),
            page: None,
            reach: None,
        })
    }

    #[must_use]
    pub fn on_page(mut self, page: impl ToString) -> Self {
        self.page = Some(page.to_string());
        self
    }

    /// Marks a call that worked on several pages, `first` being the first of
    /// them in project order.
    #[must_use]
    pub fn on_pages(mut self, first: impl ToString, reach: Reach) -> Self {
        self.page = Some(first.to_string());
        self.reach = Some(reach);
        self
    }

    #[must_use]
    pub fn with_image(mut self, label: impl Into<String>, data_url: impl Into<String>) -> Self {
        self.images.push(ToolImage {
            label: label.into(),
            data_url: data_url.into(),
        });
        self
    }
}

#[async_trait]
pub trait Host: Send + Sync + 'static {
    async fn context(&self) -> Result<Value>;

    fn tools(&self) -> Vec<Tool>;

    async fn invoke(&self, call: ToolCall, control: &Control) -> Result<Invocation>;
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn metadata(vision: Vision) -> ToolMetadata {
        ToolMetadata {
            group: ToolGroup::Read,
            vision,
            mutates_image: false,
            destructive: false,
        }
    }

    #[test]
    fn vision_requirements_are_stated_to_the_model() {
        let required = Tool::new("look", "Look.", json!({}), metadata(Vision::Required));
        let better = Tool::new("place", "Place.", json!({}), metadata(Vision::Better));

        assert_eq!(required.description, "Look. (requires image input)");
        assert_eq!(better.description, "Place.");
    }

    #[test]
    fn metadata_is_not_part_of_the_model_definition() {
        let tool = Tool::new(
            "look",
            "Look.",
            json!({ "type": "object" }),
            metadata(Vision::Required),
        );

        assert_eq!(
            serde_json::to_value(tool).unwrap(),
            json!({
                "type": "function",
                "name": "look",
                "description": "Look. (requires image input)",
                "parameters": { "type": "object" },
                "strict": false,
            })
        );
    }
}
