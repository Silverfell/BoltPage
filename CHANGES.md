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
