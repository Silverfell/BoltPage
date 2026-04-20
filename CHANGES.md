# Changes

Format: `YYYY-MM-DD [type] description` (max 200 chars). Types: decision, plan, doc, scope, code, note.

2026-02-17 [code] Removed duplicate escapeHtml (use shared.js); dropped theme from CacheKey; editor init try/catch; atomic save_preference_key; missing link-scroll-btn; CSS max-width fix.
2026-02-17 [code] Added path-allowlisting security: normalize_path, check_path_allowed, allow_path.
2026-02-17 [note] Bumped version 1.6.5 to 1.8.0.
2026-02-17 [code] Select All scoped to #markdown-content; cut in preview copies without deleteFromDocument; removed no-op undo/redo; Clipboard API for editor paste and cut.
2026-02-17 [code] Removed scroll-link toggle; scroll sync always active (breaking change).
2026-02-17 [code] Deterministic editor window label (editor-{base64path}); Edit focuses existing editor instead of duplicating.
2026-02-17 [code] Theme dropdown positioning fix: theme-menu wrapped in position:relative container.
2026-02-17 [code] Added find-and-replace to editor: Ctrl+H, replace row UI, replaceCurrent/replaceAll, escapeRegex helper.
2026-02-17 [code] Find highlight overlay in editor with orange background; window scrolls to match accurately.
2026-02-17 [code] Editor close button fix: synchronous preventDefault in onCloseRequested, save if dirty, destroy().
2026-02-17 [code] About dialog version fix (app.package_info().version); beforeBuildCommand sync script: package.json is single source of truth.
2026-02-18 [code] HTML export: save_html_export command with inlined CSS; Ctrl+Shift+E for HTML, Ctrl+Shift+P for PDF.
2026-02-18 [code] Editor line number gutter synced to textarea scroll; wrap disabled; find overlay reuses wrapper.
2026-02-18 [code] TOC sidebar auto-generated from h1-h6 headings; clickable navigation, active heading tracking, toggle button; hidden for non-markdown.
2026-03-16 [code] TOC visibility persisted via preferences; buildTOC respects tocVisible state.
2026-03-16 [code] Editor word wrap toggle persisted; line numbers aligned via mirror measurement div; ResizeObserver recalculates on resize.
2026-03-16 [code] Restored allow_path in create_window_with_file (fixes CLI/file association opens); added core:window:allow-destroy.
2026-03-16 [code] Version sync fix: BSD sed compatibility via awk in sync-version.sh; committed tauri.conf.json and Cargo.toml with correct version.
2026-03-16 [code] Editor typing freeze fix: rAF coalescing, differential line number updates, innerHTML rebuilds for full redraws.
2026-03-16 [decision] Architecture refactor: split lib.rs into flat modules (prefs, io, watchers, window, menu); shared constants; table-driven menu/keyboard dispatch.
2026-03-24 [note] Version bump 1.8.1 to 1.9.0; pushed lightweight tag v1.9.0 to trigger release workflow.
2026-03-25 [code] Editor header compacted to match viewer: removed document-identity block, flattened toolbar, smaller brand icon, kept status badge and Close.
2026-03-25 [note] Version bump 1.9.0 to 1.9.1 across package.json, tauri.conf.json, Cargo.toml, Cargo.lock, Homebrew cask.
2026-03-25 [code] White flash on window open fixed: theme injected via Tauri initialization_script in viewer and editor WebviewWindowBuilder.
2026-04-19 [note] Populated BRIEFING.md and CHANGES.md from project.db memory/changes tables.
2026-04-19 [decision] Consolidated CI: merged pr-checks.yml into ci.yml (pull_request + workflow_dispatch only), dropped Linux matrix (non-shipped), dropped redundant cargo check job, fixed branch list (main, dev).
2026-04-19 [decision] Ruleset "publicprotected" on ~DEFAULT_BRANCH now requires status check "CI Success" (from ci.yml aggregator job); keeps deletion and non-fast-forward rules.
2026-04-19 [doc] Added redesign.html: self-contained UI redesign proposal per Apple HIG (quieter chrome, semantic materials, native typography, grouped 26pt toolbar, docked find, welcome variants, editor inspector).
2026-04-19 [doc] README: AI Coding Agent notes now points to Silverfell/klaude (Claude management system) instead of describing local ai_truthfulness.md / ai_software.md.
2026-04-19 [code] Viewer chrome rewritten to native-macOS token system (material surfaces, 26pt grouped toolbar, flat document); welcome replaced with Option-B card (recents hidden, Phase 3).
2026-04-19 [code] Editor chrome rewritten; find overlay docked into #find-bar-slot (viewer+editor); View popover rebuilt (seg/stepper/switch); #update-status pill wired to EVENT_FILE_CHANGED; removed no-op renderEditorHeader.
2026-04-19 [scope] Removed #sidebar-meta panel (File Type/Path/Access/Workflow/Type Size/Shortcuts rows), renderSidebarMeta() + CSS. Sidebar now shows TOC only. Per user decision, not in redesign plan.
2026-04-19 [code] Welcome-screen icon: replaced gradient tile + inline lightning-bolt SVG with the app icon (assets/boltpage_icon.png, 96px). Per user, overrides redesign.html Option-B card spec.
2026-04-19 [code] Phase 3: prefs toolbar_density/editor_inspector_visible/recent_files; cmds get_recent_files+broadcast_toolbar_density_change; density live-sync; inspector rail live (Ctrl+Shift+I).
2026-04-19 [code] Phase 1 audit fix: dropped backdrop-filter on .toc-sidebar per plan (flush sidebar, only .app-header retains titlebar material).
2026-04-19 [note] Version bump 1.9.1 to 2.0.0 across package.json, tauri.conf.json, Cargo.toml, Cargo.lock, Homebrew cask.
2026-04-19 [decision] Text-editing overhaul cross-platform: Edit menu rebuilt on PredefinedMenuItem (Undo/Redo/Cut/Copy/Paste/Select All) so cmds route through OS responders/messages; custom performEditAction paths removed.
2026-04-19 [decision] macOS-only AppKit affordances gated behind cfg: app menu with About/Services/Hide/HideOthers/ShowAll/Quit; Quit moved from File to app menu on macOS (stays in File on Windows); Window menu gains PredefinedMenuItem::minimize cross-platform.
2026-04-19 [code] Find bar rewritten: match-case + whole-word toggles, all-matches highlight (DOM-wrap spans in preview, multi-mark overlay in editor), 80 ms debounce, focus restore on Esc, prefill from selection; editor find-overlay now syncs scrollLeft.
2026-04-19 [code] New find menu items + shortcuts: Find Next (Cmd/Ctrl+G), Find Previous (Shift+Cmd/Ctrl+G), Use Selection for Find (Cmd/Ctrl+E), Find and Replace (Cmd/Ctrl+Alt+F, replacing Ctrl+H which collided with macOS Hide).
2026-04-19 [code] Preview rich-copy handler writes text/html + text/plain on copy events so pasting into Pages/Word/Mail keeps formatting.
2026-04-19 [code] Editor replace uses setRangeText to preserve native undo; paste/cut stop mutating .value directly now that PredefinedMenuItem handles them.
2026-04-19 [code] Editor textarea spellcheck enabled; ::selection and caret-color tokens added per theme (light/dark/drac) for preview, editor, and find inputs.
2026-04-19 [code] Preview link interceptor bails on multi-click and active selection so double-click word-select works on linked headings; Cmd/Ctrl+A scoped to #markdown-content only when a file is open.
