use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::collections::HashMap;
use base64::Engine;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, Emitter};
use tauri_plugin_store::StoreExt;
use serde::{Deserialize, Serialize};
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc;
use url::Url;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};

// Convert file:// URL to filesystem path
fn file_url_to_path(s: &str) -> Option<PathBuf> {
    let url = Url::parse(s).ok()?;
    if url.scheme() == "file" {
        url.to_file_path().ok()
    } else {
        None
    }
}

// Resolve file path from various input formats (URLs, relative paths, absolute paths)
fn resolve_file_path(input: &str) -> Option<PathBuf> {
    // First try as file URL
    if let Some(path) = file_url_to_path(input) {
        return Some(path);
    }
    
    // Then try as regular path and convert to absolute
    let path = PathBuf::from(input);
    if path.is_absolute() {
        Some(path)
    } else {
        // Convert relative path to absolute
        std::env::current_dir().ok().map(|cwd| cwd.join(path))
    }
}

// Calculate appropriate window size with page-like proportions
fn calculate_window_size(app: &AppHandle, prefs: &AppPreferences) -> tauri::Result<(f64, f64)> {
    println!("[DEBUG] Current preferences: {}x{}", prefs.window_width, prefs.window_height);
    
    // If user has resized windows (preferences were saved), use those dimensions
    // Check if these are reasonable user-resized values (not corrupted massive values)
    if prefs.window_width > 200 && prefs.window_width < 5000 && 
       prefs.window_height > 200 && prefs.window_height < 5000 &&
       (prefs.window_width != 900 || prefs.window_height != 800) {
        println!("[DEBUG] Using saved custom window size: {}x{}", prefs.window_width, prefs.window_height);
        return Ok((prefs.window_width as f64, prefs.window_height as f64));
    }
    
    // Otherwise, calculate default page-like proportions using monitor size  
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let monitor_size = monitor.size();
        let scale_factor = monitor.scale_factor();
        
        // Convert physical pixels to logical pixels
        let logical_width = monitor_size.width as f64 / scale_factor;
        let logical_height = monitor_size.height as f64 / scale_factor;
        
        // Page-like proportions: reasonable reading width, full screen height
        let page_width = 900.0;
        let page_height = logical_height;
        
        println!("[DEBUG] Monitor size: {}x{} (scale: {}), Using calculated window size: {}x{}", 
                 logical_width, logical_height, scale_factor, page_width, page_height);
        
        Ok((page_width, page_height))
    } else {
        println!("[DEBUG] Could not get monitor info, using fallback");
        Ok((900.0, 800.0))
    }
}

// UNIFIED WINDOW CREATION - Single source of truth for all window creation
fn create_window_with_file(app: &AppHandle, file_path: Option<PathBuf>) -> tauri::Result<String> {
    println!("[DEBUG] create_window_with_file called with: {:?}", file_path);
    let prefs = get_preferences(app.clone()).unwrap_or_default();
    
    // Generate consistent window label and URL
    let (window_label, url, title) = if let Some(ref path) = file_path {
        // File window: use both querystring AND base64 label for compatibility
        let encoded_path = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(path.to_string_lossy().as_bytes());
        let label = format!("markdown-file-{}", encoded_path);
        // Use standard URI encoding compatible with JavaScript's decodeURIComponent
        let path_str = path.to_string_lossy().to_string();
        let encoded_query = urlencoding::encode(&path_str);
        // Tauri might not handle querystrings in App URLs correctly, so let's use the base64 label approach that was working
        let url = WebviewUrl::App("index.html".into());
        println!("[DEBUG] Using window label approach instead of querystring");
        let title = path.file_name()
            .and_then(|n| n.to_str())
            .map(|n| format!("MarkRust - {}", n))
            .unwrap_or_else(|| "MarkRust".to_string());
        println!("[DEBUG] File window - label: {}, url: {:?}, title: {}", label, url, title);
        (label, url, title)
    } else {
        // Empty window
        let label = format!("markdown-{}", uuid::Uuid::new_v4());
        let url = WebviewUrl::App("index.html".into());
        let title = "MarkRust".to_string();
        println!("[DEBUG] Empty window - label: {}, url: {:?}, title: {}", label, url, title);
        (label, url, title)
    };
    
    // Check if file window already exists and focus it instead
    if let Some(ref path) = file_path {
        let app_state = app.state::<AppState>();
        {
            if let Ok(open_windows) = app_state.open_windows.lock() {
                if let Some(existing_label) = open_windows.get(&path.to_string_lossy().to_string()) {
                    if let Some(window) = app.get_webview_window(existing_label) {
                        let _ = window.set_focus();
                        return Ok(existing_label.to_string());
                    }
                }
            };
        } // Lock dropped here
    }
    
    // Calculate appropriate window size (page-like proportions)
    let (width, height) = calculate_window_size(app, &prefs)?;
    
    // Create the window (hidden initially for file windows to prevent flash)
    let _window = WebviewWindowBuilder::new(app, &window_label, url)
        .title(&title)
        .inner_size(width, height)
        .visible(file_path.is_none()) // Only show empty windows immediately
        .build()?;
    
    // Track file windows
    if let Some(path) = file_path {
        let app_state = app.state::<AppState>();
        {
            if let Ok(mut open_windows) = app_state.open_windows.lock() {
                open_windows.insert(path.to_string_lossy().to_string(), window_label.clone());
            };
        } // Lock dropped here
    }
    
    Ok(window_label)
}

// Global file watchers storage
struct FileWatchers(Arc<Mutex<HashMap<String, RecommendedWatcher>>>);

impl Default for FileWatchers {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(HashMap::new())))
    }
}

// AppState for managing opened files from macOS Launch Services
#[derive(Default)]
struct AppState {
    opened_files: Arc<Mutex<Vec<String>>>,
    open_windows: Arc<Mutex<HashMap<String, String>>>, // file_path -> window_label
    setup_complete: Arc<Mutex<bool>>, // Track if setup is complete
}

#[derive(Debug, Serialize, Deserialize)]
struct AppPreferences {
    theme: String,
    window_width: u32,
    window_height: u32,
    font_size: Option<u16>,
    word_wrap: Option<bool>,
    show_line_numbers: Option<bool>,
}

impl Default for AppPreferences {
    fn default() -> Self {
        Self {
            theme: "system".to_string(),
            window_width: 900,  // Page-like width for reading
            window_height: 800, // Taller default height
            font_size: None,
            word_wrap: None,
            show_line_numbers: None,
        }
    }
}

#[tauri::command]
async fn start_file_watcher(app: AppHandle, file_path: String, window_label: String) -> Result<(), String> {
    let file_path_clone = file_path.clone();
    let window_label_clone = window_label.clone();
    
    // Create a channel for file events
    let (tx, mut rx) = mpsc::unbounded_channel();
    
    // Create the watcher
    let mut watcher = RecommendedWatcher::new(
        move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                if matches!(event.kind, notify::EventKind::Modify(_)) {
                    let _ = tx.send(());
                }
            }
        },
        Config::default(),
    ).map_err(|e| format!("Failed to create watcher: {}", e))?;
    
    // Watch the file
    watcher.watch(Path::new(&file_path_clone), RecursiveMode::NonRecursive)
        .map_err(|e| format!("Failed to watch file: {}", e))?;
    
    // Store the watcher
    let watchers = app.state::<FileWatchers>();
    watchers.0.lock().unwrap().insert(window_label_clone.clone(), watcher);
    
    // Spawn a task to handle file change events
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(_) = rx.recv().await {
            // Notify the window that the file has changed
            if let Some(window) = app_clone.get_webview_window(&window_label_clone) {
                let _ = window.emit("file-changed", ());
            }
        }
    });
    
    Ok(())
}

#[tauri::command]
fn stop_file_watcher(app: AppHandle, window_label: String) -> Result<(), String> {
    let watchers = app.state::<FileWatchers>();
    watchers.0.lock().unwrap().remove(&window_label);
    Ok(())
}

#[tauri::command]
fn broadcast_theme_change(app: AppHandle, theme: String) -> Result<(), String> {
    // Emit theme change event to all windows
    app.emit("theme-changed", &theme)
        .map_err(|e| format!("Failed to broadcast theme change: {}", e))?;
    Ok(())
}

#[tauri::command]
fn show_window(app: AppHandle, window_label: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&window_label) {
        window.show().map_err(|e| format!("Failed to show window: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
fn save_window_size(app: AppHandle, width: u32, height: u32) -> Result<(), String> {
    // Convert physical pixels to logical pixels to match our window creation logic
    let logical_size = if let Ok(Some(monitor)) = app.primary_monitor() {
        let scale_factor = monitor.scale_factor();
        let logical_width = (width as f64 / scale_factor).round() as u32;
        let logical_height = (height as f64 / scale_factor).round() as u32;
        println!("[DEBUG] Converting physical {}x{} to logical {}x{} (scale: {})", 
                 width, height, logical_width, logical_height, scale_factor);
        (logical_width, logical_height)
    } else {
        (width, height)
    };
    
    let mut prefs = get_preferences(app.clone()).unwrap_or_default();
    prefs.window_width = logical_size.0;
    prefs.window_height = logical_size.1;
    save_preferences(app, prefs)?;
    println!("[DEBUG] Saved new window size: {}x{}", logical_size.0, logical_size.1);
    Ok(())
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read file: {}", e))
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content)
        .map_err(|e| format!("Failed to write file: {}", e))
}

#[tauri::command]
fn parse_markdown(content: String) -> String {
    markrust_core::parse_markdown(&content)
}

#[tauri::command]
fn parse_markdown_with_theme(content: String, theme: String) -> String {
    markrust_core::parse_markdown_with_theme(&content, &theme)
}

#[tauri::command]
fn get_preferences(app: AppHandle) -> Result<AppPreferences, String> {
    let store = app.store(".markrust.dat")
        .map_err(|e| format!("Failed to access store: {}", e))?;
    
    let prefs = store.get("preferences")
        .and_then(|v| serde_json::from_value::<AppPreferences>(v.clone()).ok())
        .unwrap_or_default();
    
    Ok(prefs)
}

#[tauri::command]
fn save_preferences(app: AppHandle, preferences: AppPreferences) -> Result<(), String> {
    let store = app.store(".markrust.dat")
        .map_err(|e| format!("Failed to access store: {}", e))?;
    
    store.set("preferences", serde_json::to_value(&preferences).unwrap());
    store.save().map_err(|e| format!("Failed to save preferences: {}", e))?;
    
    Ok(())
}

#[tauri::command]
async fn open_file_dialog(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    
    let file_path = app.dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown"])
        .blocking_pick_file();
    
    Ok(file_path.map(|p| p.to_string()))
}

#[tauri::command]
async fn open_editor_window(app: AppHandle, file_path: String, preview_window: String) -> Result<(), String> {
    let editor_label = format!("editor-{}", uuid::Uuid::new_v4());
    
    let _editor_window = WebviewWindowBuilder::new(
        &app,
        &editor_label,
        WebviewUrl::App("editor.html".into())
    )
    .title(format!("MarkRust Editor - {}", file_path.split('/').last().unwrap_or("Untitled")))
    .inner_size(800.0, 600.0)
    .initialization_script(&format!(
        "window.__INITIAL_FILE_PATH__ = {}; window.__PREVIEW_WINDOW__ = {};",
        serde_json::to_string(&file_path).unwrap(),
        serde_json::to_string(&preview_window).unwrap()
    ))
    .build()
    .map_err(|e| format!("Failed to create editor window: {}", e))?;
    
    Ok(())
}


#[tauri::command]
fn get_opened_files(app: AppHandle) -> Result<Vec<String>, String> {
    let state = app.state::<AppState>();
    let opened_files = state.opened_files.lock()
        .map_err(|e| format!("Failed to lock opened files: {}", e))?;
    
    // Convert file:// URLs to file paths
    let file_paths: Vec<String> = opened_files
        .iter()
        .map(|url| url.replace("file://", ""))
        .collect();
    
    Ok(file_paths)
}

#[tauri::command]
fn clear_opened_files(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut opened_files = state.opened_files.lock()
        .map_err(|e| format!("Failed to lock opened files: {}", e))?;
    opened_files.clear();
    Ok(())
}

#[tauri::command]
fn create_new_window_command(app: AppHandle, file_path: Option<String>) -> Result<String, String> {
    let resolved_path = file_path.and_then(|p| resolve_file_path(&p));
    create_window_with_file(&app, resolved_path)
        .map_err(|e| format!("Failed to create window: {}", e))
}

#[tauri::command]
fn remove_window_from_tracking(app: AppHandle, window_label: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut open_windows = state.open_windows.lock()
        .map_err(|e| format!("Failed to lock open windows: {}", e))?;
    
    // Find and remove the window by label
    open_windows.retain(|_, label| label != &window_label);
    Ok(())
}

#[tauri::command]
fn refresh_preview(app: AppHandle, window: String) -> Result<(), String> {
    if let Some(preview_window) = app.get_webview_window(&window) {
        preview_window.eval("refreshFile()").map_err(|e| format!("Failed to refresh preview: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
fn debug_dump_state(app: AppHandle) -> Result<String, String> {
    let state = app.state::<AppState>();
    let opened_files = state.opened_files.lock()
        .map_err(|e| format!("Failed to lock opened files: {}", e))?;
    let open_windows = state.open_windows.lock()
        .map_err(|e| format!("Failed to lock open windows: {}", e))?;
    let setup_complete = state.setup_complete.lock()
        .map_err(|e| format!("Failed to lock setup_complete: {}", e))?;
    
    let debug_info = format!(
        "AppState Debug:\n- setup_complete: {}\n- opened_files: {:?}\n- open_windows: {:?}",
        *setup_complete, *opened_files, *open_windows
    );
    
    println!("[RUST DEBUG] State dump: {}", debug_info);
    Ok(debug_info)
}

#[tauri::command]
fn get_file_path_from_window_label(window: tauri::Window) -> Result<Option<String>, String> {
    let window_label = window.label();
    
    // Check if this is a file window (starts with "markdown-file-")
    if let Some(encoded_path) = window_label.strip_prefix("markdown-file-") {
        match base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(encoded_path) {
            Ok(decoded_bytes) => {
                match String::from_utf8(decoded_bytes) {
                    Ok(file_path) => {
                        println!("[RUST DEBUG] Decoded file path from window label: {}", file_path);
                        Ok(Some(file_path))
                    }
                    Err(e) => Err(format!("Failed to decode UTF-8: {}", e))
                }
            }
            Err(e) => Err(format!("Failed to decode base64: {}", e))
        }
    } else {
        // Not a file window, return None
        Ok(None)
    }
}


fn open_markdown_window(app: &AppHandle, file_path: Option<String>) -> Result<(), String> {
    let resolved_path = file_path.and_then(|p| resolve_file_path(&p));
    create_window_with_file(app, resolved_path)
        .map_err(|e| format!("Failed to create window: {}", e))
        .map(|_| ()) // Convert Result<String, String> to Result<(), String>
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    let file_path = args.get(1).cloned();
    
    // Initialize app state before building to avoid race condition
    let app_state = AppState::default();
    
    tauri::Builder::default()
        .manage(app_state)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            parse_markdown,
            parse_markdown_with_theme,
            get_preferences,
            save_preferences,
            open_file_dialog,
            open_editor_window,
            refresh_preview,
            start_file_watcher,
            stop_file_watcher,
            broadcast_theme_change,
            show_window,
            save_window_size,
            get_opened_files,
            clear_opened_files,
            create_new_window_command,
            remove_window_from_tracking,
            debug_dump_state,
            get_file_path_from_window_label
        ])
        .setup(move |app| {
            // Initialize file watchers state only (app state already managed)
            app.manage(FileWatchers::default());
            
            // Set up the menu
            let file_menu = SubmenuBuilder::new(app, "File")
                .item(&MenuItemBuilder::with_id("new-window", "New Window").accelerator("CmdOrCtrl+N").build(app)?)
                .item(&MenuItemBuilder::with_id("open", "Open").accelerator("CmdOrCtrl+O").build(app)?)
                .separator()
                .item(&MenuItemBuilder::with_id("close", "Close Window").accelerator("CmdOrCtrl+W").build(app)?)
                .item(&MenuItemBuilder::with_id("quit", "Quit").accelerator("CmdOrCtrl+Q").build(app)?)
                .build()?;
            
            let window_menu = SubmenuBuilder::new(app, "Window")
                .item(&MenuItemBuilder::with_id("new-window", "New Window").accelerator("CmdOrCtrl+N").build(app)?)
                .build()?;
            
            let help_menu = SubmenuBuilder::new(app, "Help")
                .item(&MenuItemBuilder::with_id("about", "About MarkRust").build(app)?)
                .build()?;
            
            let menu = MenuBuilder::new(app)
                .item(&file_menu)
                .item(&window_menu)
                .item(&help_menu)
                .build()?;
            
            app.set_menu(menu)?;
            
            // Handle menu events
            app.on_menu_event(|app, event| {
                match event.id().as_ref() {
                    "new-window" => {
                        // Create a new empty window
                        let _ = create_new_window_command(app.clone(), None);
                    }
                    "open" => {
                        // Create a new window and trigger open file dialog
                        if let Ok(_) = create_new_window_command(app.clone(), None) {
                            // The new window will handle the open file dialog
                        }
                    }
                    "close" => {
                        // This will be handled by the window's menu directly
                        // Individual windows handle their own close events
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    "about" => {
                        // Show about dialog - try to find any active window
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.eval("alert('MarkRust v0.1.0\\nA fast Markdown viewer and editor')");
                        } else {
                            // Try to find any window if main doesn't exist
                            for (_, window) in app.webview_windows() {
                                let _ = window.eval("alert('MarkRust v0.1.0\\nA fast Markdown viewer and editor')");
                                break;
                            }
                        }
                    }
                    _ => {}
                }
            });
            
            // Always create initial window - RunEvent::Opened handles additional files
            // For CLI args, open the specified file; otherwise create empty window
            open_markdown_window(&app.handle(), file_path)?;
            
            // Mark setup as complete
            let state = app.state::<AppState>();
            if let Ok(mut setup_complete) = state.setup_complete.lock() {
                *setup_complete = true;
            }
            
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::Resized(size) => {
                    let app = window.app_handle();
                    if let Ok(mut prefs) = get_preferences(app.clone()) {
                        prefs.window_width = size.width;
                        prefs.window_height = size.height;
                        let _ = save_preferences(app.clone(), prefs);
                    }
                }
                tauri::WindowEvent::CloseRequested { .. } => {
                    // Clean up file watcher and window tracking
                    let app = window.app_handle();
                    let window_label = window.label().to_string();
                    let _ = stop_file_watcher(app.clone(), window_label.clone());
                    let _ = remove_window_from_tracking(app.clone(), window_label);
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Handle file opening from macOS Launch Services (Open With, double-click)
            if let tauri::RunEvent::Opened { urls } = event {
                // Only create windows if setup is complete, otherwise store for later
                if let Some(state) = app.try_state::<AppState>() {
                    if let Ok(setup_complete) = state.setup_complete.try_lock() {
                        if *setup_complete {
                            // Setup complete - create windows immediately
                            drop(setup_complete); // Release lock before creating windows
                            for url in urls {
                                if let Some(path) = resolve_file_path(&url.to_string()) {
                                    if let Err(e) = create_window_with_file(&app, Some(path.clone())) {
                                        eprintln!("Failed to open window for {:?}: {}", path, e);
                                    }
                                } else {
                                    eprintln!("Ignored non-file URL: {}", url);
                                }
                            }
                        } else {
                            // Setup not complete - store files for later processing
                            drop(setup_complete);
                            if let Ok(mut opened_files) = state.opened_files.try_lock() {
                                *opened_files = urls.iter().map(|url| url.to_string()).collect();
                            }
                        }
                    }
                }
            }
        });
}
