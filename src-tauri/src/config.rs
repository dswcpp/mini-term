use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub projects: Vec<ProjectConfig>,
    pub default_shell: String,
    pub available_shells: Vec<ShellConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectConfig {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellConfig {
    pub name: String,
    pub command: String,
    pub args: Option<Vec<String>>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            projects: vec![],
            default_shell: default_shell_name(),
            available_shells: default_shells(),
        }
    }
}

#[cfg(target_os = "windows")]
fn default_shell_name() -> String { "cmd".into() }

#[cfg(target_os = "macos")]
fn default_shell_name() -> String { "zsh".into() }

#[cfg(target_os = "linux")]
fn default_shell_name() -> String { "bash".into() }

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn default_shell_name() -> String { "sh".into() }

#[cfg(target_os = "windows")]
fn default_shells() -> Vec<ShellConfig> {
    vec![
        ShellConfig { name: "cmd".into(), command: "cmd".into(), args: None },
        ShellConfig { name: "powershell".into(), command: "powershell".into(), args: None },
    ]
}

#[cfg(target_os = "macos")]
fn default_shells() -> Vec<ShellConfig> {
    vec![
        ShellConfig { name: "zsh".into(), command: "/bin/zsh".into(), args: Some(vec!["--login".into()]) },
        ShellConfig { name: "bash".into(), command: "/bin/bash".into(), args: Some(vec!["--login".into()]) },
    ]
}

#[cfg(target_os = "linux")]
fn default_shells() -> Vec<ShellConfig> {
    vec![
        ShellConfig { name: "bash".into(), command: "/bin/bash".into(), args: None },
        ShellConfig { name: "zsh".into(), command: "/usr/bin/zsh".into(), args: None },
        ShellConfig { name: "sh".into(), command: "/bin/sh".into(), args: None },
    ]
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn default_shells() -> Vec<ShellConfig> {
    vec![
        ShellConfig { name: "sh".into(), command: "/bin/sh".into(), args: None },
    ]
}

fn config_path(app: &AppHandle) -> PathBuf {
    let dir = app.path().app_data_dir().expect("failed to get app data dir");
    fs::create_dir_all(&dir).ok();
    dir.join("config.json")
}

#[tauri::command]
pub fn load_config(app: AppHandle) -> AppConfig {
    let path = config_path(&app);
    match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => AppConfig::default(),
    }
}

#[tauri::command]
pub fn save_config(app: AppHandle, config: AppConfig) -> Result<(), String> {
    let path = config_path(&app);
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_has_shells() {
        let config = AppConfig::default();
        assert!(!config.available_shells.is_empty());
        assert!(!config.default_shell.is_empty());
    }

    #[test]
    fn config_round_trip() {
        let config = AppConfig::default();
        let json = serde_json::to_string(&config).unwrap();
        let parsed: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.available_shells.len(), config.available_shells.len());
    }
}
