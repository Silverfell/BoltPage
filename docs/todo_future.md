# Future TODO

Feature candidates pulled from the Obsidian comparison (2026-04-22). Tier 1 items fit BoltPage's current single-file viewer-editor scope. Tier 2 items are marked **maybe** because they require widening scope from "file" to "folder".

## Done (2.1.0 — 2026-04-23)

1. **Format shortcuts** — Cmd+B bold, Cmd+I italic, Cmd+Shift+U insert link, Cmd+Shift+K strikethrough. toggleWrap via setRangeText (native undo preserved). Cmd+K is chord-prefix-only (Cmd+K Cmd+P = command palette); the chord dispatcher's single-key fallback is a no-op when no action is registered for the prefix.
2. **Heading fold in editor** — translate-edits model: foldState.fullText is source-of-truth; textarea shows displayText; edits translate through displayLineRanges, cross-boundary edits drop intersecting folds, undo/redo resets state.
3. **Command palette** — `Cmd+K Cmd+P` chord opens a fuzzy-filtered list of commands. New setupChordShortcuts dispatcher in shared.js.
4. **Math (KaTeX) and Mermaid rendering** — pulldown-cmark ENABLE_MATH emits inline/display math spans; mermaid fences emit `<pre class="mermaid">`. Rendered client-side via bundled KaTeX 0.16.11 + Mermaid 11.4.1.
5. **Callouts / admonitions** — GitHub `> [!KIND]` blockquotes rewritten to `<div class="callout callout-{kind}">` via regex post-processor; five accent colors.
6. **Syntax highlighting verification** — root cause found: ammonia::clean was stripping every `class`. Ammonia rebuilt as a cached Builder with `class` in generic_attributes. Core language coverage confirmed; optional gaps noted in CHANGES.md.
7. **Paste URL over selection → auto-link** — editor paste handler detects URL-like clipboard text with non-empty selection and rewrites to `[selected](url)`.
8. **Custom font family pref** — curated presets (document: serif-iowan / sans-system / mono-plex; editor: mono-plex / mono-jetbrains / mono-sf). Exposed in View popover Typography section, broadcast across windows, applied to markdown body / textarea / gutter / mirror via CSS custom properties, and honored in HTML export.

## Tier 2 — Maybes

Scope widened to folder-as-workspace on 2026-06-11; items 1 and 5 shipped (see below).

1. ~~File explorer sidebar~~ — shipped 2026-06-11 (Files tab in the sidebar, lazy tree).
2. **(maybe) Full-text search across folder**. Ripgrep-backed Rust command.
3. **(maybe) `[[Wiki-links]]` with autocomplete**. Now meaningful with the folder scope.
4. **(maybe) Backlinks pane**. Requires a link index built over the folder.
5. ~~Quick Switcher (Cmd+O)~~ — shipped 2026-06-11 (fuzzy palette over the workspace index).
6. **(maybe) Daily notes / templates**. Needs a date-formatted filename convention.

## Done after 2.1.0 shipped

- **Vendored syntaxes pack (2026-04-23).** 8 `.sublime-syntax` files dropped under `boltpage/markrust-core/syntaxes/` (ini, kotlin, swift, ts, tsx, scss, toml, dockerfile) and merged with syntect's default-fancy set via `SyntaxSetBuilder` + `include_str!`. Audit test flipped from eprintln-on-gaps to assertive zero-gap check. Sources: sharkdp/bat (Apache-2.0) for 5 packs, asbjornenge/Docker.tmbundle (MIT), braver/SublimeSass (MIT), sublimehq/Packages (permissive) for TOML.
- **Insert Link off the chord prefix (2026-04-23).** Remapped to `Cmd+Shift+U`. Cmd+K is now chord-prefix-only (Cmd+K Cmd+P = palette); the chord dispatcher's single-key fallback becomes a no-op when no action is registered for the prefix. Editor shortcut (`editor.js`), menu accelerator (`menu.rs`), and palette hint all updated.
- **2.2.0 wave (2026-06-11).** Session restore + native File > Open Recent; on-type live preview with block-level DOM patching; editor core rebuilt on vendored CodeMirror 6 (markdown highlighting, native section folding, CM-driven find/replace); folder workspace (Files sidebar tab, Cmd+O fuzzy quick switcher, Open Folder Cmd+Shift+O, canonicalized dir-grant access control). Plan: docs/plan_2026-06_features.md.
