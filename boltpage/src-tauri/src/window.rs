use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::constants::{WINDOW_PREFIX_EDITOR, WINDOW_PREFIX_FILE, WINDOW_PREFIX_MARKDOWN};
use crate::io;
use crate::launch_gate::ShowDecision;
use crate::menu;
use crate::prefs::{self, AppPreferences};
use crate::registry::{self, Change};
use crate::watchers;
use crate::AppState;

// --- Label helpers ---

pub(crate) fn is_preview_window_label(label: &str) -> bool {
    label.starts_with(WINDOW_PREFIX_MARKDOWN)
}

pub(crate) fn is_editor_window_label(label: &str) -> bool {
    label.starts_with(WINDOW_PREFIX_EDITOR)
}

// --- Registry transitions ---

/// A change to which file a window shows.
pub(crate) enum Transition<'a> {
    /// The window was built for the entry `Registry::open_viewer` reserved
    /// (an empty change for a blank window). `recent` is false for session
    /// restore, which reopens files without the user asking for them.
    Opened { change: Change, recent: bool },
    /// The window's frontend opens another file in place.
    Switch(&'a str),
    /// The window is going away. `keep_session` leaves its file in the saved
    /// session: quit and the startup gate close windows the next launch
    /// should still restore.
    Closed { keep_session: bool },
}

/// Canonicalize a path for the recents list. Falls back to the raw string if
/// the file does not yet exist.
fn normalize_path(path: &str) -> String {
    fs::canonicalize(path)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| path.to_string())
}

/// Every change to which file a window shows goes through here: the registry
/// records it, and the path grant, saved session, recents, file watcher and
/// menu follow from what it reports.
pub(crate) async fn apply_transition(
    app: &AppHandle,
    label: &str,
    transition: Transition<'_>,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let (change, recent, keep_session) = match transition {
        // Window creation is reached only from trusted entry points (CLI,
        // Launch Services, recents menu, save dialog), so the file is granted.
        Transition::Opened { change, recent } => {
            if let Some(path) = &change.shown {
                state.grants.grant_path(path);
            }
            (change, recent, false)
        }
        // An in-window open (welcome-card recents, the open dialog, the
        // workspace tree) comes from the webview: the path must already be
        // allowed, or be a known recent.
        Transition::Switch(path) => {
            if state.grants.authorize(path).is_err() {
                let canonical = normalize_path(path);
                let known_recent = prefs::read_recent_paths(app)
                    .iter()
                    .any(|r| normalize_path(r) == canonical);
                if !known_recent {
                    return Err("Access denied: path not authorized".to_string());
                }
                state.grants.grant_path(path);
            }
            (state.windows.switch_file(label, path), true, false)
        }
        Transition::Closed { keep_session } => {
            let _ = watchers::stop_file_watcher(app.clone(), label.to_string()).await;
            (state.windows.close(label), false, keep_session)
        }
    };

    let dropped = if keep_session {
        Vec::new()
    } else {
        change.dropped
    };
    let saved = if change.shown.is_none() && dropped.is_empty() {
        Ok(())
    } else {
        prefs::update(app, |map| {
            for path in &dropped {
                prefs::session_remove(map, path);
            }
            if let Some(path) = &change.shown {
                prefs::session_add(map, path);
                if recent {
                    prefs::push_recent(map, &normalize_path(path));
                }
            }
        })
        .await
    };

    // The Window and Open Recent submenus both follow from the above.
    let _ = menu::rebuild_app_menu(app);
    saved
}

// --- Size helpers ---

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

pub(crate) fn stored_window_size(
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

fn calculate_window_size(app: &AppHandle, prefs: &AppPreferences) -> tauri::Result<(f64, f64)> {
    if let Some(size) = stored_window_size(
        Some(prefs.window_width),
        Some(prefs.window_height),
        900,
        800,
    ) {
        return Ok(size);
    }

    if let Ok(Some(monitor)) = app.primary_monitor() {
        let monitor_size = monitor.size();
        let scale_factor = monitor.scale_factor();
        let logical_height = monitor_size.height as f64 / scale_factor;
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

pub(crate) fn convert_to_logical(window: &tauri::Window, width: u32, height: u32) -> (u32, u32) {
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

// --- Window creation ---

/// `startup_gated`: true only for windows the startup resolver creates (session
/// restore, welcome). Their labels enter the launch gate so show_window can veto
/// them if a document launch is observed by their show moment.
pub(crate) async fn create_window_with_file(
    app: &AppHandle,
    file_path: Option<PathBuf>,
    startup_gated: bool,
) -> tauri::Result<String> {
    let prefs = prefs::get_preferences(app.clone()).unwrap_or_default();
    let (width, height) = calculate_window_size(app, &prefs)?;
    let state = app.state::<AppState>();

    let mut init_script = format!(
        "document.documentElement.setAttribute('data-theme', {});",
        serde_json::to_string(&prefs.theme).unwrap()
    );
    let (window_label, title, change) = if let Some(ref path) = file_path {
        let path_str = io::pathbuf_to_string(path);
        let label = registry::new_label(WINDOW_PREFIX_FILE);
        // Registering before the window is built makes concurrent opens of
        // one file settle on a single window.
        let change = match state.windows.open_viewer(&label, &path_str) {
            Ok(change) => change,
            Err(existing_label) => {
                if !startup_gated {
                    // An explicit open landing on a window the startup resolver
                    // created un-gates it: the user asked for this file, so its
                    // show moment must show it.
                    state.launch_gate.ungate(&existing_label);
                    // No transition happens, but the open still counts as
                    // recent.
                    if let Err(e) = io::push_to_recents(app, &path_str).await {
                        eprintln!("Failed to push recents: {e}");
                    }
                }
                // No window yet means a concurrent open is still building it.
                if let Some(window) = app.get_webview_window(&existing_label) {
                    let _ = window.set_focus();
                }
                return Ok(existing_label);
            }
        };
        init_script.push_str(&format!(
            " window.__INITIAL_FILE_PATH__ = {};",
            serde_json::to_string(&path_str).unwrap()
        ));
        let title = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| format!("BoltPage - {n}"))
            .unwrap_or_else(|| "BoltPage".to_string());
        (label, title, change)
    } else {
        let label = registry::new_label(WINDOW_PREFIX_MARKDOWN);
        (label, "BoltPage".to_string(), Change::default())
    };

    // All windows start hidden; the frontend invokes show_window after its
    // first render (the show-time gate lives there).
    let built = WebviewWindowBuilder::new(app, &window_label, WebviewUrl::App("index.html".into()))
        .title(&title)
        .inner_size(width, height)
        .visible(false)
        .initialization_script(init_script)
        .build();
    if let Err(e) = built {
        state.windows.close(&window_label);
        return Err(e);
    }

    if startup_gated {
        state.launch_gate.gate(&window_label);
    }

    let opened = Transition::Opened {
        change,
        recent: !startup_gated,
    };
    if let Err(e) = apply_transition(app, &window_label, opened).await {
        eprintln!("Failed to update session list: {e}");
    }

    Ok(window_label)
}

// --- Print ---

pub(crate) fn print_focused_webview(app: &AppHandle) {
    for (_, window) in app.webview_windows() {
        if window.is_focused().unwrap_or(false) {
            let _ = window.print();
            return;
        }
    }
}

#[tauri::command]
pub(crate) fn print_current_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.print().map_err(|e| format!("Print failed: {e}"))
}

// --- Tauri commands ---

#[tauri::command]
pub(crate) async fn show_window(app: AppHandle, window_label: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    // The show-time gate: a startup window (session restore / welcome) reaching
    // its show moment after a document launch was observed is destroyed unseen —
    // unless it is itself a requested document, in which case it IS the doc
    // window and must show (also keeps the Opened dedupe from ever racing a
    // destroy of the window it lands on).
    let file = state.windows.file_of(&window_label);
    if state.launch_gate.on_show(&window_label, file.as_deref()) == ShowDecision::Destroy {
        // Deliberately keep_session: the saved session must survive a
        // file launch so the next plain launch still restores it.
        let _ = apply_transition(
            &app,
            &window_label,
            Transition::Closed { keep_session: true },
        )
        .await;
        if let Some(window) = app.get_webview_window(&window_label) {
            let _ = window.destroy();
        }
        // Again, now that the window is gone from the Window submenu.
        let _ = menu::rebuild_app_menu(&app);
        return Ok(());
    }
    if let Some(window) = app.get_webview_window(&window_label) {
        window
            .show()
            .map_err(|e| format!("Failed to show window: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn refresh_preview(app: AppHandle, window: String) -> Result<(), String> {
    if let Some(path) = app.state::<AppState>().windows.file_of(&window) {
        io::invalidate_cache_for_path_sync(&app, &path);
    }
    if let Some(preview_window) = app.get_webview_window(&window) {
        preview_window
            .eval("refreshFile()")
            .map_err(|e| format!("Failed to refresh preview: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn open_editor_window(
    app: AppHandle,
    file_path: String,
    preview_window: String,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    state.grants.authorize(&file_path)?;

    let editor_label = registry::new_label(WINDOW_PREFIX_EDITOR);
    if let Err(existing_label) =
        state
            .windows
            .open_editor(&editor_label, &file_path, &preview_window)
    {
        if let Some(existing) = app.get_webview_window(&existing_label) {
            let _ = existing.set_focus();
        }
        return Ok(());
    }

    let file_name = Path::new(&file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Untitled");
    let prefs = prefs::get_preferences(app.clone()).unwrap_or_default();
    let (editor_width, editor_height) = stored_window_size(
        prefs.editor_window_width,
        prefs.editor_window_height,
        800,
        600,
    )
    .unwrap_or((800.0, 600.0));
    let built =
        WebviewWindowBuilder::new(&app, &editor_label, WebviewUrl::App("editor.html".into()))
            .title(format!("BoltPage Editor - {file_name}"))
            .inner_size(editor_width, editor_height)
            .initialization_script(format!(
                "window.__INITIAL_FILE_PATH__ = {}; window.__PREVIEW_WINDOW__ = {}; document.documentElement.setAttribute('data-theme', {});",
                serde_json::to_string(&file_path).unwrap(),
                serde_json::to_string(&preview_window).unwrap(),
                serde_json::to_string(&prefs.theme).unwrap()
            ))
            .build();
    if let Err(e) = built {
        state.windows.close(&editor_label);
        return Err(format!("Failed to create editor window: {e}"));
    }

    Ok(())
}

#[tauri::command]
pub(crate) async fn create_new_window_command(app: AppHandle) -> Result<String, String> {
    // Always a blank window: the webview must not be able to pass an arbitrary
    // path here, because create_window_with_file grants it via Grants::grant_path.
    // File-bearing opens go through trusted Rust entry points (CLI, Launch
    // Services, recents/menu) that call create_window_with_file directly.
    create_window_with_file(&app, None, false)
        .await
        .map_err(|e| format!("Failed to create window: {e}"))
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct WindowInfo {
    pub label: String,
    pub title: String,
    pub file_path: String,
}

#[tauri::command]
pub(crate) fn get_all_windows(app: AppHandle) -> Result<Vec<WindowInfo>, String> {
    let state = app.state::<AppState>();
    let mut windows = Vec::new();

    for (label, window) in app.webview_windows() {
        let title = window.title().unwrap_or_else(|_| "Untitled".to_string());
        let file_path = state.windows.file_of(&label).unwrap_or_default();

        windows.push(WindowInfo {
            label: label.to_string(),
            title,
            file_path,
        });
    }

    Ok(windows)
}

#[tauri::command]
pub(crate) fn focus_window(app: AppHandle, window_label: String) -> Result<(), String> {
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

// --- Tests ---

#[cfg(test)]
mod tests {
    use super::*;

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
    fn window_label_helpers() {
        let viewer = registry::new_label(WINDOW_PREFIX_FILE);
        let blank = registry::new_label(WINDOW_PREFIX_MARKDOWN);
        let editor = registry::new_label(WINDOW_PREFIX_EDITOR);
        assert!(is_preview_window_label(&viewer));
        assert!(is_preview_window_label(&blank));
        assert!(is_editor_window_label(&editor));
        assert!(!is_preview_window_label(&editor));
        assert!(!is_editor_window_label(&viewer));
    }
}
