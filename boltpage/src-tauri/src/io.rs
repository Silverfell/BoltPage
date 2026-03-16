use base64::Engine;
use lru::LruCache;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use url::Url;

use crate::AppState;

// --- Path helpers ---

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

pub(crate) fn resolve_file_path(input: &str) -> Option<PathBuf> {
    if let Some(path) = file_url_to_path(input) {
        return Some(path);
    }
    let path = PathBuf::from(input);
    if path.is_absolute() {
        Some(path)
    } else {
        std::env::current_dir().ok().map(|cwd| cwd.join(path))
    }
}

pub(crate) fn pathbuf_to_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

// --- Path security ---

/// Verify that `path` was explicitly opened by the user (file dialog, CLI, or
/// macOS Launch Services).  Prevents a compromised webview from reading /
/// writing arbitrary files.
pub(crate) fn check_path_allowed(app: &AppHandle, path: &str) -> Result<(), String> {
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
pub(crate) fn allow_path(app: &AppHandle, path: &str) {
    let normalized = normalize_path(path);
    let state = app.state::<AppState>();
    state
        .allowed_paths
        .write()
        .expect("allowed_paths lock poisoned")
        .insert(normalized);
}

// --- File system utils ---

pub(crate) fn paths_match(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a_canon), Ok(b_canon)) => a_canon == b_canon,
        _ => false,
    }
}

pub(crate) fn event_targets_file(paths: &[PathBuf], target: &Path) -> bool {
    paths.iter().any(|candidate| paths_match(candidate, target))
}

// --- Cache ---

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct CacheKey {
    pub path: String,
    pub size: u64,
    pub mtime_secs: u64,
}

pub(crate) fn remove_cache_entries_for_path(
    cache: &mut LruCache<CacheKey, String>,
    file_path: &str,
) {
    let keys_to_remove: Vec<CacheKey> = cache
        .iter()
        .filter(|(k, _)| k.path == file_path)
        .map(|(k, _)| k.clone())
        .collect();

    for key in keys_to_remove {
        cache.pop(&key);
    }
}

pub(crate) fn invalidate_cache_for_path_sync(app: &AppHandle, file_path: &str) {
    if let Some(state) = app.try_state::<AppState>() {
        let mut cache = state.html_cache.blocking_write();
        remove_cache_entries_for_path(&mut cache, file_path);
    }
}

pub(crate) async fn invalidate_cache_for_path(app: &AppHandle, file_path: &str) {
    if let Some(state) = app.try_state::<AppState>() {
        let mut cache = state.html_cache.write().await;
        remove_cache_entries_for_path(&mut cache, file_path);
    }
}

// --- Atomic write ---

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

// --- Rendering helpers ---

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

// --- Tauri commands: file I/O ---

#[tauri::command]
pub(crate) fn read_file(app: AppHandle, path: String) -> Result<String, String> {
    check_path_allowed(&app, &path)?;
    fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {e}"))
}

#[tauri::command]
pub(crate) fn read_file_bytes_b64(app: AppHandle, path: String) -> Result<String, String> {
    check_path_allowed(&app, &path)?;
    fs::read(&path)
        .map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes))
        .map_err(|e| format!("Failed to read file bytes: {e}"))
}

#[tauri::command]
pub(crate) fn write_file(app: AppHandle, path: String, content: String) -> Result<(), String> {
    check_path_allowed(&app, &path)?;
    if !Path::new(&path).exists() {
        return Err("File does not exist. Use create to make new files.".to_string());
    }
    atomic_write_file(Path::new(&path), &content)?;
    invalidate_cache_for_path_sync(&app, &path);
    Ok(())
}

#[tauri::command]
pub(crate) fn is_writable(app: AppHandle, path: String) -> Result<bool, String> {
    check_path_allowed(&app, &path)?;
    match fs::OpenOptions::new().write(true).open(&path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => Ok(false),
        Err(e) => Err(format!("Failed to check writability: {e}")),
    }
}

// --- Tauri commands: markrust_core wrappers ---

#[tauri::command]
pub(crate) fn parse_markdown(content: String) -> String {
    markrust_core::parse_markdown(&content)
}

#[tauri::command]
pub(crate) fn parse_markdown_with_theme(content: String, theme: String) -> String {
    markrust_core::parse_markdown_with_theme(&content, &theme)
}

#[tauri::command]
pub(crate) fn parse_json_with_theme(content: String, theme: String) -> Result<String, String> {
    markrust_core::parse_json_with_theme(&content, &theme)
}

#[tauri::command]
pub(crate) fn parse_yaml_with_theme(content: String, theme: String) -> Result<String, String> {
    markrust_core::parse_yaml_with_theme(&content, &theme)
}

#[tauri::command]
pub(crate) fn format_json_pretty(content: String) -> Result<String, String> {
    let value: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("Invalid JSON: {e}"))?;
    serde_json::to_string_pretty(&value).map_err(|e| format!("Failed to pretty-print JSON: {e}"))
}

// --- Tauri commands: rendering ---

#[tauri::command]
pub(crate) async fn render_file_to_html(
    app: AppHandle,
    path: String,
    theme: String,
) -> Result<String, String> {
    use std::time::UNIX_EPOCH;

    check_path_allowed(&app, &path)?;

    let allowed = ["md", "markdown", "json", "yaml", "yml", "txt"];
    let ext = Path::new(&path)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    if !allowed.contains(&ext.as_str()) {
        return Err(format!("Unsupported file extension: .{ext}"));
    }

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

    let key = CacheKey {
        path: path.clone(),
        size,
        mtime_secs,
    };

    if let Some(state) = app.try_state::<AppState>() {
        let mut cache = state.html_cache.write().await;
        if let Some(cached) = cache.get(&key).cloned() {
            return Ok(cached);
        }
    }

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

    if let Some(state) = app.try_state::<AppState>() {
        let mut cache = state.html_cache.write().await;
        cache.put(key, html.clone());
    }

    Ok(html)
}

// --- Tauri commands: export ---

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
pub(crate) async fn save_html_export(
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

// --- Tauri commands: dialogs ---

#[tauri::command]
pub(crate) async fn open_file_dialog(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

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

    if let Some(ref p) = file_path {
        allow_path(&app, &p.to_string());
    }

    Ok(file_path.map(|p| p.to_string()))
}

#[tauri::command]
pub(crate) async fn create_new_markdown_file(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

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

    let window_label = crate::window::create_window_with_file(&app, Some(path))
        .await
        .map_err(|e| format!("Failed to open window: {e}"))?;

    Ok(Some(window_label))
}

// --- Tests ---

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::num::NonZeroUsize;

    fn unique_temp_dir() -> PathBuf {
        let dir = env::temp_dir().join(format!("boltpage-tests-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
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
}
