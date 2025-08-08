use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::collections::HashMap;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, Emitter};
use tauri_plugin_store::StoreExt;
use serde::{Deserialize, Serialize};
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc;

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
            window_width: 800,
            window_height: 600,
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
fn refresh_preview(app: AppHandle, window: String) -> Result<(), String> {
    if let Some(preview_window) = app.get_webview_window(&window) {
        preview_window.eval("refreshFile()").map_err(|e| format!("Failed to refresh preview: {}", e))?;
    }
    Ok(())
}

fn open_markdown_window(app: &AppHandle, file_path: Option<String>) -> Result<(), String> {
    let prefs = get_preferences(app.clone()).unwrap_or_default();
    
    let window_label = if file_path.is_some() {
        format!("markdown-{}", uuid::Uuid::new_v4())
    } else {
        "main".to_string()
    };
    
    let mut window_builder = WebviewWindowBuilder::new(
        app,
        &window_label,
        WebviewUrl::App("index.html".into())
    )
    .title(file_path.as_ref().map(|p| {
        PathBuf::from(p)
            .file_name()
            .map(|n| format!("MarkRust - {}", n.to_string_lossy()))
            .unwrap_or_else(|| "MarkRust".to_string())
    }).unwrap_or_else(|| "MarkRust".to_string()))
    .inner_size(prefs.window_width as f64, prefs.window_height as f64)
    ;
    
    if let Some(path) = file_path {
        window_builder = window_builder.initialization_script(&format!(
            "window.__INITIAL_FILE_PATH__ = {};",
            serde_json::to_string(&path).unwrap()
        ));
    }
    
    window_builder.build()
        .map_err(|e| format!("Failed to create window: {}", e))?;
    
    Ok(())
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
            get_opened_files,
            clear_opened_files
        ])
        .setup(move |app| {
            // Initialize file watchers state only (app state already managed)
            app.manage(FileWatchers::default());
            
            // Set up the menu
            let file_menu = SubmenuBuilder::new(app, "File")
                .item(&MenuItemBuilder::with_id("open", "Open").accelerator("CmdOrCtrl+O").build(app)?)
                .separator()
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
                    "open" => {
                        // Trigger open file in the active window
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.eval("openFile()");
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    "new-window" => {
                        // Open a new window without a file
                        let _ = open_markdown_window(&app, None);
                    }
                    "about" => {
                        // Show about dialog
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.eval("alert('MarkRust v0.1.0\\nA fast Markdown viewer and editor')");
                        }
                    }
                    _ => {}
                }
            });
            
            open_markdown_window(&app.handle(), file_path)?;
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
                    // Clean up file watcher for this window
                    let app = window.app_handle();
                    let _ = stop_file_watcher(app.clone(), window.label().to_string());
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Handle file opening from macOS Launch Services (Open With, double-click)
            if let tauri::RunEvent::Opened { urls } = event {
                // Safely access state with error handling
                if let Some(state) = app.try_state::<AppState>() {
                    if let Ok(mut opened_files) = state.opened_files.try_lock() {
                        *opened_files = urls.iter().map(|url| url.to_string()).collect();
                    }
                }
            }
        });
}
