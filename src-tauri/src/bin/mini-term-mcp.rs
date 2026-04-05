fn main() {
    if let Err(error) = tauri_app_lib::mcp::run_stdio_server() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
