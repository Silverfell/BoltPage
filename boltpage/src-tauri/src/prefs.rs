use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;

use crate::AppState;

// serde(default): the store is also written one key at a time by
// save_preference_key, so the map can legally hold any subset of fields.
// Without this, a partial map fails deserialization and get_preferences
// silently falls back to Default, discarding every saved preference.
#[derive(Debug, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct AppPreferences {
    pub theme: String,
    pub window_width: u32,
    pub window_height: u32,
    pub editor_window_width: Option<u32>,
    pub editor_window_height: Option<u32>,
    pub font_size: Option<u16>,
    pub word_wrap: Option<bool>,
    pub show_line_numbers: Option<bool>,
    pub toc_visible: Option<bool>,
    pub cli_setup_prompted: Option<bool>,
    pub toolbar_density: Option<String>,
    pub editor_inspector_visible: Option<bool>,
    pub recent_files: Option<Vec<String>>,
    pub document_font_family: Option<String>,
    pub editor_font_family: Option<String>,
}

impl Default for AppPreferences {
    fn default() -> Self {
        Self {
            theme: "drac".to_string(),
            window_width: 900,
            window_height: 800,
            editor_window_width: None,
            editor_window_height: None,
            font_size: None,
            word_wrap: None,
            show_line_numbers: None,
            toc_visible: None,
            cli_setup_prompted: None,
            toolbar_density: None,
            editor_inspector_visible: None,
            recent_files: None,
            document_font_family: None,
            editor_font_family: None,
        }
    }
}

#[tauri::command]
pub(crate) fn get_preferences(app: AppHandle) -> Result<AppPreferences, String> {
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
pub(crate) fn save_preferences(app: AppHandle, preferences: AppPreferences) -> Result<(), String> {
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
pub(crate) async fn save_preference_key_inner(
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
pub(crate) async fn save_preference_key(
    app: AppHandle,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    save_preference_key_inner(&app, &key, value).await
}

#[tauri::command]
pub(crate) async fn mark_cli_setup_declined(app: AppHandle) -> Result<(), String> {
    save_preference_key_inner(&app, "cli_setup_prompted", serde_json::Value::Bool(true)).await
}

/// Read a Vec<String> entry from the preferences map. Returns empty on any
/// missing/parse failure (the store may legally hold a partial map).
fn read_string_list(app: &AppHandle, key: &str) -> Vec<String> {
    let Ok(store) = app.store(".boltpage.dat") else {
        return Vec::new();
    };
    store
        .get("preferences")
        .and_then(|v| {
            serde_json::from_value::<serde_json::Map<String, serde_json::Value>>(v.clone()).ok()
        })
        .and_then(|map| {
            map.get(key)
                .and_then(|v| serde_json::from_value::<Vec<String>>(v.clone()).ok())
        })
        .unwrap_or_default()
}

/// Raw recent-files list, most-recent first. Dead paths are NOT filtered here;
/// call sites decide (menu and get_recent_files filter, validation does not).
pub(crate) fn read_recent_paths(app: &AppHandle) -> Vec<String> {
    read_string_list(app, "recent_files")
}

/// Ordered list of files that were open in preview windows (session restore).
pub(crate) fn read_session_paths(app: &AppHandle) -> Vec<String> {
    read_string_list(app, "session_files")
}

/// Read a single string entry from the preferences map (None when missing,
/// null, or unparseable).
pub(crate) fn read_string_pref(app: &AppHandle, key: &str) -> Option<String> {
    let store = app.store(".boltpage.dat").ok()?;
    store
        .get("preferences")
        .and_then(|v| {
            serde_json::from_value::<serde_json::Map<String, serde_json::Value>>(v.clone()).ok()
        })
        .and_then(|map| map.get(key).and_then(|v| v.as_str().map(|s| s.to_string())))
}

#[derive(Debug, Serialize)]
pub(crate) struct RecentFile {
    pub path: String,
    pub display_name: String,
    pub directory: String,
    pub modified_ts: Option<u64>,
}

#[tauri::command]
pub(crate) async fn get_recent_files(app: AppHandle) -> Result<Vec<RecentFile>, String> {
    let paths = read_recent_paths(&app);

    let mut out: Vec<RecentFile> = Vec::with_capacity(paths.len());
    for raw in paths {
        let p = Path::new(&raw);
        if !p.exists() {
            continue;
        }
        let display_name = p
            .file_name()
            .and_then(|n| n.to_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| raw.clone());
        let directory = p
            .parent()
            .map(|d| d.to_string_lossy().to_string())
            .unwrap_or_default();
        let modified_ts = fs::metadata(p)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs());
        out.push(RecentFile {
            path: raw,
            display_name,
            directory,
            modified_ts,
        });
    }

    Ok(out)
}
