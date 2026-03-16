use crate::constants::*;
use serde::{Deserialize, Serialize};
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager};

// Rebuild the native application menu, including a dynamic Window submenu
pub(crate) fn rebuild_app_menu(app: &AppHandle) -> tauri::Result<()> {
    // File menu
    let file_menu = SubmenuBuilder::new(app, "File")
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
        )
        .item(
            &MenuItemBuilder::with_id(MENU_QUIT, "Quit")
                .accelerator("CmdOrCtrl+Q")
                .build(app)?,
        )
        .build()?;

    // Edit menu (native accelerators for copy/paste/etc.)
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(
            &MenuItemBuilder::with_id(ACTION_UNDO, "Undo")
                .accelerator("CmdOrCtrl+Z")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id(ACTION_REDO, "Redo")
                .accelerator("Shift+CmdOrCtrl+Z")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id(ACTION_CUT, "Cut")
                .accelerator("CmdOrCtrl+X")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id(ACTION_COPY, "Copy")
                .accelerator("CmdOrCtrl+C")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id(ACTION_PASTE, "Paste")
                .accelerator("CmdOrCtrl+V")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id(ACTION_SELECT_ALL, "Select All")
                .accelerator("CmdOrCtrl+A")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id(MENU_FIND, "Find...")
                .accelerator("CmdOrCtrl+F")
                .build(app)?,
        )
        .build()?;

    // Window menu (dynamic list of open windows)
    let mut window_menu_builder = SubmenuBuilder::new(app, "Window").separator();

    for (label, window) in app.webview_windows() {
        let title = window.title().unwrap_or_else(|_| "Untitled".to_string());
        let window_id = format!("{MENU_WINDOW_PREFIX}{label}");
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
            .item(&MenuItemBuilder::with_id(MENU_SETUP_CLI, "Setup CLI Access...").build(app)?);
    }

    let help_menu = help_menu_builder
        .item(&MenuItemBuilder::with_id(MENU_ABOUT, "About BoltPage").build(app)?)
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

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct ScrollSyncPayload {
    pub source: String,
    pub file_path: String,
    pub kind: String,
    pub line: Option<u32>,
    pub percent: Option<f64>,
}

#[tauri::command]
pub(crate) fn broadcast_theme_change(app: AppHandle, theme: String) -> Result<(), String> {
    app.emit(EVENT_THEME_CHANGED, &theme)
        .map_err(|e| format!("Failed to broadcast theme change: {e}"))?;
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
pub(crate) fn get_syntax_css(theme: String) -> Result<String, String> {
    markrust_core::get_syntax_theme_css(&theme)
        .ok_or_else(|| "Failed to generate syntax CSS".to_string())
}
