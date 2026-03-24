# BoltPage Redesign: Wireframe Structure

## Intent

This document defines the target screen structure for the redesign. These are content and layout wireframes, not visual comps.

## Shared Shell Principles

All major windows should share the same shell language:

- Top header with document identity
- Secondary action row or action cluster
- Optional left contextual panel
- Main content canvas
- Lightweight overlays or popovers for temporary tools

Shared header content:

- file name
- path or parent folder
- file type badge
- state badge: writable, read-only, modified, synced

## Screen 1: Preview Window, Markdown

### Layout

- Header bar
  - left: app mark, file name, path
  - center: optional document mode label
  - right: state badges, search, theme, more actions
- Main workspace
  - left rail: TOC panel
  - center: reading canvas
  - optional right utility slot for future use

### Header Details

- Primary title: current file name
- Secondary line: parent path
- Badges:
  - `Markdown`
  - `Writable` or `Read Only`
  - `Linked Editor` when editor window exists

### Primary Actions

- Open
- New
- Edit
- Search
- Export
- Theme

### Reading Canvas

- centered page surface
- wider spacing above document start
- stronger document edge definition than current UI
- subtle page container rather than free-floating markdown

### TOC Rail

- collapsible
- heading hierarchy
- active section marker
- sticky heading label such as `Contents`

## Screen 2: Preview Window, Empty State

### Layout

- Shared shell remains visible
- Main canvas becomes a designed landing panel

### Content

- product title
- short description
- primary actions:
  - Open Document
  - New Markdown File
- secondary hints:
  - drag and drop support if later added
  - keyboard shortcuts

### Goal

The empty state should introduce the app and its workflow rather than simply stating that no file is open.

## Screen 3: Preview Window, JSON/YAML/TXT

### Layout

- Shared header
- left rail changes from TOC to file info / structure tools
- main canvas becomes code-like document surface

### Left Rail Content

- file info
- line count
- file type
- optional quick actions:
  - wrap preview
  - copy path
  - open editor

### Main Canvas

- preserve syntax-highlighted preview
- stronger visual separation between prose documents and structured text
- line-oriented reading surface if feasible

## Screen 4: Preview Window, PDF

### Layout

- Shared header remains
- PDF controls sit in header or compact sub-bar
- canvas is full-bleed viewer area

### Controls

- page fit mode
- open in system viewer
- print/export where appropriate

### Goal

PDF should not feel like a fallback mode; it should feel like a supported document view that happens to use a different canvas.

## Screen 5: Editor Window

### Layout

- Header bar
  - left: file name, path
  - right: state badges, wrap, search, close
- Editor workspace
  - optional narrow left gutter for line numbers and markers
  - main editor surface

### Header Details

- file title
- `Autosave`
- `Modified` when dirty
- `Linked to Preview`

### Editor Surface

- keep plaintext textarea foundation for now
- improve surrounding framing and typography
- give the text area a stronger sense of place inside the window

### Overlay Tools

- search and replace overlay
- future room for formatting or command palette without requiring it now

## Screen 6: Read-Only State

### Behavior

- clearly visible read-only badge in header
- edit action disabled with visible reason
- no reliance on modal alert as the only signal

### Messaging

- concise explanatory text
- path or permission hint when useful

## Screen 7: External Change State

### Behavior

- auto-refresh can remain
- but the interface should acknowledge when content changed externally

### UI Pattern

- compact transient notice in header or below it
- message example:
  - `File updated on disk`

## Screen 8: Error or Unsupported State

### Layout

- same shell
- centered state panel in canvas

### Content

- error title
- concise explanation
- recovery action where possible

## Wireframe Priorities

If implementation needs to be phased, priority order should be:

1. Preview header and shell
2. Editor header and shell
3. Empty state
4. TOC rail redesign
5. JSON/YAML/TXT specialized view
6. PDF shell alignment

