use std::path::PathBuf;

use anyhow::{Context as _, Result};
use serde::{Deserialize, Serialize};
use specta::Type;

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

/// Settings for the agent tools served over MCP.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, Type)]
pub struct McpConfig {
    /// Loopback port, read once when the server starts.
    pub port: u16,
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
}

impl Default for McpConfig {
    fn default() -> Self {
        Self {
            port: 47821,
            export_dir: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configs_without_new_mcp_fields_keep_their_defaults() {
        let config: Config = toml::from_str("reasoning = \"high\"\n[mcp]\nport = 5000\n").unwrap();

        assert_eq!(config.mcp.port, 5000);
        assert_eq!(config.mcp.export_dir, None);
        let defaults = toml::Value::try_from(Config::default()).unwrap();
        assert_eq!(defaults.try_into::<Config>().unwrap(), Config::default());
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
