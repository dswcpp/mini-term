use crate::agent_core::{
    git_context::{get_diff_for_review, get_git_summary},
    workspace_context::{validate_workspace_command_target, validate_workspace_relative_file_path},
};
use serde_json::Value;

pub fn get_git_summary_tool(args: Value) -> Result<Value, String> {
    let object = args.as_object().cloned().unwrap_or_default();
    let project_path = object
        .get("projectPath")
        .and_then(Value::as_str)
        .ok_or("projectPath is required")?;
    let validated = validate_workspace_command_target(project_path, "git-summary")?;
    serde_json::to_value(get_git_summary(&validated.workspace_path)?).map_err(|err| err.to_string())
}

pub fn get_diff_for_review_tool(args: Value) -> Result<Value, String> {
    let object = args.as_object().cloned().unwrap_or_default();
    let project_path = object
        .get("projectPath")
        .and_then(Value::as_str)
        .ok_or("projectPath is required")?;
    let file_path = object
        .get("filePath")
        .and_then(Value::as_str)
        .ok_or("filePath is required")?;
    let validated_project = validate_workspace_command_target(project_path, "git-diff")?;
    let validated_file_path =
        validate_workspace_relative_file_path(&validated_project.workspace_path, file_path)?;
    serde_json::to_value(get_diff_for_review(
        &validated_project.workspace_path,
        &validated_file_path,
    )?)
    .map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::tools::test_support::TestHarness;
    use serde_json::json;

    #[test]
    fn get_git_summary_succeeds_for_workspace_directory() {
        let harness = TestHarness::new("git-summary-success");
        let value = get_git_summary_tool(json!({
            "projectPath": harness.workspace_path()
        }))
        .unwrap();

        assert_eq!(value["repoCount"], 0);
    }

    #[test]
    fn get_diff_for_review_rejects_parent_traversal() {
        let harness = TestHarness::new("git-diff-parent");
        let error = get_diff_for_review_tool(json!({
            "projectPath": harness.workspace_path(),
            "filePath": "../secret.txt"
        }))
        .unwrap_err();

        assert_eq!(error, "file path must not escape the project path");
    }
}
