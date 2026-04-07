fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("mini-term-claude-sidecar");
        println!("Repository-local reference sidecar for Mini-Term's claude-sidecar backend.");
        println!();
        println!("Usage:");
        println!("  mini-term-claude-sidecar");
        println!();
        println!("This binary is meant to be launched by Mini-Term over stdio.");
        println!("Interactive commands are sent from Mini-Term task input after startup.");
        return;
    }

    if let Err(error) = tauri_app_lib::reference_sidecar::run_stdio_reference_sidecar() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
