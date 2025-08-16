// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;

fn main() {
    let args: Vec<String> = env::args().collect();
    
    // Handle help and version flags only if arguments are provided
    if args.len() > 1 {
        match args[1].as_str() {
            "-h" | "--help" => {
                println!("BoltPage - Fast Markdown viewer and editor");
                println!();
                println!("USAGE:");
                println!("    boltpage [FILE]");
                println!();
                println!("OPTIONS:");
                println!("    -h, --help       Print help information");
                println!("    -v, --version    Print version information");
                println!();
                println!("EXAMPLES:");
                println!("    boltpage README.md     Open README.md in BoltPage");
                println!("    boltpage               Launch BoltPage without opening a file");
                return;
            }
            "-v" | "--version" => {
                println!("BoltPage 1.0.0");
                return;
            }
            _ => {}
        }
    }
    
    // Launch the Tauri application (with or without file argument)
    markrust_lib::run();
}
