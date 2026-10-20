use std::{sync::Arc, time::Instant};

use anyhow::{Context as _, Result, bail};
use rmcp::{
    ErrorData, RoleServer, ServerHandler,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
        ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerConfig,
        SubscriptionFilter, ToolAnnotations,
    },
    service::{NotificationContext, RequestContext, SubscriptionContext},
};
use serde_json::Value;

use super::{Calls, Clients, Shared, ToolActivity};
use crate::{Control, Host, Invocation, Tool, ToolCall, ToolGroup, ToolImage};

// Host-neutral counterpart of the in-app agent instructions. MCP clients receive no
// injected project context, so they are told how to read the project themselves.
const INSTRUCTIONS: &str = r#"These tools operate the manga translation project that is currently open in Koharu.
Work page by page. Call inspect_page for the page you work on: it is compact and lists every text element with its ID, box, source text, and translation. Call inspect_project only for an overview of every page; it is large for long projects. Read the state again after edits instead of assuming their effect.
A typical page: run_pipeline with operation detection and then ocr for the page; remove with the text elements whose original text should disappear; set_translations once with every translation of the page; then check the result with inspect_page, or view_page when you can see images. Fix warnings about text that does not fit by shortening the translation or adjusting its typography. Finally call set_page_status with translated_by_agent, or with needs_review when the page needs the owner's attention.
Call read_glossary before translating and keep the translation of every glossary term; add the names and terms you settle on with set_glossary_terms so later pages stay consistent. An element's reference is what a published translation of the work says there: when present, base the translation on its meaning and terms, and use the source text to confirm it.
If your model cannot see images, do not call view_page: rely on the boxes and text from inspect_page, give remove, draw, and erase areas as element IDs rather than guessed coordinates, and tell the user which pages need a visual check.
Use the provided tools whenever the user asks to inspect or change the project. Never claim a change succeeded unless its tool result says it succeeded. The user may turn tools off in Koharu's settings; do not try to work around a tool that is unavailable.
All project changes are revisioned and reversible from Koharu's undo history.
Do not invent entity identifiers. Preserve artwork and existing authored content unless the user asks to change them."#;

/// Serves one MCP session by forwarding tool requests to the shared [`Host`].
pub(super) struct Handler<H> {
    shared: Arc<Shared<H>>,
    calls: Arc<Calls>,
    clients: Arc<Clients>,
}

impl<H> Handler<H> {
    pub(super) fn new(shared: Arc<Shared<H>>, calls: Arc<Calls>, clients: Arc<Clients>) -> Self {
        Self {
            shared,
            calls,
            clients,
        }
    }
}

impl<H> ServerHandler for Handler<H>
where
    H: Host,
{
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_tool_list_changed()
                .build(),
        )
        .with_server_info(
            Implementation::new("koharu", env!("CARGO_PKG_VERSION")).with_title("Koharu"),
        )
        .with_instructions(INSTRUCTIONS)
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let tools = self
            .shared
            .enabled_tools()
            .and_then(|tools| tools.into_iter().map(tool).collect::<Result<Vec<_>>>())
            .map_err(|error| ErrorData::internal_error(format!("{error:#}"), None))?;
        Ok(ListToolsResult::with_all_items(tools))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let started = Instant::now();
        let call = ToolCall {
            call_id: context.id.to_string(),
            name: request.name.into_owned(),
            arguments: Value::Object(request.arguments.unwrap_or_default()).to_string(),
        };
        let tool = call.name.clone();
        let (result, page, changed) = self.run(call, &context).await?;
        let activity = ToolActivity::new(tool, started.elapsed());
        self.shared.activity.record(match result.is_error {
            Some(true) => activity.failed(first_text(&result)),
            _ => ToolActivity {
                page,
                changed,
                ..activity
            },
        });
        Ok(result.into())
    }

    async fn on_initialized(&self, context: NotificationContext<RoleServer>) {
        self.clients.add_session(context.peer);
    }

    fn accepted_subscription_filter(
        &self,
        _requested: &SubscriptionFilter,
    ) -> Option<SubscriptionFilter> {
        Some(SubscriptionFilter::builder().tools_list_changed().build())
    }

    async fn listen(&self, context: SubscriptionContext) -> Result<(), ErrorData> {
        let _subscription = self.clients.subscribe(context.sink().clone());
        context.cancelled().await;
        Ok(())
    }
}

impl<H> Handler<H>
where
    H: Host,
{
    /// Runs one call unless Koharu's settings or a stopping server refuse it.
    /// Also returns the page the call worked on and whether it changed the project.
    async fn run(
        &self,
        call: ToolCall,
        context: &RequestContext<RoleServer>,
    ) -> Result<(CallToolResult, Option<String>, bool), ErrorData> {
        let disabled = self
            .shared
            .disables(&call.name)
            .map_err(|error| ErrorData::internal_error(format!("{error:#}"), None))?;
        if disabled {
            let message = format!("Tool `{}` is disabled in Koharu settings", call.name);
            return Ok((refusal(message), None, false));
        }
        let control = Control::default();
        let Some(_call) = self.calls.begin(control.clone()) else {
            let message = "Koharu's MCP server is stopping and accepts no new tool calls";
            return Ok((refusal(message.to_owned()), None, false));
        };
        let mut invocation = self.shared.host.invoke(call, &control);
        // A cancelled MCP request stops the host through the same control as an
        // in-app agent run; the invocation still finishes so it can clean up.
        let invocation = tokio::select! {
            invocation = &mut invocation => invocation,
            () = context.ct.cancelled() => {
                control.cancel();
                invocation.await
            }
        };
        let (page, changed) = invocation.as_ref().map_or((None, false), |invocation| {
            (invocation.page.clone(), invocation.changed)
        });
        Ok((result(invocation), page, changed))
    }
}

fn refusal(message: String) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(message)])
}

fn first_text(result: &CallToolResult) -> &str {
    result
        .content
        .iter()
        .find_map(|block| block.as_text())
        .map_or("", |text| text.text.as_str())
}

fn tool(tool: Tool) -> Result<rmcp::model::Tool> {
    let Value::Object(schema) = tool.parameters else {
        bail!("tool {} parameters are not a JSON object schema", tool.name);
    };
    // Every Koharu tool works inside the open project, so none reaches an open world.
    let annotations = ToolAnnotations::new()
        .read_only(tool.metadata.group == ToolGroup::Read)
        .destructive(tool.metadata.destructive)
        .open_world(false);
    Ok(rmcp::model::Tool::new(tool.name, tool.description, schema).with_annotations(annotations))
}

fn result(invocation: Result<Invocation>) -> CallToolResult {
    match invocation.and_then(content) {
        Ok(content) => CallToolResult::success(content),
        Err(error) => CallToolResult::error(vec![ContentBlock::text(format!("{error:#}"))]),
    }
}

fn content(invocation: Invocation) -> Result<Vec<ContentBlock>> {
    let mut content = vec![ContentBlock::text(invocation.value.to_string())];
    for image in &invocation.images {
        content.push(self::image(image)?);
    }
    Ok(content)
}

fn image(image: &ToolImage) -> Result<ContentBlock> {
    let (mime_type, data) = image
        .data_url
        .strip_prefix("data:")
        .and_then(|data_url| data_url.split_once(";base64,"))
        .with_context(|| format!("{} is not a base64 data URL", image.label))?;
    Ok(ContentBlock::image(data, mime_type))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::mcp::tests::{FakeHost, PIXEL, TOOLS};

    async fn invoke(name: &str, arguments: Value) -> Result<Invocation> {
        FakeHost::default()
            .invoke(
                ToolCall {
                    call_id: "1".to_owned(),
                    name: name.to_owned(),
                    arguments: arguments.to_string(),
                },
                &Control::default(),
            )
            .await
    }

    #[test]
    fn host_tools_become_mcp_tools() -> Result<()> {
        let tools = FakeHost::default()
            .tools()
            .into_iter()
            .map(tool)
            .collect::<Result<Vec<_>>>()?;

        assert_eq!(
            tools
                .iter()
                .map(|tool| tool.name.as_ref())
                .collect::<Vec<_>>(),
            TOOLS
        );
        assert_eq!(
            tools[0].description.as_deref(),
            Some("Fake inspect_project.")
        );
        assert_eq!(
            Value::Object((*tools[0].input_schema).clone()),
            json!({ "type": "object", "properties": {} })
        );
        Ok(())
    }

    #[test]
    fn annotations_follow_tool_metadata() -> Result<()> {
        let tools = FakeHost::default()
            .tools()
            .into_iter()
            .map(tool)
            .collect::<Result<Vec<_>>>()?;
        let annotations = |name: &str| {
            tools
                .iter()
                .find(|tool| tool.name == name)
                .and_then(|tool| tool.annotations.clone())
                .expect("every Koharu tool is annotated")
        };

        let read = annotations("inspect_project");
        assert_eq!(read.read_only_hint, Some(true));
        assert_eq!(read.open_world_hint, Some(false));
        let delete = annotations("delete_pages");
        assert_eq!(delete.read_only_hint, Some(false));
        assert_eq!(delete.destructive_hint, Some(true));
        let edit = annotations("set_translation");
        assert_eq!(edit.read_only_hint, Some(false));
        assert_eq!(edit.destructive_hint, Some(false));
        Ok(())
    }

    #[test]
    fn non_object_schemas_are_rejected() {
        assert!(
            tool(Tool::new(
                "broken",
                "Broken.",
                json!(true),
                crate::mcp::tests::metadata("broken")
            ))
            .is_err()
        );
    }

    #[tokio::test]
    async fn values_become_json_text() {
        let result = result(invoke("inspect_project", json!({})).await);

        assert_eq!(result.is_error, Some(false));
        assert_eq!(
            result.content,
            vec![ContentBlock::text(json!({ "pages": [] }).to_string())]
        );
    }

    #[tokio::test]
    async fn images_become_base64_image_content() {
        let result = result(invoke("view_page", json!({ "page": "page" })).await);

        assert_eq!(result.is_error, Some(false));
        assert_eq!(
            result.content,
            vec![
                ContentBlock::text(json!({ "page": "page" }).to_string()),
                ContentBlock::image(PIXEL, "image/webp"),
            ]
        );
    }

    #[tokio::test]
    async fn host_errors_become_error_results() {
        let result = result(invoke("missing_tool", json!({})).await);

        assert_eq!(result.is_error, Some(true));
        assert_eq!(
            result.content,
            vec![ContentBlock::text("unknown Koharu tool missing_tool")]
        );
    }

    #[test]
    fn images_without_a_data_url_become_error_results() -> Result<()> {
        let invocation =
            Invocation::read(json!({}))?.with_image("Rendered page", "https://example.com/1.webp");

        let result = result(Ok(invocation));

        assert_eq!(result.is_error, Some(true));
        assert_eq!(
            result.content,
            vec![ContentBlock::text("Rendered page is not a base64 data URL")]
        );
        Ok(())
    }
}
