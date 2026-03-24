# BoltPage Redesign: Implementation Plan

## Intent

This document maps the redesign into a practical implementation sequence against the current codebase.

## Target Files

Primary frontend files:

- `boltpage/src/index.html`
- `boltpage/src/main.js`
- `boltpage/src/styles.css`
- `boltpage/src/editor.html`
- `boltpage/src/editor.js`
- `boltpage/src/editor.css`

Possible Rust touchpoints:

- `boltpage/src-tauri/src/menu.rs`
- `boltpage/src-tauri/src/prefs.rs`
- `boltpage/src-tauri/src/window.rs`

## Phase 1: Shell Redesign

### Goal

Replace the current toolbar with a stronger app header and action model.

### Tasks

- redesign preview header markup in `index.html`
- introduce document identity area
- introduce state badges
- reorganize actions into primary and secondary groups
- redesign editor header markup in `editor.html` to mirror preview shell

### Notes

This phase produces the largest visible improvement with the least behavioral risk.

## Phase 2: Visual System Refactor

### Goal

Replace the current ad hoc theme variables with a fuller token system.

### Tasks

- define new CSS variables in `styles.css` and `editor.css`
- separate shell surfaces from document surfaces
- implement new spacing, radii, typography, and elevation
- restyle popovers, buttons, badges, rails, and notices
- update existing themes to use the new tokens

### Notes

Try to unify shared tokens between preview and editor even if the CSS remains split initially.

## Phase 3: Preview Information Architecture

### Goal

Make document context explicit and promote important actions into the visible UI.

### Tasks

- display file name and path in preview header
- display file type and writable/read-only state
- surface export and creation actions in a compact overflow or action cluster
- redesign TOC rail as a labeled contextual panel
- improve empty state

### Likely JS Changes

- extend `openFile()` UI updates in `main.js`
- add DOM hooks for file metadata
- add state rendering for empty/read-only/document modes

## Phase 4: Editor UX Upgrade

### Goal

Bring the editor window up to the same product standard as the preview.

### Tasks

- display file identity in editor header
- show autosave and modified status more clearly
- show linked-preview state
- redesign line-number gutter styling
- restyle search/replace overlay

### Likely JS Changes

- update `initialize()` and `updateStatus()` in `editor.js`
- add richer status states rather than plain text only

## Phase 5: State Design

### Goal

Make state transitions legible and non-modal.

### Tasks

- add compact notification pattern for external changes
- reduce reliance on `alert()` for normal UX cases
- add visible read-only messaging
- add error-state panel styling for unsupported or failed loads

### Notes

This phase may justify a small reusable notice component in both preview and editor.

## Phase 6: Preference Surface

### Goal

Expose the most valuable existing or latent preferences in the redesigned UI.

### Candidate Preferences

- theme
- TOC visibility
- word wrap
- font size
- line numbers

### Rust Impact

Low if only existing keys are used.

Moderate if new keys or richer preference structures are added.

## Phase 7: Native Menu Alignment

### Goal

Decide which native-menu actions remain menu-first and which gain visible in-app homes.

### Candidate Promotions

- New File
- Export
- Print
- Copy Path

### Rust Impact

Possibly none if existing commands are reused.

## Implementation Order

Recommended order of actual build work:

1. Preview header and shell
2. Editor header and shell
3. Shared visual tokens
4. TOC/context rail redesign
5. Empty and state panels
6. Search/theme popover refresh
7. Preference exposure
8. Native menu alignment

## Risks

### 1. Over-designing the shell

BoltPage should remain lightweight. Do not bury the document surface under oversized chrome.

### 2. Divergence between preview and editor

The redesign should use a shared UI language, even if the windows keep different layouts.

### 3. Theme regressions

The current rendering CSS is dense and tied to syntax colors. Refactor tokens carefully to avoid breaking readability.

### 4. State sprawl

Avoid adding too many badges, notices, or controls at once. Prioritize signal over exhaustiveness.

## Deliverable Outcome

After these phases, the app should:

- look intentional
- communicate document state clearly
- feel coherent across preview and editor
- preserve the current workflow strengths

