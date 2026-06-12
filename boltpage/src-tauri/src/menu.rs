use crate::constants::*;
use crate::prefs;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager};

/// Encode a file path into an Open Recent menu item id.
fn recent_menu_id(path: &str) -> String {
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(path.as_bytes());
    format!("{MENU_RECENT_PREFIX}{encoded}")
}

/// Decode an Open Recent menu item id back to its file path.
/// Returns None for ids that don't carry the prefix or don't decode.
pub(crate) fn decode_recent_menu_id(id: &str) -> Option<String> {
    let encoded = id.strip_prefix(MENU_RECENT_PREFIX)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .ok()?;
    String::from_utf8(bytes).ok()
}

/// Display label for an Open Recent entry: "name (dir)", with the home
/// directory abbreviated to ~.
fn recent_menu_label(path: &str) -> String {
    let p = Path::new(path);
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());
    let dir = p
        .parent()
        .map(|d| d.to_string_lossy().to_string())
        .unwrap_or_default();
    let dir = match std::env::var("HOME") {
        Ok(home) if !home.is_empty() && dir.starts_with(&home) => {
            format!("~{}", &dir[home.len()..])
        }
        _ => dir,
    };
    if dir.is_empty() {
        name
    } else {
        format!("{name} ({dir})")
    }
}

// Rebuild the native application menu, including a dynamic Window submenu
pub(crate) fn rebuild_app_menu(app: &AppHandle) -> tauri::Result<()> {
    // macOS application menu (mirrors HIG: About, Services, Hide, Quit)
    #[cfg(target_os = "macos")]
    let app_menu = SubmenuBuilder::new(app, "BoltPage")
        .item(&MenuItemBuilder::with_id(MENU_ABOUT, "About BoltPage").build(app)?)
        .separator()
        .item(&PredefinedMenuItem::services(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;

    // File menu (Quit lives in the app menu on macOS)
    #[allow(unused_mut)]
    let mut file_menu_builder = SubmenuBuilder::new(app, "File")
        .item(
            &MenuItemBuilder::with_id(MENU_NEW_FILE, "New File")
                .accelerator("CmdOrCtrl+N")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id(MENU_NEW_WINDOW, "New Window")
                .accelerator("CmdOrCtrl+Shift+N")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id(MENU_OPEN, "Open")
                .accelerator("CmdOrCtrl+O")
                .build(app)?,
        )
        .item(&{
            // Open Recent: rebuilt with the rest of the menu whenever recents
            // change (push_to_recents triggers a rebuild).
            let mut recent_builder = SubmenuBuilder::new(app, "Open Recent");
            let mut any = false;
            for path in prefs::read_recent_paths(app)
                .iter()
                .filter(|p| Path::new(p).exists())
            {
                recent_builder = recent_builder.item(
                    &MenuItemBuilder::with_id(recent_menu_id(path), recent_menu_label(path))
                        .build(app)?,
                );
                any = true;
            }
            if any {
                recent_builder = recent_builder.separator();
            }
            recent_builder
                .item(&MenuItemBuilder::with_id(MENU_RECENT_CLEAR, "Clear Menu").build(app)?)
                .build()?
        })
        .item(
            &MenuItemBuilder::with_id(MENU_OPEN_FOLDER, "Open Folder…")
                .accelerator("CmdOrCtrl+Shift+O")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id(MENU_PRINT, "Print")
                .accelerator("CmdOrCtrl+P")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id(MENU_EXPORT_HTML, "Export as HTML...")
                .accelerator("CmdOrCtrl+Shift+E")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id(MENU_EXPORT_PDF, "Export as PDF...")
                .accelerator("CmdOrCtrl+Shift+P")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id(MENU_CLOSE, "Close Window")
                .accelerator("CmdOrCtrl+W")
                .build(app)?,
        );

    #[cfg(not(target_os = "macos"))]
    {
        file_menu_builder = file_menu_builder.item(
            &MenuItemBuilder::with_id(MENU_QUIT, "Quit")
                .accelerator("CmdOrCtrl+Q")
                .build(app)?,
        );
    }

    let file_menu = file_menu_builder.build()?;

    // Edit menu: predefined items route through the OS responder chain,
    // giving native Undo/Cut/Copy/Paste/Select All with automatic enable/disable.
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id(MENU_FIND, "Find...")
                .accelerator("CmdOrCtrl+F")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id(MENU_FIND_NEXT, "Find Next")
                .accelerator("CmdOrCtrl+G")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id(MENU_FIND_PREV, "Find Previous")
                .accelerator("Shift+CmdOrCtrl+G")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id(MENU_FIND_USE_SELECTION, "Use Selection for Find")
                .accelerator("CmdOrCtrl+E")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id(MENU_FIND_REPLACE, "Find and Replace...")
                .accelerator("CmdOrCtrl+Alt+F")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id(MENU_COMMAND_PALETTE, "Command Palette…  ⌘K ⌘P")
                .build(app)?,
        )
        .build()?;

    // Format menu: text-editing shortcuts routed through the focused editor
    // window via emit events. Items are globally visible but JS listeners
    // gate on window focus + window-type.
    let format_menu = SubmenuBuilder::new(app, "Format")
        .item(
            &MenuItemBuilder::with_id(MENU_FORMAT_BOLD, "Bold")
                .accelerator("CmdOrCtrl+B")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id(MENU_FORMAT_ITALIC, "Italic")
                .accelerator("CmdOrCtrl+I")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id(MENU_FORMAT_LINK, "Insert Link…")
                .accelerator("CmdOrCtrl+Shift+U")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id(MENU_FORMAT_STRIKE, "Strikethrough")
                .accelerator("CmdOrCtrl+Shift+K")
                .build(app)?,
        )
        .build()?;

    // Window menu: Minimize (cross-platform) + dynamic list of open windows
    let mut window_menu_builder = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .separator();

    for (label, window) in app.webview_windows() {
        let title = window.title().unwrap_or_else(|_| "Untitled".to_string());
        let window_id = format!("{MENU_WINDOW_PREFIX}{label}");
        window_menu_builder =
            window_menu_builder.item(&MenuItemBuilder::with_id(&window_id, &title).build(app)?);
    }
    let window_menu = window_menu_builder.build()?;

    // Help menu (About duplicated into app menu on macOS; Windows keeps it here)
    #[allow(unused_mut)]
    let mut help_menu_builder = SubmenuBuilder::new(app, "Help");

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        help_menu_builder = help_menu_builder
            .item(&MenuItemBuilder::with_id(MENU_SETUP_CLI, "Setup CLI Access...").build(app)?);
    }

    #[cfg(not(target_os = "macos"))]
    {
        help_menu_builder = help_menu_builder
            .item(&MenuItemBuilder::with_id(MENU_ABOUT, "About BoltPage").build(app)?);
    }

    let help_menu = help_menu_builder.build()?;

    // Build and set the menu
    let mut menu_builder = MenuBuilder::new(app);

    #[cfg(target_os = "macos")]
    {
        menu_builder = menu_builder.item(&app_menu);
    }

    let menu = menu_builder
        .item(&file_menu)
        .item(&edit_menu)
        .item(&format_menu)
        .item(&window_menu)
        .item(&help_menu)
        .build()?;
    app.set_menu(menu)?;
    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct ScrollSyncPayload {
    pub source: String,
    pub file_path: String,
    pub kind: String,
    pub line: Option<u32>,
    pub percent: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct EditorWindowClosedPayload {
    pub preview_window: String,
    pub file_path: String,
}

/// Unsaved editor buffer, broadcast on type (debounced in JS) so previews can
/// render ahead of the autosave/watcher roundtrip.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct EditorBufferPayload {
    pub source: String,
    pub file_path: String,
    pub kind: String,
    pub content: String,
}

#[tauri::command]
pub(crate) fn broadcast_editor_buffer(
    app: AppHandle,
    payload: EditorBufferPayload,
) -> Result<(), String> {
    app.emit(EVENT_EDITOR_BUFFER_CHANGED, &payload)
        .map_err(|e| format!("Failed to broadcast editor buffer: {e}"))
}

#[tauri::command]
pub(crate) fn broadcast_theme_change(app: AppHandle, theme: String) -> Result<(), String> {
    app.emit(EVENT_THEME_CHANGED, &theme)
        .map_err(|e| format!("Failed to broadcast theme change: {e}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) fn broadcast_toolbar_density_change(
    app: AppHandle,
    density: String,
) -> Result<(), String> {
    app.emit(EVENT_TOOLBAR_DENSITY_CHANGED, &density)
        .map_err(|e| format!("Failed to broadcast toolbar density change: {e}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) fn broadcast_font_size_change(app: AppHandle, font_size: u16) -> Result<(), String> {
    app.emit(EVENT_FONT_SIZE_CHANGED, &font_size)
        .map_err(|e| format!("Failed to broadcast font size change: {e}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) fn broadcast_scroll_sync(
    app: AppHandle,
    payload: ScrollSyncPayload,
) -> Result<(), String> {
    app.emit(EVENT_SCROLL_SYNC, &payload)
        .map_err(|e| format!("Failed to broadcast scroll sync: {e}"))
}

#[tauri::command]
pub(crate) fn broadcast_editor_window_closed(
    app: AppHandle,
    payload: EditorWindowClosedPayload,
) -> Result<(), String> {
    app.emit(EVENT_EDITOR_WINDOW_CLOSED, &payload)
        .map_err(|e| format!("Failed to broadcast editor close event: {e}"))
}

#[tauri::command]
pub(crate) fn get_syntax_css(theme: String) -> Result<String, String> {
    markrust_core::get_syntax_theme_css(&theme)
        .ok_or_else(|| "Failed to generate syntax CSS".to_string())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct FontFamilyPayload {
    pub document: Option<String>,
    pub editor: Option<String>,
}

#[tauri::command]
pub(crate) fn broadcast_font_family_change(
    app: AppHandle,
    payload: FontFamilyPayload,
) -> Result<(), String> {
    app.emit(EVENT_FONT_FAMILY_CHANGED, &payload)
        .map_err(|e| format!("Failed to broadcast font family change: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recent_menu_id_round_trips() {
        let path = "/Users/someone/notes/a file with spaces.md";
        let id = recent_menu_id(path);
        assert!(id.starts_with(MENU_RECENT_PREFIX));
        assert_eq!(decode_recent_menu_id(&id), Some(path.to_string()));
        // The Clear id must never decode as a path.
        assert_eq!(decode_recent_menu_id(MENU_RECENT_CLEAR), None);
        assert_eq!(decode_recent_menu_id("other-id"), None);
    }
}
