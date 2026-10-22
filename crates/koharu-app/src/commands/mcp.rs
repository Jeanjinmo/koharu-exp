//! Settings and live status of the MCP server that offers Koharu's agent
//! tools to external agents. The in-app agent is unaffected by these settings.

use std::{path::PathBuf, sync::OnceLock};

use anyhow::{Context as _, Result, anyhow};
use koharu_agent::{
    Config, McpConfig, ToolMetadata, ToolProfile,
    mcp::{McpClient, ServerStatus, Supervisor, ToolActivity},
};
use koharu_scene::EntityId;
use koharu_secrets::ExposeSecret as _;
use parking_lot::Mutex;
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager as _, State, WebviewWindow, ipc::Channel};
use tauri_runtime_cef::CefRuntime;
use tokio::sync::broadcast::error::RecvError;

use super::{ChannelExt as _, Error, agent::KoharuHost, lifecycle};

#[derive(Default)]
pub(crate) struct McpState {
    supervisor: OnceLock<Supervisor<KoharuHost>>,
    /// Kept while Koharu runs: on Linux, copied text lasts only as long as
    /// the clipboard that set it.
    clipboard: Mutex<Option<arboard::Clipboard>>,
}

#[derive(Default)]
pub(crate) struct McpChannel {
    pub(crate) channel: Mutex<Option<Channel<McpEvent>>>,
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum McpEvent {
    Status {
        status: ServerStatus,
    },
    Activity {
        activity: ToolActivity,
    },
    ActivityCleared,
    /// The editor now shows the page an agent changed.
    Followed {
        page: EntityId,
    },
}

/// What the UI shows about the MCP server when it starts.
#[derive(Clone, Debug, Serialize, Type)]
pub struct McpOverview {
    pub status: ServerStatus,
    /// The recent tool calls, oldest first.
    pub activity: Vec<ToolActivity>,
}

#[derive(Clone, Debug, Serialize, Type)]
pub struct McpSettings {
    pub config: McpConfig,
    /// Every agent tool, including the ones MCP clients may not use.
    pub tools: Vec<McpTool>,
    /// Where agent exports go, with the default folder resolved.
    pub export_folder: PathBuf,
}

#[derive(Clone, Debug, Serialize, Type)]
pub struct McpTool {
    pub name: String,
    pub metadata: ToolMetadata,
    /// Whether the chosen profile lets MCP clients list and call the tool.
    pub enabled: bool,
}

impl McpState {
    /// Supervises the MCP server and reports its status to the UI. Call this
    /// only after the desktop runtime is initialized, because tools such as
    /// `run_pipeline` depend on state managed during initialization.
    pub(crate) fn start(&self, handle: AppHandle<CefRuntime>) -> Result<()> {
        let supervisor = Supervisor::new(KoharuHost::new(handle.clone()), Config::load()?)?;
        let mut status = supervisor.status();
        let status_handle = handle.clone();
        drop(tauri::async_runtime::spawn(async move {
            loop {
                let current = status.borrow_and_update().clone();
                status_handle
                    .state::<McpChannel>()
                    .channel
                    .publish(McpEvent::Status { status: current });
                if status.changed().await.is_err() {
                    break;
                }
            }
        }));
        let mut activity = supervisor.subscribe_activity();
        drop(tauri::async_runtime::spawn(async move {
            loop {
                match activity.recv().await {
                    Ok(activity) => {
                        let followed = followed_page(&activity);
                        handle
                            .state::<McpChannel>()
                            .channel
                            .publish(McpEvent::Activity { activity });
                        if let Some(page) = followed {
                            follow(&handle, page).await;
                        }
                    }
                    Err(RecvError::Lagged(skipped)) => {
                        tracing::warn!(skipped, "the MCP activity log fell behind");
                    }
                    Err(RecvError::Closed) => break,
                }
            }
        }));
        self.supervisor
            .set(supervisor)
            .map_err(|_| anyhow!("the MCP server is already supervised"))
    }

    pub(crate) fn overview(&self) -> McpOverview {
        match self.supervisor.get() {
            Some(supervisor) => McpOverview {
                status: supervisor.status().borrow().clone(),
                activity: supervisor.activity(),
            },
            None => McpOverview {
                status: ServerStatus::Off,
                activity: Vec::new(),
            },
        }
    }

    /// Closes the server at once, cancelling the tool calls it is running.
    pub(crate) fn shutdown(&self) {
        if let Some(supervisor) = self.supervisor.get() {
            supervisor.shutdown();
        }
    }

    fn supervisor(&self) -> Result<&Supervisor<KoharuHost>> {
        self.supervisor
            .get()
            .context("the MCP server is not ready yet")
    }

    fn settings(&self) -> Result<McpSettings> {
        let config = Config::load()?.read()?.mcp.clone();
        Ok(McpSettings {
            export_folder: config.export_folder()?,
            tools: self
                .supervisor()?
                .tools()
                .into_iter()
                .map(|tool| McpTool {
                    enabled: config.enables(&tool),
                    name: tool.name,
                    metadata: tool.metadata,
                })
                .collect(),
            config,
        })
    }
}

/// The page to show after a call, when following the agent is on and the
/// call changed that page.
fn followed_page(activity: &ToolActivity) -> Option<EntityId> {
    let follow = Config::load()
        .and_then(|config| Ok(config.read()?.mcp.follow_agent))
        .unwrap_or(false);
    if !follow || !activity.ok || !activity.changed {
        return None;
    }
    serde_json::from_value(serde_json::Value::String(activity.page.clone()?)).ok()
}

async fn follow(handle: &AppHandle<CefRuntime>, page: EntityId) {
    match lifecycle::follow_page(handle, page).await {
        Ok(true) => handle
            .state::<McpChannel>()
            .channel
            .publish(McpEvent::Followed { page }),
        Ok(false) => {}
        // The agent may have deleted or moved past the page since.
        Err(error) => tracing::debug!("could not follow the agent to its page: {error:#}"),
    }
}

fn set_export_dir(folder: Option<PathBuf>) -> Result<()> {
    let config = Config::load()?;
    let mut config = config.write()?;
    config.mcp.export_dir = folder;
    config.save()
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn get_mcp_settings(
    state: State<'_, McpState>,
) -> std::result::Result<McpSettings, Error> {
    Ok(state.settings()?)
}

/// Starts or stops the server. Enabling also retries a server that failed.
#[tauri::command]
#[specta::specta]
pub(crate) async fn set_mcp_enabled(
    enabled: bool,
    state: State<'_, McpState>,
) -> std::result::Result<McpSettings, Error> {
    state.supervisor()?.set_enabled(enabled)?;
    Ok(state.settings()?)
}

/// Chooses the tools MCP clients may use: a preset profile, or the custom
/// profile without `disabled_tools`.
#[tauri::command]
#[specta::specta]
pub(crate) async fn set_mcp_tools(
    profile: ToolProfile,
    disabled_tools: Vec<String>,
    state: State<'_, McpState>,
) -> std::result::Result<McpSettings, Error> {
    state
        .supervisor()?
        .set_tools(profile, disabled_tools.into_iter().collect())?;
    Ok(state.settings()?)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn set_mcp_follow_agent(
    follow: bool,
    state: State<'_, McpState>,
) -> std::result::Result<McpSettings, Error> {
    {
        let config = Config::load()?;
        let mut config = config.write()?;
        config.mcp.follow_agent = follow;
        config.save()?;
    }
    Ok(state.settings()?)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn choose_mcp_export_folder(
    window: WebviewWindow<CefRuntime>,
    state: State<'_, McpState>,
) -> std::result::Result<McpSettings, Error> {
    let current = Config::load()?.read()?.mcp.export_folder()?;
    if let Some(folder) = rfd::AsyncFileDialog::new()
        .set_directory(&current)
        .set_parent(&window)
        .pick_folder()
        .await
    {
        set_export_dir(Some(folder.path().to_owned()))?;
    }
    Ok(state.settings()?)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn reset_mcp_export_folder(
    state: State<'_, McpState>,
) -> std::result::Result<McpSettings, Error> {
    set_export_dir(None)?;
    Ok(state.settings()?)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn clear_mcp_activity(
    state: State<'_, McpState>,
    channel: State<'_, McpChannel>,
) -> std::result::Result<(), Error> {
    state.supervisor()?.clear_activity();
    channel.channel.publish(McpEvent::ActivityCleared);
    Ok(())
}

/// Copies what registers the running server with `client`, its URL and token
/// included, to the clipboard. The token never reaches the UI.
#[tauri::command]
#[specta::specta]
pub(crate) async fn copy_mcp_registration(
    client: McpClient,
    state: State<'_, McpState>,
) -> std::result::Result<(), Error> {
    let registration = state.supervisor()?.registration(client)?;
    let mut clipboard = state.clipboard.lock();
    if clipboard.is_none() {
        *clipboard = Some(arboard::Clipboard::new().context("the clipboard is unavailable")?);
    }
    clipboard
        .as_mut()
        .context("the clipboard is unavailable")?
        .set_text(registration.expose_secret())
        .context("failed to copy to the clipboard")?;
    Ok(())
}

/// Cancels the tool calls that a stopping server is still waiting for.
#[tauri::command]
#[specta::specta]
pub(crate) async fn stop_mcp_now(state: State<'_, McpState>) -> std::result::Result<(), Error> {
    state.supervisor()?.stop_now();
    Ok(())
}
