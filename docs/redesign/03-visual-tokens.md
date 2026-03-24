# BoltPage Redesign: Visual Tokens

## Intent

This document defines the visual system for the redesign. The goal is to replace the current generic theme styling with a consistent product language.

## Visual Direction

Recommended direction: `Nocturne Editorial Workstation`

Characteristics:

- dark shell
- brighter document plane
- strong type hierarchy
- restrained accent color
- subtle depth
- calm motion

This should feel more like a focused desktop reading environment than a generic code app.

## Color Model

### Core Shell Colors

- shell background: deep graphite
- shell panel: charcoal
- shell raised surface: cool slate
- shell border: low-contrast steel

### Document Colors

- document background: warm near-white for light theme variant, soft ink-gray for dark variant
- document text: high-contrast but not pure black/white
- subdued secondary text for path, meta, helper labels

### Accent

Choose one primary accent for the redesign.

Recommended options:

- icy cyan
- muted amber
- oxidized teal

Recommendation:

- default accent: icy cyan
- warning/accent-secondary: muted amber

### Semantic Colors

- success: muted green
- warning: amber
- danger: restrained red
- info: accent color

## Suggested Token Set

These names are implementation-oriented and can map directly to CSS variables.

### Surface Tokens

- `--surface-app`
- `--surface-panel`
- `--surface-panel-raised`
- `--surface-document`
- `--surface-document-muted`
- `--surface-overlay`

### Border Tokens

- `--border-subtle`
- `--border-default`
- `--border-strong`

### Text Tokens

- `--text-primary`
- `--text-secondary`
- `--text-muted`
- `--text-accent`
- `--text-inverse`

### Accent Tokens

- `--accent-primary`
- `--accent-primary-soft`
- `--accent-secondary`
- `--accent-secondary-soft`

### Feedback Tokens

- `--state-success`
- `--state-warning`
- `--state-danger`
- `--state-info`

## Typography

### UI Typeface

Use a more intentional UI face than the current default system stack.

Candidate directions:

- IBM Plex Sans
- Geist Sans
- Spline Sans

Recommendation:

- UI face: Geist Sans or IBM Plex Sans

### Reading Face

The reading surface should have the option of a document-oriented face distinct from the shell.

Candidate directions:

- Source Serif 4
- Spectral
- Newsreader

Recommendation:

- reading face: Source Serif 4 for Markdown prose

### Monospace

Candidate directions:

- Berkeley Mono if licensed
- JetBrains Mono
- IBM Plex Mono

Recommendation:

- monospace: IBM Plex Mono or JetBrains Mono

## Type Scale

Suggested starting scale:

- app title: 20
- section title: 16
- body: 15 or 16
- metadata: 12 or 13
- badges: 11 or 12
- code/editor text: 13 or 14

## Spacing

Use a tight-but-deliberate scale:

- `4`
- `8`
- `12`
- `16`
- `24`
- `32`
- `48`

Guidance:

- shell spacing should feel compact
- document spacing should feel more open

## Radius

Use moderate radius, not bubble UI.

Suggested scale:

- small: 6
- medium: 10
- large: 14
- document frame: 16

## Elevation

Depth should be subtle and mostly communicated by layered surfaces and borders.

Suggested levels:

- base shell: no shadow
- raised panel: low blur shadow
- overlay/popover: medium shadow
- document plane: faint outer lift if needed

## Iconography

Style:

- simple stroke icons
- slightly more refined than the current inline set
- consistent line width

Use icons to support labels, not replace them by default.

## Motion

Motion should remain restrained.

Allowed uses:

- rail open/close
- popover reveal
- active state transitions
- notice appearance

Avoid:

- decorative motion
- large-scale page movement
- constant shimmer or hover theatrics

## Theme Strategy

Keep three themes initially, but make them visually coherent product themes rather than simple background swaps.

### Proposed Themes

- `Nocturne`
  Dark editorial default

- `Slate`
  Cooler, lower-contrast dark variant

- `Paper`
  Light reading-focused variant

Map existing themes to new names only if implementation chooses to rename the user-facing labels.

## Token Priority

First tokens to implement:

1. surfaces
2. text hierarchy
3. accent
4. spacing
5. radius
6. typography

