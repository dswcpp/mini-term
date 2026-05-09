use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::PathBuf;

use tauri_app_lib::config::{
    config_path_for_data_dir, save_config_to_path, AppConfig, SavedPane, SavedProjectLayout,
    SavedSplitNode, SavedTab, SavedTerminalPane, WorkspaceConfig, WorkspaceRootConfig,
};

fn terminal_leaf(shell_name: &str) -> SavedSplitNode {
    SavedSplitNode::Leaf {
        pane: Some(SavedPane::Terminal(SavedTerminalPane {
            kind: None,
            shell_name: shell_name.to_string(),
            run_command: None,
            run_profile: None,
        })),
        panes: Vec::new(),
    }
}

fn main() -> Result<(), String> {
    let mut args = env::args().skip(1);
    let data_dir = PathBuf::from(
        args.next()
            .ok_or_else(|| "missing data dir argument".to_string())?,
    );
    let workspace_root = PathBuf::from(
        args.next()
            .ok_or_else(|| "missing workspace root argument".to_string())?,
    );

    fs::create_dir_all(&data_dir).map_err(|err| err.to_string())?;
    fs::create_dir_all(&workspace_root).map_err(|err| err.to_string())?;

    let workspace_path = workspace_root.to_string_lossy().to_string();
    let saved_layout = SavedProjectLayout {
        tabs: vec![
            SavedTab {
                custom_title: Some("Alpha".into()),
                split_layout: terminal_leaf("powershell"),
            },
            SavedTab {
                custom_title: None,
                split_layout: terminal_leaf("cmd"),
            },
        ],
        active_tab_index: 0,
    };

    let config = AppConfig {
        workspaces: vec![WorkspaceConfig {
            id: "workspace-1".into(),
            name: "desktop-smoke".into(),
            roots: vec![WorkspaceRootConfig {
                id: "root-1".into(),
                name: "desktop-smoke".into(),
                path: workspace_path,
                role: "primary".into(),
            }],
            pinned: true,
            accent: None,
            saved_layout: Some(saved_layout),
            expanded_dirs_by_root: BTreeMap::new(),
            created_at: 1,
            last_opened_at: 1,
        }],
        recent_workspaces: Vec::new(),
        last_workspace_id: Some("workspace-1".into()),
        ..AppConfig::default()
    };

    let config_path = config_path_for_data_dir(&data_dir);
    save_config_to_path(&config_path, config)?;
    println!("{}", config_path.display());
    Ok(())
}
