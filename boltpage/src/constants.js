// Event names (must match Rust constants in src-tauri/src/constants.rs)
export const EVENT_FILE_CHANGED = 'file-changed';
export const EVENT_THEME_CHANGED = 'theme-changed';
export const EVENT_FONT_SIZE_CHANGED = 'font-size-changed';
export const EVENT_FONT_FAMILY_CHANGED = 'font-family-changed';
export const EVENT_TOOLBAR_DENSITY_CHANGED = 'toolbar-density-changed';
export const EVENT_EDITOR_WINDOW_CLOSED = 'editor-window-closed';
export const EVENT_EDITOR_BUFFER_CHANGED = 'editor-buffer-changed';
export const EVENT_SCROLL_SYNC = 'scroll-sync';
export const EVENT_MENU_OPEN = 'menu-open';
export const EVENT_MENU_OPEN_FOLDER = 'menu-open-folder';
export const EVENT_MENU_CLOSE = 'menu-close';
export const EVENT_MENU_FIND = 'menu-find';
export const EVENT_MENU_FIND_NEXT = 'menu-find-next';
export const EVENT_MENU_FIND_PREV = 'menu-find-prev';
export const EVENT_MENU_FIND_USE_SELECTION = 'menu-find-use-selection';
export const EVENT_MENU_FIND_REPLACE = 'menu-find-replace';
export const EVENT_MENU_EXPORT_HTML = 'menu-export-html';
export const EVENT_MENU_PRINT = 'menu-print';
export const EVENT_MENU_FORMAT_BOLD = 'menu-format-bold';
export const EVENT_MENU_FORMAT_ITALIC = 'menu-format-italic';
export const EVENT_MENU_FORMAT_LINK = 'menu-format-link';
export const EVENT_MENU_FORMAT_STRIKE = 'menu-format-strike';
export const EVENT_MENU_COMMAND_PALETTE = 'menu-command-palette';

// Scroll sync kinds
export const KIND_MARKDOWN = 'markdown';
export const KIND_JSON = 'json';
export const KIND_YAML = 'yaml';
export const KIND_TXT = 'txt';
