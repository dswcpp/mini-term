use crate::agent_core::{
    fs_read::{read_file, search_files},
    workspace_context::{resolve_workspace_path, validate_workspace_command_target},
};
use serde_json::{json, Value};

pub fn read_file_tool(args: Value) -> Result<Value, String> {
    let object = args.as_object().cloned().unwrap_or_default();
    let path = object
        .get("path")
        .and_then(Value::as_str)
        .ok_or("path is required")?;
    let resolved = resolve_workspace_path(path)?;
    serde_json::to_value(read_file(resolved.requested_path)?).map_err(|err| err.to_string())
}

pub fn search_files_tool(args: Value) -> Result<Value, String> {
    let object = args.as_object().cloned().unwrap_or_default();
    let root_path = object
        .get("rootPath")
        .and_then(Value::as_str)
        .ok_or("rootPath is required")?;
    let query = object
        .get("query")
        .and_then(Value::as_str)
        .ok_or("query is required")?;
    let validated_root = validate_workspace_command_target(root_path, "search")?;
    let limit = object.get("limit").and_then(Value::as_u64).unwrap_or(20) as usize;
    Ok(json!(search_files(
        &validated_root.workspace_path,
        query,
        limit
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::tools::test_support::TestHarness;
    use serde_json::json;
    use std::fs;

    #[test]
    fn read_file_reads_workspace_file() {
        let harness = TestHarness::new("read-file-success");
        let file_path = harness.workspace_root.join("README.md");
        fs::write(&file_path, "hello").unwrap();
        let canonical_file = fs::canonicalize(&file_path).unwrap();

        let value = read_file_tool(json!({ "path": file_path.to_string_lossy() })).unwrap();
        assert_eq!(
            value["path"],
            crate::agent_core::workspace_context::resolve_workspace_path(
                &canonical_file.to_string_lossy()
            )
            .unwrap()
            .requested_path
        );
        assert_eq!(value["content"], "hello");
    }

    #[test]
    fn read_file_rejects_outside_workspace() {
        let _harness = TestHarness::new("read-file-outside");
        let outside = std::env::temp_dir().join("outside-read-file.txt");
        fs::write(&outside, "hello").unwrap();

        let error = read_file_tool(json!({ "path": outside.to_string_lossy() })).unwrap_err();
        assert_eq!(error, "workspace path is outside configured roots");

        let _ = fs::remove_file(outside);
    }

    #[test]
    fn search_files_requires_query() {
        let harness = TestHarness::new("search-files-missing");
        let error = search_files_tool(json!({ "rootPath": harness.workspace_path() })).unwrap_err();
        assert_eq!(error, "query is required");
    }

    #[test]
    fn search_files_returns_matches_inside_workspace() {
        let harness = TestHarness::new("search-files-success");
        fs::write(
            harness.workspace_root.join("notes.txt"),
            "Needle in a haystack",
        )
        .unwrap();

        let value = search_files_tool(json!({
            "rootPath": harness.workspace_path(),
            "query": "needle"
        }))
        .unwrap();

        assert_eq!(value.as_array().map(|items| items.len()), Some(1));
    }
}
