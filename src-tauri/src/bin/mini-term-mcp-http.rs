fn main() {
    std::env::set_var("MINI_TERM_MCP_TRANSPORT", "http");
    if let Err(error) = tauri_app_lib::mcp::run_http_server() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
