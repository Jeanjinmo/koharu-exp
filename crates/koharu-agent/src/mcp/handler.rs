use std::sync::Arc;

use anyhow::{Context as _, Result, bail};
use rmcp::{
    ErrorData, RoleServer, ServerHandler,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
        ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerConfig,
    },
    service::RequestContext,
};
use serde_json::Value;

use crate::{Control, Host, Invocation, Tool, ToolCall, ToolImage};

// Host-neutral counterpart of the in-app agent instructions. MCP clients receive no
// injected project context, so they are pointed at `inspect_project` instead.
const INSTRUCTIONS: &str = r#"These tools operate the manga translation project that is currently open in Koharu.
Call inspect_project to read the complete current project state before acting, and again after edits instead of assuming their effect. It omits page images. Call view_page only when visual inspection is needed, and only for relevant pages.
Use the provided tools whenever the user asks to inspect or change the project. Never claim a change succeeded unless its tool result says it succeeded.
All project changes are revisioned and reversible from Koharu's undo history.
Do not invent entity identifiers. Preserve artwork and existing authored content unless the user asks to change them."#;

/// Serves one MCP session by forwarding tool requests to the shared [`Host`].
pub(super) struct Handler<H> {
    host: Arc<H>,
}

impl<H> Handler<H> {
    pub(super) fn new(host: Arc<H>) -> Self {
        Self { host }
    }
}

impl<H> ServerHandler for Handler<H>
where
    H: Host,
{
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
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
            .host
            .tools()
            .into_iter()
            .map(tool)
            .collect::<Result<Vec<_>>>()
            .map_err(|error| ErrorData::internal_error(format!("{error:#}"), None))?;
        Ok(ListToolsResult::with_all_items(tools))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let call = ToolCall {
            call_id: context.id.to_string(),
            name: request.name.into_owned(),
            arguments: Value::Object(request.arguments.unwrap_or_default()).to_string(),
        };
        let control = Control::default();
        let mut invocation = self.host.invoke(call, &control);
        // A cancelled MCP request stops the host through the same control as an
        // in-app agent run; the invocation still finishes so it can clean up.
        let invocation = tokio::select! {
            invocation = &mut invocation => invocation,
            () = context.ct.cancelled() => {
                control.cancel();
                invocation.await
            }
        };
        Ok(result(invocation).into())
    }
}

fn tool(tool: Tool) -> Result<rmcp::model::Tool> {
    let Value::Object(schema) = tool.parameters else {
        bail!("tool {} parameters are not a JSON object schema", tool.name);
    };
    Ok(rmcp::model::Tool::new(tool.name, tool.description, schema))
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
    fn non_object_schemas_are_rejected() {
        assert!(tool(Tool::new("broken", "Broken.", json!(true))).is_err());
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
