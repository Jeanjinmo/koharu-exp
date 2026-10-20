use std::{collections::BTreeSet, path::PathBuf};

use anyhow::{Context as _, Result};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::{Tool, ToolGroup, Vision};

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, Type)]
pub struct Config {
    pub model: Option<String>,
    pub reasoning: Reasoning,
    pub mcp: McpConfig,
}

impl Config {
    pub fn load() -> Result<koharu_config::Config<Self>> {
        koharu_config::load("agent")
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum Reasoning {
    Low,
    #[default]
    Medium,
    High,
    Xhigh,
    Max,
    Ultra,
}

impl Reasoning {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
            Self::Ultra => "ultra",
        }
    }
}

/// Settings for the agent tools served over MCP. Koharu's configuration loader
/// merges saved values over [`McpConfig::default`], so configurations saved
/// before a field existed still load.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, Type)]
pub struct McpConfig {
    /// Whether Koharu serves MCP at all.
    pub enabled: bool,
    /// Loopback port, read whenever the server starts.
    pub port: u16,
    /// Which tools MCP clients may list and call.
    pub profile: ToolProfile,
    /// Tools the custom profile turns off.
    pub disabled_tools: BTreeSet<String>,
    /// Whether the editor shows each page an MCP tool call changes.
    pub follow_agent: bool,
    /// Folder that receives agent exports; `None` uses `Documents/Koharu/exports`.
    pub export_dir: Option<PathBuf>,
}

/// A tool selection matched to what the agent's model can do. Koharu cannot
/// detect a model's abilities, so the owner chooses one.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ToolProfile {
    /// Every tool, for models that see images.
    #[default]
    Vision,
    /// Every tool that works without seeing images.
    Text,
    /// Only tools that read the project.
    Read,
    /// The tools that `disabled_tools` leaves on.
    Custom,
}

impl McpConfig {
    pub fn export_folder(&self) -> Result<PathBuf> {
        match &self.export_dir {
            Some(folder) => Ok(folder.clone()),
            None => Ok(dirs::document_dir()
                .context("the Documents folder is unavailable")?
                .join("Koharu")
                .join("exports")),
        }
    }

    /// Whether MCP clients may list and call `tool`. Preset profiles follow
    /// tool metadata, so tools added later join the matching profiles.
    #[must_use]
    pub fn enables(&self, tool: &Tool) -> bool {
        match self.profile {
            ToolProfile::Vision => true,
            ToolProfile::Text => tool.metadata.vision != Vision::Required,
            ToolProfile::Read => tool.metadata.group == ToolGroup::Read,
            ToolProfile::Custom => !self.disabled_tools.contains(&tool.name),
        }
    }
}

impl Default for McpConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            port: 47821,
            profile: ToolProfile::default(),
            disabled_tools: BTreeSet::new(),
            follow_agent: true,
            export_dir: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_defaults_serve_every_tool_on_the_documented_port() {
        let defaults = McpConfig::default();

        assert!(defaults.enabled);
        assert_eq!(defaults.port, 47821);
        assert_eq!(defaults.profile, ToolProfile::Vision);
        assert!(defaults.disabled_tools.is_empty());
        assert!(defaults.follow_agent);
        assert_eq!(defaults.export_dir, None);
        let saved = toml::Value::try_from(Config::default()).unwrap();
        assert_eq!(saved.try_into::<Config>().unwrap(), Config::default());
    }

    #[test]
    fn profiles_select_tools_by_their_metadata() {
        let tool = |name: &str, group, vision| {
            Tool::new(
                name,
                "Tool.",
                serde_json::json!({}),
                crate::ToolMetadata {
                    group,
                    vision,
                    mutates_image: false,
                    destructive: false,
                },
            )
        };
        let tools = [
            tool("inspect_page", ToolGroup::Read, Vision::None),
            tool("view_page", ToolGroup::Read, Vision::Required),
            tool("remove", ToolGroup::Image, Vision::Better),
        ];
        let enabled = |profile, disabled: &[&str]| {
            let config = McpConfig {
                profile,
                disabled_tools: disabled.iter().map(|name| (*name).to_owned()).collect(),
                ..McpConfig::default()
            };
            tools
                .iter()
                .filter(|tool| config.enables(tool))
                .map(|tool| tool.name.as_str())
                .collect::<Vec<_>>()
        };

        assert_eq!(
            enabled(ToolProfile::Vision, &["remove"]),
            ["inspect_page", "view_page", "remove"]
        );
        assert_eq!(enabled(ToolProfile::Text, &[]), ["inspect_page", "remove"]);
        assert_eq!(
            enabled(ToolProfile::Read, &[]),
            ["inspect_page", "view_page"]
        );
        assert_eq!(
            enabled(ToolProfile::Custom, &["inspect_page"]),
            ["view_page", "remove"]
        );
    }

    #[test]
    fn exports_default_to_the_documents_folder() {
        let custom = McpConfig {
            export_dir: Some(PathBuf::from("/exports")),
            ..McpConfig::default()
        };

        assert_eq!(custom.export_folder().unwrap(), PathBuf::from("/exports"));
        if let Some(documents) = dirs::document_dir() {
            assert_eq!(
                McpConfig::default().export_folder().unwrap(),
                documents.join("Koharu").join("exports")
            );
        }
    }
}
