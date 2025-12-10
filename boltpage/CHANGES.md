# Changes

2025-12-10: Remove "system" theme option and set "drac" as the default theme
2025-12-10: Add "Setup CLI Access..." menu item to Help menu for manual CLI configuration
2025-12-10: Fix clippy linting warnings: convert all format! strings to use inline format variables (e.g., format!("{x}") instead of format!("{}", x))
2025-12-10: Fix dead code warnings: remove initial_empty_window field and open_markdown_window function
2025-12-10: Improve window creation logic: use tokio::task::yield_now() instead of arbitrary delays (proper macOS event loop pattern)
2025-12-10: Fix double-click behavior: delay empty window creation by 1 second to allow Opened events to process first
2025-12-10: Fix CLI setup: check preferences per-session, re-prompt if CLI not actually installed
2025-12-10: Fix CLI script to resolve relative paths to absolute paths before passing to 'open' command (preserves working directory context)
2025-12-10: Fix window creation logic: always create window on launch (empty if no file), detect initial launch file opens and close empty windows automatically
2025-12-10: Fix CLI setup dialog blocking (removed alert, use console.log instead)
2025-12-10: Fix terminal lock when launching from CLI (use shell script wrapper with 'open' command on macOS)
2025-12-10: Add AppleScript automation entitlement to prevent JavaScript permission dialog on CLI setup
2025-12-10: Add automatic CLI setup on first run with platform-specific installation (macOS shell script, Windows PATH)
2025-12-10: Add Homebrew cask binary stanza for automatic CLI access via brew install
2025-12-10: Remove unused save_window_size command (window resize now handled directly in Rust event system)
2025-12-10: Fix version mismatch (aligned package.json to 1.6.2)
2025-12-10: Update BRIEFING.md with PDF support, find functionality, scroll sync parameters, and CLI file creation details
2025-11-23: Allow CLI invocation with a new file path to auto-create and open the file
2025-11-23: Add File -> New menu to create empty markdown files immediately and open them; bump version to 1.6.1
2025-11-23: Harden release workflow certificate decoding/import for macOS and Windows
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
