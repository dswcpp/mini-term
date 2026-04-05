use crate::agent_core::workspace_context::validate_workspace_command_target;
use crate::ai_sessions::get_ai_sessions;
use serde_json::Value;

pub fn list_ai_sessions_tool(args: Value) -> Result<Value, String> {
    let object = args.as_object().cloned().unwrap_or_default();
    let project_paths = object
        .get("projectPaths")
        .and_then(Value::as_array)
        .ok_or("projectPaths is required")?
        .iter()
        .filter_map(|value| value.as_str())
        .map(|path| {
            validate_workspace_command_target(path, "list-ai-sessions")
                .map(|item| item.workspace_path)
        })
        .collect::<Result<Vec<_>, _>>()?;

    serde_json::to_value(get_ai_sessions(project_paths)?).map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::tools::test_support::TestHarness;
    use serde_json::json;

    #[test]
    fn list_ai_sessions_returns_success_for_workspace_paths() {
        let harness = TestHarness::new("sessions-success");
        let value = list_ai_sessions_tool(json!({
            "projectPaths": [harness.workspace_path()]
        }))
        .unwrap();

        assert!(value.is_array());
    }
}
