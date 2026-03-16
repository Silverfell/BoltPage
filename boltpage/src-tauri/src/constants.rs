// Event names (emitted via app.emit)
pub const EVENT_FILE_CHANGED: &str = "file-changed";
pub const EVENT_THEME_CHANGED: &str = "theme-changed";
pub const EVENT_SCROLL_SYNC: &str = "scroll-sync";
pub const EVENT_MENU_OPEN: &str = "menu-open";
pub const EVENT_MENU_CLOSE: &str = "menu-close";
pub const EVENT_MENU_FIND: &str = "menu-find";
pub const EVENT_MENU_EDIT: &str = "menu-edit";
pub const EVENT_MENU_EXPORT_HTML: &str = "menu-export-html";
#[allow(dead_code)]
pub const EVENT_MENU_PRINT: &str = "menu-print";

// Menu IDs (used in rebuild_app_menu and on_menu_event)
pub const MENU_NEW_FILE: &str = "new-file";
pub const MENU_NEW_WINDOW: &str = "new-window";
pub const MENU_OPEN: &str = "open";
pub const MENU_PRINT: &str = "print";
pub const MENU_EXPORT_PDF: &str = "export-pdf";
pub const MENU_EXPORT_HTML: &str = "export-html";
pub const MENU_CLOSE: &str = "close";
pub const MENU_QUIT: &str = "quit";
pub const MENU_FIND: &str = "find";
pub const MENU_SETUP_CLI: &str = "setup-cli";
pub const MENU_ABOUT: &str = "about";

// Edit action IDs (menu IDs and event payloads)
pub const ACTION_UNDO: &str = "undo";
pub const ACTION_REDO: &str = "redo";
pub const ACTION_CUT: &str = "cut";
pub const ACTION_COPY: &str = "copy";
pub const ACTION_PASTE: &str = "paste";
pub const ACTION_SELECT_ALL: &str = "select-all";

// Scroll sync kinds (ScrollSyncPayload.kind) — used by JS only
#[allow(dead_code)]
pub const KIND_MARKDOWN: &str = "markdown";
#[allow(dead_code)]
pub const KIND_JSON: &str = "json";
#[allow(dead_code)]
pub const KIND_YAML: &str = "yaml";
#[allow(dead_code)]
pub const KIND_TXT: &str = "txt";

// Window label prefixes
pub const WINDOW_PREFIX_MARKDOWN: &str = "markdown-";
pub const WINDOW_PREFIX_EDITOR: &str = "editor-";
pub const WINDOW_PREFIX_FILE: &str = "markdown-file-";
pub const MENU_WINDOW_PREFIX: &str = "window-";
