// Event names (emitted via app.emit)
pub const EVENT_FILE_CHANGED: &str = "file-changed";
pub const EVENT_THEME_CHANGED: &str = "theme-changed";
pub const EVENT_FONT_SIZE_CHANGED: &str = "font-size-changed";
pub const EVENT_FONT_FAMILY_CHANGED: &str = "font-family-changed";
pub const EVENT_TOOLBAR_DENSITY_CHANGED: &str = "toolbar-density-changed";
pub const EVENT_EDITOR_WINDOW_CLOSED: &str = "editor-window-closed";
pub const EVENT_EDITOR_BUFFER_CHANGED: &str = "editor-buffer-changed";
pub const EVENT_SCROLL_SYNC: &str = "scroll-sync";
pub const EVENT_MENU_OPEN: &str = "menu-open";
pub const EVENT_MENU_OPEN_FOLDER: &str = "menu-open-folder";
pub const EVENT_MENU_CLOSE: &str = "menu-close";
pub const EVENT_MENU_FIND: &str = "menu-find";
pub const EVENT_MENU_FIND_NEXT: &str = "menu-find-next";
pub const EVENT_MENU_FIND_PREV: &str = "menu-find-prev";
pub const EVENT_MENU_FIND_USE_SELECTION: &str = "menu-find-use-selection";
pub const EVENT_MENU_FIND_REPLACE: &str = "menu-find-replace";
pub const EVENT_MENU_EXPORT_HTML: &str = "menu-export-html";
pub const EVENT_MENU_FORMAT_BOLD: &str = "menu-format-bold";
pub const EVENT_MENU_FORMAT_ITALIC: &str = "menu-format-italic";
pub const EVENT_MENU_FORMAT_LINK: &str = "menu-format-link";
pub const EVENT_MENU_FORMAT_STRIKE: &str = "menu-format-strike";
pub const EVENT_MENU_COMMAND_PALETTE: &str = "menu-command-palette";
#[allow(dead_code)]
pub const EVENT_MENU_PRINT: &str = "menu-print";

// Menu IDs (used in rebuild_app_menu and on_menu_event)
pub const MENU_NEW_FILE: &str = "new-file";
pub const MENU_NEW_WINDOW: &str = "new-window";
pub const MENU_OPEN: &str = "open";
pub const MENU_OPEN_FOLDER: &str = "open-folder";
pub const MENU_PRINT: &str = "print";
pub const MENU_EXPORT_PDF: &str = "export-pdf";
pub const MENU_EXPORT_HTML: &str = "export-html";
pub const MENU_CLOSE: &str = "close";
pub const MENU_QUIT: &str = "quit";
pub const MENU_FIND: &str = "find";
pub const MENU_FIND_NEXT: &str = "find-next";
pub const MENU_FIND_PREV: &str = "find-prev";
pub const MENU_FIND_USE_SELECTION: &str = "find-use-selection";
pub const MENU_FIND_REPLACE: &str = "find-replace";
pub const MENU_FORMAT_BOLD: &str = "format-bold";
pub const MENU_FORMAT_ITALIC: &str = "format-italic";
pub const MENU_FORMAT_LINK: &str = "format-link";
pub const MENU_FORMAT_STRIKE: &str = "format-strike";
pub const MENU_COMMAND_PALETTE: &str = "command-palette";
pub const MENU_SETUP_CLI: &str = "setup-cli";
pub const MENU_ABOUT: &str = "about";
// Open Recent submenu: item ids are MENU_RECENT_PREFIX + URL_SAFE_NO_PAD b64(path).
// The Clear id must NOT share the prefix or strip_prefix would decode it.
pub const MENU_RECENT_PREFIX: &str = "recent-file-";
pub const MENU_RECENT_CLEAR: &str = "recent-clear";

// Scroll sync kinds (ScrollSyncPayload.kind) — used by JS only
#[allow(dead_code)]
pub const KIND_MARKDOWN: &str = "markdown";
#[allow(dead_code)]
pub const KIND_JSON: &str = "json";
#[allow(dead_code)]
pub const KIND_YAML: &str = "yaml";
#[allow(dead_code)]
pub const KIND_TXT: &str = "txt";

// Recent files cap (most-recent first)
pub const MAX_RECENT_FILES: usize = 10;

// Window label prefixes
pub const WINDOW_PREFIX_MARKDOWN: &str = "markdown-";
pub const WINDOW_PREFIX_EDITOR: &str = "editor-";
pub const WINDOW_PREFIX_FILE: &str = "markdown-file-";
pub const MENU_WINDOW_PREFIX: &str = "window-";
