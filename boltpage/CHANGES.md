# Changes

## 2026-01-13: Edit/Copy/Paste Tools Investigation

### Current State Analysis

**Native Edit Menu (lib.rs:197-236):**
- Undo (CmdOrCtrl+Z), Redo (Shift+CmdOrCtrl+Z), Cut, Copy, Paste, Select All, Find
- Menu events are emitted via `app.emit("menu-edit", &action)` at lib.rs:1207-1209

**Editor Window (editor.js):**
- Keyboard shortcuts captured at lines 201-229 for undo/redo/copy/cut/paste/select-all
- `performEditAction()` at lines 350-393 handles: copy, cut, paste, select-all
- **ISSUE**: No cases for 'undo' or 'redo' - native menu triggers these but JS ignores them

**Viewer Window (main.js):**
- Keyboard shortcuts captured at lines 445-480 for undo/redo/copy/cut/paste/select-all
- `performEditAction()` at lines 758-803 handles: copy, cut, paste, select-all
- **ISSUE**: No cases for 'undo' or 'redo' - menu events are silently ignored
- **ISSUE**: Cut operation deletes from read-only content (inappropriate for viewer)

### Missing Standard Industry Features

1. **Right-Click Context Menu (CRITICAL)**
   - Neither editor.html nor index.html implement a context menu
   - Users expect right-click access to Cut/Copy/Paste/Select All
   - Industry standard for all text editors and viewers

2. **Undo/Redo Support in Editor**
   - Native menu emits 'undo'/'redo' events but `performEditAction()` lacks handlers
   - Textarea has native undo/redo stack but not connected to menu events
   - Fix: Add undo/redo cases using `document.execCommand('undo'/'redo')` or maintain custom stack

3. **Find & Replace in Editor**
   - Only Find functionality exists (Ctrl+F)
   - No Replace or Replace All - standard feature for any text editor
   - Find overlay exists but lacks replace input field

4. **Inappropriate Viewer Operations**
   - Cut in viewer calls `selection.deleteFromDocument()` which modifies read-only rendered content
   - Fix: Remove cut handling from viewer or make it copy-only

### Proposed Fixes

#### Priority 1: Right-Click Context Menu
**Files to modify:** editor.js, main.js, editor.css, styles.css

Editor context menu should include:
- Undo, Redo (separator)
- Cut, Copy, Paste, Delete (separator)
- Select All

Viewer context menu should include:
- Copy (separator)
- Select All

Implementation approach:
1. Create `createContextMenu()` function to build menu DOM
2. Add `contextmenu` event listener to prevent default and show custom menu
3. Add click-outside handler to dismiss menu
4. Style menu to match current theme (drac/light/dark)

#### Priority 2: Undo/Redo in Editor performEditAction
**File:** editor.js

Add cases to switch statement:
```javascript
case 'undo':
    document.execCommand('undo');
    break;
case 'redo':
    document.execCommand('redo');
    break;
```

Note: `document.execCommand` is deprecated but still works for textarea undo/redo.
Alternative: Use InputEvent with inputType='historyUndo'/'historyRedo' but browser support varies.

#### Priority 3: Find & Replace (Editor only)
**File:** editor.js, editor.css

Extend find overlay to include:
- Replace input field
- Replace / Replace All buttons
- Match case toggle (optional enhancement)

#### Priority 4: Fix Viewer Cut Operation
**File:** main.js

Remove or neuter cut handling in viewer:
```javascript
case 'cut':
    // Viewer is read-only - cut acts as copy only
    if (selection && selection.toString()) {
        await navigator.clipboard.writeText(selection.toString());
    }
    break;
```

---

## Previous Changes

2025-12-10: Fix unused-mut warning for help_menu_builder (only used on macOS/Windows)
2025-12-10: Fix code formatting issues (cargo fmt) for CI/CD pipeline
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
