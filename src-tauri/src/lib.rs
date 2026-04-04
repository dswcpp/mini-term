mod ai_sessions;
mod config;
mod fs;
mod git;
mod process_monitor;
mod pty;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .manage(pty::PtyManager::new())
        .manage(fs::FsWatcherManager::new())
        .setup(|app| {
            let pty_manager = app.state::<crate::pty::PtyManager>();
            let pty_clone = pty_manager.inner().clone();
            process_monitor::start_monitor(app.handle().clone(), pty_clone);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            config::load_config,
            config::save_config,
            pty::create_pty,
            pty::create_terminal_session,
            pty::write_pty,
            pty::write_terminal_input,
            pty::run_terminal_command,
            pty::resize_pty,
            pty::resize_terminal_session,
            pty::kill_pty,
            pty::close_terminal_session,
            pty::restart_terminal_session,
            pty::take_startup_output,
            pty::take_terminal_startup_output,
            fs::list_directory,
            fs::complete_path_entries,
            fs::watch_directory,
            fs::unwatch_directory,
            fs::create_file,
            fs::create_directory,
            fs::read_file_content,
            fs::write_text_file,
            fs::write_binary_file,
            ai_sessions::get_ai_sessions,
            git::get_git_status,
            git::get_git_diff,
            git::discover_git_repos,
            git::get_git_completion_data,
            git::get_git_log,
            git::get_commit_files,
            git::get_commit_file_diff,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
