use base64::Engine;
use lru::LruCache;
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_store::StoreExt;
use tokio::sync::{mpsc, Mutex, RwLock};
use tokio::time::{sleep, Duration};
use url::Url;

// Conditional debug logging (only in debug builds)
#[cfg(debug_assertions)]
macro_rules! debug_log {
    ($($arg:tt)*) => {
        eprintln!($($arg)*);
    };
}

#[cfg(not(debug_assertions))]
macro_rules! debug_log {
    ($($arg:tt)*) => {};
}

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
    // If user has resized windows (preferences were saved), use those dimensions
    // Check if these are reasonable user-resized values (not corrupted massive values)
    if prefs.window_width > 200
        && prefs.window_width < 5000
        && prefs.window_height > 200
        && prefs.window_height < 5000
        && (prefs.window_width != 900 || prefs.window_height != 800)
    {
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

        debug_log!(
            "[DEBUG] Monitor size: {}x{} (scale: {}), Using calculated window size: {}x{}",
            _logical_width,
            logical_height,
            scale_factor,
            page_width,
            page_height
        );

        Ok((page_width, page_height))
    } else {
        Ok((900.0, 800.0))
    }
}

// UNIFIED WINDOW CREATION - Single source of truth for all window creation
async fn create_window_with_file(
    app: &AppHandle,
    file_path: Option<PathBuf>,
) -> tauri::Result<String> {
    let prefs = get_preferences(app.clone()).unwrap_or_default();

    // Generate consistent window label and URL
    let (window_label, url, title) = if let Some(ref path) = file_path {
        let encoded_path = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(path.to_string_lossy().as_bytes());
        let label = format!("markdown-file-{}", encoded_path);
        let url = WebviewUrl::App("index.html".into());
        let title = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| format!("BoltPage - {}", n))
            .unwrap_or_else(|| "BoltPage".to_string());
        (label, url, title)
    } else {
        let label = format!("markdown-{}", uuid::Uuid::new_v4());
        let url = WebviewUrl::App("index.html".into());
        let title = "BoltPage".to_string();
        (label, url, title)
    };

    // Check if file window already exists and focus it instead
    if let Some(ref path) = file_path {
        let app_state = app.state::<AppState>();
        let open_windows = app_state.open_windows.read().await;
        if let Some(existing_label) = open_windows.get(&path.to_string_lossy().to_string()) {
            if let Some(window) = app.get_webview_window(existing_label) {
                let _ = window.set_focus();
                return Ok(existing_label.to_string());
            }
        }
        drop(open_windows); // Explicitly release read lock
    }

    // Calculate appropriate window size (page-like proportions)
    let (width, height) = calculate_window_size(app, &prefs)?;

    // Create the window (hidden initially for file windows to prevent flash)
    let _window = WebviewWindowBuilder::new(app, &window_label, url)
        .title(&title)
        .inner_size(width, height)
        .visible(file_path.is_none()) // Only show empty windows immediately
        .build()?;

    // Rebuild the application menu to include this window in the Window menu
    let _ = rebuild_app_menu(app);

    // Track file windows
    if let Some(path) = file_path {
        let app_state = app.state::<AppState>();
        let mut open_windows = app_state.open_windows.write().await;
        open_windows.insert(path.to_string_lossy().to_string(), window_label.clone());
    }

    Ok(window_label)
}

// Rebuild the native application menu, including a dynamic Window submenu
fn rebuild_app_menu(app: &AppHandle) -> tauri::Result<()> {
    // File menu
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(
            &MenuItemBuilder::with_id("new-file", "New File")
                .accelerator("CmdOrCtrl+N")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("new-window", "New Window")
                .accelerator("CmdOrCtrl+Shift+N")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("open", "Open")
                .accelerator("CmdOrCtrl+O")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("print", "Print")
                .accelerator("CmdOrCtrl+P")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("close", "Close Window")
                .accelerator("CmdOrCtrl+W")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("quit", "Quit")
                .accelerator("CmdOrCtrl+Q")
                .build(app)?,
        )
        .build()?;

    // Edit menu (native accelerators for copy/paste/etc.)
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(
            &MenuItemBuilder::with_id("undo", "Undo")
                .accelerator("CmdOrCtrl+Z")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("redo", "Redo")
                .accelerator("Shift+CmdOrCtrl+Z")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("cut", "Cut")
                .accelerator("CmdOrCtrl+X")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("copy", "Copy")
                .accelerator("CmdOrCtrl+C")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("paste", "Paste")
                .accelerator("CmdOrCtrl+V")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("select-all", "Select All")
                .accelerator("CmdOrCtrl+A")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("find", "Find...")
                .accelerator("CmdOrCtrl+F")
                .build(app)?,
        )
        .build()?;

    // Window menu (dynamic list of open windows)
    let mut window_menu_builder = SubmenuBuilder::new(app, "Window")
        .item(
            &MenuItemBuilder::with_id("new-window", "New Window")
                .accelerator("CmdOrCtrl+Shift+N")
                .build(app)?,
        )
        .separator();

    for (label, window) in app.webview_windows() {
        let title = window.title().unwrap_or_else(|_| "Untitled".to_string());
        let window_id = format!("window-{}", label);
        window_menu_builder =
            window_menu_builder.item(&MenuItemBuilder::with_id(&window_id, &title).build(app)?);
    }
    let window_menu = window_menu_builder.build()?;

    // Help menu
    let help_menu = SubmenuBuilder::new(app, "Help")
        .item(&MenuItemBuilder::with_id("about", "About BoltPage").build(app)?)
        .build()?;

    // Build and set the menu
    let menu = MenuBuilder::new(app)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&window_menu)
        .item(&help_menu)
        .build()?;
    app.set_menu(menu)?;
    Ok(())
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

/// Type alias for resize task map to reduce complexity
type ResizeTaskMap = HashMap<String, (tauri::async_runtime::JoinHandle<()>, u32, u32)>;

/// Application state with optimized concurrency patterns
///
/// Uses RwLock for read-heavy operations (open_windows, html_cache)
/// Uses Mutex only where writes are frequent or exclusive access needed
struct AppState {
    /// Maps file_path -> window_label for tracking open windows
    /// Read-heavy workload (many lookups, few inserts/removes)
    open_windows: Arc<RwLock<HashMap<String, String>>>,

    /// Debounced resize tasks per window label
    /// Writes on every resize event, so Mutex is appropriate
    resize_tasks: Arc<Mutex<ResizeTaskMap>>,

    /// HTML render cache: (path, size, mtime_secs, theme) -> HTML
    /// Read-heavy workload with LRU eviction
    html_cache: Arc<RwLock<LruCache<CacheKey, String>>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            open_windows: Arc::new(RwLock::new(HashMap::new())),
            resize_tasks: Arc::new(Mutex::new(HashMap::new())),
            html_cache: Arc::new(RwLock::new(LruCache::new(NonZeroUsize::new(50).unwrap()))),
        }
    }
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

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct CacheKey {
    path: String,
    size: u64,
    mtime_secs: u64,
    theme: String,
}

async fn invalidate_cache_for_path(app: &AppHandle, file_path: &str) {
    if let Some(state) = app.try_state::<AppState>() {
        let mut cache = state.html_cache.write().await;
        // Collect matching keys first to avoid borrowing issues
        let keys_to_remove: Vec<CacheKey> = cache
            .iter()
            .filter(|(k, _)| k.path == file_path)
            .map(|(k, _)| k.clone())
            .collect();

        for k in keys_to_remove {
            cache.pop(&k);
        }
    }
}

#[tauri::command]
async fn start_file_watcher(
    app: AppHandle,
    file_path: String,
    window_label: String,
) -> Result<(), String> {
    let watchers = app.state::<FileWatchers>();

    // Register subscription
    {
        let mut subs = watchers.subs.lock().await;
        let entry = subs.entry(file_path.clone()).or_default();
        if !entry.iter().any(|w| w == &window_label) {
            entry.push(window_label.clone());
        }
    }

    // Ensure a single watcher exists for this file path
    let need_create = {
        let map = watchers.watchers.lock().await;
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
        )
        .map_err(|e| format!("Failed to create watcher: {}", e))?;

        // Watch the file
        watcher
            .watch(Path::new(&file_path), RecursiveMode::NonRecursive)
            .map_err(|e| format!("Failed to watch file: {}", e))?;

        // Store watcher and sender
        watchers
            .watchers
            .lock()
            .await
            .insert(file_path.clone(), watcher);
        watchers.senders.lock().await.insert(file_path.clone(), tx);

        // Spawn a debounced notifier for this file path
        let app_clone = app.clone();
        let file_key = file_path.clone();
        let handle = tauri::async_runtime::spawn(async move {
            let mut pending_task: Option<tauri::async_runtime::JoinHandle<()>> = None;
            while rx.recv().await.is_some() {
                // Reset debounce timer
                if let Some(h) = pending_task.take() {
                    h.abort();
                }
                let app2 = app_clone.clone();
                let file2 = file_key.clone();
                pending_task = Some(tauri::async_runtime::spawn(async move {
                    sleep(Duration::from_millis(250)).await;
                    // Invalidate any cached HTML for this file
                    invalidate_cache_for_path(&app2, &file2).await;
                    if let Some(state) = app2.try_state::<FileWatchers>() {
                        let subs = state.subs.lock().await;
                        if let Some(labels) = subs.get(&file2) {
                            for label in labels.iter() {
                                if let Some(win) = app2.get_webview_window(label) {
                                    let _ = win.emit("file-changed", ());
                                }
                            }
                        }
                    }
                }));
            }
        });
        watchers
            .debounce_tasks
            .lock()
            .await
            .insert(file_path.clone(), handle);
    }

    Ok(())
}

#[tauri::command]
async fn stop_file_watcher(app: AppHandle, window_label: String) -> Result<(), String> {
    let watchers = app.state::<FileWatchers>();
    // Remove the window from all subscriptions and clean up any orphaned watchers
    let mut to_remove: Vec<String> = Vec::new();
    {
        let mut subs = watchers.subs.lock().await;
        for (file, labels) in subs.iter_mut() {
            labels.retain(|l| l != &window_label);
            if labels.is_empty() {
                to_remove.push(file.clone());
            }
        }
        // Actually remove empty entries
        for f in to_remove.iter() {
            subs.remove(f);
        }
    }

    // Stop watchers for files with no subscribers
    for f in to_remove.iter() {
        let mut map = watchers.watchers.lock().await;
        map.remove(f);
        drop(map);

        let mut txs = watchers.senders.lock().await;
        txs.remove(f);
        drop(txs);

        let mut tasks = watchers.debounce_tasks.lock().await;
        if let Some(h) = tasks.remove(f) {
            h.abort();
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
        window
            .show()
            .map_err(|e| format!("Failed to show window: {}", e))?;
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
    Ok(())
}

fn convert_to_logical(app: &AppHandle, width: u32, height: u32) -> (u32, u32) {
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let scale_factor = monitor.scale_factor();
        let logical_width = (width as f64 / scale_factor).round() as u32;
        let logical_height = (height as f64 / scale_factor).round() as u32;
        debug_log!(
            "Converting physical {}x{} to logical {}x{} (scale: {})",
            width,
            height,
            logical_width,
            logical_height,
            scale_factor
        );
        (logical_width, logical_height)
    } else {
        (width, height)
    }
}

fn escape_html(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#039;"),
            _ => out.push(ch),
        }
    }
    out
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {}", e))
}

#[tauri::command]
fn read_file_bytes_b64(path: String) -> Result<String, String> {
    fs::read(&path)
        .map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes))
        .map_err(|e| format!("Failed to read file bytes: {}", e))
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| format!("Failed to write file: {}", e))
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
fn parse_yaml_with_theme(content: String, theme: String) -> Result<String, String> {
    markrust_core::parse_yaml_with_theme(&content, &theme)
}

#[tauri::command]
fn format_json_pretty(content: String) -> Result<String, String> {
    // Pretty-print JSON using serde_json with default map ordering (sorted keys)
    let value: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("Invalid JSON: {}", e))?;
    serde_json::to_string_pretty(&value).map_err(|e| format!("Failed to pretty-print JSON: {}", e))
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ScrollSyncPayload {
    source: String,
    file_path: String,
    kind: String,         // e.g., "json", "markdown", "txt"
    line: Option<u32>,    // topmost line (1-based) when applicable
    percent: Option<f64>, // fallback scroll percent [0.0, 1.0]
}

#[tauri::command]
fn broadcast_scroll_sync(app: AppHandle, payload: ScrollSyncPayload) -> Result<(), String> {
    app.emit("scroll-sync", &payload)
        .map_err(|e| format!("Failed to broadcast scroll sync: {}", e))
}

#[tauri::command]
fn get_syntax_css(theme: String) -> Result<String, String> {
    markrust_core::get_syntax_theme_css(&theme)
        .ok_or_else(|| "Failed to generate syntax CSS".to_string())
}

#[tauri::command]
async fn render_file_to_html(
    app: AppHandle,
    path: String,
    theme: String,
) -> Result<String, String> {
    use std::time::UNIX_EPOCH;

    // Stat for cache key
    let meta = fs::metadata(&path).map_err(|e| format!("Failed to stat file: {}", e))?;
    let size = meta.len();
    let mtime_secs = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let key = CacheKey {
        path: path.clone(),
        size,
        mtime_secs,
        theme: theme.clone(),
    };

    // Try cache first (write lock needed because LRU get() updates internal state)
    if let Some(state) = app.try_state::<AppState>() {
        let mut cache = state.html_cache.write().await;
        if let Some(cached) = cache.get(&key).cloned() {
            return Ok(cached);
        }
    }

    // Heavy work in blocking thread
    let html = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        // Determine kind by extension
        let lower = Path::new(&path)
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_lowercase())
            .unwrap_or_default();

        if lower == "txt" {
            let content =
                fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {}", e))?;
            let escaped = escape_html(&content);
            Ok(format!(
                "<div class=\"markdown-body\"><pre class=\"plain-text\">{}</pre></div>",
                escaped
            ))
        } else if lower == "json" {
            let content =
                fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {}", e))?;
            markrust_core::parse_json_with_theme(&content, &theme)
        } else if lower == "yaml" || lower == "yml" {
            let content =
                fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {}", e))?;
            markrust_core::parse_yaml_with_theme(&content, &theme)
        } else {
            // default markdown
            let content =
                fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {}", e))?;
            Ok(markrust_core::parse_markdown_with_theme(&content, &theme))
        }
    })
    .await
    .map_err(|e| format!("Join error: {}", e))??;

    // Insert into cache
    if let Some(state) = app.try_state::<AppState>() {
        let mut cache = state.html_cache.write().await;
        cache.put(key, html.clone());
    }

    Ok(html)
}

#[tauri::command]
fn get_preferences(app: AppHandle) -> Result<AppPreferences, String> {
    let store = app
        .store(".boltpage.dat")
        .map_err(|e| format!("Failed to access store: {}", e))?;

    let prefs = store
        .get("preferences")
        .and_then(|v| serde_json::from_value::<AppPreferences>(v.clone()).ok())
        .unwrap_or_default();

    Ok(prefs)
}

#[tauri::command]
fn save_preferences(app: AppHandle, preferences: AppPreferences) -> Result<(), String> {
    let store = app
        .store(".boltpage.dat")
        .map_err(|e| format!("Failed to access store: {}", e))?;

    store.set("preferences", serde_json::to_value(&preferences).unwrap());
    store
        .save()
        .map_err(|e| format!("Failed to save preferences: {}", e))?;

    Ok(())
}

#[tauri::command]
async fn open_file_dialog(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let file_path = app
        .dialog()
        .file()
        // Show a combined filter first for convenience
        .add_filter(
            "Supported",
            &["md", "markdown", "json", "yaml", "yml", "txt", "pdf"],
        )
        // Specific filters
        .add_filter("Markdown", &["md", "markdown"])
        .add_filter("JSON", &["json"])
        .add_filter("YAML", &["yaml", "yml"])
        .add_filter("Text", &["txt"])
        .add_filter("PDF", &["pdf"])
        .blocking_pick_file();

    Ok(file_path.map(|p| p.to_string()))
}

#[tauri::command]
async fn create_new_markdown_file(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let selection = app
        .dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown"])
        .add_filter("All Files", &["*"])
        .blocking_save_file();

    let Some(selection) = selection else {
        return Ok(None);
    };

    let mut path = selection
        .into_path()
        .map_err(|e| format!("Failed to resolve path: {}", e))?;

    if path.extension().is_none() {
        path.set_extension("md");
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directories: {}", e))?;
    }

    fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&path)
        .map_err(|e| format!("Failed to create file: {}", e))?;

    let window_label = create_window_with_file(&app, Some(path))
        .await
        .map_err(|e| format!("Failed to open window: {}", e))?;

    Ok(Some(window_label))
}

#[tauri::command]
async fn open_editor_window(
    app: AppHandle,
    file_path: String,
    preview_window: String,
) -> Result<(), String> {
    let editor_label = format!("editor-{}", uuid::Uuid::new_v4());

    let _editor_window =
        WebviewWindowBuilder::new(&app, &editor_label, WebviewUrl::App("editor.html".into()))
            .title(format!(
                "BoltPage Editor - {}",
                file_path.split('/').next_back().unwrap_or("Untitled")
            ))
            .inner_size(800.0, 600.0)
            .initialization_script(format!(
                "window.__INITIAL_FILE_PATH__ = {}; window.__PREVIEW_WINDOW__ = {};",
                serde_json::to_string(&file_path).unwrap(),
                serde_json::to_string(&preview_window).unwrap()
            ))
            .build()
            .map_err(|e| format!("Failed to create editor window: {}", e))?;

    Ok(())
}

#[tauri::command]
async fn create_new_window_command(
    app: AppHandle,
    file_path: Option<String>,
) -> Result<String, String> {
    let resolved_path = file_path.and_then(|p| resolve_file_path(&p));
    create_window_with_file(&app, resolved_path)
        .await
        .map_err(|e| format!("Failed to create window: {}", e))
}

#[tauri::command]
async fn remove_window_from_tracking(app: AppHandle, window_label: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut open_windows = state.open_windows.write().await;

    // Find and remove the window by label
    open_windows.retain(|_, label| label != &window_label);
    Ok(())
}

#[tauri::command]
fn refresh_preview(app: AppHandle, window: String) -> Result<(), String> {
    if let Some(preview_window) = app.get_webview_window(&window) {
        preview_window
            .eval("refreshFile()")
            .map_err(|e| format!("Failed to refresh preview: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
fn get_file_path_from_window_label(window: tauri::Window) -> Result<Option<String>, String> {
    let window_label = window.label();

    // Check if this is a file window (starts with "markdown-file-")
    if let Some(encoded_path) = window_label.strip_prefix("markdown-file-") {
        match base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(encoded_path) {
            Ok(decoded_bytes) => match String::from_utf8(decoded_bytes) {
                Ok(file_path) => Ok(Some(file_path)),
                Err(e) => Err(format!("Failed to decode UTF-8: {}", e)),
            },
            Err(e) => Err(format!("Failed to decode base64: {}", e)),
        }
    } else {
        // Not a file window, return None
        Ok(None)
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct WindowInfo {
    label: String,
    title: String,
    file_path: String,
}

#[tauri::command]
fn get_all_windows(app: AppHandle) -> Result<Vec<WindowInfo>, String> {
    let mut windows = Vec::new();

    for (label, window) in app.webview_windows() {
        let title = window.title().unwrap_or_else(|_| "Untitled".to_string());
        // For now, just show the window label as file path since we can't easily get the actual path
        let file_path = if label.starts_with("markdown-file-") {
            "File window".to_string()
        } else {
            "Empty window".to_string()
        };

        windows.push(WindowInfo {
            label: label.to_string(),
            title,
            file_path,
        });
    }

    Ok(windows)
}

#[tauri::command]
fn focus_window(app: AppHandle, window_label: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&window_label) {
        window
            .set_focus()
            .map_err(|e| format!("Failed to focus window: {}", e))?;
        window
            .show()
            .map_err(|e| format!("Failed to show window: {}", e))?;
        Ok(())
    } else {
        Err("Window not found".to_string())
    }
}

async fn open_markdown_window(app: &AppHandle, file_path: Option<String>) -> Result<(), String> {
    let resolved_path = file_path.and_then(|p| resolve_file_path(&p));
    create_window_with_file(app, resolved_path)
        .await
        .map_err(|e| format!("Failed to create window: {}", e))
        .map(|_| ())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    let mut file_path = args.get(1).cloned();
    // If a CLI path was provided, ensure it exists (create empty file) and normalize to absolute
    if let Some(ref path_str) = file_path {
        if let Some(pathbuf) = resolve_file_path(path_str) {
            if !pathbuf.exists() {
                if let Some(parent) = pathbuf.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                if let Err(e) = fs::OpenOptions::new()
                    .write(true)
                    .create(true)
                    .truncate(true)
                    .open(&pathbuf)
                {
                    eprintln!("Failed to create file from CLI arg {:?}: {}", pathbuf, e);
                }
            }
            file_path = Some(pathbuf.to_string_lossy().to_string());
        }
    }

    // Initialize app state before building to avoid race condition
    let app_state = AppState::default();

    tauri::Builder::default()
        .manage(app_state)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_file,
            read_file_bytes_b64,
            write_file,
            is_writable,
            parse_markdown,
            parse_markdown_with_theme,
            parse_json_with_theme,
            parse_yaml_with_theme,
            format_json_pretty,
            broadcast_scroll_sync,
            get_preferences,
            save_preferences,
            open_file_dialog,
            create_new_markdown_file,
            open_editor_window,
            refresh_preview,
            start_file_watcher,
            stop_file_watcher,
            broadcast_theme_change,
            broadcast_scroll_link,
            show_window,
            save_window_size,
            create_new_window_command,
            remove_window_from_tracking,
            get_file_path_from_window_label,
            get_all_windows,
            focus_window,
            get_syntax_css,
            render_file_to_html
        ])
        .setup(move |app| {
            // Initialize file watchers state only (app state already managed)
            app.manage(FileWatchers::default());

            // Set up the initial menu (dynamic Window submenu)
            rebuild_app_menu(app.handle())?;

            // Handle menu events
            app.on_menu_event(|app, event| {
                match event.id().as_ref() {
                    "new-file" => {
                        let app_clone = app.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(e) = create_new_markdown_file(app_clone).await {
                                eprintln!("Failed to create new file: {}", e);
                            }
                        });
                    }
                    "new-window" => {
                        // Create a new empty window (spawn async)
                        let app_clone = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = create_new_window_command(app_clone, None).await;
                        });
                    }
                    window_id if window_id.starts_with("window-") => {
                        // Extract the actual window label from the menu item ID
                        if let Some(label) = window_id.strip_prefix("window-") {
                            if let Some(window) = app.get_webview_window(label) {
                                let _ = window.set_focus();
                                let _ = window.show();
                            }
                        }
                    }
                    "open" => {
                        // Create a new window and trigger open file dialog
                        let app_clone = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = create_new_window_command(app_clone, None).await;
                        });
                    }
                    "print" => {
                        // Forward to all windows; JS will handle based on focus
                        let _ = app.emit("menu-print", &());
                    }
                    "close" => {
                        // This will be handled by the window's menu directly
                        // Individual windows handle their own close events
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    // Edit actions forwarded to webviews (focused window will act)
                    "undo" | "redo" | "cut" | "copy" | "paste" | "select-all" => {
                        let action = event.id().as_ref();
                        let _ = app.emit("menu-edit", &action);
                    }
                    // Find action
                    "find" => {
                        let _ = app.emit("menu-find", &());
                    }
                    "about" => {
                        let version = env!("CARGO_PKG_VERSION");
                        let msg = format!(
                            "alert('BoltPage v{}\\nA fast Markdown viewer and editor')",
                            version
                        );
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.eval(&msg);
                        } else if let Some((_, window)) = app.webview_windows().into_iter().next() {
                            let _ = window.eval(&msg);
                        }
                    }
                    _ => {}
                }
            });

            // Create initial window (CLI args or empty)
            // On macOS, skip creating an empty window if no CLI args were provided,
            // because double-clicking a file sends an Opened event instead of CLI args
            #[cfg(target_os = "macos")]
            {
                if file_path.is_some() {
                    // Explicit CLI argument (e.g., from terminal) - create window
                    tauri::async_runtime::block_on(open_markdown_window(app.handle(), file_path))?;
                }
                // Otherwise, wait for Opened event or user menu action (don't create empty window)
            }

            #[cfg(not(target_os = "macos"))]
            {
                // On other platforms, always create initial window
                tauri::async_runtime::block_on(open_markdown_window(app.handle(), file_path))?;
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::Resized(size) => {
                    // Debounce saves and convert to logical pixels
                    let app = window.app_handle().clone();
                    let label = window.label().to_string();
                    let (lw, lh) = convert_to_logical(&app, size.width, size.height);

                    // Extract only the Arc<Mutex> we need (not a borrow)
                    let resize_tasks_arc = app
                        .try_state::<AppState>()
                        .map(|state| state.inner().resize_tasks.clone());

                    if let Some(resize_tasks) = resize_tasks_arc {
                        let app_clone = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let mut tasks = resize_tasks.lock().await;

                            // Cancel previous debounce task if any
                            if let Some((handle, _, _)) = tasks.remove(&label) {
                                handle.abort();
                            }

                            // Spawn new debounced save task
                            let app_clone2 = app_clone.clone();
                            let handle = tauri::async_runtime::spawn(async move {
                                sleep(Duration::from_millis(450)).await;

                                // Save the size that was captured at spawn time
                                let mut prefs =
                                    get_preferences(app_clone2.clone()).unwrap_or_default();
                                prefs.window_width = lw;
                                prefs.window_height = lh;
                                let _ = save_preferences(app_clone2, prefs);
                            });

                            tasks.insert(label, (handle, lw, lh));
                        });
                    }
                }
                tauri::WindowEvent::CloseRequested { .. } => {
                    // Clean up file watcher and window tracking
                    let app = window.app_handle().clone();
                    let window_label = window.label().to_string();

                    // Spawn async task for cleanup
                    tauri::async_runtime::spawn(async move {
                        let _ = stop_file_watcher(app.clone(), window_label.clone()).await;
                        let _ = remove_window_from_tracking(app.clone(), window_label).await;
                        let _ = rebuild_app_menu(&app);
                    });
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // Handle file opening via Launch Services on macOS
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                let app_clone = _app.clone();
                tauri::async_runtime::spawn(async move {
                    for url in urls {
                        if let Some(path) = resolve_file_path(&url.to_string()) {
                            if let Err(e) =
                                create_window_with_file(&app_clone, Some(path.clone())).await
                            {
                                eprintln!("Failed to open window for {:?}: {}", path, e);
                            }
                        }
                    }
                    // Rebuild menu after opening files
                    let _ = rebuild_app_menu(&app_clone);
                });
            }
        });
}
