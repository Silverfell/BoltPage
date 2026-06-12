# Implementation Plan: Live Preview, CodeMirror 6, Folder Workspace, Session Restore

Date: 2026-06-11, revised same day after a systematic audit against the code.
Covers review suggestions 1, 2, 3, 5 (auto-update deliberately excluded).
Order A → B → C → D is by dependency and risk: A fixes the permission/tracking
substrate D builds on; B's preview patching is editor-agnostic so it survives C;
C replaces the editor input layer B hooks into (one hook moves); D is the scope
expansion.

Gate after every phase: `cargo fmt --all -- --check`, `cargo clippy --all-targets
--all-features -- -D warnings`, `cargo test --all`, `node --input-type=module
--check` on touched JS, plus listed manual checks. Single version bump to 2.2.0 at
the end (all phases land together).

Decisions fixed during audit (not open questions):
- Session restore is default-on, no toggle (macOS reopen-windows convention);
  closing all windows before quitting yields the welcome screen.
- In-window file switching is the canonical open path; tracking happens in one
  Rust command, not scattered per-flow.
- JSON/YAML live preview keeps the last good render on parse errors, silently.
- Quick switcher binds to Cmd+O when a workspace folder is set (todo_future.md's
  own choice), with a Browse… row to reach the dialog; Open Folder… is Cmd+Shift+O.
- Workspace folder is global (one per app), persisted in prefs.
- CM6 is assembled from explicit extensions, never basicSetup (its searchKeymap
  conflicts with the docked find bar).

---

## Phase A: Session restore + native Open Recent

Latent bugs absorbed: (1) welcome-card recents click calls openFile with no
allow_path grant → "Access denied" on fresh launch; (2) in-window opens (dialog in
welcome window, recents) never update open_windows, so duplicate-window dedup and
any session tracking would miss them.

1. prefs.rs: sync helpers `read_recent_paths(app)` and `read_session_paths(app)`;
   get_recent_files refactored onto the former → verify: cargo test.
2. constants.rs: MENU_RECENT_PREFIX = "recent-file-", MENU_RECENT_CLEAR =
   "recent-clear" (clear id must not share the prefix) → verify: compile.
3. menu.rs: File > Open Recent submenu between Open and Print: items id = prefix +
   URL_SAFE_NO_PAD b64(path) (window-label encoding), label "name (dir, ~ for
   home)", dead paths filtered, separator + Clear Menu; decode helper with unit
   test → verify: round-trip test; manual: submenu populated.
4. io.rs: `session_add` / `session_remove` (ordered Vec in pref "session_files",
   read-modify-write under pref_lock, push_to_recents pattern);
   push_to_recents rebuilds the menu after save so every recents mutation
   refreshes the submenu → verify: clippy; manual: open file, submenu updates.
5. io.rs: `open_tracked_file(window, path)` command: if not allowed, grant only
   when path is in stored recents (string-canonical compare), else Err; then
   update open_windows (drop this window's previous path mapping, collect it),
   session_remove(old) + session_add(new) + push_to_recents (sequential awaits,
   pref_lock-serialized) → verify: unit-light (store-coupled), clippy; manual:
   fresh launch + recents click opens.
6. lib.rs: pub(crate) static QUITTING: AtomicBool; RunEvent::ExitRequested sets it
   (covers Cmd+Q PredefinedMenuItem and custom MENU_QUIT); register command →
   verify: compile.
7. window.rs: create_window_with_file does session_add after open_windows insert;
   remove_window_from_tracking collects this label's paths, then (only when
   !QUITTING) session_removes them → verify: manual: close window updates store;
   quit keeps it.
8. lib.rs setup: when CLI args produced no files, read session, filter to existing
   paths, allow each, spawn sequential create_window_with_file in saved order
   (re-adds preserve order); fall back to welcome if nothing opened → verify:
   manual: open 2 files, quit, relaunch → both; close-all-quit → welcome.
9. main.js: on menu recent click Rust opens a window directly (no JS); welcome
   recents keep calling openFile, which now invokes open_tracked_file whenever the
   path differs from lastTrackedPath (initialized to the label-derived path so the
   boot open doesn't double-track); tracking happens before render so the grant
   precedes check_path_allowed → verify: node --check; manual matrix: fresh-launch
   recents, dialog in welcome window, dedup focuses existing window.

## Phase B: On-type live preview

1. Constants both sides: EVENT_EDITOR_BUFFER_CHANGED = "editor-buffer-changed";
   menu.rs broadcast_editor_buffer command, payload {source, file_path, kind,
   content}; registered → verify: clippy.
2. editor.js: trailing 150ms debounce on input broadcasts foldState.fullText
   (folded sections included), kind = currentFileKind; >2MB guard falls back to
   the save path (one console.info) → verify: node --check.
3. main.js listener: filter self/file_path/pdf; render via
   parse_markdown_with_theme / parse_json_with_theme / parse_yaml_with_theme;
   txt built JS-side (escapeHtml into the same double-wrapped
   markdown-body/pre.plain-text shape render_file_to_html emits); JSON/YAML parse
   errors keep last good render; single-flight with latest-pending coalescing →
   verify: manual: md/json/yaml/txt live-update; invalid JSON doesn't clobber.
4. applyPreviewHtml(html, {patch}): keys = djb2 hash of each top-level node's
   pre-enhancement serialization, stored in a WeakMap (survives KaTeX/Mermaid
   in-place mutation; attributes do not represent post-enhancement nodes); diff =
   common prefix + suffix by key, replace middle run only; clearFindResults
   first; renderMath/renderMermaid scoped to inserted nodes; TOC rebuilt only
   when the heading signature changed; returns {full} → verify: manual: typing in
   a paragraph leaves an unrelated mermaid diagram untouched; scroll stays.
5. Mermaid theme fix (pre-existing: mermaid.run skips data-processed nodes, so
   theme re-render is a no-op today and patching would pin it further): stash
   original source in dataset.bpSrc on first render; theme change restores source,
   strips data-processed, re-runs → verify: manual: theme switch recolors
   diagrams.
6. openFile/refreshFile route through applyPreviewHtml; pdf keeps the full-swap
   path; scroll-anchor restore only when {full} (patches must not touch scroll) →
   verify: manual: save causes no flicker; welcome → file, file → pdf intact.

## Phase C: CodeMirror 6 editor core

Verified up front: 607KB min / 206KB gz for the realistic bundle; zero eval /
new Function (existing vendor audit passes; CSP unchanged; CM6 injects styles via
<style>, covered by style-src 'unsafe-inline'); @codemirror/commands maps native
beforeinput historyUndo/Redo into CM6 history so the Edit menu PredefinedMenuItems
keep working; lang-markdown registers foldNodeProp (heading-section ranges
confirmed at C3, fallback foldService reusing sectionEnd logic).

1. scripts/vendor-codemirror.sh: pinned exact versions, esbuild ESM bundle to
   src/assets/vendor/codemirror/codemirror.min.js + concatenated LICENSE file;
   explicit named exports (EditorView, keymap, lineNumbers, drawSelection,
   placeholder, EditorState, Compartment, EditorSelection, history,
   defaultKeymap, historyKeymap, foldGutter, codeFolding, foldKeymap,
   foldService, syntaxHighlighting, markdown, markdownLanguage, search,
   SearchQuery, setSearchQuery, findNext, findPrevious, replaceNext, replaceAll,
   classHighlighter, tags); no basicSetup → verify: grep eval/new Function = 0;
   bundle imports in the editor window.
2. editor.html: textarea/gutter/mirror subtree → #editor-host div; chrome
   (header, find slot, inspector) unchanged. editor.js: EditorView with
   compartments for line numbers + wrap; load via applyFileContent
   (EditorState.create), save from state.doc.toString(); EOL mode,
   lastKnownDiskText, external reload/warn ported; JSON format-on-save becomes a
   full-doc dispatch (CM maps selection; caret hack deleted) → verify: edit/save
   round-trip incl CRLF; external-change badge.
3. Delete fold machinery (foldState, diffSingleEdit, applyDisplayEditToFull,
   mirror/gutter rebuilds, ~500 lines); folding = codeFolding + foldGutter +
   lang-markdown (confirm heading sections; else custom foldService); palette
   fold-all/unfold-all via foldAll/unfoldAll commands; save always full text
   (view-only folding) → verify: fold, edit around, save full content; undo
   across folds.
4. Rewire chrome: font size/family via CSS vars on .cm-editor (+requestMeasure);
   spellcheck via contentAttributes; inspector from updateListener
   (rAF-coalesced as today); scroll-sync out via scrollDOM scroll +
   lineBlockAtHeight → doc.lineAt().number (fold-safe: doc coords are full-text);
   scroll-sync in via EditorView.scrollIntoView(line.from, y:'start'); percent
   mode unchanged on scrollDOM metrics; format commands (bold/italic/strike/
   insert-link/paste-URL) as CM dispatches preserving the existing
   wrap/unwrap/inside-outside semantics; markdown highlighting via
   classHighlighter + per-theme tok- CSS → verify: full shortcut table; both
   scroll-sync directions; menu Format items.
5. Find bar kept, drives @codemirror/search programmatically (SearchQuery with
   caseSensitive/wholeWord, setSearchQuery effect, findNext/Previous,
   replaceNext/replaceAll); match count via query cursor (capped);
   findHighlightOverlay deleted → verify: toggles, counts, replace one/all, Esc
   focus restore.
6. Phase B broadcast moves into updateListener docChanged → verify: live preview
   unchanged.
7. shared.js: toggleWrap/insertLink/pasteUrlOverSelection removed (editor-only,
   textarea-specific); README "Vanilla JavaScript" line amended to name vendored
   CodeMirror; BRIEFING editor bullets rewritten → verify: grep for stale
   references; docs match code.

## Phase D: Folder workspace (scope expansion)

0. BRIEFING Current scope/Non-goals updated first; CHANGES [scope] entry. v1
   non-goals: full-text folder search, wiki-links, backlinks, recursive watch.
1. AppState.allowed_dirs (canonicalized PathBuf set); check_path_allowed passes
   when the canonicalized path (canonicalization must succeed; raw paths never
   dir-match) sits under an allowed dir; logic extracted to a pure
   path_allowed_by(canonical, paths, dirs) for tests → verify: unit tests: inside
   ok, ../ escape denied, symlink-out denied.
2. Commands: open_folder_dialog (blocking_pick_folder, plugin 2.3.2 verified) →
   allow_dir + workspace_folder pref; get_workspace_folder (re-grants on boot);
   clear_workspace_folder; list_dir(path) one lazy level (hidden skipped, dirs +
   md/markdown/json/yaml/yml/txt/pdf, dirs-first case-insensitive sort);
   list_workspace_files (depth/count capped walk in spawn_blocking, truncation
   flag) → verify: filter unit test; clippy.
3. Sidebar: Files | Outline seg in sidebar header; lazy tree (#file-tree), expand
   fetches children, current-file highlight, expanded-set refresh on window focus
   (recents pattern); tree click = openFile(path) (dir grant covers
   check_path_allowed; open_tracked_file from A does tracking) → verify: manual:
   switch via tree updates title/watcher/Window menu/session; dedup intact.
4. Quick switcher: Cmd+O and EVENT_MENU_OPEN open the fuzzy palette over
   list_workspace_files when a workspace is set (first row "Browse…" = dialog);
   plain dialog otherwise; createCommandPalette reused → verify: manual: nested
   file found and opened; no workspace → dialog as today.
5. Menu: File > Open Folder… (Cmd+Shift+O, verified unclaimed) via EMIT_ACTIONS;
   welcome card gains Open Folder button → verify: manual.
6. Editor windows ignore workspace entirely → verify: editor unchanged.

---

Cross-phase: single bump to 2.2.0 + sync-version.sh at the end; CHANGES entries
per phase; cask untouched until release.

---

## Phase E: Editor quick wins (2026-06-11, post-2.2.0-build)

Six CM6 extension drops. All exports verified present in the pinned packages
(markdownKeymap = [Enter, Backspace]; highlightSelectionMatches;
rectangularSelection; crosshairCursor; highlightActiveLine(+Gutter);
scrollPastEnd; indentWithTab; EditorState.allowMultipleSelections;
EditorView.documentPadding). No Rust changes; version stays 2.2.0 (unreleased).

1. scripts/vendor-codemirror.sh: add the eight exports above to entry.js,
   re-run (same pinned versions; the symbols live in already-bundled packages,
   so growth is a few KB) → verify: script's eval/new Function audit passes;
   node import smoke shows all new symbols defined.
2. editor.js keymap order: `[...markdownKeymap, ...defaultKeymap,
   ...historyKeymap, ...foldKeymap, indentWithTab]`. markdownKeymap must
   precede defaultKeymap or its Enter (insertNewlineContinueMarkup) and
   Backspace (deleteMarkupBackward) lose to insertNewlineAndIndent →
   verify: Enter inside "- item" continues the bullet; Backspace on the empty
   bullet removes the marker; Enter elsewhere unchanged; Tab/Shift+Tab
   indent/dedent a list item instead of moving focus.
3. Extensions added to buildEditorExtensions: EditorState.allowMultipleSelections
   .of(true), rectangularSelection(), crosshairCursor(), highlightActiveLine(),
   highlightActiveLineGutter(), highlightSelectionMatches(), scrollPastEnd().
   Known scope limit: cmToggleWrap/cmInsertLink act on selection.main only;
   multi-range formatting is a later upgrade (changeByRange) → verify:
   Alt+click adds a caret, Alt+drag column-selects, typing applies at all
   carets; Cmd+B with multiple selections bolds the main one without error.
4. Scroll-sync compensation for scrollPastEnd: the virtual bottom padding
   inflates scrollHeight, skewing percent sync near the document end. Use
   `editorView.documentPadding.bottom` in both directions:
   out: percent = scrollTop / max(1, scrollHeight - clientHeight - padBottom);
   in: scrollTop = percent * max(0, scrollHeight - clientHeight - padBottom);
   skip when the compensated denominator is <= 0 (content fits) → verify:
   scroll editor to last line, preview lands at its bottom (not ~80%), and
   the reverse; json/yaml/txt line sync unaffected (lineBlockAtHeight is
   padding-agnostic at the top edge).
5. editor.css theme tokens: .cm-activeLine / .cm-activeLineGutter on a
   low-alpha background (must stay translucent: the active-line layer paints
   above drawSelection's selection layer, an opaque color would hide the
   selection on that line); .cm-selectionMatch on --accent-tint, visually
   distinct from .cm-searchMatch (--accent-warning-soft) → verify: select a
   word, other occurrences tint accent while find-bar matches stay warning-
   tinted; selecting text on the active line keeps visible selection.
6. Gate + docs: node --check editor.js; cargo fmt/clippy/test (untouched but
   cheap); rebuild app, manual checklist above; BRIEFING editor bullet gains
   the new behaviors; CHANGES [code] entry → verify: gate output + docs match.
