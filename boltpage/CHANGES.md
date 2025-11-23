# Changes

2025-11-23: Add File -> New menu to create empty markdown files immediately and open them; bump version to 1.6.1
2025-11-19: Fix async Mutex usage throughout lib.rs (tokio::sync::Mutex requires .await on .lock())
2025-11-19: Add debug_log macro for conditional debug output (eprintln in debug builds, no-op in release)
2025-11-19: Make stop_file_watcher async to properly await mutex locks
2025-11-19: Refactor window event handlers to spawn async tasks for mutex operations
2025-11-19: Remove unused SystemTime import in render_file_to_html
2025-11-19: Fix CloseRequested handler lifetime error (clone AppHandle before moving into async task)
2025-11-19: Fix Resized handler lifetime error (clone AppHandle before moving into async task)
2025-11-19: Fix formatting issues (return statements on same line as closing braces)
2025-11-19: Fix Resized handler borrow checker error (extract Arc directly instead of cloning entire state)
2025-11-19: Unify line height calculation (1.4 multiplier) across editor.js and main.js to eliminate vertical misalignment
2025-11-19: Replace requestAnimationFrame with setTimeout (50ms) for scroll sync debouncing to reduce broadcast frequency
2025-11-19: Increase programmatic scroll timeout (0ms to 100ms) to prevent echo loops between editor and viewer
2025-11-19: Add scroll delta thresholds (0.5 lines, 1% for markdown) to filter micro-scroll events and eliminate jitter
2025-11-19: Replace scrollTo with direct scrollTop assignment for consistent cross-browser scroll behavior
2025-11-19: Fix percentage calculation edge case (check scrollableHeight > 0 before dividing)
2025-11-19: Add offset calculation caching in main.js to avoid repeated DOM walking during scroll events
2025-11-19: Add txt file type to scroll sync handlers (was missing from preview listener)
