// Event names (must match Rust constants in src-tauri/src/constants.rs)
export const EVENT_FILE_CHANGED = 'file-changed';
export const EVENT_THEME_CHANGED = 'theme-changed';
export const EVENT_SCROLL_SYNC = 'scroll-sync';
export const EVENT_MENU_OPEN = 'menu-open';
export const EVENT_MENU_CLOSE = 'menu-close';
export const EVENT_MENU_FIND = 'menu-find';
export const EVENT_MENU_EDIT = 'menu-edit';
export const EVENT_MENU_EXPORT_HTML = 'menu-export-html';
export const EVENT_MENU_PRINT = 'menu-print';

// Edit actions (payloads of EVENT_MENU_EDIT)
export const ACTION_UNDO = 'undo';
export const ACTION_REDO = 'redo';
export const ACTION_CUT = 'cut';
export const ACTION_COPY = 'copy';
export const ACTION_PASTE = 'paste';
export const ACTION_SELECT_ALL = 'select-all';

// Scroll sync kinds
export const KIND_MARKDOWN = 'markdown';
export const KIND_JSON = 'json';
export const KIND_YAML = 'yaml';
export const KIND_TXT = 'txt';
