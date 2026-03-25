use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::constants::{WINDOW_PREFIX_EDITOR, WINDOW_PREFIX_FILE, WINDOW_PREFIX_MARKDOWN};
use crate::io;
use crate::menu;
use crate::prefs::{self, AppPreferences};
use crate::AppState;

// --- Label helpers ---

pub(crate) fn is_preview_window_label(label: &str) -> bool {
    label.starts_with(WINDOW_PREFIX_MARKDOWN)
}

pub(crate) fn is_editor_window_label(label: &str) -> bool {
    label.starts_with(WINDOW_PREFIX_EDITOR)
}

pub(crate) fn decode_file_path_from_window_label_str(
    window_label: &str,
) -> Result<Option<String>, String> {
    if let Some(encoded_path) = window_label.strip_prefix(WINDOW_PREFIX_FILE) {
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

pub(crate) fn decode_editor_file_path_from_window_label_str(
    window_label: &str,
) -> Result<Option<String>, String> {
    if let Some(encoded_path) = window_label.strip_prefix(WINDOW_PREFIX_EDITOR) {
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

pub(crate) async fn create_window_with_file(
    app: &AppHandle,
    file_path: Option<PathBuf>,
) -> tauri::Result<String> {
    let prefs = prefs::get_preferences(app.clone()).unwrap_or_default();

    let (window_label, url, title) = if let Some(ref path) = file_path {
        let encoded_path = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(path.to_string_lossy().as_bytes());
        let label = format!("{WINDOW_PREFIX_FILE}{encoded_path}");
        let url = WebviewUrl::App("index.html".into());
        let title = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| format!("BoltPage - {n}"))
            .unwrap_or_else(|| "BoltPage".to_string());
        (label, url, title)
    } else {
        let label = format!("{WINDOW_PREFIX_MARKDOWN}{}", uuid::Uuid::new_v4());
        let url = WebviewUrl::App("index.html".into());
        let title = "BoltPage".to_string();
        (label, url, title)
    };

    if let Some(ref path) = file_path {
        let app_state = app.state::<AppState>();
        let open_windows = app_state.open_windows.read().await;
        if let Some(existing_label) = open_windows.get(&path.to_string_lossy().to_string()) {
            if let Some(window) = app.get_webview_window(existing_label) {
                let _ = window.set_focus();
                return Ok(existing_label.to_string());
            }
        }
        drop(open_windows);
    }

    let (width, height) = calculate_window_size(app, &prefs)?;

    let _window = WebviewWindowBuilder::new(app, &window_label, url)
        .title(&title)
        .inner_size(width, height)
        .visible(file_path.is_none())
        .initialization_script(format!(
            "document.documentElement.setAttribute('data-theme', {});",
            serde_json::to_string(&prefs.theme).unwrap()
        ))
        .build()?;

    let _ = menu::rebuild_app_menu(app);

    if let Some(path) = file_path {
        let path_str = io::pathbuf_to_string(&path);
        io::allow_path(app, &path_str);
        let app_state = app.state::<AppState>();
        let mut open_windows = app_state.open_windows.write().await;
        open_windows.insert(path_str, window_label.clone());
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
pub(crate) fn show_window(app: AppHandle, window_label: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&window_label) {
        window
            .show()
            .map_err(|e| format!("Failed to show window: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn refresh_preview(app: AppHandle, window: String) -> Result<(), String> {
    if let Some(path) = decode_file_path_from_window_label_str(&window)? {
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
    io::check_path_allowed(&app, &file_path)?;

    let encoded_path =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(file_path.as_bytes());
    let editor_label = format!("{WINDOW_PREFIX_EDITOR}{encoded_path}");

    if let Some(existing) = app.get_webview_window(&editor_label) {
        let _ = existing.set_focus();
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
    let _editor_window =
        WebviewWindowBuilder::new(&app, &editor_label, WebviewUrl::App("editor.html".into()))
            .title(format!("BoltPage Editor - {file_name}"))
            .inner_size(editor_width, editor_height)
            .initialization_script(format!(
                "window.__INITIAL_FILE_PATH__ = {}; window.__PREVIEW_WINDOW__ = {}; document.documentElement.setAttribute('data-theme', {});",
                serde_json::to_string(&file_path).unwrap(),
                serde_json::to_string(&preview_window).unwrap(),
                serde_json::to_string(&prefs.theme).unwrap()
            ))
            .build()
            .map_err(|e| format!("Failed to create editor window: {e}"))?;

    Ok(())
}

#[tauri::command]
pub(crate) async fn create_new_window_command(
    app: AppHandle,
    file_path: Option<String>,
) -> Result<String, String> {
    let resolved_path = file_path.and_then(|p| io::resolve_file_path(&p));
    create_window_with_file(&app, resolved_path)
        .await
        .map_err(|e| format!("Failed to create window: {e}"))
}

#[tauri::command]
pub(crate) async fn remove_window_from_tracking(
    app: AppHandle,
    window_label: String,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut open_windows = state.open_windows.write().await;
    open_windows.retain(|_, label| label != &window_label);
    Ok(())
}

#[tauri::command]
pub(crate) fn get_file_path_from_window_label(
    window: tauri::Window,
) -> Result<Option<String>, String> {
    decode_file_path_from_window_label_str(window.label())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct WindowInfo {
    pub label: String,
    pub title: String,
    pub file_path: String,
}

#[tauri::command]
pub(crate) fn get_all_windows(app: AppHandle) -> Result<Vec<WindowInfo>, String> {
    let mut windows = Vec::new();

    for (label, window) in app.webview_windows() {
        let title = window.title().unwrap_or_else(|_| "Untitled".to_string());
        let file_path = if let Some(encoded) = label.strip_prefix(WINDOW_PREFIX_FILE) {
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
    fn window_label_helpers() {
        assert!(is_preview_window_label("markdown-file-abc"));
        assert!(is_preview_window_label("markdown-123"));
        assert!(is_editor_window_label("editor-123"));
        assert!(!is_preview_window_label("editor-123"));
        assert!(!is_editor_window_label("markdown-file-abc"));
    }
}
