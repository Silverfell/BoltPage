use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;

use crate::AppState;

#[derive(Debug, Serialize, Deserialize)]
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
