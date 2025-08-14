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
// Simple debug macro to strip logs in release
macro_rules! debug_log {
    ($($arg:tt)*) => {
        #[cfg(debug_assertions)]
        {
            println!($($arg)*);
        }
    }
}
// removed unused percent_encoding imports
use tokio::time::{sleep, Duration};

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
    debug_log!("[DEBUG] Current preferences: {}x{}", prefs.window_width, prefs.window_height);
    
    // If user has resized windows (preferences were saved), use those dimensions
    // Check if these are reasonable user-resized values (not corrupted massive values)
    if prefs.window_width > 200 && prefs.window_width < 5000 && 
       prefs.window_height > 200 && prefs.window_height < 5000 &&
       (prefs.window_width != 900 || prefs.window_height != 800) {
        debug_log!("[DEBUG] Using saved custom window size: {}x{}", prefs.window_width, prefs.window_height);
        return Ok((prefs.window_width as f64, prefs.window_height as f64));
    }
    
    // Otherwise, calculate default page-like proportions using monitor size  
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let monitor_size = monitor.size();
        let scale_factor = monitor.scale_factor();
        
        // Convert physical pixels to logical pixels
        let _logical_width = monitor_size.width as f64 / scale_factor;
        let logical_height = monitor_size.height as f64 / scale_factor;
        
        // Page-like proportions: reasonable reading width, full screen height
        let page_width = 900.0;
        let page_height = logical_height;
        
        debug_log!("[DEBUG] Monitor size: {}x{} (scale: {}), Using calculated window size: {}x{}", 
                 _logical_width, logical_height, scale_factor, page_width, page_height);
        
        Ok((page_width, page_height))
    } else {
        debug_log!("[DEBUG] Could not get monitor info, using fallback");
        Ok((900.0, 800.0))
    }
}

// UNIFIED WINDOW CREATION - Single source of truth for all window creation
fn create_window_with_file(app: &AppHandle, file_path: Option<PathBuf>) -> tauri::Result<String> {
    debug_log!("[DEBUG] create_window_with_file called with: {:?}", file_path);
    let prefs = get_preferences(app.clone()).unwrap_or_default();
    
    // Generate consistent window label and URL
    let (window_label, url, title) = if let Some(ref path) = file_path {
        // File window: use both querystring AND base64 label for compatibility
        let encoded_path = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(path.to_string_lossy().as_bytes());
        let label = format!("markdown-file-{}", encoded_path);
        // Use standard URI encoding compatible with JavaScript's decodeURIComponent
        // Reserve: available string path if needed for future query encoding
        // Tauri might not handle querystrings in App URLs correctly, so let's use the base64 label approach that was working
        let url = WebviewUrl::App("index.html".into());
        debug_log!("[DEBUG] Using window label approach instead of querystring");
        let title = path.file_name()
            .and_then(|n| n.to_str())
            .map(|n| format!("BoltPage - {}", n))
            .unwrap_or_else(|| "BoltPage".to_string());
        debug_log!("[DEBUG] File window - label: {}, url: {:?}, title: {}", label, url, title);
        (label, url, title)
    } else {
        // Empty window
        let label = format!("markdown-{}", uuid::Uuid::new_v4());
        let url = WebviewUrl::App("index.html".into());
        let title = "BoltPage".to_string();
        debug_log!("[DEBUG] Empty window - label: {}, url: {:?}, title: {}", label, url, title);
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

// Global file watchers storage with dedup by file path and debounced emits
struct FileWatchers {
    // One OS watcher per file path
    watchers: Arc<Mutex<HashMap<String, RecommendedWatcher>>>,
    // Sender per file path to notify async task
    senders: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<()>>>>,
    // Debounce task per file path
    debounce_tasks: Arc<Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>>,
    // Subscriptions: file path -> list of window labels
    subs: Arc<Mutex<HashMap<String, Vec<String>>>>,
}

impl Default for FileWatchers {
    fn default() -> Self {
        Self {
            watchers: Arc::new(Mutex::new(HashMap::new())),
            senders: Arc::new(Mutex::new(HashMap::new())),
            debounce_tasks: Arc::new(Mutex::new(HashMap::new())),
            subs: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

// AppState for managing opened files from macOS Launch Services
#[derive(Default)]
struct AppState {
    opened_files: Arc<Mutex<Vec<String>>>,
    open_windows: Arc<Mutex<HashMap<String, String>>>, // file_path -> window_label
    setup_complete: Arc<Mutex<bool>>, // Track if setup is complete
    // Debounced window resize save tasks per window label
    resize_tasks: Arc<Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>>,
    // Latest logical sizes per window label
    latest_sizes: Arc<Mutex<HashMap<String, (u32, u32)>>>,
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
    let watchers = app.state::<FileWatchers>();

    // Register subscription
    {
        let mut subs = watchers.subs.lock().map_err(|e| e.to_string())?;
        let entry = subs.entry(file_path.clone()).or_default();
        if !entry.iter().any(|w| w == &window_label) {
            entry.push(window_label.clone());
        }
    }

    // Ensure a single watcher exists for this file path
    let need_create = {
        let map = watchers.watchers.lock().map_err(|e| e.to_string())?;
        !map.contains_key(&file_path)
    };

    if need_create {
        // Channel for raw events
        let (tx, mut rx) = mpsc::unbounded_channel();

        // Create the watcher
        let tx_for_watcher = tx.clone();
        let mut watcher = RecommendedWatcher::new(
            move |res: Result<notify::Event, notify::Error>| {
                if let Ok(event) = res {
                    if matches!(event.kind, notify::EventKind::Modify(_)) {
                        let _ = tx_for_watcher.send(());
                    }
                }
            },
            Config::default(),
        ).map_err(|e| format!("Failed to create watcher: {}", e))?;

        // Watch the file
        watcher.watch(Path::new(&file_path), RecursiveMode::NonRecursive)
            .map_err(|e| format!("Failed to watch file: {}", e))?;

        // Store watcher and sender
        watchers.watchers.lock().map_err(|e| e.to_string())?.insert(file_path.clone(), watcher);
        watchers.senders.lock().map_err(|e| e.to_string())?.insert(file_path.clone(), tx);

        // Spawn a debounced notifier for this file path
        let app_clone = app.clone();
        let file_key = file_path.clone();
        let handle = tauri::async_runtime::spawn(async move {
            let mut pending_task: Option<tauri::async_runtime::JoinHandle<()>> = None;
            while let Some(_) = rx.recv().await {
                // Reset debounce timer
                if let Some(h) = pending_task.take() { h.abort(); }
                let app2 = app_clone.clone();
                let file2 = file_key.clone();
                pending_task = Some(tauri::async_runtime::spawn(async move {
                    sleep(Duration::from_millis(250)).await;
                    if let Some(state) = app2.try_state::<FileWatchers>() {
                        if let Ok(subs) = state.subs.lock() {
                            if let Some(labels) = subs.get(&file2) {
                                for label in labels.iter() {
                                    if let Some(win) = app2.get_webview_window(label) {
                                        let _ = win.emit("file-changed", ());
                                    }
                                }
                            }
                        }
                    }
                }));
            }
        });
        watchers.debounce_tasks.lock().map_err(|e| e.to_string())?.insert(file_path.clone(), handle);
    }

    Ok(())
}

#[tauri::command]
fn stop_file_watcher(app: AppHandle, window_label: String) -> Result<(), String> {
    let watchers = app.state::<FileWatchers>();
    // Remove the window from all subscriptions and clean up any orphaned watchers
    let mut to_remove: Vec<String> = Vec::new();
    {
        let mut subs = watchers.subs.lock().map_err(|e| e.to_string())?;
        for (file, labels) in subs.iter_mut() {
            labels.retain(|l| l != &window_label);
            if labels.is_empty() {
                to_remove.push(file.clone());
            }
        }
        // Actually remove empty entries
        for f in to_remove.iter() { subs.remove(f); }
    }

    // Stop watchers for files with no subscribers
    for f in to_remove.iter() {
        if let Ok(mut map) = watchers.watchers.lock() { map.remove(f); }
        if let Ok(mut txs) = watchers.senders.lock() { txs.remove(f); }
        if let Ok(mut tasks) = watchers.debounce_tasks.lock() {
            if let Some(h) = tasks.remove(f) { h.abort(); }
        }
    }

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
fn broadcast_scroll_link(app: AppHandle, enabled: bool) -> Result<(), String> {
    app.emit("scroll-link-changed", &enabled)
        .map_err(|e| format!("Failed to broadcast scroll-link: {}", e))?;
    Ok(())
}

#[tauri::command]
fn show_window(app: AppHandle, window_label: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&window_label) {
        window.show().map_err(|e| format!("Failed to show window: {}", e))?;
    }
    Ok(())
}

// save_window_size kept for compatibility but now unused on the JS side.
#[tauri::command]
fn save_window_size(app: AppHandle, width: u32, height: u32) -> Result<(), String> {
    let (lw, lh) = convert_to_logical(&app, width, height);
    let mut prefs = get_preferences(app.clone()).unwrap_or_default();
    prefs.window_width = lw;
    prefs.window_height = lh;
    save_preferences(app, prefs)?;
    debug_log!("Saved new window size: {}x{}", lw, lh);
    Ok(())
}

fn convert_to_logical(app: &AppHandle, width: u32, height: u32) -> (u32, u32) {
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let scale_factor = monitor.scale_factor();
        let logical_width = (width as f64 / scale_factor).round() as u32;
        let logical_height = (height as f64 / scale_factor).round() as u32;
        debug_log!(
            "Converting physical {}x{} to logical {}x{} (scale: {})",
            width, height, logical_width, logical_height, scale_factor
        );
        (logical_width, logical_height)
    } else {
        (width, height)
    }
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
fn is_writable(path: String) -> Result<bool, String> {
    match fs::metadata(&path) {
        Ok(meta) => Ok(!meta.permissions().readonly()),
        Err(e) => Err(format!("Failed to get metadata: {}", e)),
    }
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
fn parse_json_with_theme(content: String, theme: String) -> Result<String, String> {
    markrust_core::parse_json_with_theme(&content, &theme)
}

#[tauri::command]
fn format_json_pretty(content: String) -> Result<String, String> {
    // Pretty-print JSON using serde_json with default map ordering (sorted keys)
    let value: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Invalid JSON: {}", e))?;
    serde_json::to_string_pretty(&value).map_err(|e| format!("Failed to pretty-print JSON: {}", e))
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ScrollSyncPayload {
    source: String,
    file_path: String,
    kind: String,              // e.g., "json", "markdown", "txt"
    line: Option<u32>,         // topmost line (1-based) when applicable
    percent: Option<f64>,      // fallback scroll percent [0.0, 1.0]
}

#[tauri::command]
fn broadcast_scroll_sync(app: AppHandle, payload: ScrollSyncPayload) -> Result<(), String> {
    app.emit("scroll-sync", &payload)
        .map_err(|e| format!("Failed to broadcast scroll sync: {}", e))
}

#[tauri::command]
fn get_syntax_css(theme: String) -> Result<String, String> {
    markrust_core::get_syntax_theme_css(&theme).ok_or_else(|| "Failed to generate syntax CSS".to_string())
}

#[tauri::command]
fn get_preferences(app: AppHandle) -> Result<AppPreferences, String> {
    let store = app.store(".boltpage.dat")
        .map_err(|e| format!("Failed to access store: {}", e))?;
    
    let prefs = store.get("preferences")
        .and_then(|v| serde_json::from_value::<AppPreferences>(v.clone()).ok())
        .unwrap_or_default();
    
    Ok(prefs)
}

#[tauri::command]
fn save_preferences(app: AppHandle, preferences: AppPreferences) -> Result<(), String> {
    let store = app.store(".boltpage.dat")
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
        // Show a combined filter first for convenience
        .add_filter("Supported", &["md", "markdown", "json", "txt"])
        // Specific filters
        .add_filter("Markdown", &["md", "markdown"])
        .add_filter("JSON", &["json"])
        .add_filter("Text", &["txt"])
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
    .title(format!("BoltPage Editor - {}", file_path.split('/').last().unwrap_or("Untitled")))
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
    
    debug_log!("[RUST DEBUG] State dump: {}", debug_info);
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
                        debug_log!("[RUST DEBUG] Decoded file path from window label: {}", file_path);
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
            is_writable,
            parse_markdown,
            parse_markdown_with_theme,
            parse_json_with_theme,
            format_json_pretty,
            broadcast_scroll_sync,
            get_preferences,
            save_preferences,
            open_file_dialog,
            open_editor_window,
            refresh_preview,
            start_file_watcher,
            stop_file_watcher,
            broadcast_theme_change,
            broadcast_scroll_link,
            show_window,
            save_window_size,
            get_opened_files,
            clear_opened_files,
            create_new_window_command,
            remove_window_from_tracking,
            debug_dump_state,
            get_file_path_from_window_label,
            get_syntax_css
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
                .item(&MenuItemBuilder::with_id("about", "About BoltPage").build(app)?)
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
                            let _ = window.eval("alert('BoltPage v0.1.0\\nA fast Markdown viewer and editor')");
                        } else {
                            // Try to find any window if main doesn't exist
                            for (_, window) in app.webview_windows() {
                                let _ = window.eval("alert('BoltPage v0.1.0\\nA fast Markdown viewer and editor')");
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
                    // Debounce saves on the Rust side and convert to logical pixels
                    let app = window.app_handle();
                    let label = window.label().to_string();
                    let (lw, lh) = convert_to_logical(&app, size.width, size.height);

                    // update latest size
                    if let Some(state) = app.try_state::<AppState>() {
                        if let Ok(mut latest) = state.latest_sizes.lock() {
                            latest.insert(label.clone(), (lw, lh));
                        }
                        // cancel previous task if any
                        if let Ok(mut tasks) = state.resize_tasks.lock() {
                            if let Some(handle) = tasks.remove(&label) {
                                handle.abort();
                            }
                            let app_clone = app.clone();
                            let label_clone = label.clone();
                            let handle = tauri::async_runtime::spawn(async move {
                                sleep(Duration::from_millis(450)).await;
                                if let Some(state2) = app_clone.try_state::<AppState>() {
                                    if let Ok(latest2) = state2.latest_sizes.lock() {
                                        if let Some((w, h)) = latest2.get(&label_clone) {
                                            let mut prefs = get_preferences(app_clone.clone()).unwrap_or_default();
                                            prefs.window_width = *w;
                                            prefs.window_height = *h;
                                            let _ = save_preferences(app_clone.clone(), prefs);
                                            debug_log!("Debounced save window size: {}x{} for {}", w, h, label_clone);
                                        }
                                    }
                                }
                            });
                            tasks.insert(label, handle);
                        }
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
        .run(|_app, _event| {
            // Handle file opening via Launch Services only on Apple platforms
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = _event {
                if let Some(state) = _app.try_state::<AppState>() {
                    if let Ok(setup_complete) = state.setup_complete.try_lock() {
                        if *setup_complete {
                            drop(setup_complete);
                            for url in urls {
                                if let Some(path) = resolve_file_path(&url.to_string()) {
                                    if let Err(e) = create_window_with_file(&_app, Some(path.clone())) {
                                        eprintln!("Failed to open window for {:?}: {}", path, e);
                                    }
                                } else {
                                    eprintln!("Ignored non-file URL: {}", url);
                                }
                            }
                        } else {
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
