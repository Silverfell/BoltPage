use base64::Engine;
use lru::LruCache;
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock as StdRwLock};
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

/// Canonicalize a path for use in the allowed-paths set.
/// Falls back to the raw string if the file does not yet exist.
fn normalize_path(path: &str) -> String {
    fs::canonicalize(path)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| path.to_string())
}

/// Verify that `path` was explicitly opened by the user (file dialog, CLI, or
/// macOS Launch Services).  Prevents a compromised webview from reading /
/// writing arbitrary files.
fn check_path_allowed(app: &AppHandle, path: &str) -> Result<(), String> {
    let normalized = normalize_path(path);
    let state = app.state::<AppState>();
    let allowed = state
        .allowed_paths
        .read()
        .expect("allowed_paths lock poisoned");
    if allowed.contains(&normalized) {
        Ok(())
    } else {
        Err("Access denied: path not authorized".to_string())
    }
}

/// Register a path as allowed for file I/O commands.
fn allow_path(app: &AppHandle, path: &str) {
    let normalized = normalize_path(path);
    let state = app.state::<AppState>();
    state
        .allowed_paths
        .write()
        .expect("allowed_paths lock poisoned")
        .insert(normalized);
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

fn pathbuf_to_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn is_reasonable_window_size(
    width: u32,
    height: u32,
    default_width: u32,
    default_height: u32,
) -> bool {
    width > 200
        && width < 5000
        && height > 200
        && height < 5000
        && (width != default_width || height != default_height)
}

fn stored_window_size(
    width: Option<u32>,
    height: Option<u32>,
    default_width: u32,
    default_height: u32,
) -> Option<(f64, f64)> {
    let (width, height) = (width?, height?);
    if is_reasonable_window_size(width, height, default_width, default_height) {
        Some((width as f64, height as f64))
    } else {
        None
    }
}

fn is_preview_window_label(label: &str) -> bool {
    label.starts_with("markdown-")
}

fn is_editor_window_label(label: &str) -> bool {
    label.starts_with("editor-")
}

fn decode_file_path_from_window_label_str(window_label: &str) -> Result<Option<String>, String> {
    if let Some(encoded_path) = window_label.strip_prefix("markdown-file-") {
        match base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(encoded_path) {
            Ok(decoded_bytes) => match String::from_utf8(decoded_bytes) {
                Ok(file_path) => Ok(Some(file_path)),
                Err(e) => Err(format!("Failed to decode UTF-8: {e}")),
            },
            Err(e) => Err(format!("Failed to decode base64: {e}")),
        }
    } else {
        Ok(None)
    }
}

fn paths_match(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }

    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a_canon), Ok(b_canon)) => a_canon == b_canon,
        _ => false,
    }
}

fn event_targets_file(paths: &[PathBuf], target: &Path) -> bool {
    paths.iter().any(|candidate| paths_match(candidate, target))
}

fn is_refresh_relevant_event(kind: &notify::EventKind) -> bool {
    matches!(
        kind,
        notify::EventKind::Modify(_)
            | notify::EventKind::Create(_)
            | notify::EventKind::Remove(_)
            | notify::EventKind::Any
    )
}

fn remove_cache_entries_for_path(cache: &mut LruCache<CacheKey, String>, file_path: &str) {
    let keys_to_remove: Vec<CacheKey> = cache
        .iter()
        .filter(|(k, _)| k.path == file_path)
        .map(|(k, _)| k.clone())
        .collect();

    for key in keys_to_remove {
        cache.pop(&key);
    }
}

fn invalidate_cache_for_path_sync(app: &AppHandle, file_path: &str) {
    if let Some(state) = app.try_state::<AppState>() {
        let mut cache = state.html_cache.blocking_write();
        remove_cache_entries_for_path(&mut cache, file_path);
    }
}

#[cfg(not(target_os = "windows"))]
fn replace_file_atomically(temp_path: &Path, target_path: &Path) -> Result<(), String> {
    fs::rename(temp_path, target_path).map_err(|e| format!("Failed to replace file: {e}"))
}

#[cfg(target_os = "windows")]
fn replace_file_atomically(temp_path: &Path, target_path: &Path) -> Result<(), String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    fn encode_wide(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }

    let temp_wide = encode_wide(temp_path.as_os_str());
    let target_wide = encode_wide(target_path.as_os_str());
    let flags = MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH;
    let success = unsafe { MoveFileExW(temp_wide.as_ptr(), target_wide.as_ptr(), flags) };
    if success != 0 {
        Ok(())
    } else {
        Err(format!(
            "Failed to replace file: {}",
            std::io::Error::last_os_error()
        ))
    }
}

fn atomic_write_file(path: &Path, content: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Cannot write file without a parent directory".to_string())?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Cannot write file with a non-UTF-8 name".to_string())?;
    let metadata = fs::metadata(path).map_err(|e| format!("Failed to stat file: {e}"))?;
    let temp_path = parent.join(format!(".{file_name}.{}.tmp", uuid::Uuid::new_v4()));

    let result = (|| -> Result<(), String> {
        let mut temp_file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .map_err(|e| format!("Failed to create temp file: {e}"))?;
        temp_file
            .write_all(content.as_bytes())
            .map_err(|e| format!("Failed to write temp file: {e}"))?;
        temp_file
            .sync_all()
            .map_err(|e| format!("Failed to flush temp file: {e}"))?;
        drop(temp_file);

        fs::set_permissions(&temp_path, metadata.permissions())
            .map_err(|e| format!("Failed to preserve file permissions: {e}"))?;
        replace_file_atomically(&temp_path, path)?;

        if let Ok(parent_dir) = fs::File::open(parent) {
            let _ = parent_dir.sync_all();
        }

        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }

    result
}

// Calculate appropriate window size with page-like proportions
fn calculate_window_size(app: &AppHandle, prefs: &AppPreferences) -> tauri::Result<(f64, f64)> {
    // If user has resized windows (preferences were saved), use those dimensions
    // Check if these are reasonable user-resized values (not corrupted massive values)
    if let Some(size) = stored_window_size(
        Some(prefs.window_width),
        Some(prefs.window_height),
        900,
        800,
    ) {
        return Ok(size);
    }

    // Otherwise, calculate default page-like proportions using monitor size
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let monitor_size = monitor.size();
        let scale_factor = monitor.scale_factor();

        // Convert physical pixels to logical pixels
        let logical_height = monitor_size.height as f64 / scale_factor;

        // Page-like proportions: reasonable reading width, full screen height
        let page_width = 900.0;
        let page_height = logical_height;

        debug_log!(
            "[DEBUG] Monitor size: {}x{} (scale: {}), Using calculated window size: {}x{}",
            monitor_size.width as f64 / scale_factor,
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
        let label = format!("markdown-file-{encoded_path}");
        let url = WebviewUrl::App("index.html".into());
        let title = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| format!("BoltPage - {n}"))
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

    // Track file windows and register as allowed for I/O commands
    if let Some(path) = file_path {
        let path_str = pathbuf_to_string(&path);
        allow_path(app, &path_str);
        let app_state = app.state::<AppState>();
        let mut open_windows = app_state.open_windows.write().await;
        open_windows.insert(path_str, window_label.clone());
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
        .item(
            &MenuItemBuilder::with_id("export-html", "Export as HTML...")
                .accelerator("CmdOrCtrl+Shift+E")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("export-pdf", "Export as PDF...")
                .accelerator("CmdOrCtrl+Shift+P")
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
    let mut window_menu_builder = SubmenuBuilder::new(app, "Window").separator();

    for (label, window) in app.webview_windows() {
        let title = window.title().unwrap_or_else(|_| "Untitled".to_string());
        let window_id = format!("window-{label}");
        window_menu_builder =
            window_menu_builder.item(&MenuItemBuilder::with_id(&window_id, &title).build(app)?);
    }
    let window_menu = window_menu_builder.build()?;

    // Help menu
    #[allow(unused_mut)]
    let mut help_menu_builder = SubmenuBuilder::new(app, "Help");

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        help_menu_builder = help_menu_builder
            .item(&MenuItemBuilder::with_id("setup-cli", "Setup CLI Access...").build(app)?);
    }

    let help_menu = help_menu_builder
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
struct FileWatcherInner {
    watchers: HashMap<String, RecommendedWatcher>,
    /// Stored to keep the channel alive; dropping the sender closes the receiver.
    senders: HashMap<String, mpsc::UnboundedSender<()>>,
    debounce_tasks: HashMap<String, tauri::async_runtime::JoinHandle<()>>,
    subs: HashMap<String, Vec<String>>,
}

struct FileWatchers {
    inner: Arc<Mutex<FileWatcherInner>>,
}

impl Default for FileWatchers {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(FileWatcherInner {
                watchers: HashMap::new(),
                senders: HashMap::new(),
                debounce_tasks: HashMap::new(),
                subs: HashMap::new(),
            })),
        }
    }
}

fn prune_orphaned_watchers(inner: &mut FileWatcherInner) {
    let mut to_remove = Vec::new();
    for (file, labels) in inner.subs.iter() {
        if labels.is_empty() {
            to_remove.push(file.clone());
        }
    }

    for file in to_remove {
        inner.subs.remove(&file);
        inner.watchers.remove(&file);
        inner.senders.remove(&file);
        if let Some(handle) = inner.debounce_tasks.remove(&file) {
            handle.abort();
        }
    }
}

fn unsubscribe_window_from_all(inner: &mut FileWatcherInner, window_label: &str) {
    for labels in inner.subs.values_mut() {
        labels.retain(|label| label != window_label);
    }
    prune_orphaned_watchers(inner);
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

    /// HTML render cache: (path, size, mtime_secs) -> HTML
    /// Read-heavy workload with LRU eviction
    html_cache: Arc<RwLock<LruCache<CacheKey, String>>>,

    /// Set of canonicalized paths the user has explicitly opened.
    /// Uses std::sync::RwLock (not tokio) so sync commands can read it.
    allowed_paths: Arc<StdRwLock<HashSet<String>>>,

    /// Serializes read-modify-write cycles on the preference store
    /// to prevent concurrent saves from overwriting each other.
    pref_lock: Arc<Mutex<()>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            open_windows: Arc::new(RwLock::new(HashMap::new())),
            resize_tasks: Arc::new(Mutex::new(HashMap::new())),
            html_cache: Arc::new(RwLock::new(LruCache::new(NonZeroUsize::new(50).unwrap()))),
            allowed_paths: Arc::new(StdRwLock::new(HashSet::new())),
            pref_lock: Arc::new(Mutex::new(())),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct AppPreferences {
    theme: String,
    window_width: u32,
    window_height: u32,
    editor_window_width: Option<u32>,
    editor_window_height: Option<u32>,
    font_size: Option<u16>,
    word_wrap: Option<bool>,
    show_line_numbers: Option<bool>,
    toc_visible: Option<bool>,
    cli_setup_prompted: Option<bool>,
}

impl Default for AppPreferences {
    fn default() -> Self {
        Self {
            theme: "drac".to_string(),
            window_width: 900,  // Page-like width for reading
            window_height: 800, // Taller default height
            editor_window_width: None,
            editor_window_height: None,
            font_size: None,
            word_wrap: None,
            show_line_numbers: None,
            toc_visible: None,
            cli_setup_prompted: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct CacheKey {
    path: String,
    size: u64,
    mtime_secs: u64,
}

async fn invalidate_cache_for_path(app: &AppHandle, file_path: &str) {
    if let Some(state) = app.try_state::<AppState>() {
        let mut cache = state.html_cache.write().await;
        remove_cache_entries_for_path(&mut cache, file_path);
    }
}

#[tauri::command]
async fn start_file_watcher(
    app: AppHandle,
    file_path: String,
    window_label: String,
) -> Result<(), String> {
    check_path_allowed(&app, &file_path)?;
    let watchers = app.state::<FileWatchers>();
    let mut inner = watchers.inner.lock().await;
    unsubscribe_window_from_all(&mut inner, &window_label);

    // Register subscription
    let entry = inner.subs.entry(file_path.clone()).or_default();
    if !entry.iter().any(|w| w == &window_label) {
        entry.push(window_label.clone());
    }

    // If watcher already exists for this file, we're done
    if inner.watchers.contains_key(&file_path) {
        return Ok(());
    }

    // Create watcher while holding lock to prevent duplicate creation.
    // Watcher creation is fast (OS notification setup only).
    let (tx, mut rx) = mpsc::unbounded_channel();
    let target_path = PathBuf::from(&file_path);
    let watch_path = target_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| target_path.clone());

    let tx_for_watcher = tx.clone();
    let mut watcher = RecommendedWatcher::new(
        move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                if is_refresh_relevant_event(&event.kind)
                    && event_targets_file(&event.paths, &target_path)
                {
                    let _ = tx_for_watcher.send(());
                }
            }
        },
        Config::default(),
    )
    .map_err(|e| format!("Failed to create watcher: {e}"))?;

    watcher
        .watch(&watch_path, RecursiveMode::NonRecursive)
        .map_err(|e| format!("Failed to watch file: {e}"))?;

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
                    let guard = state.inner.lock().await;
                    if let Some(labels) = guard.subs.get(&file2) {
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

    // Store watcher, sender, and debounce task (lock still held)
    inner.watchers.insert(file_path.clone(), watcher);
    inner.senders.insert(file_path.clone(), tx);
    inner.debounce_tasks.insert(file_path.clone(), handle);

    Ok(())
}

#[tauri::command]
async fn stop_file_watcher(app: AppHandle, window_label: String) -> Result<(), String> {
    let watchers = app.state::<FileWatchers>();
    let mut inner = watchers.inner.lock().await;
    unsubscribe_window_from_all(&mut inner, &window_label);
    Ok(())
}

#[tauri::command]
fn broadcast_theme_change(app: AppHandle, theme: String) -> Result<(), String> {
    // Emit theme change event to all windows
    app.emit("theme-changed", &theme)
        .map_err(|e| format!("Failed to broadcast theme change: {e}"))?;
    Ok(())
}

#[tauri::command]
fn show_window(app: AppHandle, window_label: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&window_label) {
        window
            .show()
            .map_err(|e| format!("Failed to show window: {e}"))?;
    }
    Ok(())
}

fn convert_to_logical(window: &tauri::Window, width: u32, height: u32) -> (u32, u32) {
    // Use the window's current monitor, not the primary monitor, so the
    // correct scale factor is applied when the window is on a secondary display.
    if let Ok(Some(monitor)) = window.current_monitor() {
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
fn read_file(app: AppHandle, path: String) -> Result<String, String> {
    check_path_allowed(&app, &path)?;
    fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {e}"))
}

#[tauri::command]
fn read_file_bytes_b64(app: AppHandle, path: String) -> Result<String, String> {
    check_path_allowed(&app, &path)?;
    fs::read(&path)
        .map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes))
        .map_err(|e| format!("Failed to read file bytes: {e}"))
}

#[tauri::command]
fn write_file(app: AppHandle, path: String, content: String) -> Result<(), String> {
    check_path_allowed(&app, &path)?;
    if !Path::new(&path).exists() {
        return Err("File does not exist. Use create to make new files.".to_string());
    }
    atomic_write_file(Path::new(&path), &content)?;
    invalidate_cache_for_path_sync(&app, &path);
    Ok(())
}

#[tauri::command]
fn is_writable(app: AppHandle, path: String) -> Result<bool, String> {
    check_path_allowed(&app, &path)?;
    // Actually attempt to open for writing rather than checking permission bits,
    // which are unreliable on Unix for non-owner users.
    match fs::OpenOptions::new().write(true).open(&path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => Ok(false),
        Err(e) => Err(format!("Failed to check writability: {e}")),
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
        serde_json::from_str(&content).map_err(|e| format!("Invalid JSON: {e}"))?;
    serde_json::to_string_pretty(&value).map_err(|e| format!("Failed to pretty-print JSON: {e}"))
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ScrollSyncPayload {
    source: String,
    file_path: String,
    kind: String,         // e.g., "json", "markdown", "txt"
    line: Option<u32>,    // topmost line (1-based) when applicable
    percent: Option<f64>, // fallback scroll percent [0.0, 1.0]
}

fn print_focused_webview(app: &AppHandle) {
    for (_, window) in app.webview_windows() {
        if window.is_focused().unwrap_or(false) {
            let _ = window.print();
            return;
        }
    }
}

#[tauri::command]
fn print_current_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.print().map_err(|e| format!("Print failed: {e}"))
}

#[tauri::command]
fn broadcast_scroll_sync(app: AppHandle, payload: ScrollSyncPayload) -> Result<(), String> {
    app.emit("scroll-sync", &payload)
        .map_err(|e| format!("Failed to broadcast scroll sync: {e}"))
}

#[tauri::command]
fn get_syntax_css(theme: String) -> Result<String, String> {
    markrust_core::get_syntax_theme_css(&theme)
        .ok_or_else(|| "Failed to generate syntax CSS".to_string())
}

async fn export_html_inner(app: &AppHandle, path: &str, theme: &str) -> Result<String, String> {
    let fragment = render_file_to_html(app.clone(), path.to_string(), theme.to_string()).await?;
    let syntax_css = markrust_core::get_syntax_theme_css(theme).unwrap_or_default();
    let base_css = include_str!("../../src/styles.css");

    let data_theme = match theme {
        "dark" => r#" data-theme="dark""#,
        "drac" => r#" data-theme="drac""#,
        _ => "",
    };

    let title = Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Exported Document");

    Ok(format!(
        r#"<!DOCTYPE html>
<html lang="en"{data_theme}>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title}</title>
<style>
{base_css}
</style>
<style>
{syntax_css}
</style>
</head>
<body>
<div class="content-wrapper">
<div class="markdown-body">
{fragment}
</div>
</div>
</body>
</html>"#
    ))
}

#[tauri::command]
async fn save_html_export(
    app: AppHandle,
    path: String,
    theme: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    check_path_allowed(&app, &path)?;

    let html = export_html_inner(&app, &path, &theme).await?;

    let app_clone = app.clone();
    let selection = tauri::async_runtime::spawn_blocking(move || {
        app_clone
            .dialog()
            .file()
            .add_filter("HTML", &["html"])
            .blocking_save_file()
    })
    .await
    .map_err(|e| format!("Join error: {e}"))?;

    let Some(selection) = selection else {
        return Ok(None);
    };

    let mut save_path = selection
        .into_path()
        .map_err(|e| format!("Failed to resolve path: {e}"))?;

    if save_path.extension().is_none() {
        save_path.set_extension("html");
    }

    tauri::async_runtime::spawn_blocking(move || {
        fs::write(&save_path, html).map_err(|e| format!("Failed to write HTML: {e}"))
    })
    .await
    .map_err(|e| format!("Join error: {e}"))??;

    Ok(Some("ok".to_string()))
}

#[tauri::command]
async fn render_file_to_html(
    app: AppHandle,
    path: String,
    theme: String,
) -> Result<String, String> {
    use std::time::UNIX_EPOCH;

    check_path_allowed(&app, &path)?;

    // Only allow known file extensions
    let allowed = ["md", "markdown", "json", "yaml", "yml", "txt"];
    let ext = Path::new(&path)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    if !allowed.contains(&ext.as_str()) {
        return Err(format!("Unsupported file extension: .{ext}"));
    }

    // Stat and read in a single blocking call to avoid TOCTOU between
    // metadata check and content read.
    let read_path = path.clone();
    let (size, mtime_secs, raw_content) =
        tauri::async_runtime::spawn_blocking(move || -> Result<(u64, u64, String), String> {
            let meta = fs::metadata(&read_path).map_err(|e| format!("Failed to stat file: {e}"))?;
            let size = meta.len();
            let mtime_secs = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let content =
                fs::read_to_string(&read_path).map_err(|e| format!("Failed to read file: {e}"))?;
            Ok((size, mtime_secs, content))
        })
        .await
        .map_err(|e| format!("Join error: {e}"))??;

    // Theme is not part of the cache key because the rendered HTML is
    // theme-independent (themes are applied via CSS class swapping).
    let key = CacheKey {
        path: path.clone(),
        size,
        mtime_secs,
    };

    // Try cache first (write lock needed because LRU get() updates internal state)
    if let Some(state) = app.try_state::<AppState>() {
        let mut cache = state.html_cache.write().await;
        if let Some(cached) = cache.get(&key).cloned() {
            return Ok(cached);
        }
    }

    // Heavy rendering work in blocking thread
    let html = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        if ext == "txt" {
            let escaped = escape_html(&raw_content);
            Ok(format!(
                "<div class=\"markdown-body\"><pre class=\"plain-text\">{escaped}</pre></div>"
            ))
        } else if ext == "json" {
            markrust_core::parse_json_with_theme(&raw_content, &theme)
        } else if ext == "yaml" || ext == "yml" {
            markrust_core::parse_yaml_with_theme(&raw_content, &theme)
        } else {
            Ok(markrust_core::parse_markdown_with_theme(
                &raw_content,
                &theme,
            ))
        }
    })
    .await
    .map_err(|e| format!("Join error: {e}"))??;

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
        .map_err(|e| format!("Failed to access store: {e}"))?;

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
        .map_err(|e| format!("Failed to access store: {e}"))?;

    store.set(
        "preferences",
        serde_json::to_value(&preferences)
            .map_err(|e| format!("Failed to serialize preferences: {e}"))?,
    );
    store
        .save()
        .map_err(|e| format!("Failed to save preferences: {e}"))?;

    Ok(())
}

/// Atomically read-modify-write a single preference key while holding pref_lock.
/// Used by both JS (via the command) and internal Rust code.
async fn save_preference_key_inner(
    app: &AppHandle,
    key: &str,
    value: serde_json::Value,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let _lock = state.pref_lock.lock().await;

    let store = app
        .store(".boltpage.dat")
        .map_err(|e| format!("Failed to access store: {e}"))?;

    let mut map = store
        .get("preferences")
        .and_then(|v| {
            serde_json::from_value::<serde_json::Map<String, serde_json::Value>>(v.clone()).ok()
        })
        .unwrap_or_default();

    map.insert(key.to_string(), value);

    store.set("preferences", serde_json::Value::Object(map));
    store
        .save()
        .map_err(|e| format!("Failed to save preferences: {e}"))?;
    Ok(())
}

#[tauri::command]
async fn save_preference_key(
    app: AppHandle,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    save_preference_key_inner(&app, &key, value).await
}

#[tauri::command]
async fn open_file_dialog(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    // Run the blocking native dialog off the async worker thread
    let app_clone = app.clone();
    let file_path = tauri::async_runtime::spawn_blocking(move || {
        app_clone
            .dialog()
            .file()
            .add_filter(
                "Supported",
                &["md", "markdown", "json", "yaml", "yml", "txt", "pdf"],
            )
            .add_filter("Markdown", &["md", "markdown"])
            .add_filter("JSON", &["json"])
            .add_filter("YAML", &["yaml", "yml"])
            .add_filter("Text", &["txt"])
            .add_filter("PDF", &["pdf"])
            .blocking_pick_file()
    })
    .await
    .map_err(|e| format!("Join error: {e}"))?;

    // Register the user-chosen path as allowed for I/O
    if let Some(ref p) = file_path {
        allow_path(&app, &p.to_string());
    }

    Ok(file_path.map(|p| p.to_string()))
}

#[tauri::command]
async fn create_new_markdown_file(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    // Run the blocking native dialog off the async worker thread
    let app_clone = app.clone();
    let selection = tauri::async_runtime::spawn_blocking(move || {
        app_clone
            .dialog()
            .file()
            .add_filter("Markdown", &["md", "markdown"])
            .add_filter("All Files", &["*"])
            .blocking_save_file()
    })
    .await
    .map_err(|e| format!("Join error: {e}"))?;

    let Some(selection) = selection else {
        return Ok(None);
    };

    let mut path = selection
        .into_path()
        .map_err(|e| format!("Failed to resolve path: {e}"))?;

    if path.extension().is_none() {
        path.set_extension("md");
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directories: {e}"))?;
    }

    fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&path)
        .map_err(|e| format!("Failed to create file: {e}"))?;

    let window_label = create_window_with_file(&app, Some(path))
        .await
        .map_err(|e| format!("Failed to open window: {e}"))?;

    Ok(Some(window_label))
}

#[tauri::command]
async fn open_editor_window(
    app: AppHandle,
    file_path: String,
    preview_window: String,
) -> Result<(), String> {
    check_path_allowed(&app, &file_path)?;

    // Deterministic label from file path so we can detect an existing editor
    let encoded_path =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(file_path.as_bytes());
    let editor_label = format!("editor-{encoded_path}");

    // If an editor for this file already exists, focus it
    if let Some(existing) = app.get_webview_window(&editor_label) {
        let _ = existing.set_focus();
        return Ok(());
    }

    let file_name = Path::new(&file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Untitled");
    let prefs = get_preferences(app.clone()).unwrap_or_default();
    let (editor_width, editor_height) = stored_window_size(
        prefs.editor_window_width,
        prefs.editor_window_height,
        800,
        600,
    )
    .unwrap_or((800.0, 600.0));
    let _editor_window =
        WebviewWindowBuilder::new(&app, &editor_label, WebviewUrl::App("editor.html".into()))
            .title(format!("BoltPage Editor - {file_name}"))
            .inner_size(editor_width, editor_height)
            .initialization_script(format!(
                "window.__INITIAL_FILE_PATH__ = {}; window.__PREVIEW_WINDOW__ = {};",
                serde_json::to_string(&file_path).unwrap(),
                serde_json::to_string(&preview_window).unwrap()
            ))
            .build()
            .map_err(|e| format!("Failed to create editor window: {e}"))?;

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
        .map_err(|e| format!("Failed to create window: {e}"))
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
    if let Some(path) = decode_file_path_from_window_label_str(&window)? {
        invalidate_cache_for_path_sync(&app, &path);
    }
    if let Some(preview_window) = app.get_webview_window(&window) {
        preview_window
            .eval("refreshFile()")
            .map_err(|e| format!("Failed to refresh preview: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn get_file_path_from_window_label(window: tauri::Window) -> Result<Option<String>, String> {
    decode_file_path_from_window_label_str(window.label())
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
        let file_path = if let Some(encoded) = label.strip_prefix("markdown-file-") {
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(encoded)
                .ok()
                .and_then(|b| String::from_utf8(b).ok())
                .unwrap_or_default()
        } else {
            String::new()
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
            .map_err(|e| format!("Failed to focus window: {e}"))?;
        window
            .show()
            .map_err(|e| format!("Failed to show window: {e}"))?;
        Ok(())
    } else {
        Err("Window not found".to_string())
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn is_cli_installed() -> Result<bool, String> {
    Ok(PathBuf::from("/usr/local/bin/boltpage").exists())
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn is_cli_installed() -> Result<bool, String> {
    // Check if the exe directory is in PATH
    let exe_path =
        std::env::current_exe().map_err(|e| format!("Failed to get executable path: {e}"))?;
    let exe_dir = exe_path
        .parent()
        .ok_or_else(|| "Failed to get executable directory".to_string())?;
    let exe_dir_str = exe_dir.to_string_lossy().to_string();

    // Check PATH environment variable
    if let Ok(path_var) = std::env::var("PATH") {
        Ok(path_var.split(';').any(|p| p.trim() == exe_dir_str))
    } else {
        Ok(false)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
#[tauri::command]
fn is_cli_installed() -> Result<bool, String> {
    Ok(false)
}

#[tauri::command]
async fn mark_cli_setup_declined(app: AppHandle) -> Result<(), String> {
    save_preference_key_inner(&app, "cli_setup_prompted", serde_json::Value::Bool(true)).await
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn setup_cli_access() -> Result<String, String> {
    use std::process::Command;

    let script_path = "/usr/local/bin/boltpage";

    // Check if script already exists
    if PathBuf::from(script_path).exists() {
        return Ok("CLI access already configured".to_string());
    }

    // Create a shell script wrapper that uses 'open' command to properly launch the app
    // This ensures the terminal doesn't lock when launching from CLI
    // Converts relative paths to absolute paths since 'open' doesn't preserve working directory
    let script_content = r#"#!/bin/bash
# BoltPage CLI wrapper - launches app via macOS 'open' command to prevent terminal lock
if [ $# -eq 0 ]; then
    open -a BoltPage
else
    # Convert all arguments to absolute paths if they exist as files
    args=()
    for arg in "$@"; do
        if [ -e "$arg" ]; then
            # File exists, convert to absolute path
            args+=("$(cd "$(dirname "$arg")" && pwd)/$(basename "$arg")")
        else
            # Not a file, pass as-is
            args+=("$arg")
        fi
    done
    open -a BoltPage --args "${args[@]}"
fi
"#;

    // Escape single quotes in the script content for the shell command
    let escaped_content = script_content.replace("'", "'\\''");

    // Create the script using osascript to get admin privileges
    let script = format!(
        r#"do shell script "mkdir -p /usr/local/bin && printf '%s' '{escaped_content}' > '{script_path}' && chmod +x '{script_path}'" with administrator privileges"#
    );

    let output = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("Failed to execute osascript: {e}"))?;

    if output.status.success() {
        Ok(
            "CLI access configured successfully. You can now use 'boltpage' from the terminal."
                .to_string(),
        )
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("User canceled") {
            Err("Setup cancelled by user".to_string())
        } else {
            Err(format!("Failed to create CLI script: {stderr}"))
        }
    }
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn setup_cli_access() -> Result<String, String> {
    use std::process::Command;
    use winreg::enums::*;
    use winreg::RegKey;

    // Get the directory containing the executable
    let exe_path =
        std::env::current_exe().map_err(|e| format!("Failed to get executable path: {e}"))?;
    let exe_dir = exe_path
        .parent()
        .ok_or_else(|| "Failed to get executable directory".to_string())?;

    // Add to user PATH
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let env = hkcu
        .open_subkey_with_flags("Environment", KEY_READ | KEY_WRITE)
        .map_err(|e| format!("Failed to open registry key: {e}"))?;

    let current_path: String = env.get_value("Path").unwrap_or_else(|_| String::new());

    let exe_dir_str = exe_dir.to_string_lossy().to_string();

    // Check if already in PATH
    if current_path.split(';').any(|p| p.trim() == exe_dir_str) {
        return Ok("CLI access already configured".to_string());
    }

    // Append to PATH
    let new_path = if current_path.is_empty() {
        exe_dir_str
    } else {
        format!("{current_path};{exe_dir_str}")
    };

    env.set_value("Path", &new_path)
        .map_err(|e| format!("Failed to update PATH: {e}"))?;

    // Broadcast WM_SETTINGCHANGE so running processes pick up the new PATH.
    // We intentionally avoid `setx` here because it silently truncates values
    // longer than 1024 characters, which would corrupt the user's PATH.
    let _ = Command::new("cmd")
        .args(["/C", "rundll32", "user32.dll,UpdatePerUserSystemParameters"])
        .output();

    Ok("CLI access configured successfully. You may need to restart your terminal.".to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
#[tauri::command]
async fn setup_cli_access() -> Result<String, String> {
    Err("CLI setup is not supported on this platform".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    let mut file_path = args.get(1).cloned();
    // Skip arguments that look like flags
    if let Some(ref p) = file_path {
        if p.starts_with('-') {
            file_path = None;
        }
    }
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
                    eprintln!("Failed to create file from CLI arg {pathbuf:?}: {e}");
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
            save_preference_key,
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
            show_window,
            create_new_window_command,
            remove_window_from_tracking,
            get_file_path_from_window_label,
            get_all_windows,
            focus_window,
            get_syntax_css,
            render_file_to_html,
            save_html_export,
            print_current_window,
            is_cli_installed,
            mark_cli_setup_declined,
            setup_cli_access
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
                                eprintln!("Failed to create new file: {e}");
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
                        // Emit event so the focused window triggers the open file dialog
                        let _ = app.emit("menu-open", &());
                    }
                    "print" | "export-pdf" => {
                        print_focused_webview(app);
                    }
                    "export-html" => {
                        let _ = app.emit("menu-export-html", &());
                    }
                    "close" => {
                        let _ = app.emit("menu-close", &());
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
                    "setup-cli" => {
                        #[cfg(any(target_os = "macos", target_os = "windows"))]
                        {
                            let app_clone = app.clone();
                            tauri::async_runtime::spawn(async move {
                                match setup_cli_access().await {
                                    Ok(msg) => {
                                        let escaped =
                                            serde_json::to_string(&msg).unwrap_or_default();
                                        let alert = format!("alert({escaped})");
                                        if let Some((_, window)) =
                                            app_clone.webview_windows().into_iter().next()
                                        {
                                            let _ = window.eval(&alert);
                                        }
                                    }
                                    Err(err) => {
                                        let escaped = serde_json::to_string(&format!(
                                            "CLI setup failed: {err}"
                                        ))
                                        .unwrap_or_default();
                                        let alert = format!("alert({escaped})");
                                        if let Some((_, window)) =
                                            app_clone.webview_windows().into_iter().next()
                                        {
                                            let _ = window.eval(&alert);
                                        }
                                    }
                                }
                            });
                        }
                    }
                    "about" => {
                        let version = app.package_info().version.to_string();
                        let msg_text =
                            format!("BoltPage v{version}\nA fast Markdown viewer and editor");
                        let escaped = serde_json::to_string(&msg_text).unwrap_or_default();
                        let alert = format!("alert({escaped})");
                        if let Some((_, window)) = app.webview_windows().into_iter().next() {
                            let _ = window.eval(&alert);
                        }
                    }
                    _ => {}
                }
            });

            // Register CLI path as allowed before creating the window
            if let Some(ref p) = file_path {
                allow_path(app.handle(), p);
            }

            // Create initial window based on launch method
            if let Some(resolved_path) = file_path.and_then(|p| resolve_file_path(&p)) {
                // File provided via CLI - create file window immediately
                tauri::async_runtime::block_on(create_window_with_file(
                    app.handle(),
                    Some(resolved_path),
                ))?;
            } else {
                // No CLI file - yield to event loop to let queued Opened events process first
                // On macOS, double-clicking a file queues an Opened event before setup completes
                let app_handle = app.handle().clone();

                tauri::async_runtime::spawn(async move {
                    // Yield to event loop once to let Opened events process
                    // This is the standard macOS pattern - much faster than arbitrary delays
                    tokio::task::yield_now().await;

                    // Check if an Opened event already created windows
                    if app_handle.webview_windows().is_empty() {
                        // No windows were created by Opened event, create empty window
                        let _ = create_window_with_file(&app_handle, None).await;
                    }
                });
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::Resized(size) => {
                    // Debounce saves and convert to logical pixels using the
                    // window's own monitor (not primary) for correct scale factor.
                    let app = window.app_handle().clone();
                    let label = window.label().to_string();
                    if !is_preview_window_label(&label) && !is_editor_window_label(&label) {
                        return;
                    }
                    let (lw, lh) = convert_to_logical(window, size.width, size.height);

                    // Extract only the Arcs we need (not a borrow of the State)
                    let arcs = app.try_state::<AppState>().map(|state| {
                        (
                            state.inner().resize_tasks.clone(),
                            state.inner().pref_lock.clone(),
                        )
                    });

                    if let Some((resize_tasks, pref_lock)) = arcs {
                        let app_clone = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let mut tasks = resize_tasks.lock().await;

                            // Cancel previous debounce task if any
                            if let Some((handle, _, _)) = tasks.remove(&label) {
                                handle.abort();
                            }

                            // Spawn new debounced save task
                            let app_clone2 = app_clone.clone();
                            let label_for_prefs = label.clone();
                            let handle = tauri::async_runtime::spawn(async move {
                                sleep(Duration::from_millis(450)).await;

                                // Hold pref_lock for the read-modify-write cycle
                                let _lock = pref_lock.lock().await;
                                let mut prefs =
                                    get_preferences(app_clone2.clone()).unwrap_or_default();
                                if is_editor_window_label(&label_for_prefs) {
                                    prefs.editor_window_width = Some(lw);
                                    prefs.editor_window_height = Some(lh);
                                } else {
                                    prefs.window_width = lw;
                                    prefs.window_height = lh;
                                }
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
                // Register paths as allowed before creating windows
                for url in urls.iter() {
                    if let Some(path) = resolve_file_path(url.as_ref()) {
                        allow_path(_app, &path.to_string_lossy());
                    }
                }
                let app_clone = _app.clone();
                let urls = urls.clone();
                tauri::async_runtime::spawn(async move {
                    for url in urls {
                        if let Some(path) = resolve_file_path(url.as_ref()) {
                            if let Err(e) =
                                create_window_with_file(&app_clone, Some(path.clone())).await
                            {
                                eprintln!("Failed to open window for {path:?}: {e}");
                            }
                        }
                    }
                    let _ = rebuild_app_menu(&app_clone);
                });
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn unique_temp_dir() -> PathBuf {
        let dir = env::temp_dir().join(format!("boltpage-tests-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn decode_file_path_from_window_label_round_trips() {
        let path = "/tmp/example.md";
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(path.as_bytes());
        let label = format!("markdown-file-{encoded}");

        assert_eq!(
            decode_file_path_from_window_label_str(&label).unwrap(),
            Some(path.to_string())
        );
        assert_eq!(
            decode_file_path_from_window_label_str("markdown-plain").unwrap(),
            None
        );
    }

    #[test]
    fn stored_window_size_ignores_defaults_and_invalid_values() {
        assert_eq!(stored_window_size(Some(900), Some(800), 900, 800), None);
        assert_eq!(stored_window_size(Some(100), Some(800), 900, 800), None);
        assert_eq!(
            stored_window_size(Some(1200), Some(900), 900, 800),
            Some((1200.0, 900.0))
        );
    }

    #[test]
    fn remove_cache_entries_for_path_removes_all_versions() {
        let mut cache = LruCache::new(NonZeroUsize::new(8).unwrap());
        let key_a1 = CacheKey {
            path: "/tmp/a.md".to_string(),
            size: 10,
            mtime_secs: 1,
        };
        let key_a2 = CacheKey {
            path: "/tmp/a.md".to_string(),
            size: 11,
            mtime_secs: 2,
        };
        let key_b = CacheKey {
            path: "/tmp/b.md".to_string(),
            size: 20,
            mtime_secs: 1,
        };

        cache.put(key_a1.clone(), "old".to_string());
        cache.put(key_a2.clone(), "new".to_string());
        cache.put(key_b.clone(), "other".to_string());

        remove_cache_entries_for_path(&mut cache, "/tmp/a.md");

        assert!(cache.get(&key_a1).is_none());
        assert!(cache.get(&key_a2).is_none());
        assert_eq!(cache.get(&key_b).cloned(), Some("other".to_string()));
    }

    #[test]
    fn atomic_write_file_replaces_contents() {
        let dir = unique_temp_dir();
        let path = dir.join("sample.md");
        fs::write(&path, "before").unwrap();

        atomic_write_file(&path, "after").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "after");

        let leftovers: Vec<PathBuf> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok().map(|value| value.path()))
            .filter(|candidate| {
                candidate
                    .file_name()
                    .and_then(|value| value.to_str())
                    .map(|value| value.contains(".tmp"))
                    .unwrap_or(false)
            })
            .collect();
        assert!(leftovers.is_empty());

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn watch_helpers_cover_replace_style_saves() {
        let target = PathBuf::from("/tmp/notes.md");
        assert!(is_preview_window_label("markdown-file-abc"));
        assert!(is_preview_window_label("markdown-123"));
        assert!(is_editor_window_label("editor-123"));
        assert!(is_refresh_relevant_event(&notify::EventKind::Create(
            notify::event::CreateKind::File
        )));
        assert!(is_refresh_relevant_event(&notify::EventKind::Remove(
            notify::event::RemoveKind::File
        )));
        assert!(event_targets_file(std::slice::from_ref(&target), &target));
        assert!(!event_targets_file(
            &[PathBuf::from("/tmp/other.md")],
            &target
        ));
    }

    #[test]
    fn app_preferences_deserialize_toc_visibility() {
        let prefs: AppPreferences = serde_json::from_value(serde_json::json!({
            "theme": "drac",
            "window_width": 900,
            "window_height": 800,
            "toc_visible": false
        }))
        .unwrap();

        assert_eq!(prefs.toc_visible, Some(false));
    }
}
