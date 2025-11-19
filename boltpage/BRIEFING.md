# BoltPage Project Briefing

## Overview
BoltPage is a fast Markdown viewer and editor built with Rust and Tauri. It renders Markdown, JSON, YAML, and plain text files with syntax highlighting and multiple themes.

## Architecture
- **Frontend**: HTML/JS/CSS loaded via Tauri webview
- **Backend**: Rust (Tauri 2.x) with markrust-core library for rendering
- **State Management**:
  - RwLock for read-heavy operations (open_windows, html_cache)
  - Async Mutex (tokio::sync::Mutex) for write-heavy operations (file watchers, resize tasks)
- **Concurrency**: Async runtime (Tokio) for file watching, debouncing, and cache management

## Key Components
- **File Watchers**: Per-file watchers with debounced notifications (250ms) to multiple subscriber windows
- **HTML Cache**: LRU cache (50 entries) keyed by (path, size, mtime, theme) for fast re-renders
- **Window Management**: Dynamic native menus, multi-window support, automatic deduplication of file windows
- **Preferences**: Persistent storage via tauri-plugin-store for theme, window size, font preferences

## Build Requirements
- Rust toolchain (2021 edition)
- Node.js/npm for Tauri CLI
- macOS: Code signing credentials (APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID) for release builds
- Windows: Optional WiX Toolset for MSI installers

## Critical Decisions
1. **Async Mutex**: Uses tokio::sync::Mutex throughout for consistency with async runtime. All .lock() calls require .await.
2. **No hardcoded paths**: File paths resolved via resolve_file_path to handle URLs, relative, and absolute paths uniformly.
3. **Debouncing**: File change notifications (250ms), window resize saves (450ms), and scroll sync broadcasts (50ms) to reduce I/O and state updates.
4. **Cache invalidation**: File watchers invalidate HTML cache entries on modification to ensure fresh renders.
5. **Scroll Sync Parameters**: Line height fallback (1.4x font-size), programmatic scroll timeout (100ms), delta thresholds (0.5 lines or 1% for markdown) prevent jitter and echo loops between editor and viewer windows.

## Known Constraints
- macOS 10.13+ required for builds
- Release builds on macOS require valid Apple Developer credentials
- Windows MSI builds require WiX Toolset v3.x installed separately
- Cross-platform builds not supported (macOS cannot build Windows installers in Tauri v2)

## Testing Notes
- Debug builds include debug_log macro output (eprintln)
- Release builds strip debug logging for performance
- Test with stale Cargo build cache by running `cargo clean` if project moved between directories
