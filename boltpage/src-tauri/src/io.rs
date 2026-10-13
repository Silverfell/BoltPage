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

/// Record `path` at the head of the recent-files list (most-recent first),
/// deduplicated and capped at MAX_RECENT_FILES. One locked prefs update, so
/// concurrent file-open events cannot lose entries.
pub(crate) async fn push_to_recents(app: &AppHandle, path: &str) -> Result<(), String> {
    let canonical = fs::canonicalize(path)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| path.to_string());

    crate::prefs::update(app, |map| crate::prefs::push_recent(map, &canonical)).await?;

    // Keep the File > Open Recent submenu current with every recents mutation.
    let _ = crate::menu::rebuild_app_menu(app);

    Ok(())
}

/// Register a file opened *inside an existing window* (welcome-card recents,
/// the open dialog, the workspace tree), so in-window switches stay tracked
/// like window creation.
#[tauri::command]
pub(crate) async fn open_tracked_file(
    app: AppHandle,
    window: tauri::Window,
    path: String,
) -> Result<(), String> {
    crate::window::apply_transition(
        &app,
        window.label(),
        crate::window::Transition::Switch(&path),
    )
    .await
}

/// Resolve a relative link clicked in the preview and grant access to the
/// target so the subsequent open passes authorization. Returns the canonical
/// absolute path to open.
#[tauri::command]
pub(crate) fn resolve_doc_link(
    app: AppHandle,
    base: String,
    href: String,
) -> Result<String, String> {
    let grants = &app.state::<AppState>().grants;
    let canonical =
        grants.authorize_relative(&base, &href, crate::workspace::WORKSPACE_EXTENSIONS)?;
    let canonical_str = pathbuf_to_string(&canonical);
    grants.grant_path(&canonical_str);
    Ok(canonical_str)
}

// --- Document assets (local images) ---

/// Extensions embeddable as data: URIs in the preview and HTML export.
const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif",
];

/// Refuse to embed images beyond this size; data URIs inflate by ~33% and
/// travel over IPC.
const MAX_ASSET_BYTES: u64 = 20 * 1024 * 1024;

fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

#[derive(Debug, serde::Serialize)]
pub(crate) struct DocAsset {
    pub mime: String,
    pub data_b64: String,
}

/// Validate + read an image referenced by a document. Blocking (fs reads);
/// call from spawn_blocking in async contexts.
pub(crate) fn doc_asset_payload(
    app: &AppHandle,
    base: &str,
    src: &str,
) -> Result<(String, String), String> {
    let canonical =
        app.state::<AppState>()
            .grants
            .authorize_relative(base, src, IMAGE_EXTENSIONS)?;
    let meta = fs::metadata(&canonical).map_err(|e| format!("Failed to stat image: {e}"))?;
    if meta.len() > MAX_ASSET_BYTES {
        return Err("Image exceeds the 20 MB embed limit".to_string());
    }
    let ext = canonical
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    let bytes = fs::read(&canonical).map_err(|e| format!("Failed to read image: {e}"))?;
    Ok((
        mime_for_ext(&ext).to_string(),
        base64::engine::general_purpose::STANDARD.encode(bytes),
    ))
}

#[tauri::command]
pub(crate) async fn load_doc_asset(
    app: AppHandle,
    base: String,
    src: String,
) -> Result<DocAsset, String> {
    tauri::async_runtime::spawn_blocking(move || {
        doc_asset_payload(&app, &base, &src).map(|(mime, data_b64)| DocAsset { mime, data_b64 })
    })
    .await
    .map_err(|e| format!("Join error: {e}"))?
}

/// Replace relative `<img src>` values with data: URIs produced by `resolve`
/// (src → (mime, base64)); tags whose asset can't be resolved are left
/// untouched. Split from the AppHandle so the string mechanics are testable.
fn embed_images_with<F>(html: &str, resolve: F) -> String
where
    F: Fn(&str) -> Option<(String, String)>,
{
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(i) = rest.find("<img") {
        out.push_str(&rest[..i]);
        let tag_rest = &rest[i..];
        let end = tag_rest.find('>').map(|e| e + 1).unwrap_or(tag_rest.len());
        out.push_str(&rewrite_img_src_with(&tag_rest[..end], &resolve));
        rest = &tag_rest[end..];
    }
    out.push_str(rest);
    out
}

fn rewrite_img_src_with<F>(tag: &str, resolve: &F) -> String
where
    F: Fn(&str) -> Option<(String, String)>,
{
    let Some(s) = tag.find("src=\"") else {
        return tag.to_string();
    };
    let val_start = s + 5;
    let Some(rel_end) = tag[val_start..].find('"') else {
        return tag.to_string();
    };
    let val = &tag[val_start..val_start + rel_end];
    let lower = val.to_ascii_lowercase();
    if lower.starts_with("data:")
        || lower.starts_with("http:")
        || lower.starts_with("https:")
        || lower.starts_with("blob:")
    {
        return tag.to_string();
    }
    // Ammonia escaped the attribute; `&` is the only escape that survives in
    // a sanitized path value (quotes and angle brackets can't appear).
    let src = val.replace("&amp;", "&");
    match resolve(&src) {
        Some((mime, b64)) => format!(
            "{}data:{mime};base64,{b64}{}",
            &tag[..val_start],
            &tag[val_start + rel_end..]
        ),
        None => tag.to_string(),
    }
}

/// Replace relative `<img src>` values in exported HTML with data: URIs so
/// the exported file is self-contained.
fn embed_local_images(app: &AppHandle, html: &str, base: &str) -> String {
    embed_images_with(html, |src| doc_asset_payload(app, base, src).ok())
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

// --- Tauri commands: file I/O ---

#[tauri::command]
pub(crate) fn read_file(app: AppHandle, path: String) -> Result<String, String> {
    let canonical = app.state::<AppState>().grants.authorize(&path)?;
    fs::read_to_string(&canonical).map_err(|e| format!("Failed to read file: {e}"))
}

#[tauri::command]
pub(crate) fn read_file_bytes_b64(app: AppHandle, path: String) -> Result<String, String> {
    let canonical = app.state::<AppState>().grants.authorize(&path)?;
    fs::read(&canonical)
        .map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes))
        .map_err(|e| format!("Failed to read file bytes: {e}"))
}

#[tauri::command]
pub(crate) fn write_file(app: AppHandle, path: String, content: String) -> Result<(), String> {
    let canonical = app.state::<AppState>().grants.authorize(&path)?;
    if !canonical.exists() {
        return Err("File does not exist. Use create to make new files.".to_string());
    }
    atomic_write_file(&canonical, &content)?;
    invalidate_cache_for_path_sync(&app, &path);
    Ok(())
}

#[tauri::command]
pub(crate) fn is_writable(app: AppHandle, path: String) -> Result<bool, String> {
    let canonical = app.state::<AppState>().grants.authorize(&path)?;
    match fs::OpenOptions::new().write(true).open(&canonical) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => Ok(false),
        Err(e) => Err(format!("Failed to check writability: {e}")),
    }
}

#[tauri::command]
pub(crate) fn format_json_pretty(content: String) -> Result<String, String> {
    let value: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("Invalid JSON: {e}"))?;
    serde_json::to_string_pretty(&value).map_err(|e| format!("Failed to pretty-print JSON: {e}"))
}

// --- Tauri commands: rendering ---

/// Render an unsaved editor buffer. `kind` is one of the frontend's KIND_*
/// names, each of which is also a file extension of that kind.
#[tauri::command]
pub(crate) fn render_buffer_to_html(kind: String, content: String) -> Result<String, String> {
    let kind = markrust_core::Kind::from_extension(&kind)
        .ok_or_else(|| format!("Unsupported document kind: {kind}"))?;
    markrust_core::render(kind, &content)
}

#[tauri::command]
pub(crate) async fn render_file_to_html(app: AppHandle, path: String) -> Result<String, String> {
    use std::time::UNIX_EPOCH;

    let read_path = app.state::<AppState>().grants.authorize(&path)?;

    let ext = Path::new(&path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    let kind = markrust_core::Kind::from_extension(ext)
        .ok_or_else(|| format!("Unsupported file extension: .{}", ext.to_lowercase()))?;

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

    let html =
        tauri::async_runtime::spawn_blocking(move || markrust_core::render(kind, &raw_content))
            .await
            .map_err(|e| format!("Join error: {e}"))??;

    if let Some(state) = app.try_state::<AppState>() {
        let mut cache = state.html_cache.write().await;
        cache.put(key, html.clone());
    }

    Ok(html)
}

// --- Pasted images ---

const MAX_PASTED_IMAGE_BYTES: usize = 10 * 1024 * 1024;

/// Sniff the pasted payload's real format from magic bytes; the extension the
/// file gets on disk comes from here, never from the caller-supplied mime.
fn sniff_image_ext(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some("png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("gif")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

/// Save a clipboard image next to the document (`assets/img-<uuid8>.<ext>`)
/// and return the relative path to insert into the markdown. Unlike
/// write_file, creating a new file is the point here; the target is confined
/// to the document's own assets/ subfolder.
#[tauri::command]
pub(crate) async fn save_clipboard_image(
    app: AppHandle,
    doc_path: String,
    data_b64: String,
) -> Result<String, String> {
    app.state::<AppState>().grants.authorize(&doc_path)?;
    let doc = PathBuf::from(&doc_path);
    let ext_ok = doc
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            let l = e.to_lowercase();
            l == "md" || l == "markdown"
        })
        .unwrap_or(false);
    if !ext_ok {
        return Err("Images can only be pasted into Markdown files".to_string());
    }
    if !doc.is_file() {
        return Err("Document does not exist on disk".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64)
        .map_err(|e| format!("Invalid image data: {e}"))?;
    if bytes.len() > MAX_PASTED_IMAGE_BYTES {
        return Err("Pasted image exceeds the 10 MB limit".to_string());
    }
    let Some(img_ext) = sniff_image_ext(&bytes) else {
        return Err("Unsupported clipboard image format (PNG/JPEG/GIF/WebP)".to_string());
    };
    let parent = doc
        .parent()
        .ok_or_else(|| "Document has no parent directory".to_string())?
        .to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        let assets = parent.join("assets");
        fs::create_dir_all(&assets).map_err(|e| format!("Failed to create assets folder: {e}"))?;
        // A few attempts in case of a uuid-prefix collision; create_new never
        // clobbers an existing file.
        for _ in 0..4 {
            let id = uuid::Uuid::new_v4().simple().to_string();
            let name = format!("img-{}.{img_ext}", &id[..8]);
            let target = assets.join(&name);
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
            {
                Ok(mut f) => {
                    f.write_all(&bytes)
                        .map_err(|e| format!("Failed to write image: {e}"))?;
                    return Ok(format!("assets/{name}"));
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(format!("Failed to create image file: {e}")),
            }
        }
        Err("Failed to allocate an image filename".to_string())
    })
    .await
    .map_err(|e| format!("Join error: {e}"))?
}

// --- Custom preview CSS ---

const CUSTOM_CSS_FILE: &str = "custom.css";
const CUSTOM_CSS_TEMPLATE: &str = "/* BoltPage custom preview CSS.\n\
   Loaded after the theme styles in every preview window and included in\n\
   HTML export. Scope rules to one theme with [data-theme=\"dark\"] /\n\
   [data-theme=\"drac\"] selectors, or write bare selectors for all themes.\n\
   Reloaded whenever a preview window regains focus. */\n";

fn custom_css_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to resolve config dir: {e}"))?;
    Ok(dir.join(CUSTOM_CSS_FILE))
}

/// The user's custom stylesheet; empty when none has been written yet.
#[tauri::command]
pub(crate) fn get_custom_css(app: AppHandle) -> Result<String, String> {
    let path = custom_css_path(&app)?;
    match fs::read_to_string(&path) {
        Ok(css) => Ok(css),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("Failed to read custom CSS: {e}")),
    }
}

/// Create the custom stylesheet from a commented template if missing, then
/// open it in the system's default editor.
#[tauri::command]
pub(crate) fn open_custom_css(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    let path = custom_css_path(&app)?;
    if !path.exists() {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {e}"))?;
        }
        fs::write(&path, CUSTOM_CSS_TEMPLATE)
            .map_err(|e| format!("Failed to create custom CSS: {e}"))?;
    }
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| format!("Failed to open custom CSS: {e}"))
}

// --- Tauri commands: export ---

async fn export_html_inner(
    app: &AppHandle,
    path: &str,
    theme: &str,
    document_font_stack: Option<&str>,
) -> Result<String, String> {
    let fragment = render_file_to_html(app.clone(), path.to_string()).await?;
    // Inline relative images so the exported file stands alone.
    let fragment = {
        let app = app.clone();
        let base = path.to_string();
        tauri::async_runtime::spawn_blocking(move || embed_local_images(&app, &fragment, &base))
            .await
            .map_err(|e| format!("Join error: {e}"))?
    };
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

    let font_override = document_font_stack
        .map(|stack| format!("<style>:root{{--document-font-family:{stack};}}</style>"))
        .unwrap_or_default();

    // User stylesheet last, mirroring the preview's cascade order.
    let custom_css = get_custom_css(app.clone()).unwrap_or_default();
    let custom_block = if custom_css.trim().is_empty() {
        String::new()
    } else {
        format!("<style>\n{custom_css}\n</style>")
    };

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
{font_override}
{custom_block}
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
    document_font_stack: Option<String>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    app.state::<AppState>().grants.authorize(&path)?;

    let html = export_html_inner(&app, &path, &theme, document_font_stack.as_deref()).await?;

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
        let path_str = p.to_string();
        app.state::<AppState>().grants.grant_path(&path_str);
        if let Err(e) = push_to_recents(&app, &path_str).await {
            eprintln!("Failed to push recents (open_file_dialog): {e}");
        }
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

    let window_label = crate::window::create_window_with_file(&app, Some(path), false)
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
    fn embed_images_with_rewrites_only_resolvable_relative_srcs() {
        let resolve = |src: &str| -> Option<(String, String)> {
            if src.starts_with("http") || src.starts_with("data:") {
                panic!("resolver must not be called for absolute/data srcs: {src}");
            }
            if src == "ok.png" || src == "a&b.png" {
                Some(("image/png".to_string(), "QUJD".to_string()))
            } else {
                None
            }
        };

        // Resolvable src → data URI; alt and the rest of the tag preserved.
        let out = embed_images_with(r#"<p>x</p><img src="ok.png" alt="a"><p>y</p>"#, resolve);
        assert_eq!(
            out,
            r#"<p>x</p><img src="data:image/png;base64,QUJD" alt="a"><p>y</p>"#
        );

        // Unresolvable src → untouched. Multiple imgs handled independently.
        let out = embed_images_with(r#"<img src="ok.png"><img src="missing.png">"#, resolve);
        assert!(out.contains("data:image/png;base64,QUJD"), "got: {out}");
        assert!(out.contains(r#"<img src="missing.png">"#), "got: {out}");

        // http/data srcs skipped without consulting the resolver (it panics).
        let out = embed_images_with(
            r#"<img src="https://x/y.png"><img src="data:image/png;base64,zz">"#,
            resolve,
        );
        assert!(out.contains("https://x/y.png"), "got: {out}");

        // Ammonia's &amp; escape is undone before the resolver sees the path.
        let out = embed_images_with(r#"<img src="a&amp;b.png">"#, resolve);
        assert!(out.contains("data:image/png"), "got: {out}");

        // No src, truncated tag, or no imgs at all: passthrough, no panic.
        assert_eq!(
            embed_images_with("<img alt=\"x\">", resolve),
            "<img alt=\"x\">"
        );
        assert_eq!(embed_images_with("<img src=\"q", resolve), "<img src=\"q");
        assert_eq!(
            embed_images_with("plain <b>html</b>", resolve),
            "plain <b>html</b>"
        );
    }

    #[test]
    fn sniff_image_ext_recognizes_formats() {
        assert_eq!(
            sniff_image_ext(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00]),
            Some("png")
        );
        assert_eq!(sniff_image_ext(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("jpg"));
        assert_eq!(sniff_image_ext(b"GIF89a..."), Some("gif"));
        assert_eq!(
            sniff_image_ext(b"RIFF\x00\x00\x00\x00WEBPVP8 "),
            Some("webp")
        );
        assert_eq!(sniff_image_ext(b"plain text"), None);
        assert_eq!(sniff_image_ext(b""), None);
        // Truncated RIFF header must not panic.
        assert_eq!(sniff_image_ext(b"RIFF\x00\x00"), None);
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
