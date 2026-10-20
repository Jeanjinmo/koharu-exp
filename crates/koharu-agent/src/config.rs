use std::{collections::BTreeSet, path::PathBuf};

use anyhow::{Context as _, Result};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::Tool;

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
    /// Tools that MCP clients can neither list nor call.
    pub disabled_tools: BTreeSet<String>,
    /// Folder that receives agent exports; `None` uses `Documents/Koharu/exports`.
    pub export_dir: Option<PathBuf>,
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

    /// Whether MCP clients may list and call `tool`.
    #[must_use]
    pub fn enables(&self, tool: &Tool) -> bool {
        !self.disabled_tools.contains(&tool.name)
    }
}

impl Default for McpConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            port: 47821,
            disabled_tools: BTreeSet::new(),
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
        assert!(defaults.disabled_tools.is_empty());
        assert_eq!(defaults.export_dir, None);
        let saved = toml::Value::try_from(Config::default()).unwrap();
        assert_eq!(saved.try_into::<Config>().unwrap(), Config::default());
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
