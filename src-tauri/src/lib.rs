mod agent_api;
mod agent_backend_runtime;
mod agent_backends;
pub mod agent_core;
mod agent_ext;
mod agent_policy;
mod agent_tool_broker;
mod ai_sessions;
mod config;
mod fs;
mod git;
mod host_control;
pub mod mcp;
mod mcp_host;
mod process_monitor;
mod pty;
pub mod reference_sidecar;
mod reference_sidecar_provider;
mod runtime_mcp;

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
            runtime_mcp::initialize_runtime_host(env!("CARGO_PKG_VERSION"))?;
            host_control::start_host_control_server(app.handle().clone())?;
            runtime_mcp::start_runtime_heartbeat(env!("CARGO_PKG_VERSION").to_string());
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
            fs::read_document_preview,
            fs::read_image_data_url,
            fs::read_binary_preview_base64,
            fs::write_text_file,
            fs::write_binary_file,
            ai_sessions::get_ai_sessions,
            agent_ext::session_import::list_external_sessions,
            agent_ext::session_import::get_external_session_messages,
            agent_ext::session_import::delete_external_session,
            git::get_git_status,
            git::get_git_diff,
            git::restore_git_file,
            git::restore_git_hunk,
            git::restore_git_change_block,
            git::discover_git_repos,
            git::get_git_completion_data,
            git::get_git_log,
            git::get_commit_files,
            git::get_commit_file_diff,
            git::get_file_git_history,
            git::get_file_git_blame,
            agent_api::list_agent_backends,
            agent_api::test_agent_backend_connection,
            agent_api::list_agent_workspaces,
            agent_api::get_agent_workspace_context,
            agent_api::list_agent_tasks,
            agent_api::get_agent_task_status,
            agent_api::list_attention_task_summaries,
            agent_api::list_approval_requests,
            agent_api::resolve_approval_request,
            agent_api::start_agent_task,
            agent_api::spawn_worker_agent_task,
            agent_api::send_agent_task_input,
            agent_api::close_agent_task,
            agent_api::resume_agent_task,
            agent_api::list_agent_task_events,
            agent_api::save_agent_task_plan,
            agent_api::list_agent_policy_profiles,
            agent_api::get_agent_policy_profile,
            agent_api::get_default_agent_policy_profile,
            agent_api::save_agent_policy_profile,
            agent_api::reset_agent_policy_profile,
            agent_api::export_agent_policy_bundle,
            agent_api::install_mcp_client_config_command,
            agent_api::get_task_injection_preview,
            agent_api::get_task_effective_policy,
            agent_api::get_embedded_mcp_launch_info,
            agent_api::list_embedded_mcp_tools_command,
            agent_api::call_embedded_mcp_tool_command,
            agent_api::list_external_mcp_servers_command,
            agent_api::sync_external_mcp_servers_command,
            host_control::resolve_host_control_request,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
