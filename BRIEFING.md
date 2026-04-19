# Briefing

- Purpose: Fast Markdown viewer and editor built with Rust and Tauri.

- Current scope:
  - Frontend: HTML/JS/CSS loaded via Tauri webview.
  - Backend: Rust (Tauri 2.x) with markrust-core rendering library.
  - File watchers with debounced notifications (250ms) to multiple subscriber windows.
  - LRU HTML cache (50 entries) keyed by (path, size, mtime, theme).
  - Dynamic native menus with multi-window support and deduplication.
  - Persistent preferences via tauri-plugin-store (theme, window size, font).
  - In-page find with Ctrl+F in both preview and editor windows.
  - Bidirectional scroll sync between editor and preview with debouncing.
  - PDF viewing via blob URLs with proper cleanup.
  - CLI usage: launch with file path, auto-creates files if missing.

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

- Non-goals:
  - Cross-platform builds not supported.
  - macOS 10.13+ minimum required for builds.

- Dependencies:
  - Rust toolchain (2021 edition).
  - Node.js/npm for Tauri CLI.
  - macOS: Apple Developer credentials for release builds.
  - Windows: Optional WiX Toolset v3.x for MSI installers.
