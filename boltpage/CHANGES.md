# Changes

2025-11-19: Fix async Mutex usage throughout lib.rs (tokio::sync::Mutex requires .await on .lock())
2025-11-19: Add debug_log macro for conditional debug output (eprintln in debug builds, no-op in release)
2025-11-19: Make stop_file_watcher async to properly await mutex locks
2025-11-19: Refactor window event handlers to spawn async tasks for mutex operations
2025-11-19: Remove unused SystemTime import in render_file_to_html
2025-11-19: Fix CloseRequested handler lifetime error (clone AppHandle before moving into async task)
2025-11-19: Fix Resized handler lifetime error (clone AppHandle before moving into async task)
2025-11-19: Fix formatting issues (return statements on same line as closing braces)
2025-11-19: Fix Resized handler borrow checker error (extract state before spawning async task)
