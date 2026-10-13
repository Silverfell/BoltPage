use lru::LruCache;
use std::collections::HashMap;
use std::fs;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tokio::sync::{Mutex, RwLock};
use tokio::time::{sleep, Duration};

// Conditional debug logging (only in debug builds)
// Must be defined before mod declarations so submodules can use it.
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

mod constants;
mod grants;
mod io;
mod launch_gate;
mod menu;
mod prefs;
mod registry;
mod watchers;
mod window;
mod workspace;

/// Set on RunEvent::ExitRequested. Window-close cleanup consults it so windows
/// closed as a side effect of quitting keep their session entries (next launch
/// restores them); only user-initiated closes remove entries.
pub(crate) static QUITTING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Type alias for resize task map to reduce complexity
type ResizeTaskMap = HashMap<String, (tauri::async_runtime::JoinHandle<()>, u32, u32)>;

/// Application state with optimized concurrency patterns
///
/// Uses RwLock for read-heavy operations (html_cache)
/// Uses Mutex only where writes are frequent or exclusive access needed
struct AppState {
    /// Which file each viewer and editor window shows.
    windows: registry::Registry,

    /// Debounced resize tasks per window label
    /// Writes on every resize event, so Mutex is appropriate
    resize_tasks: Arc<Mutex<ResizeTaskMap>>,

    /// HTML render cache: (path, size, mtime_secs) -> HTML
    /// Read-heavy workload with LRU eviction
    html_cache: Arc<RwLock<LruCache<io::CacheKey, String>>>,

    /// Files and workspace folders that file I/O commands may touch.
    grants: grants::Grants,

    /// Decides which windows a launch may show.
    launch_gate: launch_gate::LaunchGate,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            windows: registry::Registry::default(),
            resize_tasks: Arc::new(Mutex::new(HashMap::new())),
            html_cache: Arc::new(RwLock::new(LruCache::new(
                std::num::NonZeroUsize::new(50).unwrap(),
            ))),
            grants: grants::Grants::default(),
            launch_gate: launch_gate::LaunchGate::default(),
        }
    }
}

// --- CLI commands (platform-specific, coupled to run()) ---

#[cfg(target_os = "macos")]
#[tauri::command]
fn is_cli_installed() -> Result<bool, String> {
    Ok(PathBuf::from("/usr/local/bin/boltpage").exists())
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn is_cli_installed() -> Result<bool, String> {
    let exe_path =
        std::env::current_exe().map_err(|e| format!("Failed to get executable path: {e}"))?;
    let exe_dir = exe_path
        .parent()
        .ok_or_else(|| "Failed to get executable directory".to_string())?;
    let exe_dir_str = exe_dir.to_string_lossy().to_string();

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

#[cfg(target_os = "macos")]
#[tauri::command]
async fn setup_cli_access() -> Result<String, String> {
    use std::process::Command;

    let script_path = "/usr/local/bin/boltpage";

    if PathBuf::from(script_path).exists() {
        return Ok("CLI access already configured".to_string());
    }

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

    // Write the wrapper to a temp file first: embedding the multiline,
    // double-quote-laden script directly in an AppleScript string literal is
    // not possible (raw `"` and newlines terminate the literal). The shell
    // command below contains only single-quoted paths, which are safe inside
    // an AppleScript double-quoted string.
    let temp_path = std::env::temp_dir().join(format!("boltpage-cli-{}.sh", uuid::Uuid::new_v4()));
    fs::write(&temp_path, script_content)
        .map_err(|e| format!("Failed to write temp CLI script: {e}"))?;
    let temp_str = temp_path.to_string_lossy();

    let script = format!(
        r#"do shell script "mkdir -p /usr/local/bin && cp '{temp_str}' '{script_path}' && chmod +x '{script_path}'" with administrator privileges"#
    );

    let output = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("Failed to execute osascript: {e}"));

    let _ = fs::remove_file(&temp_path);
    let output = output?;

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

    let exe_path =
        std::env::current_exe().map_err(|e| format!("Failed to get executable path: {e}"))?;
    let exe_dir = exe_path
        .parent()
        .ok_or_else(|| "Failed to get executable directory".to_string())?;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let env = hkcu
        .open_subkey_with_flags("Environment", KEY_READ | KEY_WRITE)
        .map_err(|e| format!("Failed to open registry key: {e}"))?;

    let current_path: String = env.get_value("Path").unwrap_or_else(|_| String::new());

    let exe_dir_str = exe_dir.to_string_lossy().to_string();

    if current_path.split(';').any(|p| p.trim() == exe_dir_str) {
        return Ok("CLI access already configured".to_string());
    }

    let new_path = if current_path.is_empty() {
        exe_dir_str
    } else {
        format!("{current_path};{exe_dir_str}")
    };

    env.set_value("Path", &new_path)
        .map_err(|e| format!("Failed to update PATH: {e}"))?;

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

// --- App entry point ---

/// One-time startup window resolution, run on RunEvent::Ready.
///
/// - CLI launch: windows already created in setup; nothing to do.
/// - Document launch already observed (recorded synchronously at
///   RunEvent::Opened delivery): nothing to do — the Opened handler opens the
///   clicked files. This check is a fast path only, not a correctness deadline:
///   session/welcome windows created below stay hidden and startup-gated, and
///   show_window destroys any still-gated window if a document launch is
///   observed by its show moment (see window::show_window).
async fn resolve_startup_windows(app: tauri::AppHandle) {
    if app.state::<AppState>().launch_gate.skip_startup() {
        return;
    }

    // Restore the previous session (preview windows open at last quit),
    // oldest-opened first.
    let session: Vec<std::path::PathBuf> = prefs::read_session_paths(&app)
        .iter()
        .filter(|p| std::path::Path::new(p).exists())
        .filter_map(|p| io::resolve_file_path(p))
        .collect();
    // Sequential awaits: restore windows in saved order; each open re-appends to
    // the session list, preserving it.
    for path in session {
        if let Err(e) = window::create_window_with_file(&app, Some(path.clone()), true).await {
            eprintln!("Failed to restore session window for {path:?}: {e}");
        }
    }

    // Welcome fallback: only when nothing is open and no Launch Services file
    // opened a document. create_window_with_file(None) is the welcome card.
    let nothing_open = app.webview_windows().is_empty();
    if nothing_open && app.state::<AppState>().launch_gate.welcome_allowed() {
        match window::create_window_with_file(&app, None, true).await {
            Ok(label) => app.state::<AppState>().launch_gate.set_welcome(label),
            Err(e) => eprintln!("Failed to create welcome window: {e}"),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    // All non-flag arguments are files to open; the CLI wrapper passes every
    // argument through, so dropping all but the first would lose files.
    let mut file_paths: Vec<String> = Vec::new();
    for raw in args.iter().skip(1) {
        if raw.starts_with('-') {
            continue;
        }
        if let Some(pathbuf) = io::resolve_file_path(raw) {
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
            file_paths.push(pathbuf.to_string_lossy().to_string());
        }
    }

    let app_state = AppState::default();

    tauri::Builder::default()
        .manage(app_state)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            io::read_file,
            io::read_file_bytes_b64,
            io::write_file,
            io::is_writable,
            io::format_json_pretty,
            io::render_buffer_to_html,
            io::render_file_to_html,
            io::save_html_export,
            io::open_file_dialog,
            io::open_tracked_file,
            io::resolve_doc_link,
            io::load_doc_asset,
            io::get_custom_css,
            io::open_custom_css,
            io::save_clipboard_image,
            io::create_new_markdown_file,
            prefs::save_preference_key,
            prefs::get_preferences,
            prefs::mark_cli_setup_declined,
            prefs::get_recent_files,
            menu::broadcast_scroll_sync,
            menu::broadcast_theme_change,
            menu::broadcast_toolbar_density_change,
            menu::broadcast_font_size_change,
            menu::broadcast_font_family_change,
            menu::broadcast_editor_window_closed,
            menu::broadcast_editor_buffer,
            menu::get_syntax_css,
            watchers::start_file_watcher,
            watchers::stop_file_watcher,
            workspace::open_folder_dialog,
            workspace::get_workspace_folder,
            workspace::clear_workspace_folder,
            workspace::list_dir,
            workspace::list_workspace_files,
            workspace::search_workspace,
            window::show_window,
            window::print_current_window,
            window::refresh_preview,
            window::open_editor_window,
            window::create_new_window_command,
            window::get_all_windows,
            window::focus_window,
            is_cli_installed,
            setup_cli_access
        ])
        .setup(move |app| {
            app.manage(watchers::FileWatchers::default());

            menu::rebuild_app_menu(app.handle())?;

            app.on_menu_event(|app, event| {
                use crate::constants::*;

                // Table: menu IDs that simply emit an event to the focused window.
                // Cut/Copy/Paste/Undo/Redo/Select All are PredefinedMenuItem and
                // never reach this callback; the OS routes them to the responder.
                const EMIT_ACTIONS: &[(&str, &str)] = &[
                    (MENU_OPEN, EVENT_MENU_OPEN),
                    (MENU_OPEN_FOLDER, EVENT_MENU_OPEN_FOLDER),
                    (MENU_CLOSE, EVENT_MENU_CLOSE),
                    (MENU_FIND, EVENT_MENU_FIND),
                    (MENU_FIND_NEXT, EVENT_MENU_FIND_NEXT),
                    (MENU_FIND_PREV, EVENT_MENU_FIND_PREV),
                    (MENU_FIND_USE_SELECTION, EVENT_MENU_FIND_USE_SELECTION),
                    (MENU_FIND_REPLACE, EVENT_MENU_FIND_REPLACE),
                    (MENU_EXPORT_HTML, EVENT_MENU_EXPORT_HTML),
                    (MENU_FORMAT_BOLD, EVENT_MENU_FORMAT_BOLD),
                    (MENU_FORMAT_ITALIC, EVENT_MENU_FORMAT_ITALIC),
                    (MENU_FORMAT_LINK, EVENT_MENU_FORMAT_LINK),
                    (MENU_FORMAT_STRIKE, EVENT_MENU_FORMAT_STRIKE),
                    (MENU_COMMAND_PALETTE, EVENT_MENU_COMMAND_PALETTE),
                ];

                let id = event.id().as_ref();

                if let Some((_, event_name)) =
                    EMIT_ACTIONS.iter().find(|(menu_id, _)| *menu_id == id)
                {
                    let _ = app.emit(event_name, &());
                } else if let Some(label) = id.strip_prefix(MENU_WINDOW_PREFIX) {
                    if let Some(w) = app.get_webview_window(label) {
                        let _ = w.set_focus();
                        let _ = w.show();
                    }
                } else if id == MENU_RECENT_CLEAR {
                    let app_clone = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = prefs::save_preference_key_inner(
                            &app_clone,
                            "recent_files",
                            serde_json::Value::Array(Vec::new()),
                        )
                        .await
                        {
                            eprintln!("Failed to clear recents: {e}");
                        }
                        let _ = menu::rebuild_app_menu(&app_clone);
                    });
                } else if let Some(path) = menu::decode_recent_menu_id(id) {
                    // The id was built from our own recents store, so clicking
                    // it is user intent: the open grants access like a dialog
                    // pick.
                    let app_clone = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Some(resolved) = io::resolve_file_path(&path) {
                            if let Err(e) =
                                window::create_window_with_file(&app_clone, Some(resolved), false)
                                    .await
                            {
                                eprintln!("Failed to open recent file: {e}");
                            }
                        }
                    });
                } else {
                    match id {
                        MENU_NEW_FILE => {
                            let app_clone = app.clone();
                            tauri::async_runtime::spawn(async move {
                                if let Err(e) = io::create_new_markdown_file(app_clone).await {
                                    eprintln!("Failed to create new file: {e}");
                                }
                            });
                        }
                        MENU_NEW_WINDOW => {
                            let app_clone = app.clone();
                            tauri::async_runtime::spawn(async move {
                                let _ = window::create_new_window_command(app_clone).await;
                            });
                        }
                        MENU_PRINT | MENU_EXPORT_PDF => {
                            window::print_focused_webview(app);
                        }
                        MENU_QUIT => {
                            app.exit(0);
                        }
                        MENU_SETUP_CLI => {
                            #[cfg(any(target_os = "macos", target_os = "windows"))]
                            {
                                let app_clone = app.clone();
                                tauri::async_runtime::spawn(async move {
                                    match setup_cli_access().await {
                                        Ok(msg) => {
                                            let escaped =
                                                serde_json::to_string(&msg).unwrap_or_default();
                                            let alert = format!("alert({escaped})");
                                            if let Some((_, w)) =
                                                app_clone.webview_windows().into_iter().next()
                                            {
                                                let _ = w.eval(&alert);
                                            }
                                        }
                                        Err(err) => {
                                            let escaped = serde_json::to_string(&format!(
                                                "CLI setup failed: {err}"
                                            ))
                                            .unwrap_or_default();
                                            let alert = format!("alert({escaped})");
                                            if let Some((_, w)) =
                                                app_clone.webview_windows().into_iter().next()
                                            {
                                                let _ = w.eval(&alert);
                                            }
                                        }
                                    }
                                });
                            }
                        }
                        MENU_ABOUT => {
                            let version = app.package_info().version.to_string();
                            let msg_text =
                                format!("BoltPage v{version}\nA fast Markdown viewer and editor");
                            let escaped = serde_json::to_string(&msg_text).unwrap_or_default();
                            let alert = format!("alert({escaped})");
                            if let Some((_, w)) = app.webview_windows().into_iter().next() {
                                let _ = w.eval(&alert);
                            }
                        }
                        _ => {}
                    }
                }
            });

            let mut resolved: Vec<std::path::PathBuf> = file_paths
                .iter()
                .filter_map(|p| io::resolve_file_path(p))
                .collect();

            if !resolved.is_empty() {
                // CLI files: open them now, before the event loop starts. Flag
                // the launch so resolve_startup_windows (RunEvent::Ready) skips
                // session restore, matching the prior CLI-launch behavior.
                app.handle()
                    .state::<AppState>()
                    .launch_gate
                    .request_documents(
                        resolved.iter().map(|p| p.to_string_lossy().to_string()),
                        true,
                    );
                let first = resolved.remove(0);
                tauri::async_runtime::block_on(window::create_window_with_file(
                    app.handle(),
                    Some(first),
                    false,
                ))?;
                // No welcome window exists on a CLI launch; this only records
                // that a requested document opened.
                app.handle()
                    .state::<AppState>()
                    .launch_gate
                    .opens_finished(true, |_| false);
                if !resolved.is_empty() {
                    let handle = app.handle().clone();
                    tauri::async_runtime::spawn(async move {
                        // Sequential awaits: windows open in argument order and each
                        // open appends to the session list and recents.
                        for path in resolved {
                            if let Err(e) =
                                window::create_window_with_file(&handle, Some(path.clone()), false)
                                    .await
                            {
                                eprintln!("Failed to open window for {path:?}: {e}");
                            }
                        }
                        let _ = menu::rebuild_app_menu(&handle);
                    });
                }
            }
            // The no-CLI case (session restore, else the welcome window) runs in
            // resolve_startup_windows on RunEvent::Ready, so a Launch Services
            // file-open (RunEvent::Opened) can suppress or reclaim the welcome
            // window regardless of Opened-vs-Ready delivery order.

            Ok(())
        })
        .on_window_event(|win, event| match event {
            tauri::WindowEvent::Resized(size) => {
                let app = win.app_handle().clone();
                let label = win.label().to_string();
                if !window::is_preview_window_label(&label)
                    && !window::is_editor_window_label(&label)
                {
                    return;
                }
                let (lw, lh) = window::convert_to_logical(win, size.width, size.height);

                let resize_tasks = app
                    .try_state::<AppState>()
                    .map(|state| state.inner().resize_tasks.clone());

                if let Some(resize_tasks) = resize_tasks {
                    let app_clone = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let mut tasks = resize_tasks.lock().await;

                        if let Some((handle, _, _)) = tasks.remove(&label) {
                            handle.abort();
                        }

                        let app_clone2 = app_clone.clone();
                        let label_for_prefs = label.clone();
                        let handle = tauri::async_runtime::spawn(async move {
                            sleep(Duration::from_millis(450)).await;

                            let editor = window::is_editor_window_label(&label_for_prefs);
                            let _ = prefs::update(&app_clone2, |map| {
                                prefs::set_window_size(map, editor, lw, lh)
                            })
                            .await;
                        });

                        tasks.insert(label, (handle, lw, lh));
                    });
                }
            }
            tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed => {
                let app = win.app_handle().clone();
                let window_label = win.label().to_string();
                let destroyed = matches!(event, tauri::WindowEvent::Destroyed);

                if window::is_editor_window_label(&window_label) {
                    // The editor can refuse a close request (a failed save
                    // keeps the window), so it leaves the registry only once
                    // destroyed; a file must never get a second editor.
                    if !destroyed {
                        let windows = &app.state::<AppState>().windows;
                        if let Some(file_path) = windows.file_of(&window_label) {
                            let _ = menu::broadcast_editor_window_closed(
                                app.clone(),
                                menu::EditorWindowClosedPayload {
                                    preview_window: windows
                                        .preview_of(&window_label)
                                        .unwrap_or_default(),
                                    file_path,
                                },
                            );
                        }
                        return;
                    }
                } else if destroyed {
                    return;
                }

                tauri::async_runtime::spawn(async move {
                    // During quit, windows close as a side effect: keep the
                    // session so the next launch restores it. Only
                    // user-initiated closes drop entries.
                    let keep_session = QUITTING.load(std::sync::atomic::Ordering::SeqCst);
                    if let Err(e) = window::apply_transition(
                        &app,
                        &window_label,
                        window::Transition::Closed { keep_session },
                    )
                    .await
                    {
                        eprintln!("Failed to update session list: {e}");
                    }
                });
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // Covers Cmd+Q (PredefinedMenuItem::quit), the Windows File > Quit
            // item (app.exit), and last-window-closed exits.
            if matches!(_event, tauri::RunEvent::ExitRequested { .. }) {
                QUITTING.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            // Startup window resolution runs here (not in setup) so any Launch
            // Services file-open delivered via RunEvent::Opened is already known.
            if matches!(_event, tauri::RunEvent::Ready) {
                tauri::async_runtime::spawn(resolve_startup_windows(_app.clone()));
            }
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                // Record the document launch synchronously at event delivery:
                // the show-time gate and the startup resolver read these. A
                // store deferred to the spawned task races window creation
                // (the original cold-start session-restore bug).
                {
                    let state = _app.state::<AppState>();
                    let doc_paths: Vec<String> = urls
                        .iter()
                        .filter_map(|url| io::resolve_file_path(url.as_ref()))
                        .map(|path| path.to_string_lossy().to_string())
                        .collect();
                    state.launch_gate.request_documents(doc_paths, false);
                }
                let app_clone = _app.clone();
                let urls = urls.clone();
                tauri::async_runtime::spawn(async move {
                    let mut opened_any = false;
                    for url in urls {
                        if let Some(path) = io::resolve_file_path(url.as_ref()) {
                            let mut result = window::create_window_with_file(
                                &app_clone,
                                Some(path.clone()),
                                false,
                            )
                            .await;
                            if result.is_err() {
                                // REASON: single retry after a short delay —
                                // webview creation can fail transiently.
                                sleep(Duration::from_millis(150)).await;
                                result = window::create_window_with_file(
                                    &app_clone,
                                    Some(path.clone()),
                                    false,
                                )
                                .await;
                            }
                            match result {
                                Ok(_) => opened_any = true,
                                Err(e) => eprintln!("Failed to open window for {path:?}: {e}"),
                            }
                        }
                    }
                    // A success reclaims the startup welcome window while
                    // it is still pristine (no file in the registry); a batch
                    // that failed entirely, with no success before it, clears
                    // the launch intent (see LaunchGate::opens_finished).
                    let state = app_clone.state::<AppState>();
                    let reclaim = state
                        .launch_gate
                        .opens_finished(opened_any, |label| state.windows.file_of(label).is_some());
                    if let Some(w) = reclaim.and_then(|label| app_clone.get_webview_window(&label))
                    {
                        let _ = w.destroy();
                    }
                    let _ = menu::rebuild_app_menu(&app_clone);
                });
            }
        });
}

#[cfg(test)]
mod tests {
    use crate::prefs::AppPreferences;

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

    /// The store is written one key at a time, so it holds a partial map.
    /// serde(default) must fill the missing fields instead of
    /// failing deserialization (which silently reset every preference).
    #[test]
    fn app_preferences_deserialize_partial_map_keeps_known_keys() {
        let prefs: AppPreferences = serde_json::from_value(serde_json::json!({
            "theme": "light",
            "font_size": 20
        }))
        .unwrap();

        assert_eq!(prefs.theme, "light");
        assert_eq!(prefs.font_size, Some(20));
        assert_eq!(prefs.window_width, 900);
        assert_eq!(prefs.window_height, 800);
    }
}
