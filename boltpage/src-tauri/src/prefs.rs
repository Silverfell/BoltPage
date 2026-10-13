use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;
use tokio::sync::Mutex;

use crate::constants::MAX_RECENT_FILES;

// The typed read view get_preferences returns. serde(default): the store is
// written one key at a time, so the map can legally hold any subset of fields.
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
    pub editor_vim_mode: Option<bool>,
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
            editor_vim_mode: None,
        }
    }
}

type PrefMap = serde_json::Map<String, serde_json::Value>;

/// Serializes read-modify-write cycles on the preference store so concurrent
/// saves cannot overwrite each other. Private: update() is the only taker.
static PREF_LOCK: Mutex<()> = Mutex::const_new(());

/// Keys the path grants trust: a known recent is granted on open, a session
/// file on restore and the workspace folder on read. Only Rust code that saw
/// the user's pick writes them, so the webview cannot grant itself a path.
const RUST_ONLY_KEYS: &[&str] = &["recent_files", "session_files", "workspace_folder"];

fn webview_may_set(key: &str) -> bool {
    !RUST_ONLY_KEYS.contains(&key)
}

/// The stored preferences map. None when the store is unreachable or holds
/// no map yet (the store may legally hold a partial map).
fn load_map(app: &AppHandle) -> Option<PrefMap> {
    let store = app.store(".boltpage.dat").ok()?;
    store
        .get("preferences")
        .and_then(|v| serde_json::from_value::<PrefMap>(v).ok())
}

/// The one read-modify-write entry: holds PREF_LOCK while it loads the map,
/// applies `change` and saves, so concurrent writers cannot lose each other's
/// keys. Used by both JS (via save_preference_key) and internal Rust code.
pub(crate) async fn update(
    app: &AppHandle,
    change: impl FnOnce(&mut PrefMap),
) -> Result<(), String> {
    let _lock = PREF_LOCK.lock().await;

    let store = app
        .store(".boltpage.dat")
        .map_err(|e| format!("Failed to access store: {e}"))?;

    let mut map = store
        .get("preferences")
        .and_then(|v| serde_json::from_value::<PrefMap>(v).ok())
        .unwrap_or_default();

    change(&mut map);

    store.set("preferences", serde_json::Value::Object(map));
    store
        .save()
        .map_err(|e| format!("Failed to save preferences: {e}"))?;
    Ok(())
}

// --- Changes applied through update() ---

pub(crate) fn set_key(map: &mut PrefMap, key: &str, value: serde_json::Value) {
    map.insert(key.to_string(), value);
}

fn string_list(map: &PrefMap, key: &str) -> Vec<String> {
    map.get(key)
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default()
}

/// Record `path` at the head of the recent-files list (most-recent first),
/// deduplicated and capped at MAX_RECENT_FILES.
pub(crate) fn push_recent(map: &mut PrefMap, path: &str) {
    let mut vec = string_list(map, "recent_files");
    vec.retain(|p| p != path);
    vec.insert(0, path.to_string());
    vec.truncate(MAX_RECENT_FILES);
    map.insert("recent_files".into(), vec.into());
}

/// Push `path` to the end of the ordered session list ("session_files"),
/// removing an earlier occurrence first. Order is preserved for session restore.
pub(crate) fn session_add(map: &mut PrefMap, path: &str) {
    let mut vec = string_list(map, "session_files");
    vec.retain(|p| p != path);
    vec.push(path.to_string());
    map.insert("session_files".into(), vec.into());
}

pub(crate) fn session_remove(map: &mut PrefMap, path: &str) {
    let mut vec = string_list(map, "session_files");
    vec.retain(|p| p != path);
    map.insert("session_files".into(), vec.into());
}

/// Remember the last size of a preview window, or of an editor window.
pub(crate) fn set_window_size(map: &mut PrefMap, editor: bool, width: u32, height: u32) {
    let (width_key, height_key) = if editor {
        ("editor_window_width", "editor_window_height")
    } else {
        ("window_width", "window_height")
    };
    map.insert(width_key.into(), width.into());
    map.insert(height_key.into(), height.into());
}

#[tauri::command]
pub(crate) fn get_preferences(app: AppHandle) -> Result<AppPreferences, String> {
    let prefs = load_map(&app)
        .and_then(|map| serde_json::from_value(serde_json::Value::Object(map)).ok())
        .unwrap_or_default();

    Ok(prefs)
}

pub(crate) async fn save_preference_key_inner(
    app: &AppHandle,
    key: &str,
    value: serde_json::Value,
) -> Result<(), String> {
    update(app, |map| set_key(map, key, value)).await
}

#[tauri::command]
pub(crate) async fn save_preference_key(
    app: AppHandle,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    if !webview_may_set(&key) {
        return Err(format!("Preference key is not writable: {key}"));
    }
    save_preference_key_inner(&app, &key, value).await
}

#[tauri::command]
pub(crate) async fn mark_cli_setup_declined(app: AppHandle) -> Result<(), String> {
    save_preference_key_inner(&app, "cli_setup_prompted", serde_json::Value::Bool(true)).await
}

/// Raw recent-files list, most-recent first. Dead paths are NOT filtered here;
/// call sites decide (menu and get_recent_files filter, validation does not).
pub(crate) fn read_recent_paths(app: &AppHandle) -> Vec<String> {
    load_map(app)
        .map(|map| string_list(&map, "recent_files"))
        .unwrap_or_default()
}

/// Ordered list of files that were open in preview windows (session restore).
pub(crate) fn read_session_paths(app: &AppHandle) -> Vec<String> {
    load_map(app)
        .map(|map| string_list(&map, "session_files"))
        .unwrap_or_default()
}

/// Read a single string entry from the preferences map (None when missing,
/// null, or unparseable).
pub(crate) fn read_string_pref(app: &AppHandle, key: &str) -> Option<String> {
    load_map(app)?.get(key)?.as_str().map(|s| s.to_string())
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn map(value: serde_json::Value) -> PrefMap {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn window_resize_keeps_session_files_and_workspace_folder() {
        let mut m = map(json!({
            "theme": "light",
            "session_files": ["/a.md", "/b.md"],
            "workspace_folder": "/notes"
        }));

        set_window_size(&mut m, false, 1000, 700);
        set_window_size(&mut m, true, 1200, 900);

        assert_eq!(m["session_files"], json!(["/a.md", "/b.md"]));
        assert_eq!(m["workspace_folder"], json!("/notes"));
        assert_eq!(m["theme"], json!("light"));
        assert_eq!(m["window_width"], json!(1000));
        assert_eq!(m["window_height"], json!(700));
        assert_eq!(m["editor_window_width"], json!(1200));
        assert_eq!(m["editor_window_height"], json!(900));
    }

    #[test]
    fn set_key_keeps_other_keys() {
        let mut m = map(json!({ "theme": "light", "font_size": 20 }));

        set_key(&mut m, "theme", json!("drac"));
        set_key(&mut m, "workspace_folder", serde_json::Value::Null);

        assert_eq!(
            serde_json::Value::Object(m),
            json!({ "theme": "drac", "font_size": 20, "workspace_folder": null })
        );
    }

    #[test]
    fn webview_cannot_set_keys_the_grants_trust() {
        for key in ["recent_files", "session_files", "workspace_folder"] {
            assert!(!webview_may_set(key));
        }
        for key in ["theme", "font_size", "toc_visible", "window_width"] {
            assert!(webview_may_set(key));
        }
    }

    #[test]
    fn push_recent_moves_to_head_dedupes_and_caps() {
        let mut m = PrefMap::new();
        for i in 0..MAX_RECENT_FILES + 2 {
            push_recent(&mut m, &format!("/{i}.md"));
        }
        push_recent(&mut m, "/5.md");

        let recents = string_list(&m, "recent_files");
        assert_eq!(recents.len(), MAX_RECENT_FILES);
        assert_eq!(recents[0], "/5.md");
        assert_eq!(recents.iter().filter(|p| *p == "/5.md").count(), 1);
        assert_eq!(recents[1], format!("/{}.md", MAX_RECENT_FILES + 1));
    }

    #[test]
    fn session_add_and_remove_keep_order() {
        let mut m = map(json!({ "session_files": ["/a.md", "/b.md", "/c.md"] }));

        session_add(&mut m, "/a.md");
        assert_eq!(m["session_files"], json!(["/b.md", "/c.md", "/a.md"]));

        session_remove(&mut m, "/c.md");
        assert_eq!(m["session_files"], json!(["/b.md", "/a.md"]));

        session_remove(&mut m, "/missing.md");
        assert_eq!(m["session_files"], json!(["/b.md", "/a.md"]));
    }

    #[test]
    fn list_changes_start_from_empty_on_missing_or_malformed_key() {
        let mut m = map(json!({ "recent_files": "not a list" }));

        push_recent(&mut m, "/a.md");
        session_add(&mut m, "/a.md");

        assert_eq!(m["recent_files"], json!(["/a.md"]));
        assert_eq!(m["session_files"], json!(["/a.md"]));
    }
}
