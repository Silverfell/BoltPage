# BoltPage UI redesign — implementation plan

## Context

The proposal in `/Users/igor/Projects/boltpage_org/redesign.html` replaces BoltPage's current "glass web-app" UI (heavy blurs, 20–28px nested rounded panels, 42pt pill toolbar buttons, decorative body gradients, marketing-style welcome) with a macOS-native look aligned to Apple's HIG: semantic materials for toolbar/sidebar, 10px window / 6px control radii, 26pt grouped toolbar items, native font stack, docked find bar, and a quieter welcome state with recent files.

All UI lives in `boltpage/src/` (HTML/CSS/JS loaded by the Tauri webview). Preferences persist via `tauri-plugin-store` in `.boltpage.dat`; the atomic writer `prefs::save_preference_key_inner` (`prefs.rs:72`) is already async and `pub(crate)`, so internal Rust callers (Phase 3 recents push) can reuse it without duplicating logic. Three themes (`light`, `dark`, `drac`) are kept — values retuned to the new token palette.

Work is split into three testable phases. **Invariant across all phases:** every element ID that JS currently queries keeps its exact name, and every Tauri command keeps its exact signature. New prefs keys and one new command are added in Phase 3 only; no migration is required because `tauri-plugin-store` is JSON-typed and tolerant of missing fields.

---

## Critical files

### Frontend
- `boltpage/src/index.html` — viewer markup (titlebar region, toolbar, sidebar, welcome)
- `boltpage/src/editor.html` — editor markup (toolbar, textarea wrapper, inspector rail)
- `boltpage/src/styles.css` — viewer styles (1292 lines; token block + chrome rewritten; `.markdown-body` rules at lines ~776–1292 preserved via alias tokens)
- `boltpage/src/editor.css` — editor styles (499 lines; mirror token block + chrome rewritten; `.editor-textarea`, `.line-number-gutter`, `.line-mirror`, `.find-highlight-overlay` rules preserved intact)
- `boltpage/src/main.js` — viewer JS (find-overlay parent, view-popover markup, welcome recents wiring, updated pill, toolbar-density application)
- `boltpage/src/editor.js` — editor JS (inspector rail, inspector toggle, remove no-op `renderEditorHeader`)
- `boltpage/src/shared.js` — extend `createFindOverlay(parentEl = document.body)` signature; nothing else changes
- `boltpage/src/constants.js` — unchanged in Phase 1–2; Phase 3 optionally adds `TOOLBAR_DENSITY_*` string constants for readability

### Backend (Phase 3 only)
- `boltpage/src-tauri/src/prefs.rs` — extend `AppPreferences` (`prefs.rs:8`) with three optional fields
- `boltpage/src-tauri/src/io.rs` — `push_to_recents` helper; call after successful file-dialog pick (`io.rs:483`) and new-file creation (`io.rs:528`)
- `boltpage/src-tauri/src/lib.rs` — register new `get_recent_files` command (joining the invoke_handler list at `lib.rs:266` area); fire-and-forget recents push at CLI-arg site (`lib.rs:395`) and macOS Launch-Services site (`lib.rs:498–508`)
- `boltpage/src-tauri/src/menu.rs` — new broadcast `broadcast_toolbar_density_change` mirroring `broadcast_theme_change` (`menu.rs:146`), plus matching event in `constants.js` and `constants.rs`
- `boltpage/src-tauri/src/constants.rs` — add `MAX_RECENT_FILES: usize = 10` and `EVENT_TOOLBAR_DENSITY_CHANGED: &str = "toolbar-density-changed"`

### Artifacts (no changes)
- `redesign.html` stays as the visual reference document.
- `tauri.conf.json` unchanged (no new plugins or capabilities needed).
- `release-build.sh` / release workflow unchanged.

---

## Cross-cutting guardrails (apply every phase)

- **DOM ID contract — do not rename.** Viewer: `#open-btn`, `#new-btn`, `#edit-btn`, `#export-btn`, `#find-btn`, `#refresh-btn`, `#theme-btn`, `#theme-menu`, `.theme-option`, `#refresh-indicator`, `#rail-toggle-option`, `#rail-toggle-title`, `#rail-toggle-caption`, `#rail-toggle-state`, `#font-size-decrease-btn`, `#font-size-increase-btn`, `#font-size-indicator`, `#toc-sidebar`, `#toc-nav`, `#toc-open-btn`, `#toc-close-btn`, `#sidebar-meta`, `#markdown-content`, `.content-wrapper`, `.sidebar-label`, `.sidebar-caption`. Editor: `#editor-textarea`, `#editor-status-badge`, `#editor-font-size-indicator`, `#editor-font-size-decrease-btn`, `#editor-font-size-increase-btn`, `#line-numbers-btn`, `#wrap-btn`, `#find-btn`, `#close-btn`, `.editor-textarea-wrapper`, `.line-number-gutter`, `.line-mirror`, `.find-highlight-overlay`.
- **Reuse existing utilities.** Do not reimplement:
  - `createFindOverlay()` → `shared.js:81` (extend with optional `parentEl` parameter only).
  - `setBadgeState(el, text, tone, hidden)` → `shared.js:66`; tones `accent` / `success` / `warning` already exist. Use for the viewer's new `#update-status` pill.
  - `applyThemeToDocument(theme)` → `shared.js:121` (sets `data-theme` on `<html>`). Put `data-toolbar-density` on `<html>` too for consistency.
  - `setupKeyboardShortcuts(table)` → `shared.js:134`; both windows pass their own shortcut table. For Phase 3 add one entry to editor.js's table.
  - `invoke('save_preference_key', { key, value })` → atomic, already wrapped by `savePreference(key, value)` in `main.js:98`. Use this for every new pref.
  - `invoke('get_preferences')` → returns the `AppPreferences` struct; new Phase 3 fields are read through it automatically after the struct is extended. Existing call sites: `main.js:70`, `editor.js:209`.
  - `updateViewMenuState()` → `main.js:150`. Already rebuilds theme-option `.active` class and the rail-toggle state. Phase 2's new popover DOM must keep those IDs so this helper stays correct; Phase 3 extends it to also reflect `toolbar_density` + `editor_inspector_visible`.
  - `openFile(filePath)` → `main.js:401`. Welcome recents bind clicks to this exact function (no new path loader needed).
  - `prefs::save_preference_key_inner(&app, key, value)` → `prefs.rs:72`. **Not** usable for `push_to_recents` — its lock covers only the write, not the read. `push_to_recents` must take `pref_lock` itself (see Phase 3 step 3 and the existing precedent at `lib.rs:449–459`).
- **Style conventions.** 4-space indentation in JS (match existing). Rust uses `cargo fmt`. CSS uses kebab-case class names and per-root custom properties. No Tailwind / CSS-in-JS / SCSS introduced.
- **Remove what you make unused.** Per project rule: when touching a file, remove dead imports/vars/functions that become unused *because of your change*. Do not mass-clean pre-existing dead code (out of scope). Concrete item in scope: `renderEditorHeader()` at `editor.js:92–94` is already a no-op; Phase 2 deletes it since that function is touched anyway.
- **Docs per phase.** Each phase ends with a `CHANGES.md` entry (`YYYY-MM-DD [code] …` or `[decision] …`, ≤200 chars). No `BRIEFING.md` change is expected (no scope change); only update if a decision from this plan changes a listed "Key decision" in BRIEFING.
- **Print CSS preserved.** `@media print` at `styles.css:808` references `.app-header`, `.toc-sidebar`, `.toc-open-btn`, `.main-area`, `.content-wrapper`, `.markdown-body` — all class names are retained by the redesign, so print stays functional without rewriting that block.
- **PDF mode preserved.** `.pdf-mode` body class and `.pdf-mode .content-wrapper` / `.pdf-mode .markdown-body > .pdf-embed` rules (`styles.css:710–728`) must continue to take over the content pane at full bleed.
- **PDF-mode class toggle preserved.** The `.pdf-mode` body class is set/cleared by viewer JS around the `openFile` PDF branch (`main.js` ~line 434) and its cleanup. Phase 1 chrome edits must not refactor this toggle point nor move the `.pdf-mode` rules elsewhere.
- **Phase-2 atomicity.** Phase 2's HTML additions (`#find-bar-slot` in editor.html) and the JS call-site updates to `createFindOverlay(parent)` must land together in the same commit/PR. A partial apply leaves `createFindOverlay` with `undefined` parent and breaks `Ctrl+F` in one of the windows.
- **Broadcast echo guard required.** Any new cross-window broadcast (toolbar-density, future additions) must follow the existing theme pattern: the listener compares event payload to the current local value and early-returns if equal (`main.js:799–807`). Without this, `invoke → emit → listen` round-trips cause redundant DOM work and recursive `savePreference` calls.

---

## Phase 1 — Viewer shell (visual only)

**Goal:** the viewer window reads as native macOS under all three themes. No new features, no prefs changes, no Rust changes. The welcome screen takes its new layout; the recents list is present in the DOM but hidden (unwrapped in Phase 3).

### Changes

1. **`boltpage/src/styles.css` — token block rewrite** (`:root` + `[data-theme]` blocks at lines 1–125)
   - Introduce the new semantic tokens: `--content-bg`, `--toolbar-bg`, `--sidebar-bg`, `--titlebar-bg`, `--separator`, `--separator-strong`, `--text-primary`, `--text-muted`, `--text-tertiary`, `--accent`, `--accent-tint`, `--hover`, `--selected`, `--kbd-bg`, `--kbd-border`.
   - Keep the old token names as aliases mapped to the new ones — **required** because `.markdown-body` rules at lines 776–1292 read `--bg-color`, `--text-color`, `--text-secondary`, `--border-color`, `--link-color`, `--code-bg`, `--blockquote-color`, `--table-border`, `--table-alt-bg`, `--kbd-bg`, `--kbd-border` directly. Leaving the alias layer in place means the entire markdown-body block does not need to be touched.
   - Light values: `#FFFFFF` content, `rgba(246,246,246,.96)` toolbar/titlebar, `rgba(243,243,244,.85)` sidebar, `#0066CC` accent.
   - Dark values: `#1C1C1E` content, `rgba(40,40,42,.96)` toolbar, `rgba(34,34,36,.85)` sidebar, `#0A84FF` accent.
   - Drac values: its own tuned palette (retain the purple-shifted accent, e.g. `#BD93F9`-family; deeper content `#1A2131`; sidebar ~`#131B2A`). **Drac stays as its own distinct theme, not folded into dark.**
   - Delete the decorative gradient stack on `body` (`styles.css:139–143`): two radial-gradients plus one linear-gradient layered over `var(--surface-app)`. Body becomes a flat `var(--surface-app)` (= window background).

2. **`boltpage/src/styles.css` — chrome rewrite** (sections `.app-shell`, `.app-header`, `.header-main`, `.toolbar-btn`, `.toc-sidebar`, `.content-wrapper`, `.welcome-message`, `@media` blocks)
   - Drop the 20–28px border-radius, heavy shadow, and `backdrop-filter: blur(18px)` from `.header-main`, `.toc-sidebar`, `.content-wrapper`. These surfaces now sit flush to the window.
   - `.app-header` → 38pt flex row; background `var(--toolbar-bg)` + 1px bottom `var(--separator)`; `backdrop-filter: blur(20px) saturate(180%)` is retained (semantic, not decorative — approximates macOS titlebar material).
   - `.toolbar-btn` → 26pt tall, 6px radius, 12px font, transparent default; `:hover` = `var(--hover)`; `.active` / `.is-active` = `var(--selected)` with `var(--accent)` text. Remove the `translateY(-1px)` hover lift.
   - New utility classes: `.toolbar-group` (flex row; 2px gap; 0 4px padding; right-border `var(--separator)`; last `.toolbar-group` has no right border) and `.toolbar-spacer` (`flex: 1`).
   - `.button-prominent` retained as an alias class on `#open-btn` — background `var(--accent)`, foreground white in light, `#08131F` in dark (for contrast against bright accent).
   - Font stack for `:root` switches to `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "Segoe UI", system-ui, sans-serif`. `.markdown-body` keeps its serif stack (existing: `"Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif`).
   - `.welcome-message` becomes the Option-B card: 72pt gradient icon, 22pt display title, 13pt tagline, two `.wel-btn` CTAs (`.primary` / `.secondary`), an empty `.recent-list[hidden]` placeholder, `.kbd-hint`.

3. **`boltpage/src/styles.css` — add a find-bar slot shell.** Reserve a `.find-bar-slot` row between the toolbar and `.main-area` (0px tall when empty, `display: flex` when populated). This establishes the docked position Phase 2 needs; Phase 1 just lays down the stylesheet.

4. **`boltpage/src/index.html` — markup restructure**
   - Remove `.brand-block` / `.brand-icon` from `.header-lead` (the lead is a child of `.header-main`; brand identity is the window title + app icon in the Dock).
   - Wrap toolbar buttons in three `.toolbar-group` divs:
     - Group A: `#open-btn` (keeps `.button-prominent`) + `#new-btn`
     - Group B: `#edit-btn` + `#export-btn`
     - Group C: `#find-btn` + `#refresh-btn`
   - Add `<span id="update-status" class="tb-status" hidden></span>` just before `#theme-btn` (wired in Phase 2).
   - Keep the `#theme-btn` ID on the View button; convert to icon-only (drop the text label "View" so the button is 26×26). `#theme-menu` dropdown markup is rewritten in Phase 2.
   - Add `<div id="find-bar-slot" class="find-bar-slot"></div>` between `.app-header` and `.main-area` as the docked find bar's parent slot.
   - Replace `.welcome-message` contents with the Option-B card. The two CTA buttons get IDs `#welcome-open-btn` / `#welcome-new-btn` — Phase 1 wires them to delegate to `#open-btn.click()` / `#new-btn.click()`.
   - Sidebar outer card removed (no background panel / shadow). `#toc-sidebar` is now a flex child of `.main-area` with `var(--sidebar-bg)` and a right-border `var(--separator)`.

5. **`boltpage/src/main.js`** — smallest possible touch:
   - Wire `#welcome-open-btn` / `#welcome-new-btn` click handlers to delegate to the existing buttons.
   - No other changes.

### Verification
1. `cd boltpage && npm run tauri dev`; open `test.md` and a PDF file to sanity-check PDF mode.
2. Viewer at thumbnail size reads as a native macOS document app; no floating rounded panels, no background blobs.
3. Switch themes through the existing View menu (light / dark / drac). All three render without contrast regressions. `.markdown-body` colors unchanged (aliases carry through).
4. Toggle TOC, open/close a file, resize to 600px width — no broken layout, no overflow on toolbar.
5. Invoke every existing keyboard shortcut (`⌘O`, `⌘N`, `⌘E`, `⌘⇧E`, `⌘F`, `⌘T`, `⌘R`) — handlers still fire (proved by preserved element IDs).
6. `cargo build` in `src-tauri/` — no Rust change, must still be green.
7. Append a `CHANGES.md` entry: `YYYY-MM-DD [code] Viewer chrome rewritten to native-macOS token system (material surfaces, 26pt grouped toolbar, flat document); welcome replaced with Option-B card (recents hidden, Phase 3).`

---

## Phase 2 — Editor, docked find, popover, update pill

**Goal:** editor window matches the viewer's native chrome; find overlay docks into `#find-bar-slot` in both windows; View popover is rebuilt with segmented / stepper / switch controls; an "Updated" pill fires when the file changes on disk. No new prefs yet.

### Changes

1. **`boltpage/src/editor.css` — chrome rewrite**
   - Mirror the Phase-1 token block (duplicated per-root, since index.html and editor.html are independent Tauri webviews with independent stylesheets — shared import would require a new `<link>` tag and path resolution that the current build doesn't wire). Keep editor-only tokens `--editor-font-size`, `--editor-gutter-font-size`.
   - Drop body's gradient stack (`editor.css:93–96`): two radial-gradients plus one linear-gradient — same flat `var(--surface-app)` as viewer.
   - Remove the 28px rounded outer container around the textarea (`.editor-container` at `editor.css:274`; `border-radius: 28px` at line 281). Textarea sits on `var(--content-bg)` with a 1px top `var(--separator)` separating it from the toolbar.
   - `.editor-header` → 38pt row, matching viewer.
   - Add `.editor-inspector` (180pt wide, right side, `var(--sidebar-bg)`, 1px left `var(--separator)`, `hidden` by default). CSS only; JS wiring in Phase 3.
   - Keep textarea / gutter / mirror / find-highlight-overlay rules intact — tightly coupled to `editor.js` measurement logic.
   - Add shared utility classes `.seg`, `.stepper`, `.switch`, `.tb-status`, `.toolbar-group`, `.toolbar-spacer`, `.find-bar` and `.find-bar-slot` — duplicated from styles.css. (Trade-off acknowledged: ~100 lines of CSS duplication; cost of extraction is higher than the benefit at this scale.)
   - Add `#find-bar-slot` reservation row between `.editor-header` and `.editor-container`.

2. **`boltpage/src/editor.html`**
   - Remove `.brand-block` from `.editor-header-main`.
   - Replace the three separate font-size elements with one `.seg` segmented control whose three children keep the existing IDs: `#editor-font-size-decrease-btn` ("A−"), `#editor-font-size-indicator` (middle, shows "18 px"), `#editor-font-size-increase-btn` ("A+"). No JS changes: `updateFontSizeControls()` (`editor.js:83`) still sets `textContent` and `disabled` on the same IDs.
   - Add SVG icons to `#line-numbers-btn` and `#wrap-btn`; `.active` toggling already lives in `applyLineNumberVisibility()` (declared at `editor.js:151`; the toggle statement is line 157 — note the local variable is confusingly named `wrapBtn` but actually refers to `#line-numbers-btn`) and the wrap equivalent in `applyWordWrap()` at `editor.js:387` — CSS change only.
   - Group buttons with `.toolbar-group` separators.
   - Add `<div id="find-bar-slot" class="find-bar-slot"></div>` between `.editor-header` and `.editor-container`.
   - Add `<aside id="editor-inspector" class="editor-inspector" hidden>…</aside>` inside `.editor-container` (right side). Static label layout — populated in Phase 3.
   - Add `<button id="editor-inspector-toggle" class="toolbar-btn icon-only" title="Show inspector (⌘⇧I)">…</button>` in the editor toolbar next to `#find-btn`. Visible in Phase 2 but inert (clicks toggle the `hidden` attribute locally but do not persist; persistence in Phase 3).

3. **`boltpage/src/shared.js` — extend `createFindOverlay`**
   - New signature: `export function createFindOverlay(parent = document.body)`. Internal `parent.appendChild(overlay)` replaces the hard-coded `document.body.appendChild(overlay)` at `shared.js:91`. Overlay HTML (`#find-input`, `#find-count`, `#find-prev`, `#find-next`, `#find-close`) unchanged so all downstream handlers (main.js:1018, editor.js:682) keep working.

4. **`boltpage/src/main.js`**
   - Update the one call site to pass the docked slot: `createFindOverlay(document.getElementById('find-bar-slot'))`.
   - Remove `position: fixed; top: 118px; right: 28px;` from `.find-overlay` (`styles.css:475`) in favor of the in-flow docked layout defined by `.find-bar-slot` + `.find-overlay.show`.

5. **`boltpage/src/editor.js`**
   - Same change: `createFindOverlay(document.getElementById('find-bar-slot'))` at the existing call site.
   - Delete no-op `renderEditorHeader()` (3-line fn body at `editor.js:92–94`) and its single caller (1 line at `editor.js:180`) — per project rule "Remove imports, variables, and functions that your changes made unused."

6. **View popover rebuild** (inside the existing `#theme-menu` div — `.show` toggle from `main.js:587` unchanged, outside-click close from `main.js:697` unchanged)
   - Section 1 "Appearance": `.seg` segmented control with three `<button class="theme-option" data-theme="light|dark|drac">`. Existing click handler at `main.js:689` dispatches on `dataset.theme` → stays correct.
   - Section 2 "Document":
     - Text-size stepper reusing `#font-size-decrease-btn` / `#font-size-indicator` / `#font-size-increase-btn` IDs. No JS change.
     - Sidebar toggle rendered as `.switch` on the existing `#rail-toggle-option` button ID. Handler at `main.js:387` (`toggleTOC`) continues to fire. Keep `#rail-toggle-title` / `#rail-toggle-state` children because `updateViewMenuState()` (`main.js:150`) writes to them; `#rail-toggle-caption` is retained but its inner text is cleared (popover rows drop captions for HIG conformance) — empty span is harmless to existing selector code.
   - Section 3 "Window — Toolbar style": `.seg` placeholder with three inert buttons in Phase 2 (no `data-*` wiring). Activated in Phase 3.

7. **"Updated" pill in viewer toolbar** — a single, simple surface, not the two-stage "Updated → Saved" originally drafted (which was semantically confusing from the viewer's perspective since the viewer does not own saves).
   - `#update-status` span (added in Phase 1) is shown whenever the viewer receives `EVENT_FILE_CHANGED` (`main.js:792`): `setBadgeState(document.getElementById('update-status'), 'Updated', 'accent', false)`.
   - After `refreshFile()` completes (`main.js:576`), schedule a 2.5s `setTimeout` that hides the pill via `setBadgeState(el, '', null, true)`.
   - The existing `#refresh-indicator` red dot on the Refresh button is retained (it still signals "external change pending" before the user manually clicks Refresh, if auto-refresh is disabled — that existing flow is untouched).
   - The editor's own `#editor-status-badge` (`editor.js:222`) is unrelated to this pill and remains wired by `updateStatus()` (`editor.js:221`).

### Verification
1. `⌘E` from a loaded Markdown file opens the editor; editor chrome matches viewer.
2. Click `#line-numbers-btn`, then `#wrap-btn` — each toggles its `.active` class; `applyLineNumberVisibility()` (`editor.js:151`) still hides/shows the gutter; word-wrap toggling still reshapes the textarea. (Pure CSS/HTML change verification — JS untouched.)
3. `⌘F` in viewer: find bar slides into `#find-bar-slot` under the toolbar, scrolls are not stolen, `Esc` closes, `Enter` / `Shift+Enter` cycle matches. Same in editor. `⌘H` in editor still reveals the replace row.
4. Modify the loaded file externally (`echo x >> test.md`): viewer shows "Updated" pill in `badge-tone-accent`, file reloads, pill fades out ~2.5s later.
5. Open View popover: three themes as segmented buttons; stepper reflects current font size; switch reflects sidebar state. All three controls persist across restart (prefs infrastructure unchanged).
6. Scroll-sync between viewer and editor still works end-to-end (the textarea wrapper selectors `.editor-textarea-wrapper`, `.line-number-gutter`, `.line-mirror` are preserved).
7. `cargo build` green. No Rust changes in this phase.
8. Append a `CHANGES.md` entry: `YYYY-MM-DD [code] Editor chrome rewritten; find overlay docked into #find-bar-slot (viewer+editor); View popover rebuilt (seg/stepper/switch); #update-status pill wired to EVENT_FILE_CHANGED; removed no-op renderEditorHeader.`

---

## Phase 3 — Prefs, recents, inspector data, density broadcast

**Goal:** wire the three new frontend surfaces (toolbar-density segmented control, welcome recents list, editor inspector rail) to persistent state via new Rust prefs and one new Tauri command. Add a broadcast so density changes reflect live in both viewer and editor.

### Rust

1. **`boltpage/src-tauri/src/prefs.rs` — extend `AppPreferences`** (`prefs.rs:8`):
   - `toolbar_density: Option<String>` — default `None`; treated as `"icon-label"` on read. Validated frontend-side to one of `"icon-label" | "icon" | "label"`; unexpected values fall back to `"icon-label"`.
   - `editor_inspector_visible: Option<bool>` — default `None`, treated as `false`.
   - `recent_files: Option<Vec<String>>` — default `None`, treated as empty. Never deserialized into an ordered list — we treat the vec as insertion-ordered (most-recent first).
   - Update the `Default` impl (`prefs.rs:21`) to initialize all three to `None`.
   - **No migration needed.** `tauri-plugin-store` is JSON-typed; existing stores without these keys deserialize to `None`. Atomic writer at `prefs.rs:72` already handles partial maps.

2. **`boltpage/src-tauri/src/constants.rs`** — add:
   - `pub const MAX_RECENT_FILES: usize = 10;`
   - `pub const EVENT_TOOLBAR_DENSITY_CHANGED: &str = "toolbar-density-changed";`

3. **`boltpage/src-tauri/src/io.rs` — `push_to_recents` helper** (`pub(crate) async`):
   - **Acquires `pref_lock` itself** and performs the full read-modify-write under one critical section. **Do not** delegate to `save_preference_key_inner` here — its lock only covers the write, so a prior `get_preferences` call would still race across concurrent file-open events (e.g. CLI arg + Launch Services URL fired near-simultaneously). Mirror the existing pattern at `lib.rs:449–459`.
   - Canonicalizes the input path via `fs::canonicalize` (falls back to the raw string if the file is missing — should not happen at call sites, but keeps the helper total).
   - Removes any prior entry equal to the canonical path; prepends; truncates to `MAX_RECENT_FILES`.
   - Writes via the raw store API (the same pattern `save_preference_key_inner` uses internally at `prefs.rs:80–97`).

   Reference implementation:

   ```rust
   pub(crate) async fn push_to_recents(app: &AppHandle, path: &str) -> Result<(), String> {
       let canonical = fs::canonicalize(path)
           .map(|p| p.to_string_lossy().to_string())
           .unwrap_or_else(|_| path.to_string());
       let state = app.state::<AppState>();
       let _lock = state.pref_lock.lock().await;
       let store = app.store(".boltpage.dat").map_err(|e| format!("store: {e}"))?;
       let mut map = store.get("preferences")
           .and_then(|v| serde_json::from_value::<serde_json::Map<_, _>>(v.clone()).ok())
           .unwrap_or_default();
       let mut vec: Vec<String> = map.get("recent_files")
           .and_then(|v| serde_json::from_value(v.clone()).ok())
           .unwrap_or_default();
       vec.retain(|p| p != &canonical);
       vec.insert(0, canonical);
       vec.truncate(MAX_RECENT_FILES);
       map.insert("recent_files".into(), serde_json::to_value(vec).map_err(|e| e.to_string())?);
       store.set("preferences", serde_json::Value::Object(map));
       store.save().map_err(|e| format!("save: {e}"))?;
       Ok(())
   }
   ```

   - Call sites (order matters — `allow_path` must stay synchronous **before** any spawned push so the subsequent `read_file` from the new window passes `check_path_allowed`):
     - `open_file_dialog` (`io.rs:483`, immediately after `allow_path`): `push_to_recents(&app, &p.to_string()).await?;` — already in an async fn.
     - `create_new_markdown_file` (`io.rs:528`, after the file is created via `OpenOptions::new().create(true)…open()` at line 521, before/after the window spawn): `push_to_recents(&app, &path.to_string_lossy()).await?;`
     - `lib.rs:395` (CLI arg): `allow_path` remains synchronous; wrap the recents push in `tauri::async_runtime::spawn(async move { let _ = push_to_recents(&handle, &path_str).await; });` — fire-and-forget so window creation isn't blocked.
     - `lib.rs:503` (macOS Launch Services `async move` block, inside the existing spawn, after `allow_path` at `lib.rs:498`): `let _ = push_to_recents(&app_clone, &path.to_string_lossy()).await;`

4. **New command `get_recent_files`** in `prefs.rs` (natural home — it reads prefs):
   ```rust
   #[derive(Serialize)]
   pub(crate) struct RecentFile {
       pub path: String,
       pub display_name: String,   // basename
       pub directory: String,      // parent dir display
       pub modified_ts: Option<u64>, // unix seconds; None if stat fails
   }

   #[tauri::command]
   pub(crate) async fn get_recent_files(app: AppHandle) -> Result<Vec<RecentFile>, String> { … }
   ```
   - Reads `recent_files` from the store, filters to paths that still exist on disk (non-existent paths are silently dropped from the returned `Vec<RecentFile>`). **The store itself is not rewritten** — a stale entry stays persisted until a future `push_to_recents` either promotes it (if the file reappears) or pushes it off the end of the 10-entry truncation. This keeps `get_recent_files` side-effect-free.
   - For each surviving path, compute basename, parent directory (as display string), and `fs::metadata(&p).modified()` if readable.
   - Return in store order (most-recent first).
   - Register in the `.invoke_handler` tuple in `lib.rs` around `lib.rs:266`.

5. **`broadcast_toolbar_density_change` command** in `menu.rs` — mirror of `broadcast_theme_change` (`menu.rs:146`), emits `EVENT_TOOLBAR_DENSITY_CHANGED` with the density string payload. Register in the `.invoke_handler` list. Add matching JS constant `EVENT_TOOLBAR_DENSITY_CHANGED = 'toolbar-density-changed'` to `boltpage/src/constants.js` (keeps constants.rs and constants.js in lockstep per existing pattern).

### Frontend

6. **`boltpage/src/main.js`**:
   - On DOM-ready (after `loadPreferences()` at `main.js:68`), invoke `get_recent_files` and, if non-empty, unhide `.recent-list` in the welcome card and render items. Each item's click calls the existing `openFile(path)` (`main.js:401`). Empty state: leave `.recent-list` hidden (`[hidden]` attribute) and let the welcome card collapse naturally.
   - Re-fetch and re-render recents on: (a) DOM-ready (covered above), (b) window `focus` regained via `appWindow.onFocusChanged(({ payload: focused }) => { if (focused) fetchRecents(); })`, (c) optionally on `EVENT_FILE_CHANGED` if the welcome card is currently visible. **Do not** gate the re-fetch on successful `openFile` completion: `openFile` (`main.js:401`) can throw mid-render (PDF blob creation error around line 436, read errors), leaving the recents stale. The Rust-side `push_to_recents` is the authoritative write path; the frontend just re-queries.
   - Wire the Phase-2 placeholder "Window > Toolbar style" segmented buttons: on click, (a) set `document.documentElement.dataset.toolbarDensity = value;` (matches `data-theme` placement on `<html>` from `shared.js:122`), (b) `savePreference('toolbar_density', value)`, (c) `invoke('broadcast_toolbar_density_change', { density: value })` so editor updates live.
   - In `loadPreferences()`, read `prefs.toolbar_density || 'icon-label'` and apply the `<html>` attribute before first paint.
   - Extend `updateViewMenuState()` (`main.js:150`) to also mark the active density `.seg` button.
   - Listen for `EVENT_TOOLBAR_DENSITY_CHANGED` via `listen(...)` next to the existing theme/font-size listeners (`main.js:792` area). **Must include an echo-suppression guard** matching the theme listener pattern at `main.js:799–807`: compare `event.payload` to a module-level `currentToolbarDensity` variable and early-return if equal. Otherwise the `invoke → emit → listen` round-trip fires an extra DOM update on every click. Add `let currentToolbarDensity = 'icon-label';` at the top of `main.js` next to `currentTheme`:
   ```js
   await listen(EVENT_TOOLBAR_DENSITY_CHANGED, (event) => {
       if (event.payload === currentToolbarDensity) return;
       currentToolbarDensity = event.payload;
       document.documentElement.dataset.toolbarDensity = event.payload;
       updateViewMenuState();
   });
   ```

7. **`boltpage/src/editor.js`**:
   - Same `loadPreferences` + `EVENT_TOOLBAR_DENSITY_CHANGED` listener additions so the editor's toolbar also reflects density live. **Same echo-suppression guard required** — mirror the theme listener pattern with a local `currentToolbarDensity` variable.
   - `editor_inspector_visible` pref read on init; apply to `#editor-inspector` `hidden` attribute.
   - `#editor-inspector-toggle` click handler: flip the hidden attr and `savePreference('editor_inspector_visible', visible)`.
   - Keyboard shortcut: add `{ key: 'i', ctrl: true, shift: true, action: toggleInspector }` to the editor's `setupKeyboardShortcuts` table. Verified no collision with existing editor shortcuts (`Ctrl+F`, `Ctrl+H`, `Ctrl+S`, plus the shift-only `Shift+Enter` for find-prev handled inline, not via the table).
   - `updateInspector()` helper, called on every `input`, `keyup`, `mouseup`, and selection-change on `#editor-textarea`. Rate-limit via the same rAF pattern as `scheduleLineNumberUpdate` (`editor.js:299`): at most one recompute per frame.
     - Words: `text.trim().match(/\S+/g)?.length ?? 0`.
     - Chars: `text.length`.
     - Lines: `text === '' ? 0 : (text.match(/\n/g)?.length ?? 0) + 1`.
     - Cursor line/col: count `\n` up to `selectionStart`; col = `selectionStart - (lastNewlineIndex + 1)`.
     - Selection length: `selectionEnd - selectionStart`.
     - Encoding: hard-coded `UTF-8` (true today; file reader reads as UTF-8 string).
     - EOL: inspected once on file-load — `content.includes('\r\n') ? 'CRLF' : 'LF'`; refreshed on save (same rule).

8. **`boltpage/src/styles.css` + `boltpage/src/editor.css`** — three density rules each:
   ```css
   html[data-toolbar-density="icon"] .toolbar-btn > span.label { display: none; }
   html[data-toolbar-density="icon"] .toolbar-btn { padding: 0; width: 26px; justify-content: center; }
   html[data-toolbar-density="label"] .toolbar-btn > svg { display: none; }
   ```
   This requires wrapping the existing button label text in `<span class="label">` — a mechanical Phase 3 HTML edit on each `.toolbar-btn` in both index.html and editor.html. (Button IDs and classes stay the same, so JS handlers are unaffected.)

### Verification
1. Open four distinct files in sequence (dialog, drag-drop, CLI `open test.md`, and "Open Recent" if any). Close app; relaunch. Welcome shows the four as recent items, most-recent first, no dupes, correct basename + directory text.
2. Delete one recent file from the filesystem; relaunch; its entry is silently filtered out of the returned list.
3. Open popover → "Toolbar style" → Icon: every `.toolbar-btn` collapses to icon-only in both viewer and editor *while the editor window is open* (broadcast proves the live-update). Switch to Label only; icons hide in both. Persists across restart.
4. Editor: `⌘⇧I` toggles inspector; click the toolbar toggle button; both paths persist. Type text; word/char/line counts update per frame without typing lag. Click around; cursor line/col updates. Select a range; Sel length shows.
5. Encoding always UTF-8; EOL flips correctly between LF and CRLF given fixture files.
6. Inspect `.boltpage.dat`: `toolbar_density`, `editor_inspector_visible`, `recent_files` appear with sensible JSON values.
7. `cargo fmt --check` passes; `cargo build` green; `cargo test` (existing tests in `io.rs:549` — atomic write + cache eviction) still pass.
8. Release build `./build-release.sh` produces a bundle with no runtime console errors on first launch on a clean macOS user profile.
9. Append a `CHANGES.md` entry: `YYYY-MM-DD [code] Prefs: toolbar_density, editor_inspector_visible, recent_files. New command get_recent_files (filters dead paths). Density broadcast. Editor inspector rail live.` and a `[decision]` entry if we end up changing any BRIEFING.md "Key decision" line.

---

## Acceptance test (end of Phase 3)

Against a 60-line Markdown file on macOS 14+, the redesigned viewer at thumbnail resolution is visually indistinguishable from a stock macOS document-class app (TextEdit / Pages / Preview lineage): native titlebar material, compact grouped toolbar, flush sidebar material, flush content surface. Every keyboard shortcut from the pre-redesign build still works. Users can switch between light / dark / drac, toggle toolbar density, show/hide the editor inspector, and launch recently opened files from the welcome state. All preferences persist across restarts and the density change is reflected live in both viewer and editor without a reload.

## Explicitly out of scope (defer)

- An "Auto" theme that follows macOS system appearance (`prefers-color-scheme`) — keeps theme set at three, as discussed.
- Native "Open Recent" menu item under File in the macOS menu bar (would be a nice-to-have; not required by the redesign).
- Rewriting the markdown-body syntax-highlight color tables (`styles.css:1142–1292`) — retained as-is.
- Migrating shared CSS utilities into a single imported file — Phase 2 duplicates 4 utility classes across `styles.css` and `editor.css` as an accepted trade-off.
