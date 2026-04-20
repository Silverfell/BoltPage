# Briefing

- Purpose: Fast Markdown viewer and editor built with Rust and Tauri.

- Current scope:
  - Frontend: HTML/JS/CSS loaded via Tauri webview.
  - Backend: Rust (Tauri 2.x) with markrust-core rendering library.
  - File watchers with debounced notifications (250ms) to multiple subscriber windows.
  - LRU HTML cache (50 entries) keyed by (path, size, mtime, theme).
  - Dynamic native menus with multi-window support and deduplication.
  - Persistent preferences via tauri-plugin-store (theme, window size, font, word_wrap, line_numbers, toc_visible, toolbar_density, editor_inspector_visible, recent_files).
  - Docked in-page find with Ctrl+F in both preview and editor windows (slot-based, between toolbar and content); match-case and whole-word toggles, all-matches highlighting, 80ms debounce.
  - Cross-platform native Edit menu via PredefinedMenuItem (Undo/Redo/Cut/Copy/Paste/Select All); Window menu gains Minimize.
  - Find navigation shortcuts: Cmd/Ctrl+G (next), Shift+Cmd/Ctrl+G (previous), Cmd/Ctrl+E (use selection for find), Cmd/Ctrl+Alt+F (find and replace, editor only).
  - Bidirectional scroll sync between editor and preview with debouncing.
  - PDF viewing via blob URLs with proper cleanup.
  - CLI usage: launch with file path, auto-creates files if missing.
  - Recent files list (10 entries, most-recent first, dead paths filtered on read; store authoritative via Rust push_to_recents holding pref_lock).
  - Editor inspector rail: words/chars/lines/cursor/selection/UTF-8/EOL, rAF-coalesced; Ctrl+Shift+I toggle.
  - Toolbar density (icon-label / icon / label) with live cross-window broadcast via EVENT_TOOLBAR_DENSITY_CHANGED.
  - HIG-native macOS chrome: semantic material tokens (--content-bg / --toolbar-bg / --sidebar-bg), 26pt grouped toolbar, 6px control radii, backdrop-filter retained only on .app-header.

- Key decisions:
  - RwLock for read-heavy state (open_windows, html_cache); single Arc<Mutex<FileWatcherInner>> for file watchers.
  - tokio::sync::Mutex for async consistency.
  - Content Security Policy enforced in tauri.conf.json.
  - File extension allowlist for rendering: md, markdown, json, yaml, yml, txt.
  - write_file command requires file to already exist.
  - No hardcoded paths; resolve via resolve_file_path.
  - Debouncing: file 250ms, resize 450ms, scroll sync 50ms.
  - Cache invalidation via file watchers on modification.
  - Scroll sync: line height 1.4x, programmatic timeout 100ms, delta thresholds.
  - Debug builds use debug_log macro (eprintln); release builds strip it.
  - Run cargo fmt before committing Rust code.
  - Release tags must be lightweight, not annotated.
  - Version source of truth is package.json; scripts/sync-version.sh propagates to tauri.conf.json and Cargo.toml (Cargo.lock via cargo check, Homebrew cask updated manually).
  - UI chrome aligned to Apple HIG: 38pt titlebar material, 10px window radius, 6px control radii, three themes (light/dark/drac), native font stack; .markdown-body keeps serif stack.
  - Cross-window preference broadcasts follow echo-suppression pattern: listener compares payload to local state and early-returns on match (theme, font-size, toolbar-density).
  - Recent files push is authoritative in Rust (io::push_to_recents under pref_lock); JS refreshes on DOM-ready and window focus via invoke('get_recent_files').
  - Edit actions (Undo/Redo/Cut/Copy/Paste/Select All) use tauri PredefinedMenuItem so they route through AppKit responder chain on macOS and Win32 messages on Windows; no JS performEditAction shim remains. Preview still installs a copy-event listener to guarantee text/html + text/plain on the clipboard.
  - macOS application submenu (About, Services, Hide, Hide Others, Show All, Quit) is cfg(target_os = "macos"); Quit moves out of File on mac, stays in File on Windows. About stays in Help on Windows.
  - Editor textarea has spellcheck enabled, caret-color and ::selection tokens defined per theme; replace operations use setRangeText to keep the native undo stack intact.

- Non-goals:
  - Cross-platform builds not supported.
  - macOS 10.13+ minimum required for builds.

- Dependencies:
  - Rust toolchain (2021 edition).
  - Node.js/npm for Tauri CLI.
  - macOS: Apple Developer credentials for release builds.
  - Windows: Optional WiX Toolset v3.x for MSI installers.
