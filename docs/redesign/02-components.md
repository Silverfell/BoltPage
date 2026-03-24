# BoltPage Redesign: Component Inventory

## Intent

This document defines the core UI components required by the redesign and the behaviors they must support.

## 1. App Header

Used by both preview and editor windows.

### Content

- app mark or compact brand label
- document title
- document meta row
- state badges
- primary action cluster

### Required States

- no document
- document loaded
- read-only
- modified
- linked editor active

## 2. Document Identity Block

### Content

- file name
- parent folder or path
- file type badge

### Requirements

- truncates long paths well
- emphasizes file name over path
- usable in both wide and compact window widths

## 3. State Badge Set

### Candidate Badges

- `Markdown`
- `JSON`
- `YAML`
- `TXT`
- `PDF`
- `Writable`
- `Read Only`
- `Modified`
- `Autosave`
- `Linked Editor`

### Requirements

- quiet by default
- strong contrast for important state changes
- consistent shape and spacing

## 4. Toolbar Action Group

### Primary Actions

- Open
- New
- Edit
- Search
- Export
- Theme

### Requirements

- support icon + label in larger widths
- degrade to icon-first in narrower widths
- preserve keyboard shortcuts

## 5. Context Rail

### Modes

- Markdown TOC
- file info rail for code-like documents
- hidden rail for compact mode

### Requirements

- collapsible
- remembers visibility preference
- supports active item highlighting

## 6. Reading Canvas

### Requirements

- centered page surface
- supports prose, code blocks, tables, lists, images
- preserves existing markdown rendering behavior
- maintains readable line length

### Variants

- prose document
- structured text document
- PDF viewer canvas
- empty state
- error state

## 7. Empty State Panel

### Content

- brand/product label
- one-sentence explanation
- primary actions
- shortcut hints

### Requirements

- should feel like part of the product
- not just placeholder text

## 8. Search Overlay

### Preview Search

- query input
- previous/next controls
- match count
- close action

### Editor Search

- query input
- replace input
- replace current
- replace all
- match count

### Requirements

- visually aligned across preview and editor
- compact, keyboard-friendly, and easy to dismiss

## 9. Theme Picker

### Requirements

- current theme indication
- visually richer than a plain dropdown
- can later support previews or semantic labels

### Candidate Model

- three initial themes
- possible future addition of custom document density or page tint controls

## 10. Editor Frame

### Content

- editor header
- editor gutter
- text surface
- find overlay

### Requirements

- maintain autosave
- maintain line numbers
- maintain word wrap toggle
- clearly communicate linked-preview workflow

## 11. Gutter

### Current Function

- line numbers only

### Future-Ready Function

- line numbers
- dirty markers or selection anchors

### Requirements

- visually subordinate to text
- works in wrap and non-wrap modes

## 12. Notification Pattern

Needed for state feedback that currently relies on alerts or silent updates.

### Uses

- file changed on disk
- editor linked/opened
- export success/failure
- read-only explanation

### Requirements

- compact
- non-blocking
- consistent location

## 13. More Actions Menu

Some native-menu actions should gain a visible in-app home without cluttering the main bar.

### Candidate Actions

- Print
- Export HTML
- Export PDF
- Copy Path
- Reveal in Finder/File Manager

## 14. Window Relationship Indicator

This is unique to BoltPage's workflow and should become visible product language.

### States

- preview only
- preview with linked editor
- editor with linked preview

### Goal

Make the two-window workflow understandable without documentation.

## Component Priorities

Highest priority components for implementation:

1. App Header
2. Document Identity Block
3. State Badge Set
4. Reading Canvas
5. Editor Frame
6. Context Rail
7. Search Overlay refresh

