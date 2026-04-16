mod ai_sessions;
mod clipboard;
mod config;
mod editor;
mod fs;
mod git;
mod process_monitor;
mod pty;

use tauri::Manager;

#[cfg(windows)]
extern "system" {
    fn ReleaseCapture() -> i32;
    fn GetAsyncKeyState(v_key: i32) -> i16;
}

#[cfg(windows)]
const VK_LBUTTON: i32 = 0x01;

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
            clipboard::cleanup_old_clipboard_images();
            let pty_manager = app.state::<crate::pty::PtyManager>();
            let pty_clone = pty_manager.inner().clone();
            process_monitor::start_monitor(app.handle().clone(), pty_clone);
            Ok(())
        })
        .on_window_event(|_window, event| {
            // 窗口失焦时释放鼠标捕获，防止外部工具（截图等）与 WebView2
            // 事件处理冲突导致输入锁定。
            // 但若用户正按住左键发起 modal move/size loop（拖拽标题栏 /
            // 窗口边缘 resize），WebView2 子窗口会失焦触发该事件，此时
            // ReleaseCapture 会取消系统的鼠标捕获并立即终止 modal loop，
            // 表现为拖拽和 resize "光标变化但不生效"。
            // 因此左键按下时跳过释放，留给系统自然处理；松开时再释放。
            if let tauri::WindowEvent::Focused(false) = event {
                #[cfg(windows)]
                unsafe {
                    if (GetAsyncKeyState(VK_LBUTTON) as u16 & 0x8000) == 0 {
                        ReleaseCapture();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            config::load_config,
            config::save_config,
            pty::create_pty,
            pty::write_pty,
            pty::resize_pty,
            pty::kill_pty,
            fs::list_directory,
            fs::watch_directory,
            fs::unwatch_directory,
            fs::create_file,
            fs::create_directory,
            fs::read_file_content,
            fs::rename_entry,
            fs::filter_directories,
            ai_sessions::get_ai_sessions,
            git::get_git_status,
            git::get_git_diff,
            git::discover_git_repos,
            git::get_git_log,
            git::get_repo_branches,
            git::get_commit_files,
            git::get_commit_file_diff,
            git::git_pull,
            git::git_push,
            git::get_changes_status,
            git::git_stage,
            git::git_unstage,
            git::git_stage_all,
            git::git_unstage_all,
            git::git_commit,
            git::git_discard_file,
            editor::open_in_vscode,
            clipboard::read_clipboard_image,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
