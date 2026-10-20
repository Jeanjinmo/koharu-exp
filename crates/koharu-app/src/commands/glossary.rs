//! The project glossary: terms and names with the translation each keeps,
//! which translation follows.

use anyhow::Context as _;
use koharu_scene::GlossaryEntry;
use tauri::State;

use super::{
    ChannelExt as _, Error,
    lifecycle::ProjectChannel,
    project::{CurrentProject, Project},
};

#[tauri::command]
#[specta::specta]
pub(crate) async fn get_glossary(
    project: State<'_, CurrentProject>,
) -> std::result::Result<Vec<GlossaryEntry>, Error> {
    let project = project.project.lock().await;
    let project = project.as_ref().context("no project is open")?;
    Ok(Project::glossary(&project.snapshot())?)
}

/// Adds a term, or changes the one named `previous`, as one undo step.
#[tauri::command]
#[specta::specta]
pub(crate) async fn set_glossary_term(
    previous: Option<String>,
    entry: GlossaryEntry,
    project: State<'_, CurrentProject>,
    project_channel: State<'_, ProjectChannel>,
) -> std::result::Result<(), Error> {
    let info = {
        let mut project = project.project.lock().await;
        let project = project.as_mut().context("no project is open")?;
        let commit = project.set_glossary_terms(vec![(previous, entry)]).await?;
        project.record_commit(&commit);
        project.info()
    };
    project_channel.channel.publish(Some(info));
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn remove_glossary_term(
    term: String,
    project: State<'_, CurrentProject>,
    project_channel: State<'_, ProjectChannel>,
) -> std::result::Result<(), Error> {
    let info = {
        let mut project = project.project.lock().await;
        let project = project.as_mut().context("no project is open")?;
        let commit = project.remove_glossary_terms(vec![term]).await?;
        project.record_commit(&commit);
        project.info()
    };
    project_channel.channel.publish(Some(info));
    Ok(())
}
