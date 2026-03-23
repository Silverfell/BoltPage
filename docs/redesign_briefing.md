# BoltPage Redesign Briefing

## Purpose

This document translates the current repository analysis into a concrete UI redesign brief for BoltPage. The goal is to preserve the app's core strengths while replacing the current generic utility shell with a more intentional desktop product experience.

Follow-on design deliverables live in `docs/redesign/`:

- `01-wireframes.md`
- `02-components.md`
- `03-visual-tokens.md`
- `04-implementation-plan.md`

## Product Summary

BoltPage is a Tauri desktop application for viewing and editing Markdown and adjacent text formats. Its current strengths are technical rather than presentational:

- Fast local rendering
- Multi-window workflow
- Separate preview and editor windows
- File watching and live refresh
- Scroll sync between preview and editor
- Syntax highlighting
- HTML/PDF export through native menus

The core interaction model is sound. The problem is that the UI does not adequately communicate the product's quality, workflow model, or state.

## Current Interface Summary

### Preview Window

The preview window consists of:

- A compact top toolbar with `Open`, `Refresh`, `Theme`, `Find`, `Edit`, and `TOC`
- An optional TOC sidebar for Markdown documents
- A centered document column
- A simple welcome state when no file is open

The reading surface is usable, but the shell is thin. Important information is missing from the chrome:

- Current file identity
- Path or folder context
- File type
- Read-only or writable state
- Relationship to any paired editor window
- Export and creation affordances that currently live only in native menus

### Editor Window

The editor window consists of:

- A minimal toolbar with status text
- `Wrap`, `Find`, and `Close`
- A plain textarea editor with line numbers
- Autosave and synced preview behavior behind the scenes

This window is capable, but visually underpowered. It feels like an internal utility rather than a first-class editing environment.

### Native Menu Layer

Important product actions live in the native menu rather than the app shell:

- New File
- New Window
- Print
- Export HTML
- Export PDF
- Window switching
- Help and CLI setup

This is acceptable for power users, but the in-window UI currently under-represents product capability.

## Design Problem

BoltPage currently feels like a fast renderer wrapped in generic controls. The redesign needs to make it feel like a deliberate desktop workspace for reading and editing text documents.

The redesign should not fight the product's strengths:

- It should stay fast.
- It should preserve a document-first reading experience.
- It should preserve the separate-window model unless there is a strong reason to change it.
- It should avoid turning a compact utility into an overbuilt IDE.

## Design Goals

### 1. Clarify the product

The app should immediately read as a focused desktop document tool, not a demo shell.

### 2. Strengthen document context

Users should be able to see, at a glance:

- what file is open
- where it lives
- what kind of file it is
- whether it is writable
- whether it is in sync

### 3. Unify preview and editor

The preview and editor windows should feel like two modes of the same product, not unrelated windows that happen to sync.

### 4. Improve state design

The UI should treat these as designed states, not incidental conditions:

- empty state
- Markdown state
- code-like text state
- PDF state
- read-only state
- external change state
- save/error state

### 5. Build a real visual system

Themes should become more than color toggles. The app needs a cohesive shell, typography system, spacing scale, and interaction language.

## Recommended Direction

Keep the separate-window model as the primary workflow, but redesign it as a linked document workspace.

The recommended tone is:

- editorial
- desktop-native
- dark by default
- calm rather than flashy
- document-first rather than chrome-first

The current Dracula-inspired styling should be replaced with a more original design language built around layered dark surfaces, a brighter reading plane, and stronger information hierarchy.

## Proposed Deliverables

The redesign work is broken into four follow-on documents:

1. `docs/redesign/01-wireframes.md`
   Screen-by-screen structure for preview, editor, and state variants.

2. `docs/redesign/02-components.md`
   Component inventory and behavioral requirements.

3. `docs/redesign/03-visual-tokens.md`
   Visual system proposal: typography, color, spacing, radii, elevation, iconography, and motion.

4. `docs/redesign/04-implementation-plan.md`
   Practical implementation sequence mapped to the current codebase.

## Scope Guidance

The first implementation pass should remain mostly in the frontend shell:

- `boltpage/src/index.html`
- `boltpage/src/main.js`
- `boltpage/src/styles.css`
- `boltpage/src/editor.html`
- `boltpage/src/editor.js`
- `boltpage/src/editor.css`

Rust changes should be limited to cases where the redesign needs:

- new menu behavior
- new preferences
- changed window relationships
- new metadata exposed to the frontend

## Constraints

- Preserve multi-window support.
- Preserve keyboard-first workflows and native menu accelerators.
- Preserve low visual friction for reading.
- Avoid introducing a framework unless there is a compelling architectural reason.
- Keep PDF mode visually coherent with the rest of the application even if it remains structurally distinct.

## Success Criteria

The redesign is successful if:

- BoltPage feels like a coherent product rather than a plain wrapper
- preview and editor feel intentionally related
- important document state is obvious without hunting
- the default dark theme feels distinctive and finished
- the app remains lightweight and fast

