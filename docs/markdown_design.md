MarkRust Briefing Document

Overview

MarkRust is a cross‑platform Markdown editor and viewer designed for macOS and Windows.  It will be written in Rust with a Tauri front‑end, using pulldown‑cmark for Markdown parsing and syntect for syntax highlighting.  MarkRust focuses on speed, a small binary size and a responsive native feel.

Key features include:
	•	Native Markdown viewer and editor: double‑clicking a .md file, running markrust <file> from the command line, or using the OS “Open with → MarkRust” context menu will open the file.  The app presents the Markdown document in a full preview window and supports multiple simultaneous preview windows.
	•	GitHub‑flavored extensions: pulldown‑cmark optionally supports footnotes, tables, task lists and strikethrough ￼, so MarkRust will enable these.  Code fences will be syntax highlighted via syntect.
	•	User‑friendly interface: a top‑right toolbar provides Open file, Refresh, Theme and Edit buttons.  A file menu offers Open/Quit/About actions and keyboard shortcuts (Ctrl+O to open, Ctrl+R to refresh, etc.).  A dark, light, system, and drac (Darkula‑inspired) theme can be selected and will persist between sessions.
	•	External change indicator: MarkRust monitors each open file.  If the file is modified on disk, the Refresh button gains an overlaid exclamation mark to prompt the user to reload it; automatic reloading is deliberately avoided.
	•	Simple editor: clicking Edit opens a separate window with a plain‑text ASCII editor and basic Markdown syntax highlighting using syntect.  Edits automatically update the preview and save to disk.
	•	Persistence: the chosen theme and the last preview‑window size are stored and applied to future sessions.
	•	Manual updates: no auto‑updater will be included.  Platform‑specific installers (.msi/.exe for Windows, .dmg for macOS) will be code‑signed and notarized.

Development Phases

The project will be executed in five sequential phases.  Each phase includes a detailed prompt to guide implementation.

Phase 1 – Project Setup and Basic Viewer

Goal: Establish the Rust/Tauri project, implement basic Markdown viewing with pulldown‑cmark and create the initial UI framework.

Prompt:
	1.	Initialize a Tauri project on macOS (which will also build for Windows later).  Set up a Rust workspace with separate crates if needed (e.g., a core library and a Tauri front‑end).
	2.	Implement the CLI interface so that running markrust <file> or double‑clicking a .md file launches the application and opens that file.  Register MarkRust as the default handler for .md files and integrate it with the OS “Open with…” context menu.
	3.	On startup without arguments, display a native file‑open dialog to select a Markdown file.
	4.	Parse Markdown using pulldown‑cmark: create a function that reads the file, constructs a Parser with the necessary options (enable footnotes, tables, task lists and strikethrough ￼), and renders to HTML.  Use a minimal HTML template and CSS for the preview.
	5.	Design the initial UI: a native window containing the rendered HTML with a top‑right toolbar.  Create stub buttons for Open file, Refresh, Theme, and Edit, and implement the menu bar with Open/Quit/About.  Style the UI using the default light and dark themes, and support system appearance.  Save the chosen theme to persistent storage using Tauri’s configuration API.
	6.	Implement keyboard shortcuts for Open (Ctrl/⌘ + O), Refresh (Ctrl/⌘ + R), cycling themes (Ctrl/⌘ + T), and Edit (Ctrl/⌘ + E).
	7.	Persist window size: listen for resize events in the preview window.  Store the latest size to local storage and apply it when creating new preview windows.

Expected outcome: a simple Tauri application that can open and display Markdown files with GitHub‑style extensions, support multiple themes and persist the chosen theme and window size.

Phase 2 – Syntax Highlighting and Basic Editor

Goal: Enhance the preview with syntax‑highlighted code blocks and implement a basic editing window.

Prompt:
	1.	Integrate syntect: detect fenced code blocks during Markdown parsing.  For each fenced block, use syntect to highlight the code according to its language and output HTML spans with CSS classes or inline styles.  Provide a small set of built‑in themes for code highlighting that harmonize with the dark, light and drac themes.  Ensure performance remains high by caching syntax definitions.
	2.	Implement the editor window: when the Edit button or Ctrl/⌘ + E is pressed, open a separate window containing a plain text editor.  Use a Rust or web‑based component capable of handling simple text input (e.g., a textarea or a lightweight CodeMirror/Monaco instance).  Apply basic Markdown syntax highlighting via syntect.
	3.	Auto‑save and live preview: whenever the user types, update the file on disk immediately and re‑render the preview in the associated window.  Ensure that undo/redo history exists within the editor; using a standard component such as CodeMirror provides this for free.
	4.	Manage multiple editors: if multiple preview windows are open, each can open its own editor.  Ensure each editor window is tied to the correct file and preview.

Expected outcome: MarkRust will render code fences with proper syntax highlighting, and users can edit files via a dedicated editor that automatically updates the preview and saves changes.

Phase 3 – External Change Detection and Multi‑Window Support

Goal: Add detection of external file modifications, a manual refresh mechanism, and robust handling of multiple simultaneous windows.

Prompt:
	1.	Implement file watching: use a cross‑platform crate such as notify to watch each open file.  When the underlying file changes externally, set a flag that causes the Refresh button’s icon to display an overlaid exclamation mark.  Do not automatically reload the content.  Clicking Refresh should reload the file from disk, clear the flag, and re‑render the preview.
	2.	Manage multiple windows: allow the user to open several Markdown files at once.  Each preview window maintains its own state (file contents, theme, exclamation flag) but shares global preferences (theme choice and default window size).  Ensure that closing a window stops its file watcher.
	3.	Window management: add menu commands or a window list if necessary to switch between open documents.  Ensure keyboard shortcuts still apply to the active window.

Expected outcome: MarkRust will correctly indicate when an open file has changed on disk and require the user to click Refresh to reload.  Users can comfortably work with multiple documents in independent windows.

Phase 4 – Theme Persistence and User Preferences

Goal: Finalize theme handling, add the “drac” theme and persist user preferences across sessions.

Prompt:
	1.	Implement the “drac” theme: derive a palette inspired by the Darkula colour scheme.  Apply it consistently to the toolbar, preview and editor, including syntax‑highlighted code blocks.
	2.	Theme menu: clicking the Theme button should present a small menu or pop‑over with options: Light, Dark, System, and Drac.  Selecting an option applies it immediately and saves it in persistent storage.
	3.	Persist additional preferences: store the last resized window size and any other user‑modifiable settings in a configuration file under the user’s home directory.  Load these preferences at startup.
	4.	Ensure cross‑platform look and feel: adapt UI spacing, icons and fonts to match conventions on Windows and macOS.  Use Tauri’s API to access native dialogs and menus.

Expected outcome: users can choose among four themes, and MarkRust will remember both their theme and preferred window size across restarts.

Phase 5 – Packaging, Code Signing and Distribution

Goal: Prepare MarkRust for release, including installers for macOS and Windows and manual update procedures.

Prompt:
	1.	Windows packaging: configure Tauri’s bundler to produce a signed installer (e.g., .msi or .exe).  Obtain a Windows code‑signing certificate and sign the binary.  Ensure the installer registers file associations for .md files and adds “Open with MarkRust” to the context menu.
	2.	macOS packaging: configure Tauri to produce a signed and notarized .dmg.  Use an Apple Developer ID certificate to sign the app and run it through the notarization process.  Enable the proper entitlements for opening files and watching directories.
	3.	CLI binary: compile a standalone markrust binary that can be placed in the user’s PATH.  It should simply launch the GUI with the specified file argument or prompt for a file if no argument is given.
	4.	Manual update instructions: document how to download and install new releases.  Since auto‑update is omitted, guide users to check for updates on your website or GitHub releases.
	5.	Final testing: thoroughly test the installers on clean installations of Windows and macOS.  Verify that themes persist, file watching works, and all keyboard shortcuts operate as expected.

Expected outcome: platform‑specific installers will be available, signed and notarized, ready for distribution.  Users can install MarkRust easily and update manually when new versions are released.

Summary

MarkRust will provide a fast, lightweight Markdown viewer/editor built with Rust, Tauri and pulldown‑cmark.  It emphasizes performance ￼ and supports essential GitHub Markdown extensions ￼ while offering a simple yet polished user experience.  By following the phased plan above, we ensure a gradual rollout—from core viewing functionality to editing, multi‑window support, preferences, and professional packaging—yielding a high‑quality tool that meets the stated requirements.