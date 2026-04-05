use crate::agent_core::data_dir::{clear_thread_data_dir, set_thread_data_dir};
use crate::config::{save_config_to_path, AppConfig, WorkspaceConfig, WorkspaceRootConfig};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn unique_temp_dir(label: &str) -> PathBuf {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tid = std::thread::current().id();
    let path = std::env::temp_dir().join(format!("mini-term-mcp-{label}-{unique}-{tid:?}"));
    fs::create_dir_all(&path).unwrap();
    path
}

pub struct TestHarness {
    pub data_dir: PathBuf,
    pub workspace_root: PathBuf,
}

impl TestHarness {
    pub fn new(label: &str) -> Self {
        let data_dir = unique_temp_dir(&format!("{label}-data"));
        let workspace_root = unique_temp_dir(&format!("{label}-workspace"));

        // Per-thread override: no global env var mutation, no serialising lock.
        set_thread_data_dir(data_dir.clone());

        let config = AppConfig {
            workspaces: vec![WorkspaceConfig {
                id: "workspace-1".into(),
                name: "mini-term".into(),
                roots: vec![WorkspaceRootConfig {
                    id: "root-1".into(),
                    name: "mini-term".into(),
                    path: workspace_root.to_string_lossy().to_string(),
                    role: "primary".into(),
                }],
                pinned: false,
                accent: None,
                saved_layout: None,
                expanded_dirs_by_root: Default::default(),
                created_at: 1,
                last_opened_at: 1,
            }],
            ..AppConfig::default()
        };
        save_config_to_path(&crate::agent_core::data_dir::config_path(), config).unwrap();

        Self {
            data_dir,
            workspace_root,
        }
    }

    pub fn workspace_path(&self) -> String {
        self.workspace_root.to_string_lossy().to_string()
    }
}

impl Drop for TestHarness {
    fn drop(&mut self) {
        clear_thread_data_dir();
        let _ = fs::remove_dir_all(&self.workspace_root);
        let _ = fs::remove_dir_all(&self.data_dir);
    }
}
