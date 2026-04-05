use crate::agent_core::{
    models::TaskContextPreset,
    workspace_context::{get_workspace_context, list_workspaces},
};
use serde_json::{json, Value};

fn parse_preset(value: Option<&str>) -> TaskContextPreset {
    match value {
        Some("review") => TaskContextPreset::Review,
        Some("standard") => TaskContextPreset::Standard,
        _ => TaskContextPreset::Light,
    }
}

pub fn list_workspaces_tool(_: Value) -> Result<Value, String> {
    Ok(json!(list_workspaces()))
}

pub fn get_workspace_context_tool(args: Value) -> Result<Value, String> {
    let object = args.as_object().cloned().unwrap_or_default();
    let workspace_id = object
        .get("workspaceId")
        .and_then(Value::as_str)
        .ok_or("workspaceId is required")?;
    let preset = parse_preset(object.get("preset").and_then(Value::as_str));
    serde_json::to_value(get_workspace_context(workspace_id, preset)?)
        .map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::tools::test_support::TestHarness;
    use serde_json::json;
    use std::fs;

    #[test]
    fn list_workspaces_returns_configured_workspace() {
        let _harness = TestHarness::new("workspace-list");
        let value = list_workspaces_tool(json!({})).unwrap();
        let workspaces = value.as_array().unwrap();
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0]["workspaceId"], "workspace-1");
    }

    #[test]
    fn get_workspace_context_requires_workspace_id() {
        let _harness = TestHarness::new("workspace-context-missing");
        let error = get_workspace_context_tool(json!({})).unwrap_err();
        assert_eq!(error, "workspaceId is required");
    }

    #[test]
    fn get_workspace_context_returns_instruction_documents() {
        let harness = TestHarness::new("workspace-context-success");
        fs::write(harness.workspace_root.join("README.md"), "Mini-Term").unwrap();
        fs::write(
            harness.workspace_root.join("AGENTS.md"),
            "workspace instructions",
        )
        .unwrap();

        let value = get_workspace_context_tool(json!({
            "workspaceId": "workspace-1",
            "preset": "review"
        }))
        .unwrap();

        assert_eq!(value["workspace"]["workspaceId"], "workspace-1");
        assert_eq!(
            value["relatedFiles"].as_array().map(|items| items.len()),
            Some(1)
        );
        assert_eq!(
            value["instructions"].as_array().map(|items| items.len()),
            Some(1)
        );
    }
}
